/*
 * storage.js — pay-period history + draft persistence
 * ---------------------------------------------------
 * Phase-1 storage strategy (decided with user): localStorage for fast live
 * state, plus JSON export to disk as the durable, portable SOURCE OF TRUTH.
 * A pay-period record carries a RATE SNAPSHOT so reopening an old period
 * reproduces the exact numbers even after rates change later.
 *
 * Pure data layer. Inject a store (defaults to window.localStorage) so the
 * same code is testable in Node and swappable for a real DB in phase-2.
 */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) module.exports = factory();
  else root.Storage = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var KEY = "brittco_payroll_periods_v1";

  // Probe localStorage; some browsers throw on file:// or private mode.
  function safeLocalStorage() {
    try {
      if (typeof localStorage === "undefined") return null;
      var k = "__brittco_probe__";
      localStorage.setItem(k, "1");
      localStorage.removeItem(k);
      return localStorage;
    } catch (e) {
      return null;
    }
  }

  function makeStore(backing) {
    var store = backing || safeLocalStorage() || memoryStore();

    function readAll() {
      try {
        return JSON.parse(store.getItem(KEY) || "[]");
      } catch (e) {
        return [];
      }
    }
    function writeAll(arr) {
      store.setItem(KEY, JSON.stringify(arr));
    }

    return {
      list: function () {
        return readAll().sort(function (a, b) {
          return (b.periodStartISO || "").localeCompare(a.periodStartISO || "");
        });
      },
      get: function (id) {
        return readAll().filter(function (r) { return r.id === id; })[0] || null;
      },
      save: function (record) {
        var all = readAll();
        var idx = all.findIndex(function (r) { return r.id === record.id; });
        record.updatedAt = new Date().toISOString();
        if (idx === -1) {
          record.createdAt = record.createdAt || record.updatedAt;
          all.push(record);
        } else {
          all[idx] = record;
        }
        writeAll(all);
        return record;
      },
      remove: function (id) {
        writeAll(readAll().filter(function (r) { return r.id !== id; }));
      },
      clear: function () { writeAll([]); },
    };
  }

  function memoryStore() {
    var m = {};
    return {
      getItem: function (k) { return k in m ? m[k] : null; },
      setItem: function (k, v) { m[k] = String(v); },
      removeItem: function (k) { delete m[k]; },
    };
  }

  // Build a persistable record (snapshots rates so old periods stay reproducible).
  function buildRecord(params) {
    return {
      id: params.id || "pp_" + (params.periodStartISO || "") + "_" + Date.now(),
      status: params.status || "draft",
      createdAt: params.createdAt || new Date().toISOString(),
      initials: params.initials || "FY",
      periodStartISO: params.periodStartISO,
      periodEndISO: params.periodEndISO,
      paydayISO: params.paydayISO,
      ratesSnapshot: params.ratesSnapshot || [],
      shifts: params.shifts || [],
      reviewSummary: params.reviewSummary || null,
      draft: params.draft || null,
      sourceFiles: params.sourceFiles || [], // [{name,size}] — bytes optional
    };
  }

  function toJSON(record) {
    return JSON.stringify(record, null, 2);
  }

  // Browser-only: trigger a JSON download into the user's folder.
  function download(filename, text) {
    if (typeof document === "undefined") return false;
    var blob = new Blob([text], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    return true;
  }

  return {
    KEY: KEY,
    safeLocalStorage: safeLocalStorage,
    makeStore: makeStore,
    memoryStore: memoryStore,
    buildRecord: buildRecord,
    toJSON: toJSON,
    download: download,
  };
});
