from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

app = FastAPI(title="ITR Tax Tracker API")

# Allow the React frontend (running on a different port/domain) to call this API.
# For local dev this covers Vite's default port; add your deployed frontend URL later.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # tighten this to your actual frontend URL before sharing publicly
    allow_methods=["*"],
    allow_headers=["*"],
)


class TaxInput(BaseModel):
    fy: str  # "FY 2025-26" or "FY 2024-25"
    gross_salary: float
    nps_employer: float = 0.0
    sb_interest: float = 0.0
    fd_interest: float = 0.0
    dividend_income: float = 0.0
    tds_salary: float = 0.0
    tds_other: float = 0.0
    advance_tax: float = 0.0


class TaxResult(BaseModel):
    taxable_income: float
    base_tax: float
    tax_with_cess: float
    total_tds_paid: float
    net_payable: float
    is_refund: bool


STANDARD_DEDUCTION = 75000


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


@app.get("/")
def root():
    return {"status": "ok", "service": "ITR Tax Tracker API"}


@app.post("/calculate", response_model=TaxResult)
def calculate_tax(data: TaxInput):
    salary_income = max(0.0, data.gross_salary - STANDARD_DEDUCTION - data.nps_employer)
    other_income_total = data.sb_interest + data.fd_interest + data.dividend_income
    taxable_income = max(0.0, salary_income + other_income_total)

    base_tax = compute_new_regime_tax(taxable_income, data.fy)
    tax_with_cess = base_tax * 1.04  # 4% Health & Education cess

    total_tds_paid = data.tds_salary + data.tds_other + data.advance_tax
    net_payable = tax_with_cess - total_tds_paid

    return TaxResult(
        taxable_income=round(taxable_income, 2),
        base_tax=round(base_tax, 2),
        tax_with_cess=round(tax_with_cess, 2),
        total_tds_paid=round(total_tds_paid, 2),
        net_payable=round(abs(net_payable), 2),
        is_refund=net_payable < 0,
    )
