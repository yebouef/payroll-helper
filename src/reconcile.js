/*
 * reconcile.js — payroll reconciliation + back-pay ledger
 * -------------------------------------------------------
 * Reconciliation compares the CALCULATED total (from approved rules) against the
 * ACTUAL payment. A non-zero discrepancy means the approved rules didn't fully
 * explain the pay → a Rule Discovery candidate (Phase 2) AND/OR a back-pay item.
 *
 * The back-pay ledger formalizes shortfalls: each entry tracks its source period,
 * amount, and status (open → carried → settled). Pure, DOM-free.
 */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) module.exports = factory();
  else root.Reconcile = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function round2(n) { return Math.round(n * 100) / 100; }

  /*
   * Compare calculated vs actual. discrepancy > 0 = underpaid (short);
   * < 0 = overpaid. status: pending | matched | short | over.
   * needsDiscovery: a real discrepancy means approved rules may be incomplete.
   */
  function reconcile(calculatedTotal, actualPaid) {
    if (actualPaid == null || actualPaid === "") {
      return { calculated: round2(calculatedTotal || 0), actualPaid: null, discrepancy: null, status: "pending", needsDiscovery: false };
    }
    var calc = round2(calculatedTotal || 0);
    var paid = round2(+actualPaid);
    var disc = round2(calc - paid);
    var status = Math.abs(disc) < 0.005 ? "matched" : (disc > 0 ? "short" : "over");
    return {
      calculated: calc,
      actualPaid: paid,
      discrepancy: disc,
      status: status,
      needsDiscovery: status !== "matched", // open a Discovery case when pay != calc
    };
  }

  // ---- back-pay ledger ----
  function makeLedgerEntry(params) {
    return {
      id: params.id || "bp_" + (params.sourcePeriodId || "") + "_" + Date.now(),
      sourcePeriodId: params.sourcePeriodId || null,
      sourcePeriodLabel: params.sourcePeriodLabel || "",
      client: params.client || null, // optional per-client attribution
      amount: round2(params.amount || 0),
      status: params.status || "open", // open | carried | settled
      dateRecorded: params.dateRecorded || new Date().toISOString().slice(0, 10),
      note: params.note || "",
    };
  }

  function openEntries(ledger) {
    return (ledger || []).filter(function (e) { return e.status === "open"; });
  }
  function totalOpen(ledger) {
    return round2(openEntries(ledger).reduce(function (s, e) { return s + (e.amount || 0); }, 0));
  }
  function setStatus(ledger, id, status) {
    return (ledger || []).map(function (e) { return e.id === id ? Object.assign({}, e, { status: status }) : e; });
  }
  // record a shortfall (from a reconciliation) as an open ledger entry, deduped by source period
  function recordShortfall(ledger, params) {
    ledger = (ledger || []).slice();
    var existing = ledger.filter(function (e) { return e.sourcePeriodId === params.sourcePeriodId && e.status !== "settled"; })[0];
    if (existing) { existing.amount = round2(params.amount); return ledger; }
    ledger.push(makeLedgerEntry(params));
    return ledger;
  }

  return {
    round2: round2,
    reconcile: reconcile,
    makeLedgerEntry: makeLedgerEntry,
    openEntries: openEntries,
    totalOpen: totalOpen,
    setStatus: setStatus,
    recordShortfall: recordShortfall,
  };
});
