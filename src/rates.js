/*
 * rates.js — configurable client pay-rule table
 * ----------------------------------------------
 * RATES ARE CONFIGURATION, NOT CODE. Nothing here is hardcoded into the
 * calculation engine. Add/edit clients without touching payroll logic.
 *
 * Data model (per user spec):
 *   client_name        display name used verbatim in the email
 *   client_key         stable id / PDF code (e.g. "EC", "RG", "PN")
 *   regular_rate_usd   $/hr for regular hours
 *   overnight_rate_usd $/hr for overnight hours (null => no overnight rate)
 *   overnight_start    hour 0..23 overnight window begins (e.g. 23 = 11PM)
 *   overnight_end      hour 0..23 overnight window ends   (e.g. 7  = 7AM)
 *   special_rules      free-form notes (no behavior unless implemented later)
 *
 * IMPORTANT: clients with no entry here have NO rates. The engine will FLAG
 * such shifts for review and will never invent a rate.
 */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) module.exports = factory();
  else root.Rates = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Default is EMPTY — the app ships with no clients. Each user adds their own
  // (privacy + multi-user). Rates come from the rule library at runtime.
  function defaultRates() {
    return [];
  }

  function makeTable(list) {
    var byKey = {};
    var byName = {};
    var aliasIndex = {};
    (list || []).forEach(function (r) {
      byKey[r.client_key] = r;
      byName[normName(r.client_name)] = r;
      (r.pdf_aliases || []).forEach(function (a) {
        aliasIndex[normName(a)] = r;
      });
    });
    return {
      list: list || [],
      get: function (keyOrName) {
        if (!keyOrName) return null;
        return (
          byKey[keyOrName] ||
          byName[normName(keyOrName)] ||
          aliasIndex[normName(keyOrName)] ||
          null
        );
      },
      // resolve a PDF section header / code to a configured rate, else null.
      resolve: function (headerText, code) {
        if (code && byKey[code]) return byKey[code];
        var n = normName(headerText);
        if (byName[n]) return byName[n];
        // alias contains-match (PDF headers can be "Lastname Lastname - Location")
        for (var a in aliasIndex) {
          if (n.indexOf(a) !== -1) return aliasIndex[a];
        }
        return null;
      },
    };
  }

  function normName(s) {
    return String(s || "").toLowerCase().replace(/[^a-z]/g, "");
  }

  // A rate is only "configured" once it has a real regular $/hr. Auto-added
  // clients exist as rows but stay UNCONFIGURED (flagged) until you set a rate —
  // we never invent one.
  function isConfigured(rate) {
    return !!(rate && typeof rate.regular_rate_usd === "number" && !isNaN(rate.regular_rate_usd) && rate.regular_rate_usd > 0);
  }

  return { defaultRates: defaultRates, makeTable: makeTable, normName: normName, isConfigured: isConfigured };
});
