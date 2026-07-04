/*
 * parser.js — Brittco attendance-PDF grid parser (deterministic, coordinate-based)
 * --------------------------------------------------------------------------------
 * Brittco exports a weekly grid: 7 day-columns (Sun..Sat) across, stacked shift
 * blocks down, grouped into client sections. Each shift cell carries:
 *   "1 Clients" / client code / "N Staff" / staff initials / start-time / end-time
 *   (+ optional "Crosses Midnight").
 *
 * We reconstruct the grid from token (x, top) positions — NOT from fragile text
 * flow. The algorithm was validated in Python against the user's 3 real PDFs
 * before being ported here; it reproduces the exact FY shift set.
 *
 * SPLIT DESIGN for testability + phase-2:
 *   - parseFromTokens(pagesTokens, opts)  : PURE. No pdf.js. Unit-testable in Node.
 *   - parsePdfFile(arrayBuffer, opts)     : browser wrapper using window.pdfjsLib.
 *
 * Depends on: Normalize, Rates (optional, for name resolution).
 */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory(require("./normalize.js"));
  } else {
    root.Parser = factory(root.Normalize);
  }
})(typeof self !== "undefined" ? self : this, function (Normalize) {
  "use strict";

  var TIME_RE = /^(\d{1,2}):(\d{2})(am|pm)(-?)$/i;
  var DATE_RE = /^(\d{1,2})\/(\d{1,2})$/;
  var DATE3_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/; // M/D/YY (Review Attendance list)
  var TIMERANGE_RE = /^(\d{1,2}:\d{2}(?:am|pm))-(\d{1,2}:\d{2}(?:am|pm))$/i; // "7:00am-8:00am"
  var REPORT_DATE_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{2})/;
  var INITIAL_RE = /^[A-Z]{2}$/;

  // UI/chrome words that are NOT client headers.
  var STOP = {};
  ["Attendance","Actions","Back","to","Today","Client","Staff","Service","Location",
   "Apply","Filters","HPC","Clients","Crosses","Midnight","Showing","Scheduled",
   "Incomplete","Completed","Missed","of","https"].forEach(function (w) {
    STOP[w.toLowerCase()] = true;
  });

  // ---- column clustering -------------------------------------------------
  // Derive the 7 day-column centers from the x of all time tokens (present in
  // every block, dead-reliable). Robust to minor layout/zoom shifts.
  function deriveColumns(tokens) {
    var xs = tokens.filter(function (t) { return TIME_RE.test(t.text); }).map(function (t) { return t.x; });
    xs.sort(function (a, b) { return a - b; });
    var clusters = [];
    var cur = [];
    for (var i = 0; i < xs.length; i++) {
      if (cur.length && xs[i] - cur[cur.length - 1] > 40) {
        clusters.push(cur); cur = [];
      }
      cur.push(xs[i]);
    }
    if (cur.length) clusters.push(cur);
    var centers = clusters.map(function (c) {
      return c.reduce(function (a, b) { return a + b; }, 0) / c.length;
    });
    return centers;
  }

  function colOf(x, centers, tol) {
    tol = tol || 49;
    var best = -1, bd = Infinity;
    for (var i = 0; i < centers.length; i++) {
      var d = Math.abs(x - centers[i]);
      if (d < bd) { bd = d; best = i; }
    }
    return bd <= tol ? best : -1;
  }

  function isInitial(t) {
    return INITIAL_RE.test(t) && t !== "EC" && t !== "RG";
  }

  // group tokens into horizontal lines by 'top' (gap-based)
  function groupLines(tokens) {
    var sorted = tokens.slice().sort(function (a, b) { return a.top - b.top || a.x - b.x; });
    var lines = [];
    var cur = null;
    sorted.forEach(function (t) {
      if (!cur || Math.abs(t.top - cur.top) > 3) {
        cur = { top: t.top, items: [t] };
        lines.push(cur);
      } else {
        cur.items.push(t);
      }
    });
    lines.forEach(function (l) { l.items.sort(function (a, b) { return a.x - b.x; }); });
    return lines;
  }

  // resolve a header line's tokens to {name, key} via the rates list aliases.
  function resolveHeader(headerTokens, ratesList) {
    var words = headerTokens.map(function (t) { return t.text; });
    var joined = words.join(" ").toLowerCase().replace(/[^a-z ]/g, "");
    var rl = ratesList || [];
    for (var i = 0; i < rl.length; i++) {
      var r = rl[i];
      var aliases = (r.pdf_aliases || []).concat([r.client_name]);
      for (var j = 0; j < aliases.length; j++) {
        var a = String(aliases[j]).toLowerCase().replace(/[^a-z ]/g, "").trim();
        if (a && joined.indexOf(a) !== -1) return { name: r.client_name, key: r.client_key, configured: true };
      }
    }
    // unconfigured client: handle "Last, First" (Brittco style) -> use First name.
    var joinedRaw = words.join(" ");
    var cm = /([A-Za-z]+)\s*,\s*([A-Za-z]+)/.exec(joinedRaw);
    var nm = cm ? cm[2] : (words[0] ? words[0].replace(/[^A-Za-z]/g, "") : "Unknown");
    return { name: nm, key: null, configured: false };
  }

  // detect whether a line is a client-section header
  function headerOf(line, ratesList) {
    var left = line.items.filter(function (t) { return t.x < 170; });
    if (!left.length) return null;
    var first = left[0];
    if (/[\/:]/.test(first.text)) return null; // URLs (https://...), times (1:08), page #s (1/3)
    var w = first.text.replace(/[^A-Za-z]/g, "");
    if (w.length < 3) return null;
    if (STOP[w.toLowerCase()]) return null;
    if (TIME_RE.test(first.text) || DATE_RE.test(first.text)) return null;
    if (/^\d/.test(first.text)) return null;
    return resolveHeader(left, ratesList);
  }

  // ---- main pure parse ---------------------------------------------------
  /*
   * pagesTokens: [ [ {text,x,top}, ... ]  per page ]
   * opts: { ratesList, reportYear, source }
   * returns { shifts:[...], columns, warnings:[...] }
   */
  // Which Brittco export is this? The "Review Attendance" list has a Location +
  // Service + Note column header; the weekly grid does not.
  function detectFormat(tokens) {
    var has = {};
    for (var i = 0; i < tokens.length; i++) has[tokens[i].text] = true;
    if (has["Location"] && has["Service"] && has["Note"]) return "review_list";
    return "grid";
  }

  /*
   * Parse the "Review Attendance" LIST export. Each shift is one row:
   *   Date(M/D/YY) · Staff · Location(=client) · Service   then a time-range line
   *   (+ optional "Crosses Midnight"). The report is already filtered to one staff
   *   member, so every row is that person's shift. Far simpler/sturdier than the grid.
   */
  function parseReviewList(pagesTokens, opts) {
    opts = opts || {};
    var ratesList = opts.ratesList || [];
    var initials = (opts.initials || "FY").toUpperCase();
    var warnings = [];
    var all = [];
    pagesTokens.forEach(function (toks, pi) { toks.forEach(function (t) { all.push({ text: t.text, x: t.x, top: t.top + pi * 100000 }); }); });
    var lines = groupLines(all);
    var shifts = [];

    // Brittco paginates the Review Attendance list ("Showing 1-25 of 29"). Capture
    // the TOTAL so the app can warn when not every page has been uploaded.
    var reportTotal = null;
    lines.forEach(function (L) {
      var j = L.items.map(function (t) { return t.text; }).join(" ");
      var m = /Showing\s*\d+\s*[-–]\s*\d+\s*of\s*(\d+)/i.exec(j);
      if (m) reportTotal = Math.max(reportTotal || 0, +m[1]);
    });

    // Columns vary between Brittco reports (some add a "Group" or "Client(s)"
    // column), so we DETECT columns from the header row instead of hardcoding x's.
    // The client is read from the "Client(s)" column when present, else "Location"
    // — never the "Staff" column (which caused staff names to show as the client).
    function labelOf(t) {
      var s = String(t).replace(/[^A-Za-z]/g, "").toLowerCase();
      if (s.indexOf("date") === 0) return "date";
      if (s.indexOf("group") === 0) return "group";
      if (s.indexOf("client") === 0) return "client";
      if (s.indexOf("staff") === 0) return "staff";
      if (s.indexOf("location") === 0) return "location";
      if (s.indexOf("service") === 0) return "service";
      if (s.indexOf("note") === 0) return "note";
      return null;
    }
    var colX = {};
    for (var h = 0; h < lines.length; h++) {
      var labs = {};
      lines[h].items.forEach(function (it) { var l = labelOf(it.text); if (l && labs[l] == null) labs[l] = it.x; });
      if (labs.date != null && labs.staff != null && (labs.client != null || labs.location != null)) { colX = labs; break; }
    }
    // x-range of the client column = midpoints to its neighbours (robust to shifts)
    function colRange(key) {
      var order = ["date", "group", "client", "staff", "location", "service", "note"];
      var xs = order.filter(function (k) { return colX[k] != null; }).map(function (k) { return { k: k, x: colX[k] }; });
      for (var ci = 0; ci < xs.length; ci++) {
        if (xs[ci].k === key) {
          var left = ci > 0 ? (xs[ci - 1].x + xs[ci].x) / 2 : xs[ci].x - 60;
          var right = ci < xs.length - 1 ? (xs[ci].x + xs[ci + 1].x) / 2 : xs[ci].x + 130;
          return [left, right];
        }
      }
      return null;
    }
    var clientRange = colRange("client") || colRange("location") || [300, 525];
    var staffRange = colRange("staff"); // to read the actual staff name(s) on each shift

    // Each shift is a RECORD spanning from a date row to the next date row (cells
    // wrap onto continuation lines), so gather client tokens across the whole record.
    for (var i = 0; i < lines.length; i++) {
      var first = lines[i].items[0];
      if (!first || first.x > 110) continue;
      var dm = DATE3_RE.exec(first.text);
      if (!dm) continue;
      var recEnd = i + 1;
      while (recEnd < lines.length && !(lines[recEnd].items[0] && lines[recEnd].items[0].x <= 110 && DATE3_RE.test(lines[recEnd].items[0].text))) recEnd++;

      var clientToks = [], staffToks = [], startRaw = null, endRaw = null;
      for (var j = i; j < recEnd; j++) {
        lines[j].items.forEach(function (w) {
          if (w.x >= clientRange[0] && w.x < clientRange[1]) clientToks.push(w);
          if (staffRange && w.x >= staffRange[0] && w.x < staffRange[1]) staffToks.push(w);
        });
        if (!startRaw) {
          var joined = lines[j].items.filter(function (w) { return w.x < 130; }).map(function (w) { return w.text; }).join("");
          var mr = TIMERANGE_RE.exec(joined);
          if (mr) { startRaw = mr[1]; endRaw = mr[2]; }
        }
      }
      if (!startRaw || !clientToks.length) continue;
      var resolved = resolveHeader(clientToks, ratesList);

      // Staff name(s) on the shift — the real text from the Staff column (may list
      // more than one person). Matching to the user is by NAME, done in review.js.
      staffToks.sort(function (a, b) { return a.top - b.top || a.x - b.x; });
      var staffText = staffToks.map(function (w) { return w.text; }).join(" ").replace(/\s+/g, " ").trim();

      var y = 2000 + parseInt(dm[3], 10);
      var dateISO = y + "-" + pad(+dm[1]) + "-" + pad(+dm[2]);
      shifts.push({
        id: (opts.source || "review") + ":" + dateISO + ":" + startRaw + ":" + shifts.length,
        clientName: resolved.name,
        clientKey: resolved.key,
        clientConfigured: resolved.configured,
        dateISO: dateISO,
        startRaw: startRaw,
        endRaw: endRaw,
        staff: staffText ? [staffText] : [initials],
        staffText: staffText || null, // raw Staff-column text; null when unavailable
        staffRaw: staffText ? [staffText] : [initials],
        source: opts.source || null,
        parseFlags: [],
      });
    }
    if (!shifts.length) warnings.push({ level: "review", code: "no_shifts", message: "No shifts parsed from this Review Attendance export." });
    return { shifts: shifts, format: "review_list", columns: [], colDate: {}, warnings: warnings, reportTotal: reportTotal, reportShown: shifts.length };
  }

  function parseFromTokens(pagesTokens, opts) {
    opts = opts || {};
    var ratesList = opts.ratesList || [];
    var warnings = [];

    // dispatch by export format
    var fmtTokens = [];
    pagesTokens.forEach(function (toks) { for (var i = 0; i < toks.length; i++) fmtTokens.push(toks[i]); });
    if (detectFormat(fmtTokens) === "review_list") return parseReviewList(pagesTokens, opts);

    // report year (for assigning a full date to m/d columns)
    var reportYear = opts.reportYear || null;
    var reportMonth = null;
    if (!reportYear) {
      outer: for (var p = 0; p < pagesTokens.length; p++) {
        for (var k = 0; k < pagesTokens[p].length; k++) {
          var m = REPORT_DATE_RE.exec(pagesTokens[p][k].text);
          if (m) { reportMonth = +m[1]; reportYear = 2000 + +m[3]; break outer; }
        }
      }
    }
    reportYear = reportYear || new Date().getFullYear();

    // Unify all pages into ONE coordinate space (offset each page far down) so a
    // shift block that straddles a page break — staff at the bottom of one page,
    // its time at the top of the next — stays contiguous in reading order.
    var PAGE_OFFSET = 100000;
    var allTokens = [];
    pagesTokens.forEach(function (toks, pi) {
      toks.forEach(function (t) { allTokens.push({ text: t.text, x: t.x, top: t.top + pi * PAGE_OFFSET }); });
    });

    var centers = deriveColumns(allTokens.length ? allTokens : flat(pagesTokens));
    if (centers.length < 5) warnings.push({ level: "review", code: "grid_columns", message: "Only " + centers.length + " day-columns detected — layout may be unexpected." });

    // date header from the first page only
    var colDate = {}; // colIndex -> {m,d}
    var lines0 = groupLines(pagesTokens[0] || []);
    for (var li = 0; li < lines0.length; li++) {
      var dts = lines0[li].items.filter(function (t) { return DATE_RE.test(t.text); });
      if (dts.length >= 5) {
        dts.forEach(function (t) {
          var ci = colOf(t.x, centers);
          if (ci !== -1) { var mm = DATE_RE.exec(t.text); colDate[ci] = { m: +mm[1], d: +mm[2] }; }
        });
        break;
      }
    }

    function isoFor(ci) {
      var md = colDate[ci];
      if (!md) return null;
      var y = reportYear;
      if (md.m === 12 && reportMonth && reportMonth <= 2) y = reportYear - 1; // Dec under Jan/Feb report
      return y + "-" + pad(md.m) + "-" + pad(md.d);
    }

    // Staff for a shift = the FIRST initials line ABOVE the start-time in the same
    // column, walking up by SEQUENCE (not pixels) so page breaks/dense rows don't
    // matter. Stop at the previous block's time-token (means this block has no staff).
    function staffFor(lines, yi, ci) {
      for (var u = yi - 1; u >= 0 && u >= yi - 18; u--) {
        var inCol = lines[u].items.filter(function (w) { return colOf(w.x, centers) === ci; });
        if (!inCol.length) continue;
        if (inCol.some(function (w) { return TIME_RE.test(w.text); })) return { staff: [], raw: [] }; // reached previous block
        var inits = inCol.filter(function (w) { return isInitial(w.text); });
        if (inits.length) {
          var alpha = inCol.filter(function (w) { return /[A-Za-z]/.test(w.text) && !TIME_RE.test(w.text); });
          return { staff: inits.map(function (w) { return w.text; }), raw: alpha.map(function (w) { return w.text; }) };
        }
      }
      return { staff: [], raw: [] };
    }

    var shifts = [];
    var section = null;
    var lines = groupLines(allTokens);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var hdr = headerOf(line, ratesList);
      if (hdr) { section = hdr; continue; }

      for (var t2 = 0; t2 < line.items.length; t2++) {
        var tok = line.items[t2];
        var mt = TIME_RE.exec(tok.text);
        if (!mt || mt[4] !== "-") continue; // need trailing '-'
        var ci2 = colOf(tok.x, centers);
        if (ci2 === -1) continue;

        // end time: same column, within next 2 lines below
        var endRaw = null;
        for (var j = i + 1; j < Math.min(i + 3, lines.length); j++) {
          var found = lines[j].items.filter(function (w) {
            var em = TIME_RE.exec(w.text);
            return em && em[4] === "" && colOf(w.x, centers) === ci2;
          })[0];
          if (found) { endRaw = found.text; break; }
        }

        var st = staffFor(lines, i, ci2);
        var staff = st.staff, staffRaw = st.raw;
        var dateISO = isoFor(ci2);
        var startRaw = tok.text.replace(/-$/, "");
        var parseFlags = [];
        if (!endRaw) parseFlags.push({ level: "review", code: "missing_end", message: "Could not read this shift's end time." });
        if (!dateISO) parseFlags.push({ level: "review", code: "missing_date", message: "Could not map this shift to a calendar date." });
        staffRaw.forEach(function (sr) {
          if (!INITIAL_RE.test(sr) && !/^(EC|RG)$/.test(sr)) {
            parseFlags.push({ level: "review", code: "unclear_initials", message: "Hard-to-read staff marking '" + sr + "'." });
          }
        });

        shifts.push({
          id: (opts.source || "pdf") + ":" + (dateISO || "?") + ":" + ci2 + ":" + startRaw + ":" + shifts.length,
          clientName: section ? section.name : "Unknown",
          clientKey: section ? section.key : null,
          clientConfigured: section ? section.configured : false,
          dateISO: dateISO,
          col: ci2,
          startRaw: startRaw,
          endRaw: endRaw,
          staff: staff,
          staffRaw: staffRaw,
          source: opts.source || null,
          parseFlags: parseFlags,
        });
      }
    }

    if (!shifts.length) warnings.push({ level: "review", code: "no_shifts", message: "No shifts parsed — is this a Brittco attendance export?" });
    return { shifts: shifts, columns: centers, colDate: colDate, reportYear: reportYear, warnings: warnings };
  }

  // ---- pdf.js browser wrapper -------------------------------------------
  /*
   * pdf.js getTextContent returns text in tiny per-glyph runs (e.g. "Actions"
   * arrives as "A","c","t","i","ons"; "7:00am-" as several pieces). pdfplumber
   * pre-merges these into words, but pdf.js does not — so we must reassemble
   * fragments into words ourselves before the grid parser can see them.
   *
   * Algorithm: cluster fragments into lines by 'top', sort each line by x, then
   * concatenate adjacent fragments into a word, breaking on a whitespace run or a
   * horizontal gap wider than `gapBreak` points (i.e. a real space / column jump).
   * This reproduces pdfplumber-style words: "CT" and "KK" in one cell stay
   * separate (a space splits them) while "11:00pm-" merges into one token.
   */
  function reconstructWords(items, pageHeight, opts) {
    opts = opts || {};
    var gapBreak = opts.gapBreak != null ? opts.gapBreak : 4; // points
    var frags = [];
    items.forEach(function (it) {
      var str = it.str || "";
      if (str.length === 0) return;
      frags.push({ str: str, x: it.transform[4], top: pageHeight - it.transform[5], w: it.width || 0 });
    });
    frags.sort(function (a, b) { return a.top - b.top || a.x - b.x; });

    // group into lines
    var lines = [], cur = null;
    frags.forEach(function (f) {
      if (!cur || Math.abs(f.top - cur.top) > 3) { cur = { top: f.top, frags: [f] }; lines.push(cur); }
      else cur.frags.push(f);
    });

    var tokens = [];
    lines.forEach(function (line) {
      line.frags.sort(function (a, b) { return a.x - b.x; });
      var word = "", wx = null, prevRight = null;
      function flush() { if (word !== "") tokens.push({ text: word, x: wx, top: line.top }); word = ""; wx = null; }
      line.frags.forEach(function (f) {
        var isSpace = f.str.trim() === "";
        var gap = prevRight == null ? 0 : f.x - prevRight;
        if (isSpace || (prevRight != null && gap > gapBreak)) flush();
        if (!isSpace) { if (word === "") wx = f.x; word += f.str; }
        prevRight = f.x + f.w;
      });
      flush();
    });
    return tokens;
  }

  function extractPageTokens(page) {
    var viewport = page.getViewport({ scale: 1 });
    return page.getTextContent().then(function (tc) {
      return reconstructWords(tc.items, viewport.height);
    });
  }

  function parsePdfFile(arrayBuffer, opts) {
    opts = opts || {};
    var pdfjsLib = opts.pdfjsLib || (typeof window !== "undefined" ? window.pdfjsLib : null);
    if (!pdfjsLib) return Promise.reject(new Error("pdf.js (pdfjsLib) not available"));
    return pdfjsLib.getDocument({ data: arrayBuffer }).promise.then(function (doc) {
      var pageNums = [];
      for (var i = 1; i <= doc.numPages; i++) pageNums.push(i);
      return Promise.all(pageNums.map(function (n) {
        return doc.getPage(n).then(extractPageTokens);
      })).then(function (pagesTokens) {
        return parseFromTokens(pagesTokens, opts);
      });
    });
  }

  function flat(arr) { return [].concat.apply([], arr); }
  function pad(n) { return (n < 10 ? "0" : "") + n; }

  return {
    TIME_RE: TIME_RE,
    deriveColumns: deriveColumns,
    colOf: colOf,
    groupLines: groupLines,
    parseFromTokens: parseFromTokens,
    parseReviewList: parseReviewList,
    detectFormat: detectFormat,
    reconstructWords: reconstructWords,
    extractPageTokens: extractPageTokens,
    parsePdfFile: parsePdfFile,
  };
});
