import io
import re
import asyncio
from datetime import datetime, date

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
    taxable_income: int
    base_tax: int
    tax_with_cess: int
    net_payable: int
    is_refund: bool


class TaxResult(BaseModel):
    new_regime: RegimeResult
    old_regime: RegimeResult
    total_tds_paid: int
    better_regime: str  # "new" | "old" | "same"


class ExtractedFields(BaseModel):
    doc_type: str
    gross_salary: int | None = None
    tds: int | None = None
    sb_interest: int | None = None
    fd_interest: int | None = None
    dividend_income: int | None = None
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
        taxable_income=round(taxable_income),
        base_tax=round(base_tax),
        tax_with_cess=round(tax_with_cess),
        net_payable=round(abs(net)),
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
        total_tds_paid=round(total_tds_paid),
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


def _round_or_none(value):
    """Round to whole rupees, matching how amounts appear on the actual
    AIS/TIS/Form16/payslip documents — no decimal places."""
    return round(value) if value is not None else None


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


def extract_form16_figures(text: str):
    """Form 16 Part A has a reliable single-line summary:
    'Total (Rs.)  <amount paid/credited>  <TDS deducted>  <TDS deposited>'
    which is far more consistent across employers than trying to match
    'Gross Salary' labels (those often sit on a different line than their
    number, due to how the PDF's table columns get extracted)."""
    match = re.search(
        r"Total\s*\(Rs\.\)\s+([\d,]+\.?\d*)\s+([\d,]+\.?\d*)\s+([\d,]+\.?\d*)", text
    )
    if match:
        gross_salary = to_float(match.group(1))
        tds_deposited = to_float(match.group(3))
        return gross_salary, tds_deposited

    # Fallback: cross-line label matching for Form 16 layouts without that summary row
    gross_salary = None
    tds = None
    gross_match = re.search(
        r"Total amount of salary received from current employer.*?(\d[\d,]{3,}\.\d{2})",
        text, re.DOTALL,
    )
    if gross_match:
        gross_salary = to_float(gross_match.group(1))
    tds_match = re.search(
        r"Tax deducted from salary of the employee.*?(\d[\d,]{3,}\.\d{2})",
        text, re.DOTALL,
    )
    if tds_match:
        tds = to_float(tds_match.group(1))
    return gross_salary, tds


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


async def extract_pdf_text_async(file_bytes: bytes) -> str:
    """Run the CPU-bound pdfplumber parsing in a thread pool so multiple
    documents can be processed concurrently instead of one after another."""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, extract_pdf_text, file_bytes)


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
        result.gross_salary = _round_or_none(find_amount(text, GROSS_SALARY_PATTERNS))
        result.tds = _round_or_none(find_amount(text, TDS_PATTERNS))

    elif doc_type == "form16":
        gross_salary, tds = extract_form16_figures(text)
        result.gross_salary = _round_or_none(gross_salary)
        result.tds = _round_or_none(tds)

    elif doc_type == "tis":
        result.gross_salary = _round_or_none(extract_tis_category(text, "Salary"))
        result.sb_interest = _round_or_none(extract_tis_category(text, "Interest from savings bank"))
        result.fd_interest = _round_or_none(extract_tis_category(text, "Interest from deposit"))
        result.dividend_income = _round_or_none(extract_tis_category(text, "Dividend"))

    elif doc_type == "ais":
        result.gross_salary = _round_or_none(extract_ais_gross_salary(text))
        result.tds = _round_or_none(sum_salary_tds_deposited(text))
        result.sb_interest = _round_or_none(sum_ais_lines_containing(text, "SFT-016(SB)"))
        result.fd_interest = _round_or_none(sum_ais_lines_containing(text, "SFT-016(TD)"))
        result.dividend_income = _round_or_none(sum_ais_lines_containing(text, "Dividend"))

    return result


# ---------------------------------------------------------------------------
# FULL ANALYSIS: reconcile payslips vs Form 16, categorize every AIS/TIS
# income item per the Income Tax Act, compute salary + other-sources TDS
# separately, and estimate 234B/234C interest.
# ---------------------------------------------------------------------------

# How each TIS category should be treated under the Income Tax Act.
# IMPORTANT: not everything reported in AIS/TIS is taxable income —
# "purchase of securities" and "outward remittance" are informational only.
TIS_CATEGORY_RULES = [
    (["salary"], "salary"),
    (["interest from savings bank"], "slab_other_income"),
    (["interest from deposit"], "slab_other_income"),
    (["dividend"], "slab_other_income"),
    (["receipts on transfer of virtual digital asset"], "vda_flat30"),
    (["purchase of securities", "purchase of immovable", "cash withdrawal", "cash deposit"], "non_income"),
    (["outward foreign remittance"], "non_income"),
    (["sale of securities", "sale of immovable", "capital gain"], "capital_gains_needs_review"),
]


