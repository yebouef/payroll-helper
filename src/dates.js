/*
 * dates.js — pay-period + payday date math and formatting
 * -------------------------------------------------------
 * Pay period: 2 weeks, weeks run Monday..Sunday => period is Mon (start) to
 * Sun (start+13). Payday default = 2nd Friday AFTER the period end Sunday
 * (matches the user's real sample: period ends 6/14, PAY DAY 6/26). Editable.
 *
 * All dates handled as 'yyyy-mm-dd' strings in local time (no TZ drift).
 */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) module.exports = factory();
  else root.DateUtil = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function pad(n) { return (n < 10 ? "0" : "") + n; }

  function parseISO(iso) {
    var p = String(iso).split("-");
    return { y: +p[0], m: +p[1], d: +p[2] };
  }
  function toISO(y, m, d) { return y + "-" + pad(m) + "-" + pad(d); }

  // Use UTC arithmetic to avoid DST/timezone off-by-one.
  function addDays(iso, n) {
    var p = parseISO(iso);
    var dt = new Date(Date.UTC(p.y, p.m - 1, p.d));
    dt.setUTCDate(dt.getUTCDate() + n);
    return toISO(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
  }

  // 0=Sun .. 6=Sat
  function weekday(iso) {
    var p = parseISO(iso);
    return new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay();
  }

  // Period end (Sunday) from a Monday start.
  function periodEnd(startISO) { return addDays(startISO, 13); }

  // First Friday strictly after a given date.
  function nextFriday(iso) {
    var d = addDays(iso, 1);
    while (weekday(d) !== 5) d = addDays(d, 1);
    return d;
  }

  // Default payday = 2nd Friday after the period end Sunday.
  function defaultPayday(periodEndISO) {
    return nextFriday(nextFriday(periodEndISO));
  }

  // "6/05/26" — month no leading zero, day leading zero, 2-digit year (sample style).
  function fmtMDY(iso) {
    var p = parseISO(iso);
    return p.m + "/" + pad(p.d) + "/" + String(p.y).slice(-2);
  }

  // "6/01/26-6/14/26"
  function fmtRange(startISO, endISO) { return fmtMDY(startISO) + "-" + fmtMDY(endISO); }

  // Snap any date back to the Monday of its Mon..Sun week (for period start).
  function mondayOf(iso) {
    var wd = weekday(iso); // 0..6, Sun=0
    var back = wd === 0 ? 6 : wd - 1;
    return addDays(iso, -back);
  }

  // ---- biweekly pay schedule (anchored on a known payday) ----
  // Whole-day difference b - a.
  function daysBetween(aISO, bISO) {
    var a = parseISO(aISO), b = parseISO(bISO);
    return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86400000);
  }
  // The payday on/after `todayISO`, given any known `anchorISO` payday (14-day cadence).
  function paydayOnOrAfter(todayISO, anchorISO) {
    var k = Math.ceil(daysBetween(anchorISO, todayISO) / 14);
    return addDays(anchorISO, k * 14);
  }
  // Snap an arbitrary date to the nearest scheduled payday.
  function snapPayday(iso, anchorISO) {
    var k = Math.round(daysBetween(anchorISO, iso) / 14);
    return addDays(anchorISO, k * 14);
  }
  // The 2-week pay period a payday pays for (Mon..Sun, 14 days, non-overlapping):
  // end (Sunday) = payday - 12, start (Monday) = end - 13.
  // (Matches the verified example: payday 6/26 -> 6/01..6/14 = the real $3,308 paycheck.)
  // NOTE: the leading Sunday belongs to the PREVIOUS period (that's why 5/31 was excluded
  // from June and paid earlier). A shift on the period-start-minus-one Sunday is prior-period.
  function periodFromPayday(paydayISO) {
    var endISO = addDays(paydayISO, -12);
    return { startISO: addDays(endISO, -13), endISO: endISO };
  }
  // Inverse: the payday for a Monday period start.
  function paydayFromPeriodStart(startISO) { return addDays(startISO, 25); }
  // The 3 Brittco weekly exports (Sun..Sat) needed to cover a Mon..Sun(+13) period.
  function requiredWeeks(startISO) {
    var firstSun = addDays(startISO, -weekday(startISO)); // Sunday on/before the start
    var out = [];
    for (var i = 0; i < 3; i++) {
      var sun = addDays(firstSun, i * 7);
      out.push({ sun: sun, sat: addDays(sun, 6) });
    }
    return out;
  }
  // Email is due the Wednesday before payday (payday - 2 days).
  function emailDue(paydayISO) { return addDays(paydayISO, -2); }

  return {
    pad: pad, parseISO: parseISO, toISO: toISO, addDays: addDays, weekday: weekday,
    periodEnd: periodEnd, nextFriday: nextFriday, defaultPayday: defaultPayday,
    fmtMDY: fmtMDY, fmtRange: fmtRange, mondayOf: mondayOf,
    daysBetween: daysBetween, paydayOnOrAfter: paydayOnOrAfter, snapPayday: snapPayday,
    periodFromPayday: periodFromPayday, paydayFromPeriodStart: paydayFromPeriodStart,
    requiredWeeks: requiredWeeks, emailDue: emailDue,
  };
});
