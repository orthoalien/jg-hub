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
    return fetch(API + encodeURIComponent(CFG.sheetId) + path, opts).then(function (r) {
      if (r.ok) return r.json();
      return r.text().then(function (t) { throw { status: r.status, text: t }; });
    });
  }

  function rowsToObjects(values) {
    if (!values || !values.length) return [];
    var head = values[0].map(function (h) { return String(h).trim(); });
    return values.slice(1).filter(function (r) { return r.some(function (c) { return String(c).trim() !== ""; }); })
      .map(function (r, i) {
        var o = { _row: i + 2 };
        head.forEach(function (h, j) { o[h] = r[j] == null ? "" : String(r[j]); });
        return o;
      });
  }

  var lastChecked = null;
  function load() {
    return api("/values:batchGet?ranges=Items!A1:Y&ranges=Answers!A1:F&majorDimension=ROWS").then(function (d) {
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

  function handleError(err, fallback) {
    var s = err && err.status;
    if (s === 401) { dropToken(); setStatus("Google sign-in expired. Tap any button to unlock again.", "warn"); return; }
    if (s === 403 || s === 404) {
      dropToken();
      showGate("wrong", "This Google account can't open the iTap board. Use " + CFG.account + ".");
      return;
    }
    setStatus(fallback || "Couldn't reach Google. Check the connection and try again.", "warn");
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
    /* Tap/scan: appt or dd on the name line. Shipped/mfg: dd/due only when appt is missing (appt lives on its own line). */
    if (!mfg && !shipped) {
      top.appendChild(el("span", "tap-when" + (appt ? "" : " dd"), appt ? apptLabel(appt).replace(pills.some(function (p) { return /^RUSH$/i.test(p.trim()); }) ? /\s*\bRUSH\b/i : /$^/, "") : dueLabel(due)));
    } else if (!appt) {
      top.appendChild(el("span", "tap-when dd", dueLabel(due)));
    }
    pills.filter(function (p) { return !/PURPLE STAR/i.test(p); }).forEach(function (p) {
      var cls = /RUSH/i.test(p) ? "pill stop" : /PRIORITY/i.test(p) ? "pill purple" : /DONE/i.test(p) ? "pill done" : "pill";
      top.appendChild(el("span", cls, p));
    });
    if (sec === "tap" && String(it.review || "").trim().toLowerCase() === "not_reviewed") {
      top.appendChild(el("span", "pill review", "Not yet reviewed"));
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
      var scanned = fmtDate(it.scan_date) || fmtDate(it.updated);
      wrap.appendChild(el("div", "tap-scanned", scanned ? "Scanned " + scanned : "Scanned"));
      if (it.reason) wrap.appendChild(el("div", "tap-reason", it.reason));
    } else if (shipped) {
      var scanD = fmtDate(it.scan_date);
      if (scanD) addLine("Scan date", function (d) { d.appendChild(el("span", "tap-line-value", scanD)); });
      var appr = fmtDate(it.approved);
      if (appr) addLine("Approved", function (d) { d.appendChild(el("span", "tap-line-value", appr)); });
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
      var apprM = fmtDate(it.approved);
      if (apprM) addLine("Approved", function (d) { d.appendChild(el("span", null, apprM)); });
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
      var scannedTap = fmtDate(it.scan_date);
      if (scannedTap) wrap.appendChild(el("div", "tap-scanned", "Scanned " + scannedTap));
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
        var box = body.querySelector('.tap-note-input[data-key="' + CSS.escape(key) + '"]');
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
            var box = body.querySelector('.tap-note-input[data-key="' + CSS.escape(key) + '"]');
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
    if (!answered && modifyDraft[key] != null) wrap.appendChild(modifyBox(it));
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
      bySec[k].sort(function (x, y) {
        var ax = latestAnswer(x) ? 1 : 0, ay = latestAnswer(y) ? 1 : 0;
        var dx = sortDate(x), dy = sortDate(y);
        var dd = dx === dy ? 0 : (dx === Infinity ? 1 : dy === Infinity ? -1 : dx - dy);
        return ax - ay || starRank(x) - starRank(y) || dd || barRank(x) - barRank(y);
      });
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
      var box = body.querySelector('[data-key="' + CSS.escape(String(keep.k)) + '"], [data-keep="' + CSS.escape(String(keep.k)) + '"]');
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
      s.src = "html2canvas.min.js?v=20261119g";
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
    if (!markupEl) return;
    if (markupEl.parentNode) markupEl.parentNode.removeChild(markupEl);
    markupEl = null;
    markupBusy = false;
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

  function openMarkupOverlay(imageCanvas) {
    closeMarkup();
    var wrap = el("div", "taps-markup");
    wrap.setAttribute("role", "dialog");
    wrap.setAttribute("aria-label", "Markup");
    var tools = el("div", "taps-markup-tools");
    var colors = [
      ["ink", "#001219", "Dark ink"],
      ["red", "#D8452F", "Red"],
      ["ocean", "#1F7A9E", "Ocean blue"]
    ];
    var tool = "pen", color = colors[0][1], strokes = [], current = null, activePtr = null, activeType = "";
    var stage = el("div", "taps-markup-stage");
    var canvas = document.createElement("canvas");
    canvas.className = "taps-markup-canvas";
    canvas.setAttribute("aria-label", "Drawing area");
    var srcW = imageCanvas.width, srcH = imageCanvas.height;
    canvas.width = srcW; canvas.height = srcH;
    var ctx = canvas.getContext("2d");
    function redraw() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(imageCanvas, 0, 0);
      strokes.forEach(drawStroke);
    }
    function drawStroke(st) {
      if (!st.points.length) return;
      ctx.save();
      ctx.lineCap = "round"; ctx.lineJoin = "round";
      ctx.lineWidth = st.width;
      if (st.mode === "erase") { ctx.globalCompositeOperation = "destination-out"; ctx.strokeStyle = "rgba(0,0,0,1)"; }
      else { ctx.globalCompositeOperation = "source-over"; ctx.strokeStyle = st.color; }
      ctx.beginPath();
      ctx.moveTo(st.points[0].x, st.points[0].y);
      for (var i = 1; i < st.points.length; i++) ctx.lineTo(st.points[i].x, st.points[i].y);
      if (st.points.length === 1) { ctx.lineTo(st.points[0].x + 0.1, st.points[0].y); }
      ctx.stroke();
      ctx.restore();
    }
    function pt(e) {
      var r = canvas.getBoundingClientRect();
      return { x: (e.clientX - r.left) * (canvas.width / r.width), y: (e.clientY - r.top) * (canvas.height / r.height) };
    }
    function onDown(e) {
      e.preventDefault();
      if (activePtr != null && activeType !== "pen" && e.pointerType === "pen") {
        if (current && current.points.length) strokes.push(current);
        current = null; activePtr = null;
      }
      if (activePtr != null) return;
      activePtr = e.pointerId; activeType = e.pointerType;
      try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
      current = { mode: tool, color: color, width: tool === "erase" ? 24 : 4, points: [pt(e)] };
      drawStroke(current);
    }
    function onMove(e) {
      if (e.pointerId !== activePtr || !current) return;
      e.preventDefault();
      current.points.push(pt(e));
      redraw();
      if (current) drawStroke(current);
    }
    function onUp(e) {
      if (e.pointerId !== activePtr) return;
      e.preventDefault();
      if (current && current.points.length) strokes.push(current);
      current = null; activePtr = null; activeType = "";
      redraw();
    }
    canvas.addEventListener("pointerdown", onDown, { passive: false });
    canvas.addEventListener("pointermove", onMove, { passive: false });
    canvas.addEventListener("pointerup", onUp, { passive: false });
    canvas.addEventListener("pointercancel", onUp, { passive: false });
    canvas.addEventListener("contextmenu", function (e) { e.preventDefault(); });

    function mkBtn(cls, label, title, fn) {
      var b = el("button", cls, label); b.type = "button"; b.title = title; b.setAttribute("aria-label", title);
      b.addEventListener("click", fn); return b;
    }
    var penBtn = mkBtn("tap-btn primary taps-markup-tool active", "Pen", "Pen", function () { tool = "pen"; syncTools(); });
    tools.appendChild(penBtn);
    var colorBtns = [];
    colors.forEach(function (c) {
      var b = mkBtn("taps-markup-color" + (c[1] === color ? " active" : ""), "", c[2], function () { color = c[1]; tool = "pen"; syncTools(); });
      b.style.background = c[1];
      b.dataset.color = c[1];
      colorBtns.push(b); tools.appendChild(b);
    });
    var eraseBtn = mkBtn("tap-btn primary taps-markup-tool", "Eraser", "Eraser", function () { tool = "erase"; syncTools(); });
    tools.appendChild(eraseBtn);
    tools.appendChild(mkBtn("tap-btn primary", "Undo", "Undo", function () { strokes.pop(); redraw(); }));
    function syncTools() {
      penBtn.classList.toggle("active", tool === "pen");
      eraseBtn.classList.toggle("active", tool === "erase");
      colorBtns.forEach(function (b) { b.classList.toggle("active", b.dataset.color === color && tool === "pen"); });
    }
    var cancel = mkBtn("tap-btn primary", "Cancel", "Cancel", function () { closeMarkup(); });
    var send = mkBtn("tap-btn primary", "Send", "Send", function () { sendMarkup(canvas, send); });
    tools.appendChild(cancel); tools.appendChild(send);
    stage.appendChild(canvas);
    wrap.appendChild(tools); wrap.appendChild(stage);
    document.body.appendChild(wrap);
    markupEl = wrap;
    redraw();
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
        return h2c(panel, { backgroundColor: "#04202A", scale: 2, useCORS: true, logging: false });
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
    items = []; answers = []; editing = {}; modifyDraft = {};
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
