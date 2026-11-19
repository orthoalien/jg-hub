/* Invisalign taps: in-page board backed by her private Google Sheet.
   Google enforces access: the browser gets a short-lived OAuth token for her
   account and calls the Sheets API directly. Nothing is cached to disk except
   the token (sessionStorage, under 1 hour). Patient data only lives in memory. */
(function () {
  "use strict";
  var CFG = window.TAPS_CONFIG || {};
  var SCOPE = "https://www.googleapis.com/auth/spreadsheets";
  var API = "https://sheets.googleapis.com/v4/spreadsheets/";
  var TOKEN_KEY = "jg-taps-token-v1";
  var CID_KEY = "jg-taps-client-id";
  var PLAN_URL = "https://vip.invisalign.com/v3/auth/patient/patientFile.action?patientId=";
  var LIST_URL = "https://vip.invisalign.com/v3/auth/patients.action";

  var filterEl = null;
  var overlay, body, statusEl, tokenClient = null, pendingAfterToken = [];
  var items = [], answers = [], pollTimer = null, editing = {};

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
    sessionStorage.setItem(TOKEN_KEY, JSON.stringify({ access: resp.access_token, exp: exp }));
  }
  function dropToken() { sessionStorage.removeItem(TOKEN_KEY); }

  function initTokenClient() {
    if (tokenClient || !clientId() || !(window.google && google.accounts && google.accounts.oauth2)) return !!tokenClient;
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: clientId(),
      scope: SCOPE,
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
    return true;
  }

  /* Must be called inside a tap/click so Safari allows Google's popup. */
  function withToken(cb, forceChooser) {
    if (!forceChooser && savedToken()) { cb(null); return; }
    if (!initTokenClient()) { cb({ type: "gis_not_ready" }); return; }
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
    return api("/values:batchGet?ranges=Items!A1:V&ranges=Answers!A1:F&majorDimension=ROWS").then(function (d) {
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
    delete editing[it.case];
    delete modifyDraft[it.case];
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
    answers.forEach(function (a) {
      if (String(a.case) !== String(it.case)) return;
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
  var ALLOWED_BUTTONS = ["Approve", "Modify request", "Double-check", "Staff resubmit"];
  var MODIFY = "Modify request";
  var modifyDraft = {}; // case -> note text while the Modify box is open
  function allowedButton(label) {
    var t = String(label || "").trim().toLowerCase().replace(/\s+/g, " ");
    if (HIDDEN_BUTTONS.test(t)) return null;
    if (t === "modify") t = "modify request";
    if (t === "double check") t = "double-check";
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
  /* Parse "Fri 11/20", "11/23", "12/7 RUSH", "1/3/27" -> { t: UTC-noon ms, mo, d, y, rest } or null. */
  function parseMD(raw) {
    var str = String(raw || "").trim();
    var iso = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ][\d:.]+Z?)?\s*(.*)$/); // 2026-11-30 -> 11/30/2026
    if (iso) str = iso[2] + "/" + iso[3] + "/" + iso[1] + (iso[4] ? " " + iso[4] : "");
    var m = str.match(/^(?:[A-Za-z]{2,9}\.?,?\s+)?(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b\s*(.*)$/);
    if (!m) return null;
    var mo = Number(m[1]), d = Number(m[2]), y = m[3] ? Number(m[3]) : null, rest = m[4] || "";
    if (y != null && y < 100) y += 2000;
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
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
    return { t: t, mo: mo, d: d, yr: iso ? "" : (m[3] || ""), rest: rest, dow: DOW[dt.getUTCDay()] };
  }
  /* Plain date for fixed card lines: ISO -> M/D; anything else (e.g. "date not shown") as-is. */
  function fmtDate(raw) {
    var v = String(raw || "").trim();
    if (!v) return "";
    var p = /^\d{4}-\d{1,2}-\d{1,2}/.test(v) ? parseMD(v) : null;
    return p ? p.mo + "/" + p.d + (p.rest ? " " + p.rest : "") : v;
  }
  function apptLabel(raw) {
    var p = parseMD(raw);
    if (!p) return String(raw || "").trim();
    return p.dow + " " + p.mo + "/" + p.d + (p.yr ? "/" + p.yr : "") + (p.rest ? " " + p.rest : "");
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
      showGate("wrong", "This Google account can't open the Tap Board. Use " + CFG.account + ".");
      return;
    }
    setStatus(fallback || "Couldn't reach Google. Check the connection and try again.", "warn");
  }

  function row(it) {
    var ans = latestAnswer(it);
    var answered = !!ans && !editing[it.case];
    var sec = sectionOf(it);
    var mfg = sec === "manufacturing", shipped = sec === "shipped";
    var bar = (answered || mfg || shipped) ? "done" : (it.bar || "wait");
    var card = el("article", "tap-row bar-" + bar + (answered ? " answered" : ""));
    card.appendChild(el("div", "tap-bar"));
    var main = el("div", "tap-main");

    var top = el("div", "tap-top");
    top.appendChild(el("span", "tap-name", it.patient));
    var pills = split(it.pills);
    var sc = starColor(it);
    var star = el("span", "tap-star star-" + (sc || "none"), sc ? "\u2605" : "\u2606");
    star.setAttribute("aria-label", sc ? sc + " star" : "no star"); star.title = sc ? sc + " star" : "no star";
    top.appendChild(star);
    var appt = String(it.appt || "").trim(), due = String(it.due || "").trim();
    if (!mfg && !shipped) top.appendChild(el("span", "tap-when" + (appt ? "" : " dd"), appt ? apptLabel(appt).replace(pills.some(function (p) { return /^RUSH$/i.test(p.trim()); }) ? /\s*\bRUSH\b/i : /$^/, "") : (due ? "DD " + due : "DD")));
    pills.filter(function (p) { return !/PURPLE STAR/i.test(p); }).forEach(function (p) {
      var cls = /RUSH/i.test(p) ? "pill stop" : /PRIORITY/i.test(p) ? "pill purple" : /DONE/i.test(p) ? "pill done" : "pill";
      top.appendChild(el("span", cls, p));
    });
    main.appendChild(top);

    var meta = [];
    if (it.case && /^\d+$/.test(it.case)) meta.push("#" + it.case);
    var cnt = String(it.count || "").trim();
    if (it.plan) meta.push("Plan " + it.plan + (cnt ? ": " + cnt : ""));
    var req = String(it.req_date || "").trim();
    if (mfg || shipped) {
      /* Fixed layout for Manufacturing + Shipped/Delivered: four lines, em dash when empty, then reason, then #case/Plan. */
      var DASH = "\u2014";
      var lines = el("div", "tap-lines");
      var line = function (label) { var d = el("div", "tap-line"); d.appendChild(el("span", "tap-line-label", label + " ")); lines.appendChild(d); return d; };
      line("Approved").appendChild(el("span", null, fmtDate(it.approved) || DASH));
      line("Appt").appendChild(el("span", null, String(it.appt || "").trim() ? apptLabel(it.appt) : DASH));
      line("Manufacturing:").appendChild(el("span", null, "Mfg ETA " + (fmtDate(it.mfg_eta) || DASH)));
      var sh = line("Shipping:");
      var shp = fmtDate(it.shipped), ups = String(it.ups || "").trim(), dlv = fmtDate(it.delivered), eta = fmtDate(it.ups_eta);
      if (!shp && !ups && !dlv && !eta) sh.appendChild(el("span", null, "Not shipped yet"));
      else {
        var parts = [];
        if (shp) parts.push(el("span", null, "Shipped " + shp));
        if (ups) {
          var uw = el("span", null, "UPS ");
          var u = el("a", "tap-ups", ups); u.href = upsUrl(ups); u.target = "_blank"; u.rel = "noopener noreferrer";
          uw.appendChild(u); parts.push(uw);
        }
        if (dlv) parts.push(el("span", "pill done tap-delivered", "Delivered " + dlv));
        else if (eta) parts.push(el("span", null, "ETA " + eta));
        else parts.push(el("span", null, "In transit"));
        parts.forEach(function (n, i) { if (i) sh.appendChild(document.createTextNode(" \u00b7 ")); sh.appendChild(n); });
      }
      main.appendChild(lines);
      if (it.reason) main.appendChild(el("div", "tap-reason", (req ? req + ": " : "") + it.reason));
      if (meta.length) main.appendChild(el("div", "tap-meta", meta.join(" \u00b7 ")));
    } else {
      if (meta.length) main.appendChild(el("div", "tap-meta", meta.join(" \u00b7 ")));
      if (it.reason) main.appendChild(el("div", "tap-reason", (req ? req + ": " : "") + it.reason));
    }

    var acts = el("div", "tap-acts");
    if (answered) {
      /* Answered: status is only ADDED (pill on the name line + "Picked" label). Card text is never dimmed. */
      var st = String(ans.status || "pending").toLowerCase();
      var pend = el("span", "pill tap-pending " + (st === "confirmed" ? "ok" : ""), st === "confirmed" ? "confirmed" : (ans._local ? "saving\u2026" : "pending"));
      top.appendChild(pend);
      if (ans.note && st !== "confirmed") main.insertBefore(el("div", "tap-note-shown", "Note: " + ans.note), acts.parentNode === main ? acts : null);
      var mark = el("span", "tap-picked", "Picked: " + ans.choice);
      if (st !== "confirmed") {
        mark.appendChild(document.createTextNode(" \u00b7 "));
        var ch = el("button", "tap-link", "change");
        ch.type = "button";
        ch.addEventListener("click", function () { editing[it.case] = true; render(); });
        mark.appendChild(ch);
      }
      acts.appendChild(mark);
    } else {
      var seen = {};
      split(it.buttons).map(allowedButton).filter(function (c) { if (!c || seen[c]) return false; seen[c] = 1; return true; }).forEach(function (choice) {
        var b = el("button", "tap-btn primary", choice);
        b.type = "button";
        if (choice === MODIFY) {
          if (modifyDraft[it.case] != null) b.classList.add("active");
          b.addEventListener("click", function () {
            if (modifyDraft[it.case] == null) modifyDraft[it.case] = "";
            render();
            var box = body.querySelector('.tap-note-input[data-case="' + CSS.escape(String(it.case)) + '"]');
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
    var a = el("a", "tap-btn primary tap-open", it.open_label || "Open plan");
    a.href = it.patientId ? PLAN_URL + encodeURIComponent(it.patientId) : LIST_URL;
    a.target = "_blank"; a.rel = "noopener noreferrer";
    acts.appendChild(a);
    main.appendChild(acts);
    if (!answered && modifyDraft[it.case] != null) main.appendChild(modifyBox(it));
    card.appendChild(main);
    return card;
  }

  function modifyBox(it) {
    var f = el("form", "tap-modify");
    var ta = el("textarea", "tap-note-input");
    ta.rows = 3; ta.placeholder = "What should Align change?"; ta.value = modifyDraft[it.case] || "";
    ta.dataset.case = it.case; ta.setAttribute("aria-label", "Modify request note");
    var row2 = el("div", "tap-modify-btns");
    var send = el("button", "tap-btn primary", "Send"); send.type = "submit";
    var cancel = el("button", "tap-btn primary", "Cancel"); cancel.type = "button";
    var sync = function () { modifyDraft[it.case] = ta.value; send.disabled = !ta.value.trim(); };
    ta.addEventListener("input", sync); sync();
    cancel.addEventListener("click", function () { delete modifyDraft[it.case]; render(); });
    f.addEventListener("submit", function (e) {
      e.preventDefault();
      var note = ta.value.trim();
      if (!note) { ta.focus(); return; }
      withToken(function (err) {
        if (err) { handleError({ status: 0 }, "Google sign-in didn't finish. Tap Send again."); return; }
        appendAnswer(it, MODIFY, note);
      });
    });
    row2.appendChild(send); row2.appendChild(cancel);
    f.appendChild(ta); f.appendChild(row2);
    return f;
  }

  function group(title, list, open) {
    var d = el("details", "tap-group");
    if (open) d.open = true;
    var s = el("summary", null);
    s.appendChild(el("span", null, title));
    s.appendChild(el("span", "count", String(list.length)));
    d.appendChild(s);
    if (!list.length) d.appendChild(el("p", "tap-empty", "Nothing here."));
    list.forEach(function (it) { d.appendChild(row(it)); });
    return d;
  }

  /* Plain-star filter: every STAR_COLORS star (purple leftmost), then a light gray outline star for unlabeled cards.
     Tap a star to filter, tap it again to clear. */
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

  var openState = {};
  function render() {
    if (!body) return;
    var ae = document.activeElement, keep = null;
    if (ae && ae.classList && ae.classList.contains("tap-note-input")) keep = { c: ae.dataset.case, s: ae.selectionStart, e: ae.selectionEnd };
    renderFilter();
    body.querySelectorAll("details.tap-group").forEach(function (d) { openState[d.dataset.key] = d.open; });
    body.textContent = "";
    var bySec = { tap: [], in_progress: [], manufacturing: [], shipped: [] };
    var todayNY = nyToday();
    items.forEach(function (it) {
      var sec = sectionOf(it);
      if (sec === "shipped" && deliveredLongAgo(it, todayNY)) return; // gone 7+ days after delivery
      (bySec[sec] || bySec.tap).push(it);
    });
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
      ["tap", "Needs a tap", bySec.tap, true],
      ["in_progress", "ClinCheck in progress", bySec.in_progress, false],
      ["manufacturing", "Manufacturing", bySec.manufacturing, false],
      ["shipped", "Shipped/Delivered", bySec.shipped, false]
    ];
    sections.forEach(function (s) {
      if (s[0] === "in_progress" && !s[2].length) return;
      var g = group(s[1], s[2], openState[s[0]] != null ? openState[s[0]] : s[3]);
      g.dataset.key = s[0];
      body.appendChild(g);
    });
    var newest = items.reduce(function (m, it) { var t = Date.parse(it.updated) || 0; return t > m ? t : m; }, 0);
    var when = newest ? new Date(newest).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
    var chk = lastChecked ? lastChecked.toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }) : "";
    setStatus(open + " waiting on you" + (when ? " \u00b7 list as of " + when + " ET" : "") + (chk ? " \u00b7 checked " + chk : ""));
    if (keep) {
      var box = body.querySelector('.tap-note-input[data-case="' + CSS.escape(String(keep.c)) + '"]');
      if (box) { box.focus(); try { box.setSelectionRange(keep.s, keep.e); } catch (e) {} }
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
  function build() {
    overlay = el("div", "taps-overlay");
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-label", "What needs a tap");
    var panel = el("div", "taps-panel");
    var head = el("header", "taps-head");
    var h = el("div");
    h.appendChild(el("h2", null, "What needs a tap"));
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
    var close = el("button", "taps-icon-btn", "\u2715"); close.type = "button"; close.title = "Close"; close.setAttribute("aria-label", "Close");
    close.addEventListener("click", closeBoard);
    var btns = el("div", "taps-head-btns"); btns.appendChild(refresh); btns.appendChild(close);
    head.appendChild(btns);
    panel.appendChild(head);
    body = el("div", "taps-body");
    panel.appendChild(body);
    panel.appendChild(el("p", "taps-legend", "red = stop \u00b7 orange = waiting on you \u00b7 green = ready \u00b7 grey = done / manufacturing \u00b7 \u2605 = Align star (purple first). Private: real patient data."));
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && overlay.classList.contains("open")) closeBoard(); });
  }

  function openBoard(fromTap) {
    if (!overlay) build();
    overlay.classList.add("open");
    document.documentElement.classList.add("taps-lock");
    if (location.hash !== "#taps") history.pushState(null, "", "#taps");
    if (!clientId()) { showGate("setup"); return; }
    if (savedToken()) { setStatus("Loading\u2026"); load().then(startPoll).catch(function (e) { handleError(e); }); return; }
    if (fromTap) unlock(false); else showGate("locked");
  }

  function closeBoard() {
    if (!overlay) return;
    overlay.classList.remove("open");
    document.documentElement.classList.remove("taps-lock");
    stopPoll();
    items = []; answers = []; editing = {}; modifyDraft = {};
    if (body) body.textContent = "";
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
