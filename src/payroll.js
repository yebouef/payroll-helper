/*
 * payroll.js — deterministic pay calculation with overnight split
 * ---------------------------------------------------------------
 * No heuristics. Whole-hour blocks only. Overnight window is read from the
 * client's rate config (never hardcoded). If a client has no rate, pay is NOT
 * computed and the shift is flagged unconfigured.
 *
 * Depends on: Normalize (normalizeShift, label12).
 */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory(require("./normalize.js"));
  } else {
    root.Payroll = factory(root.Normalize);
  }
})(typeof self !== "undefined" ? self : this, function (Normalize) {
  "use strict";

  // Is whole-hour block [t, t+1) (t on a 0..47 timeline) inside the overnight
  // window defined by [start,end)? Window wraps midnight when start > end.
  function isOvernightHour(t, start, end) {
    if (start == null || end == null) return false;
    var h = ((t % 24) + 24) % 24;
    if (start < end) return h >= start && h < end; // non-wrapping window
    return h >= start || h < end; // wraps midnight, e.g. 23..7
  }

  /*
   * Split a normalized shift into regular vs overnight whole hours.
   * Returns { regularHours, overnightHours, totalHours }.
   * Iterates one whole-hour block at a time => exact, no rounding drift.
   */
  function splitHours(startHour, endHour, rate) {
    var reg = 0,
      on = 0;
    for (var t = startHour; t < endHour; t++) {
      if (rate && rate.overnight_rate_usd != null && isOvernightHour(t, rate.overnight_start, rate.overnight_end)) {
        on++;
      } else {
        reg++;
      }
    }
    return { regularHours: reg, overnightHours: on, totalHours: reg + on };
  }

  /*
   * Compute pay for a single shift.
   * shift: { startRaw, endRaw, ... }   rate: rate config object or null.
   * Returns a fully-populated result; on missing rate, computed=false + reason.
   */
  function computeShiftPay(shift, rate) {
    var norm = Normalize.normalizeShift(shift.startRaw, shift.endRaw);
    if (!norm.ok) {
      return { computed: false, reason: "unparseable_time", pay: 0, totalHours: 0, notes: [] };
    }
    var base = {
      startHour: norm.startHour,
      endHour: norm.endHour,
      crossesMidnight: norm.crossesMidnight,
      startLabel: Normalize.label12(norm.startHour),
      endLabel: Normalize.label12(norm.endHour),
      notes: norm.notes.slice(),
    };
    if (norm.durationHours <= 0) {
      return Object.assign(base, { computed: false, reason: "zero_or_negative_duration", pay: 0, totalHours: 0 });
    }
    // Treat a missing rate OR a rate with no real $/hr (e.g. an auto-added,
    // not-yet-configured client) as unconfigured — never compute as $0.
    if (!rate || typeof rate.regular_rate_usd !== "number" || isNaN(rate.regular_rate_usd) || rate.regular_rate_usd <= 0) {
      return Object.assign(base, {
        computed: false,
        reason: "no_rate_configured",
        pay: 0,
        totalHours: norm.durationHours,
        regularHours: norm.durationHours,
        overnightHours: 0,
      });
    }
    var split = splitHours(norm.startHour, norm.endHour, rate);
    var regRate = rate.regular_rate_usd || 0;
    var onRate = rate.overnight_rate_usd != null ? rate.overnight_rate_usd : regRate;
    var pay = split.regularHours * regRate + split.overnightHours * onRate;
    return Object.assign(base, {
      computed: true,
      regularHours: split.regularHours,
      overnightHours: split.overnightHours,
      totalHours: split.totalHours,
      regularRate: regRate,
      overnightRate: onRate,
      pay: pay,
    });
  }

  /*
   * Compute a whole pay period.
   * shifts: array of claimed shift objects (already filtered to FY + period).
   * table:  Rates table (from Rates.makeTable). Returns grouped client totals.
   */
  function computePeriod(shifts, table) {
    var groups = {}; // clientKey -> { clientName, shifts:[], hours, pay, hasUnconfigured }
    var order = [];
    (shifts || []).forEach(function (s) {
      var rate = table ? table.resolve(s.clientName, s.clientKey) : null;
      var res = computeShiftPay(s, rate);
      var key = s.clientKey || s.clientName;
      if (!groups[key]) {
        groups[key] = {
          clientKey: key,
          clientName: s.clientName,
          configured: !!rate,
          shifts: [],
          totalHours: 0,
          totalPay: 0,
          hasUnconfigured: false,
        };
        order.push(key);
      }
      var g = groups[key];
      g.shifts.push(Object.assign({}, s, { calc: res }));
      g.totalHours += res.totalHours || 0;
      g.totalPay += res.pay || 0;
      if (!res.computed) g.hasUnconfigured = true;
    });
    var grandPay = 0,
      grandHours = 0;
    order.forEach(function (k) {
      grandPay += groups[k].totalPay;
      grandHours += groups[k].totalHours;
    });
    return { clients: order.map(function (k) { return groups[k]; }), grandPay: grandPay, grandHours: grandHours };
  }

  return {
    isOvernightHour: isOvernightHour,
    splitHours: splitHours,
    computeShiftPay: computeShiftPay,
    computePeriod: computePeriod,
  };
});
