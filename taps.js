/* iTap board: in-page board backed by her private Google Sheet.
   Google enforces access: the browser gets a short-lived OAuth token for her
   account and calls the Sheets API directly. Nothing is cached to disk except
   the token (sessionStorage, under 1 hour). Patient data only lives in memory. */
(function () {
  "use strict";
  var CFG = window.TAPS_CONFIG || {};
  var SCOPE = "https://www.googleapis.com/auth/spreadsheets";
  var DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
  var ITEM_COLS = ["patient","case","plan","appt","reason","bar","section","buttons","pills","patientId","open_label","updated","approved","mfg_eta","ups","ups_eta","star","count","req_date","due","shipped","delivered","scan_date","cc_ready","review"];
  var API = "https://sheets.googleapis.com/v4/spreadsheets/";
  var TOKEN_KEY = "jg-taps-token-v1";
  var CID_KEY = "jg-taps-client-id";
  var PLAN_URL = "https://vip.invisalign.com/v3/auth/patient/patientFile.action?patientId=";
  var LIST_URL = "https://vip.invisalign.com/v3/auth/patients.action";

  var filterEl = null;
  var overlay, body, statusEl, tokenClient = null, pendingAfterToken = [];
  var items = [], answers = [], pollTimer = null, editing = {};
  var openState = {}, cardOpen = {}, localSection = {};
  var addOpen = false, addDraft = { patient: "", appt: "", note: "" };

  function clientId() { return CFG.clientId || localStorage.getItem(CID_KEY) || ""; }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /* CSS.escape is missing on some older iPad Safari / WebViews. */
  function cssEsc(s) {
    s = String(s);
    if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(s);
    return s.replace(/[^a-zA-Z0-9_-]/g, function (ch) {
      var hex = ch.charCodeAt(0).toString(16).toUpperCase();
      return "\\" + hex + " ";
    });
  }

  /* ---------- token ---------- */
  function savedToken() {
    try {
      var t = JSON.parse(sessionStorage.getItem(TOKEN_KEY) || "null");
      if (t && t.exp > Date.now() + 60000) return t.access;
    } catch (e) {}
    return null;
  }
  function storeToken(resp) {
    var exp = Date.now() + (Number(resp.expires_in || 3599) * 1000);
    var sc = resp.scope || (tokenClient && tokenClient._withDrive ? (SCOPE + " " + DRIVE_SCOPE) : SCOPE);
    sessionStorage.setItem(TOKEN_KEY, JSON.stringify({ access: resp.access_token, exp: exp, scope: sc }));
  }
  function hasDriveScope() {
    try {
      var t = JSON.parse(sessionStorage.getItem(TOKEN_KEY) || "null");
      return !!(t && t.scope && t.scope.indexOf(DRIVE_SCOPE) >= 0);
    } catch (e) { return false; }
  }
  function dropToken() { sessionStorage.removeItem(TOKEN_KEY); }

  function initTokenClient(withDrive) {
    if (!clientId() || !(window.google && google.accounts && google.accounts.oauth2)) return !!tokenClient;
    if (tokenClient && (!withDrive || tokenClient._withDrive)) return true;
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: clientId(),
      scope: withDrive ? (SCOPE + " " + DRIVE_SCOPE) : SCOPE,
      login_hint: CFG.account,
      callback: function (resp) {
        var cbs = pendingAfterToken; pendingAfterToken = [];
        if (resp && resp.access_token) {
          storeToken(resp);
          cbs.forEach(function (cb) { cb(null); });
        } else {
          cbs.forEach(function (cb) { cb(resp || { error: "no_token" }); });
        }
      },
      error_callback: function (err) {
        var cbs = pendingAfterToken; pendingAfterToken = [];
        cbs.forEach(function (cb) { cb(err || { type: "popup_failed" }); });
      }
    });
    tokenClient._withDrive = !!withDrive;
    return true;
  }

  /* Must be called inside a tap/click so Safari allows Google's popup.
     withDrive requests drive.file incrementally; regular taps never add it. */
  function withToken(cb, forceChooser, withDrive) {
    if (!forceChooser && savedToken() && (!withDrive || hasDriveScope())) { cb(null); return; }
    if (!initTokenClient(!!withDrive)) { cb({ type: "gis_not_ready" }); return; }
    pendingAfterToken.push(cb);
    tokenClient.requestAccessToken({ prompt: forceChooser ? "select_account" : "" });
  }

  /* ---------- Sheets API ---------- */
  function api(path, opts) {
    var tok = savedToken();
    if (!tok) return Promise.reject({ status: 401 });
    opts = opts || {};
    opts.headers = Object.assign({ Authorization: "Bearer " + tok }, opts.headers || {});
    /* Reads (GET) retry twice on Google 5xx/429 with backoff (1s, 3s). Writes never retry, so no duplicate rows. */
    var isRead = !opts.method || String(opts.method).toUpperCase() === "GET";
    var waits = isRead ? [1000, 3000] : [];
    function attempt(n) {
      return fetch(API + encodeURIComponent(CFG.sheetId) + path, opts).then(function (r) {
        if (r.ok) return r.json();
        if ((r.status >= 500 || r.status === 429) && n < waits.length) {
          return new Promise(function (res) { setTimeout(res, waits[n]); }).then(function () { return attempt(n + 1); });
        }
        return r.text().then(function (t) { throw { status: r.status, text: t }; });
      });
    }
    return attempt(0);
  }

  function rowsToObjects(values) {
    if (!values || !values.length) return [];
    if (!values[0] || typeof values[0].map !== "function") throw new Error("Unexpected sheet response");
    var head = values[0].map(function (h) { return String(h).trim(); });
    return values.slice(1).filter(function (r) { return r.some(function (c) { return String(c).trim() !== ""; }); })
      .map(function (r, i) {
        var o = { _row: i + 2 };
        head.forEach(function (h, j) { o[h] = r[j] == null ? "" : String(r[j]); });
        return o;
      });
  }

  var lastChecked = null;
  function batchGetPath(a, b) {
    return "/values:batchGet?ranges=" + encodeURIComponent(a) + "&ranges=" + encodeURIComponent(b) + "&majorDimension=ROWS";
  }
  /* Prefer A1:AB so staff note columns Z–AB are included. If that range 400s
     (grid smaller than column AB, or a tab-name parse error), retry the
     whole Items and Answers tabs, which stay in-grid. */
  function load() {
    return api(batchGetPath("Items!A1:AB", "Answers!A1:F")).catch(function (err) {
      if (err && err.status === 400) return api(batchGetPath("Items", "Answers"));
      throw err;
    }).then(function (d) {
      var vr = d.valueRanges || [];
      items = rowsToObjects(vr[0] && vr[0].values);
      answers = rowsToObjects(vr[1] && vr[1].values);
      lastChecked = new Date();
      render();
    });
  }

  function appendAnswer(it, choice, note) {
    var ts = new Date().toISOString();
    note = note || "";
    var local = { case: it.case, patient: it.patient, choice: choice, ts: ts, status: "pending", note: note, _local: true };
    answers.push(local);
    var key = cardKey(it);
    delete editing[key];
    delete modifyDraft[key];
    if (choice === ORDER) localSection[key] = "tap";
    render();
    var payload = { values: [[it.case, it.patient, choice, ts, "pending", note]] };
    return api("/values/" + encodeURIComponent("Answers!A:F") + ":append?valueInputOption=RAW&insertDataOption=INSERT_ROWS", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }).then(function () {
      local._local = false; local._saved = true; render();
    }).catch(function (err) {
      answers.splice(answers.indexOf(local), 1);
      handleError(err, "Your tap did not save. Tap it again.");
      render();
    });
  }

  /* ---------- state ---------- */
  function latestAnswer(it) {
    var best = null;
    var caseId = String(it.case || "").trim();
    var patient = String(it.patient || "").trim();
    answers.forEach(function (a) {
      if (caseId) {
        if (String(a.case || "").trim() !== caseId) return;
      } else {
        if (String(a.case || "").trim()) return;
        if (String(a.patient || "").trim() !== patient) return;
      }
      var at = Date.parse(a.ts) || 0, ut = Date.parse(it.updated) || 0;
      if (ut && at && at < ut && !a._local) return; // answer predates the item's latest version
      if (!best || at > (Date.parse(best.ts) || 0)) best = a;
    });
    return best;
  }

  /* Align star colors, in sort/filter order. Edit this one list to change them. */
  var STAR_COLORS = ['purple','green','blue','red']; // any other/blank value = unlabeled (gray outline star)
  var HIDDEN_BUTTONS = /^(full check|hold)$/i; // never rendered, even if the feed lists them
  /* Only these buttons render (matched case-insensitively; "Modify" counts as "Modify request"). */
  var ALLOWED_BUTTONS = ["Approve", "Modify request", "Staff resubmit", "Call for appointment"];
  var MODIFY = "Modify request";
  var modifyDraft = {}; // cardKey -> { text, choice } while a note box is open
  var noteOpen = {}; // cardKey -> { type, text } while the staff-note form is open
  var ORDER = "Order Invisalign";
  var MARKUP_FOLDER = "Tap Board Markups";
  function cardKey(it) {
    var c = String(it.case || "").trim();
    if (c) return "c:" + c;
    return "p:" + String(it.patient || "") + ":" + (it._row || "");
  }
  function allowedButton(label) {
    var t = String(label || "").trim().toLowerCase().replace(/\s+/g, " ");
    if (HIDDEN_BUTTONS.test(t)) return null;
    if (t === "modify") t = "modify request";
    for (var i = 0; i < ALLOWED_BUTTONS.length; i++) if (ALLOWED_BUTTONS[i].toLowerCase() === t) return ALLOWED_BUTTONS[i];
    return null;
  }
  /* Appt like "Fri 11/20", "11/23", "12/7 RUSH", "Thu 11/19 5:45 PM" -> "F 11/20" etc.
     The weekday comes from the calendar date itself (UTC noon, so no zone can shift the day);
     the year is the one that puts the date nearest to today in America/New_York. */
  var DOW = ["U", "M", "T", "W", "R", "F", "S"];
  function nyToday() {
    var p = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "numeric", day: "numeric" }).formatToParts(new Date());
    var o = {}; p.forEach(function (x) { o[x.type] = Number(x.value); });
    return Date.UTC(o.year, o.month - 1, o.day, 12);
  }
  /* 12-hour clock like "2:00 PM". */
  function fmtClock(h, min) {
    h = Number(h); min = Number(min) || 0;
    if (isNaN(h) || h < 0 || h > 23 || min < 0 || min > 59) return "";
    var am = h < 12, h12 = h % 12;
    if (h12 === 0) h12 = 12;
    return h12 + ":" + (min < 10 ? "0" + min : String(min)) + " " + (am ? "AM" : "PM");
  }
  /* Pull a leading time out of a trailing string. "2:00 PM", "2 PM", "14:00", "14:00:00". */
  function pullTime(s) {
    s = String(s || "").trim();
    if (!s) return { time: "", rest: "" };
    var m = s.match(/^T?(\d{1,2})(?::(\d{2})(?::\d{2}(?:\.\d+)?)?)?\s*(AM|PM)?\b\s*(.*)$/i);
    if (!m) return { time: "", rest: s };
    var h = Number(m[1]), min = m[2] != null ? Number(m[2]) : 0, ap = (m[3] || "").toUpperCase();
    if (!ap && m[2] == null) return { time: "", rest: s }; // bare hour is not a time
    if (ap) {
      if (h < 1 || h > 12) return { time: "", rest: s };
      if (ap === "AM") { if (h === 12) h = 0; }
      else if (h !== 12) h += 12;
    } else if (h > 23) return { time: "", rest: s };
    return { time: fmtClock(h, min), rest: (m[4] || "").trim() };
  }
  /* Parse "Fri 11/20", "11/30 2:00 PM", "Mon 11/30 2:00 PM", "2026-11-30 14:00", "12/7 RUSH".
     Weekday is computed from the date (M T W R F S U). Year is inferred when missing. */
  function parseMD(raw) {
    try { return parseMDInner(raw); } catch (e) { try { console.error("iTap board parseMD", e); } catch (e2) {} return null; }
  }
  function parseMDInner(raw) {
    var str = String(raw || "").trim();
    if (!str) return null;
    var time = "", rest = "";
    var iso = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s](.+))?$/);
    if (iso) {
      var tail = iso[4] || "";
      if (/Z|[+-]\d{2}:?\d{2}$/.test(tail)) {
        var dtz = new Date(str);
        if (!isNaN(dtz.getTime())) {
          var parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true }).formatToParts(dtz);
          var o = {}; parts.forEach(function (x) { o[x.type] = x.value; });
          var moZ = Number(o.month), dZ = Number(o.day), yZ = Number(o.year);
          var tZ = Date.UTC(yZ, moZ - 1, dZ, 12);
          var period = String(o.dayPeriod || "").replace(/\./g, "").replace(/\s/g, "").toUpperCase();
          if (period === "A") period = "AM"; if (period === "P") period = "PM";
          return { t: tZ, mo: moZ, d: dZ, yr: "", rest: "", time: tail ? (o.hour + ":" + o.minute + (period ? " " + period : "")) : "", dow: DOW[new Date(tZ).getUTCDay()] };
        }
      }
      str = Number(iso[2]) + "/" + Number(iso[3]) + "/" + iso[1] + (tail ? " " + tail : "");
    }
    var m = str.match(/^(?:[A-Za-z]{2,9}\.?,?\s+)?(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b\s*(.*)$/);
    if (!m) return null;
    var mo = Number(m[1]), d = Number(m[2]), y = m[3] ? Number(m[3]) : null;
    if (y != null && y < 100) y += 2000;
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    var pulled = pullTime(m[4] || "");
    time = pulled.time; rest = pulled.rest;
    var t;
    if (y == null) {
      var today = nyToday(), yr = new Date(today).getUTCFullYear(), best = null;
      [yr - 1, yr, yr + 1].forEach(function (yy) {
        var c = Date.UTC(yy, mo - 1, d, 12);
        if (best == null || Math.abs(c - today) < Math.abs(best - today)) best = c;
      });
      t = best;
    } else t = Date.UTC(y, mo - 1, d, 12);
    var dt = new Date(t);
    if (dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null; // e.g. 2/30
    return { t: t, mo: mo, d: d, yr: "", rest: rest, time: time, dow: DOW[dt.getUTCDay()] };
  }
  /* Plain date for fixed card lines: parseable -> M/D; unparseable as-is. Date only, no time. */
  function fmtDate(raw) {
    var v = String(raw || "").trim();
    if (!v) return "";
    var p = parseMD(v);
    return p ? p.mo + "/" + p.d : v;
  }
  /* Date+time: keep a time when the value has one. ISO timestamps with a zone render in America/New_York. */
  function fmtDateTime(raw) {
    var v = String(raw || "").trim();
    if (!v) return "";
    var p = parseMD(v);
    if (!p) return v;
    return p.mo + "/" + p.d + (p.time ? " " + p.time : "");
  }
  function pickedLabel(choice) {
    if (String(choice || "").trim().toLowerCase() === "call for appointment") return "Sent to manager";
    return "Picked: " + choice;
  }
  /* "M 11/30 2:00 PM" or "M 11/30" when there is no time. Unparseable values are shown raw. */
  function apptLabel(raw) {
    var p = parseMD(raw);
    if (!p) return String(raw || "").trim();
    return p.dow + " " + p.mo + "/" + p.d + (p.time ? " " + p.time : "") + (p.rest ? " " + p.rest : "");
  }
  /* Shipped line date: "W 11/18". Unparseable values are shown raw. */
  function dayDate(raw) {
    var p = parseMD(raw);
    if (!p) return String(raw || "").trim();
    return p.dow + " " + p.mo + "/" + p.d;
  }
  function dueLabel(due) {
    var v = String(due || "").trim();
    if (!v) return "dd";
    return "dd " + (fmtDate(v) || v);
  }
  /* Sort date: the appt, or `due` when there's no appt; Infinity = no date (sorts last). */
  function sortDate(it) {
    var p = String(it.appt || "").trim() ? parseMD(it.appt) : parseMD(it.due);
    return p ? p.t : Infinity;
  }
  /* Manufacturing sort: parse approved as M/D or M/D/YYYY. Yearless values use the current America/New_York year. Blank or unparseable -> Infinity (after dated rows). */
  function approvedSortTime(it) {
    var str = String(it.approved || "").trim();
    if (!str) return Infinity;
    var p = parseMD(str);
    if (!p) return Infinity;
    var hasYear = /^\d{4}-\d{1,2}-\d{1,2}/.test(str) || /(?:^|[^\d])\d{1,2}\/\d{1,2}\/\d{2,4}\b/.test(str);
    if (!hasYear) {
      var yr = new Date(nyToday()).getUTCFullYear();
      return Date.UTC(yr, p.mo - 1, p.d, 12);
    }
    return p.t;
  }
  function hasDelivered(it) {
    return String(it.delivered || "").trim() !== "";
  }
  function deliveredSortTime(it) {
    var p = parseMD(it.delivered);
    return p ? p.t : 0;
  }
  var starFilter = "all"; // "all", a color, or "none" (cards with no star)
  /* Align star color from the `star` column; old feeds: bar=purple or a "PURPLE STAR" pill. */
  function starColor(it) {
    var c = String(it.star || "").trim().toLowerCase();
    if (STAR_COLORS.indexOf(c) >= 0) return c;
    if (it.bar === "purple" || split(it.pills).some(function (p) { return /PURPLE STAR/i.test(p); })) return "purple";
    return "";
  }
  function sectionOf(it) {
    var v = String(it.section || "").trim().toLowerCase();
    if (v === "done") v = "manufacturing";
    if (v === "not_urgent") v = "tap"; // Low priority section removed: these are regular taps now
    if (v !== "scan" && v !== "in_progress" && v !== "manufacturing" && v !== "shipped") v = "tap";
    var key = cardKey(it);
    if (localSection[key]) {
      if (v !== "scan") delete localSection[key];
      else return localSection[key];
    }
    return v;
  }
  /* Shipped cards drop off when today (America/New_York) is more than 7 days after `delivered`.
     Delivered dates are in the past, so a yearless date resolves to the most recent such date. */
  function deliveredLongAgo(it, todayNY) {
    var p = parseMD(it.delivered);
    if (!p) return false;
    var t = p.t;
    if (!p.yr && t > todayNY + 86400000) t = Date.UTC(new Date(t).getUTCFullYear() - 1, p.mo - 1, p.d, 12);
    return (todayNY - t) / 86400000 > 7;
  }
  function upsUrl(n) { return "https://www.ups.com/track?tracknum=" + encodeURIComponent(n); }

  function split(s) { return String(s || "").split("|").map(function (x) { return x.trim(); }).filter(Boolean); }

  /* ---------- UI ---------- */
  function setStatus(msg, tone) {
    statusEl.textContent = msg || "";
    statusEl.className = "taps-status" + (tone ? " " + tone : "");
  }

  /* Status-line detail only: HTTP status + Google error.message, or e.name/e.message.
     Never dump response bodies or cell values (those can contain PHI). */
  function googleMessage(text) {
    if (text == null || text === "") return "";
    try {
      var j = typeof text === "string" ? JSON.parse(text) : text;
      var m = j && j.error && j.error.message;
      if (m) return String(m).replace(/\s+/g, " ").trim().slice(0, 180);
    } catch (e) {}
    return "";
  }
  function describeError(err) {
    if (!err) return "";
    if (typeof err.status === "number") {
      var g = googleMessage(err.text);
      return "Google " + err.status + (g ? ": " + g : "");
    }
    var n = err.name ? String(err.name) : "";
    var m = err.message != null ? String(err.message).replace(/\s+/g, " ").trim().slice(0, 180) : "";
    if (n && m) return n + ": " + m;
    return n || m;
  }
  function handleError(err, fallback) {
    try { console.error("iTap board", err); } catch (e) {}
    var s = err && err.status;
    if (s === 401) { dropToken(); setStatus("Google sign-in expired. Tap any button to unlock again.", "warn"); return; }
    if (s === 403 || s === 404) {
      dropToken();
      showGate("wrong", "This Google account can't open the iTap board. Use " + CFG.account + ".");
      return;
    }
    var base = fallback || "Couldn't reach Google. Check the connection and try again.";
    var detail = describeError(err);
    setStatus(detail ? base + " " + detail : base, "warn");
  }


  var NOTE_TYPES = ["Late", "Away dates", "Other"];
  function staffNoteType(it) { return String(it.staff_note_type || "").trim(); }
  function staffNoteText(it) { return String(it.staff_note || "").trim(); }
  function hasStaffNote(it) { return !!(staffNoteType(it) || staffNoteText(it)); }
  function staffNoteKind(type) {
    var t = String(type || "").trim().toLowerCase();
    if (t === "late") return "late";
    if (t === "away dates" || t === "away" || t === "vacation") return "away";
    return "other";
  }
  function staffNotePillLabel(type, text) {
    var label = type || "Note";
    if (text) {
      var short = text.length > 28 ? text.slice(0, 27) + "\u2026" : text;
      return label + " \u00b7 " + short;
    }
    return label;
  }
  /* Locate the Items row by the board's _row index, confirmed by patient + case. */
  function findItemRow(it) {
    var patient = String(it.patient || "").trim();
    var caseId = String(it.case || "").trim();
    var matches = items.filter(function (x) {
      return String(x.patient || "").trim() === patient && String(x.case || "").trim() === caseId;
    });
    if (matches.length === 1 && matches[0]._row) return Number(matches[0]._row);
    if (it._row) {
      var self = matches.filter(function (x) { return Number(x._row) === Number(it._row); });
      if (self.length === 1) return Number(it._row);
    }
    return 0;
  }
  function saveStaffNote(it, type, text) {
    type = String(type || "").trim();
    text = String(text || "").trim();
    if (!type && text) type = "Other";
    if (!type && !text) { type = ""; text = ""; }
    var rowNum = findItemRow(it);
    if (!rowNum) return Promise.reject({ status: 0, text: "missing-row" });
    var ts = (type || text) ? new Date().toISOString() : "";
    var key = cardKey(it);
    var prev = { type: it.staff_note_type, text: it.staff_note, ts: it.staff_note_updated };
    it.staff_note_type = type;
    it.staff_note = text;
    it.staff_note_updated = ts;
    delete noteOpen[key];
    render();
    var range = "Items!Z" + rowNum + ":AB" + rowNum;
    return api("/values/" + encodeURIComponent(range) + "?valueInputOption=RAW", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ values: [[type, text, ts]] })
    }).then(function () {
      setStatus("Staff note saved");
    }).catch(function (err) {
      it.staff_note_type = prev.type;
      it.staff_note = prev.text;
      it.staff_note_updated = prev.ts;
      noteOpen[key] = { type: type, text: text };
      render();
      handleError(err, "The staff note did not save. Try again.");
    });
  }
  function staffNoteBox(it) {
    var key = cardKey(it);
    var draft = noteOpen[key] || { type: staffNoteType(it) || "Late", text: staffNoteText(it) };
    if (!draft.type) draft.type = "Late";
    var f = el("div", "tap-staff-note");
    f.appendChild(el("div", "tap-staff-note-label", "Staff note"));
    var rowEl = el("div", "tap-staff-note-row");
    var sel = document.createElement("select");
    sel.className = "tap-staff-note-type";
    sel.setAttribute("aria-label", "Staff note type");
    NOTE_TYPES.forEach(function (t) {
      var o = document.createElement("option");
      o.value = t; o.textContent = t;
      if (t === draft.type) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener("change", function () { if (noteOpen[key]) noteOpen[key].type = sel.value; });
    var inp = el("input", "tap-add-input tap-staff-note-text");
    inp.type = "text";
    inp.placeholder = "Time, dates, or a short note";
    inp.value = draft.text || "";
    inp.dataset.key = key;
    inp.dataset.keep = "staff-note";
    inp.setAttribute("aria-label", "Staff note");
    inp.addEventListener("input", function () { if (noteOpen[key]) noteOpen[key].text = inp.value; });
    var save = el("button", "tap-btn primary", "Save");
    save.type = "button";
    save.addEventListener("click", function () {
      withToken(function (err) {
        if (err) { handleError({ status: 0 }, "Google sign-in didn't finish. Tap Save again."); return; }
        save.disabled = true;
        saveStaffNote(it, sel.value, inp.value).then(function () { save.disabled = false; }, function () { save.disabled = false; });
      });
    });
    rowEl.appendChild(sel); rowEl.appendChild(inp); rowEl.appendChild(save);
    if (hasStaffNote(it)) {
      var clear = el("button", "tap-btn", "Clear");
      clear.type = "button";
      clear.addEventListener("click", function () {
        withToken(function (err) {
          if (err) { handleError({ status: 0 }, "Google sign-in didn't finish. Tap Clear again."); return; }
          saveStaffNote(it, "", "");
        });
      });
      rowEl.appendChild(clear);
    }
    var cancel = el("button", "tap-btn", "Cancel");
    cancel.type = "button";
    cancel.addEventListener("click", function () { delete noteOpen[key]; render(); });
    rowEl.appendChild(cancel);
    f.appendChild(rowEl);
    return f;
  }
  function openStaffNote(it) {
    var key = cardKey(it);
    noteOpen[key] = { type: staffNoteType(it) || "Late", text: staffNoteText(it) };
    cardOpen[key] = true;
    render();
    var box = body.querySelector('.tap-staff-note-text[data-key="' + cssEsc(key) + '"]');
    if (box) box.focus();
  }

  function row(it) {
    var key = cardKey(it);
    var ans = latestAnswer(it);
    var answered = !!ans && !editing[key];
    var sec = sectionOf(it);
    var mfg = sec === "manufacturing", shipped = sec === "shipped", scan = sec === "scan";
    var bar = (answered || mfg || shipped) ? "done" : (it.bar || "wait");
    var isOpen = !!cardOpen[key] || modifyDraft[key] != null;
    var card = el("article", "tap-row bar-" + bar + (answered ? " answered" : "") + (isOpen ? " open" : ""));
    card.dataset.key = key;
    card.appendChild(el("div", "tap-bar"));
    var main = el("div", "tap-main");

    var top = el("div", "tap-top");
    top.setAttribute("role", "button");
    top.tabIndex = 0;
    top.setAttribute("aria-expanded", isOpen ? "true" : "false");
    var chev = el("span", "tap-chevron", "\u25B8");
    chev.setAttribute("aria-hidden", "true");
    top.appendChild(chev);
    top.appendChild(el("span", "tap-name", it.patient));
    var pills = split(it.pills);
    var sc = starColor(it);
    var star = el("span", "tap-star star-" + (sc || "none"), sc ? "\u2605" : "\u2606");
    star.setAttribute("aria-label", sc ? sc + " star" : "no star"); star.title = sc ? sc + " star" : "no star";
    top.appendChild(star);
    var appt = String(it.appt || "").trim(), due = String(it.due || "").trim();
    /* Every card shows an appt tag, a due tag, or a red No date flag next to the star. */
    if (appt) {
      top.appendChild(el("span", "tap-when", apptLabel(appt).replace(pills.some(function (p) { return /^RUSH$/i.test(p.trim()); }) ? /\s*\bRUSH\b/i : /$^/, "")));
    } else if (due) {
      top.appendChild(el("span", "tap-when dd", dueLabel(due)));
    } else {
      top.appendChild(el("span", "tap-when no-date", "No date"));
    }
    pills.filter(function (p) { return !/PURPLE STAR/i.test(p); }).forEach(function (p) {
      var cls = /RUSH/i.test(p) ? "pill stop" : /PRIORITY/i.test(p) ? "pill purple" : /DONE/i.test(p) ? "pill done" : "pill";
      top.appendChild(el("span", cls, p));
    });
    if (sec === "tap" && String(it.review || "").trim().toLowerCase() === "not_reviewed") {
      top.appendChild(el("span", "pill review", "Not yet reviewed"));
    }
    if (hasStaffNote(it)) {
      var nt = staffNoteType(it), ntxt = staffNoteText(it);
      var notePill = el("span", "pill staff-note staff-" + staffNoteKind(nt), staffNotePillLabel(nt, ntxt));
      notePill.title = [nt, ntxt].filter(Boolean).join(": ") || "Staff note";
      notePill.setAttribute("role", "button");
      notePill.tabIndex = 0;
      notePill.setAttribute("aria-label", "Edit staff note");
      function openNote(e) { e.preventDefault(); e.stopPropagation(); openStaffNote(it); }
      notePill.addEventListener("click", openNote);
      notePill.addEventListener("keydown", function (e) {
        if (e.key !== "Enter" && e.key !== " ") return;
        openNote(e);
      });
      top.appendChild(notePill);
    }
    top.addEventListener("click", function () {
      if (modifyDraft[key] != null) return;
      cardOpen[key] = !isOpen;
      render();
    });
    top.addEventListener("keydown", function (e) {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      if (modifyDraft[key] != null) return;
      cardOpen[key] = !isOpen;
      render();
    });
    main.appendChild(top);

    var wrap = el("div", "tap-body");
    function addLine(label, fill) {
      var d = el("div", "tap-line");
      if (label) d.appendChild(el("span", "tap-line-label", label + " "));
      fill(d);
      wrap.appendChild(d);
      return d;
    }
    function dateOrDash(raw) {
      return fmtDate(raw) || "\u2014";
    }
    /* Every card lists Scan and Approved; a blank value shows an em dash. */
    function addScanApproved() {
      addLine("Scan", function (d) { d.appendChild(el("span", "tap-line-value", dateOrDash(it.scan_date))); });
      addLine("Approved", function (d) { d.appendChild(el("span", "tap-line-value", dateOrDash(it.approved))); });
    }
    function upsLink(parent, ups) {
      var uw = el("span", null, "UPS ");
      var u = el("a", "tap-ups", ups); u.href = upsUrl(ups); u.target = "_blank"; u.rel = "noopener noreferrer";
      uw.appendChild(u); parent.appendChild(uw);
    }

    var meta = [];
    var cnt = String(it.count || "").trim();
    if (it.plan) meta.push("Plan " + it.plan + (cnt ? ": " + cnt : ""));
    var req = String(it.req_date || "").trim();

    if (scan) {
      addScanApproved();
      if (it.reason) wrap.appendChild(el("div", "tap-reason", it.reason));
    } else if (shipped) {
      addScanApproved();
      if (appt) addLine("Appt", function (d) { d.appendChild(el("span", "tap-line-value", apptLabel(it.appt))); });
      var shpRaw = String(it.shipped || "").trim();
      var ups = String(it.ups || "").trim();
      if (shpRaw) addLine("Shipped", function (d) { d.appendChild(el("span", "tap-line-value", dayDate(it.shipped))); });
      var dlv = fmtDateTime(it.delivered), etaRaw = String(it.ups_eta || "").trim();
      if (dlv) {
        var box = el("div", "tap-delivered-box");
        box.appendChild(el("span", "tap-delivered-flag", "DELIVERED"));
        box.appendChild(el("span", "tap-line-value", dlv));
        if (ups) upsLink(box, ups);
        wrap.appendChild(box);
      } else if (etaRaw || ups) {
        var eta = el("div", "tap-eta-line");
        if (etaRaw) eta.appendChild(el("span", "tap-line-value", "ETA " + etaRaw));
        if (etaRaw && ups) eta.appendChild(document.createTextNode(" \u00b7 "));
        if (ups) upsLink(eta, ups);
        wrap.appendChild(eta);
      }
      if (it.reason) wrap.appendChild(el("div", "tap-reason", (req ? req + ": " : "") + it.reason));
      if (meta.length) wrap.appendChild(el("div", "tap-meta", meta.join(" \u00b7 ")));
    } else if (mfg) {
      addScanApproved();
      if (appt) addLine("Appt", function (d) { d.appendChild(el("span", null, apptLabel(it.appt))); });
      var mfgEta = fmtDate(it.mfg_eta);
      if (mfgEta) addLine("Manufacturing:", function (d) { d.appendChild(el("span", null, "Mfg ETA " + mfgEta)); });
      var shpM = fmtDate(it.shipped), upsM = String(it.ups || "").trim(), dlvM = fmtDateTime(it.delivered), etaM = String(it.ups_eta || "").trim();
      if (!shpM && !upsM && !dlvM && !etaM) {
        addLine("Shipping:", function (d) { d.appendChild(el("span", null, "Not shipped yet")); });
      } else {
        addLine("Shipping:", function (d) {
          var parts = [];
          if (shpM) parts.push(el("span", null, "Shipped " + shpM));
          if (upsM) {
            var hold = el("span", null);
            upsLink(hold, upsM);
            parts.push(hold);
          }
          if (dlvM) parts.push(el("span", "pill done tap-delivered", "Delivered " + dlvM));
          else if (etaM) parts.push(el("span", null, "ETA " + etaM));
          else if (shpM || upsM) parts.push(el("span", null, "In transit"));
          parts.forEach(function (n, i) { if (i) d.appendChild(document.createTextNode(" \u00b7 ")); d.appendChild(n); });
        });
      }
      if (it.reason) wrap.appendChild(el("div", "tap-reason", (req ? req + ": " : "") + it.reason));
      if (meta.length) wrap.appendChild(el("div", "tap-meta", meta.join(" \u00b7 ")));
    } else {
      addScanApproved();
      var ready = fmtDate(it.cc_ready);
      if (ready) wrap.appendChild(el("div", "tap-cc-ready", "ClinCheck ready " + ready));
      if (meta.length) wrap.appendChild(el("div", "tap-meta", meta.join(" \u00b7 ")));
      if (it.reason) wrap.appendChild(el("div", "tap-reason", (req ? req + ": " : "") + it.reason));
    }

    var acts = el("div", "tap-acts");
    if (answered) {
      var st = String(ans.status || "pending").toLowerCase();
      var pend = el("span", "pill tap-pending " + (st === "confirmed" ? "ok" : ""), st === "confirmed" ? "confirmed" : (ans._local ? "saving\u2026" : "pending"));
      top.appendChild(pend);
      if (ans.note && st !== "confirmed") wrap.appendChild(el("div", "tap-note-shown", "Note: " + ans.note));
      var mark = el("span", "tap-picked", pickedLabel(ans.choice));
      if (st !== "confirmed") {
        mark.appendChild(document.createTextNode(" \u00b7 "));
        var ch = el("button", "tap-link", "change");
        ch.type = "button";
        ch.addEventListener("click", function (e) { e.stopPropagation(); editing[key] = true; cardOpen[key] = true; render(); });
        mark.appendChild(ch);
      }
      acts.appendChild(mark);
    } else if (scan) {
      var ob = el("button", "tap-btn primary", ORDER);
      ob.type = "button";
      if (modifyDraft[key] && modifyDraft[key].choice === ORDER) ob.classList.add("active");
      ob.addEventListener("click", function () {
        if (modifyDraft[key] == null) modifyDraft[key] = { text: "", choice: ORDER };
        cardOpen[key] = true;
        render();
        var box = body.querySelector('.tap-note-input[data-key="' + cssEsc(key) + '"]');
        if (box) box.focus();
      });
      acts.appendChild(ob);
    } else {
      var seen = {};
      split(it.buttons).map(allowedButton).filter(function (c) { if (!c || seen[c]) return false; seen[c] = 1; return true; }).forEach(function (choice) {
        var b = el("button", "tap-btn primary", choice);
        b.type = "button";
        if (choice === MODIFY) {
          if (modifyDraft[key] != null) b.classList.add("active");
          b.addEventListener("click", function () {
            if (modifyDraft[key] == null) modifyDraft[key] = { text: "", choice: MODIFY };
            cardOpen[key] = true;
            render();
            var box = body.querySelector('.tap-note-input[data-key="' + cssEsc(key) + '"]');
            if (box) box.focus();
          });
        } else {
          b.addEventListener("click", function () {
            withToken(function (err) {
              if (err) { handleError({ status: 0 }, "Google sign-in didn't finish. Tap again."); return; }
              appendAnswer(it, choice, "");
            });
          });
        }
        acts.appendChild(b);
      });
    }
    if (!scan) {
      var a = el("a", "tap-btn primary tap-open", it.open_label || "Open plan");
      a.href = it.patientId ? PLAN_URL + encodeURIComponent(it.patientId) : LIST_URL;
      a.target = "_blank"; a.rel = "noopener noreferrer";
      acts.appendChild(a);
    }
    wrap.appendChild(acts);
    if (!noteOpen[key] && !hasStaffNote(it)) {
      var noteLink = el("button", "tap-link", "Note");
      noteLink.type = "button";
      noteLink.title = "Add a staff note";
      noteLink.setAttribute("aria-label", "Add a staff note");
      noteLink.addEventListener("click", function (e) { e.stopPropagation(); openStaffNote(it); });
      acts.appendChild(noteLink);
    } else if (!noteOpen[key] && hasStaffNote(it)) {
      var editNote = el("button", "tap-link", "Edit note");
      editNote.type = "button";
      editNote.setAttribute("aria-label", "Edit staff note");
      editNote.addEventListener("click", function (e) { e.stopPropagation(); openStaffNote(it); });
      acts.appendChild(editNote);
    }
    if (!answered && modifyDraft[key] != null) wrap.appendChild(modifyBox(it));
    if (noteOpen[key]) wrap.appendChild(staffNoteBox(it));
    main.appendChild(wrap);
    card.appendChild(main);
    return card;
  }

  function modifyBox(it) {
    var key = cardKey(it);
    var draft = modifyDraft[key] || { text: "", choice: MODIFY };
    var choice = draft.choice || MODIFY;
    var f = el("form", "tap-modify");
    var ta = el("textarea", "tap-note-input");
    ta.rows = 3;
    ta.placeholder = choice === ORDER ? "Note (optional)" : "What should Align change?";
    ta.value = draft.text || "";
    ta.dataset.key = key; ta.setAttribute("aria-label", choice === ORDER ? "Order Invisalign note" : "Modify request note");
    var row2 = el("div", "tap-modify-btns");
    var send = el("button", "tap-btn primary", "Send"); send.type = "submit";
    var cancel = el("button", "tap-btn primary", "Cancel"); cancel.type = "button";
    var sync = function () {
      modifyDraft[key] = { text: ta.value, choice: choice };
      if (choice === MODIFY) send.disabled = !ta.value.trim();
      else send.disabled = false;
    };
    ta.addEventListener("input", sync); sync();
    cancel.addEventListener("click", function () { delete modifyDraft[key]; render(); });
    f.addEventListener("submit", function (e) {
      e.preventDefault();
      var note = ta.value.trim();
      if (choice === MODIFY && !note) { ta.focus(); return; }
      withToken(function (err) {
        if (err) { handleError({ status: 0 }, "Google sign-in didn't finish. Tap Send again."); return; }
        appendAnswer(it, choice, note);
      });
    });
    row2.appendChild(send); row2.appendChild(cancel);
    f.appendChild(ta); f.appendChild(row2);
    return f;
  }

  function stopHeaderToggle(e) { e.preventDefault(); e.stopPropagation(); }

  function addPatientForm() {
    var f = el("form", "tap-add-form");
    f.addEventListener("click", function (e) { e.stopPropagation(); });
    var name = el("input", "tap-add-input"); name.type = "text"; name.required = true;
    name.placeholder = "Patient name"; name.setAttribute("aria-label", "Patient name");
    name.dataset.keep = "add-patient"; name.value = addDraft.patient || "";
    var apptIn = el("input", "tap-add-input"); apptIn.type = "text";
    apptIn.placeholder = "Appt date (optional)"; apptIn.setAttribute("aria-label", "Appointment date");
    apptIn.dataset.keep = "add-appt"; apptIn.value = addDraft.appt || "";
    var note = el("textarea", "tap-add-input tap-note-input"); note.rows = 2;
    note.placeholder = "Note (optional)"; note.setAttribute("aria-label", "Note");
    note.dataset.keep = "add-note"; note.value = addDraft.note || "";
    function sync() { addDraft = { patient: name.value, appt: apptIn.value, note: note.value }; }
    name.addEventListener("input", sync); apptIn.addEventListener("input", sync); note.addEventListener("input", sync);
    var btns = el("div", "tap-modify-btns");
    var save = el("button", "tap-btn primary", "Save"); save.type = "submit";
    var cancel = el("button", "tap-btn primary", "Cancel"); cancel.type = "button";
    cancel.addEventListener("click", function () {
      addOpen = false; addDraft = { patient: "", appt: "", note: "" }; render();
    });
    f.addEventListener("submit", function (e) {
      e.preventDefault();
      var patient = name.value.trim();
      if (!patient) { name.focus(); return; }
      addDraft = { patient: patient, appt: apptIn.value.trim(), note: note.value.trim() };
      withToken(function (err) {
        if (err) { handleError({ status: 0 }, "Google sign-in didn't finish. Tap Save again."); return; }
        savePatient();
      });
    });
    btns.appendChild(save); btns.appendChild(cancel);
    f.appendChild(name); f.appendChild(apptIn); f.appendChild(note); f.appendChild(btns);
    return f;
  }

  function savePatient() {
    var fields = { patient: addDraft.patient, appt: addDraft.appt, reason: addDraft.note, section: "scan", updated: new Date().toISOString() };
    var rowVals = ITEM_COLS.map(function (h) { return fields[h] != null ? fields[h] : ""; });
    return api("/values/" + encodeURIComponent("Items!A:Y") + ":append?valueInputOption=RAW&insertDataOption=INSERT_ROWS", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ values: [rowVals] })
    }).then(function () {
      addOpen = false; addDraft = { patient: "", appt: "", note: "" };
      openState.scan = true;
      return load();
    }).catch(function (err) {
      handleError(err, "The new patient did not save. Try again.");
    });
  }

  function group(title, list, open, key, countLabel) {
    var d = el("details", "tap-group");
    if (key) d.dataset.key = key;
    if (open) d.open = true;
    var s = el("summary", null);
    s.appendChild(el("span", null, title));
    s.appendChild(el("span", "count", countLabel != null ? String(countLabel) : String(list.length)));
    if (key === "scan") {
      var add = el("button", "tap-add-btn", "+ Add patient");
      add.type = "button";
      add.addEventListener("pointerdown", stopHeaderToggle);
      add.addEventListener("click", function (e) {
        stopHeaderToggle(e);
        openState.scan = true;
        d.open = true;
        addOpen = true;
        render();
        var inp = body.querySelector('.tap-add-input[data-keep="add-patient"]');
        if (inp) inp.focus();
      });
      s.appendChild(add);
    }
    d.appendChild(s);
    if (key === "scan" && addOpen) d.appendChild(addPatientForm());
    if (!list.length && !(key === "scan" && addOpen)) d.appendChild(el("p", "tap-empty", "Nothing here."));
    list.forEach(function (it) { d.appendChild(row(it)); });
    return d;
  }

  function renderFilter() {
    if (!filterEl) return;
    filterEl.textContent = "";
    if (!items.length) { filterEl.hidden = true; return; } // locked / setup screens
    var colors = STAR_COLORS.concat(["none"]); // always all four colors, then the unlabeled outline star
    filterEl.hidden = false;
    colors.forEach(function (c) {
      var b = el("button", "taps-star-btn star-" + c + (starFilter === c ? " active" : ""), c === "none" ? "\u2606" : "\u2605");
      b.type = "button";
      var label = c === "none" ? "no star" : c + " star";
      b.title = "Show " + label + " cards"; b.setAttribute("aria-label", "Filter: " + label);
      b.setAttribute("aria-pressed", starFilter === c ? "true" : "false");
      b.addEventListener("click", function () { starFilter = starFilter === c ? "all" : c; render(); });
      filterEl.appendChild(b);
    });
  }

  function render() {
    if (!body) return;
    var ae = document.activeElement, keep = null;
    if (ae && ae.classList && (ae.classList.contains("tap-note-input") || ae.classList.contains("tap-add-input") || (ae.dataset && ae.dataset.keep))) {
      keep = { k: ae.dataset.key || ae.dataset.keep, s: ae.selectionStart, e: ae.selectionEnd };
    }
    renderFilter();
    body.querySelectorAll("details.tap-group").forEach(function (d) { openState[d.dataset.key] = d.open; });
    body.textContent = "";
    var bySec = { scan: [], tap: [], in_progress: [], manufacturing: [], shipped: [] };
    var todayNY = nyToday();
    items.forEach(function (it) {
      var sec = sectionOf(it);
      if (sec === "shipped" && deliveredLongAgo(it, todayNY)) return; // gone 7+ days after delivery
      (bySec[sec] || bySec.tap).push(it);
    });
    /* Shipped S/D badge: after the 7-day hide, BEFORE the star filter (preferred). */
    var shippedS = bySec.shipped.length;
    var shippedD = bySec.shipped.filter(function (it) { return String(it.delivered || "").trim() !== ""; }).length;
    var shippedBadge = shippedS + "/" + shippedD;
    var open = bySec.tap.filter(function (it) { return !latestAnswer(it); }).length;
    var rank = { stop: 0, wait: 1, go: 2, done: 3 };
    function starRank(it) { var i = STAR_COLORS.indexOf(starColor(it)); return i < 0 ? STAR_COLORS.length : i; }
    function barRank(it) { return rank[it.bar] == null ? 4 : rank[it.bar]; }
    Object.keys(bySec).forEach(function (k) {
      if (starFilter !== "all") bySec[k] = bySec[k].filter(function (it) { return (starColor(it) || "none") === starFilter; });
      bySec[k] = bySec[k].map(function (it, i) { return { it: it, i: i }; }).sort(function (a, b) {
        var x = a.it, y = b.it, tie = a.i - b.i;
        if (k === "manufacturing") {
          var apx = approvedSortTime(x), apy = approvedSortTime(y);
          var ad = apx === apy ? 0 : (apx === Infinity ? 1 : apy === Infinity ? -1 : apx - apy);
          return ad || tie;
        }
        var ax = latestAnswer(x) ? 1 : 0, ay = latestAnswer(y) ? 1 : 0;
        var dx = sortDate(x), dy = sortDate(y);
        var dd = dx === dy ? 0 : (dx === Infinity ? 1 : dy === Infinity ? -1 : dx - dy);
        var base = ax - ay || starRank(x) - starRank(y) || dd || barRank(x) - barRank(y);
        if (k === "shipped") {
          var xd = hasDelivered(x) ? 0 : 1, yd = hasDelivered(y) ? 0 : 1;
          if (xd !== yd) return xd - yd;
          if (xd === 0) {
            var dtx = deliveredSortTime(x), dty = deliveredSortTime(y);
            if (dtx !== dty) return dty - dtx;
          }
        }
        return base || tie;
      }).map(function (o) { return o.it; });
    });
    var sections = [
      ["scan", "MyiTero", bySec.scan, false, null],
      ["tap", "Needs a tap", bySec.tap, false, null],
      ["in_progress", "ClinCheck", bySec.in_progress, false, null],
      ["manufacturing", "Manufacturing", bySec.manufacturing, false, null],
      ["shipped", "Shipped/Delivered", bySec.shipped, false, shippedBadge]
    ];
    sections.forEach(function (s) {
      if (s[0] === "in_progress" && !s[2].length) return;
      var g = group(s[1], s[2], openState[s[0]] != null ? openState[s[0]] : s[3], s[0], s[4]);
      body.appendChild(g);
    });
    var newest = items.reduce(function (m, it) { var t = Date.parse(it.updated) || 0; return t > m ? t : m; }, 0);
    var when = newest ? new Date(newest).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
    var chk = lastChecked ? lastChecked.toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }) : "";
    setStatus(open + " waiting on you" + (when ? " \u00b7 list as of " + when + " ET" : "") + (chk ? " \u00b7 checked " + chk : ""));
    if (keep) {
      var box = body.querySelector('[data-key="' + cssEsc(String(keep.k)) + '"], [data-keep="' + cssEsc(String(keep.k)) + '"]');
      if (box) { box.focus(); try { if (box.setSelectionRange) box.setSelectionRange(keep.s, keep.e); } catch (e) {} }
    }
  }

  function showGate(kind, msg) {
    stopPoll();
    items = []; answers = [];
    body.textContent = "";
    renderFilter();
    var g = el("div", "tap-gate");
    if (kind === "setup") {
      g.appendChild(el("h3", null, "Not connected yet"));
      g.appendChild(el("p", null, "The board is built. It needs Greenie's one-time Google setup step, then it lights up here."));
      var f = el("form", "tap-cid");
      var inp = el("input"); inp.placeholder = "Paste Client ID (\u2026apps.googleusercontent.com)"; inp.autocomplete = "off";
      var go = el("button", "tap-btn primary", "Connect"); go.type = "submit";
      f.appendChild(inp); f.appendChild(go);
      f.addEventListener("submit", function (e) {
        e.preventDefault();
        var v = inp.value.trim();
        if (!/\.apps\.googleusercontent\.com$/.test(v)) { setStatus("That doesn't look like a Client ID.", "warn"); return; }
        localStorage.setItem(CID_KEY, v); tokenClient = null; unlock(false);
      });
      g.appendChild(f);
      setStatus("Waiting on setup", "warn");
    } else {
      g.appendChild(el("h3", null, kind === "wrong" ? "Wrong Google account" : "Locked"));
      g.appendChild(el("p", null, msg || ("Unlock with " + CFG.account + ". Google checks the login; patient names never leave Google until you do.")));
      var b = el("button", "tap-btn primary", kind === "wrong" ? "Choose account" : "Unlock with Google");
      b.type = "button";
      b.addEventListener("click", function () { unlock(kind === "wrong"); });
      g.appendChild(b);
      setStatus(kind === "wrong" ? "Access denied by Google" : "Locked", "warn");
    }
    body.appendChild(g);
  }

  function startPoll() {
    stopPoll();
    pollTimer = setInterval(function () {
      if (document.hidden || !overlay.classList.contains("open") || !savedToken()) return;
      load().catch(function (e) { if (e && e.status) handleError(e); });
    }, (CFG.pollSeconds || 30) * 1000);
  }
  function stopPoll() { if (pollTimer) clearInterval(pollTimer); pollTimer = null; }

  function unlock(chooser) {
    if (!clientId()) { showGate("setup"); return; }
    setStatus("Unlocking\u2026");
    withToken(function (err) {
      if (err) { showGate("locked", "Google sign-in didn't finish (popup closed or blocked). Tap Unlock to try again."); return; }
      setStatus("Loading\u2026");
      load().then(startPoll).catch(function (e) { handleError(e); });
    }, chooser);
  }

  /* ---------- overlay ---------- */
  /* ---------- markup ---------- */
  var markupEl = null, markupBusy = false;

  function loadHtml2Canvas() {
    return new Promise(function (resolve, reject) {
      if (window.html2canvas) { resolve(window.html2canvas); return; }
      var s = document.createElement("script");
      s.src = "html2canvas.min.js?v=20261119h";
      s.onload = function () { window.html2canvas ? resolve(window.html2canvas) : reject(new Error("html2canvas missing")); };
      s.onerror = function () { reject(new Error("Could not load capture library")); };
      document.head.appendChild(s);
    });
  }

  function nyStamp(d) {
    var parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(d);
    var o = {}; parts.forEach(function (x) { o[x.type] = x.value; });
    return o.year + o.month + o.day + "-" + o.hour + o.minute + o.second;
  }

  function driveFetch(url, opts) {
    var tok = savedToken();
    if (!tok) return Promise.reject({ status: 401 });
    opts = opts || {};
    opts.headers = Object.assign({ Authorization: "Bearer " + tok }, opts.headers || {});
    return fetch(url, opts).then(function (r) {
      if (r.ok) return r.json();
      return r.text().then(function (t) { throw { status: r.status, text: t }; });
    });
  }

  function findOrCreateMarkupFolder() {
    var q = "name = '" + MARKUP_FOLDER + "' and mimeType = 'application/vnd.google-apps.folder' and trashed = false";
    var url = "https://www.googleapis.com/drive/v3/files?q=" + encodeURIComponent(q) + "&fields=files(id,name)&pageSize=5&spaces=drive";
    return driveFetch(url).then(function (d) {
      if (d.files && d.files[0]) return d.files[0].id;
      return driveFetch("https://www.googleapis.com/drive/v3/files?fields=id,name", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: MARKUP_FOLDER, mimeType: "application/vnd.google-apps.folder" })
      }).then(function (f) { return f.id; });
    });
  }

  function uploadMarkupPng(blob, folderId) {
    var name = "markup-" + nyStamp(new Date()) + ".png";
    var meta = JSON.stringify({ name: name, parents: [folderId] });
    var boundary = "taps_markup_" + Date.now();
    return blob.arrayBuffer().then(function (buf) {
      var enc = new TextEncoder();
      var metaPart = enc.encode("--" + boundary + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" + meta + "\r\n");
      var head = enc.encode("--" + boundary + "\r\nContent-Type: image/png\r\n\r\n");
      var tail = enc.encode("\r\n--" + boundary + "--");
      var file = new Uint8Array(buf);
      var all = new Uint8Array(metaPart.length + head.length + file.length + tail.length);
      all.set(metaPart, 0); all.set(head, metaPart.length); all.set(file, metaPart.length + head.length); all.set(tail, metaPart.length + head.length + file.length);
      return driveFetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink,name", {
        method: "POST",
        headers: { "Content-Type": "multipart/related; boundary=" + boundary },
        body: all
      });
    });
  }

  function closeMarkup() {
    if (markupDockResize) {
      window.removeEventListener("resize", markupDockResize);
      window.removeEventListener("orientationchange", markupDockResize);
      markupDockResize = null;
    }
    if (!markupEl) return;
    if (markupEl.parentNode) markupEl.parentNode.removeChild(markupEl);
    markupEl = null;
    markupBusy = false;
    markupApi = null;
  }

  function canvasToPngBlob(canvas) {
    return new Promise(function (resolve, reject) {
      if (canvas.toBlob) canvas.toBlob(function (b) { b ? resolve(b) : reject(new Error("png")); }, "image/png");
      else {
        try {
          var bin = atob(canvas.toDataURL("image/png").split(",")[1]), arr = new Uint8Array(bin.length);
          for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
          resolve(new Blob([arr], { type: "image/png" }));
        } catch (e) { reject(e); }
      }
    });
  }

  var MARKUP_PREFS_KEY = "itap-markup-prefs-v1";
  var MARKUP_DOCK_POS_KEY = "itap-markup-toolbar-pos-v1";
  var markupDockResize = null;
  function loadDockFrac() {
    try {
      var p = JSON.parse(localStorage.getItem(MARKUP_DOCK_POS_KEY) || "null");
      if (p && isFinite(p.x) && isFinite(p.y)) return { x: Number(p.x), y: Number(p.y) };
    } catch (e) {}
    return null;
  }
  function saveDockFrac(p) {
    try { localStorage.setItem(MARKUP_DOCK_POS_KEY, JSON.stringify({ x: p.x, y: p.y })); } catch (e) {}
  }
  function clearDockFrac() {
    try { localStorage.removeItem(MARKUP_DOCK_POS_KEY); } catch (e) {}
  }
  var MARKUP_COLORS = [
    "#FFFFFF", "#D5D8D6", "#8A8F8C", "#001219", "#5C4033", "#C4A484", "#FF8BA0", "#D8452F",
    "#FF6B4A", "#EE9B00", "#FFD84D", "#F4E3B2", "#B7E4C7", "#2A9D8F", "#6E9A4E", "#0A9396",
    "#94D2BD", "#CAFFBF", "#7DD3FC", "#1F7A9E", "#3F6E9A", "#6B4E8F", "#7B4FE0", "#E0A6FF"
  ];
  var PEN_WIDTHS = [3, 6, 11];
  var HI_WIDTHS = [16, 26, 40];
  var RUB_WIDTH = 28;
  var STAFF_NAMES = ["Tati", "Sarah", "Kiara", "Jess", "Trish", "Eric", "Destinee", "Dr. Grace", "Dr. Rana"];
  var markupApi = null;

  function markupDefaultPrefs() {
    return { pen: { color: "#D8452F", widthIndex: 1 }, highlight: { color: "#FFD84D", widthIndex: 1 }, eraseMode: "stroke" };
  }
  function markupKnownColor(c) {
    var i, hex = String(c || "").toUpperCase();
    for (i = 0; i < MARKUP_COLORS.length; i++) if (MARKUP_COLORS[i].toUpperCase() === hex) return MARKUP_COLORS[i];
    return "";
  }
  function loadMarkupPrefs() {
    var d = markupDefaultPrefs(), raw, p;
    try { raw = localStorage.getItem(MARKUP_PREFS_KEY); } catch (e) { return d; }
    if (!raw) return d;
    try { p = JSON.parse(raw); } catch (e2) { return d; }
    if (!p || typeof p !== "object") return d;
    if (p.pen && markupKnownColor(p.pen.color)) d.pen.color = markupKnownColor(p.pen.color);
    if (p.pen && p.pen.widthIndex >= 0 && p.pen.widthIndex <= 2) d.pen.widthIndex = p.pen.widthIndex | 0;
    if (p.highlight && markupKnownColor(p.highlight.color)) d.highlight.color = markupKnownColor(p.highlight.color);
    if (p.highlight && p.highlight.widthIndex >= 0 && p.highlight.widthIndex <= 2) d.highlight.widthIndex = p.highlight.widthIndex | 0;
    if (p.eraseMode === "rub" || p.eraseMode === "stroke") d.eraseMode = p.eraseMode;
    return d;
  }
  function saveMarkupPrefs(p) {
    try { localStorage.setItem(MARKUP_PREFS_KEY, JSON.stringify(p)); } catch (e) {}
  }

  function hideClosedTapGroups(doc) {
    var root = doc || document;
    var nodes = root.querySelectorAll("details.tap-group:not([open])");
    Array.prototype.forEach.call(nodes, function (d) {
      Array.prototype.forEach.call(d.children, function (ch) {
        if (ch.tagName !== "SUMMARY") ch.style.display = "none";
      });
    });
  }

  function distToSeg(p, a, b) {
    var dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy, t = 0;
    if (len2 > 0) t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
    var x = a.x + t * dx, y = a.y + t * dy, ex = p.x - x, ey = p.y - y;
    return Math.sqrt(ex * ex + ey * ey);
  }
  function colorWithAlpha(hex, a) {
    var h = String(hex || "").replace("#", "");
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (h.length !== 6) return "rgba(255,216,77," + a + ")";
    var r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
    return "rgba(" + r + "," + g + "," + b + "," + a + ")";
  }
  function stampUnit(srcW) { return Math.max(0.75, srcW / 1000); }

  function getStampRect(st, srcW) {
    var u = stampUnit(srcW), kind = st.kind, label = st.label || "";
    if (kind === "call" || kind === "tap" || kind === "staff") {
      var text = kind === "staff" ? label : (kind === "call" ? "CALL" : "TAP");
      var w = Math.max(52, 12 * u * 0.62 * text.length + 28 * u);
      var h = 28 * u;
      return { x: st.x - w / 2, y: st.y - h / 2, w: w, h: h };
    }
    var s = 32 * u;
    return { x: st.x - s, y: st.y - s, w: s * 2, h: s * 2 };
  }

  function drawStamp(ctx, st, srcW) {
    var u = stampUnit(srcW), kind = st.kind, x = st.x, y = st.y, r = 16 * u;
    ctx.save();
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    if (kind === "check" || kind === "x" || kind === "question") {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = kind === "check" ? "#2A9D8F" : (kind === "x" ? "#D8452F" : "#FFD84D");
      ctx.fill();
      if (kind === "check") {
        ctx.strokeStyle = "#FFFFFF"; ctx.lineWidth = 2.6 * u;
        ctx.beginPath(); ctx.moveTo(x - 6.2 * u, y + 0.4 * u); ctx.lineTo(x - 2 * u, y + 4.6 * u); ctx.lineTo(x + 7.2 * u, y - 5.4 * u); ctx.stroke();
      } else if (kind === "x") {
        ctx.strokeStyle = "#FFFFFF"; ctx.lineWidth = 2.6 * u;
        ctx.beginPath(); ctx.moveTo(x - 5.6 * u, y - 5.6 * u); ctx.lineTo(x + 5.6 * u, y + 5.6 * u);
        ctx.moveTo(x + 5.6 * u, y - 5.6 * u); ctx.lineTo(x - 5.6 * u, y + 5.6 * u); ctx.stroke();
      } else {
        ctx.fillStyle = "#1a1a1a";
        ctx.font = "800 " + Math.round(18 * u) + "px Figtree, sans-serif";
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText("?", x, y + 0.5 * u);
      }
    } else if (kind === "star") {
      var i, n = 5, ro = 16 * u, ri = 6.5 * u;
      ctx.beginPath();
      for (i = 0; i < n * 2; i++) {
        var ang = -Math.PI / 2 + i * Math.PI / n, rad = i % 2 === 0 ? ro : ri;
        var px = x + Math.cos(ang) * rad, py = y + Math.sin(ang) * rad;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath(); ctx.fillStyle = "#EE9B00"; ctx.fill();
    } else if (kind === "arrow") {
      ctx.strokeStyle = "#E9F5F2"; ctx.lineWidth = 2.6 * u;
      ctx.beginPath(); ctx.moveTo(x - 16 * u, y); ctx.lineTo(x + 14 * u, y);
      ctx.moveTo(x + 4 * u, y - 8 * u); ctx.lineTo(x + 16 * u, y); ctx.lineTo(x + 4 * u, y + 8 * u); ctx.stroke();
    } else if (kind === "call" || kind === "tap" || kind === "staff") {
      var text = kind === "staff" ? String(st.label || "") : (kind === "call" ? "CALL" : "TAP");
      var box = getStampRect(st, srcW);
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(box.x, box.y, box.w, box.h, box.h / 2);
      else {
        var rr = box.h / 2;
        ctx.moveTo(box.x + rr, box.y); ctx.arcTo(box.x + box.w, box.y, box.x + box.w, box.y + box.h, rr);
        ctx.arcTo(box.x + box.w, box.y + box.h, box.x, box.y + box.h, rr);
        ctx.arcTo(box.x, box.y + box.h, box.x, box.y, rr); ctx.arcTo(box.x, box.y, box.x + box.w, box.y, rr);
      }
      ctx.fillStyle = kind === "call" ? "#EE9B00" : (kind === "tap" ? "#2A9D8F" : "#6B4E8F");
      ctx.fill();
      ctx.fillStyle = kind === "staff" ? "#FFFFFF" : "#001219";
      ctx.font = "800 " + Math.round(12 * u) + "px Figtree, sans-serif";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(text, x, y + 0.4 * u);
    }
    ctx.restore();
  }

  function drawStrokePath(ctx, st) {
    if (!st.points || !st.points.length) return;
    ctx.save();
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.lineWidth = st.width;
    if (st.mode === "rub") {
      ctx.globalCompositeOperation = "destination-out";
      ctx.strokeStyle = "rgba(0,0,0,1)";
    } else if (st.mode === "highlight") {
      ctx.globalCompositeOperation = "source-over";
      ctx.strokeStyle = colorWithAlpha(st.color, 0.52);
    } else {
      ctx.globalCompositeOperation = "source-over";
      ctx.strokeStyle = st.color;
    }
    ctx.beginPath();
    ctx.moveTo(st.points[0].x, st.points[0].y);
    var i;
    for (i = 1; i < st.points.length; i++) ctx.lineTo(st.points[i].x, st.points[i].y);
    if (st.points.length === 1) ctx.lineTo(st.points[0].x + 0.1, st.points[0].y);
    ctx.stroke();
    ctx.restore();
  }

  function hitObject(obj, p, srcW) {
    var i, slop, box;
    if (obj.type === "stamp") {
      box = getStampRect(obj, srcW);
      return p.x >= box.x && p.x <= box.x + box.w && p.y >= box.y && p.y <= box.y + box.h;
    }
    if (obj.type === "stroke" && obj.points && obj.points.length) {
      slop = (obj.width || 4) / 2 + 8;
      if (obj.points.length === 1) {
        var dx = p.x - obj.points[0].x, dy = p.y - obj.points[0].y;
        return Math.sqrt(dx * dx + dy * dy) <= slop;
      }
      for (i = 1; i < obj.points.length; i++) {
        if (distToSeg(p, obj.points[i - 1], obj.points[i]) <= slop) return true;
      }
    }
    return false;
  }

  function svgIcon(html, w) {
    w = w || 26;
    return '<svg width="' + w + '" height="' + w + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + html + "</svg>";
  }

  function openMarkupOverlay(imageCanvas) {
    closeMarkup();
    var prefs = loadMarkupPrefs();
    var tool = "pen";
    var eraseMode = prefs.eraseMode;
    var penColor = prefs.pen.color, penW = prefs.pen.widthIndex;
    var hiColor = prefs.highlight.color, hiW = prefs.highlight.widthIndex;
    var objects = [];
    var redoStack = [];
    var current = null, activePtr = null, activeType = "";
    var armedStamp = null, staffName = "";
    var openTray = "";
    var srcW = imageCanvas.width, srcH = imageCanvas.height;

    var wrap = el("div", "taps-markup");
    wrap.setAttribute("role", "dialog");
    wrap.setAttribute("aria-label", "Markup");

    var chrome = el("div", "taps-markup-chrome");
    var chromeLeft = el("div", "taps-markup-chrome-left");
    var chromeTitle = el("div", "taps-markup-chrome-title", "Markup");
    var stage = el("div", "taps-markup-stage");
    var layers = el("div", "taps-markup-layers");

    var boardCv = document.createElement("canvas");
    boardCv.className = "taps-markup-board";
    boardCv.width = srcW; boardCv.height = srcH;
    boardCv.setAttribute("aria-hidden", "true");
    var boardCtx = boardCv.getContext("2d");
    if (boardCtx) boardCtx.drawImage(imageCanvas, 0, 0);

    var inkCv = document.createElement("canvas");
    inkCv.className = "taps-markup-canvas";
    inkCv.width = srcW; inkCv.height = srcH;
    inkCv.setAttribute("aria-label", "Drawing area");
    var inkCtx = inkCv.getContext("2d");

    function persist() {
      saveMarkupPrefs({
        pen: { color: penColor, widthIndex: penW },
        highlight: { color: hiColor, widthIndex: hiW },
        eraseMode: eraseMode
      });
    }
    function commit(obj) {
      objects.push(obj);
      redoStack = [];
      redraw();
      syncChrome();
    }
    function redraw() {
      if (!inkCtx) return;
      inkCtx.clearRect(0, 0, srcW, srcH);
      objects.forEach(function (obj) {
        if (obj.type === "stroke") drawStrokePath(inkCtx, obj);
        else if (obj.type === "stamp") drawStamp(inkCtx, obj, srcW);
      });
    }
    function flattenCanvas() {
      var out = document.createElement("canvas");
      out.width = srcW; out.height = srcH;
      var ctx = out.getContext("2d");
      if (ctx) {
        if (boardCv) ctx.drawImage(boardCv, 0, 0);
        if (inkCv) ctx.drawImage(inkCv, 0, 0);
      }
      return out;
    }
    function pt(e, target) {
      var r = (target || inkCv).getBoundingClientRect();
      var rw = r.width || 1, rh = r.height || 1;
      return { x: (e.clientX - r.left) * (srcW / rw), y: (e.clientY - r.top) * (srcH / rh) };
    }
    function currentStyle() {
      if (tool === "highlight") return { mode: "highlight", color: hiColor, width: HI_WIDTHS[hiW] };
      if (tool === "erase" && eraseMode === "rub") return { mode: "rub", color: "#000000", width: RUB_WIDTH };
      return { mode: "pen", color: penColor, width: PEN_WIDTHS[penW] };
    }

    function undo() {
      if (current) return;
      if (!objects.length) return;
      redoStack.push(objects.pop());
      redraw(); syncChrome();
    }
    function redo() {
      if (current) return;
      if (!redoStack.length) return;
      objects.push(redoStack.pop());
      redraw(); syncChrome();
    }
    function clearAll() {
      if (!objects.length) return;
      redoStack = [];
      objects = [];
      redraw(); syncChrome();
    }
    function eraseStrokeAt(p) {
      var i, hit;
      for (i = objects.length - 1; i >= 0; i--) {
        if (hitObject(objects[i], p, srcW)) {
          hit = objects.splice(i, 1)[0];
          redoStack = [];
          redraw(); syncChrome();
          return hit;
        }
      }
      return null;
    }
    function placeStampAt(p) {
      if (!armedStamp) return null;
      var st = { type: "stamp", kind: armedStamp.kind, label: armedStamp.label || "", x: p.x, y: p.y };
      if (st.kind === "staff" && !st.label) return null;
      commit(st);
      return st;
    }

    function onDown(e) {
      e.preventDefault();
      if (dockDragging) return;
      if (activePtr != null && activeType !== "pen" && e.pointerType === "pen") {
        if (current && current.type === "stroke" && current.points.length) commit(current);
        current = null; activePtr = null;
      }
      if (activePtr != null) return;
      activePtr = e.pointerId; activeType = e.pointerType;
      try { inkCv.setPointerCapture(e.pointerId); } catch (err) {}
      var p = pt(e);
      if (tool === "stamp") { placeStampAt(p); return; }
      if (tool === "erase" && eraseMode === "stroke") { eraseStrokeAt(p); return; }
      var st = currentStyle();
      current = { type: "stroke", mode: st.mode, color: st.color, width: st.width, points: [p] };
      redraw();
      if (current) drawStrokePath(inkCtx, current);
    }
    function onMove(e) {
      if (e.pointerId !== activePtr) return;
      if (tool === "stamp" || (tool === "erase" && eraseMode === "stroke")) return;
      if (!current) return;
      e.preventDefault();
      current.points.push(pt(e));
      redraw();
      if (current) drawStrokePath(inkCtx, current);
    }
    function onUp(e) {
      if (e.pointerId !== activePtr) return;
      e.preventDefault();
      if (current && current.type === "stroke" && current.points.length) commit(current);
      else { current = null; redraw(); }
      current = null; activePtr = null; activeType = "";
    }
    inkCv.addEventListener("pointerdown", onDown, { passive: false });
    inkCv.addEventListener("pointermove", onMove, { passive: false });
    inkCv.addEventListener("pointerup", onUp, { passive: false });
    inkCv.addEventListener("pointercancel", onUp, { passive: false });
    inkCv.addEventListener("contextmenu", function (e) { e.preventDefault(); });

    function mkBtn(cls, label, title, fn) {
      var b = el("button", cls, label); b.type = "button"; b.title = title; b.setAttribute("aria-label", title);
      b.addEventListener("click", fn); return b;
    }
    function mkTile(title, svg, label, fn) {
      var b = mkBtn("taps-markup-tile", "", title, fn);
      b.innerHTML = svg + (label ? '<span class="taps-markup-tile-lbl">' + label + "</span>" : "");
      return b;
    }

    var cancelBtn = mkBtn("tap-btn", "Cancel", "Cancel", function () { closeMarkup(); });
    var clearBtn = mkBtn("tap-btn", "Clear", "Clear", function () { clearAll(); });
    var sendBtn = mkBtn("tap-btn primary", "Send", "Send", function () { sendMarkup(flattenCanvas(), sendBtn); });
    chromeLeft.appendChild(cancelBtn); chromeLeft.appendChild(clearBtn);
    chrome.appendChild(chromeLeft); chrome.appendChild(chromeTitle); chrome.appendChild(sendBtn);

    var dockWrap = el("div", "taps-markup-dock-wrap");
    var trays = el("div", "taps-markup-trays");
    var dock = el("div", "taps-markup-dock");
    dock.setAttribute("role", "toolbar");
    dock.setAttribute("aria-label", "Markup tools");
    var dockDragging = false, dockCustom = false, dockFrac = null;
    var dockPad = 8;
    var grip = el("div", "taps-markup-grip");
    grip.title = "Drag toolbar. Double-tap to reset.";
    grip.setAttribute("role", "button");
    grip.tabIndex = 0;
    grip.setAttribute("aria-label", "Move toolbar. Double-tap to reset.");
    grip.innerHTML = '<span class="taps-markup-grip-dots" aria-hidden="true"></span>';
    dock.appendChild(grip);

    var colorTray = el("div", "taps-markup-tray taps-markup-tray-color");
    colorTray.appendChild(el("div", "taps-markup-caret"));
    var colorLbl = el("div", "taps-markup-tray-label", "Pen · color & thickness");
    colorTray.appendChild(colorLbl);
    var nubs = el("div", "taps-markup-thickness");
    var nubBtns = [0, 1, 2].map(function (idx) {
      var b = mkBtn("taps-markup-nib t" + (idx + 1), "", "Thickness " + (idx + 1), function () {
        if (tool === "highlight") hiW = idx; else { tool = "pen"; penW = idx; }
        persist(); syncChrome();
      });
      b.appendChild(el("i", null));
      nubs.appendChild(b);
      return b;
    });
    colorTray.appendChild(nubs);
    var palette = el("div", "taps-markup-palette");
    palette.setAttribute("aria-label", "24-color palette");
    var swatchBtns = MARKUP_COLORS.map(function (c) {
      var b = mkBtn("taps-markup-swatch" + (c === "#FFFFFF" ? " white" : ""), "", c, function () {
        if (tool === "highlight") hiColor = c; else { tool = "pen"; penColor = c; }
        persist(); syncChrome();
      });
      b.style.background = c;
      b.dataset.color = c;
      palette.appendChild(b);
      return b;
    });
    colorTray.appendChild(palette);

    var eraseTray = el("div", "taps-markup-tray taps-markup-tray-erase");
    eraseTray.appendChild(el("div", "taps-markup-tray-label", "Eraser"));
    var modes = el("div", "taps-markup-erase-modes");
    var strokeModeBtn = mkBtn("taps-markup-mode", "Whole stroke", "Whole stroke eraser", function () { eraseMode = "stroke"; persist(); syncChrome(); });
    var rubModeBtn = mkBtn("taps-markup-mode", "Rub out", "Rub-out eraser", function () { eraseMode = "rub"; persist(); syncChrome(); });
    modes.appendChild(strokeModeBtn); modes.appendChild(rubModeBtn);
    eraseTray.appendChild(modes);

    var stampTray = el("div", "taps-markup-tray taps-markup-tray-stamps");
    stampTray.appendChild(el("div", "taps-markup-tray-label", "Stamps"));
    var stampRow = el("div", "taps-markup-stamps");
    function stampSvg(kind) {
      if (kind === "check") return '<svg width="26" height="26" viewBox="0 0 26 26"><circle cx="13" cy="13" r="12" fill="#2A9D8F"/><path d="M7.5 13.4l3.4 3.4 7.6-7.8" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      if (kind === "x") return '<svg width="26" height="26" viewBox="0 0 26 26"><circle cx="13" cy="13" r="12" fill="#D8452F"/><path d="M8.2 8.2l9.6 9.6M17.8 8.2l-9.6 9.6" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/></svg>';
      if (kind === "star") return '<svg width="26" height="26" viewBox="0 0 24 24"><path d="M12 2.6l2.7 6.1 6.6.7-5 4.6 1.4 6.5L12 17.3 6.3 20.5 7.7 14 2.7 9.4l6.6-.7L12 2.6z" fill="#EE9B00"/></svg>';
      if (kind === "arrow") return '<svg width="28" height="26" viewBox="0 0 28 26" fill="none" stroke="#E9F5F2" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M4 13h18M16 6l8 7-8 7"/></svg>';
      if (kind === "question") return '<svg width="26" height="26" viewBox="0 0 26 26"><circle cx="13" cy="13" r="12" fill="#FFD84D"/><text x="13" y="18" text-anchor="middle" font-size="16" font-weight="800" font-family="Figtree, sans-serif" fill="#1a1a1a">?</text></svg>';
      return "";
    }
    var stampKinds = [
      ["check", "Check", ""],
      ["x", "X", ""],
      ["star", "Star", ""],
      ["arrow", "Arrow", ""],
      ["question", "Question", ""],
      ["call", "CALL", "call"],
      ["tap", "TAP", "tap"],
      ["staff", "STAFF", "staff"]
    ];
    var stampBtns = {};
    stampKinds.forEach(function (row) {
      var kind = row[0], title = row[1], extra = row[2];
      var b = mkBtn("taps-markup-stamp" + (extra ? " pill " + extra : ""), extra ? title : "", title, function () {
        tool = "stamp";
        if (kind === "staff") {
          armedStamp = staffName ? { kind: "staff", label: staffName } : null;
          openTray = "stamps";
        } else {
          armedStamp = { kind: kind, label: "" };
          openTray = "stamps";
        }
        syncChrome();
      });
      if (!extra) b.innerHTML = stampSvg(kind);
      stampRow.appendChild(b);
      stampBtns[kind] = b;
    });
    stampTray.appendChild(stampRow);
    var staffRow = el("div", "taps-markup-staff");
    staffRow.setAttribute("aria-label", "Staff names");
    var staffBtns = STAFF_NAMES.map(function (name) {
      var b = mkBtn("taps-markup-staff-btn", name, name, function () {
        staffName = name;
        tool = "stamp";
        armedStamp = { kind: "staff", label: name };
        openTray = "stamps";
        syncChrome();
      });
      staffRow.appendChild(b);
      return b;
    });
    stampTray.appendChild(staffRow);

    trays.appendChild(colorTray);
    trays.appendChild(eraseTray);
    trays.appendChild(stampTray);

    var undoBtn = mkTile("Undo", svgIcon('<path d="M9 14l-5-5 5-5"/><path d="M4 9h9a7 7 0 1 1 0 14h-2"/>'), "", function () { undo(); });
    var redoBtn = mkTile("Redo", svgIcon('<path d="M15 14l5-5-5-5"/><path d="M20 9H11a7 7 0 1 0 0 14h2"/>'), "", function () { redo(); });
    var penBtn = mkTile("Pen", svgIcon('<path d="M15.4 4.2l4.4 4.4L8.4 20H4v-4.4L15.4 4.2z"/><path d="M13.7 5.9l4.4 4.4"/>'), "Pen", function () {
      if (tool === "pen" && openTray === "color") openTray = "";
      else { tool = "pen"; openTray = "color"; }
      syncChrome();
    });
    var hiBtn = mkTile("Highlighter", svgIcon('<path d="M15.2 3.6l5.2 5.2-2.2 2.2-5.2-5.2 2.2-2.2z" fill="currentColor" opacity=".2"/><path d="M17.2 7.2L9 15.4l-4 1.2 1.2-4L14.4 4.4"/><path d="M3.8 19.8h11.4" stroke-width="3.4"/>'), "Highlight", function () {
      if (tool === "highlight" && openTray === "color") openTray = "";
      else { tool = "highlight"; openTray = "color"; }
      syncChrome();
    });
    var eraseBtn = mkTile("Eraser", svgIcon('<path d="M4.2 14.8l7.6-7.6a2.3 2.3 0 0 1 3.2 0l3.6 3.6a2.3 2.3 0 0 1 0 3.2L12 20.6H7.4L4.2 17.4a2.3 2.3 0 0 1 0-2.6z"/><path d="M8.2 10.8l7.4 7.4"/><path d="M5 20.6h15.2"/>'), "Eraser", function () {
      if (tool === "erase" && openTray === "erase") openTray = "";
      else { tool = "erase"; openTray = "erase"; }
      syncChrome();
    });
    var stampsBtn = mkTile("Stamps", svgIcon('<rect x="3.2" y="3.2" width="7.4" height="7.4" rx="1.6"/><rect x="13.4" y="3.2" width="7.4" height="7.4" rx="1.6"/><rect x="3.2" y="13.4" width="7.4" height="7.4" rx="1.6"/><rect x="13.4" y="13.4" width="7.4" height="7.4" rx="1.6"/>'), "Stamps", function () {
      if (tool === "stamp" && openTray === "stamps") openTray = "";
      else { tool = "stamp"; openTray = "stamps"; }
      syncChrome();
    });
    var colorDot = el("div", "taps-markup-color-dot");
    var colorBtn = mkBtn("taps-markup-tile", "", "Color palette", function () {
      if (tool !== "pen" && tool !== "highlight") tool = "pen";
      openTray = openTray === "color" ? "" : "color";
      syncChrome();
    });
    colorBtn.appendChild(colorDot);
    colorBtn.appendChild(el("span", "taps-markup-tile-lbl", "Color"));

    dock.appendChild(undoBtn);
    dock.appendChild(redoBtn);
    dock.appendChild(el("div", "taps-markup-sep"));
    dock.appendChild(penBtn);
    dock.appendChild(hiBtn);
    dock.appendChild(eraseBtn);
    dock.appendChild(stampsBtn);
    dock.appendChild(el("div", "taps-markup-sep"));
    dock.appendChild(colorBtn);

    function viewport() {
      return { w: window.innerWidth || document.documentElement.clientWidth || 0, h: window.innerHeight || document.documentElement.clientHeight || 0 };
    }
    function clampWrap(left, top) {
      var vp = viewport();
      var w = dockWrap.offsetWidth || 0, h = dockWrap.offsetHeight || 0;
      var maxL = Math.max(dockPad, vp.w - w - dockPad);
      var maxT = Math.max(dockPad, vp.h - h - dockPad);
      return { left: Math.max(dockPad, Math.min(left, maxL)), top: Math.max(dockPad, Math.min(top, maxT)) };
    }
    function layoutTraySide() {
      var vp = viewport();
      var r = dock.getBoundingClientRect();
      var above = r.top, below = vp.h - r.bottom;
      var openUp = above >= below;
      dockWrap.classList.toggle("trays-below", !openUp);
      dockWrap.classList.toggle("trays-above", openUp);
    }
    function dockFractions() {
      var vp = viewport();
      var r = dock.getBoundingClientRect();
      var vw = vp.w || 1, vh = vp.h || 1;
      return { x: (r.left + r.width / 2) / vw, y: (r.top + r.height / 2) / vh };
    }
    function setWrapPos(left, top) {
      var c = clampWrap(left, top);
      dockWrap.style.left = c.left + "px";
      dockWrap.style.top = c.top + "px";
      return c;
    }
    function placeDefault() {
      dockCustom = false;
      dockWrap.classList.add("trays-above");
      dockWrap.classList.remove("trays-below");
      var vp = viewport();
      var w = dockWrap.offsetWidth || 0, h = dockWrap.offsetHeight || 0;
      setWrapPos((vp.w - w) / 2, vp.h - h - 16);
      layoutTraySide();
      setWrapPos(parseFloat(dockWrap.style.left) || 0, parseFloat(dockWrap.style.top) || 0);
      dockFrac = dockFractions();
    }
    function placeFromFractions(frac) {
      if (!frac || !isFinite(frac.x) || !isFinite(frac.y)) { placeDefault(); return; }
      dockCustom = true;
      var vp = viewport();
      var dr = dock.getBoundingClientRect();
      var wr = dockWrap.getBoundingClientRect();
      var cx = frac.x * (vp.w || 1), cy = frac.y * (vp.h || 1);
      var left = cx - dr.width / 2 - (dr.left - wr.left);
      var top = cy - dr.height / 2 - (dr.top - wr.top);
      setWrapPos(left, top);
      layoutTraySide();
      dr = dock.getBoundingClientRect();
      wr = dockWrap.getBoundingClientRect();
      left = cx - dr.width / 2 - (dr.left - wr.left);
      top = cy - dr.height / 2 - (dr.top - wr.top);
      setWrapPos(left, top);
      var measured = dock.getBoundingClientRect();
      dockFrac = (measured.width > 0 && measured.height > 0) ? dockFractions() : { x: frac.x, y: frac.y };
    }
    function layoutDock() {
      if (dockCustom && dockFrac) placeFromFractions(dockFrac);
      else placeDefault();
    }
    function resetDock() {
      clearDockFrac();
      dockFrac = null;
      placeDefault();
    }
    function initDockPosition() {
      var saved = loadDockFrac();
      if (saved) placeFromFractions(saved);
      else placeDefault();
    }
    var gripPtr = null, gripMoved = false, gripStartX = 0, gripStartY = 0, gripLeft = 0, gripTop = 0, lastGripTap = 0;
    function onGripDown(e) {
      if (gripPtr != null) return;
      e.preventDefault();
      e.stopPropagation();
      gripPtr = e.pointerId;
      dockDragging = true;
      gripMoved = false;
      gripStartX = e.clientX; gripStartY = e.clientY;
      gripLeft = parseFloat(dockWrap.style.left) || 0;
      gripTop = parseFloat(dockWrap.style.top) || 0;
      dockWrap.classList.add("dragging");
      try { grip.setPointerCapture(e.pointerId); } catch (err) {}
    }
    function onGripMove(e) {
      if (e.pointerId !== gripPtr) return;
      e.preventDefault();
      e.stopPropagation();
      var dx = e.clientX - gripStartX, dy = e.clientY - gripStartY;
      if (!gripMoved && (dx * dx + dy * dy) < 64) return;
      gripMoved = true;
      setWrapPos(gripLeft + dx, gripTop + dy);
      layoutTraySide();
      setWrapPos(parseFloat(dockWrap.style.left) || 0, parseFloat(dockWrap.style.top) || 0);
    }
    function onGripUp(e) {
      if (e.pointerId !== gripPtr) return;
      e.preventDefault();
      e.stopPropagation();
      gripPtr = null;
      dockDragging = false;
      dockWrap.classList.remove("dragging");
      if (gripMoved) {
        dockCustom = true;
        dockFrac = dockFractions();
        saveDockFrac(dockFrac);
        lastGripTap = 0;
      } else {
        var now = Date.now();
        if (lastGripTap && now - lastGripTap <= 400) {
          lastGripTap = 0;
          resetDock();
        } else lastGripTap = now;
      }
    }
    grip.addEventListener("pointerdown", onGripDown, { passive: false });
    grip.addEventListener("pointermove", onGripMove, { passive: false });
    grip.addEventListener("pointerup", onGripUp, { passive: false });
    grip.addEventListener("pointercancel", onGripUp, { passive: false });
    grip.addEventListener("contextmenu", function (e) { e.preventDefault(); });
    markupDockResize = function () { layoutDock(); };
    window.addEventListener("resize", markupDockResize);
    window.addEventListener("orientationchange", markupDockResize);

    function setActive(btn, on) { btn.classList.toggle("active", !!on); }
    function syncChrome() {
      setActive(penBtn, tool === "pen");
      setActive(hiBtn, tool === "highlight");
      setActive(eraseBtn, tool === "erase");
      setActive(stampsBtn, tool === "stamp");
      setActive(colorBtn, openTray === "color");
      undoBtn.classList.toggle("dim", objects.length === 0);
      redoBtn.classList.toggle("dim", redoStack.length === 0);
      clearBtn.disabled = objects.length === 0;
      var drawing = tool === "highlight" ? "highlight" : "pen";
      var col = drawing === "highlight" ? hiColor : penColor;
      var wIndex = drawing === "highlight" ? hiW : penW;
      colorDot.style.background = col;
      colorLbl.textContent = (drawing === "highlight" ? "Highlighter" : "Pen") + " · color & thickness";
      nubBtns.forEach(function (b, i) {
        b.classList.toggle("active", i === wIndex);
        b.querySelector("i").style.background = col;
      });
      swatchBtns.forEach(function (b) { b.classList.toggle("active", b.dataset.color === col); });
      setActive(strokeModeBtn, eraseMode === "stroke");
      setActive(rubModeBtn, eraseMode === "rub");
      Object.keys(stampBtns).forEach(function (k) {
        var on = tool === "stamp" && armedStamp && armedStamp.kind === k;
        setActive(stampBtns[k], on);
      });
      staffBtns.forEach(function (b) { setActive(b, staffName === b.getAttribute("aria-label")); });
      staffRow.hidden = openTray !== "stamps";
      colorTray.hidden = openTray !== "color";
      eraseTray.hidden = openTray !== "erase";
      stampTray.hidden = openTray !== "stamps";
      inkCv.style.cursor = tool === "stamp" ? "pointer" : (tool === "erase" ? "cell" : "crosshair");
      dockWrap.classList.toggle("has-tray", !!openTray);
      layoutDock();
    }

    layers.appendChild(boardCv);
    layers.appendChild(inkCv);
    stage.appendChild(layers);
    dockWrap.appendChild(trays);
    dockWrap.appendChild(dock);
    wrap.appendChild(chrome);
    wrap.appendChild(stage);
    wrap.appendChild(dockWrap);
    document.body.appendChild(wrap);
    markupEl = wrap;
    redraw();
    syncChrome();
    initDockPosition();

    markupApi = {
      tool: function () { return tool; },
      setTool: function (t, tray) { tool = t; if (tray !== undefined) openTray = tray; syncChrome(); },
      eraseMode: function () { return eraseMode; },
      setEraseMode: function (m) { eraseMode = m === "rub" ? "rub" : "stroke"; persist(); syncChrome(); },
      pen: function () { return { color: penColor, widthIndex: penW, width: PEN_WIDTHS[penW] }; },
      highlight: function () { return { color: hiColor, widthIndex: hiW, width: HI_WIDTHS[hiW] }; },
      setPenColor: function (c) { if (markupKnownColor(c)) { penColor = markupKnownColor(c); persist(); syncChrome(); } },
      setPenWidthIndex: function (i) { if (i >= 0 && i <= 2) { penW = i | 0; persist(); syncChrome(); } },
      setHiColor: function (c) { if (markupKnownColor(c)) { hiColor = markupKnownColor(c); persist(); syncChrome(); } },
      setHiWidthIndex: function (i) { if (i >= 0 && i <= 2) { hiW = i | 0; persist(); syncChrome(); } },
      objects: function () { return objects.slice(); },
      addStroke: function (st) { commit({ type: "stroke", mode: st.mode, color: st.color, width: st.width, points: st.points.slice() }); },
      addStamp: function (kind, x, y, label) { commit({ type: "stamp", kind: kind, label: label || "", x: x, y: y }); },
      setArmedStamp: function (kind, label) { armedStamp = kind ? { kind: kind, label: label || "" } : null; if (kind) tool = "stamp"; syncChrome(); },
      setStaffName: function (n) { staffName = n; armedStamp = { kind: "staff", label: n }; tool = "stamp"; openTray = "stamps"; syncChrome(); },
      placeStampAt: placeStampAt,
      eraseStrokeAt: eraseStrokeAt,
      undo: undo,
      redo: redo,
      clear: clearAll,
      flatten: flattenCanvas,
      prefs: loadMarkupPrefs,
      persist: persist,
      tray: function () { return openTray; },
      staffName: function () { return staffName; },
      boardCanvas: function () { return boardCv; },
      inkCanvas: function () { return inkCv; },
      dockKey: MARKUP_DOCK_POS_KEY,
      dockPos: function () { return { left: parseFloat(dockWrap.style.left) || 0, top: parseFloat(dockWrap.style.top) || 0, frac: dockFractions(), custom: dockCustom, traySide: dockWrap.classList.contains("trays-below") ? "below" : "above" }; },
      moveDock: function (left, top) {
        dockCustom = true;
        setWrapPos(left, top);
        layoutTraySide();
        var c = setWrapPos(parseFloat(dockWrap.style.left) || 0, parseFloat(dockWrap.style.top) || 0);
        dockFrac = dockFractions();
        saveDockFrac(dockFrac);
        return c;
      },
      resetDock: resetDock,
      layoutDock: layoutDock,
      grip: function () { return grip; }
    };
  }

  function sendMarkup(canvas, btn) {
    if (markupBusy) return;
    markupBusy = true;
    if (btn) btn.disabled = true;
    setStatus("Sending markup\u2026");
    withToken(function (err) {
      if (err) { markupBusy = false; if (btn) btn.disabled = false; handleError({ status: 0 }, "Google sign-in didn't finish. Tap Send again."); return; }
      canvasToPngBlob(canvas).then(function (blob) {
        return findOrCreateMarkupFolder().then(function (folderId) {
          return uploadMarkupPng(blob, folderId);
        });
      }).then(function (file) {
        var note = (file.id || "") + (file.webViewLink ? " " + file.webViewLink : "");
        var ts = new Date().toISOString();
        var local = { case: "MARKUP", patient: "", choice: "Markup", ts: ts, status: "pending", note: note, _local: true };
        answers.push(local);
        return api("/values/" + encodeURIComponent("Answers!A:F") + ":append?valueInputOption=RAW&insertDataOption=INSERT_ROWS", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ values: [["MARKUP", "", "Markup", ts, "pending", note]] })
        }).then(function () { local._local = false; local._saved = true; });
      }).then(function () {
        closeMarkup();
        setStatus("Markup sent");
      }).catch(function (e) {
        markupBusy = false; if (btn) btn.disabled = false;
        handleError(e, "The markup did not send. Try again.");
      });
    }, false, true);
  }

  function startMarkup() {
    if (markupEl) return;
    withToken(function (err) {
      if (err) { handleError({ status: 0 }, "Google sign-in didn't finish. Tap Markup again."); return; }
      var panel = document.querySelector(".taps-panel");
      var bodyEl = document.querySelector(".taps-body");
      if (!panel) { setStatus("Couldn't capture the board.", "warn"); return; }
      var prevOverflow = bodyEl ? bodyEl.style.overflow : "";
      var prevHeight = bodyEl ? bodyEl.style.height : "";
      if (bodyEl) { bodyEl.style.overflow = "visible"; bodyEl.style.height = "auto"; }
      loadHtml2Canvas().then(function (h2c) {
        return h2c(panel, { backgroundColor: "#04202A", scale: 2, useCORS: true, logging: false, onclone: function (doc) { hideClosedTapGroups(doc); } });
      }).then(function (cv) {
        if (bodyEl) { bodyEl.style.overflow = prevOverflow; bodyEl.style.height = prevHeight; }
        openMarkupOverlay(cv);
        setStatus("");
      }).catch(function () {
        if (bodyEl) { bodyEl.style.overflow = prevOverflow; bodyEl.style.height = prevHeight; }
        setStatus("Couldn't capture the board.", "warn");
      });
    }, false, true);
  }


  if (window.TAPS_TEST) {
    window.__itapMarkup = {
      open: openMarkupOverlay,
      close: closeMarkup,
      hideClosedTapGroups: hideClosedTapGroups,
      api: function () { return markupApi; },
      colors: MARKUP_COLORS,
      staffNames: STAFF_NAMES,
      prefsKey: MARKUP_PREFS_KEY,
      dockKey: MARKUP_DOCK_POS_KEY,
      penWidths: PEN_WIDTHS,
      hiWidths: HI_WIDTHS
    };
  }

  function build() {
    overlay = el("div", "taps-overlay");
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-label", "iTap board");
    var panel = el("div", "taps-panel");
    var head = el("header", "taps-head");
    var h = el("div");
    h.appendChild(el("h2", null, "iTap board"));
    statusEl = el("p", "taps-status");
    h.appendChild(statusEl);
    filterEl = el("div", "taps-stars"); filterEl.setAttribute("role", "group"); filterEl.setAttribute("aria-label", "Filter by star"); filterEl.hidden = true;
    h.appendChild(filterEl);
    head.appendChild(h);
    var refresh = el("button", "taps-icon-btn", "\u21bb"); refresh.type = "button"; refresh.title = "Refresh"; refresh.setAttribute("aria-label", "Refresh");
    refresh.addEventListener("click", function (e) {
      e.preventDefault(); e.stopPropagation();
      if (!savedToken()) { unlock(false); return; }
      if (refresh.classList.contains("spinning")) return;
      refresh.classList.add("spinning"); refresh.disabled = true;
      var t0 = Date.now();
      var done = function () {
        setTimeout(function () { refresh.classList.remove("spinning"); refresh.disabled = false; }, Math.max(0, 600 - (Date.now() - t0)));
      };
      load().then(done, function (err) { done(); handleError(err); });
    });
    var markupBtn = el("button", "taps-icon-btn taps-markup-btn", "Markup");
    markupBtn.type = "button"; markupBtn.title = "Markup"; markupBtn.setAttribute("aria-label", "Markup");
    markupBtn.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); startMarkup(); });
    var close = el("button", "taps-icon-btn", "\u2715"); close.type = "button"; close.title = "Close"; close.setAttribute("aria-label", "Close");
    close.addEventListener("click", closeBoard);
    var btns = el("div", "taps-head-btns"); btns.appendChild(refresh); btns.appendChild(markupBtn); btns.appendChild(close);
    head.appendChild(btns);
    panel.appendChild(head);
    body = el("div", "taps-body");
    panel.appendChild(body);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape") return;
      if (markupEl) { closeMarkup(); return; }
      if (overlay.classList.contains("open")) closeBoard();
    });
  }

  var prevTitle = null;
  function openBoard(fromTap) {
    if (!overlay) build();
    overlay.classList.add("open");
    document.documentElement.classList.add("taps-lock");
    if (prevTitle == null) prevTitle = document.title;
    document.title = "iTap board";
    if (location.hash !== "#taps") history.pushState(null, "", "#taps");
    if (!clientId()) { showGate("setup"); return; }
    if (savedToken()) { setStatus("Loading\u2026"); load().then(startPoll).catch(function (e) { handleError(e); }); return; }
    if (fromTap) unlock(false); else showGate("locked");
  }

  function closeBoard() {
    if (!overlay) return;
    closeMarkup();
    overlay.classList.remove("open");
    document.documentElement.classList.remove("taps-lock");
    stopPoll();
    items = []; answers = []; editing = {}; modifyDraft = {}; noteOpen = {};
    openState = {}; cardOpen = {}; localSection = {};
    addOpen = false; addDraft = { patient: "", appt: "", note: "" };
    if (body) body.textContent = "";
    if (prevTitle != null) { document.title = prevTitle; prevTitle = null; }
    if (location.hash === "#taps") history.pushState(null, "", location.pathname + location.search);
  }

  window.addEventListener("popstate", function () {
    if (location.hash === "#taps") openBoard(false); else if (overlay && overlay.classList.contains("open")) closeBoard();
  });

  document.addEventListener("DOMContentLoaded", function () {
    var tile = document.querySelector('[data-id="invisalign-taps"]');
    if (tile) tile.addEventListener("click", function (e) { e.preventDefault(); openBoard(true); });
    if (location.hash === "#taps") openBoard(false);
  });
})();
