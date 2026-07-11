import { useState } from "react";
import "./App.css";

const API_URL = "https://ledger-tax-app.onrender.com";

const EMPTY_FORM = {
  gross_salary: "",
  nps_employer: "",
  sb_interest: "",
  fd_interest: "",
  dividend_income: "",
  hra_exemption: "",
  lta_exemption: "",
  other_exemptions: "",
  ded_80c: "",
  ded_80ccd1b: "",
  ded_80d: "",
  ded_80tta_ttb: "",
  ded_other: "",
  tds_salary: "",
  tds_other: "",
  advance_tax: "",
};

const FIELD_GROUPS = [
  {
    title: "Salary",
    fields: [
      { key: "gross_salary", label: "Gross salary (annual)", hint: "From Form 16 / payslips" },
      { key: "nps_employer", label: "Employer NPS — 80CCD(2)", hint: "Allowed in both regimes" },
    ],
  },
  {
    title: "Exemptions",
    subtitle: "Only reduce tax under the Old Regime",
    fields: [
      { key: "hra_exemption", label: "HRA exemption claimed", hint: "" },
      { key: "lta_exemption", label: "LTA exemption claimed", hint: "" },
      { key: "other_exemptions", label: "Other exempt allowances", hint: "" },
    ],
  },
  {
    title: "Chapter VI-A deductions",
    subtitle: "Only reduce tax under the Old Regime",
    fields: [
      { key: "ded_80c", label: "80C (PF, ELSS, LIC…)", hint: "Max ₹1,50,000" },
      { key: "ded_80ccd1b", label: "80CCD(1B) — NPS additional", hint: "Max ₹50,000" },
      { key: "ded_80d", label: "80D — Medical insurance", hint: "" },
      { key: "ded_80tta_ttb", label: "80TTA / 80TTB — interest deduction", hint: "" },
      { key: "ded_other", label: "Other (80E, 80G, 80EEA…)", hint: "" },
    ],
  },
  {
    title: "Other income",
    subtitle: "From AIS",
    fields: [
      { key: "sb_interest", label: "Savings bank interest", hint: "" },
      { key: "fd_interest", label: "FD / deposit interest", hint: "" },
      { key: "dividend_income", label: "Dividend income", hint: "" },
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

const UPLOAD_SLOTS = [
  { key: "payslip", label: "Payslips", hint: "Upload one or more — gross salary is summed", multiple: true },
  { key: "form16", label: "Form 16", hint: "Gross salary + TDS", multiple: false },
  { key: "ais", label: "AIS", hint: "Interest, dividend income", multiple: false },
  { key: "tis", label: "TIS", hint: "TDS / TCS summary", multiple: false },
];

function formatINR(value) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(value);
}

export default function App() {
  const [fy, setFy] = useState("FY 2025-26");
  const [ageGroup, setAgeGroup] = useState("Below 60");
  const [form, setForm] = useState(EMPTY_FORM);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [uploadStatus, setUploadStatus] = useState({});

  const handleChange = (key, value) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const handleFileUpload = async (slotKey, files) => {
    if (!files || files.length === 0) return;
    setUploadStatus((prev) => ({ ...prev, [slotKey]: "reading…" }));

    try {
      if (slotKey === "payslip") {
        let totalGross = 0;
        let totalTds = 0;
        let foundAny = false;
        for (const file of files) {
          const fd = new FormData();
          fd.append("file", file);
          fd.append("doc_type", "payslip");
          const res = await fetch(`${API_URL}/extract`, { method: "POST", body: fd });
          const data = await res.json();
          if (data.gross_salary) {
            totalGross += data.gross_salary;
            foundAny = true;
          }
          if (data.tds) totalTds += data.tds;
        }
        if (foundAny) {
          setForm((prev) => ({
            ...prev,
            gross_salary: String(totalGross),
            tds_salary: totalTds ? String(totalTds) : prev.tds_salary,
          }));
          setUploadStatus((prev) => ({ ...prev, payslip: `extracted from ${files.length} file(s)` }));
        } else {
          setUploadStatus((prev) => ({ ...prev, payslip: "couldn't detect figures — enter manually" }));
        }
        return;
      }

      const file = files[0];
      const fd = new FormData();
      fd.append("file", file);
      fd.append("doc_type", slotKey);
      const res = await fetch(`${API_URL}/extract`, { method: "POST", body: fd });
      const data = await res.json();

      if (slotKey === "form16") {
        const updates = {};
        if (data.gross_salary) updates.gross_salary = String(data.gross_salary);
        if (data.tds) updates.tds_salary = String(data.tds);
        setForm((prev) => ({ ...prev, ...updates }));
        setUploadStatus((prev) => ({
          ...prev,
          form16: Object.keys(updates).length ? "extracted — please verify" : "couldn't detect figures",
        }));
      } else if (slotKey === "ais") {
        const updates = {};
        if (data.sb_interest) updates.sb_interest = String(data.sb_interest);
        if (data.fd_interest) updates.fd_interest = String(data.fd_interest);
        if (data.dividend_income) updates.dividend_income = String(data.dividend_income);
        setForm((prev) => ({ ...prev, ...updates }));
        setUploadStatus((prev) => ({
          ...prev,
          ais: Object.keys(updates).length ? "extracted — please verify" : "couldn't detect figures",
        }));
      } else if (slotKey === "tis") {
        const updates = {};
        if (data.tds) updates.tds_other = String(data.tds);
        setForm((prev) => ({ ...prev, ...updates }));
        setUploadStatus((prev) => ({
          ...prev,
          tis: Object.keys(updates).length ? "extracted — please verify" : "couldn't detect figures",
        }));
      }
    } catch (err) {
      setUploadStatus((prev) => ({ ...prev, [slotKey]: "upload failed — enter manually" }));
    }
  };

  const handleCalculate = async () => {
    setLoading(true);
    setError(null);
    try {
      const payload = { fy, age_group: ageGroup };
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
    setUploadStatus({});
  };

  const renderRegimeStub = (label, regimeResult, isBetter) => (
    <div className={`stub ${regimeResult ? "stub-filled" : ""} ${isBetter ? "stub-best" : ""}`}>
      <div className="stub-notch" />
      <div className="stub-head">
        <span>{label}</span>
        {isBetter && <span className="best-tag">Better for you</span>}
      </div>

      {!regimeResult && <p className="stub-placeholder">Calculate to see this regime's figures.</p>}

      {regimeResult && (
        <>
          <div className="stub-line">
            <span>Taxable income</span>
            <span className="figure">{formatINR(regimeResult.taxable_income)}</span>
          </div>
          <div className="stub-line">
            <span>Base tax</span>
            <span className="figure">{formatINR(regimeResult.base_tax)}</span>
          </div>
          <div className="stub-line">
            <span>+ 4% cess</span>
            <span className="figure">{formatINR(regimeResult.tax_with_cess)}</span>
          </div>
          <div className="stub-divider" />
          <div className="stub-total">
            <span>{regimeResult.is_refund ? "Net refundable" : "Net payable"}</span>
            <span className={`figure figure-large ${regimeResult.is_refund ? "refund" : "payable"}`}>
              {formatINR(regimeResult.net_payable)}
            </span>
          </div>
        </>
      )}
      <div className="stub-notch stub-notch-bottom" />
    </div>
  );

  return (
    <div className="page">
      <header className="masthead">
        <span className="eyebrow">Personal · Old &amp; New Regime · Not Financial Advice</span>
        <h1 className="wordmark">Ledger</h1>
        <p className="tagline">A tax reckoning, kept plainly.</p>
      </header>

      <main className="layout">
        <section className="form-column">
          <div className="fy-toggle">
            <label>
              <input type="radio" name="fy" checked={fy === "FY 2025-26"} onChange={() => setFy("FY 2025-26")} />
              <span>FY 2025-26 (AY 2026-27)</span>
            </label>
            <label>
              <input type="radio" name="fy" checked={fy === "FY 2024-25"} onChange={() => setFy("FY 2024-25")} />
              <span>FY 2024-25 (AY 2025-26)</span>
            </label>
          </div>

          <div className="age-select">
            <label htmlFor="age-group">Age category (affects Old Regime exemption limit)</label>
            <select id="age-group" value={ageGroup} onChange={(e) => setAgeGroup(e.target.value)}>
              <option value="Below 60">Below 60</option>
              <option value="60 to 79">60 to 79 (Senior citizen)</option>
              <option value="80 and above">80 and above (Super senior citizen)</option>
            </select>
          </div>

          <fieldset className="entry-group upload-group">
            <legend>Upload documents</legend>
            <p className="upload-note">
              Best-effort text extraction — always verify the auto-filled numbers below before calculating.
            </p>
            <div className="upload-grid">
              {UPLOAD_SLOTS.map((slot) => (
                <div className="upload-slot" key={slot.key}>
                  <label className="upload-label">
                    <span>{slot.label}</span>
                    <small>{slot.hint}</small>
                  </label>
                  <input
                    type="file"
                    accept="application/pdf"
                    multiple={slot.multiple}
                    onChange={(e) => handleFileUpload(slot.key, e.target.files)}
                  />
                  {uploadStatus[slot.key] && <small className="upload-status">{uploadStatus[slot.key]}</small>}
                </div>
              ))}
            </div>
          </fieldset>

          {FIELD_GROUPS.map((group) => (
            <fieldset className="entry-group" key={group.title}>
              <legend>{group.title}</legend>
              {group.subtitle && <p className="group-subtitle">{group.subtitle}</p>}
              {group.fields.map((field) => (
                <div className="entry-row" key={field.key}>
                  <div className="entry-label">
                    <span>{field.label}</span>
                    {field.hint && <small>{field.hint}</small>}
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
          <div className="stub-head-row">
            <span className="stub-fy-label">{fy}</span>
          </div>
          {renderRegimeStub("New Regime", result?.new_regime, result?.better_regime === "new")}
          {renderRegimeStub("Old Regime", result?.old_regime, result?.better_regime === "old")}

          <p className="disclaimer">
            For personal tracking only. Not a substitute for filing your ITR or advice from a CA.
            Does not account for capital gains, house property income, or surcharge.
          </p>
        </section>
      </main>
    </div>
  );
}