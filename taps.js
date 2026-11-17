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

  function load() {
    return api("/values:batchGet?ranges=Items!A1:L&ranges=Answers!A1:E&majorDimension=ROWS").then(function (d) {
      var vr = d.valueRanges || [];
      items = rowsToObjects(vr[0] && vr[0].values);
      answers = rowsToObjects(vr[1] && vr[1].values);
      render();
    });
  }

  function appendAnswer(it, choice) {
    var ts = new Date().toISOString();
    var local = { case: it.case, patient: it.patient, choice: choice, ts: ts, status: "pending", _local: true };
    answers.push(local);
    delete editing[it.case];
    render();
    var payload = { values: [[it.case, it.patient, choice, ts, "pending"]] };
    return api("/values/" + encodeURIComponent("Answers!A:E") + ":append?valueInputOption=RAW&insertDataOption=INSERT_ROWS", {
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
    var bar = answered ? "done" : (it.bar || "wait");
    var card = el("article", "tap-row bar-" + bar + (answered ? " answered" : ""));
    card.appendChild(el("div", "tap-bar"));
    var main = el("div", "tap-main");

    var top = el("div", "tap-top");
    top.appendChild(el("span", "tap-name", it.patient));
    var pills = split(it.pills);
    if (it.bar === "purple" || pills.some(function (p) { return /PURPLE STAR/i.test(p); })) {
      var star = el("span", "tap-star", "\u2605"); star.setAttribute("aria-label", "purple star"); top.appendChild(star);
    }
    pills.filter(function (p) { return !/PURPLE STAR/i.test(p); }).forEach(function (p) {
      var cls = /RUSH/i.test(p) ? "pill stop" : /PRIORITY/i.test(p) ? "pill purple" : /DONE/i.test(p) ? "pill done" : "pill";
      top.appendChild(el("span", cls, p));
    });
    main.appendChild(top);

    var meta = [];
    if (it.case && /^\d+$/.test(it.case)) meta.push("#" + it.case);
    if (it.plan) meta.push("plan " + it.plan);
    if (it.appt) meta.push("appt " + it.appt);
    main.appendChild(el("div", "tap-meta", meta.join(" \u00b7 ")));
    main.appendChild(el("div", "tap-reason", it.reason));

    var acts = el("div", "tap-acts");
    if (answered) {
      var mark = el("span", "tap-picked", "\u2713 " + ans.choice);
      acts.appendChild(mark);
      var st = String(ans.status || "pending").toLowerCase();
      var pend = el("span", "tap-pending " + (st === "confirmed" ? "ok" : ""), st === "confirmed" ? "confirmed" : (ans._local ? "saving\u2026" : "pending"));
      acts.appendChild(pend);
      if (st !== "confirmed") {
        var ch = el("button", "tap-link", "change");
        ch.type = "button";
        ch.addEventListener("click", function () { editing[it.case] = true; render(); });
        acts.appendChild(ch);
      }
    } else {
      split(it.buttons).forEach(function (choice, i) {
        var b = el("button", "tap-btn" + (i === 0 ? " primary" : ""), choice);
        b.type = "button";
        b.addEventListener("click", function () {
          withToken(function (err) {
            if (err) { handleError({ status: 0 }, "Google sign-in didn't finish. Tap again."); return; }
            appendAnswer(it, choice);
          });
        });
        acts.appendChild(b);
      });
    }
    var a = el("a", "tap-open", it.open_label || "Open plan");
    a.href = it.patientId ? PLAN_URL + encodeURIComponent(it.patientId) : LIST_URL;
    a.target = "_blank"; a.rel = "noopener noreferrer";
    acts.appendChild(a);
    main.appendChild(acts);
    card.appendChild(main);
    return card;
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

  var openState = {};
  function render() {
    if (!body) return;
    body.querySelectorAll("details.tap-group").forEach(function (d) { openState[d.dataset.key] = d.open; });
    body.textContent = "";
    var bySec = { tap: [], in_progress: [], done: [], not_urgent: [] };
    items.forEach(function (it) { (bySec[it.section] || bySec.tap).push(it); });
    var rank = { purple: 0, stop: 1, wait: 2, go: 3, done: 4 };
    bySec.tap.sort(function (x, y) {
      var ax = latestAnswer(x) ? 1 : 0, ay = latestAnswer(y) ? 1 : 0;
      return ax - ay || (rank[x.bar] == null ? 5 : rank[x.bar]) - (rank[y.bar] == null ? 5 : rank[y.bar]);
    });
    var open = bySec.tap.filter(function (it) { return !latestAnswer(it); }).length;
    var sections = [
      ["tap", "Needs a tap", bySec.tap, true],
      ["in_progress", "In progress", bySec.in_progress, false],
      ["done", "Done", bySec.done, false],
      ["not_urgent", "Not urgent", bySec.not_urgent, false]
    ];
    sections.forEach(function (s) {
      if (s[0] === "in_progress" && !s[2].length) return;
      var g = group(s[1], s[2], openState[s[0]] != null ? openState[s[0]] : s[3]);
      g.dataset.key = s[0];
      body.appendChild(g);
    });
    var newest = items.reduce(function (m, it) { var t = Date.parse(it.updated) || 0; return t > m ? t : m; }, 0);
    var when = newest ? new Date(newest).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
    setStatus(open + " waiting on you" + (when ? " \u00b7 list as of " + when + " ET" : ""));
  }

  function showGate(kind, msg) {
    stopPoll();
    items = []; answers = [];
    body.textContent = "";
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
    head.appendChild(h);
    var refresh = el("button", "taps-icon-btn", "\u21bb"); refresh.type = "button"; refresh.title = "Refresh"; refresh.setAttribute("aria-label", "Refresh");
    refresh.addEventListener("click", function () { if (savedToken()) load().catch(function (e) { handleError(e); }); else unlock(false); });
    var close = el("button", "taps-icon-btn", "\u2715"); close.type = "button"; close.title = "Close"; close.setAttribute("aria-label", "Close");
    close.addEventListener("click", closeBoard);
    var btns = el("div", "taps-head-btns"); btns.appendChild(refresh); btns.appendChild(close);
    head.appendChild(btns);
    panel.appendChild(head);
    body = el("div", "taps-body");
    panel.appendChild(body);
    panel.appendChild(el("p", "taps-legend", "red = stop \u00b7 orange = waiting on you \u00b7 green = ready \u00b7 grey = done \u00b7 \u2605 purple = star priority. Private: real patient data."));
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
    items = []; answers = []; editing = {};
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
