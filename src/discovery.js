/*
 * discovery.js — Rule Discovery engine (Phase 2)
 * ----------------------------------------------
 * Given one client's claimed shifts and a TARGET amount (what was actually paid,
 * or the coordinator's figure), generate candidate rule sets, compute each total,
 * and rank by how well — and how *plausibly* — each explains the target.
 *
 * Key idea: a rule that hits the target only by using an odd, "engineered" rate
 * (e.g. $17.91/hr) is far less believable than a clean rate ($18.00) — even if its
 * $-difference is smaller. So confidence weights BOTH the $-difference AND rate
 * cleanliness. If no clean rule lands near the target, that's itself the finding:
 * the discrepancy is in the HOURS, not the rate.
 *
 * Pure, DOM-free. Never activates anything — it only recommends. Depends on Payroll.
 */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) module.exports = factory(require("./payroll.js"), require("./normalize.js"));
  else root.Discovery = factory(root.Payroll, root.Normalize);
})(typeof self !== "undefined" ? self : this, function (Payroll, Normalize) {
  "use strict";

  function round2(n) { return Math.round(n * 100) / 100; }
  function isClean(n) { return n != null && Math.abs(n * 4 - Math.round(n * 4)) < 1e-9; } // multiple of $0.25
  function rule(over) {
    return Object.assign({ regular_rate_usd: null, overnight_rate_usd: null, overnight_start: null, overnight_end: null }, over || {});
  }
  function totalFor(shifts, r) {
    return round2(shifts.reduce(function (s, sh) { return s + (Payroll.computeShiftPay(sh, r).pay || 0); }, 0));
  }
  // hours split under a given overnight window (start/end). Returns {reg, on, total}.
  function split(shifts, start, end) {
    var probe = rule({ regular_rate_usd: 1, overnight_rate_usd: 1, overnight_start: start, overnight_end: end });
    var reg = 0, on = 0;
    shifts.forEach(function (sh) { var c = Payroll.computeShiftPay(sh, probe); reg += c.regularHours || 0; on += c.overnightHours || 0; });
    return { reg: reg, on: on, total: reg + on };
  }

  function confidence(diff, clean) {
    var ad = Math.abs(diff);
    if (ad < 0.01) return clean ? 99 : 85;          // reproduces exactly
    if (ad < 1) return clean ? 96 : 83;
    if (ad < 5) return clean ? 93 : 80;
    if (ad < 20) return clean ? 85 : 72;
    if (ad < 75) return 65;
    return 55;                                       // can't explain it
  }

  /*
   * params: { shifts (one client, claimed/in-period), currentRules, targetTotal,
   *           overnightStart, overnightEnd } (window defaults to the client's, else 23/7)
   * returns { totalHours, regHours, onHours, targetTotal, candidates:[...], recommendation, note }
   */
  function discover(params) {
    var shifts = params.shifts || [];
    var target = round2(params.targetTotal);
    var cur = params.currentRules || rule();
    var oStart = params.overnightStart != null ? params.overnightStart : (cur.overnight_start != null ? cur.overnight_start : 23);
    var oEnd = params.overnightEnd != null ? params.overnightEnd : (cur.overnight_end != null ? cur.overnight_end : 7);
    var sp = split(shifts, oStart, oEnd);
    var H = sp.total, regH = sp.reg, onH = sp.on;

    var cands = [];
    function add(label, r, kind) {
      var total = totalFor(shifts, r);
      var diff = round2(total - target);
      var clean = isClean(r.regular_rate_usd) && (r.overnight_rate_usd == null || isClean(r.overnight_rate_usd));
      cands.push({ label: label, kind: kind, rules: r, computed: total, diff: diff, clean: clean, confidence: confidence(diff, clean) });
    }

    // 1. current approved rules (baseline)
    if (cur.regular_rate_usd != null) add("Current approved rules", rule(cur), "baseline");

    // 2. flat rate, no overnight differential (clean candidates near target/H)
    if (H > 0) {
      var flat = round2(target / H);
      add("Flat $" + flat.toFixed(2) + "/hr, no overnight", rule({ regular_rate_usd: flat }), "flat");
      [Math.round(flat), Math.round(flat * 4) / 4].forEach(function (rt) { // nearest $1 and $0.25
        if (rt > 0 && rt !== flat) add("Flat $" + rt.toFixed(2) + "/hr, no overnight", rule({ regular_rate_usd: rt }), "flat");
      });
    }

    // 3. keep regular rate, solve the overnight rate to hit target
    if (onH > 0 && cur.regular_rate_usd) {
      var onSolved = round2((target - cur.regular_rate_usd * regH) / onH);
      add("Regular $" + cur.regular_rate_usd + " + overnight $" + onSolved.toFixed(2) + " (" + oStart + "–" + oEnd + ")",
        rule({ regular_rate_usd: cur.regular_rate_usd, overnight_rate_usd: onSolved, overnight_start: oStart, overnight_end: oEnd }), "solve_on");
    }
    // 4. keep overnight $16, solve the regular rate
    if (regH > 0 && onH > 0) {
      var regSolved = round2((target - 16 * onH) / regH);
      add("Regular $" + regSolved.toFixed(2) + " + overnight $16 (" + oStart + "–" + oEnd + ")",
        rule({ regular_rate_usd: regSolved, overnight_rate_usd: 16, overnight_start: oStart, overnight_end: oEnd }), "solve_reg");
    }
    // 5. clean fixed rate sets to compare (no overnight)
    [18, 20, 22].forEach(function (rt) { add("Flat $" + rt + "/hr, no overnight", rule({ regular_rate_usd: rt }), "fixed"); });

    // de-dupe by rule signature, keep best confidence
    var seen = {};
    cands = cands.filter(function (c) {
      var k = c.rules.regular_rate_usd + "|" + c.rules.overnight_rate_usd + "|" + c.rules.overnight_start + "|" + c.rules.overnight_end;
      if (seen[k]) return false; seen[k] = true; return true;
    });
    // rank: clean-and-close first. Sort by confidence desc, then |diff| asc.
    cands.sort(function (a, b) { return b.confidence - a.confidence || Math.abs(a.diff) - Math.abs(b.diff); });

    var best = cands[0];
    // is the target reachable by any CLEAN rule near it? (within $1)
    var cleanClose = cands.some(function (c) { return c.clean && Math.abs(c.diff) < 1; });
    var note = cleanClose
      ? "A clean, plausible rate reproduces the target — see the top candidate."
      : "No clean/plausible rate reproduces the target on these " + H + " hours. The gap is most likely in the HOURS (attendance vs billed), not the pay rate — investigate the shift counts, not the rate.";

    return { totalHours: H, regHours: regH, onHours: onH, targetTotal: target, candidates: cands, recommendation: best, note: note, cleanClose: cleanClose };
  }

  return { round2: round2, isClean: isClean, confidence: confidence, discover: discover };
});
