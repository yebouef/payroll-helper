/*
 * review.js — claim filtering + ambiguity detection (review-first safety layer)
 * -----------------------------------------------------------------------------
 * Core safety rule: DO NOT GUESS. Anything uncertain is flagged for manual
 * review instead of being silently resolved. Two severities:
 *   "review" = needs a human decision before the email is trustworthy
 *   "info"   = transparency note (expected behavior, surfaced for clarity)
 *
 * Depends on: Normalize.
 */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory(require("./normalize.js"), require("./dates.js"));
  } else {
    root.Review = factory(root.Normalize, root.DateUtil);
  }
})(typeof self !== "undefined" ? self : this, function (Normalize, DateUtil) {
  "use strict";

  var INITIAL_RE = /^[A-Z]{2}$/;

  function sameStaff(a, b) {
    var x = (a || []).slice().sort().join("+");
    var y = (b || []).slice().sort().join("+");
    return x === y;
  }

  /*
   * Re-join overnight shifts that Brittco SPLITS across two cells: an overnight
   * ending at hour H on day N, plus a continuation starting at hour H on day N+1
   * for the same client and same staff, become one shift (start..continuation-end)
   * on the START date. Pay is unchanged — the same split/rate rules run on the
   * merged shift; this only fixes the shift boundaries Brittco broke apart.
   * Runs on ALL parsed shifts BEFORE the period filter, so a continuation whose
   * overnight belongs to the prior period is correctly attributed there.
   */
  function mergeCrossMidnight(shifts) {
    shifts = shifts || [];
    var byCD = {}; // client -> date -> [indices]
    shifts.forEach(function (s, i) {
      var k = s.clientKey || s.clientName;
      (byCD[k] = byCD[k] || {});
      (byCD[k][s.dateISO] = byCD[k][s.dateISO] || []).push(i);
    });

    // PASS 1: pair each overnight with its next-morning continuation. A short
    // leftover fragment (Brittco's split tail, e.g. 7AM-8AM, <=2h) is attached
    // BACKWARD to the previous overnight (prev 11PM-7AM + 7AM-8AM -> 11PM-8AM) so an
    // overnight day starts at 11PM. Real day shifts (>2h) are never tails.
    var consumed = {}, mergeTail = {};
    shifts.forEach(function (s, i) {
      if (s._mergedOvernight) return; // IDEMPOTENT: never re-merge an already-merged shift
      var n = Normalize.normalizeShift(s.startRaw, s.endRaw);
      if (!(n.ok && n.crossesMidnight && s.dateISO)) return;
      var endH = n.endHour % 24;
      var nextDay = DateUtil.addDays(s.dateISO, 1);
      var k = s.clientKey || s.clientName;
      var cands = (byCD[k] || {})[nextDay] || [];
      for (var j = 0; j < cands.length; j++) {
        var ti = cands[j];
        if (ti === i || consumed[ti]) continue;
        var t = shifts[ti];
        var tn = Normalize.normalizeShift(t.startRaw, t.endRaw);
        var isShortTail = tn.ok && tn.durationHours > 0 && tn.durationHours <= 2;
        if (Normalize.wholeHour(t.startRaw) === endH && isShortTail && sameStaff(t.staff, s.staff)) {
          consumed[ti] = true; mergeTail[i] = t; break;
        }
      }
    });
    // PASS 2: emit, skipping consumed tails and extending merged overnights.
    var out = [];
    shifts.forEach(function (s, i) {
      if (consumed[i]) return;
      var t = mergeTail[i];
      if (t) {
        var info = { level: "info", code: "merged_overnight", message: "Merged Brittco's split overnight: " + s.startRaw + "–" + s.endRaw + " + next-morning " + t.startRaw + "–" + t.endRaw + " → " + s.startRaw + "–" + t.endRaw + " (kept on start date)." };
        out.push(Object.assign({}, s, { endRaw: t.endRaw, _mergedOvernight: true, parseFlags: (s.parseFlags || []).concat([info]) }));
      } else {
        out.push(s);
      }
    });
    return out;
  }

  /*
   * Pay periods run Monday–Sunday. A shift that starts BEFORE 8:00am on a Monday
   * is the tail of a Sunday-night overnight and belongs to Sunday (the previous
   * day) — and therefore to whichever period that Sunday falls in. So at a period
   * boundary, an early-Monday shift counts in the OLD period, not the new one.
   * We re-key such shifts to the prior date BEFORE the period filter; the date
   * range then attributes them correctly. Runs after the overnight merge.
   */
  var MONDAY = 1, DAY_START_HOUR = 8;
  function rollMondayMorningToSunday(shifts) {
    return (shifts || []).map(function (s) {
      if (!s.dateISO || DateUtil.weekday(s.dateISO) !== MONDAY) return s;
      var h = Normalize.wholeHour(s.startRaw);
      if (h == null || h >= DAY_START_HOUR) return s; // 8:00am or later = a real Monday shift
      var sun = DateUtil.addDays(s.dateISO, -1);
      var info = { level: "info", code: "monday_pre8_to_sunday",
        message: "Starts before 8:00am on Monday (" + s.startRaw + ") — counted under Sunday " + sun + " (previous day) for the pay period." };
      return Object.assign({}, s, { dateISO: sun, parseFlags: (s.parseFlags || []).concat([info]) });
    });
  }

  function rateConfigured(rate) {
    return !!(rate && typeof rate.regular_rate_usd === "number" && !isNaN(rate.regular_rate_usd) && rate.regular_rate_usd > 0);
  }

  function staffHasInitials(staff, initials) {
    var want = String(initials || "").toUpperCase();
    return (staff || []).some(function (s) {
      return String(s || "").toUpperCase() === want;
    });
  }

  function normName(s) { return String(s || "").toLowerCase().replace(/[^a-z]/g, ""); }

  // Does this shift belong to the user? "Review Attendance" list shifts match by
  // NAME — the user's name appearing ANYWHERE in the Staff column counts, so shifts
  // shared by two staff still count for each. Grid shifts fall back to initials.
  // If no name is set, trust the report's own staff filter (claim everything).
  function claimsShift(shift, opts) {
    if (shift.staffText != null) {
      var want = normName(opts.staffName);
      if (!want) return true;
      var have = normName(shift.staffText);
      return have.indexOf(want) !== -1 || want.indexOf(have) !== -1;
    }
    return staffHasInitials(shift.staff, opts.initials);
  }

  // yyyy-mm-dd string compare works lexicographically.
  function inPeriod(dateISO, startISO, endISO) {
    return dateISO >= startISO && dateISO <= endISO;
  }

  /*
   * Build flags for a single (already FY-claimed) shift.
   * rate: resolved rate config or null.
   */
  function flagsForShift(shift, rate) {
    var flags = [];
    // time validity
    var ps = Normalize.parseTime(shift.startRaw);
    var pe = Normalize.parseTime(shift.endRaw);
    if (!ps.valid || !pe.valid) {
      flags.push({ level: "review", code: "unclear_time", message: "Could not read shift time '" + shift.startRaw + "-" + shift.endRaw + "'." });
    } else {
      var norm = Normalize.normalizeShift(shift.startRaw, shift.endRaw);
      if (norm.ok && norm.durationHours <= 0) {
        flags.push({ level: "review", code: "bad_duration", message: "Shift has zero/negative length after rounding." });
      }
      norm.notes.forEach(function (n) { flags.push({ level: "info", code: "rounded", message: n }); });
      if (norm.ok && norm.crossesMidnight) {
        flags.push({ level: "info", code: "cross_midnight", message: "Crosses midnight — kept under start date " + shift.dateISO + "." });
      }
    }
    // staff sanity. Grid cells hold initials (warn on odd tokens); list rows hold
    // full names (no initials check — just confirm a name was read).
    if (shift.staffText == null) {
      (shift.staff || []).forEach(function (t) {
        if (!INITIAL_RE.test(String(t))) {
          flags.push({ level: "review", code: "unclear_initials", message: "Unusual staff marking '" + t + "' in this cell." });
        }
      });
      if (!shift.staff || shift.staff.length === 0) {
        flags.push({ level: "review", code: "missing_staff", message: "No staff initials parsed for this cell." });
      }
    } else if (!shift.staffText) {
      flags.push({ level: "review", code: "missing_staff", message: "No staff name parsed for this shift." });
    }
    // rate configured? (a row with no real $/hr counts as unconfigured)
    if (!rateConfigured(rate)) {
      flags.push({ level: "review", code: "no_rate", message: "No pay rate set for '" + shift.clientName + "'. Pay not computed — set a $/hr on the Review row or Rates tab." });
    }
    // any parser-emitted flags
    (shift.parseFlags || []).forEach(function (pf) { flags.push(pf); });
    return flags;
  }

  /*
   * Claim FY shifts within the period and attach flags.
   * Returns {
   *   claimed: [shift + {flags}],   // FY only, in-period
   *   omittedClients: [names...],   // clients that appeared but had no FY in period
   *   duplicates: [...],            // identical shift seen >1x (possible double count)
   *   reviewCount, infoCount
   * }
   */
  function claim(allShifts, opts) {
    opts = opts || {};
    // Cross-midnight merge is ON by default: re-join Brittco's split overnight
    // (11PM-7AM + next-morning 7AM-8AM tail) into one 11PM-8AM shift on the start
    // date, so an overnight day correctly starts at 11PM and the email reads cleanly.
    // Only a SHORT (<=2h) tail is absorbed, so real day shifts are never merged.
    // Pass merge:false to see every raw Brittco cell instead.
    if (opts.merge !== false) allShifts = mergeCrossMidnight(allShifts || []);
    // Monday-before-8am belongs to the previous Sunday (see rollMondayMorningToSunday).
    if (opts.mondayRoll !== false) allShifts = rollMondayMorningToSunday(allShifts);
    var initials = opts.initials || "FY";
    var startISO = opts.startISO,
      endISO = opts.endISO;
    var table = opts.table || null;

    var claimed = [];
    var clientsSeen = {};
    var clientsWithFY = {};
    var seen = {};
    var duplicates = [];
    var outOfPeriodFY = []; // FY shifts dropped ONLY because they're outside the period

    (allShifts || []).forEach(function (s) {
      if (startISO && endISO && !inPeriod(s.dateISO, startISO, endISO)) {
        if (claimsShift(s, opts)) outOfPeriodFY.push(s); // surface, don't silently drop
        return; // out of period
      }
      clientsSeen[s.clientName] = true;
      if (!claimsShift(s, opts)) return; // only the user's shifts
      clientsWithFY[s.clientName] = true;

      var sig = [s.clientKey || s.clientName, s.dateISO, s.startRaw, s.endRaw, (s.staff || []).join("+")].join("|");
      if (seen[sig]) duplicates.push(sig);
      seen[sig] = (seen[sig] || 0) + 1;

      var rate = table ? table.resolve(s.clientName, s.clientKey) : null;
      var withFlags = Object.assign({}, s, { flags: flagsForShift(s, rate), rate: rateConfigured(rate) ? rate.client_key : null });
      // Note co-workers on a shared shift (the Staff column lists more than the user).
      if (s.staffText && opts.staffName) {
        var rem = normName(s.staffText).replace(normName(opts.staffName), "");
        if (rem.length > 3) withFlags.flags.push({ level: "info", code: "shared_shift", message: "Shared shift — Brittco lists: " + s.staffText });
      }
      claimed.push(withFlags);
    });

    // duplicate flag
    if (duplicates.length) {
      claimed.forEach(function (s) {
        var sig = [s.clientKey || s.clientName, s.dateISO, s.startRaw, s.endRaw, (s.staff || []).join("+")].join("|");
        if (duplicates.indexOf(sig) !== -1) {
          s.flags.push({ level: "review", code: "duplicate", message: "Identical FY shift appears more than once — confirm it is not a double-count." });
        }
      });
    }

    // multiple same-day same-client (allowed, but surfaced as info per spec)
    var dayCount = {};
    claimed.forEach(function (s) {
      var k = (s.clientKey || s.clientName) + "|" + s.dateISO;
      dayCount[k] = (dayCount[k] || 0) + 1;
    });
    claimed.forEach(function (s) {
      var k = (s.clientKey || s.clientName) + "|" + s.dateISO;
      if (dayCount[k] > 1) {
        s.flags.push({ level: "info", code: "multi_same_day", message: "Multiple FY shifts on " + s.dateISO + " for " + s.clientName + " — each listed separately." });
      }
    });

    var omitted = Object.keys(clientsSeen).filter(function (c) { return !clientsWithFY[c]; });

    var reviewCount = 0,
      infoCount = 0;
    claimed.forEach(function (s) {
      s.flags.forEach(function (f) { f.level === "review" ? reviewCount++ : infoCount++; });
    });

    return {
      claimed: claimed,
      omittedClients: omitted,
      duplicates: duplicates,
      outOfPeriodFY: outOfPeriodFY,
      reviewCount: reviewCount,
      infoCount: infoCount,
    };
  }

  return {
    INITIAL_RE: INITIAL_RE,
    staffHasInitials: staffHasInitials,
    inPeriod: inPeriod,
    flagsForShift: flagsForShift,
    mergeCrossMidnight: mergeCrossMidnight,
    rollMondayMorningToSunday: rollMondayMorningToSunday,
    claim: claim,
  };
});
