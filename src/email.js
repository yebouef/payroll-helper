/*
 * email.js — final email DRAFT generation (review-first; never auto-send)
 * ----------------------------------------------------------------------
 * Produces text in the user's sample style:
 *
 *   Subject: Pay Period: 6/01/26-6/14/26
 *   To: (your coordinator's email)
 *   From: (your name and email)
 *   (high importance)
 *
 *   PAY DAY: 6/26/26
 *   Client A (72 HOURS)
 *
 *   6/05/26: 3PM-11PM
 *   ...
 *
 *   Client B (88 HOURS)
 *
 *   6/01/26: 11PM-7AM
 *   ...
 *
 *   TOTAL PAY: $1,440
 *
 * Rules honored: omit clients with no FY shifts; whole-hour totals; cross-midnight
 * under start date; client display names verbatim; grand total in dollars.
 *
 * Depends on: Payroll, DateUtil, Normalize.
 */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory(require("./payroll.js"), require("./dates.js"), require("./normalize.js"));
  } else {
    root.EmailGen = factory(root.Payroll, root.DateUtil, root.Normalize);
  }
})(typeof self !== "undefined" ? self : this, function (Payroll, DateUtil, Normalize) {
  "use strict";

  function money(n) {
    var neg = n < 0;
    var s = Math.round(Math.abs(n)).toString();
    s = s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return (neg ? "-$" : "$") + s;
  }

  // Display a normalized shift's time window as "3PM-11PM" / "11PM-7AM".
  function shiftWindow(calc) {
    return calc.startLabel + "-" + calc.endLabel;
  }

  // DISPLAY-ONLY grouping: collapse back-to-back shifts that START on the same
  // calendar date into one printed range (e.g. 2PM-11PM + 11PM-8AM -> 2PM-8AM).
  // Combines ONLY when one shift ends exactly when the next begins AND both share
  // the same start date AND both are computed — so 24/7 coverage never collapses
  // across days, gaps never merge, and pay is never affected (totals come from the
  // individual shifts). Returns display groups; multi-shift groups carry count>1.
  var EPOCH = "2000-01-01";
  function combineForDisplay(sortedShifts) {
    var groups = [], cur = null;
    (sortedShifts || []).forEach(function (s) {
      var calc = s.calc || {};
      var hasPos = typeof calc.startHour === "number" && typeof calc.endHour === "number";
      var aS = hasPos ? DateUtil.daysBetween(EPOCH, s.dateISO) * 24 + calc.startHour : null;
      var aE = hasPos ? DateUtil.daysBetween(EPOCH, s.dateISO) * 24 + calc.endHour : null;
      if (cur && cur.computed && calc.computed && hasPos && cur.aE === aS && cur.dateISO === s.dateISO) {
        cur.aE = aE; cur.endLabel = calc.endLabel; cur.count++;        // extend the block
      } else {
        if (cur) groups.push(cur);
        cur = {
          dateISO: s.dateISO, count: 1, computed: !!calc.computed, aS: aS, aE: aE,
          startLabel: calc.startLabel, endLabel: calc.endLabel,
          raw: (calc.computed || calc.startLabel) ? null : (s.startRaw + "-" + s.endRaw),
        };
      }
    });
    if (cur) groups.push(cur);
    return groups;
  }

  // True when a combined block's last worked hour falls on a later calendar day.
  function endsNextDay(g) {
    return g.aS != null && g.aE != null && Math.floor((g.aE - 1) / 24) > Math.floor(g.aS / 24);
  }

  /*
   * Build the draft from claimed shifts.
   * params: {
   *   shifts, table, startISO, endISO, paydayISO,
   *   to, from, clientOrder (array of clientName preference)
   * }
   * Returns { subject, to, from, highImportance, body, totals, unconfigured }.
   */
  function buildDraft(params) {
    var period = Payroll.computePeriod(params.shifts, params.table);

    // order clients by preference list, then by first appearance
    var pref = params.clientOrder || [];
    period.clients.sort(function (a, b) {
      var ia = pref.indexOf(a.clientName), ib = pref.indexOf(b.clientName);
      if (ia === -1) ia = 999;
      if (ib === -1) ib = 999;
      return ia - ib;
    });

    var lines = [];
    lines.push("PAY DAY: " + DateUtil.fmtMDY(params.paydayISO));

    var unconfigured = [];
    period.clients.forEach(function (c) {
      // sort shifts by date then start hour
      var sorted = c.shifts.slice().sort(function (x, y) {
        if (x.dateISO !== y.dateISO) return x.dateISO < y.dateISO ? -1 : 1;
        return (x.calc.startHour || 0) - (y.calc.startHour || 0);
      });
      lines.push(c.clientName + " (" + c.totalHours + " HOURS)");
      lines.push(""); // blank line under header (sample style)
      // unconfigured tracking stays per-shift (independent of display grouping)
      sorted.forEach(function (s) {
        if (!s.calc.computed) unconfigured.push(c.clientName + " " + DateUtil.fmtMDY(s.dateISO));
      });
      // print one line per display group (contiguous same-day shifts merged)
      combineForDisplay(sorted).forEach(function (g) {
        var win = g.raw != null ? g.raw : (g.startLabel + "-" + g.endLabel);
        var line = DateUtil.fmtMDY(g.dateISO) + ": " + win;
        if (g.count > 1 && endsNextDay(g)) line += " (next day)"; // marker only on merged cross-midnight lines
        lines.push(line);
      });
      lines.push("");
      lines.push(""); // gap between clients (sample style)
    });

    // adjustments (back pay / deductions) — each is { label, amount }
    var adjustments = params.adjustments || [];
    var adjTotal = adjustments.reduce(function (s, a) { return s + (Number(a.amount) || 0); }, 0);
    var grand = period.grandPay + adjTotal;

    // trim trailing blanks, then the pay breakdown + inclusive total
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    lines.push("");
    // When there's back pay/adjustments, show the breakdown so TOTAL = this period + back pay.
    if (adjustments.length) {
      lines.push("PAY THIS PERIOD: " + money(period.grandPay));
      adjustments.forEach(function (a) { lines.push(a.label + ": " + money(Number(a.amount) || 0)); });
    }
    lines.push("TOTAL PAY: " + money(grand));

    // wrap with a light greeting + sign-off so it reads like an email (editable via params)
    var senderName = String(params.from || "").replace(/\s*<[^>]*>\s*$/, "").trim();
    var greeting = params.greeting != null ? params.greeting : "Hello,";
    var closing = params.closing != null ? params.closing : "Thank you,";
    var bodyLines = [];
    if (greeting) bodyLines.push(greeting, "");
    bodyLines = bodyLines.concat(lines);
    if (closing) { bodyLines.push("", closing); if (senderName) bodyLines.push(senderName); }

    return {
      subject: "Pay Period: " + DateUtil.fmtRange(params.startISO, params.endISO),
      to: params.to || "",
      from: params.from || "",
      highImportance: true,
      body: bodyLines.join("\n"),
      adjustments: adjustments,
      totals: { currentEarnings: period.grandPay, adjustmentsTotal: adjTotal, grandPay: grand, grandHours: period.grandHours },
      perClient: period.clients.map(function (c) {
        return { name: c.clientName, hours: c.totalHours, pay: c.totalPay, configured: c.configured };
      }),
      unconfigured: unconfigured, // non-empty => DO NOT SEND until resolved
    };
  }

  return { money: money, shiftWindow: shiftWindow, buildDraft: buildDraft };
});
