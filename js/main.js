/* Zambia Bikes — shared site behaviour
   Nav, tour cards, request-to-join modal, join form, reveal animations.
   All "requests to join" are stored locally and reviewed by the Grown-Up
   Crew before anyone becomes a member — nothing on this site is automatic. */

(function () {
  "use strict";

  document.documentElement.classList.add("js");

  var DATA = window.ZB_DATA || { tours: [], events: [] };
  var STORE_KEY = "zb_requests";

  /* ---------- tiny helpers ---------- */

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function loadRequests() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      var list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list : [];
    } catch (e) { return []; }
  }

  function saveRequests(list) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(list)); } catch (e) { /* private mode */ }
  }

  function newRequestId() {
    var n = Math.floor(1000 + Math.random() * 9000);
    return "ZB-2026-" + n;
  }

  function findTour(id) {
    var all = DATA.tours.concat(DATA.events);
    for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
    return null;
  }

  /* ---------- mini scene illustrations (SVG per tour theme) ---------- */

  var TREE_MIOMBO = function (x, y, s, c) {
    return '<g transform="translate(' + x + ' ' + y + ') scale(' + s + ')" fill="' + c + '">' +
      '<rect x="-3" y="-18" width="6" height="20" rx="2"/>' +
      '<ellipse cx="0" cy="-26" rx="22" ry="12"/>' +
      '<ellipse cx="-13" cy="-19" rx="12" ry="7"/>' +
      '<ellipse cx="13" cy="-19" rx="12" ry="7"/></g>';
  };

  var TREE_BAOBAB = function (x, y, s, c) {
    return '<g transform="translate(' + x + ' ' + y + ') scale(' + s + ')" fill="' + c + '">' +
      '<path d="M -9 0 C -8 -14 -8 -24 -10 -32 C -18 -35 -25 -41 -28 -49 C -21 -44 -14 -41 -9 -40 ' +
      'C -11 -46 -15 -51 -20 -56 C -13 -53 -8 -48 -5 -43 C -5 -51 -6 -58 -9 -65 C -3 -58 0 -50 1 -43 ' +
      'C 5 -49 11 -53 19 -55 C 13 -49 8 -44 5 -39 C 12 -41 19 -40 25 -37 C 17 -35 10 -33 5 -30 ' +
      'C 3 -21 3 -11 4 0 Z"/></g>';
  };

  var sceneSeq = 0;

  function sceneSVG(kind) {
    /* unique gradient ids per card — duplicate ids are invalid HTML */
    var uid = "s" + (sceneSeq++);
    var head = '<svg viewBox="0 0 400 200" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">';
    var defs =
      '<defs>' +
      '<linearGradient id="g-sunset-' + uid + '" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFE9A8"/><stop offset=".55" stop-color="#F7B733"/><stop offset="1" stop-color="#E8791D"/></linearGradient>' +
      '<linearGradient id="g-forest-' + uid + '" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#EAF7E0"/><stop offset="1" stop-color="#BFE3B4"/></linearGradient>' +
      '<linearGradient id="g-river-' + uid + '" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#D5F1EC"/><stop offset="1" stop-color="#7ACCC0"/></linearGradient>' +
      '<linearGradient id="g-lake-' + uid + '" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFD98E"/><stop offset="1" stop-color="#F08A3C"/></linearGradient>' +
      '</defs>';
    var s = head + defs;

    if (kind === "miombo") {
      s += '<rect width="400" height="200" fill="url(#g-forest-' + uid + ')"/>' +
        '<circle cx="330" cy="42" r="26" fill="#FFF3C4"/>' +
        '<path d="M0 150 Q 100 118 200 142 T 400 138 L 400 200 L 0 200 Z" fill="#1F7A48"/>' +
        TREE_MIOMBO(60, 148, 1.25, "#14532D") + TREE_MIOMBO(150, 140, 0.9, "#1F7A48") +
        TREE_MIOMBO(255, 146, 1.1, "#14532D") + TREE_MIOMBO(340, 138, 0.8, "#1F7A48") +
        '<path d="M0 178 Q 130 158 250 172 T 400 168 L 400 200 L 0 200 Z" fill="#0C2E1C"/>' +
        '<path d="M20 190 q 40 -10 90 -4" stroke="#FAEFDA" stroke-width="4" stroke-dasharray="1 10" stroke-linecap="round" fill="none"/>';
    } else if (kind === "falls") {
      s += '<rect width="400" height="200" fill="url(#g-river-' + uid + ')"/>' +
        '<path d="M0 70 L 150 70 L 150 20 L 0 26 Z" fill="#2A9D8F" opacity=".55"/>' +
        '<path d="M250 70 L 400 70 L 400 22 L 250 20 Z" fill="#2A9D8F" opacity=".55"/>' +
        '<rect x="150" y="20" width="100" height="120" fill="#F3FBFA"/>' +
        '<path d="M158 20 v 120 M175 20 v 120 M200 20 v 120 M225 20 v 120 M242 20 v 120" stroke="#BDE8E2" stroke-width="6" stroke-linecap="round"/>' +
        '<ellipse cx="200" cy="146" rx="90" ry="18" fill="#FFFFFF" opacity=".85"/>' +
        '<path d="M120 96 a 80 80 0 0 1 160 0" fill="none" stroke="#E8791D" stroke-width="5" opacity=".6"/>' +
        '<path d="M128 96 a 72 72 0 0 1 144 0" fill="none" stroke="#F7B733" stroke-width="5" opacity=".6"/>' +
        '<path d="M136 96 a 64 64 0 0 1 128 0" fill="none" stroke="#2A9D8F" stroke-width="5" opacity=".6"/>' +
        '<path d="M0 160 Q 100 140 220 158 T 400 152 L 400 200 L 0 200 Z" fill="#14532D"/>' +
        TREE_MIOMBO(50, 162, 0.9, "#0C2E1C") + TREE_MIOMBO(350, 158, 0.9, "#0C2E1C");
    } else if (kind === "baobab") {
      s += '<rect width="400" height="200" fill="url(#g-sunset-' + uid + ')"/>' +
        '<circle cx="200" cy="96" r="34" fill="#FFF3C4"/>' +
        '<path d="M0 150 Q 120 122 240 146 T 400 140 L 400 200 L 0 200 Z" fill="#8A5A00" opacity=".35"/>' +
        TREE_BAOBAB(105, 158, 1.5, "#43290F") + TREE_BAOBAB(300, 150, 1.0, "#5A3812") +
        '<path d="M0 170 Q 140 150 260 166 T 400 160 L 400 200 L 0 200 Z" fill="#43290F"/>' +
        '<g stroke="#43290F" stroke-width="3" stroke-linecap="round" fill="none"><path d="M320 60 q 7 -7 14 0 q 7 -7 14 0"/><path d="M60 46 q 6 -6 12 0 q 6 -6 12 0"/></g>';
    } else if (kind === "lake") {
      s += '<rect width="400" height="200" fill="url(#g-sunset-' + uid + ')"/>' +
        '<circle cx="200" cy="102" r="30" fill="#FFF3C4"/>' +
        '<rect y="112" width="400" height="88" fill="url(#g-lake-' + uid + ')"/>' +
        '<path d="M150 128 h 100 M138 142 h 124 M158 156 h 84" stroke="#FFF3C4" stroke-width="5" stroke-linecap="round" opacity=".8"/>' +
        '<path d="M0 190 Q 100 176 200 188 T 400 184 L 400 200 L 0 200 Z" fill="#43290F"/>' +
        '<g fill="#43290F"><ellipse cx="330" cy="146" rx="22" ry="8"/><circle cx="349" cy="141" r="7"/><circle cx="352" cy="138" r="1.6" fill="#FFD98E"/></g>' +
        '<g stroke="#43290F" stroke-width="3" stroke-linecap="round" fill="none"><path d="M70 60 q 7 -7 14 0 q 7 -7 14 0"/></g>';
    } else if (kind === "pump") {
      s += '<rect width="400" height="200" fill="url(#g-forest-' + uid + ')"/>' +
        '<circle cx="60" cy="46" r="24" fill="#FFF3C4"/>' +
        '<path d="M0 160 Q 50 120 100 160 T 200 160 T 300 160 T 400 160 L 400 200 L 0 200 Z" fill="#B0713A"/>' +
        '<path d="M0 160 Q 50 120 100 160 T 200 160 T 300 160 T 400 160" fill="none" stroke="#8A5324" stroke-width="6"/>' +
        '<g><line x1="100" y1="118" x2="100" y2="150" stroke="#14532D" stroke-width="4"/><path d="M100 118 l 26 8 l -26 8 Z" fill="#E8791D"/></g>' +
        '<g><line x1="300" y1="118" x2="300" y2="150" stroke="#14532D" stroke-width="4"/><path d="M300 118 l 26 8 l -26 8 Z" fill="#2A9D8F"/></g>' +
        '<g fill="none" stroke="#0C2E1C" stroke-width="5" stroke-linecap="round"><circle cx="188" cy="128" r="12"/><circle cx="222" cy="128" r="12"/><path d="M188 128 l 12 0 l 8 -12 l 14 12 M200 128 l -4 -10 l 12 -2"/></g>';
    } else { /* safari */
      s += '<rect width="400" height="200" fill="url(#g-sunset-' + uid + ')"/>' +
        '<circle cx="320" cy="70" r="38" fill="#FFF3C4"/>' +
        '<path d="M0 148 Q 130 132 260 144 T 400 140 L 400 200 L 0 200 Z" fill="#8A5A00" opacity=".4"/>' +
        '<g fill="#43290F">' +
        '<path d="M60 158 c 0 -10 6 -16 14 -16 c 4 -8 14 -8 18 -2 c 8 -2 14 4 14 10 l 2 8 l -6 0 l -2 12 l -5 0 l -1 -8 l -14 0 l -1 8 l -5 0 l -2 -12 Z"/>' +
        '<path d="M96 132 c 3 -6 9 -6 11 0 l -2 6 l -7 0 Z"/>' +
        '<g><rect x="292" y="128" width="26" height="16" rx="7"/><rect x="312" y="106" width="7" height="30" rx="3"/><circle cx="317" cy="104" r="6"/><rect x="295" y="142" width="5" height="14"/><rect x="309" y="142" width="5" height="14"/></g>' +
        '</g>' +
        TREE_BAOBAB(200, 150, 1.1, "#43290F") +
        '<path d="M0 172 Q 140 156 260 168 T 400 164 L 400 200 L 0 200 Z" fill="#43290F"/>';
    }
    return s + "</svg>";
  }

  /* ---------- tour cards ---------- */

  var LEVELS = {
    easy: { label: "Easy Rider", cls: "chip--easy" },
    trail: { label: "Trail Star", cls: "chip--trail" },
    hero: { label: "Downhill Hero", cls: "chip--hero" }
  };

  function tourCardHTML(t) {
    var lv = LEVELS[t.level] || LEVELS.easy;
    var low = t.spotsLeft <= 4;
    var spotsText = low ? "Only " + t.spotsLeft + " spots left!" : t.spotsLeft + " of " + t.spotsTotal + " spots open";
    return (
      '<article class="tour-card reveal">' +
        '<div class="tour-scene">' + sceneSVG(t.scene) +
          '<span class="tour-date">' + esc(t.dateLabel) + "</span></div>" +
        '<div class="tour-body">' +
          "<h3>" + esc(t.name) + "</h3>" +
          '<p class="tour-place">📍 ' + esc(t.place) + "</p>" +
          '<p class="tour-blurb">' + esc(t.blurb) + "</p>" +
        "</div>" +
        '<div class="tour-meta">' +
          '<span class="chip ' + lv.cls + '">' + lv.label + "</span>" +
          '<span class="chip chip--info">Ages ' + esc(t.ages) + "</span>" +
          (t.km ? '<span class="chip chip--info">' + t.km + " km</span>" : '<span class="chip chip--info">Skills day</span>') +
        "</div>" +
        '<div class="tour-foot">' +
          '<span class="tour-spots' + (low ? " is-low" : "") + '">' + spotsText + "</span>" +
          '<button type="button" class="btn btn--copper btn--small" data-request="' + esc(t.id) + '">Request to join</button>' +
        "</div>" +
      "</article>"
    );
  }

  function renderTourGrids() {
    var grids = document.querySelectorAll("[data-tours]");
    for (var i = 0; i < grids.length; i++) {
      var el = grids[i];
      var list = el.getAttribute("data-tours") === "events" ? DATA.events : DATA.tours;
      var limit = parseInt(el.getAttribute("data-limit") || "0", 10);
      var items = limit > 0 ? list.slice(0, limit) : list;
      var html = "";
      for (var j = 0; j < items.length; j++) html += tourCardHTML(items[j]);
      el.innerHTML = html;
    }
  }

  /* ---------- request-to-join modal ---------- */

  function ensureModal() {
    var dlg = document.getElementById("zb-request-modal");
    if (dlg) return dlg;
    dlg = document.createElement("dialog");
    dlg.className = "modal";
    dlg.id = "zb-request-modal";
    dlg.setAttribute("aria-labelledby", "zb-modal-title");
    dlg.innerHTML =
      '<div class="modal-head"><h3 id="zb-modal-title">Request to join</h3>' +
      '<button type="button" class="modal-close" data-close aria-label="Close">✕</button></div>' +
      '<div class="modal-body"></div>';
    document.body.appendChild(dlg);
    dlg.addEventListener("click", function (e) {
      if (e.target === dlg || e.target.hasAttribute("data-close")) dlg.close();
    });
    return dlg;
  }

  function modalFormHTML(tour) {
    return (
      '<p>Ask to ride <strong>' + esc(tour.name) + "</strong> — " + esc(tour.dateLabel) + " at " + esc(tour.place) + ".</p>" +
      '<form id="zb-request-form">' +
        '<div class="field-row">' +
          '<div class="field"><label for="rq-name">Rider first name <span class="req">*</span></label>' +
          '<input id="rq-name" name="rider" type="text" required maxlength="20" autocomplete="off"></div>' +
          '<div class="field"><label for="rq-age">Rider age <span class="req">*</span></label>' +
          '<select id="rq-age" name="age" required><option value="">Pick…</option>' +
          "<option>6</option><option>7</option><option>8</option><option>9</option><option>10</option>" +
          "<option>11</option><option>12</option><option>13</option><option>14</option></select></div>" +
        "</div>" +
        '<div class="field"><label for="rq-parent">Parent or guardian name <span class="req">*</span></label>' +
        '<input id="rq-parent" name="parentName" type="text" required maxlength="60"></div>' +
        '<div class="field"><label for="rq-email">Parent or guardian email <span class="req">*</span></label>' +
        '<input id="rq-email" name="parentEmail" type="email" required maxlength="80"></div>' +
        '<label class="checkbox-row"><input type="checkbox" required>' +
        "<span>My parent or guardian is filling this in with me (or said yes!).</span></label>" +
        '<button type="submit" class="btn btn--copper btn--big" style="width:100%">Prepare my request 🚵</button>' +
        '<div class="form-note"><p><strong>What happens next:</strong> your request is prepared here, your parent ' +
        "or guardian sends it to the Grown-Up Crew with one tap, and a real adult replies to confirm before your " +
        "spot is booked. Nothing is automatic — that's the club promise.</p></div>" +
      "</form>"
    );
  }

  function requestMailto(req, tourName) {
    var subject = (req.type === "tour" ? "Ride request " : "Membership request ") + req.id +
      (tourName ? " — " + tourName : "");
    var lines = [
      (req.type === "tour" ? "Ride" : "Membership") + " request " + req.id,
      tourName ? "Tour: " + tourName : null,
      "Rider first name: " + req.rider,
      "Rider age: " + req.age,
      "Parent/guardian: " + req.parentName,
      "Contact email: " + req.parentEmail,
      req.province ? "Province: " + req.province : null,
      req.level ? "Riding level: " + req.level : null,
      req.about ? "About the rider: " + req.about : null,
      "",
      "Sent from the Zambia Bikes website."
    ].filter(Boolean);
    return "mailto:hello@zambiabikes.org?subject=" + encodeURIComponent(subject) +
      "&body=" + encodeURIComponent(lines.join("\n"));
  }

  function modalSuccessHTML(req, tour) {
    return (
      '<div style="text-align:center;padding:0.5rem 0 0.2rem"><span style="font-size:3rem">🎉</span></div>' +
      '<h3 style="text-align:center">Request ready, ' + esc(req.rider) + "!</h3>" +
      '<p style="text-align:center">Your request for <strong>' + esc(tour.name) + "</strong> is packed and ready for the Grown-Up Crew.</p>" +
      '<p style="text-align:center"><span class="chip chip--trail">Status: pending review</span> ' +
      '<span class="chip chip--info">Ref ' + esc(req.id) + "</span></p>" +
      '<p style="text-align:center;color:var(--ink-soft);font-size:0.95rem">One more pedal stroke: ask ' + esc(req.parentName) +
      " to tap the button — the email to the Crew is already written. A real adult reads it and replies within 3 days, before the spot is booked.</p>" +
      '<div style="display:flex;flex-wrap:wrap;justify-content:center;gap:0.6rem;margin-top:0.8rem">' +
      '<a class="btn btn--copper" href="' + requestMailto(req, tour.name) + '">Send it to the Crew ✉️</a>' +
      '<button type="button" class="btn btn--ghost" data-close>Done!</button></div>'
    );
  }

  function openRequestModal(tourId) {
    var tour = findTour(tourId);
    if (!tour) return;
    var dlg = ensureModal();
    var body = dlg.querySelector(".modal-body");
    dlg.querySelector("#zb-modal-title").textContent = "Request to join · " + tour.name;
    body.innerHTML = modalFormHTML(tour);
    var form = body.querySelector("#zb-request-form");
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var req = {
        id: newRequestId(),
        type: "tour",
        tourId: tour.id,
        tourName: tour.name,
        rider: form.rider.value.trim(),
        age: form.age.value,
        parentName: form.parentName.value.trim(),
        parentEmail: form.parentEmail.value.trim(),
        status: "pending",
        ts: new Date().toISOString()
      };
      var list = loadRequests();
      list.push(req);
      saveRequests(list);
      body.innerHTML = modalSuccessHTML(req, tour);
    });
    if (typeof dlg.showModal === "function") dlg.showModal();
    else dlg.setAttribute("open", "open");
  }

  document.addEventListener("click", function (e) {
    var btn = e.target.closest ? e.target.closest("[data-request]") : null;
    if (btn) openRequestModal(btn.getAttribute("data-request"));
  });

  /* ---------- membership join form (join.html) ---------- */

  function initJoinForm() {
    var form = document.querySelector("[data-join-form]");
    if (!form) return;
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var levelInput = form.querySelector('input[name="level"]:checked');
      var req = {
        id: newRequestId(),
        type: "membership",
        rider: (form.rider ? form.rider.value : "").trim(),
        age: form.age ? form.age.value : "",
        parentName: (form.parentName ? form.parentName.value : "").trim(),
        parentEmail: (form.parentEmail ? form.parentEmail.value : "").trim(),
        province: form.province ? form.province.value : "",
        level: levelInput ? levelInput.value : "",
        about: (form.about ? form.about.value : "").trim().slice(0, 500),
        status: "pending",
        ts: new Date().toISOString()
      };
      var list = loadRequests();
      list.push(req);
      saveRequests(list);
      renderRequestStatus();
      form.reset();
      var panel = document.querySelector("[data-request-status]");
      if (panel) panel.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }

  function renderRequestStatus() {
    var host = document.querySelector("[data-request-status]");
    if (!host) return;
    var list = loadRequests();
    var memberships = list.filter(function (r) { return r.type === "membership"; });
    if (!memberships.length) { host.innerHTML = ""; return; }
    var r = memberships[memberships.length - 1];
    var when = r.ts ? new Date(r.ts).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "";
    host.innerHTML =
      '<div class="status-panel reveal is-visible"><h3>🛡️ Membership request ready</h3>' +
      "<p><strong>" + esc(r.rider) + "</strong>'s request was prepared on " + esc(when) +
      ". Ask " + esc(r.parentName || "your parent or guardian") + " to send it — the email to the Grown-Up Crew is already written.</p>" +
      '<p><span class="chip chip--trail">Status: pending review</span> <span class="chip chip--info">Ref ' + esc(r.id) + "</span></p>" +
      '<p style="margin-bottom:0.6rem">A real adult reads it and replies by email before membership is unlocked. Changed your mind?</p>' +
      '<div style="display:flex;flex-wrap:wrap;gap:0.6rem">' +
      '<a class="btn btn--copper btn--small" href="' + requestMailto(r, null) + '">Send it to the Crew ✉️</a>' +
      '<button type="button" class="btn btn--ghost btn--small" data-withdraw>Withdraw request</button></div></div>';
    var btn = host.querySelector("[data-withdraw]");
    if (btn) btn.addEventListener("click", function () {
      saveRequests(loadRequests().filter(function (x) { return x.id !== r.id; }));
      renderRequestStatus();
    });
  }

  /* ---------- next ride pill ---------- */

  function initNextRide() {
    var el = document.querySelector("[data-next-ride]");
    if (!el || !DATA.tours.length) return;
    var today = new Date(); today.setHours(0, 0, 0, 0);
    var next = null;
    var all = DATA.tours.concat(DATA.events);
    for (var i = 0; i < all.length; i++) {
      var d = new Date(all[i].dateISO + "T00:00:00");
      if (d >= today && (!next || d < new Date(next.dateISO + "T00:00:00"))) next = all[i];
    }
    if (!next) { el.textContent = "New season of rides announced soon!"; return; }
    var days = Math.round((new Date(next.dateISO + "T00:00:00") - today) / 86400000);
    var inTxt = days === 0 ? "today!" : days === 1 ? "tomorrow!" : "in " + days + " days";
    el.innerHTML = "🚵 Next ride: <strong>" + esc(next.name) + "</strong> · " + inTxt;
  }

  /* ---------- nav, reveal, footer ---------- */

  function initNav() {
    var toggle = document.querySelector(".nav-toggle");
    var nav = document.getElementById("site-nav");
    if (!toggle || !nav) return;
    toggle.addEventListener("click", function () {
      var open = nav.classList.toggle("is-open");
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
    });
  }

  function initReveal() {
    var items = document.querySelectorAll(".reveal");
    if (!("IntersectionObserver" in window)) {
      document.documentElement.classList.add("no-observer");
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add("is-visible"); io.unobserve(en.target); }
      });
    }, { threshold: 0.12 });
    items.forEach(function (el) { io.observe(el); });
  }

  function initYear() {
    var els = document.querySelectorAll("[data-year]");
    for (var i = 0; i < els.length; i++) els[i].textContent = String(new Date().getFullYear());
  }

  /* ---------- boot ---------- */

  function boot() {
    renderTourGrids();
    initJoinForm();
    renderRequestStatus();
    initNextRide();
    initNav();
    initYear();
    initReveal(); /* after tour grids render so new cards are observed */
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
