/*
 * audit.js — per-period payroll audit report (full transparency / audit trail)
 * ----------------------------------------------------------------------------
 * For every claimed shift, shows: raw clock times -> rounded whole hours ->
 * regular/overnight split -> rate applied -> $ — and which client RULE VERSION
 * was used. Plus period totals, back pay, grand total. Produces both a
 * structured object (for storage) and a readable text report.
 *
 * Depends on: Payroll, Normalize, DateUtil, RuleLib.
 */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory(require("./payroll.js"), require("./normalize.js"), require("./dates.js"), require("./rulelib.js"));
  } else {
    root.Audit = factory(root.Payroll, root.Normalize, root.DateUtil, root.RuleLib);
  }
})(typeof self !== "undefined" ? self : this, function (Payroll, Normalize, DateUtil, RuleLib) {
  "use strict";

  function money(n) {
    var neg = n < 0, s = Math.round(Math.abs(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return (neg ? "-$" : "$") + s;
  }
  function pad(s, n) { s = String(s); while (s.length < n) s += " "; return s; }

  /*
   * params: { shifts (claimed), table, ruleLib, startISO, endISO, paydayISO, adjustments, initials }
   */
  function generate(params) {
    var table = params.table;
    var lib = params.ruleLib;
    var per = Payroll.computePeriod(params.shifts, table);

    var clients = per.clients.map(function (c) {
      var libClient = lib ? RuleLib.getClient(lib, c.clientKey || c.clientName) : null;
      var av = libClient ? RuleLib.activeVersionOf(libClient) : null;
      var rows = c.shifts.slice().sort(function (a, b) {
        if (a.dateISO !== b.dateISO) return a.dateISO < b.dateISO ? -1 : 1;
        return (a.calc.startHour || 0) - (b.calc.startHour || 0);
      }).map(function (s) {
        var calc = s.calc;
        return {
          dateISO: s.dateISO,
          raw: s.startRaw + "-" + s.endRaw,
          rounded: calc.startLabel ? calc.startLabel + "-" + calc.endLabel : "(unreadable)",
          crossesMidnight: !!calc.crossesMidnight,
          regularHours: calc.regularHours || 0,
          overnightHours: calc.overnightHours || 0,
          regularRate: calc.regularRate != null ? calc.regularRate : null,
          overnightRate: calc.overnightRate != null ? calc.overnightRate : null,
          pay: calc.pay || 0,
          computed: !!calc.computed,
          notes: (calc.notes || []).concat((s.flags || []).filter(function (f){ return f.code === "merged_overnight"; }).map(function (f){ return f.message; })),
        };
      });
      return {
        clientName: c.clientName,
        clientKey: c.clientKey,
        ruleVersion: av ? av.version : "(none)",
        ruleConfidence: av ? av.confidence : 0,
        configured: c.configured,
        rows: rows,
        hours: c.totalHours,
        pay: c.totalPay,
      };
    });

    var adjustments = params.adjustments || [];
    var adjTotal = adjustments.reduce(function (s, a) { return s + (Number(a.amount) || 0); }, 0);
    var grand = per.grandPay + adjTotal;

    var report = {
      generatedAt: new Date().toISOString(),
      initials: params.initials || "FY",
      periodStartISO: params.startISO,
      periodEndISO: params.endISO,
      paydayISO: params.paydayISO,
      clients: clients,
      adjustments: adjustments,
      currentEarnings: per.grandPay,
      adjustmentsTotal: adjTotal,
      grandPay: grand,
      grandHours: per.grandHours,
    };
    report.text = toText(report);
    return report;
  }

  function toText(r) {
    var L = [];
    L.push("PAYROLL AUDIT REPORT");
    L.push("Generated: " + r.generatedAt);
    L.push("Initials: " + r.initials + "   Pay period: " + DateUtil.fmtRange(r.periodStartISO, r.periodEndISO) + "   Pay day: " + DateUtil.fmtMDY(r.paydayISO));
    L.push("");
    r.clients.forEach(function (c) {
      L.push("== " + c.clientName + "  [rule v" + c.ruleVersion + ", confidence " + c.ruleConfidence + "%] ==");
      L.push(pad("DATE", 11) + pad("RAW", 16) + pad("ROUNDED", 14) + pad("REG", 5) + pad("OT", 5) + pad("RATES", 14) + "PAY");
      c.rows.forEach(function (row) {
        var rates = c.configured ? ("$" + (row.regularRate || 0) + "/$" + (row.overnightRate != null ? row.overnightRate : row.regularRate || 0)) : "(no rate)";
        L.push(
          pad(DateUtil.fmtMDY(row.dateISO), 11) +
          pad(row.raw, 16) +
          pad(row.rounded, 14) +
          pad(row.regularHours, 5) +
          pad(row.overnightHours, 5) +
          pad(rates, 14) +
          (row.computed ? money(row.pay) : "UNCONFIGURED")
        );
        row.notes.forEach(function (n) { L.push("    · " + n); });
      });
      L.push("   Subtotal: " + c.hours + " hrs · " + money(c.pay));
      L.push("");
    });
    if (r.adjustments.length) {
      L.push("== Adjustments / Back pay ==");
      r.adjustments.forEach(function (a) { L.push("   " + a.label + ": " + money(a.amount)); });
      L.push("");
    }
    L.push("Current earnings: " + money(r.currentEarnings));
    if (r.adjustmentsTotal) L.push("Adjustments:      " + money(r.adjustmentsTotal));
    L.push("GRAND TOTAL:      " + money(r.grandPay) + "   (" + r.grandHours + " hours)");
    return L.join("\n");
  }

  return { generate: generate, money: money };
});
