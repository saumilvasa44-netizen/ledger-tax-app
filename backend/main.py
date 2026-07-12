import io
import re

import pdfplumber
from fastapi import FastAPI, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

app = FastAPI(title="ITR Tax Tracker API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # tighten to your deployed frontend URL before wide sharing
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# MODELS
# ---------------------------------------------------------------------------

class TaxInput(BaseModel):
    fy: str  # "FY 2025-26" or "FY 2024-25"
    age_group: str = "Below 60"  # "Below 60" | "60 to 79" | "80 and above"

    gross_salary: float = 0.0
    nps_employer: float = 0.0  # 80CCD(2) - allowed in both regimes

    # Other income (both regimes)
    sb_interest: float = 0.0
    fd_interest: float = 0.0
    dividend_income: float = 0.0

    # Old-regime-only exemptions
    hra_exemption: float = 0.0
    lta_exemption: float = 0.0
    other_exemptions: float = 0.0

    # Old-regime-only Chapter VI-A deductions
    ded_80c: float = 0.0
    ded_80ccd1b: float = 0.0
    ded_80d: float = 0.0
    ded_80tta_ttb: float = 0.0
    ded_other: float = 0.0

    # Tax already paid (both regimes)
    tds_salary: float = 0.0
    tds_other: float = 0.0
    advance_tax: float = 0.0


class RegimeResult(BaseModel):
    taxable_income: float
    base_tax: float
    tax_with_cess: float
    net_payable: float
    is_refund: bool


class TaxResult(BaseModel):
    new_regime: RegimeResult
    old_regime: RegimeResult
    total_tds_paid: float
    better_regime: str  # "new" | "old" | "same"


class ExtractedFields(BaseModel):
    doc_type: str
    gross_salary: float | None = None
    tds: float | None = None
    sb_interest: float | None = None
    fd_interest: float | None = None
    dividend_income: float | None = None
    raw_text_preview: str = ""


# ---------------------------------------------------------------------------
# TAX CALCULATION
# ---------------------------------------------------------------------------

STANDARD_DEDUCTION_NEW = 75000
STANDARD_DEDUCTION_OLD = 50000


def compute_new_regime_tax(taxable_income: float, fy: str) -> float:
    if "2025-26" in fy:
        slabs = [
            (400000, 0.00), (400000, 0.05), (400000, 0.10),
            (400000, 0.15), (400000, 0.20), (400000, 0.25),
            (float("inf"), 0.30),
        ]
        rebate_limit = 1200000
    else:
        slabs = [
            (300000, 0.00), (300000, 0.05), (300000, 0.10),
            (300000, 0.15), (300000, 0.20), (float("inf"), 0.30),
        ]
        rebate_limit = 700000

    tax = 0.0
    remaining = taxable_income
    for width, rate in slabs:
        chunk = min(remaining, width)
        if chunk <= 0:
            break
        tax += chunk * rate
        remaining -= chunk

    if taxable_income <= rebate_limit:
        tax = 0.0
    return tax


def compute_old_regime_tax(taxable_income: float, age_group: str) -> float:
    if age_group == "60 to 79":
        exempt_limit = 300000
    elif age_group == "80 and above":
        exempt_limit = 500000
    else:
        exempt_limit = 250000

    slabs = [
        (exempt_limit, 0.00),
        (max(0, 500000 - exempt_limit), 0.05),
        (max(0, 1000000 - 500000), 0.20),
        (float("inf"), 0.30),
    ]

    tax = 0.0
    remaining = taxable_income
    for width, rate in slabs:
        chunk = min(remaining, width)
        if chunk <= 0:
            continue
        tax += chunk * rate
        remaining -= chunk

    if taxable_income <= 500000:
        tax = 0.0
    return tax


def build_regime_result(taxable_income: float, base_tax: float, total_tds_paid: float) -> RegimeResult:
    tax_with_cess = base_tax * 1.04
    net = tax_with_cess - total_tds_paid
    return RegimeResult(
        taxable_income=round(taxable_income, 2),
        base_tax=round(base_tax, 2),
        tax_with_cess=round(tax_with_cess, 2),
        net_payable=round(abs(net), 2),
        is_refund=net < 0,
    )


@app.get("/")
def root():
    return {"status": "ok", "service": "ITR Tax Tracker API"}


@app.post("/calculate", response_model=TaxResult)
def calculate_tax(data: TaxInput):
    other_income_total = data.sb_interest + data.fd_interest + data.dividend_income
    total_tds_paid = data.tds_salary + data.tds_other + data.advance_tax

    # New regime: only standard deduction + employer NPS allowed
    new_salary_income = max(0.0, data.gross_salary - STANDARD_DEDUCTION_NEW - data.nps_employer)
    new_taxable_income = max(0.0, new_salary_income + other_income_total)
    new_base_tax = compute_new_regime_tax(new_taxable_income, data.fy)
    new_result = build_regime_result(new_taxable_income, new_base_tax, total_tds_paid)

    # Old regime: exemptions + Chapter VI-A deductions + employer NPS all allowed
    total_exemptions = data.hra_exemption + data.lta_exemption + data.other_exemptions
    total_chapter_via = (
        data.ded_80c + data.ded_80ccd1b + data.ded_80d + data.ded_80tta_ttb + data.ded_other
    )
    old_salary_income = max(
        0.0, data.gross_salary - total_exemptions - STANDARD_DEDUCTION_OLD - data.nps_employer
    )
    old_taxable_income = max(0.0, old_salary_income + other_income_total - total_chapter_via)
    old_base_tax = compute_old_regime_tax(old_taxable_income, data.age_group)
    old_result = build_regime_result(old_taxable_income, old_base_tax, total_tds_paid)

    if new_result.tax_with_cess < old_result.tax_with_cess:
        better = "new"
    elif old_result.tax_with_cess < new_result.tax_with_cess:
        better = "old"
    else:
        better = "same"

    return TaxResult(
        new_regime=new_result,
        old_regime=old_result,
        total_tds_paid=round(total_tds_paid, 2),
        better_regime=better,
    )


# ---------------------------------------------------------------------------
# PDF EXTRACTION
# ---------------------------------------------------------------------------

def to_float(raw: str):
    try:
        return float(raw.replace(",", ""))
    except ValueError:
        return None


def extract_tis_category(text: str, category_name: str):
    """TIS has a clean summary table: 'Category Name   <processed>   <accepted>'.
    The 'accepted by taxpayer' figure (second number) is the authoritative one."""
    pattern = rf"{re.escape(category_name)}\s+([\d,]+)\s+([\d,]+)"
    match = re.search(pattern, text, re.IGNORECASE)
    if match:
        return to_float(match.group(2))
    return None


def sum_ais_lines_containing(text: str, marker: str):
    """AIS lists each bank/source as a separate line ending in the amount
    (e.g. 'SFT-016(SB) Interest income ... BANK NAME (CODE) 1 21,864').
    Sum the trailing amount across every matching line."""
    total = 0.0
    found = False
    for line in text.splitlines():
        if marker in line:
            numbers = re.findall(r"[\d,]+", line)
            if numbers:
                amount = to_float(numbers[-1])
                if amount is not None:
                    total += amount
                    found = True
    return total if found else None


def sum_salary_tds_deposited(text: str):
    """AIS salary section lists one row per quarter/payment:
    'SR QUARTER DATE AMOUNT_PAID TDS_DEDUCTED TDS_DEPOSITED STATUS'.
    Sum the TDS_DEPOSITED column across every such row."""
    total = 0.0
    found = False
    for line in text.splitlines():
        if re.match(r"^\d+\s+Q\d\(", line.strip()):
            numbers = re.findall(r"[\d,]+", line)
            if len(numbers) >= 4:
                tds_deposited = to_float(numbers[-1])
                if tds_deposited is not None:
                    total += tds_deposited
                    found = True
    return total if found else None


def extract_ais_gross_salary(text: str):
    """AIS Part B7 shows 'GROSS SALARY' as a distinct labeled figure, or the
    Part B1 salary row 'TDS-192 Salary received ... <count> <amount>'."""
    match = re.search(r"gross\s*salary\s*(?:received)?\D{0,20}?([\d,]+)", text, re.IGNORECASE)
    if match:
        return to_float(match.group(1))
    for line in text.splitlines():
        if "TDS-192" in line:
            numbers = re.findall(r"[\d,]+", line)
            if numbers:
                return to_float(numbers[-1])
    return None


GROSS_SALARY_PATTERNS = [
    r"gross\s*salary[^\d]{0,25}([\d,]+\.?\d*)",
    r"total\s*gross\s*(?:earnings|salary)[^\d]{0,25}([\d,]+\.?\d*)",
    r"gross\s*earnings[^\d]{0,25}([\d,]+\.?\d*)",
    r"total\s*earnings[^\d]{0,25}([\d,]+\.?\d*)",
]

TDS_PATTERNS = [
    r"total\s*tax\s*deducted[^\d]{0,25}([\d,]+\.?\d*)",
    r"tax\s*deducted\s*at\s*source[^\d]{0,25}([\d,]+\.?\d*)",
    r"total\s*(?:amount\s*of\s*)?tds[^\d]{0,25}([\d,]+\.?\d*)",
]


def find_amount(text: str, patterns: list[str]):
    for pattern in patterns:
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            return to_float(match.group(1))
    return None


def extract_pdf_text(file_bytes: bytes) -> str:
    text = ""
    with pdfplumber.open(io.BytesIO(file_bytes)) as pdf:
        for page in pdf.pages:
            text += (page.extract_text() or "") + "\n"
    return text


@app.post("/extract", response_model=ExtractedFields)
async def extract_document(file: UploadFile = File(...), doc_type: str = Form(...)):
    """
    doc_type: "payslip" | "form16" | "ais" | "tis"

    TIS uses a clean summary table and is the preferred source for interest/
    dividend income. AIS lists the same figures spread across many repeating
    per-bank rows, which is summed as a fallback. Always verify extracted
    figures — layouts can still vary between years/portals.
    """
    file_bytes = await file.read()
    try:
        text = extract_pdf_text(file_bytes)
    except Exception as e:
        return ExtractedFields(doc_type=doc_type, raw_text_preview=f"Could not read PDF: {e}")

    result = ExtractedFields(doc_type=doc_type, raw_text_preview=text[:300])

    if doc_type == "payslip":
        result.gross_salary = find_amount(text, GROSS_SALARY_PATTERNS)
        result.tds = find_amount(text, TDS_PATTERNS)

    elif doc_type == "form16":
        result.gross_salary = find_amount(text, GROSS_SALARY_PATTERNS)
        result.tds = find_amount(text, TDS_PATTERNS)

    elif doc_type == "tis":
        result.gross_salary = extract_tis_category(text, "Salary")
        result.sb_interest = extract_tis_category(text, "Interest from savings bank")
        result.fd_interest = extract_tis_category(text, "Interest from deposit")
        result.dividend_income = extract_tis_category(text, "Dividend")

    elif doc_type == "ais":
        result.gross_salary = extract_ais_gross_salary(text)
        result.tds = sum_salary_tds_deposited(text)
        result.sb_interest = sum_ais_lines_containing(text, "SFT-016(SB)")
        result.fd_interest = sum_ais_lines_containing(text, "SFT-016(TD)")
        result.dividend_income = sum_ais_lines_containing(text, "Dividend")

    return result