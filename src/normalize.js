/*
 * normalize.js — time parsing + whole-hour normalization
 * -------------------------------------------------------
 * OPERATING RULE (locked with user): round DOWN / truncate to the whole hour.
 *   7:14am -> 7:00 (7)    9:01am -> 9:00 (9)    7:45am -> 7:00 (7)
 * The truncated whole-hour value is used for BOTH display and pay.
 *
 * Pure, DOM-free, deterministic. Same code runs in the browser app and in Node.
 */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) module.exports = factory();
  else root.Normalize = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Strict Brittco time token, e.g. "7:00am", "11:00pm", "7:14am". Trailing "-" allowed.
  var TIME_RE = /^(\d{1,2}):(\d{2})(am|pm)-?$/i;

  // Parse a raw time string into a 24h decimal {h, m, valid, raw}. Does NOT truncate.
  function parseTime(raw) {
    if (raw == null) return { valid: false, raw: raw };
    var t = String(raw).trim();
    var m = TIME_RE.exec(t);
    if (!m) return { valid: false, raw: raw };
    var hr = parseInt(m[1], 10);
    var min = parseInt(m[2], 10);
    var mer = m[3].toLowerCase();
    if (hr < 1 || hr > 12 || min < 0 || min > 59) return { valid: false, raw: raw };
    // 12am = 0, 12pm = 12, otherwise pm adds 12.
    if (mer === "am") hr = hr === 12 ? 0 : hr;
    else hr = hr === 12 ? 12 : hr + 12;
    return { valid: true, raw: raw, h: hr, m: min, meridiem: mer };
  }

  // Truncate a parsed time to its whole hour (drop minutes). Returns integer 0..23.
  function truncateToHour(parsed) {
    if (!parsed || !parsed.valid) return null;
    return parsed.h; // minutes intentionally dropped (round-down rule)
  }

  // Convenience: raw string -> whole hour 0..23 (or null if unparseable).
  function wholeHour(raw) {
    return truncateToHour(parseTime(raw));
  }

  // Was a non-zero minute present? (used only for transparency notes, NOT pay).
  function hadMinutes(raw) {
    var p = parseTime(raw);
    return p.valid && p.m !== 0;
  }

  /*
   * Normalize a shift's start/end raw strings into whole-hour integers on a
   * 0..47 timeline so cross-midnight shifts are monotonic.
   * Returns { ok, startHour, endHour, crossesMidnight, durationHours, notes[] }.
   * endHour may be >23 when the shift crosses midnight (e.g. 11pm->7am => 23..31).
   * NOTE: the shift stays keyed to its START date (caller owns the date).
   */
  function normalizeShift(startRaw, endRaw) {
    var notes = [];
    var ps = parseTime(startRaw);
    var pe = parseTime(endRaw);
    if (!ps.valid || !pe.valid) {
      return { ok: false, reason: "unparseable_time", startRaw: startRaw, endRaw: endRaw };
    }
    var startHour = truncateToHour(ps);
    var endHour = truncateToHour(pe);
    if (hadMinutes(startRaw)) notes.push("start " + startRaw + " rounded down to " + label12(startHour));
    if (hadMinutes(endRaw)) notes.push("end " + endRaw + " rounded down to " + label12(endHour));

    var crosses = false;
    if (endHour <= startHour) {
      // crosses midnight (or zero/negative duration). Treat end as next day.
      endHour += 24;
      crosses = true;
    }
    var duration = endHour - startHour;
    return {
      ok: true,
      startHour: startHour,
      endHour: endHour,
      crossesMidnight: crosses,
      durationHours: duration,
      notes: notes,
    };
  }

  // Format a whole hour (0..47) as a compact 12h label like "7AM", "11PM", "12AM".
  function label12(hour) {
    var h = ((hour % 24) + 24) % 24;
    var mer = h < 12 ? "AM" : "PM";
    var disp = h % 12;
    if (disp === 0) disp = 12;
    return disp + mer;
  }

  return {
    TIME_RE: TIME_RE,
    parseTime: parseTime,
    truncateToHour: truncateToHour,
    wholeHour: wholeHour,
    hadMinutes: hadMinutes,
    normalizeShift: normalizeShift,
    label12: label12,
  };
});