def categorize_tis_category(name: str) -> str:
    name_lower = name.lower()
    for keywords, treatment in TIS_CATEGORY_RULES:
        if any(kw in name_lower for kw in keywords):
            return treatment
    return "needs_review"


def extract_tis_all_categories(text: str):
    """Parse every row of TIS's summary table (restricted to the summary
    section only — the detailed Annexure pages repeat similar-looking rows
    that would otherwise be mistakenly picked up)."""
    summary_section = text.split("Annexure to Taxpayer Information Summary")[0]
    pattern = r"^(\d+)\s+(.+?)\s+([\d,]+)\s+([\d,]+)$"
    rows = []
    for line in summary_section.splitlines():
        match = re.match(pattern, line.strip())
        if match:
            _, category, processed, accepted = match.groups()
            rows.append({"category": category.strip(), "amount": to_float(accepted)})
    return rows


def split_ais_salary_vs_other_tds(text: str):
    """AIS lists TDS as repeating quarterly rows under each category section.
    Split the document into the Salary section vs everything after it, and
    sum the 'TDS DEPOSITED' column separately for each."""
    salary_start = text.find("Salary\n")
    if salary_start == -1:
        return None, None

    # Find the next category header after Salary to bound the salary block.
    next_headers = ["Interest from deposit", "Interest from savings bank", "Receipts on transfer"]
    next_positions = [text.find(h, salary_start + 7) for h in next_headers]
    next_positions = [p for p in next_positions if p != -1]
    salary_end = min(next_positions) if next_positions else len(text)

    salary_block = text[salary_start:salary_end]
    rest_block = text[salary_end:]

    def sum_quarterly(block):
        total = 0.0
        found = False
        for line in block.splitlines():
            if re.match(r"^\d+\s+Q\d\(", line.strip()):
                numbers = re.findall(r"[\d,]+", line)
                if len(numbers) >= 4:
                    total += to_float(numbers[-1])
                    found = True
        return total if found else None

    return sum_quarterly(salary_block), sum_quarterly(rest_block)


def months_elapsed_since_fy_start(fy_string: str, today=None) -> int:
    """Months from 1 April of the Assessment Year to today — part of a month
    counts as a full month, per Section 234B."""
    today = today or datetime.now().date()
    ay_start = date(2026, 4, 1) if "2025-26" in fy_string else date(2025, 4, 1)
    if today < ay_start:
        return 0
    months = (today.year - ay_start.year) * 12 + (today.month - ay_start.month)
    if today.day > ay_start.day:
        months += 1
    return max(0, months)


def compute_234b(total_tax: float, total_tds: float, advance_tax_paid: float, fy_string: str):
    """Section 234B: the 'assessed tax' this section actually tests against is
    total tax MINUS TDS already credited — not the gross tax figure. Advance
    tax paid separately (not TDS) is then checked against 90% of that net
    figure. If assessed tax (after TDS) is ≤ ₹10,000, there's no advance-tax
    obligation at all (Section 208), so no interest applies either."""
    assessed_tax = total_tax - total_tds
    months = months_elapsed_since_fy_start(fy_string)
    if assessed_tax <= 10000:
        return 0, months
    if advance_tax_paid >= 0.9 * assessed_tax:
        return 0, months
    shortfall = assessed_tax - advance_tax_paid
    return round(shortfall * 0.01 * months), months


def compute_234c(total_tax: float, total_tds: float, advance_tax_paid: float = 0):
    """Section 234C: checked against the same net-of-TDS 'assessed tax' base
    as 234B. Advance tax paid separately (not TDS, which is already netted
    out of the base) is compared against each installment checkpoint
    (15%/45%/75%/100% by 15 Jun/Sep/Dec/Mar). Each checkpoint's interest is
    rounded individually before summing, matching how this is computed in
    practice. Same Section 208 threshold as 234B applies: if the net-of-TDS
    liability is ≤ ₹10,000, there's no advance-tax obligation at all, so no
    234C interest either."""
    assessed_tax = total_tax - total_tds
    if assessed_tax <= 10000:
        return 0
    checkpoints = [(0.15, 3), (0.45, 3), (0.75, 3), (1.00, 1)]
    total_interest = 0
    for required_pct, months in checkpoints:
        required = assessed_tax * required_pct
        shortfall = max(0, required - advance_tax_paid)
        total_interest += round(shortfall * 0.01 * months)
    return total_interest


class IncomeItem(BaseModel):
    category: str
    amount: int
    treatment: str  # slab_other_income | vda_flat30 | non_income | capital_gains_needs_review | needs_review
    included_in_tax: bool


class SalaryReconciliation(BaseModel):
    payslip_total: int | None
    form16_total: int | None
    additional_income_identified: int
    final_gross_salary: int


