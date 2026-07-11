import { useState } from "react";
import "./App.css";

const API_URL = "http://localhost:8000";

const FIELD_GROUPS = [
  {
    title: "Salary",
    fields: [
      { key: "gross_salary", label: "Gross salary (annual)", hint: "From Form 16 / payslips" },
      { key: "nps_employer", label: "Employer NPS — 80CCD(2)", hint: "Only deduction New Regime allows" },
    ],
  },
  {
    title: "Other income",
    fields: [
      { key: "sb_interest", label: "Savings bank interest", hint: "From AIS" },
      { key: "fd_interest", label: "FD / deposit interest", hint: "From AIS" },
      { key: "dividend_income", label: "Dividend income", hint: "From AIS" },
    ],
  },
  {
    title: "Tax already paid",
    fields: [
      { key: "tds_salary", label: "TDS on salary", hint: "From Form 16" },
      { key: "tds_other", label: "TDS / TCS on other income", hint: "From AIS / TIS" },
      { key: "advance_tax", label: "Advance tax paid", hint: "If any" },
    ],
  },
];

const EMPTY_FORM = {
  gross_salary: "",
  nps_employer: "",
  sb_interest: "",
  fd_interest: "",
  dividend_income: "",
  tds_salary: "",
  tds_other: "",
  advance_tax: "",
};

function formatINR(value) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(value);
}

export default function App() {
  const [fy, setFy] = useState("FY 2025-26");
  const [form, setForm] = useState(EMPTY_FORM);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const handleChange = (key, value) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const handleCalculate = async () => {
    setLoading(true);
    setError(null);
    try {
      const payload = { fy };
      Object.keys(EMPTY_FORM).forEach((key) => {
        payload[key] = parseFloat(form[key]) || 0;
      });

      const response = await fetch(`${API_URL}/calculate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!response.ok) throw new Error("Calculation failed — check the API is running.");
      const data = await response.json();
      setResult(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleReset = () => {
    setForm(EMPTY_FORM);
    setResult(null);
    setError(null);
  };

  return (
    <div className="page">
      <header className="masthead">
        <span className="eyebrow">Personal · New Regime · Not Financial Advice</span>
        <h1 className="wordmark">Ledger</h1>
        <p className="tagline">A tax reckoning, kept plainly.</p>
      </header>

      <main className="layout">
        <section className="form-column">
          <div className="fy-toggle">
            <label>
              <input
                type="radio"
                name="fy"
                checked={fy === "FY 2025-26"}
                onChange={() => setFy("FY 2025-26")}
              />
              <span>FY 2025-26 (AY 2026-27)</span>
            </label>
            <label>
              <input
                type="radio"
                name="fy"
                checked={fy === "FY 2024-25"}
                onChange={() => setFy("FY 2024-25")}
              />
              <span>FY 2024-25 (AY 2025-26)</span>
            </label>
          </div>

          {FIELD_GROUPS.map((group) => (
            <fieldset className="entry-group" key={group.title}>
              <legend>{group.title}</legend>
              {group.fields.map((field) => (
                <div className="entry-row" key={field.key}>
                  <div className="entry-label">
                    <span>{field.label}</span>
                    <small>{field.hint}</small>
                  </div>
                  <div className="entry-input">
                    <span className="rupee">₹</span>
                    <input
                      type="number"
                      inputMode="decimal"
                      placeholder="0"
                      value={form[field.key]}
                      onChange={(e) => handleChange(field.key, e.target.value)}
                    />
                  </div>
                </div>
              ))}
            </fieldset>
          ))}

          <div className="action-row">
            <button className="btn-primary" onClick={handleCalculate} disabled={loading}>
              {loading ? "Reckoning…" : "Calculate"}
            </button>
            <button className="btn-ghost" onClick={handleReset}>
              Reset
            </button>
          </div>

          {error && <p className="error-note">{error}</p>}
        </section>

        <section className="stub-column">
          <div className={`stub ${result ? "stub-filled" : ""}`}>
            <div className="stub-notch" />
            <div className="stub-head">
              <span>Tax Reckoning</span>
              <span>{fy}</span>
            </div>

            {!result && (
              <p className="stub-placeholder">
                Fill in your figures and calculate — your result will be itemised here, like a
                receipt.
              </p>
            )}

            {result && (
              <>
                <div className="stub-line">
                  <span>Taxable income</span>
                  <span className="figure">{formatINR(result.taxable_income)}</span>
                </div>
                <div className="stub-line">
                  <span>Base tax</span>
                  <span className="figure">{formatINR(result.base_tax)}</span>
                </div>
                <div className="stub-line">
                  <span>+ 4% Health &amp; Education cess</span>
                  <span className="figure">{formatINR(result.tax_with_cess)}</span>
                </div>
                <div className="stub-line">
                  <span>Tax already paid (TDS + advance)</span>
                  <span className="figure">− {formatINR(result.total_tds_paid)}</span>
                </div>
                <div className="stub-divider" />
                <div className="stub-total">
                  <span>{result.is_refund ? "Net refundable" : "Net payable"}</span>
                  <span className={`figure figure-large ${result.is_refund ? "refund" : "payable"}`}>
                    {formatINR(result.net_payable)}
                  </span>
                </div>
              </>
            )}

            <div className="stub-notch stub-notch-bottom" />
          </div>

          <p className="disclaimer">
            For personal tracking only. Not a substitute for filing your ITR or advice from a CA.
            Does not account for capital gains, house property income, or surcharge.
          </p>
        </section>
      </main>
    </div>
  );
}
