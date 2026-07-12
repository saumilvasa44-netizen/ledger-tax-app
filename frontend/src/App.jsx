import { useState } from "react";
import "./App.css";

const API_URL = "https://ledger-tax-app.onrender.com";

const TREATMENT_LABELS = {
  slab_other_income: { label: "Taxed at slab rate", cls: "tag-slab" },
  vda_flat30: { label: "Flat 30% (VDA — Sec 115BBH)", cls: "tag-vda" },
  non_income: { label: "Not income — excluded", cls: "tag-noincome" },
  capital_gains_needs_review: { label: "Capital gains — needs manual review", cls: "tag-review" },
  needs_review: { label: "Unrecognized — needs manual review", cls: "tag-review" },
};

function formatINR(value) {
  if (value === null || value === undefined) return "—";
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(value);
}

export default function App() {
  const [activeTab, setActiveTab] = useState("documents");
  const [fy, setFy] = useState("FY 2025-26");
  const [ageGroup, setAgeGroup] = useState("Below 60");

  const [payslipFiles, setPayslipFiles] = useState([]);
  const [form16File, setForm16File] = useState(null);
  const [aisFile, setAisFile] = useState(null);
  const [tisFile, setTisFile] = useState(null);

  const [details, setDetails] = useState({
    nps_employer: "", hra_exemption: "", lta_exemption: "", other_exemptions: "",
    ded_80c: "", ded_80ccd1b: "", ded_80d: "", ded_80tta_ttb: "", ded_other: "",
    advance_tax: "",
  });

  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const handleDetailChange = (key, value) => {
    setDetails((prev) => ({ ...prev, [key]: value }));
  };

  const handleAnalyze = async () => {
    setLoading(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("fy", fy);
      fd.append("age_group", ageGroup);
      Object.entries(details).forEach(([key, value]) => {
        fd.append(key, parseFloat(value) || 0);
      });
      payslipFiles.forEach((f) => fd.append("payslips", f));
      if (form16File) fd.append("form16", form16File);
      if (aisFile) fd.append("ais", aisFile);
      if (tisFile) fd.append("tis", tisFile);

      const res = await fetch(`${API_URL}/full-analysis`, { method: "POST", body: fd });
      if (!res.ok) throw new Error("Analysis failed — check the API is running.");
      const data = await res.json();
      setResult(data);
      setActiveTab("results");
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleReset = () => {
    setPayslipFiles([]);
    setForm16File(null);
    setAisFile(null);
    setTisFile(null);
    setDetails({
      nps_employer: "", hra_exemption: "", lta_exemption: "", other_exemptions: "",
      ded_80c: "", ded_80ccd1b: "", ded_80d: "", ded_80tta_ttb: "", ded_other: "",
      advance_tax: "",
    });
    setResult(null);
    setError(null);
  };

  const salaryMatches =
    result?.salary?.form16_total != null &&
    result?.salary?.payslip_total != null &&
    result.salary.additional_income_identified === 0;

  const renderRegimeCard = (label, regime) => {
    if (!regime || !result) return null;
    return (
      <div className="analysis-card">
        <div className="analysis-card-head">{label}</div>

        <div className="analysis-row analysis-headline">
          <span>Salary (validated)</span>
          <span className="figure">{formatINR(result.salary.final_gross_salary)}</span>
        </div>
        <div className="analysis-row analysis-headline">
          <span>Other income, all sources (validated)</span>
          <span className="figure">{formatINR(result.slab_other_income_total + result.vda_income_total)}</span>
        </div>

        <div className="analysis-row analysis-subtotal analysis-tax-liability">
          <span>Tax liability ({label.toLowerCase()} slabs + VDA flat rate)</span>
          <span className="figure">{formatINR(regime.total_tax)}</span>
        </div>

        <div className="analysis-row">
          <span>Less: TDS from salary (per documents)</span>
          <span className="figure">− {formatINR(result.tds.salary_tds_used)}</span>
        </div>
        <div className="analysis-row">
          <span>Less: TDS from other income (per AIS)</span>
          <span className="figure">− {formatINR(result.tds.other_sources_tds)}</span>
        </div>

        <div className="analysis-row analysis-subtotal">
          <span>Net amount (before interest)</span>
          <span className="figure">{formatINR(regime.net_before_interest)}</span>
        </div>

        {(regime.interest_234b > 0 || regime.interest_234c > 0) ? (
          <>
            <div className="analysis-row analysis-interest">
              <span>+ Interest u/s 234B ({regime.months_elapsed_234b} month{regime.months_elapsed_234b === 1 ? "" : "s"} elapsed, estimate)</span>
              <span className="figure">{formatINR(regime.interest_234b)}</span>
            </div>
            <div className="analysis-row analysis-interest">
              <span>+ Interest u/s 234C (estimate)</span>
              <span className="figure">{formatINR(regime.interest_234c)}</span>
            </div>
          </>
        ) : (
          <div className="analysis-row analysis-no-interest">
            <span>234B / 234C interest</span>
            <span className="figure">Not applicable</span>
          </div>
        )}

        <div className="stub-divider" />
        <div className="analysis-final">
          <span>{regime.is_refund ? "Net refundable" : "Net payable"}</span>
          <span className={`figure figure-large ${regime.is_refund ? "refund" : "payable"}`}>
            {formatINR(regime.final_amount)}
          </span>
        </div>
      </div>
    );
  };

  return (
    <div className="page">
      <header className="masthead">
        <span className="eyebrow">For Salaried Employees · Old &amp; New Regime · Not Financial Advice</span>
        <h1 className="wordmark">Tax Calculator</h1>
        <p className="tagline">Built for salaried employees — payslips, Form 16, AIS &amp; TIS, reconciled.</p>
      </header>

      <nav className="tab-nav">
        <button className={activeTab === "documents" ? "tab-active" : ""} onClick={() => setActiveTab("documents")}>
          1 · Documents
        </button>
        <button className={activeTab === "details" ? "tab-active" : ""} onClick={() => setActiveTab("details")}>
          2 · Details
        </button>
        <button className={activeTab === "results" ? "tab-active" : ""} onClick={() => setActiveTab("results")}>
          3 · Results
        </button>
      </nav>

      {activeTab === "documents" && (
        <section className="tab-panel">
          <fieldset className="entry-group upload-group">
            <legend>Step 1 — Payslips</legend>
            <p className="upload-note">Upload all your monthly payslips. Their gross earnings will be summed.</p>
            <input
              type="file"
              accept="application/pdf"
              multiple
              onChange={(e) => setPayslipFiles(Array.from(e.target.files))}
            />
            {payslipFiles.length > 0 && <small className="upload-status">{payslipFiles.length} file(s) selected</small>}
          </fieldset>

          <fieldset className="entry-group upload-group">
            <legend>Step 2 — Form 16</legend>
            <p className="upload-note">
              Authoritative for gross salary and salary TDS. Any gap vs. your payslips (e.g. perquisites) is
              automatically identified and added.
            </p>
            <input type="file" accept="application/pdf" onChange={(e) => setForm16File(e.target.files[0] || null)} />
            {form16File && <small className="upload-status">{form16File.name}</small>}
          </fieldset>

          <fieldset className="entry-group upload-group">
            <legend>Step 3 — AIS &amp; TIS</legend>
            <p className="upload-note">
              Every income category is categorized per the Income Tax Act — some AIS/TIS entries (like fund
              purchases or foreign remittances) aren't actually taxable income and are excluded automatically.
            </p>
            <div className="upload-grid">
              <div className="upload-slot">
                <label className="upload-label"><span>AIS</span></label>
                <input type="file" accept="application/pdf" onChange={(e) => setAisFile(e.target.files[0] || null)} />
                {aisFile && <small className="upload-status">{aisFile.name}</small>}
              </div>
              <div className="upload-slot">
                <label className="upload-label"><span>TIS</span></label>
                <input type="file" accept="application/pdf" onChange={(e) => setTisFile(e.target.files[0] || null)} />
                {tisFile && <small className="upload-status">{tisFile.name}</small>}
              </div>
            </div>
          </fieldset>

          <button className="btn-primary" onClick={() => setActiveTab("details")}>
            Continue to Details →
          </button>
        </section>
      )}

      {activeTab === "details" && (
        <section className="tab-panel">
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

          <fieldset className="entry-group">
            <legend>NPS &amp; Advance Tax</legend>
            <div className="entry-row">
              <div className="entry-label"><span>Employer NPS — 80CCD(2)</span><small>Allowed in both regimes</small></div>
              <div className="entry-input">
                <span className="rupee">₹</span>
                <input type="number" placeholder="0" value={details.nps_employer} onChange={(e) => handleDetailChange("nps_employer", e.target.value)} />
              </div>
            </div>
            <div className="entry-row">
              <div className="entry-label"><span>Advance tax already paid</span><small>If any</small></div>
              <div className="entry-input">
                <span className="rupee">₹</span>
                <input type="number" placeholder="0" value={details.advance_tax} onChange={(e) => handleDetailChange("advance_tax", e.target.value)} />
              </div>
            </div>
          </fieldset>

          <fieldset className="entry-group">
            <legend>Exemptions</legend>
            <p className="group-subtitle">Only reduce tax under the Old Regime</p>
            {[
              ["hra_exemption", "HRA exemption claimed"],
              ["lta_exemption", "LTA exemption claimed"],
              ["other_exemptions", "Other exempt allowances"],
            ].map(([key, label]) => (
              <div className="entry-row" key={key}>
                <div className="entry-label"><span>{label}</span></div>
                <div className="entry-input">
                  <span className="rupee">₹</span>
                  <input type="number" placeholder="0" value={details[key]} onChange={(e) => handleDetailChange(key, e.target.value)} />
                </div>
              </div>
            ))}
          </fieldset>

          <fieldset className="entry-group">
            <legend>Chapter VI-A deductions</legend>
            <p className="group-subtitle">Only reduce tax under the Old Regime</p>
            {[
              ["ded_80c", "80C (PF, ELSS, LIC…)"],
              ["ded_80ccd1b", "80CCD(1B) — NPS additional"],
              ["ded_80d", "80D — Medical insurance"],
              ["ded_80tta_ttb", "80TTA / 80TTB"],
              ["ded_other", "Other (80E, 80G, 80EEA…)"],
            ].map(([key, label]) => (
              <div className="entry-row" key={key}>
                <div className="entry-label"><span>{label}</span></div>
                <div className="entry-input">
                  <span className="rupee">₹</span>
                  <input type="number" placeholder="0" value={details[key]} onChange={(e) => handleDetailChange(key, e.target.value)} />
                </div>
              </div>
            ))}
          </fieldset>

          <div className="action-row">
            <button className="btn-primary" onClick={handleAnalyze} disabled={loading}>
              {loading ? "Analyzing…" : "Analyze & Calculate"}
            </button>
            <button className="btn-ghost" onClick={handleReset}>Reset</button>
          </div>

          {error && <p className="error-note">{error}</p>}
        </section>
      )}

      {activeTab === "results" && (
        <section className="tab-panel tab-panel-wide">
          {!result && <p className="stub-placeholder">Run the analysis from the Details tab first.</p>}

          {result && (
            <>
              <div className="date-note">
                📅 Calculated as of {result.calculation_date} — {result.itr_due_date_note}
              </div>

              <div className={`compare-card ${salaryMatches ? "compare-match" : "compare-mismatch"}`}>
                <div className="compare-title">Salary Reconciliation</div>
                <div className="compare-row">
                  <span>Payslip total (summed)</span>
                  <span className="figure">{formatINR(result.salary.payslip_total)}</span>
                </div>
                <div className="compare-row">
                  <span>Form 16 gross salary</span>
                  <span className="figure">{formatINR(result.salary.form16_total)}</span>
                </div>
                <div className="compare-row compare-diff">
                  <span>Additional income identified &amp; added</span>
                  <span className="figure">{formatINR(result.salary.additional_income_identified)}</span>
                </div>
                <div className="compare-row analysis-subtotal">
                  <span>Final gross salary used</span>
                  <span className="figure">{formatINR(result.salary.final_gross_salary)}</span>
                </div>
              </div>

              <div className="compare-card compare-match">
                <div className="compare-title">TDS Reconciliation</div>
                <div className="compare-row">
                  <span>Payslip TDS total (summed)</span>
                  <span className="figure">{formatINR(result.tds.payslip_tds_total)}</span>
                </div>
                <div className="compare-row">
                  <span>Form 16 / AIS salary TDS</span>
                  <span className="figure">{formatINR(result.tds.form16_tds)}</span>
                </div>
                <div className="compare-row analysis-subtotal">
                  <span>Salary TDS used</span>
                  <span className="figure">{formatINR(result.tds.salary_tds_used)}</span>
                </div>
                <div className="compare-row">
                  <span>+ TDS on other income (from AIS)</span>
                  <span className="figure">{formatINR(result.tds.other_sources_tds)}</span>
                </div>
                <div className="compare-row analysis-subtotal">
                  <span>Total TDS paid</span>
                  <span className="figure">{formatINR(result.tds.total_tds)}</span>
                </div>
              </div>

              {result.other_income_items.length > 0 && (
                <div className="compare-card compare-match">
                  <div className="compare-title">Other Income — Categorized per Income Tax Act</div>
                  <table className="income-table">
                    <tbody>
                      {result.other_income_items.map((item, i) => {
                        const t = TREATMENT_LABELS[item.treatment] || TREATMENT_LABELS.needs_review;
                        return (
                          <tr key={i}>
                            <td>{item.category}</td>
                            <td className="figure">{formatINR(item.amount)}</td>
                            <td><span className={`income-tag ${t.cls}`}>{t.label}</span></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {result.vda_income_total > 0 && <p className="compare-note">{result.vda_caveat}</p>}
                </div>
              )}

              <div className="stub-head-row">
                <span className="stub-fy-label">{fy}</span>
              </div>
              {renderRegimeCard("New Regime", result.new_regime)}
              {renderRegimeCard("Old Regime", result.old_regime)}

              <p className="disclaimer">
                For personal tracking only. Not a substitute for filing your ITR or advice from a CA.
                234B/234C interest figures are simplified estimates — the actual computation during
                assessment may differ based on exact payment timing. Does not account for capital gains
                (flagged separately if detected), house property income, or surcharge on very high incomes.
              </p>
            </>
          )}
        </section>
      )}
    </div>
  );
}