class TDSReconciliation(BaseModel):
    payslip_tds_total: int | None
    form16_tds: int | None
    salary_tds_used: int
    other_sources_tds: int
    total_tds: int


class RegimeFullResult(BaseModel):
    taxable_income: int
    slab_tax_with_cess: int
    vda_tax_with_cess: int
    total_tax: int
    total_tds_paid: int
    net_before_interest: int
    interest_234b: int
    interest_234c: int
    months_elapsed_234b: int
    final_amount: int
    is_refund: bool


class FullAnalysisResult(BaseModel):
    salary: SalaryReconciliation
    tds: TDSReconciliation
    other_income_items: list[IncomeItem]
    vda_income_total: int
    slab_other_income_total: int
    non_income_total: int
    new_regime: RegimeFullResult
    old_regime: RegimeFullResult
    vda_caveat: str
    calculation_date: str
    itr_due_date_note: str


@app.post("/full-analysis", response_model=FullAnalysisResult)
async def full_analysis(
    fy: str = Form(...),
    age_group: str = Form("Below 60"),
    nps_employer: float = Form(0.0),
    hra_exemption: float = Form(0.0),
    lta_exemption: float = Form(0.0),
    other_exemptions: float = Form(0.0),
    ded_80c: float = Form(0.0),
    ded_80ccd1b: float = Form(0.0),
    ded_80d: float = Form(0.0),
    ded_80tta_ttb: float = Form(0.0),
    ded_other: float = Form(0.0),
    advance_tax: float = Form(0.0),
    payslips: list[UploadFile] = File(default=[]),
    form16: UploadFile | None = File(default=None),
    ais: UploadFile | None = File(default=None),
    tis: UploadFile | None = File(default=None),
):
    # --- Read and extract ALL documents concurrently (instead of one after
    # another) — this is the main lever we control for speed, since the PDF
    # parsing itself is CPU-bound but independent per document. ---
    payslip_bytes = [await f.read() for f in payslips]
    form16_bytes = await form16.read() if form16 else None
    ais_bytes = await ais.read() if ais else None
    tis_bytes = await tis.read() if tis else None

    extraction_tasks = [extract_pdf_text_async(b) for b in payslip_bytes]
    if form16_bytes is not None:
        extraction_tasks.append(extract_pdf_text_async(form16_bytes))
    if ais_bytes is not None:
        extraction_tasks.append(extract_pdf_text_async(ais_bytes))
    if tis_bytes is not None:
        extraction_tasks.append(extract_pdf_text_async(tis_bytes))

    extracted_texts = await asyncio.gather(*extraction_tasks) if extraction_tasks else []

    idx = 0
    payslip_texts = extracted_texts[idx: idx + len(payslip_bytes)]
    idx += len(payslip_bytes)
    form16_text = extracted_texts[idx] if form16_bytes is not None else None
    idx += 1 if form16_bytes is not None else 0
    ais_text = extracted_texts[idx] if ais_bytes is not None else ""
    idx += 1 if ais_bytes is not None else 0
    tis_text = extracted_texts[idx] if tis_bytes is not None else None

    # --- Salary reconciliation: payslips vs Form 16 ---
    payslip_total = None
    payslip_tds_total = None
    if payslip_texts:
        total_gross, total_tds, found = 0.0, 0.0, False
        for text in payslip_texts:
            g = find_amount(text, GROSS_SALARY_PATTERNS)
            t = find_amount(text, TDS_PATTERNS)
            if g:
                total_gross += g
                found = True
            if t:
                total_tds += t
        payslip_total = round(total_gross) if found else None
        payslip_tds_total = round(total_tds) if total_tds else None

    form16_gross, form16_tds = None, None
    if form16_text is not None:
        form16_gross, form16_tds = extract_form16_figures(form16_text)
        form16_gross = round(form16_gross) if form16_gross else None
        form16_tds = round(form16_tds) if form16_tds else None

    # Form 16 is authoritative; any excess over the payslip total (e.g.
    # perquisites, bonuses not reflected on payslips) is surfaced explicitly.
    if form16_gross is not None:
        base = payslip_total or 0
        additional = max(0, form16_gross - base)
        final_gross_salary = base + additional
    elif payslip_total is not None:
        additional = 0
        final_gross_salary = payslip_total
    else:
        additional = 0
        final_gross_salary = 0

    salary_recon = SalaryReconciliation(
        payslip_total=payslip_total,
        form16_total=form16_gross,
        additional_income_identified=additional,
        final_gross_salary=final_gross_salary,
    )

    # --- AIS: split salary TDS vs other-sources TDS ---
    ais_salary_tds, ais_other_tds = None, None
    if ais_text:
        ais_salary_tds, ais_other_tds = split_ais_salary_vs_other_tds(ais_text)

    salary_tds_used = form16_tds or ais_salary_tds or payslip_tds_total or 0
    other_sources_tds = round(ais_other_tds) if ais_other_tds else 0

    tds_recon = TDSReconciliation(
        payslip_tds_total=payslip_tds_total,
        form16_tds=form16_tds,
        salary_tds_used=round(salary_tds_used),
        other_sources_tds=other_sources_tds,
        total_tds=round(salary_tds_used) + other_sources_tds,
    )

    # --- TIS: categorize every income item per the Income Tax Act ---
    other_income_items = []
    slab_other_income_total = 0.0
    vda_income_total = 0.0
    non_income_total = 0.0

    if tis_text:
        for row in extract_tis_all_categories(tis_text):
            if row["category"].lower() == "salary" or row["amount"] is None:
                continue
            treatment = categorize_tis_category(row["category"])
            included = treatment in ("slab_other_income", "vda_flat30")
            other_income_items.append(IncomeItem(
                category=row["category"], amount=round(row["amount"]),
                treatment=treatment, included_in_tax=included,
            ))
            if treatment == "slab_other_income":
                slab_other_income_total += row["amount"]
            elif treatment == "vda_flat30":
                vda_income_total += row["amount"]
            elif treatment == "non_income":
                non_income_total += row["amount"]

    # --- Tax calculation, both regimes ---
    def calc_regime(is_new_regime: bool) -> RegimeFullResult:
        if is_new_regime:
            salary_income = max(0.0, final_gross_salary - STANDARD_DEDUCTION_NEW - nps_employer)
            taxable_income = max(0.0, salary_income + slab_other_income_total)
            slab_tax = compute_new_regime_tax(taxable_income, fy)
        else:
            total_exemptions = hra_exemption + lta_exemption + other_exemptions
            total_via = ded_80c + ded_80ccd1b + ded_80d + ded_80tta_ttb + ded_other
            salary_income = max(0.0, final_gross_salary - total_exemptions - STANDARD_DEDUCTION_OLD - nps_employer)
            taxable_income = max(0.0, salary_income + slab_other_income_total - total_via)
            slab_tax = compute_old_regime_tax(taxable_income, age_group)

        slab_tax_with_cess = slab_tax * 1.04
        # VDA: flat 30% + cess, no deductions, same treatment in both regimes
        vda_tax_with_cess = vda_income_total * 0.30 * 1.04
        total_tax = slab_tax_with_cess + vda_tax_with_cess

        total_tds = tds_recon.total_tds
        net_before_interest = total_tax - total_tds - advance_tax

        if net_before_interest > 0:
            interest_b, months_b = compute_234b(total_tax, total_tds, advance_tax, fy)
            interest_c = compute_234c(total_tax, total_tds, advance_tax)
        else:
            interest_b, months_b = 0, months_elapsed_since_fy_start(fy)
            interest_c = 0

        final_amount = net_before_interest + interest_b + interest_c

        return RegimeFullResult(
            taxable_income=round(taxable_income),
            slab_tax_with_cess=round(slab_tax_with_cess),
            vda_tax_with_cess=round(vda_tax_with_cess),
            total_tax=round(total_tax),
            total_tds_paid=round(total_tds),
            net_before_interest=round(net_before_interest),
            interest_234b=interest_b,
            interest_234c=interest_c,
            months_elapsed_234b=months_b,
            final_amount=round(abs(final_amount)),
            is_refund=final_amount < 0,
        )

    today = datetime.now().date()
    ay_start = date(2026, 4, 1) if "2025-26" in fy else date(2025, 4, 1)
    itr_due_date = date(ay_start.year, 7, 31)
    if today <= itr_due_date:
        due_note = f"Today ({today.strftime('%d %b %Y')}) is before the {itr_due_date.strftime('%d %b %Y')} ITR filing deadline — 234B is calculated only for the months actually elapsed so far, not the full year."
    else:
        due_note = f"Today ({today.strftime('%d %b %Y')}) is after the {itr_due_date.strftime('%d %b %Y')} ITR filing deadline — file as soon as possible, additional interest under Section 234A may also apply for late filing (not calculated here)."

    return FullAnalysisResult(
        salary=salary_recon,
        tds=tds_recon,
        other_income_items=other_income_items,
        vda_income_total=round(vda_income_total),
        slab_other_income_total=round(slab_other_income_total),
        non_income_total=round(non_income_total),
        new_regime=calc_regime(True),
        old_regime=calc_regime(False),
        vda_caveat=(
            "AIS/TIS report the gross transaction value for virtual digital "
            "assets, not your actual gain or loss. The amount above may "
            "overstate your real taxable VDA income if your cost basis was "
            "high, or if this included transfers between your own wallets. "
            "Verify against your exchange statements before relying on this."
        ),
        calculation_date=today.strftime("%d %b %Y"),
        itr_due_date_note=due_note,
    )