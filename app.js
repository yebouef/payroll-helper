/*
 * app.js — UI controller for the Brittco Payroll Helper (phase-1 prototype).
 * The heavy lifting lives in /src modules (the same code the tests exercise).
 * This file is intentionally the ONLY DOM-aware layer, so phase-2 can replace it
 * with a web front-end while reusing /src untouched.
 */
(function () {
  "use strict";

  // ---- pdf.js worker ----
  // The worker is loaded as a normal <script> (registers window.pdfjsWorker), so
  // pdf.js runs it on the MAIN THREAD — no Worker process, blob, or server needed.
  // workerSrc must be a non-empty string; the global is what actually executes.
  if (window.pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js";
  }

  var SETTINGS_KEY = "brittco_settings_v1";
  var RULELIB_KEY = "brittco_rulelib_v1";
  var LEDGER_KEY = "brittco_ledger_v1";
  // Safe localStorage wrapper — never let storage restrictions crash the app.
  var LS = (function () {
    var ls = Storage.safeLocalStorage();
    return {
      get: function (k) { try { return ls ? ls.getItem(k) : null; } catch (e) { return null; } },
      set: function (k, v) { try { if (ls) ls.setItem(k, v); } catch (e) {} },
    };
  })();
  var store = Storage.makeStore();

  // ---- state ----
  var state = {
    settings: loadSettings(),
    ruleLib: loadRuleLib(),
    rates: [], // resolved from ruleLib by refreshRates()
    mode: "normal", // "normal" | "discovery"
    activeTab: "setup",
    ledger: loadLedger(),
    files: [], // {name, buffer}
    master: [], // parsed + manual shifts
    excluded: {}, // id -> true
    claim: null,
    warnings: [],
    periodNote: null,
    periodSet: false, // becomes true once the period is detected from PDFs or set manually
    suggestion: null, // {payday,startISO,endISO,min,max} when uploaded files belong to another period
    adjustments: [], // back pay / deductions for the CURRENT period: {id,label,amount,sourcePeriodId}
    draft: null,
    reviewedAck: false,
  };
  refreshRates(); // populate state.rates from the rule library

  // ---- persistence helpers ----
  function loadSettings() {
    var d = {
      initials: "", // used only for the older grid export
      staffName: "", // your name as it appears in Brittco (used to claim your shifts)
      payAnchorISO: "2026-06-26", // a known pay day; pay is every 2 weeks from here
      paydayISO: null,            // current pay day (derived from schedule on boot)
      periodStartISO: "2026-06-01",
      periodEndISO: "2026-06-14",
      to: "admin@impactcareohio.com", // coordinator (fixed); editable in Setup
      from: "", // each user sets their own name/email in Setup → saved locally
    };
    try { return Object.assign(d, JSON.parse(LS.get(SETTINGS_KEY) || "{}")); }
    catch (e) { return d; }
  }
  function todayISO() {
    var n = new Date();
    return n.getFullYear() + "-" + DateUtil.pad(n.getMonth() + 1) + "-" + DateUtil.pad(n.getDate());
  }
  // Derive the period (start/end) from the current pay day. Pay day is the source of truth.
  function deriveFromPayday() {
    var p = DateUtil.periodFromPayday(state.settings.paydayISO);
    state.settings.periodStartISO = p.startISO;
    state.settings.periodEndISO = p.endISO;
  }
  function setPayday(iso, snap) {
    state.settings.paydayISO = snap ? DateUtil.snapPayday(iso, state.settings.payAnchorISO) : iso;
    state.settings.periodOverride = false; // choosing a pay day re-derives the period
    deriveFromPayday();
    state.periodSet = true;
    saveSettings(); bindSetup(); renderRequiredWeeks(); recompute();
  }
  function saveSettings() { LS.set(SETTINGS_KEY, JSON.stringify(state.settings)); }
  // ---- rule library (versioned, governed) is the source of truth for rates ----
  function loadRuleLib() {
    try { var r = JSON.parse(LS.get(RULELIB_KEY) || "null"); if (r && r.clients && r.clients.length) return r; } catch (e) {}
    return RuleLib.defaultLibrary();
  }
  function saveRuleLib() { LS.set(RULELIB_KEY, JSON.stringify(state.ruleLib)); refreshRates(); }
  function refreshRates() { state.rates = RuleLib.resolveRates(state.ruleLib); }
  function table() { return Rates.makeTable(state.rates); }
  function loadLedger() { try { return JSON.parse(LS.get(LEDGER_KEY) || "[]"); } catch (e) { return []; } }
  function saveLedger() { LS.set(LEDGER_KEY, JSON.stringify(state.ledger)); }

  // ---- navigation (4-step stepper + Manage + step buttons) ----
  function showTab(name) {
    state.activeTab = name;
    document.querySelectorAll('section[id^="tab-"]').forEach(function (s) { s.classList.add("hide"); });
    var sec = document.getElementById("tab-" + name); if (sec) sec.classList.remove("hide");
    if (name === "upload") renderRequiredWeeks();
    if (name === "draft") buildDraft();
    if (name === "review") renderAdjustments();
    if (name === "audit") buildAudit();
    refreshStepper();
    window.scrollTo(0, 0);
  }
  function goTab(name) { showTab(name); }
  // one delegated handler covers the stepper, the Manage row, and the Next/Back step buttons
  document.addEventListener("click", function (e) {
    var t = e.target.closest("[data-tab]"); if (!t) return;
    e.preventDefault(); showTab(t.getAttribute("data-tab"));
  });
  function stepDone(name) {
    if (name === "setup") return !!state.settings.paydayISO;
    if (name === "upload") return state.master.length > 0;
    if (name === "review") return !!(state.claim && state.claim.claimed.length);
    if (name === "draft") return !!state.draft && includedClaimed().length > 0;
    return false;
  }
  function refreshStepper() {
    var active = state.activeTab || "setup";
    document.querySelectorAll(".step").forEach(function (st) {
      var n = st.getAttribute("data-tab");
      st.classList.toggle("active", n === active);
      st.classList.toggle("done", stepDone(n) && n !== active);
    });
    document.querySelectorAll(".mtab").forEach(function (m) { m.classList.toggle("active", m.getAttribute("data-tab") === active); });
  }
  function updateHeaderStatus() {
    var el = $("headerStatus"); if (!el) return;
    el.innerHTML = "Pay day " + DateUtil.fmtMDY(state.settings.paydayISO) + " · Period " +
      DateUtil.fmtRange(state.settings.periodStartISO, state.settings.periodEndISO) +
      ' · <b>' + (state.mode === "discovery" ? "Discovery" : "Normal") + " Mode</b>";
  }

  // ---- setup wiring ----
  var $ = function (id) { return document.getElementById(id); };
  var setupWired = false;
  function bindSetup() {
    $("staffName").value = state.settings.staffName || "";
    $("initials").value = state.settings.initials;
    $("payday").value = state.settings.paydayISO || "";
    $("periodStart").value = state.settings.periodStartISO || "";
    $("periodEnd").value = state.settings.periodEndISO || "";
    $("toAddr").value = state.settings.to;
    $("fromAddr").value = state.settings.from;

    if (!setupWired) { // attach static listeners once
      setupWired = true;
      $("staffName").addEventListener("change", function () {
        state.settings.staffName = this.value.trim();
        saveSettings(); recompute();
      });
      $("initials").addEventListener("change", function () {
        state.settings.initials = this.value.trim().toUpperCase();
        this.value = state.settings.initials; saveSettings(); recompute();
      });
      $("payday").addEventListener("change", function () { if (this.value) setPayday(this.value, true); });
      // manual period overrides — for periods that don't fit the auto formula
      $("periodStart").addEventListener("change", function () {
        if (!this.value) return;
        state.settings.periodStartISO = this.value; state.settings.periodOverride = true;
        saveSettings(); renderRequiredWeeks(); renderPeriodSummary(); recompute();
      });
      $("periodEnd").addEventListener("change", function () {
        if (!this.value) return;
        state.settings.periodEndISO = this.value; state.settings.periodOverride = true;
        saveSettings(); renderRequiredWeeks(); renderPeriodSummary(); recompute();
      });
      $("periodReset").addEventListener("click", function () {
        state.settings.periodOverride = false;
        deriveFromPayday(); saveSettings(); bindSetup(); renderRequiredWeeks(); renderPeriodSummary(); recompute();
      });
      $("toAddr").addEventListener("change", function () { state.settings.to = this.value; saveSettings(); });
      $("fromAddr").addEventListener("change", function () { state.settings.from = this.value; saveSettings(); });
    }
    renderPeriodSummary();
  }

  // Schedule-driven summary: today, current pay day, derived period, email-due, Prev/Next.
  function renderPeriodSummary() {
    var el = $("periodSummary"); if (!el) return;
    var today = todayISO();
    var pd = state.settings.paydayISO;
    var isToday = pd === today;
    var due = DateUtil.emailDue(pd);
    var dueNote = today > due ? '<span class="pill bad">email was due ' + DateUtil.fmtMDY(due) + "</span>"
                 : '<span class="pill">email due ' + DateUtil.fmtMDY(due) + " (Wed)</span>";
    var pullEnd = DateUtil.addDays(state.settings.periodEndISO, 1); // pull one day past (Monday) to catch the last overnight
    el.innerHTML =
      '<div class="row" style="gap:10px;align-items:center;flex-wrap:wrap">' +
        '<span class="muted small">Today ' + DateUtil.fmtMDY(today) + "</span>" +
        '<span class="pill ' + (isToday ? "good" : "") + '">Pay day: ' + DateUtil.fmtMDY(pd) + (isToday ? " (today)" : "") + "</span>" +
        '<span class="pill good">Pay period: ' + DateUtil.fmtRange(state.settings.periodStartISO, state.settings.periodEndISO) + "</span>" +
        '<span class="pill warn" title="Pull one day past the period end so the last Sunday-night shift (which ends Monday morning) is included.">Pull dates: ' + DateUtil.fmtRange(state.settings.periodStartISO, pullEnd) + " (Mon&ndash;Mon)</span>" +
        (state.settings.periodOverride ? '<span class="pill warn">manual override</span>' : "") +
        dueNote +
      "</div>" +
      '<div class="muted small" style="margin-top:6px">The <b>pay period</b> never changes — it&rsquo;s what you&rsquo;re paid for. The <b>pull dates</b> end one day later (the Monday) so Brittco includes your last Sunday-night shift.</div>' +
      '<div class="row" style="gap:8px;margin-top:10px">' +
        '<button class="ghost sm" id="prevPeriod">‹ Previous pay period</button>' +
        '<button class="ghost sm" id="nextPeriod">Next pay period ›</button>' +
        '<button class="ghost sm" id="thisPeriod">Jump to current</button>' +
        '<button class="ghost sm" id="periodAdjust">Pick a pay day…</button>' +
      "</div>";
    $("prevPeriod").addEventListener("click", function () { setPayday(DateUtil.addDays(pd, -14), false); });
    $("nextPeriod").addEventListener("click", function () { setPayday(DateUtil.addDays(pd, 14), false); });
    $("thisPeriod").addEventListener("click", function () { setPayday(DateUtil.paydayOnOrAfter(todayISO(), state.settings.payAnchorISO), false); });
    $("periodAdjust").addEventListener("click", function () { $("periodEditor").classList.toggle("hide"); });
    updateHeaderStatus();
  }

  // Tell the user EXACTLY which Brittco weekly exports to pull for this period.
  function renderRequiredWeeks() {
    var el = $("uploadDates"); if (!el) return;
    var weeks = DateUtil.requiredWeeks(state.settings.periodStartISO);
    var items = weeks.map(function (w, i) {
      return "<li>Week " + (i + 1) + ": <b>" + DateUtil.fmtMDY(w.sun) + " (Sun)</b> – <b>" + DateUtil.fmtMDY(w.sat) + " (Sat)</b></li>";
    }).join("");
    var range = DateUtil.fmtRange(state.settings.periodStartISO, state.settings.periodEndISO);
    var endPull = DateUtil.addDays(state.settings.periodEndISO, 1); // the Monday after the Sunday end
    el.className = "banner warn";
    var startMDY = DateUtil.fmtMDY(state.settings.periodStartISO);
    var endMDY = DateUtil.fmtMDY(endPull);
    el.innerHTML = [
      '<div><b>Pay period</b> (what you&rsquo;re paid for): <b>' + range + "</b> &mdash; this never changes.</div>",
      '<div style="margin-top:8px;font-size:15px"><b>Pull from Brittco &mdash; Start <span style="color:var(--good)">' + startMDY + " (Mon)</span> &rarr; End <span style=\"color:var(--good)\">" + endMDY + ' (Mon)</span></b></div>',
      '<div class="small" style="margin-top:6px"><b>How:</b> open <b>Review Attendance</b>, set <b>Staff = your name</b>, <b>Start Date ' + startMDY + "</b>, <b>End Date " + endMDY + "</b>, then upload that report.</div>",
      '<div class="small" style="margin-top:6px;border-left:3px solid var(--warn);padding-left:8px"><b>Upload every page.</b> If the report shows &ldquo;Showing 1&ndash;25 of N&rdquo;, it spans multiple pages &mdash; click through each page (&raquo;) and upload them all. Your last dates are on the final page; the app warns you if any page is missing.</div>',
      '<div class="small" style="margin-top:6px;border-left:3px solid var(--warn);padding-left:8px"><b>Why end on the Monday, not the Sunday?</b> Your last Sunday-night shift runs into Monday morning; ending on the Sunday cuts it off and undercounts you. The app counts any Monday hours <b>before 8:00am</b> under the previous Sunday, so they stay in this pay period.</div>',
      '<details style="margin-top:8px"><summary class="small">Or use the weekly grid export (3 Sun&ndash;Sat files)</summary><ul style="margin:6px 0 0 18px;padding:0">' + items + "</ul></details>"
    ].join("");
  }

  // ---- Rule Library UI (versioned, governed) ----
  function label24(h) { var x = ((h % 24) + 24) % 24, m = x < 12 ? "AM" : "PM", d = x % 12; return (d === 0 ? 12 : d) + m; }

  function renderRates() { // renders the Client Rule Library
    var el = $("ruleLibBody"); if (!el) return;
    var discovery = state.mode === "discovery";
    var note = $("ruleModeNote");
    if (note) note.textContent = discovery
      ? "— Rule Discovery Mode: each change is recorded as a new approved version"
      : "— Normal Payroll Mode: approved rules are read-only";
    el.innerHTML = state.ruleLib.clients.map(function (c) {
      var av = RuleLib.activeVersionOf(c);
      var r = av ? av.rules : RuleLib.ruleSet();
      var configured = RuleLib.isApproved(c);
      var conf = av ? av.confidence : 0;
      var confCls = conf >= 99 ? "good" : (conf >= 95 ? "warn" : "bad");
      var band = (r.overnight_start != null && r.overnight_end != null) ? (label24(r.overnight_start) + "-" + label24(r.overnight_end)) : "11PM-7AM";
      var rateSummary = configured
        ? ("$" + r.regular_rate_usd + "/hr" + (r.overnight_rate_usd != null ? " · night $" + r.overnight_rate_usd + " (" + band + ")" : ""))
        : '<span class="pill bad">no rate set</span>';
      var history = (c.versions || []).slice().reverse().map(function (v) {
        return "v" + v.version + " — " + v.status + ", " + v.confidence + "% (" + (v.approvedDate || "?") + ")" + (v.notes ? " · " + escAttr(v.notes) : "");
      }).join("<br>");
      var canEdit = discovery || !configured; // Normal mode: only establishing a first rate is allowed
      var form = canEdit ? ruleEditForm(c, r)
        : '<div class="muted small" style="margin-top:6px">Read-only in Normal Payroll Mode. Switch to <b>Rule Discovery</b> (top right) to propose a change.</div>';
      return '<div class="client-block">' +
        '<div class="client-head"><div><b>' + escAttr(c.client_name) + '</b> ' +
          '<span class="pill">' + (configured ? "v" + av.version : "draft") + '</span> ' +
          '<span class="pill ' + confCls + '">' + conf + '% confidence</span></div>' +
          '<div class="small">' + rateSummary + '</div></div>' +
        '<div style="padding:8px 12px">' +
          '<details style="margin-bottom:6px"><summary class="small muted">version history (' + (c.versions || []).length + ')</summary><div class="small muted" style="margin-top:4px">' + history + '</div></details>' +
          form +
        '</div></div>';
    }).join("");
    if (!state.ruleLib.clients.length) {
      el.innerHTML = '<div class="muted small" style="padding:10px 2px">No clients yet. Add each client you work with and set their <b>Regular $/hr</b> (and a <b>Night $/hr</b> for 11pm&ndash;7am if they have one). ' +
        'Or <b>Import starter…</b> if someone shared a setup file. Uploading a Brittco PDF also adds any clients it finds here for you to price.</div>';
    }
    wireRuleForms();
  }

  function ruleEditForm(c, r) {
    return '<div class="rule-form" data-key="' + escAttr(c.client_key) + '" style="margin-top:6px">' +
      '<div class="row" style="gap:8px;flex-wrap:wrap;align-items:flex-end">' +
        '<label class="small">Regular $/hr<br><input class="tinput" data-rf="reg" type="number" step="0.01" inputmode="decimal" value="' + (r.regular_rate_usd == null ? "" : r.regular_rate_usd) + '" style="width:90px"/></label>' +
        '<label class="small">Night $/hr (11pm&ndash;7am)<br><input class="tinput" data-rf="on" type="number" step="0.01" inputmode="decimal" placeholder="(optional)" value="' + (r.overnight_rate_usd == null ? "" : r.overnight_rate_usd) + '" style="width:130px"/></label>' +
        '<label class="small">Confidence<br><select data-rf="conf"><option>99</option><option>98</option><option selected>95</option><option>90</option></select></label>' +
        '<button class="sm" data-rf-approve="' + escAttr(c.client_key) + '">Save rate</button>' +
      '</div>' +
      '<div class="muted small" style="margin-top:4px">Leave Night blank if this client has no 11pm&ndash;7am rate. The night window is fixed at 11pm&ndash;7am.</div>' +
      '<input data-rf="notes" placeholder="Note (optional, saved to history)" style="margin-top:6px;max-width:480px"/>' +
    '</div>';
  }

  function wireRuleForms() {
    document.querySelectorAll("#ruleLibBody [data-rf-approve]").forEach(function (b) {
      b.addEventListener("click", function () {
        var key = this.getAttribute("data-rf-approve");
        var form = this.closest(".rule-form");
        function val(f) { var e = form.querySelector('[data-rf="' + f + '"]'); return e ? e.value : ""; }
        var reg = parseFloat(val("reg"));
        if (isNaN(reg) || reg <= 0) { flash("saveStatus", "Enter a regular $/hr greater than 0."); return; }
        var night = val("on") === "" ? null : parseFloat(val("on"));
        // Night rate applies to the fixed 11pm-7am window; no window when there's no night rate.
        approveClientRule(key, {
          regular_rate_usd: reg,
          overnight_rate_usd: night,
          overnight_start: night == null ? null : 23,
          overnight_end: night == null ? null : 7,
        }, { confidence: parseInt(val("conf"), 10), notes: val("notes"), approvedBy: "user" });
      });
    });
  }

  function approveClientRule(key, newRules, meta) {
    state.ruleLib = RuleLib.approveVersion(state.ruleLib, key, newRules, meta);
    saveRuleLib(); renderRates(); recompute();
    var c = RuleLib.getClient(state.ruleLib, key);
    flash("saveStatus", c.client_name + " approved as v" + c.activeVersion + ".");
  }

  $("addRate").addEventListener("click", function () {
    var n = state.ruleLib.clients.length + 1;
    state.ruleLib = RuleLib.addUnconfiguredClient(state.ruleLib, "New Client " + n, "NC" + n, ["New Client " + n]);
    saveRuleLib(); renderRates(); recompute();
  });
  $("resetRates").addEventListener("click", function () {
    if (!state.ruleLib.clients.length) { flash("saveStatus", "No clients to clear."); return; }
    if (!window.confirm("Clear ALL clients and their rates? This cannot be undone. (Tip: Export starter first to keep a copy.)")) return;
    state.ruleLib = RuleLib.defaultLibrary(); saveRuleLib(); renderRates(); recompute();
    flash("saveStatus", "Cleared. Add your clients, or Import a starter file.");
  });

  // Export the current rule library as a shareable starter file.
  $("exportRates").addEventListener("click", function () {
    if (!state.ruleLib.clients.length) { flash("saveStatus", "Nothing to export — add clients first."); return; }
    Storage.download("payroll-starter.json", JSON.stringify(state.ruleLib, null, 2));
    flash("saveStatus", "Exported payroll-starter.json — share this file to set others up.");
  });

  // Import a starter file (a rule library JSON) — replaces the current client list.
  $("importRatesBtn").addEventListener("click", function () { $("importRates").click(); });
  $("importRates").addEventListener("change", function () {
    var f = this.files && this.files[0]; if (!f) return;
    var self = this;
    var r = new FileReader();
    r.onload = function () {
      try {
        var lib = JSON.parse(r.result);
        if (!lib || !Array.isArray(lib.clients)) throw new Error("not a starter file");
        if (state.ruleLib.clients.length && !window.confirm("Replace your current clients with the imported starter (" + lib.clients.length + " clients)?")) { self.value = ""; return; }
        if (!lib.schema) lib.schema = 1;
        state.ruleLib = lib; saveRuleLib(); renderRates(); recompute();
        flash("saveStatus", "Imported " + lib.clients.length + " client(s) from starter.");
      } catch (e) {
        flash("saveStatus", "That file isn't a valid starter (expected an exported payroll-starter.json).");
      }
      self.value = "";
    };
    r.readAsText(f);
  });

  // ---- upload ----
  var drop = $("drop"), fileInput = $("fileInput");
  drop.addEventListener("click", function () { fileInput.click(); });
  ["dragover","dragenter"].forEach(function (ev){ drop.addEventListener(ev, function (e){ e.preventDefault(); drop.classList.add("hot"); }); });
  ["dragleave","drop"].forEach(function (ev){ drop.addEventListener(ev, function (e){ e.preventDefault(); drop.classList.remove("hot"); }); });
  drop.addEventListener("drop", function (e) { handleFiles(e.dataTransfer.files); });
  fileInput.addEventListener("change", function () { handleFiles(this.files); });

  function handleFiles(list) {
    var arr = Array.prototype.slice.call(list).filter(function (f){ return /\.pdf$/i.test(f.name); });
    Promise.all(arr.map(function (f) {
      return f.arrayBuffer().then(function (buf) { return { name: f.name, buffer: buf }; });
    })).then(function (loaded) {
      loaded.forEach(function (l) {
        // De-dupe by name AND size, so two pages of a report that share a filename
        // (e.g. both "Review Attendance _ Brittco.pdf") are BOTH kept.
        if (!state.files.some(function (x){ return x.name === l.name && x.buffer.byteLength === l.buffer.byteLength; })) state.files.push(l);
      });
      renderFileList();
    });
  }
  function renderFileList() {
    var el = $("fileList");
    if (!state.files.length) { el.innerHTML = '<span class="muted small">No files yet.</span>'; $("parseBtn").disabled = true; return; }
    el.innerHTML = state.files.map(function (f, i) {
      return '<span class="chip">' + f.name + ' <a href="#" data-rm="' + i + '" style="color:#f3a0a0">×</a></span>';
    }).join(" ");
    el.querySelectorAll("[data-rm]").forEach(function (a) {
      a.addEventListener("click", function (e) { e.preventDefault(); state.files.splice(+this.dataset.rm, 1); renderFileList(); });
    });
    $("parseBtn").disabled = false;
  }

  // Clear the current working session (files + parsed shifts + adjustments).
  // Leaves your Setup, rates, and saved History untouched.
  $("clearBtn").addEventListener("click", function () {
    state.files = [];
    state.master = [];
    state.claim = null;
    state.excluded = {};
    state.adjustments = [];
    state.warnings = [];
    state.periodNote = null;
    state.suggestion = null;
    if ($("fileInput")) $("fileInput").value = "";
    $("parseStatus").textContent = "Cleared. Upload PDFs to start again.";
    renderFileList();
    recompute();
    renderAdjustments();
    buildDraft();
  });

  $("parseBtn").addEventListener("click", function () {
    var status = $("parseStatus"); status.textContent = "Parsing…";
    state.master = []; state.warnings = [];
    var rl = state.rates;
    var reportTotal = null, listFormat = false;
    var chain = Promise.resolve();
    state.files.forEach(function (f) {
      chain = chain.then(function () {
        // clone buffer (pdf.js can detach it)
        var copy = f.buffer.slice(0);
        return Parser.parsePdfFile(copy, { pdfjsLib: window.pdfjsLib, ratesList: rl, source: f.name }).then(function (res) {
          state.master = state.master.concat(res.shifts);
          state.warnings = state.warnings.concat(res.warnings || []);
          if (res.format === "review_list") { listFormat = true; if (res.reportTotal != null) reportTotal = Math.max(reportTotal || 0, res.reportTotal); }
        });
      });
    });
    chain.then(function () {
      var dates = state.master.map(function (s){ return s.dateISO; }).filter(Boolean).sort();
      var span = dates.length ? (" · shifts " + DateUtil.fmtMDY(dates[0]) + "–" + DateUtil.fmtMDY(dates[dates.length - 1])) : "";
      status.textContent = "Parsed " + state.master.length + " shifts from " + state.files.length + " file(s)" + span + ".";
      // Pagination guard: the Review Attendance list reports a total ("Showing 1-25 of 29").
      // If we parsed fewer rows than that total, page(s) were not uploaded.
      if (listFormat && reportTotal != null && state.master.length < reportTotal) {
        state.warnings.unshift({ level: "review", code: "missing_pages",
          message: "This Review Attendance report lists " + reportTotal + " shifts, but only " + state.master.length +
            " were uploaded — you are missing page(s). In Brittco, click through every page (» next) and upload each one, or set the page size to show all rows. The later dates (e.g. your last Sunday-night shift) are usually on the last page." });
        status.textContent += "  ⚠ missing " + (reportTotal - state.master.length) + " shift(s) — see warning.";
      }
      checkCoverage();
      recompute();
      goTab("review");
    }).catch(function (err) {
      var hint = /worker|pdfjsLib|not available|Failed to fetch|SecurityError/i.test(err.message || "")
        ? " — open the app via the \"Start Payroll Helper\" launcher (double-click start.command) so the PDF engine can run."
        : "";
      status.textContent = "Parse error: " + err.message + hint;
      console.error(err);
    });
  });

  // ---- coverage check: do the uploaded PDFs cover the 3 weeks this period needs? ----
  // The period comes from the pay-day schedule (not the PDFs). Here we just tell
  // the user if an expected week's data is missing so totals aren't silently short.
  function checkCoverage() {
    state.suggestion = null;
    state.periodNote = null;
    var dates = state.master.map(function (s) { return s.dateISO; }).filter(Boolean).sort();
    if (!dates.length) return;
    var min = dates[0], max = dates[dates.length - 1];
    var inPeriod = dates.filter(function (d) { return d >= state.settings.periodStartISO && d <= state.settings.periodEndISO; }).length;

    // GROSS MISMATCH: none of the uploaded data is in the selected period -> the
    // files belong to a different pay period. Offer a one-click switch instead of
    // dumping every out-of-period shift.
    if (inPeriod === 0) {
      var firstMon = dates.filter(function (d) { return DateUtil.weekday(d) === 1; })[0] || DateUtil.mondayOf(min);
      state.suggestion = {
        startISO: firstMon, endISO: DateUtil.periodEnd(firstMon),
        payday: DateUtil.paydayFromPeriodStart(firstMon), min: min, max: max,
      };
      return;
    }

    // Partial coverage: tell them which of the 3 needed weeks has no data.
    var weeks = DateUtil.requiredWeeks(state.settings.periodStartISO);
    var missing = [];
    weeks.forEach(function (w) {
      if (!dates.some(function (d) { return d >= w.sun && d <= w.sat; }))
        missing.push(DateUtil.fmtMDY(w.sun) + "–" + DateUtil.fmtMDY(w.sat));
    });
    state.periodNote = missing.length
      ? "Missing data for " + missing.length + " of the 3 weeks this period needs: " + missing.join("; ") +
        ". Pull and add those Brittco exports (see step 3) or the totals will be incomplete."
      : null;
  }

  // ---- recompute pipeline ----
  function activeShifts() {
    return state.master.map(function (s) { return Object.assign({}, s); });
  }
  function recompute() {
    var t = table();
    var claim = Review.claim(activeShifts(), {
      initials: state.settings.initials,
      staffName: state.settings.staffName,
      startISO: state.settings.periodStartISO,
      endISO: state.settings.periodEndISO,
      table: t,
    });
    state.claim = claim;
    autoAddNewClients(claim.claimed);
    renderReview();
    updateBadge();
    refreshStepper();
  }

  // If FY appears on a client we don't know, AUTO-ADD it to the rate table
  // (name + alias) so it's ready to configure — but with NO rate (never invented).
  // The shift stays flagged "no rate" until you set a $/hr.
  function escAttr(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;" }[c]; }); }
  function deriveKey(name) {
    var k = String(name).trim().split(/\s+/).map(function (p) { return p[0] || ""; }).join("").toUpperCase().replace(/[^A-Z]/g, "");
    return k || "C";
  }
  function uniqueKey(base) {
    var used = {}; state.ruleLib.clients.forEach(function (c) { used[c.client_key] = true; });
    if (!used[base]) return base;
    var i = 2; while (used[base + i]) i++; return base + i;
  }
  function autoAddNewClients(claimed) {
    var t = table(), added = false, have = {};
    state.rates.forEach(function (r) {
      have[Rates.normName(r.client_name)] = true;
      (r.pdf_aliases || []).forEach(function (a) { have[Rates.normName(a)] = true; });
    });
    (claimed || []).forEach(function (s) {
      if (t.resolve(s.clientName, s.clientKey)) return; // already in the library (configured or draft)
      var nm = Rates.normName(s.clientName);
      if (!nm || have[nm]) return;
      have[nm] = true;
      state.ruleLib = RuleLib.addUnconfiguredClient(state.ruleLib, s.clientName, uniqueKey(deriveKey(s.clientName)), [s.clientName]);
      added = true;
    });
    if (added) { saveRuleLib(); renderRates(); }
  }

  // Set the first $/hr for a client from the Review screen = approve its v1.0.
  function setRateForClient(name, val) {
    var amt = parseFloat(val);
    if (isNaN(amt) || amt <= 0) { flash("saveStatus", "Enter a $/hr greater than 0."); return; }
    var c = RuleLib.getClient(state.ruleLib, name);
    if (!c) {
      state.ruleLib = RuleLib.addUnconfiguredClient(state.ruleLib, name, uniqueKey(deriveKey(name)), [name]);
      c = RuleLib.getClient(state.ruleLib, name);
    }
    approveClientRule(c.client_key, { regular_rate_usd: amt }, { confidence: RuleLib.CONFIDENCE.EVIDENCE, notes: "Rate set from Review screen.", approvedBy: "user" });
  }

  function includedClaimed() {
    return (state.claim ? state.claim.claimed : []).filter(function (s){ return !state.excluded[s.id]; });
  }

  function updateBadge() {
    var inc = includedClaimed();
    var reviewFlags = 0, unconfigured = 0;
    inc.forEach(function (s) {
      s.flags.forEach(function (f){ if (f.level === "review") reviewFlags++; });
      if (s.rate == null) unconfigured++;
    });
    var b = $("reviewBadge");
    var n = reviewFlags;
    b.textContent = n;
    b.classList.toggle("zero", n === 0);
  }

  // ---- review render ----
  function renderReview() {
    var t = table();
    var inc = includedClaimed();
    var per = Payroll.computePeriod(inc, t);
    var claim = state.claim || { claimed: [], omittedClients: [], reviewCount: 0, infoCount: 0 };

    // summary
    var reviewFlags = 0, infoFlags = 0, unconfigured = 0;
    inc.forEach(function (s) {
      s.flags.forEach(function (f){ f.level === "review" ? reviewFlags++ : infoFlags++; });
      if (s.rate == null) unconfigured++;
    });
    var sum = $("reviewSummary");
    var parts = [];
    parts.push('<div class="row" style="gap:8px;margin-bottom:8px">');
    parts.push('<span class="pill ' + (reviewFlags ? "bad" : "good") + '">' + reviewFlags + " items need review</span>");
    parts.push('<span class="pill">' + infoFlags + " info notes</span>");
    if (unconfigured) parts.push('<span class="pill warn">' + unconfigured + " unconfigured-rate shift(s)</span>");
    parts.push('<span class="pill">' + inc.length + " of my shifts · " + per.grandHours + " hrs · " + EmailGen.money(per.grandPay) + "</span>");
    parts.push("</div>");
    if (state.suggestion) {
      // gross mismatch: files belong to a different pay period — offer one-click switch
      var sg = state.suggestion;
      parts.push('<div class="banner bad"><b>These PDFs don’t match the selected pay period.</b> ' +
        "Your files cover " + DateUtil.fmtMDY(sg.min) + "–" + DateUtil.fmtMDY(sg.max) +
        ", but the period is " + DateUtil.fmtRange(state.settings.periodStartISO, state.settings.periodEndISO) + ". " +
        '<button class="sm" id="switchPeriod" style="margin-top:6px">Switch to pay day ' + DateUtil.fmtMDY(sg.payday) +
        " (" + DateUtil.fmtRange(sg.startISO, sg.endISO) + ")</button></div>");
    } else {
      if (state.periodNote) parts.push('<div class="banner warn">' + state.periodNote + "</div>");
      // FY shifts that fall just outside the chosen period — surfaced (summarized), never silently dropped
      var oop = (state.claim && state.claim.outOfPeriodFY) || [];
      if (oop.length) {
        var byClient = {};
        oop.forEach(function (s) { (byClient[s.clientName] = byClient[s.clientName] || []).push(DateUtil.fmtMDY(s.dateISO)); });
        var lines = Object.keys(byClient).map(function (n) {
          var ds = byClient[n].sort();
          return n + " — " + ds.length + (ds.length <= 6 ? " (" + ds.join(", ") + ")" : " shifts");
        });
        parts.push('<div class="banner warn">' + oop.length + " of my shift(s) fall outside this period and were left out: " +
          lines.join("; ") + ". If the period is wrong, fix the pay day on Setup.</div>");
      }
    }
    if (claim.omittedClients.length) parts.push('<div class="banner warn">Omitted (none of my shifts this period): ' + claim.omittedClients.join(", ") + "</div>");
    state.warnings.forEach(function (w){ parts.push('<div class="banner bad">Parser: ' + w.message + "</div>"); });
    sum.innerHTML = parts.join("");
    if (state.suggestion) {
      var sw = $("switchPeriod");
      if (sw) sw.addEventListener("click", function () {
        var payday = state.suggestion.payday;
        state.suggestion = null;
        setPayday(payday, true); // re-derives period, saves, recompute, renders required weeks
        checkCoverage();         // re-evaluate coverage against the new period
        recompute();             // re-render with cleared/updated notes
        goTab("review");
      });
    }

    // grouped by client
    var body = $("reviewBody");
    if (!inc.length && !(state.claim && state.claim.claimed.length)) {
      body.innerHTML = '<p class="muted">No shifts yet. Upload &amp; parse PDFs, or add a shift manually.</p>'; return;
    }
    var groups = {};
    var order = [];
    (state.claim ? state.claim.claimed : []).forEach(function (s) {
      var k = s.clientName;
      if (!groups[k]) { groups[k] = []; order.push(k); }
      groups[k].push(s);
    });
    body.innerHTML = order.map(function (name) {
      var shifts = groups[name].slice().sort(function (a,b){ return (a.dateISO||"")<(b.dateISO||"")?-1:1; });
      var t2 = table();
      var rate = t2.resolve(name, shifts[0].clientKey);
      var configured = Rates.isConfigured(rate);
      var clientInc = shifts.filter(function (s){ return !state.excluded[s.id]; });
      var cper = Payroll.computePeriod(clientInc, t2);
      var hrs = cper.grandHours, pay = cper.grandPay;
      var rightSide = configured
        ? hrs + " hrs · " + EmailGen.money(pay)
        : hrs + ' hrs · <input class="tinput" type="number" min="0" step="0.01" placeholder="$/hr" data-rateinput="' + escAttr(name) + '" style="width:80px"/> <button class="ghost sm" data-setrate="' + escAttr(name) + '">Set rate</button>';
      var head = '<div class="client-head"><div><b>' + escAttr(name) + '</b> ' +
        (configured ? '<span class="pill good">configured</span>'
                    : '<span class="pill bad">new client — set $/hr to include in pay</span>') +
        '</div><div class="small">' + rightSide + "</div></div>";
      var rows = shifts.map(function (s){ return shiftRow(s); }).join("");
      var tableHtml = '<table><thead><tr><th>Incl</th><th>Date</th><th>Start</th><th>End</th><th>Staff</th><th>Hours</th><th>Flags</th><th></th></tr></thead><tbody>' + rows + "</tbody></table>";
      return '<div class="client-block">' + head + '<div style="padding:6px 10px">' + tableHtml + "</div></div>";
    }).join("");

    wireReviewInputs();
    // wire inline "Set rate" controls for new/unconfigured clients
    document.querySelectorAll("#reviewBody [data-setrate]").forEach(function (b) {
      b.addEventListener("click", function () {
        var head = this.closest(".client-head");
        var inp = head ? head.querySelector("[data-rateinput]") : null;
        setRateForClient(this.getAttribute("data-setrate"), inp ? inp.value : "");
      });
    });
    document.querySelectorAll("#reviewBody [data-rateinput]").forEach(function (inp) {
      inp.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { var head = this.closest(".client-head"); var b = head && head.querySelector("[data-setrate]"); if (b) b.click(); }
      });
    });
  }

  function shiftRow(s) {
    var t2 = table();
    var rate = t2.resolve(s.clientName, s.clientKey);
    var calc = Payroll.computeShiftPay(s, rate);
    var inc = !state.excluded[s.id];
    var hrs = calc.computed ? (calc.totalHours + "h (" + calc.regularHours + "r/" + calc.overnightHours + "o)") :
              (calc.totalHours ? calc.totalHours + "h" : "—");
    var flags = (s.flags || []).map(function (f){ return '<span class="flag ' + f.level + '" title="' + f.message.replace(/"/g,"&quot;") + '">' + f.code + "</span>"; }).join("");
    return '<tr data-id="' + s.id + '">' +
      '<td><input type="checkbox" data-f="incl" ' + (inc ? "checked" : "") + ' style="width:auto"/></td>' +
      '<td><input class="dinput" data-f="date" type="date" value="' + (s.dateISO || "") + '"/></td>' +
      '<td><input class="tinput" data-f="start" value="' + (s.startRaw || "") + '"/></td>' +
      '<td><input class="tinput" data-f="end" value="' + (s.endRaw || "") + '"/></td>' +
      '<td><input class="tinput" data-f="staff" value="' + (s.staff || []).join(" ") + '" style="width:120px"/></td>' +
      '<td class="small">' + hrs + "</td>" +
      "<td>" + (flags || '<span class="muted small">—</span>') + "</td>" +
      '<td><button class="danger sm" data-f="del">delete</button></td></tr>';
  }

  function wireReviewInputs() {
    document.querySelectorAll("#reviewBody tr[data-id]").forEach(function (tr) {
      var id = tr.dataset.id;
      tr.querySelectorAll("[data-f]").forEach(function (el) {
        var f = el.dataset.f;
        var evt = (el.type === "checkbox" || el.tagName === "BUTTON") ? "click" : "change";
        el.addEventListener(evt, function () {
          var s = findMaster(id);
          if (f === "incl") { state.excluded[id] = !this.checked; renderReview(); updateBadge(); return; }
          if (f === "del") { state.master = state.master.filter(function (m){ return m.id !== id; }); recompute(); return; }
          if (!s) return;
          if (f === "date") s.dateISO = this.value;
          else if (f === "start") s.startRaw = this.value.trim();
          else if (f === "end") s.endRaw = this.value.trim();
          else if (f === "staff") s.staff = this.value.split(/\s+/).map(function (x){return x.trim().toUpperCase();}).filter(Boolean);
          recompute();
        });
      });
    });
  }
  function findMaster(id) { return state.master.filter(function (m){ return m.id === id; })[0]; }

  $("recalcBtn").addEventListener("click", recompute);
  $("addShift").addEventListener("click", function () {
    var id = "manual:" + Date.now();
    state.master.push({
      id: id, clientName: state.rates[0] ? state.rates[0].client_name : "New Client",
      clientKey: state.rates[0] ? state.rates[0].client_key : "NC",
      dateISO: state.settings.periodStartISO, startRaw: "7:00am", endRaw: "3:00pm",
      staff: [state.settings.initials], source: "manual", parseFlags: [{ level: "info", code: "manual", message: "Added manually." }],
    });
    recompute();
  });

  // ---- back pay / adjustments ----
  function escHtml(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;" }[c]; }); }
  function round2(n) { return Math.round(n * 100) / 100; }

  function openShortfalls() {
    var curId = "pp_" + state.settings.periodStartISO;
    return store.list().filter(function (r) {
      return r.id !== curId && r.amountPaid != null && (r.shortfall || 0) > 0 && !r.carried;
    });
  }

  function renderAdjustments() {
    var os = openShortfalls();
    var osEl = $("openShortfalls");
    if (osEl) {
      if (os.length) {
        osEl.innerHTML = '<div class="banner warn" style="margin-bottom:6px">You were short-paid on a past period. The back-pay line below is filled in for you — click <b>+ Add adjustment</b> to include it in this email (or leave it out):</div>' +
          os.map(function (r) {
            var label = "BACK PAY (from " + DateUtil.fmtRange(r.periodStartISO, r.periodEndISO) + ")";
            return '<div class="row" style="margin:4px 0;gap:8px;align-items:center"><span class="pill bad">' +
              escHtml(label) + " — " + EmailGen.money(r.shortfall) + "</span>" +
              '<button class="ghost sm" data-carry="' + r.id + '">+ Add adjustment</button></div>';
          }).join("");
        osEl.querySelectorAll("[data-carry]").forEach(function (b) {
          b.addEventListener("click", function () { carryShortfall(this.dataset.carry); });
        });
      } else {
        osEl.innerHTML = '<p class="muted small">No unsettled shortfalls. On the History tab, record what you were actually paid for a past period and any shortfall will appear here.</p>';
      }
    }
    var listEl = $("adjList");
    if (listEl) {
      if (state.adjustments.length) {
        listEl.innerHTML = '<table style="margin-top:10px"><thead><tr><th>Adjustment (appears in email)</th><th class="right">Amount</th><th></th></tr></thead><tbody>' +
          state.adjustments.map(function (a) {
            return "<tr><td>" + escHtml(a.label) + '</td><td class="right">' + EmailGen.money(a.amount) + "</td>" +
              '<td><button class="danger sm" data-adjdel="' + a.id + '">remove</button></td></tr>';
          }).join("") + "</tbody></table>";
        listEl.querySelectorAll("[data-adjdel]").forEach(function (b) {
          b.addEventListener("click", function () { removeAdjustment(this.dataset.adjdel); });
        });
      } else {
        listEl.innerHTML = '<p class="muted small" style="margin:8px 0">No adjustments on this period.</p>';
      }
    }
  }

  function carryShortfall(periodId) {
    var r = store.get(periodId); if (!r) return;
    state.adjustments.push({
      id: "adj_" + Date.now(),
      label: "BACK PAY (from " + DateUtil.fmtRange(r.periodStartISO, r.periodEndISO) + ")",
      amount: r.shortfall, sourcePeriodId: periodId,
    });
    r.carried = true; store.save(r);
    renderAdjustments(); renderHistory(); buildDraft();
    flash("saveStatus", "Added " + EmailGen.money(r.shortfall) + " back pay to this period.");
  }

  function removeAdjustment(id) {
    var a = state.adjustments.filter(function (x) { return x.id === id; })[0];
    state.adjustments = state.adjustments.filter(function (x) { return x.id !== id; });
    if (a && a.sourcePeriodId) { var r = store.get(a.sourcePeriodId); if (r) { r.carried = false; store.save(r); } }
    renderAdjustments(); renderHistory(); buildDraft();
  }

  $("addAdj").addEventListener("click", function () {
    var label = $("adjLabel").value.trim();
    var amt = parseFloat($("adjAmount").value);
    if (!label || isNaN(amt)) { flash("saveStatus", "Enter a label and an amount for the adjustment."); return; }
    state.adjustments.push({ id: "adj_" + Date.now(), label: label, amount: amt });
    $("adjLabel").value = ""; $("adjAmount").value = "";
    renderAdjustments(); buildDraft();
  });

  // ---- draft ----
  function buildDraft() {
    var inc = includedClaimed();
    var draft = EmailGen.buildDraft({
      shifts: inc, table: table(),
      startISO: state.settings.periodStartISO, endISO: state.settings.periodEndISO,
      paydayISO: state.settings.paydayISO, to: state.settings.to, from: state.settings.from,
      clientOrder: state.rates.map(function (r){ return r.client_name; }),
      adjustments: state.adjustments,
    });
    state.draft = draft;
    // The whole email — To, Subject, and body — goes in the copyable box so you can
    // select all and paste it straight into your mail client.
    var header = "To: " + (draft.to || "") + "\nSubject: " + draft.subject + "\n\n";
    $("draftBody").textContent = (inc.length || state.adjustments.length)
      ? header + draft.body
      : "No shifts selected yet.\n\nUpload & parse your PDFs, confirm them on the Review tab, then this draft fills in automatically.";

    var warn = $("draftWarn");
    var reviewFlags = 0; inc.forEach(function (s){ s.flags.forEach(function (f){ if (f.level==="review") reviewFlags++; }); });
    var w = [];
    if (reviewFlags) w.push('<div class="banner bad"><b>' + reviewFlags + " item(s) still flagged for review.</b> Resolve or exclude them on the Review tab before sending.</div>");
    if (draft.unconfigured.length) w.push('<div class="banner bad">Excluded from pay (no rate configured): ' + draft.unconfigured.join(", ") + ". Add a rate or remove these shifts.</div>");
    w.push('<div class="banner good">Draft only — copy into your mail client and send it yourself. Mark as <b>high importance</b> per your sample.</div>');
    warn.innerHTML = w.join("");
  }
  $("genDraft").addEventListener("click", function () { buildDraft(); });
  $("copyDraft").addEventListener("click", function () {
    if (!state.draft) buildDraft();
    // copy exactly what's in the box (To + Subject + body)
    navigator.clipboard.writeText($("draftBody").textContent).then(function () { flash("saveStatus", "Copied the whole email (To, Subject, body)."); });
  });

  // ---- validate the draft before it can be confirmed/sent ----
  // Surfaces anything that would make the email wrong to send. Returns problems[].
  function validateDraft() {
    if (!state.draft) buildDraft();
    var inc = includedClaimed();
    var problems = [];
    if (!inc.length && !state.adjustments.length) problems.push("Nothing to send — no shifts are selected and there's no back pay.");
    var unconf = {};
    inc.forEach(function (s) { if (s.rate == null) unconf[s.clientName] = true; });
    if (Object.keys(unconf).length) problems.push("No rate set for: " + Object.keys(unconf).join(", ") + ". Set each one on the Rule Library tab.");
    var reviewFlags = 0;
    inc.forEach(function (s){ s.flags.forEach(function (f){ if (f.level === "review" && f.code !== "no_rate") reviewFlags++; }); });
    if (reviewFlags) problems.push(reviewFlags + " item(s) still need review on the Review tab.");
    if (!String(state.settings.from || "").trim()) problems.push("Set your name/email in the From field (Setup tab) before confirming.");
    return { ok: problems.length === 0, problems: problems };
  }

  // Build the saved period record. status: "draft" | "confirmed".
  function buildPeriodRecord(status) {
    if (!state.draft) buildDraft();
    var inc = includedClaimed();
    var reviewFlags = 0; inc.forEach(function (s){ s.flags.forEach(function (f){ if (f.level === "review") reviewFlags++; }); });
    var id = "pp_" + state.settings.periodStartISO;
    var existing = store.get(id) || {};
    var expectedTotal = state.draft.totals.grandPay; // emailed total, INCLUDING back pay
    var rec = Storage.buildRecord({
      id: id,
      status: status || (reviewFlags ? "needs-review" : "draft"),
      initials: state.settings.initials,
      periodStartISO: state.settings.periodStartISO,
      periodEndISO: state.settings.periodEndISO,
      paydayISO: state.settings.paydayISO,
      ratesSnapshot: JSON.parse(JSON.stringify(state.rates)),
      shifts: inc.map(function (s){ return { clientName:s.clientName, clientKey:s.clientKey, dateISO:s.dateISO, startRaw:s.startRaw, endRaw:s.endRaw, staff:s.staff, source:s.source, _mergedOvernight:s._mergedOvernight }; }),
      reviewSummary: { reviewFlags: reviewFlags, totalPay: expectedTotal, totalHours: state.draft.totals.grandHours, currentEarnings: state.draft.totals.currentEarnings, backPay: state.draft.totals.adjustmentsTotal },
      draft: state.draft,
      sourceFiles: state.files.map(function (f){ return { name: f.name, size: f.buffer.byteLength }; }),
    });
    rec.adjustments = JSON.parse(JSON.stringify(state.adjustments));
    rec.expectedTotal = expectedTotal;                       // what we billed (for shortfall math)
    rec.amountPaid = existing.amountPaid != null ? existing.amountPaid : null;
    rec.shortfall = rec.amountPaid != null ? round2(expectedTotal - rec.amountPaid) : null;
    rec.carried = existing.carried || false;
    if (status === "confirmed") rec.confirmedDate = todayISO();
    else if (existing.confirmedDate) rec.confirmedDate = existing.confirmedDate;
    rec.ruleLibSnapshot = JSON.parse(JSON.stringify(state.ruleLib)); // governed rule versions used
    rec.audit = Audit.generate({ shifts: inc, table: table(), ruleLib: state.ruleLib, startISO: state.settings.periodStartISO, endISO: state.settings.periodEndISO, paydayISO: state.settings.paydayISO, adjustments: state.adjustments, initials: state.settings.initials });
    return rec;
  }

  // Confirm & Save: validate first; only save (as "confirmed") if it passes.
  $("confirmSave").addEventListener("click", function () {
    var warn = $("confirmWarn");
    var v = validateDraft();
    if (!v.ok) {
      warn.innerHTML = '<div class="banner bad"><b>Not saved — fix these first:</b><ul style="margin:6px 0 0 18px;padding:0">' +
        v.problems.map(function (p){ return "<li>" + escAttr(p) + "</li>"; }).join("") + "</ul></div>";
      flash("saveStatus", "Couldn't confirm — see the notes above.");
      return;
    }
    warn.innerHTML = "";
    var rec = buildPeriodRecord("confirmed");
    store.save(rec);
    flash("saveStatus", "Confirmed & saved to History (" + DateUtil.fmtMDY(rec.confirmedDate) + "). Copy the draft and send it.");
    refreshStepper(); renderHistory();
  });

  // Export the current period as a JSON backup (separate from confirming).
  $("exportJson").addEventListener("click", function () {
    var rec = buildPeriodRecord();
    store.save(rec);
    Storage.download("payperiod_" + state.settings.periodStartISO + ".json", Storage.toJSON(rec));
    flash("saveStatus", "Exported JSON backup.");
    renderHistory();
  });

  // ---- full backup / restore: ALL data (settings, clients, history, ledger) -> one file ----
  function buildBackup() {
    return {
      app: "payroll-helper", schema: 1, exportedAt: new Date().toISOString(),
      settings: state.settings,
      ruleLib: state.ruleLib,
      ledger: state.ledger,
      history: store.list(),
    };
  }
  $("backupAll").addEventListener("click", function () {
    var name = "payroll-backup-" + todayISO() + ".json";
    Storage.download(name, JSON.stringify(buildBackup(), null, 2));
    flash("backupStatus", "Saved everything to " + name + " — keep this file safe.");
  });
  $("restoreAllBtn").addEventListener("click", function () { $("restoreAll").click(); });
  $("restoreAll").addEventListener("change", function () {
    var f = this.files && this.files[0]; if (!f) return;
    var self = this, r = new FileReader();
    r.onload = function () {
      try {
        var b = JSON.parse(r.result);
        if (!b || b.app !== "payroll-helper" || !b.settings) throw new Error("not a backup");
        if (!window.confirm("Restore REPLACES all data currently on this device with the backup. Continue?")) { self.value = ""; return; }
        LS.set(SETTINGS_KEY, JSON.stringify(b.settings));
        LS.set(RULELIB_KEY, JSON.stringify(b.ruleLib || { schema: 1, clients: [] }));
        LS.set(LEDGER_KEY, JSON.stringify(b.ledger || []));
        store.clear();
        (b.history || []).forEach(function (rec) { store.save(rec); });
        // reload state from the restored storage and re-render everything
        state.settings = loadSettings();
        state.ruleLib = loadRuleLib();
        state.ledger = loadLedger();
        state.adjustments = [];
        refreshRates();
        bindSetup(); renderPeriodSummary(); renderRequiredWeeks(); renderRates();
        recompute(); renderHistory(); renderLedger(); renderAdjustments(); updateHeaderStatus();
        flash("backupStatus", "Restored " + (b.history || []).length + " saved period(s) and " +
          ((b.ruleLib && b.ruleLib.clients) ? b.ruleLib.clients.length : 0) + " client(s).");
      } catch (e) {
        flash("backupStatus", "That file isn't a valid backup (expected a payroll-backup .json).");
      }
      self.value = "";
    };
    r.readAsText(f);
  });

  // ---- mode switch (Normal Payroll / Rule Discovery) ----
  function setMode(m) {
    state.mode = m;
    $("modeNormal").className = "ghost sm" + (m === "normal" ? " active" : "");
    $("modeDiscovery").className = "ghost sm" + (m === "discovery" ? " active" : "");
    var bn = $("modeBanner");
    if (bn) bn.innerHTML = m === "discovery"
      ? '<div class="banner warn" style="margin:12px 22px 0">Rule Discovery Mode — propose &amp; approve rule changes. Approved payroll rules do not change until you click <b>Approve</b>. Normal payroll math is unaffected.</div>'
      : "";
    renderRates();
    renderDiscovery();
    updateHeaderStatus();
  }
  $("modeNormal").addEventListener("click", function () { setMode("normal"); });
  $("modeDiscovery").addEventListener("click", function () { setMode("discovery"); });

  // ---- Rule Discovery (Phase 2): find the rule that explains an actual payment ----
  function renderDiscovery() {
    var el = $("discoveryPanel"); if (!el) return;
    if (state.mode !== "discovery") { el.className = "hide"; el.innerHTML = ""; return; }
    el.className = "panel";
    var opts = state.ruleLib.clients.map(function (c) { return '<option value="' + escAttr(c.client_key) + '">' + escAttr(c.client_name) + "</option>"; }).join("");
    el.innerHTML =
      '<h2 style="margin-top:0">Rule Discovery</h2>' +
      '<p class="help">Enter what a client was <b>actually paid</b> for the current period and I\'ll propose candidate rule sets — each with a confidence score and the exact $ difference — that reproduce it. Nothing changes until you click <b>Approve</b>. Parse a period on the Upload tab first so there are shifts to test against.</p>' +
      '<div class="row" style="gap:8px;align-items:flex-end;flex-wrap:wrap">' +
        '<label class="small">Client<br><select id="discClient">' + opts + "</select></label>" +
        '<label class="small">Amount actually paid (this client)<br><input id="discTarget" type="number" step="0.01" placeholder="$" style="width:140px"/></label>' +
        '<button class="sm" id="discRun">Find candidate rules</button>' +
      "</div>" +
      '<div id="discResults" style="margin-top:12px"></div>';
    $("discRun").addEventListener("click", runDiscovery);
  }

  function runDiscovery() {
    var key = $("discClient").value;
    var target = parseFloat($("discTarget").value);
    var res = $("discResults");
    if (isNaN(target)) { res.innerHTML = '<div class="banner bad">Enter the amount this client was actually paid.</div>'; return; }
    var c = RuleLib.getClient(state.ruleLib, key);
    var shifts = includedClaimed().filter(function (s) { return (s.clientKey || s.clientName) === key || s.clientName === (c && c.client_name); });
    if (!shifts.length) { res.innerHTML = '<div class="banner warn">No claimed shifts for ' + (c ? escAttr(c.client_name) : key) + " in the current period. Parse a period on the Upload tab first.</div>"; return; }
    var d = Discovery.discover({ shifts: shifts, currentRules: RuleLib.activeRules(c) || {}, targetTotal: target });
    var top = d.candidates.slice(0, 6);
    res.innerHTML =
      '<div class="banner ' + (d.cleanClose ? "good" : "warn") + '">' + d.note + "</div>" +
      '<div class="small muted" style="margin-bottom:6px">' + d.totalHours + " hrs (" + d.regHours + " regular / " + d.onHours + " overnight) · target " + EmailGen.money(d.targetTotal) + "</div>" +
      '<table><thead><tr><th>Candidate rule set</th><th class="right">Computes to</th><th class="right">Diff</th><th>Confidence</th><th></th></tr></thead><tbody>' +
      top.map(function (cd, i) {
        var cls = cd.confidence >= 95 ? "good" : (cd.confidence >= 80 ? "warn" : "bad");
        return "<tr>" +
          "<td>" + (i === 0 ? "★ " : "") + escAttr(cd.label) + (cd.clean ? "" : ' <span class="pill warn">odd rate</span>') + "</td>" +
          '<td class="right">' + EmailGen.money(cd.computed) + "</td>" +
          '<td class="right">' + (cd.diff === 0 ? "$0" : (cd.diff > 0 ? "+" : "") + EmailGen.money(cd.diff)) + "</td>" +
          '<td><span class="pill ' + cls + '">' + cd.confidence + "%</span></td>" +
          '<td><button class="ghost sm" data-approve-cand="' + i + '">Approve</button></td></tr>';
      }).join("") + "</tbody></table>";
    res.querySelectorAll("[data-approve-cand]").forEach(function (b) {
      b.addEventListener("click", function () {
        var cd = top[+this.dataset.approveCand];
        approveClientRule(key, cd.rules, {
          confidence: cd.confidence,
          notes: "Discovered to match actual pay " + EmailGen.money(target) + " — " + cd.label,
          evidence: ["Actual payment " + EmailGen.money(target), "Period " + DateUtil.fmtRange(state.settings.periodStartISO, state.settings.periodEndISO)],
          approvedBy: "user (discovery)",
        });
        renderDiscovery();
        flash("saveStatus", "Approved discovered rule for " + (c ? c.client_name : key) + ".");
      });
    });
  }

  // ---- audit report ----
  function buildAudit() {
    var report = Audit.generate({
      shifts: includedClaimed(), table: table(), ruleLib: state.ruleLib,
      startISO: state.settings.periodStartISO, endISO: state.settings.periodEndISO,
      paydayISO: state.settings.paydayISO, adjustments: state.adjustments, initials: state.settings.initials,
    });
    state.audit = report;
    $("auditBody").textContent = report.text;
    return report;
  }
  $("genAudit").addEventListener("click", function () { buildAudit(); $("auditStatus").textContent = "Generated."; });
  $("copyAudit").addEventListener("click", function () {
    if (!state.audit) buildAudit();
    navigator.clipboard.writeText(state.audit.text).then(function () { flash("auditStatus", "Copied audit report."); });
  });

  // ---- back-pay ledger ----
  function renderLedger() {
    var el = $("ledgerBody"); if (!el) return;
    if (!state.ledger.length) { el.innerHTML = '<p class="muted small">No ledger entries yet — reconcile a paid period to record any shortfall.</p>'; return; }
    el.innerHTML = '<table><thead><tr><th>Source period</th><th>Amount</th><th>Status</th><th>Recorded</th><th></th></tr></thead><tbody>' +
      state.ledger.map(function (e) {
        return "<tr><td>" + (e.sourcePeriodLabel || e.sourcePeriodId || "") + "</td>" +
          "<td>" + EmailGen.money(e.amount) + "</td>" +
          '<td><span class="pill ' + (e.status === "settled" ? "good" : e.status === "carried" ? "warn" : "bad") + '">' + e.status + "</span></td>" +
          "<td>" + e.dateRecorded + "</td>" +
          "<td>" + (e.status !== "settled" ? '<button class="ghost sm" data-settle="' + e.id + '">mark settled</button>' : "") + "</td></tr>";
      }).join("") + "</tbody></table>";
    el.querySelectorAll("[data-settle]").forEach(function (b) {
      b.addEventListener("click", function () { state.ledger = Reconcile.setStatus(state.ledger, this.dataset.settle, "settled"); saveLedger(); renderLedger(); });
    });
  }

  // ---- history ----
  function renderHistory() {
    var el = $("historyBody");
    var list = store.list();
    if (!list.length) { el.innerHTML = '<p class="muted">No saved periods yet.</p>'; return; }
    el.innerHTML = '<p class="help" style="margin:0 0 10px">On payday, type what you were <b>actually paid</b> into "Amount paid". The shortfall is computed automatically and can be carried into the current period as back pay from the Review tab.</p>' +
      '<table><thead><tr><th>Period</th><th>Pay day</th><th>Status</th><th>Expected</th><th>Amount paid</th><th>Shortfall</th><th></th></tr></thead><tbody>' +
      list.map(function (r) {
        var expected = r.expectedTotal != null ? r.expectedTotal : ((r.reviewSummary && r.reviewSummary.totalPay) || null);
        var paidVal = r.amountPaid != null ? r.amountPaid : "";
        var short = r.shortfall;
        var shortHtml = short == null ? '<span class="muted">—</span>'
          : (short > 0 ? '<span class="pill bad">' + EmailGen.money(short) + (r.carried ? " · carried" : "") + "</span>"
            : (short < 0 ? '<span class="pill warn">overpaid ' + EmailGen.money(-short) + "</span>" : '<span class="pill good">paid in full</span>'));
        var status = r.amountPaid == null ? (r.status || "draft") : (short > 0 ? "short" : "paid");
        var statusCls = (status === "paid" || status === "confirmed") ? "good" : (status === "short" ? "bad" : "warn");
        return "<tr><td>" + DateUtil.fmtRange(r.periodStartISO, r.periodEndISO) + "</td>" +
          "<td>" + DateUtil.fmtMDY(r.paydayISO) + "</td>" +
          '<td><span class="pill ' + statusCls + '">' + status + "</span></td>" +
          "<td>" + (expected != null ? EmailGen.money(expected) : "—") + "</td>" +
          '<td><input type="number" step="0.01" data-paid="' + r.id + '" value="' + paidVal + '" placeholder="$ paid" style="width:110px"/></td>' +
          "<td>" + shortHtml + "</td>" +
          '<td><button class="ghost sm" data-open="' + r.id + '">reopen</button> ' +
          '<button class="danger sm" data-delp="' + r.id + '">delete</button></td></tr>';
      }).join("") + "</tbody></table>";
    el.querySelectorAll("[data-paid]").forEach(function (inp) {
      inp.addEventListener("change", function () {
        var r = store.get(this.dataset.paid); if (!r) return;
        var v = this.value;
        var exp = r.expectedTotal != null ? r.expectedTotal : ((r.reviewSummary && r.reviewSummary.totalPay) || 0);
        var label = DateUtil.fmtRange(r.periodStartISO, r.periodEndISO);
        if (v === "") {
          r.amountPaid = null; r.shortfall = null; r.carried = false; r.reconStatus = "pending";
          // drop any non-settled ledger entry for this period
          state.ledger = state.ledger.filter(function (e) { return e.sourcePeriodId !== r.id || e.status === "settled"; });
        } else {
          var rec = Reconcile.reconcile(exp, v);
          r.amountPaid = rec.actualPaid; r.shortfall = rec.discrepancy; r.reconStatus = rec.status;
          if (rec.status === "short") {
            state.ledger = Reconcile.recordShortfall(state.ledger, { sourcePeriodId: r.id, sourcePeriodLabel: label, amount: rec.discrepancy, note: "Reconciliation shortfall" });
          } else {
            state.ledger = state.ledger.filter(function (e) { return e.sourcePeriodId !== r.id || e.status === "settled"; });
          }
        }
        saveLedger();
        store.save(r); renderHistory(); renderAdjustments(); renderLedger();
      });
    });
    el.querySelectorAll("[data-open]").forEach(function (b){ b.addEventListener("click", function (){ reopen(this.dataset.open); }); });
    el.querySelectorAll("[data-delp]").forEach(function (b){ b.addEventListener("click", function (){ store.remove(this.dataset.delp); renderHistory(); }); });
  }
  function reopen(id) {
    var r = store.get(id); if (!r) return;
    state.settings.periodStartISO = r.periodStartISO;
    state.settings.periodEndISO = r.periodEndISO;
    state.settings.paydayISO = r.paydayISO;
    state.settings.initials = r.initials;
    state.settings.periodOverride = true; // historical period: use its exact dates
    // reproduce with the period's own rule snapshot (does NOT alter the live library)
    if (r.ruleLibSnapshot) state.rates = RuleLib.resolveRates(r.ruleLibSnapshot);
    else if (r.ratesSnapshot && r.ratesSnapshot.length) state.rates = JSON.parse(JSON.stringify(r.ratesSnapshot));
    state.master = (r.shifts || []).map(function (s, i){ return Object.assign({ id: "hist:" + i, parseFlags: [] }, s); });
    state.excluded = {};
    state.adjustments = r.adjustments ? JSON.parse(JSON.stringify(r.adjustments)) : [];
    state.periodNote = null;
    state.periodSet = true;
    saveSettings(); bindSetup(); recompute(); renderAdjustments();
    if (r.draft) { state.draft = r.draft; $("draftBody").textContent = "To: " + (r.draft.to || "") + "\nSubject: " + r.draft.subject + "\n\n" + r.draft.body; }
    goTab("review");
    flash("saveStatus", "Reopened " + DateUtil.fmtRange(r.periodStartISO, r.periodEndISO));
  }

  function flash(id, msg) { var e = $(id); e.textContent = msg; setTimeout(function (){ if (e.textContent === msg) e.textContent = ""; }, 4000); }

  // ---- boot ----
  // "Done" just closes the pay-day picker (the payday change already applied it).
  $("periodDone").addEventListener("click", function () { $("periodEditor").classList.add("hide"); });

  // Initialize the pay schedule: pay day = next scheduled pay day on/after today.
  if (!state.settings.paydayISO) {
    state.settings.paydayISO = DateUtil.paydayOnOrAfter(todayISO(), state.settings.payAnchorISO);
  }
  if (!state.settings.periodOverride) deriveFromPayday(); // keep a manual override across reloads
  state.periodSet = true;
  saveSettings();

  setMode("normal"); // also renders the rule library
  bindSetup();
  renderFileList();
  renderRequiredWeeks();
  recompute();
  buildDraft(); // pre-fill Subject/To so they're never blank
  renderHistory();
  renderAdjustments();
  renderLedger();
  refreshStepper();
  updateHeaderStatus();
})();
