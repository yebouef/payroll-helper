/*
 * rulelib.js — versioned, per-client Payroll Rule Library (governance layer)
 * --------------------------------------------------------------------------
 * Each client has an independent profile with a full VERSION HISTORY. Versions
 * are never overwritten. Normal Payroll Mode executes only the ACTIVE APPROVED
 * version; new versions are added only through an explicit approval (the engine
 * never edits rules silently). Every version carries a confidence score, status,
 * notes, evidence, and approval date.
 *
 * The existing payroll engine is unchanged: resolveRates() turns the active
 * approved versions into the flat rates list the engine already consumes.
 *
 * Pure, DOM-free, deterministic.
 */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) module.exports = factory();
  else root.RuleLib = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ---- confidence scale (per spec) ----
  // 100 multi-period confirmed · 99 email+payment · 98 email · 95 evidence-but-verify · <95 experimental
  var CONFIDENCE = { MULTI: 100, PAID: 99, EMAIL: 98, EVIDENCE: 95, EXPERIMENTAL: 90 };

  function ruleSet(over) {
    return Object.assign({
      regular_rate_usd: null,
      overnight_rate_usd: null,
      overnight_start: null, // 24h hour the overnight band begins (e.g. 23)
      overnight_end: null, // 24h hour it ends (e.g. 7)
      overnight_merge: "backward", // how Brittco's split overnight tail is re-joined
      normalization: "round_down_whole_hour", // clock-time normalization rule
      special_rules: [],
    }, over || {});
  }

  function version(v, over) {
    return Object.assign({
      version: v,
      status: "approved", // "approved" | "draft" | "unconfigured" | "proposed"
      confidence: 0,
      approvedDate: null,
      approvedBy: null,
      notes: "",
      evidence: [],
      rules: ruleSet(),
    }, over || {});
  }

  // ---- default library is EMPTY: each user adds their own clients ----
  // The app ships with NO client names baked in (privacy + multi-user: everyone
  // has different clients). An admin can seed a setup by importing a starter file.
  function defaultLibrary() {
    return { schema: 1, clients: [] };
  }

  function client(key, name, aliases, versions) {
    return {
      client_key: key,
      client_name: name,
      pdf_aliases: aliases || [],
      activeVersion: versions && versions.length ? versions[versions.length - 1].version : null,
      versions: versions || [],
    };
  }

  // ---- accessors ----
  function getClient(lib, keyOrName) {
    if (!lib || !lib.clients) return null;
    var k = String(keyOrName || "").toLowerCase();
    return lib.clients.filter(function (c) {
      return c.client_key === keyOrName ||
        c.client_name.toLowerCase() === k ||
        (c.pdf_aliases || []).some(function (a) { return a.toLowerCase() === k; });
    })[0] || null;
  }

  function activeVersionOf(c) {
    if (!c) return null;
    return (c.versions || []).filter(function (v) { return v.version === c.activeVersion; })[0] || null;
  }

  function activeRules(c) {
    var v = activeVersionOf(c);
    return v ? v.rules : null;
  }

  function activeConfidence(c) {
    var v = activeVersionOf(c);
    return v ? v.confidence : 0;
  }

  function isApproved(c) {
    var v = activeVersionOf(c);
    return !!(v && v.status === "approved" && typeof v.rules.regular_rate_usd === "number" && v.rules.regular_rate_usd > 0);
  }

  // ---- resolve active approved rules into the engine's flat rates list ----
  function resolveRates(lib) {
    return (lib && lib.clients ? lib.clients : []).map(function (c) {
      var r = activeRules(c) || ruleSet();
      return {
        client_name: c.client_name,
        client_key: c.client_key,
        pdf_aliases: c.pdf_aliases || [],
        regular_rate_usd: r.regular_rate_usd,
        overnight_rate_usd: r.overnight_rate_usd,
        overnight_start: r.overnight_start,
        overnight_end: r.overnight_end,
        special_rules: r.special_rules || [],
      };
    });
  }

  // ---- versioning (never overwrite) ----
  function nextVersion(c) {
    var nums = (c.versions || []).map(function (v) { return v.version; });
    if (!nums.length) return "1.0";
    // bump the minor of the highest version
    var max = nums.sort(cmpVer)[nums.length - 1].split(".");
    return max[0] + "." + (parseInt(max[1], 10) + 1);
  }
  function cmpVer(a, b) {
    var pa = a.split(".").map(Number), pb = b.split(".").map(Number);
    return pa[0] - pb[0] || pa[1] - pb[1];
  }

  // Add a NEW approved version (explicit approval). Returns a new lib (deep-cloned).
  function approveVersion(lib, key, newRules, meta) {
    var out = clone(lib);
    var c = getClient(out, key);
    if (!c) return out;
    var vnum = nextVersion(c);
    c.versions.push(version(vnum, {
      status: "approved",
      confidence: meta && meta.confidence != null ? meta.confidence : CONFIDENCE.EVIDENCE,
      approvedDate: (meta && meta.approvedDate) || new Date().toISOString().slice(0, 10),
      approvedBy: (meta && meta.approvedBy) || "user",
      notes: (meta && meta.notes) || "",
      evidence: (meta && meta.evidence) || [],
      rules: ruleSet(Object.assign({}, activeRules(c) || {}, newRules || {})),
    }));
    c.activeVersion = vnum;
    return out;
  }

  // Add a brand-new client as an UNCONFIGURED draft (no rate yet → engine flags it).
  function addUnconfiguredClient(lib, name, key, aliases) {
    var out = clone(lib);
    if (getClient(out, key) || getClient(out, name)) return out;
    out.clients.push(client(key, name, aliases || [name], [
      version("0.1", { status: "unconfigured", confidence: 0, notes: "Auto-added — your initials appeared on this client. Set a rate to approve v1.0.", rules: ruleSet() }),
    ]));
    return out;
  }

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  return {
    CONFIDENCE: CONFIDENCE,
    ruleSet: ruleSet,
    version: version,
    defaultLibrary: defaultLibrary,
    getClient: getClient,
    activeVersionOf: activeVersionOf,
    activeRules: activeRules,
    activeConfidence: activeConfidence,
    isApproved: isApproved,
    resolveRates: resolveRates,
    nextVersion: nextVersion,
    approveVersion: approveVersion,
    addUnconfiguredClient: addUnconfiguredClient,
  };
});
