import { useState, useEffect } from "react";
import "./App.css";

const API_URL = "https://ledger-tax-app.onrender.com";

const STANDARD_DEDUCTION = { new: 75000, old: 50000 };

const TREATMENT_LABELS = {
  slab_other_income: { label: "Taxed at slab rate", cls: "tag-slab" },
  vda_flat30: { label: "Flat 30% (VDA - Sec 115BBH)", cls: "tag-vda" },
  non_income: { label: "Not income - excluded", cls: "tag-noincome" },
  capital_gains_needs_review: { label: "Capital gains - review", cls: "tag-review" },
  needs_review: { label: "Unrecognized - review", cls: "tag-review" },
};

function formatINR(value) {
  if (value === null || value === undefined) return "-";
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(value);
}

function formatPlain(value) {
  if (value === null || value === undefined) return "-";
  return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(value);
}

const emptyDetails = {
  nps_employer: "", hra_exemption: "", lta_exemption: "", other_exemptions: "",
  ded_80c: "", ded_80ccd1b: "", ded_80d: "", ded_80tta_ttb: "", ded_other: "",
  advance_tax: "", self_assessment_tax_paid: "", additional_vda_income: "",
};

export default function App() {
  const [fy, setFy] = useState("FY 2025-26");
  const [ageGroup, setAgeGroup] = useState("Below 60");

  const [payslipFiles, setPayslipFiles] = useState([]);
  const [form16File, setForm16File] = useState(null);
  const [aisFile, setAisFile] = useState(null);
  const [tisFile, setTisFile] = useState(null);

  const [details, setDetails] = useState(emptyDetails);

  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [downloadingExcel, setDownloadingExcel] = useState(false);
  const [error, setError] = useState(null);
  const [selectedRegime, setSelectedRegime] = useState("new"); // "new" | "old"

  useEffect(() => {
    if (result?.new_regime && result?.old_regime) {
      const netSigned = (r) => (r.is_refund ? -r.final_amount : r.final_amount);
      setSelectedRegime(netSigned(result.new_regime) <= netSigned(result.old_regime) ? "new" : "old");
    }
  }, [result]);

  const handleDetailChange = (key, value) => {
    setDetails((prev) => ({ ...prev, [key]: value }));
  };

  const buildFormData = () => {
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
    return fd;
  };

  const handleAnalyze = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/full-analysis`, { method: "POST", body: buildFormData() });
      if (!res.ok) throw new Error("Analysis failed - check the API is running.");
      const data = await res.json();
      setResult(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleDownloadExcel = async () => {
    setDownloadingExcel(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/export-excel`, { method: "POST", body: buildFormData() });
      if (!res.ok) throw new Error("Excel export failed - check the API is running.");
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `Tax_Computation_${fy.replace(/\s+/g, "_")}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      setError(err.message);
    } finally {
      setDownloadingExcel(false);
    }
  };

  const handleReset = () => {
    setPayslipFiles([]);
    setForm16File(null);
    setAisFile(null);
    setTisFile(null);
    setDetails(emptyDetails);
    setResult(null);
    setError(null);
  };

  const salaryMatches =
    result?.salary?.form16_total != null &&
    result?.salary?.payslip_total != null &&
    result.salary.additional_income_identified === 0;

  const renderRegimeCard = (key, label, regime, isBest) => {
    if (!regime || !result) return null;
    const isSelected = selectedRegime === key;
    return (
      <div className={`card regime-card ${isBest ? "best" : ""} ${isSelected ? "selected" : ""}`}>
        <div className="regime-head">
          <span className="regime-name">{label}</span>
          {isBest && <span className="best-badge">Better for you</span>}
        </div>

        <div className="regime-row headline">
          <span>Salary (validated)</span>
          <span className="figure">{formatINR(result.salary.final_gross_salary)}</span>
        </div>
        <div className="regime-row headline">
          <span>Other income, all sources (validated)</span>
          <span className="figure">{formatINR(result.slab_other_income_total + result.vda_income_total)}</span>
        </div>

        <div className="regime-row liability">
          <span>Tax liability ({label.toLowerCase()} + VDA flat rate)</span>
          <span className="figure">{formatINR(regime.total_tax)}</span>
        </div>

        <div className="regime-row">
          <span>Less: TDS from salary</span>
          <span className="figure">- {formatINR(result.tds.salary_tds_used)}</span>
        </div>
        <div className="regime-row">
          <span>Less: TDS from other income</span>
          <span className="figure">- {formatINR(result.tds.other_sources_tds)}</span>
        </div>
        {regime.advance_tax_paid > 0 && (
          <div className="regime-row">
            <span>Less: Advance tax paid</span>
            <span className="figure">- {formatINR(regime.advance_tax_paid)}</span>
          </div>
        )}

        <div className="regime-row subtotal">
          <span>Net amount (before interest)</span>
          <span className="figure">{formatINR(regime.net_before_interest)}</span>
        </div>

        {(regime.interest_234b > 0 || regime.interest_234c > 0) ? (
          <>
            <div className="regime-row interest">
              <span>+ Interest u/s 234B ({regime.months_elapsed_234b} month{regime.months_elapsed_234b === 1 ? "" : "s"})</span>
              <span className="figure">{formatINR(regime.interest_234b)}</span>
            </div>
            <div className="regime-row interest">
              <span>+ Interest u/s 234C</span>
              <span className="figure">{formatINR(regime.interest_234c)}</span>
            </div>
          </>
        ) : (
          <div className="regime-row no-interest">
            <span>234B / 234C interest: Not applicable</span>
          </div>
        )}

        {regime.self_assessment_tax_paid > 0 && (
          <div className="regime-row">
            <span>Less: Self-assessment tax already deposited (u/s 140A)</span>
            <span className="figure">- {formatINR(regime.self_assessment_tax_paid)}</span>
          </div>
        )}

        <div className="regime-final">
          <span className="regime-final-label">{regime.is_refund ? "Net refundable" : "Net payable"}</span>
          <span className={`regime-final-amount ${regime.is_refund ? "refund" : "payable"}`}>
            {formatINR(regime.final_amount)}
          </span>
        </div>

        <button
          className={`btn-select-regime ${isSelected ? "active" : ""}`}
          onClick={() => setSelectedRegime(key)}
        >
          {isSelected ? "Selected for detailed computation" : "Use this regime"}
        </button>
      </div>
    );
  };

  const renderSlabBreakdown = (breakdown) => {
    if (!breakdown || breakdown.length === 0) {
      return <p className="detail-note">No slab tax - income within the rebate/exemption limit.</p>;
    }
    return (
      <table className="detail-table">
        <thead>
          <tr>
            <th>Slab</th>
            <th>Rate</th>
            <th>Amount in slab</th>
            <th>Tax</th>
          </tr>
        </thead>
        <tbody>
          {breakdown.map((b, i) => (
            <tr key={i}>
              <td>{formatPlain(b.from_amount)} - {formatPlain(b.to_amount)}</td>
              <td>{b.rate_pct}%</td>
              <td>{formatPlain(b.taxable_amount)}</td>
              <td>{formatPlain(b.tax)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  };

  const renderDetailedComputation = () => {
    if (!result) return null;
    const key = selectedRegime;
    const regime = key === "new" ? result.new_regime : result.old_regime;
    const label = key === "new" ? "New Regime (Sec 115BAC)" : "Old Regime";
    if (!regime) return null;

    return (
      <div className="card detail-card">
        <div className="card-header">
          <span className="card-title">Detailed Computation - {label}</span>
        </div>
        <p className="card-note">
          Line-by-line computation following the same conventions used in professional ITR
          computation sheets - Section 288A/288B rounding, and Section 234B/234C interest
          rounded down to the nearest Rs 100 before the monthly rate is applied.
        </p>

        <div className="detail-section">
          <div className="detail-section-title">Computation of Total Income</div>
          <div className="detail-row">
            <span>Income from Salary</span>
            <span className="figure">{formatINR(regime.salary_income)}</span>
          </div>
          <div className="detail-row sub">
            <span>Gross Salary</span>
            <span className="figure">{formatINR(result.salary.final_gross_salary)}</span>
          </div>
          <div className="detail-row sub">
            <span>Less: Standard Deduction</span>
            <span className="figure">- {formatINR(STANDARD_DEDUCTION[key])}</span>
          </div>
          <div className="detail-row">
            <span>Income from Other Sources</span>
            <span className="figure">{formatINR(result.slab_other_income_total)}</span>
          </div>
          {result.vda_income_total > 0 && (
            <div className="detail-row">
              <span>Income from Capital Gains (VDA - Sec 115BBH)</span>
              <span className="figure">{formatINR(regime.special_rate_income)}</span>
            </div>
          )}
          <div className="detail-row total">
            <span>Gross Total Income</span>
            <span className="figure">{formatINR(regime.gross_total_income)}</span>
          </div>
          <div className="detail-row">
            <span>Round off u/s 288A</span>
            <span className="figure">{formatINR(regime.total_income_rounded_288a)}</span>
          </div>
        </div>

        <div className="detail-section">
          <div className="detail-section-title">Tax on Normal Income (Rs {formatPlain(regime.normal_income)})</div>
          {renderSlabBreakdown(regime.slab_tax_breakdown)}
          <div className="detail-row total">
            <span>Tax on Normal Income</span>
            <span className="figure">{formatINR(regime.slab_tax)}</span>
          </div>
          {regime.special_rate_income > 0 && (
            <div className="detail-row">
              <span>Tax on Special Rate Income (VDA @ 30%)</span>
              <span className="figure">{formatINR(regime.special_rate_tax)}</span>
            </div>
          )}
          <div className="detail-row total">
            <span>Total Tax</span>
            <span className="figure">{formatINR(regime.base_tax)}</span>
          </div>
          <div className="detail-row">
            <span>Health &amp; Education Cess @ 4%</span>
            <span className="figure">{formatINR(regime.cess)}</span>
          </div>
          <div className="detail-row total">
            <span>Total Tax + Cess</span>
            <span className="figure">{formatINR(regime.total_tax)}</span>
          </div>
        </div>

        <div className="detail-section">
          <div className="detail-section-title">Prepaid Taxes</div>
          <div className="detail-row">
            <span>T.D.S. - Salary</span>
            <span className="figure">- {formatINR(result.tds.salary_tds_used)}</span>
          </div>
          <div className="detail-row">
            <span>T.D.S. - Non-Salary</span>
            <span className="figure">- {formatINR(result.tds.other_sources_tds)}</span>
          </div>
          {regime.advance_tax_paid > 0 && (
            <div className="detail-row">
              <span>Advance Tax Paid</span>
              <span className="figure">- {formatINR(regime.advance_tax_paid)}</span>
            </div>
          )}
          <div className="detail-row total">
            <span>Balance (before interest)</span>
            <span className="figure">{formatINR(regime.net_before_interest)}</span>
          </div>
        </div>

        {(regime.interest_234b > 0) && (
          <div className="detail-section">
            <div className="detail-section-title">Interest Calculation u/s 234B</div>
            <table className="detail-table">
              <thead>
                <tr><th>Month</th><th>Principal</th><th>Interest @ 1%</th></tr>
              </thead>
              <tbody>
                {regime.interest_234b_breakdown.map((m, i) => (
                  <tr key={i}>
                    <td>{m.month}</td>
                    <td>{formatPlain(m.principal)}</td>
                    <td>{formatPlain(m.interest)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="detail-row total">
              <span>Total Interest u/s 234B</span>
              <span className="figure">{formatINR(regime.interest_234b)}</span>
            </div>
          </div>
        )}

        {(regime.interest_234c > 0) && (
          <div className="detail-section">
            <div className="detail-section-title">Interest Calculation u/s 234C</div>
            <table className="detail-table">
              <thead>
                <tr><th>Installment</th><th>Required %</th><th>Required Amt</th><th>Remaining Due (rounded)</th><th>Interest</th></tr>
              </thead>
              <tbody>
                {regime.interest_234c_breakdown.map((c, i) => (
                  <tr key={i}>
                    <td>{c.installment}</td>
                    <td>{c.required_pct}%</td>
                    <td>{formatPlain(c.required_amount)}</td>
                    <td>{formatPlain(c.remaining_due_rounded)}</td>
                    <td>{formatPlain(c.interest)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="detail-row total">
              <span>Total Interest u/s 234C</span>
              <span className="figure">{formatINR(regime.interest_234c)}</span>
            </div>
          </div>
        )}

        <div className="detail-section">
          <div className="detail-section-title">Final Settlement</div>
          <div className="detail-row">
            <span>Balance + Interest (234B + 234C)</span>
            <span className="figure">{formatINR(regime.amount_before_288b)}</span>
          </div>
          <div className="detail-row">
            <span>Round off u/s 288B</span>
            <span className="figure">{formatINR(regime.rounded_288b)}</span>
          </div>
          {regime.self_assessment_tax_paid > 0 && (
            <div className="detail-row">
              <span>Less: Self-assessment tax deposited (u/s 140A)</span>
              <span className="figure">- {formatINR(regime.self_assessment_tax_paid)}</span>
            </div>
          )}
          <div className="detail-row final-highlight">
            <span>{regime.is_refund ? "Refund Due" : "Tax Payable"}</span>
            <span className="figure">{formatINR(regime.final_amount)}</span>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="page">
      <header className="masthead">
        <div className="masthead-left">
          <div className="brand-row">
            <div className="brand-icon">Rs</div>
            <div>
              <h1 className="wordmark">Tax Calculator</h1>
              <p className="tagline">Built for salaried employees - payslips, Form 16, AIS &amp; TIS, reconciled.</p>
            </div>
          </div>
        </div>
        <span className="eyebrow-pill">Old &amp; New Regime - Not Financial Advice</span>
      </header>

      <div className="two-col-layout">
        {/* ================= LEFT COLUMN: INPUTS ================= */}
        <div className="left-col">
          <div className="card">
            <div className="card-header">
              <div className="card-icon">1</div>
              <span className="card-title">Payslips</span>
            </div>
            <p className="card-note">Upload all your monthly payslips - their gross earnings will be summed.</p>
            <div className="upload-dropzone">
              <input
                type="file"
                accept="application/pdf"
                multiple
                onChange={(e) => setPayslipFiles(Array.from(e.target.files))}
              />
              {payslipFiles.length > 0 && (
                <div className="upload-status-chip">{payslipFiles.length} file(s) selected</div>
              )}
            </div>
          </div>

          <div className="card">
            <div className="card-header">
              <div className="card-icon">2</div>
              <span className="card-title">Form 16</span>
            </div>
            <p className="card-note">
              Authoritative for gross salary and salary TDS. Any gap vs. your payslips (perquisites, bonuses)
              is automatically identified and added.
            </p>
            <div className="upload-dropzone">
              <input type="file" accept="application/pdf" onChange={(e) => setForm16File(e.target.files[0] || null)} />
              {form16File && <div className="upload-status-chip">{form16File.name}</div>}
            </div>
          </div>

          <div className="card">
            <div className="card-header">
              <div className="card-icon">3</div>
              <span className="card-title">AIS &amp; TIS</span>
            </div>
            <p className="card-note">
              Every income category is categorized per the Income Tax Act - fund purchases and foreign
              remittances aren't taxable income and are excluded automatically.
            </p>
            <div className="upload-grid-2">
              <div>
                <span className="upload-slot-label">AIS</span>
                <div className="upload-dropzone">
                  <input type="file" accept="application/pdf" onChange={(e) => setAisFile(e.target.files[0] || null)} />
                  {aisFile && <div className="upload-status-chip">{aisFile.name}</div>}
                </div>
              </div>
              <div>
                <span className="upload-slot-label">TIS</span>
                <div className="upload-dropzone">
                  <input type="file" accept="application/pdf" onChange={(e) => setTisFile(e.target.files[0] || null)} />
                  {tisFile && <div className="upload-status-chip">{tisFile.name}</div>}
                </div>
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-header">
              <div className="card-icon">FY</div>
              <span className="card-title">Year &amp; Category</span>
            </div>
            <div className="field-group">
              <label>Financial Year</label>
              <div className="fy-toggle">
                <label>
                  <input type="radio" name="fy" checked={fy === "FY 2025-26"} onChange={() => setFy("FY 2025-26")} />
                  <span>FY 2025-26</span>
                </label>
                <label>
                  <input type="radio" name="fy" checked={fy === "FY 2024-25"} onChange={() => setFy("FY 2024-25")} />
                  <span>FY 2024-25</span>
                </label>
              </div>
            </div>
            <div className="field-group">
              <label htmlFor="age-group">Age category (affects Old Regime exemption)</label>
              <select id="age-group" className="field-select" value={ageGroup} onChange={(e) => setAgeGroup(e.target.value)}>
                <option value="Below 60">Below 60</option>
                <option value="60 to 79">60 to 79 (Senior citizen)</option>
                <option value="80 and above">80 and above (Super senior citizen)</option>
              </select>
            </div>
          </div>

          <div className="card">
            <div className="card-header">
              <div className="card-icon">NPS</div>
              <span className="card-title">NPS, Advance &amp; Self-Assessment Tax</span>
            </div>
            <div className="entry-row">
              <div className="entry-label"><span>Employer NPS - 80CCD(2)</span><small>Allowed in both regimes</small></div>
              <div className="entry-input">
                <span className="rupee">Rs.</span>
                <input type="number" placeholder="0" value={details.nps_employer} onChange={(e) => handleDetailChange("nps_employer", e.target.value)} />
              </div>
            </div>
            <div className="entry-row">
              <div className="entry-label"><span>Advance tax paid</span><small>Paid during the year, before 31 Mar</small></div>
              <div className="entry-input">
                <span className="rupee">Rs.</span>
                <input type="number" placeholder="0" value={details.advance_tax} onChange={(e) => handleDetailChange("advance_tax", e.target.value)} />
              </div>
            </div>
            <div className="entry-row">
              <div className="entry-label"><span>Self-assessment tax deposited</span><small>Paid u/s 140A at return filing time - reduces final payable but not 234B/234C</small></div>
              <div className="entry-input">
                <span className="rupee">Rs.</span>
                <input type="number" placeholder="0" value={details.self_assessment_tax_paid} onChange={(e) => handleDetailChange("self_assessment_tax_paid", e.target.value)} />
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-header">
              <div className="card-icon">VDA</div>
              <span className="card-title">Capital Gains / Virtual Digital Assets</span>
            </div>
            <p className="card-note">
              Auto-detected from your TIS - no need to enter a transfer date. Only use this field to add
              income not picked up automatically.
            </p>
            <div className="entry-row">
              <div className="entry-label"><span>Additional VDA / capital gains income</span><small>Added on top of anything found in TIS</small></div>
              <div className="entry-input">
                <span className="rupee">Rs.</span>
                <input type="number" placeholder="0" value={details.additional_vda_income} onChange={(e) => handleDetailChange("additional_vda_income", e.target.value)} />
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-header">
              <div className="card-icon">EXM</div>
              <span className="card-title">Exemptions</span>
            </div>
            <p className="section-hint">Only reduce tax under the Old Regime</p>
            {[
              ["hra_exemption", "HRA exemption claimed"],
              ["lta_exemption", "LTA exemption claimed"],
              ["other_exemptions", "Other exempt allowances"],
            ].map(([key, label]) => (
              <div className="entry-row" key={key}>
                <div className="entry-label"><span>{label}</span></div>
                <div className="entry-input">
                  <span className="rupee">Rs.</span>
                  <input type="number" placeholder="0" value={details[key]} onChange={(e) => handleDetailChange(key, e.target.value)} />
                </div>
              </div>
            ))}
          </div>

          <div className="card">
            <div className="card-header">
              <div className="card-icon">80C</div>
              <span className="card-title">Chapter VI-A Deductions</span>
            </div>
            <p className="section-hint">Only reduce tax under the Old Regime</p>
            {[
              ["ded_80c", "80C (PF, ELSS, LIC...)"],
              ["ded_80ccd1b", "80CCD(1B) - NPS additional"],
              ["ded_80d", "80D - Medical insurance"],
              ["ded_80tta_ttb", "80TTA / 80TTB"],
              ["ded_other", "Other (80E, 80G, 80EEA...)"],
            ].map(([key, label]) => (
              <div className="entry-row" key={key}>
                <div className="entry-label"><span>{label}</span></div>
                <div className="entry-input">
                  <span className="rupee">Rs.</span>
                  <input type="number" placeholder="0" value={details[key]} onChange={(e) => handleDetailChange(key, e.target.value)} />
                </div>
              </div>
            ))}
          </div>

          <div className="action-row">
            <button className="btn-primary" onClick={handleAnalyze} disabled={loading}>
              {loading ? "Analyzing..." : "Analyze & Calculate"}
            </button>
            <button className="btn-ghost" onClick={handleReset}>Reset</button>
          </div>

          {error && <div className="error-banner">{error}</div>}
        </div>

        {/* ================= RIGHT COLUMN: RESULTS ================= */}
        <div className="right-col">
          <div className="results-sticky">
            {loading && (
              <div className="loading-card">
                <div className="spinner" />
                <p className="loading-title">Analyzing your documents...</p>
                <p className="loading-subtext">
                  This usually takes just a few seconds. If the server has been idle, the very first
                  request can take up to 30-60 seconds to wake up - subsequent ones will be fast.
                </p>
              </div>
            )}

            {!loading && !result && (
              <div className="empty-card">
                <div className="empty-icon">$</div>
                <p className="empty-title">Your results will appear here</p>
                <p className="empty-subtext">
                  Upload your documents and fill in the details on the left, then click
                  {" "}<strong>Analyze &amp; Calculate</strong>.
                </p>
              </div>
            )}

            {!loading && result && (
              <>
                <div className="date-note">
                  <span className="date-note-icon">i</span>
                  <span>Calculated as of {result.calculation_date} - {result.itr_due_date_note}</span>
                </div>

                <div className="card final-banner">
                  <div className="final-banner-top">
                    <span className="final-banner-title">Final Amount Payable</span>
                    <div className="regime-switch">
                      <button
                        className={selectedRegime === "new" ? "active" : ""}
                        onClick={() => setSelectedRegime("new")}
                      >
                        New Regime
                      </button>
                      <button
                        className={selectedRegime === "old" ? "active" : ""}
                        onClick={() => setSelectedRegime("old")}
                      >
                        Old Regime
                      </button>
                    </div>
                  </div>
                  {(() => {
                    const regime = selectedRegime === "new" ? result.new_regime : result.old_regime;
                    return (
                      <>
                        <span className={`final-banner-amount ${regime.is_refund ? "refund" : "payable"}`}>
                          {formatINR(regime.final_amount)}
                        </span>
                        <span className="final-banner-label">
                          {regime.is_refund ? "refundable to you" : "payable by you"} - matches the {selectedRegime === "new" ? "New" : "Old"} Regime card and Detailed Computation below
                        </span>
                      </>
                    );
                  })()}
                </div>

                <div className="card recon-card">
                  <div className="recon-status-row">
                    <span className={`status-badge ${salaryMatches ? "match" : "mismatch"}`}>
                      {salaryMatches ? "Match" : "Gap found"}
                    </span>
                    <span className="card-title">Salary Reconciliation</span>
                  </div>
                  <div className="recon-row">
                    <span>Payslip total (summed)</span>
                    <span className="figure">{formatINR(result.salary.payslip_total)}</span>
                  </div>
                  <div className="recon-row">
                    <span>Form 16 gross salary</span>
                    <span className="figure">{formatINR(result.salary.form16_total)}</span>
                  </div>
                  <div className="recon-row highlight">
                    <span>Additional income identified &amp; added</span>
                    <span className="figure">{formatINR(result.salary.additional_income_identified)}</span>
                  </div>
                  <div className="recon-row total">
                    <span>Final gross salary used</span>
                    <span className="figure">{formatINR(result.salary.final_gross_salary)}</span>
                  </div>
                </div>

                <div className="card recon-card">
                  <div className="recon-status-row">
                    <span className="status-badge match">TDS</span>
                    <span className="card-title">TDS Reconciliation</span>
                  </div>
                  <div className="recon-row">
                    <span>Payslip TDS total (summed)</span>
                    <span className="figure">{formatINR(result.tds.payslip_tds_total)}</span>
                  </div>
                  <div className="recon-row">
                    <span>Form 16 / AIS salary TDS</span>
                    <span className="figure">{formatINR(result.tds.form16_tds)}</span>
                  </div>
                  <div className="recon-row total">
                    <span>Salary TDS used</span>
                    <span className="figure">{formatINR(result.tds.salary_tds_used)}</span>
                  </div>
                  <div className="recon-row">
                    <span>+ TDS on other income (AIS)</span>
                    <span className="figure">{formatINR(result.tds.other_sources_tds)}</span>
                  </div>
                  <div className="recon-row total">
                    <span>Total TDS paid</span>
                    <span className="figure">{formatINR(result.tds.total_tds)}</span>
                  </div>
                </div>

                {result.other_income_items.length > 0 && (
                  <div className="card recon-card">
                    <div className="card-header">
                      <span className="card-title">Other Income - Categorized per Income Tax Act</span>
                    </div>
                    <div className="income-list">
                      {result.other_income_items.map((item, i) => {
                        const t = TREATMENT_LABELS[item.treatment] || TREATMENT_LABELS.needs_review;
                        return (
                          <div className="income-item" key={i}>
                            <div className="income-item-main">
                              <span className="income-item-name">{item.category}</span>
                              <span className={`income-tag ${t.cls}`}>{t.label}</span>
                            </div>
                            <span className="income-item-amount">{formatINR(item.amount)}</span>
                          </div>
                        );
                      })}
                    </div>
                    {result.vda_income_total > 0 && <p className="caveat-note">{result.vda_caveat}</p>}
                  </div>
                )}

                {(() => {
                  const netSigned = (r) => (r.is_refund ? -r.final_amount : r.final_amount);
                  const newIsBetter = netSigned(result.new_regime) <= netSigned(result.old_regime);
                  return (
                    <>
                      {renderRegimeCard("new", "New Regime", result.new_regime, newIsBetter)}
                      {renderRegimeCard("old", "Old Regime", result.old_regime, !newIsBetter)}
                    </>
                  );
                })()}

                {renderDetailedComputation()}

                <div className="card download-card">
                  <div className="download-card-text">
                    <span className="card-title">Download Full Computation</span>
                    <p className="card-note">
                      A formatted Excel workbook - Summary, Income &amp; TDS Detail, and a fully worked
                      sheet for each regime, matching the Detailed Computation above.
                    </p>
                  </div>
                  <button className="btn-primary btn-download" onClick={handleDownloadExcel} disabled={downloadingExcel}>
                    {downloadingExcel ? "Preparing..." : "Download Excel"}
                  </button>
                </div>

                <p className="disclaimer-footer">
                  For personal tracking only. Not a substitute for filing your ITR or advice from a CA.
                  234B/234C figures follow Section 288A/288B rounding and the floor-to-nearest-Rs-100
                  convention used by ITR computation software. 234C is calculated using the full assessed
                  tax for every installment that has already come due, without needing a capital-gains
                  transfer date - a small, always-conservative simplification. Does not account for house
                  property income or surcharge on very high incomes.
                </p>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
