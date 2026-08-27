/* ==========================================================================
   ZAMBIA RUSH 3D — Three.js renderer + game controller
   The simulation itself lives in js/game3d-core.js (window.ZR3); this file
   only draws the world and wires the UI. Same club promises as everywhere:
   no chat, no accounts, ghosts instead of strangers.
   ========================================================================== */

import * as THREE from "three";
import { mergeGeometries } from "./vendor/addons/utils/BufferGeometryUtils.js";
import { Sky } from "./vendor/addons/objects/Sky.js";
import { Water } from "./vendor/addons/objects/Water.js";
import { EffectComposer } from "./vendor/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "./vendor/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "./vendor/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "./vendor/addons/postprocessing/OutputPass.js";
import { FXAAPass } from "./vendor/addons/postprocessing/FXAAPass.js";

(function () {
  "use strict";

  var CORE = window.ZR3;
  var canvas = document.getElementById("game-canvas");
  if (!canvas || !CORE) return;

  /* ---------- WebGL check with graceful 2D fallback ---------- */

  var glOK = (function () {
    try {
      var c = document.createElement("canvas");
      return !!(window.WebGLRenderingContext && (c.getContext("webgl2") || c.getContext("webgl")));
    } catch (e) { return false; }
  })();
  if (!glOK) {
    var fb = document.getElementById("webgl-fallback");
    if (fb) fb.hidden = false;
    var menuEl = document.getElementById("screen-menu");
    if (menuEl) menuEl.hidden = true;
    return;
  }

  /* ---------- tiny helpers ---------- */

  function $(id) { return document.getElementById(id); }

  function lsGet(k, fallback) {
    try {
      var v = localStorage.getItem(k);
      return v == null ? fallback : JSON.parse(v);
    } catch (e) { return fallback; }
  }
  function lsSet(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* full/private */ }
  }

  /* Four different results screens share one panel. Every one of them shows its
     own row of buttons, so they all go through here: hide the lot, show the one.
     Adding a fifth row without touching this function is not possible. */
  var RESULT_ROWS = ["results-row", "results-row-tour", "results-row-vs", "results-row-mp"];
  function showResultsRow(id) {
    RESULT_ROWS.forEach(function (rid) {
      var r = $(rid);
      if (r) r.hidden = rid !== id;
    });
  }

  function fmtTime(ms) {
    /* a dash, not "NaN:NaN" — a time nobody has set is a blank, and a child at
       the end of a run that already went wrong should not be shown a stack
       trace's idea of a number */
    if (!isFinite(ms)) return "—";
    ms = Math.round(ms / 100) * 100;
    var m = Math.floor(ms / 60000);
    var s = (ms % 60000) / 1000;
    var ss = s.toFixed(1);
    if (s < 10) ss = "0" + ss;
    return m + ":" + ss;
  }

  function validGhostShape(g) {
    return g && typeof g === "object" && Array.isArray(g.samples) && g.samples.length > 1 &&
      isFinite(Number(g.timeMs));
  }

  /* ---------- persistent state (zr3_* keys; profile shared with classic) ---------- */

  var profile = lsGet("zr_profile", { name: "", jersey: "#1F7A48" });
  /* player two on the same keyboard keeps their own name and jersey, so the
     kid on the arrow keys is somebody, not "Player 2" */
  var profile2 = lsGet("zr_profile2", { name: "", jersey: "#E8791D" });
  if (!profile || typeof profile !== "object") profile = { name: "", jersey: "#1F7A48" };
  var BIKES = window.ZB_BIKES;
  var career = BIKES ? BIKES.loadCareer() : null;
  function currentBikeCfg() { return BIKES ? BIKES.loadConfig(career) : null; }
  var bests = lsGet("zr3_best", {});
  if (!bests || typeof bests !== "object" || Array.isArray(bests)) bests = {};
  var scores = lsGet("zr3_scores", {});
  if (!scores || typeof scores !== "object" || Array.isArray(scores)) scores = {};
  var friends = lsGet("zr3_friends", []);
  if (!Array.isArray(friends)) friends = [];
  friends = friends.filter(function (f) { return validGhostShape(f) && CORE.TRACKS3[f.track]; });
  var muted = lsGet("zr3_muted", false);
  var ghostsOn = lsGet("zr3_ghoston", true);
  var lightMode = lsGet("zr3_light", false);

  /* ---------- audio (little synth) ---------- */

  var AC = null, masterGain = null;
  function audio() {
    if (muted) return null;
    if (!AC) {
      try {
        AC = new (window.AudioContext || window.webkitAudioContext)();
        masterGain = AC.createGain();
        masterGain.gain.value = 0.15;
        masterGain.connect(AC.destination);
      } catch (e) { return null; }
    }
    if (AC.state === "suspended") AC.resume();
    return AC;
  }
  function tone(freq, dur, type, when, slide) {
    var ac = audio();
    if (!ac) return;
    var t0 = ac.currentTime + (when || 0);
    var osc = ac.createOscillator();
    var g = ac.createGain();
    osc.type = type || "square";
    osc.frequency.setValueAtTime(freq, t0);
    if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(30, slide), t0 + dur);
    g.gain.setValueAtTime(0.9, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    osc.connect(g); g.connect(masterGain);
    osc.start(t0); osc.stop(t0 + dur + 0.02);
  }
  var SFX = {
    coin: function () { tone(980, 0.09, "square"); tone(1470, 0.12, "square", 0.06); },
    land: function () { tone(150, 0.1, "sine", 0, 70); },
    hard: function () { tone(120, 0.16, "sine", 0, 55); },
    crash: function () { tone(300, 0.35, "sawtooth", 0, 60); },
    hop: function () { tone(420, 0.1, "triangle", 0, 660); },
    bigair: function () { tone(520, 0.18, "triangle", 0, 990); },
    gate: function () { tone(740, 0.09, "triangle"); },
    bell: function () { tone(1610, 0.35, "triangle"); tone(2130, 0.5, "triangle", 0.09); },
    splash: function () { tone(320, 0.28, "sine", 0, 70); tone(900, 0.18, "triangle", 0.03, 200); },
    turboOn: function () { tone(300, 0.22, "sawtooth", 0, 900); tone(680, 0.2, "square", 0.05, 1180); },
    turboOff: function () { tone(520, 0.22, "sawtooth", 0, 190); },
    turboTap: function () { tone(1180, 0.04, "square"); },
    trick: function (combo) {
      tone(620, 0.12, "triangle", 0, 1180);
      tone(980, 0.14, "square", 0.07, 1560);
      if (combo) tone(1320, 0.18, "triangle", 0.15, 1980);
    },
    count: function (hi) { tone(hi ? 880 : 440, 0.14, "square"); },
    finish: function () { [523, 659, 784, 1047].forEach(function (f, i) { tone(f, 0.16, "triangle", i * 0.12); }); },
    /* thunder rolls in a while after the flash — delay is distance */
    thunder: function (delay) {
      tone(58, 1.5, "sine", delay, 32);
      tone(41, 2.1, "sine", delay + 0.12, 26);
      tone(96, 0.7, "triangle", delay + 0.05, 44);
    }
  };

  /* ---------- input ---------- */

  function newInput() {
    return { pedal: false, brake: false, left: false, right: false, hop: false, turbo: false };
  }
  /* one set of controls per rider; `input` always points at player one, so
     every existing single-player code path is untouched */
  var inputs = [newInput(), newInput()];
  var input = inputs[0];
  /* every physical turbo press queues one tap; the physics loop consumes them
     one per step so a fast tapper never loses a press between frames */
  var turboTaps = [0, 0];

  /* One player has the whole keyboard. Two players split it down the middle:
     player one keeps the left hand side (WASD, shift to hop, Q to turbo) and
     player two takes the right (arrows, right shift to hop, Enter to turbo).
     Both turbo keys are big and reachable, because turbo is TAPPED as fast as
     a ten-year-old can go. */
  var KEYMAP_1 = {
    ArrowUp: "pedal", KeyW: "pedal",
    ArrowDown: "brake", KeyS: "brake",
    ArrowLeft: "left", KeyA: "left",
    ArrowRight: "right", KeyD: "right",
    Space: "hop"
  };
  /* Hop is deliberately NOT on either Shift: five taps of Shift raises the
     Windows Sticky Keys dialog, which would stop a race dead. Player two hops
     on the slash key, which sits directly above the arrow cluster. */
  var KEYMAP_2 = {
    KeyW: [0, "pedal"], KeyS: [0, "brake"], KeyA: [0, "left"], KeyD: [0, "right"],
    Space: [0, "hop"],
    ArrowUp: [1, "pedal"], ArrowDown: [1, "brake"],
    ArrowLeft: [1, "left"], ArrowRight: [1, "right"],
    Slash: [1, "hop"], NumpadDecimal: [1, "hop"]
  };
  var TURBO_KEY_1 = { KeyK: 0 };
  var TURBO_KEY_2 = { KeyQ: 0, Enter: 1, NumpadEnter: 1 };

  /* what a rider's turbo key is called, for the things that tell them to hit it */
  function turboKeyName(p) {
    if (players() !== 2) return "K";
    return p === 1 ? "ENTER" : "Q";
  }

  /* which rider does this key belong to, and what does it do? */
  function keyBinding(code) {
    if (players() === 2) {
      var b2 = KEYMAP_2[code];
      return b2 ? { p: b2[0], k: b2[1] } : null;
    }
    var k1 = KEYMAP_1[code];
    return k1 ? { p: 0, k: k1 } : null;
  }
  function turboBinding(code) {
    var t = players() === 2 ? TURBO_KEY_2[code] : TURBO_KEY_1[code];
    return t === undefined ? -1 : t;
  }

  function clearInput() {
    for (var i = 0; i < inputs.length; i++) {
      var q = inputs[i];
      q.pedal = q.brake = q.left = q.right = q.hop = q.turbo = false;
      turboTaps[i] = 0;
    }
    document.querySelectorAll(".tc-btn.is-down").forEach(function (b) { b.classList.remove("is-down"); });
  }

  document.addEventListener("keydown", function (e) {
    if (e.repeat) return;
    if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) return;
    if (e.code === "KeyF") { toggleFullscreen(); e.preventDefault(); return; }
    /* cabinet-style course browsing: left/right steps through the courses */
    if (mode === "menu" && (e.code === "ArrowLeft" || e.code === "ArrowRight")) {
      var ord = CORE.TRACK3_ORDER;
      var at = ord.indexOf(selTrack);
      selectTrack(ord[(at + (e.code === "ArrowRight" ? 1 : ord.length - 1)) % ord.length]);
      e.preventDefault();
      return;
    }
    if (mode === "race" || mode === "count") {
      var tp = turboBinding(e.code);
      if (tp >= 0) { turboTaps[tp]++; e.preventDefault(); return; }
    }
    if (e.code === "KeyB" && mode === "race" && run && run.riders[0].hasBell) { SFX.bell(); return; }
    if (e.code === "KeyP" || e.code === "Escape") {
      if (mode === "race" || mode === "count") { pauseGame(); e.preventDefault(); }
      else if (mode === "pause") { resumeGame(); e.preventDefault(); }
      return;
    }
    var bind = keyBinding(e.code);
    if (bind) {
      if (run) e.preventDefault();      /* Space and the arrows scroll pages */
      inputs[bind.p][bind.k] = true;
    }
  });
  document.addEventListener("keyup", function (e) {
    var bind = keyBinding(e.code);
    if (bind) inputs[bind.p][bind.k] = false;
  });
  window.addEventListener("blur", function () {
    clearInput();
    if (mode === "race" || mode === "count") pauseGame();
  });
  document.addEventListener("visibilitychange", function () {
    if (document.hidden && (mode === "race" || mode === "count")) { clearInput(); pauseGame(); }
  });

  function bindTouch(id, key) {
    var el2 = $(id);
    if (!el2) return;
    var down = function (e) { e.preventDefault(); input[key] = true; el2.classList.add("is-down"); };
    var up = function (e) { e.preventDefault(); input[key] = false; el2.classList.remove("is-down"); };
    el2.addEventListener("pointerdown", down);
    el2.addEventListener("pointerup", up);
    el2.addEventListener("pointercancel", up);
    el2.addEventListener("pointerleave", up);
    el2.addEventListener("contextmenu", function (e) { e.preventDefault(); });
  }
  bindTouch("tc-left", "left");
  bindTouch("tc-right", "right");
  bindTouch("tc-pedal", "pedal");
  bindTouch("tc-brake", "brake");
  bindTouch("tc-hop", "hop");
  (function () {
    var tb = $("tc-turbo");
    if (!tb) return;
    tb.addEventListener("pointerdown", function (e) {
      e.preventDefault();
      if (mode === "race" || mode === "count") turboTaps[0]++;
      tb.classList.add("is-down");
    });
    ["pointerup", "pointercancel", "pointerleave"].forEach(function (ev) {
      tb.addEventListener(ev, function () { tb.classList.remove("is-down"); });
    });
    tb.addEventListener("contextmenu", function (e) { e.preventDefault(); });
  })();

  /* the on-screen pause/exit button — the only way out mid-race on a phone */
  (function () {
    var xb = $("btn-exit");
    if (!xb) return;
    xb.addEventListener("click", function () {
      if (mode === "race" || mode === "count") pauseGame();
      else if (mode === "pause") resumeGame();
    });
  })();

  var isTouch = (window.matchMedia && window.matchMedia("(pointer: coarse)").matches) ||
    (navigator.maxTouchPoints || 0) > 1;
  /* some tablets report a fine pointer when a keyboard case is attached, so
     the first real finger anywhere turns the on-screen controls on for good */
  window.addEventListener("touchstart", function () {
    if (isTouch) return;
    isTouch = true;
    if (stageEl) stageEl.classList.add("has-touch-ui");
    if (mode === "race" || mode === "count") {
      el.touch.hidden = false;
      el.hintKeys.hidden = true;
      el.hintTouch.hidden = false;
    }
  }, { passive: true, once: true });
  var reducedMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (isTouch) {
    var st0 = document.getElementById("game-stage");
    if (st0) st0.classList.add("has-touch-ui");
  }

  /* ---------- DOM refs ---------- */

  var el = {
    hud: $("hud"), time: $("hud-time"), score: $("hud-score"), speed: $("hud-speed"),
    progress: $("hud-progress-fill"), toast: $("trick-toast"), countdown: $("countdown"),
    menu: $("screen-menu"), howto: $("screen-howto"), pause: $("screen-pause"),
    results: $("screen-results"), resultsContent: $("results-content"),
    touch: $("touch-controls"), trackCards: $("track-cards"),
    riderName: $("rider-name"), ghostToggle: $("ghost-toggle"),
    btnSound: $("btn-sound"), btnDetail: $("btn-detail"),
    lbTabs: $("lb-tabs"), lbList: $("lb-list"),
    ghostList: $("ghost-list"), ghostInput: $("ghost-input"), ghostMsg: $("ghost-import-msg"),
    fsBtn: $("btn-fs"), hint: $("controls-hint"), hintKeys: $("hint-keys"), hintTouch: $("hint-touch"),
    hud2: $("hud2"), countdown2: $("countdown-2"), hintKeys2: $("hint-keys-2p"),
    mp: $("screen-mp"), mpBoard: $("mp-board"),
    tour: $("screen-tour"), brief: $("screen-brief"), shop: $("screen-shop"),
    exitBtn: $("btn-exit"), turbo: $("turbo"), turboState: $("turbo-state"),
    turboFill: $("turbo-fill"), turboGain: $("turbo-gain"), turboHint: $("turbo-hint")
  };

  /* news that belongs to the whole race, not to one rider — it goes up in
     both halves, because both of them need to know */
  function toastAll(txt) {
    toast(txt, 0);
    if (players() === 2) toast(txt, 1);
  }

  /* every other toast belongs to a rider; with two of them it lands in that
     rider's own half instead of shouting across both */
  function toast(txt, p) {
    var t = (players() === 2 && p === 1) ? $("trick-toast-2") : el.toast;
    if (!t) t = el.toast;
    t.textContent = txt;
    t.classList.remove("pop");
    void t.offsetWidth;
    t.classList.add("pop");
  }

  /* ====================================================================
     THREE setup
     ==================================================================== */

  /* how many people are riding this screen right now: 1 or 2 */
  var numPlayers = 1;
  function players() { return numPlayers; }

  /* how sharp textures can stay at a grazing angle; filled in once the
     renderer exists and read by aniso() below */
  var MAX_ANISO = 1;

  var viewW = 960, viewH = 540;
  var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: !lightMode });
  renderer.setSize(viewW, viewH, false);
  renderer.setPixelRatio(lightMode ? 1 : Math.min(window.devicePixelRatio || 1, 1.6));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;
  renderer.shadowMap.enabled = !lightMode;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  MAX_ANISO = renderer.capabilities.getMaxAnisotropy();   /* declared above */

  /* A "view" is one player's window on the world: a camera and the chase
     state that drives it. One player has one view; two players have two,
     stacked one above the other in the same canvas. Everything downstream
     (followEnvironment, updateCoins, renderFrame) reads the ACTIVE view
     through the module-level camera/camPos/camLook, which useView() swings
     from one to the other around each half of the frame. */
  function newView() {
    return {
      camera: new THREE.PerspectiveCamera(68, viewW / viewH, 0.1, 4200),
      pos: new THREE.Vector3(),
      look: new THREE.Vector3(),
      snap: true,
      dip: 0,
      shake: 0,
      /* the slice of canvas this view owns, in pixels from the bottom left */
      rect: { x: 0, y: 0, w: viewW, h: viewH }
    };
  }
  var views = [newView(), newView()];
  var camera = views[0].camera;

  /* ---------- post-processing (full detail only): bloom + FXAA ---------- */

  /* The composer is sized to ONE VIEW, not to the canvas. Three.js applies a
     render target's own viewport while rendering into it and only applies the
     renderer's viewport to the final draw onto the canvas — so a half-height
     composer processes half-height buffers (no wasted fill, no bloom bleeding
     across the seam) and its last pass lands in whichever slice the renderer's
     viewport and scissor are pointing at. One composer serves both players. */
  var composer = null, cRenderPass = null, composerH = 0, bloomPass = null;
  function initComposer() {
    if (composer) { composer.dispose(); composer = null; }
    composerH = 0;
    if (lightMode) return;
    var pr = Math.min(window.devicePixelRatio || 1, 1.6);
    var vh = players() === 2 ? Math.floor(viewH / 2) : viewH;
    composer = new EffectComposer(renderer);
    composer.setPixelRatio(pr);
    composer.setSize(viewW, vh);
    composerH = vh;
    cRenderPass = new RenderPass(new THREE.Scene(), camera);
    composer.addPass(cRenderPass);
    /* BLOOM GOES AFTER TONE MAPPING. UnrealBloom thresholds whatever buffer it
       is handed, and before OutputPass that buffer is un-tone-mapped linear
       radiance where the physical sky sits far above 1.0 — so a threshold of
       1.0 selected the ENTIRE sky and smeared it back over the frame as a
       milky veil. Measured on the Copperbelt at midday, the red laterite road
       came out at HLS saturation 0.09 with the veil and 0.65 without it, and
       ground at 80 m went from luminance 186 to 72. After OutputPass the
       threshold means what it looks like it means: only the genuine
       highlights bloom. */
    composer.addPass(new OutputPass());
    /* Threshold in DISPLAY space: 0.86 still caught most of a bright African
       sky and blew the horizon out. 0.93 catches the sun, the water and the
       coins, which is what should glow. */
    bloomPass = new UnrealBloomPass(new THREE.Vector2(viewW, vh), 0.22, 0.28, 0.93);
    composer.addPass(bloomPass);
    var fxaa = new FXAAPass();
    fxaa.setSize(viewW * pr, vh * pr);
    composer.addPass(fxaa);
    /* the composer's targets default to no multisampling, so every edge in
       the scene relies on FXAA alone */
    if (renderer.capabilities.isWebGL2) {
      composer.renderTarget1.samples = 4;
      composer.renderTarget2.samples = 4;
    }
  }
  layoutViews();
  initComposer();

  /* ---------- fullscreen: the stage takes the whole display ---------- */

  var stageEl = document.getElementById("game-stage");
  function setRenderSize(w, h) {
    viewW = w; viewH = h;
    renderer.setSize(w, h, false);
    layoutViews();
    initComposer();
  }

  /* Carve the canvas into one slice per player. Two players get a top and a
     bottom strip: a downhill rider needs to see LEFT and RIGHT to pick a line
     round a tree, so the split runs horizontally and each player keeps the
     full width. */
  function layoutViews() {
    var n = players();
    for (var i = 0; i < views.length; i++) {
      var v = views[i];
      var h = n === 2 ? Math.floor(viewH / 2) : viewH;
      /* player 1 on top: WebGL counts y from the bottom, so P1 sits higher */
      v.rect.x = 0;
      v.rect.y = n === 2 ? (i === 0 ? viewH - h : 0) : 0;
      v.rect.w = viewW;
      v.rect.h = h;
      v.camera.aspect = v.rect.w / Math.max(1, v.rect.h);
      v.camera.updateProjectionMatrix();
    }
  }
  /* Safari (iPad) still ships the webkit-prefixed API */
  function fsElement() { return document.fullscreenElement || document.webkitFullscreenElement || null; }
  function fsRequest(elm) {
    var fn = elm.requestFullscreen || elm.webkitRequestFullscreen;
    if (fn) fn.call(elm);
  }
  function fsExit() {
    var fn = document.exitFullscreen || document.webkitExitFullscreen;
    if (fn) fn.call(document);
  }
  function fsSupported(elm) { return !!(elm.requestFullscreen || elm.webkitRequestFullscreen); }
  function toggleFullscreen() {
    if (fsElement()) fsExit();
    else fsRequest(stageEl);
  }
  function syncRenderSize() {
    if (fsElement() === stageEl) {
      var availW = window.innerWidth, availH = window.innerHeight;
      /* two strips on a 16:9 screen would be 16:4.5 each — a letterbox slot.
         Letterbox the whole thing to 4:3 instead and give each of them room. */
      if (players() === 2) {
        var w2 = Math.min(availW, availH * 4 / 3);
        availW = w2; availH = w2 * 3 / 4;
      }
      /* cap the buffer so weak GPUs keep their frame rate on huge screens */
      var s = Math.min(1, 1920 / availW);
      setRenderSize(Math.round(availW * s), Math.round(availH * s));
      return;
    }
    /* windowed: 16:9 for one rider, 4:3 for two so each strip has some height */
    var wantH = players() === 2 ? 720 : 540;
    if (viewW !== 960 || viewH !== wantH) setRenderSize(960, wantH);
  }
  if (el.fsBtn && stageEl && fsSupported(stageEl)) {
    el.fsBtn.hidden = false;
    el.fsBtn.addEventListener("click", toggleFullscreen);
    ["fullscreenchange", "webkitfullscreenchange"].forEach(function (evt) {
      document.addEventListener(evt, function () {
        syncRenderSize();
        el.fsBtn.textContent = fsElement() ? "🗗" : "⛶";
        el.fsBtn.title = fsElement() ? "Exit full screen (F)" : "Full screen (F)";
      });
    });
    window.addEventListener("resize", function () {
      if (fsElement() === stageEl) syncRenderSize();
    });
    window.addEventListener("orientationchange", function () {
      setTimeout(function () { if (fsElement() === stageEl) syncRenderSize(); }, 250);
    });
  }

  /* optional photo-scanned textures from assets/world — every load fails
     silently back to the procedural look, so static hosting keeps working */
  var worldTexLoader = new THREE.TextureLoader();
  function loadWorldTex(url, srgb, done) {
    worldTexLoader.load(url, function (t) {
      if (srgb) t.colorSpace = THREE.SRGBColorSpace;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      aniso(t);
      done(t);
    }, undefined, function () { /* asset absent — procedural stays */ });
  }

  /* Draw one player's slice. The scissor keeps the clear and the final blit
     inside that slice, so the other player's half is never touched. */
  function renderView(sc, v) {
    var r = v.rect;
    renderer.setViewport(r.x, r.y, r.w, r.h);
    renderer.setScissor(r.x, r.y, r.w, r.h);
    renderer.setScissorTest(true);
    if (composer && composerH === r.h) {
      cRenderPass.scene = sc.scene;
      cRenderPass.camera = v.camera;
      composer.render();
    } else {
      renderer.render(sc.scene, v.camera);
    }
  }

  /* Backdrop objects (sky dome, haze ridges, sun sprite) sit ON the camera, so
     they have to be re-placed for each view right before that view is drawn. */
  function renderFrame(sc) {
    renderer.toneMappingExposure = sc.exposure;
    /* rain flattens the highlights, and lightning is all highlight */
    if (bloomPass) bloomPass.strength = 0.22 * (1 - 0.42 * (sc.wxK || 0)) + 0.3 * (sc.flash || 0);
    var n = players();
    for (var i = 0; i < n; i++) {
      var v = views[i];
      useView(v);
      parkBackdrop(sc);
      /* the shadow map is redrawn per view anyway, so spend each pass on a
         tight box round that view's own rider instead of one wide soft box */
      if (run && run.riders && run.riders[i]) {
        var rst = run.riders[i].st;
        aimSun(sc, rst.x, rst.y, rst.z, 0);
      }
      renderView(sc, v);
    }
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, viewW, viewH);
    if (n > 1) useView(views[0]);
  }

  /* canvas-drawn textures for sprites */
  function radialSprite(inner, outer, size) {
    var c = document.createElement("canvas");
    c.width = c.height = size || 128;
    var g = c.getContext("2d");
    var grad = g.createRadialGradient(c.width / 2, c.height / 2, 4, c.width / 2, c.height / 2, c.width / 2);
    grad.addColorStop(0, inner);
    grad.addColorStop(1, outer);
    g.fillStyle = grad;
    g.fillRect(0, 0, c.width, c.height);
    var tx = new THREE.CanvasTexture(c);
    tx.colorSpace = THREE.SRGBColorSpace;
    return tx;
  }

  function nameSprite(name, color) {
    var c = document.createElement("canvas");
    c.width = 256; c.height = 64;
    var g = c.getContext("2d");
    g.font = "600 30px Fredoka, Arial, sans-serif";
    var w = Math.min(240, g.measureText(name).width + 28);
    g.fillStyle = "rgba(12,46,28,0.78)";
    g.beginPath();
    if (g.roundRect) g.roundRect((256 - w) / 2, 8, w, 46, 20);
    else g.rect((256 - w) / 2, 8, w, 46);
    g.fill();
    g.fillStyle = color || "#FFF3C4";
    g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText(name, 128, 33);
    var tx = new THREE.CanvasTexture(c);
    tx.colorSpace = THREE.SRGBColorSpace;
    var sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tx, transparent: true, depthTest: false }));
    sp.scale.set(3.4, 0.85, 1);
    return sp;
  }

  var dustTex = radialSprite("rgba(210,175,120,0.85)", "rgba(210,175,120,0)", 64);
  var mistTex = radialSprite("rgba(255,255,255,0.75)", "rgba(255,255,255,0)", 128);
  var sprayTex = radialSprite("rgba(226,240,244,0.92)", "rgba(226,240,244,0)", 64);
  var sunTex = radialSprite("rgba(255,250,225,1)", "rgba(255,250,225,0)", 256);

  /* ---------- procedural textures (no external assets) ---------- */

  /* The terrain map is tiled about sixty times across the course, so at a
     grazing angle — which is every angle a rider sees the ground at — plain
     mipmapping blurs it to a brown smear about eight metres out. Anisotropic
     filtering is the whole fix, it is one line, and the Garage has been using
     it all along while the game never did. */
  function aniso(tx) {
    if (MAX_ANISO > 1) tx.anisotropy = Math.min(8, MAX_ANISO);
    return tx;
  }

  function canvasTexture(w, h, draw, wrap) {
    var c = document.createElement("canvas");
    c.width = w; c.height = h;
    draw(c.getContext("2d"), w, h);
    var tx = new THREE.CanvasTexture(c);
    tx.colorSpace = THREE.SRGBColorSpace;
    if (wrap) { tx.wrapS = THREE.RepeatWrapping; tx.wrapT = THREE.RepeatWrapping; }
    return aniso(tx);
  }

  /* soft grey mottling — multiplied over terrain vertex colors for surface detail */
  var terrainDetailTex = canvasTexture(256, 256, function (g, w, h) {
    /* mean stays near-white: this map MULTIPLIES the terrain's vertex colors */
    g.fillStyle = "#E2E2E2";
    g.fillRect(0, 0, w, h);
    var rnd = (function () { var s2 = 41; return function () { s2 = (s2 * 16807) % 2147483647; return s2 / 2147483647; }; })();
    for (var i = 0; i < 900; i++) {
      var r = 2 + rnd() * 14;
      var v = 190 + Math.floor(rnd() * 65);
      g.fillStyle = "rgba(" + v + "," + v + "," + v + "," + (0.06 + rnd() * 0.08) + ")";
      g.beginPath();
      g.arc(rnd() * w, rnd() * h, r, 0, 6.284);
      g.fill();
    }
    for (i = 0; i < 2600; i++) {
      var v2 = 170 + Math.floor(rnd() * 85);
      g.fillStyle = "rgba(" + v2 + "," + v2 + "," + v2 + ",0.16)";
      g.fillRect(rnd() * w, rnd() * h, 1.6, 1.6);
    }
  }, true);
  terrainDetailTex.colorSpace = THREE.NoColorSpace;

  var grassTex = canvasTexture(128, 128, function (g, w, h) {
    g.clearRect(0, 0, w, h);
    var rnd = (function () { var s2 = 7; return function () { s2 = (s2 * 16807) % 2147483647; return s2 / 2147483647; }; })();
    for (var i = 0; i < 11; i++) {
      var bx = 12 + rnd() * (w - 24);
      var lean = (rnd() - 0.5) * 40;
      var tall = 60 + rnd() * 58;
      var grad = g.createLinearGradient(0, h, 0, h - tall);
      grad.addColorStop(0, "rgba(255,255,255,0.98)");
      grad.addColorStop(1, "rgba(255,255,255,0.75)");
      g.strokeStyle = grad;
      g.lineWidth = 2.5 + rnd() * 2.5;
      g.lineCap = "round";
      g.beginPath();
      g.moveTo(bx, h);
      g.quadraticCurveTo(bx + lean * 0.3, h - tall * 0.6, bx + lean, h - tall);
      g.stroke();
    }
  });

  var cloudTex = canvasTexture(256, 128, function (g, w, h) {
    g.clearRect(0, 0, w, h);
    var lobes = [[70, 78, 42], [120, 62, 50], [178, 76, 40], [98, 88, 34], [150, 92, 36], [205, 92, 26]];
    lobes.forEach(function (L) {
      var grad = g.createRadialGradient(L[0], L[1], 4, L[0], L[1], L[2]);
      grad.addColorStop(0, "rgba(255,255,255,0.9)");
      grad.addColorStop(1, "rgba(255,255,255,0)");
      g.fillStyle = grad;
      g.fillRect(0, 0, w, h);
    });
    /* flatten the base so it reads as a cloud, not a blob */
    var fade = g.createLinearGradient(0, 96, 0, 128);
    fade.addColorStop(0, "rgba(0,0,0,0)");
    fade.addColorStop(1, "rgba(0,0,0,1)");
    g.globalCompositeOperation = "destination-out";
    g.fillStyle = fade;
    g.fillRect(0, 90, w, 40);
    g.globalCompositeOperation = "source-over";
  });

  var streakTex = canvasTexture(128, 256, function (g, w, h) {
    g.clearRect(0, 0, w, h);
    var rnd = (function () { var s2 = 91; return function () { s2 = (s2 * 16807) % 2147483647; return s2 / 2147483647; }; })();
    for (var i = 0; i < 46; i++) {
      var x = rnd() * w;
      var y0 = rnd() * h;
      var len = 40 + rnd() * 150;
      var grad = g.createLinearGradient(0, y0, 0, y0 + len);
      grad.addColorStop(0, "rgba(255,255,255,0)");
      grad.addColorStop(0.5, "rgba(255,255,255," + (0.25 + rnd() * 0.5) + ")");
      grad.addColorStop(1, "rgba(255,255,255,0)");
      g.strokeStyle = grad;
      g.lineWidth = 1.5 + rnd() * 4;
      g.beginPath();
      g.moveTo(x, y0);
      g.lineTo(x + (rnd() - 0.5) * 6, y0 + len);
      g.stroke();
    }
  }, true);

  /* ---------- procedural normal maps (FBM height -> sobel normals) ---------- */

  function makeNormalTexture(size, octaves, strength, seed) {
    function hn(ix, iz) {
      var h = (ix * 374761393 + iz * 668265263 + seed * 2246822519) | 0;
      h = Math.imul(h ^ (h >>> 13), 1274126177);
      return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
    }
    function vn(x, z) {
      var ix = Math.floor(x), iz = Math.floor(z);
      var fx = x - ix, fz = z - iz;
      var u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
      /* wrap the lattice so the texture tiles */
      var m = size >> 3;
      function w(a) { return ((a % m) + m) % m; }
      var a = hn(w(ix), w(iz)), b = hn(w(ix + 1), w(iz));
      var c = hn(w(ix), w(iz + 1)), d = hn(w(ix + 1), w(iz + 1));
      return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
    }
    var H = new Float32Array(size * size);
    for (var z = 0; z < size; z++) {
      for (var x = 0; x < size; x++) {
        var h = 0, amp = 1, f = 1 / 16;
        for (var o = 0; o < octaves; o++) {
          h += amp * vn(x * f, z * f);
          amp *= 0.55; f *= 2;
        }
        H[z * size + x] = h;
      }
    }
    var c2 = document.createElement("canvas");
    c2.width = c2.height = size;
    var g = c2.getContext("2d");
    var img = g.createImageData(size, size);
    for (z = 0; z < size; z++) {
      for (x = 0; x < size; x++) {
        var xm = (x - 1 + size) % size, xp = (x + 1) % size;
        var zm = (z - 1 + size) % size, zp = (z + 1) % size;
        var dx = (H[z * size + xp] - H[z * size + xm]) * strength;
        var dz = (H[zp * size + x] - H[zm * size + x]) * strength;
        var inv = 1 / Math.sqrt(dx * dx + dz * dz + 1);
        var i4 = (z * size + x) * 4;
        img.data[i4] = Math.round(((-dx * inv) * 0.5 + 0.5) * 255);
        img.data[i4 + 1] = Math.round(((-dz * inv) * 0.5 + 0.5) * 255);
        img.data[i4 + 2] = Math.round((inv * 0.5 + 0.5) * 255);
        img.data[i4 + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    var tx = new THREE.CanvasTexture(c2);
    tx.wrapS = THREE.RepeatWrapping;
    tx.wrapT = THREE.RepeatWrapping;
    tx.colorSpace = THREE.NoColorSpace;
    return tx;
  }

  var terrainNormalTex = makeNormalTexture(256, 5, 2.6, 5);
  var waterNormalTex = makeNormalTexture(256, 4, 3.4, 11);

  /* ---------- leaf clusters for organic tree canopies ---------- */

  var leafTex = canvasTexture(256, 256, function (g, w, h) {
    g.clearRect(0, 0, w, h);
    var rnd = (function () { var s2 = 17; return function () { s2 = (s2 * 16807) % 2147483647; return s2 / 2147483647; }; })();
    for (var i = 0; i < 190; i++) {
      /* cluster leaves toward the middle, thin out at the edge */
      var a = rnd() * 6.28, r = Math.pow(rnd(), 0.6) * 110;
      var x = w / 2 + Math.cos(a) * r, y = h / 2 + Math.sin(a) * r * 0.82;
      var v = 175 + Math.floor(rnd() * 80);
      g.fillStyle = "rgba(" + Math.floor(v * 0.82) + "," + v + "," + Math.floor(v * 0.6) + "," + (0.75 + rnd() * 0.25) + ")";
      g.save();
      g.translate(x, y);
      g.rotate(rnd() * 6.28);
      g.beginPath();
      g.ellipse(0, 0, 4 + rnd() * 9, 2.5 + rnd() * 4.5, 0, 0, 6.284);
      g.fill();
      g.restore();
    }
  });

  /* ---------- a real baobab: bottle trunk + root-like branch crown ----------
     Built once as a single merged geometry so hundreds can be instanced. */

  function buildBaobabGeometry(seed) {
    var s2 = seed;
    function rnd() { s2 = (s2 * 16807) % 2147483647; return s2 / 2147483647; }
    var geos = [];

    /* swollen bottle trunk */
    var profile = [
      new THREE.Vector2(1.72, 0),
      new THREE.Vector2(1.5, 0.5),
      new THREE.Vector2(1.62, 1.5),
      new THREE.Vector2(1.55, 2.7),
      new THREE.Vector2(1.28, 3.9),
      new THREE.Vector2(0.95, 4.9),
      new THREE.Vector2(0.7, 5.5)
    ];
    var trunk = new THREE.LatheGeometry(profile, 12);
    geos.push(trunk);
    var crownCap = new THREE.SphereGeometry(0.7, 9, 6);
    crownCap.translate(0, 5.5, 0);
    geos.push(crownCap);

    /* recursive tapering branches — the "roots in the sky" silhouette */
    var up = new THREE.Vector3(0, 1, 0);
    function branch(origin, dir, len, r, depth) {
      var g = new THREE.CylinderGeometry(r * 0.42, r, len, 6, 1);
      g.translate(0, len / 2, 0);
      var q = new THREE.Quaternion().setFromUnitVectors(up, dir);
      var m = new THREE.Matrix4().makeRotationFromQuaternion(q);
      m.setPosition(origin.x, origin.y, origin.z);
      g.applyMatrix4(m);
      geos.push(g);
      if (depth >= 2) return;
      var tip = origin.clone().addScaledVector(dir, len * 0.96);
      var kids = depth === 0 ? 3 : 2;
      for (var k = 0; k < kids; k++) {
        var d2 = dir.clone();
        d2.x += (rnd() - 0.5) * 1.1;
        d2.z += (rnd() - 0.5) * 1.1;
        d2.y += 0.25 + rnd() * 0.55;
        d2.normalize();
        branch(tip, d2, len * (0.5 + rnd() * 0.18), r * 0.45, depth + 1);
      }
    }
    var primaries = 7;
    for (var i = 0; i < primaries; i++) {
      var az = (i / primaries) * Math.PI * 2 + rnd() * 0.55;
      var elev = 0.55 + rnd() * 0.55;                 /* 30–63 degrees up */
      var dir = new THREE.Vector3(
        Math.cos(az) * Math.cos(elev),
        Math.sin(elev),
        Math.sin(az) * Math.cos(elev)
      ).normalize();
      var origin = new THREE.Vector3(Math.cos(az) * 0.35, 5.15 + rnd() * 0.3, Math.sin(az) * 0.35);
      branch(origin, dir, 1.9 + rnd() * 1.1, 0.34 + rnd() * 0.1, 0);
    }

    var merged = mergeGeometries(geos);
    geos.forEach(function (g) { g.dispose(); });
    return merged;
  }

  var baobabGeo = buildBaobabGeometry(20261010);

  /* papyrus reed clump: stalks + umbrella heads, merged for instancing */
  var reedGeo = (function () {
    var s2 = 77;
    function rnd() { s2 = (s2 * 16807) % 2147483647; return s2 / 2147483647; }
    var geos = [];
    var up = new THREE.Vector3(0, 1, 0);
    for (var i = 0; i < 6; i++) {
      var h = 1.8 + rnd() * 1.3;
      var lean = new THREE.Vector3((rnd() - 0.5) * 0.5, 1, (rnd() - 0.5) * 0.5).normalize();
      var base = new THREE.Vector3((rnd() - 0.5) * 0.7, 0, (rnd() - 0.5) * 0.7);
      var g2 = new THREE.CylinderGeometry(0.016, 0.028, h, 5);
      g2.translate(0, h / 2, 0);
      var q = new THREE.Quaternion().setFromUnitVectors(up, lean);
      var m = new THREE.Matrix4().makeRotationFromQuaternion(q);
      m.setPosition(base.x, base.y, base.z);
      g2.applyMatrix4(m);
      geos.push(g2);
      var head = new THREE.ConeGeometry(0.16, 0.22, 6);
      head.scale(1, -1, 1);
      var tip = base.clone().addScaledVector(lean, h);
      head.translate(tip.x, tip.y + 0.08, tip.z);
      geos.push(head);
    }
    return mergeGeometries(geos);
  })();

  /* 3 crossed vertical cards + 1 horizontal card, centered on origin */
  var canopyCardGeo = (function () {
    var pos = [], uv = [], idx = [];
    function quad(verts) {
      var b = pos.length / 3;
      verts.forEach(function (v) { pos.push(v[0], v[1], v[2]); });
      uv.push(0, 0, 1, 0, 1, 1, 0, 1);
      idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    }
    for (var k = 0; k < 3; k++) {
      var a = (k / 3) * Math.PI;
      var cx = Math.cos(a), sz = Math.sin(a);
      quad([[-cx, -1, -sz], [cx, -1, sz], [cx, 1, sz], [-cx, 1, -sz]]);
    }
    quad([[-1, 0.25, -1], [1, 0.25, -1], [1, 0.25, 1], [-1, 0.25, 1]]);
    var g2 = new THREE.BufferGeometry();
    g2.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pos), 3));
    g2.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(uv), 2));
    g2.setIndex(idx);
    g2.computeVertexNormals();
    return g2;
  })();

  /* ---------- sky dome + layered horizon ridges ---------- */

  function buildSkyDome(T) {
    var geo = new THREE.SphereGeometry(760, 28, 14);
    var pos = geo.attributes.position;
    var cols = new Float32Array(pos.count * 3);
    var top = new THREE.Color(T.skyTop || T.sky);
    var hor = new THREE.Color(T.skyLow || T.fog);
    var below = new THREE.Color(T.fog);
    var tc = new THREE.Color();
    for (var i = 0; i < pos.count; i++) {
      var y = pos.getY(i) / 760;
      if (y >= 0) {
        var t = Math.pow(Math.min(1, y * 1.6), 0.72);
        tc.copy(hor).lerp(top, t);
      } else {
        tc.copy(below);
      }
      cols[i * 3] = tc.r; cols[i * 3 + 1] = tc.g; cols[i * 3 + 2] = tc.b;
    }
    geo.setAttribute("color", new THREE.BufferAttribute(cols, 3));
    var dome = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false, toneMapped: true
    }));
    dome.renderOrder = -20;
    dome.frustumCulled = false;
    return dome;
  }

  function buildRidge(radius, baseH, peakH, color, seed) {
    var segs = 72;
    var verts = [];
    var idx = [];
    for (var i = 0; i <= segs; i++) {
      var a = (i / segs) * Math.PI * 2;
      var peak = peakH * (0.35 + 0.65 * Math.abs(Math.sin(a * 3.1 + seed) * 0.6 + Math.sin(a * 7.3 + seed * 2) * 0.4));
      var x = Math.cos(a) * radius, z = Math.sin(a) * radius;
      verts.push(x, -baseH, z);
      verts.push(x, peak, z);
      if (i < segs) {
        var b = i * 2;
        idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
      }
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(verts), 3));
    geo.setIndex(idx);
    var mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color: color, side: THREE.DoubleSide, fog: false, depthWrite: false
    }));
    mesh.renderOrder = -15;
    mesh.frustumCulled = false;
    return mesh;
  }

  /* ---------- rider / bike model ---------- */

  function lam(color) { return new THREE.MeshLambertMaterial({ color: color }); }

  function buildRiderMesh(jerseyHex, bikeCfg) {
    var gp = new THREE.Group();
    var paintHex = 0x2B1B10;
    var wheelR = 0.34;
    var isFS = false, isDC = false, hasBellV = false, hasGuard = false;
    if (bikeCfg && BIKES) {
      var pd = BIKES.getOption("paint", bikeCfg.paint);
      if (pd) paintHex = new THREE.Color(pd.color).getHex();
      var wd = BIKES.getOption("wheels", bikeCfg.wheels);
      if (wd && wd.radius) wheelR = wd.radius;
      isFS = bikeCfg.frame === "zambezi_fs" || bikeCfg.frame === "muchinga_enduro" || bikeCfg.frame === "mosi_dh";
      isDC = bikeCfg.fork === "mosi_dc_200";
      hasBellV = (bikeCfg.extras || []).indexOf("bell") >= 0;
      hasGuard = (bikeCfg.extras || []).indexOf("mudguard") >= 0;
    }
    var dark = lam(0x241505), frameM = lam(paintHex), jersey = lam(jerseyHex),
      skin = lam(0x8C5A33), helmet = lam(0xE8791D), shorts = lam(0x43290F);

    var wheelG = new THREE.TorusGeometry(wheelR, 0.055, 8, 18);
    var hubG = new THREE.CylinderGeometry(0.05, 0.05, 0.08, 8);
    hubG.rotateZ(Math.PI / 2);

    function wheel() {
      var w = new THREE.Group();
      var t = new THREE.Mesh(wheelG, dark);
      t.rotation.y = Math.PI / 2;
      var spokes = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.02, 10), lam(0x6C5442));
      spokes.rotation.z = Math.PI / 2;
      w.add(t, spokes);
      return w;
    }
    var wheelB = wheel(); wheelB.position.set(0, wheelR, -0.52);
    var wheelF = wheel(); wheelF.position.set(0, wheelR, 0.52);

    function tube(a, b, r, m) {
      var d = new THREE.Vector3().subVectors(b, a);
      var len = d.length();
      var mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 6), m);
      mesh.position.copy(a).addScaledVector(d, 0.5);
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
      return mesh;
    }
    var V = function (x, y, z) { return new THREE.Vector3(x, y, z); };
    var frame = new THREE.Group();
    frame.add(
      tube(V(0, 0.34, -0.52), V(0, 0.62, -0.18), 0.035, frameM),   /* seat stay */
      tube(V(0, 0.34, -0.52), V(0, 0.36, -0.05), 0.035, frameM),   /* chain stay */
      tube(V(0, 0.36, -0.05), V(0, 0.62, -0.18), 0.04, frameM),    /* seat tube */
      tube(V(0, 0.62, -0.18), V(0, 0.72, 0.38), 0.04, frameM),     /* top tube */
      tube(V(0, 0.36, -0.05), V(0, 0.72, 0.38), 0.045, frameM),    /* down tube */
      tube(V(0, 0.72, 0.38), V(0, 0.34, 0.52), 0.04, frameM)       /* fork */
    );
    var bars = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.5, 6), frameM);
    bars.rotation.z = Math.PI / 2;
    bars.position.set(0, 0.78, 0.4);
    var seat = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.05, 0.3), dark);
    seat.position.set(0, 0.68, -0.2);
    if (isFS) {
      var shock = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, 0.17, 8), dark);
      shock.position.set(0, 0.5, 0.02);
      shock.rotation.x = 0.9;
      gp.add(shock);
    }
    if (isDC) {
      var dcCrown = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.03, 0.05), dark);
      dcCrown.position.set(0, 0.76, 0.36);
      gp.add(dcCrown);
    }
    if (hasGuard) {
      var guard = new THREE.Mesh(new THREE.TorusGeometry(wheelR + 0.03, 0.02, 5, 10, Math.PI * 0.65), dark);
      guard.position.set(0, wheelR, 0.52);
      guard.rotation.z = Math.PI / 2;
      guard.rotation.y = Math.PI / 2;
      guard.rotation.x = Math.PI * 0.18;
      guard.scale.x = 0.3;
      gp.add(guard);
    }
    if (hasBellV) {
      var bellV = new THREE.Mesh(new THREE.SphereGeometry(0.022, 8, 6), lam(0xD9A441));
      bellV.position.set(-0.08, 0.8, 0.38);
      gp.add(bellV);
    }

    var crank = new THREE.Group();
    var pedL = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.03, 0.08), dark);
    pedL.position.set(-0.12, -0.16, 0);
    var pedR = pedL.clone(); pedR.position.set(0.12, 0.16, 0);
    crank.add(pedL, pedR);
    crank.position.set(0, 0.36, -0.05);

    /* rider */
    var rider = new THREE.Group();
    var torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.13, 0.34, 3, 8), jersey);
    torso.position.set(0, 1.0, 0.05);
    torso.rotation.x = 0.55;
    var head = new THREE.Mesh(new THREE.SphereGeometry(0.14, 10, 8), skin);
    head.position.set(0, 1.24, 0.26);
    var helm = new THREE.Mesh(new THREE.SphereGeometry(0.165, 10, 8, 0, Math.PI * 2, 0, Math.PI * 0.55), helmet);
    helm.position.copy(head.position).add(V(0, 0.03, -0.01));
    helm.rotation.x = -0.25;
    var armL = tube(V(-0.14, 1.08, 0.12), V(-0.2, 0.8, 0.38), 0.045, jersey);
    var armR = tube(V(0.14, 1.08, 0.12), V(0.2, 0.8, 0.38), 0.045, jersey);
    /* articulated legs: hip -> knee chains driven by the crank */
    function buildLeg(sideX) {
      var hip = new THREE.Group();
      hip.position.set(sideX, 0.8, -0.1);
      var thigh = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.05, 0.34, 6), shorts);
      thigh.position.y = -0.17;
      hip.add(thigh);
      var knee = new THREE.Group();
      knee.position.y = -0.34;
      hip.add(knee);
      var shin = new THREE.Mesh(new THREE.CylinderGeometry(0.042, 0.036, 0.32, 6), skin);
      shin.position.y = -0.16;
      knee.add(shin);
      var foot = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.045, 0.19), dark);
      foot.position.set(0, -0.33, 0.05);
      knee.add(foot);
      hip.rotation.x = -0.5;
      knee.rotation.x = 0.95;
      return { hip: hip, knee: knee };
    }
    var legLG = buildLeg(-0.1);
    var legRG = buildLeg(0.1);
    rider.add(torso, head, helm, armL, armR, legLG.hip, legRG.hip);

    gp.add(wheelB, wheelF, frame, bars, seat, crank, rider);

    /* soft blob shadow */
    var blob = new THREE.Mesh(
      new THREE.CircleGeometry(0.75, 14),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28, depthWrite: false })
    );
    blob.rotation.x = -Math.PI / 2;
    blob.position.y = 0.02;
    gp.add(blob);

    return {
      group: gp, wheelF: wheelF, wheelB: wheelB, crank: crank, rider: rider, blob: blob,
      pedL: pedL, pedR: pedR, legL: legLG, legR: legRG, torso: torso
    };
  }

  function enableRigShadows(rig) {
    if (lightMode) return;
    rig.group.traverse(function (o) {
      if (o.isMesh && o !== rig.blob) o.castShadow = true;
    });
  }

  function makeGhostRig(name, colorHex) {
    var rig = buildRiderMesh(colorHex);
    rig.group.traverse(function (o) {
      if (o.isMesh) {
        o.material = o.material.clone();
        o.material.transparent = true;
        o.material.opacity = 0.45;
        o.material.depthWrite = false;
      }
    });
    rig.blob.visible = false;
    var tag = nameSprite(name, "#FFF3C4");
    tag.position.y = 1.9;
    rig.group.add(tag);
    return rig;
  }

  /* ---------- scene building per track ---------- */

  var sceneCache = {};   /* id -> {scene, coinMesh, coinBase, wfParts, cloudSprites} */
  var worldCache = {};   /* id -> {world, armand, arthur} */

  function getWorld(id) {
    if (!worldCache[id]) {
      var world = CORE.buildWorld(CORE.TRACKS3[id]);
      var armand = CORE.simulateAI3(world, CORE.AI3_STYLES.armand);
      var arthur = CORE.simulateAI3(world, CORE.AI3_STYLES.arthur);
      armand.track = id; arthur.track = id;
      worldCache[id] = { world: world, armand: armand, arthur: arthur };
    }
    return worldCache[id];
  }

  function disposeScene(key) {
    var sc = sceneCache[key];
    if (!sc) return;
    sc.scene.traverse(function (o) {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        (Array.isArray(o.material) ? o.material : [o.material]).forEach(function (m) {
          if (m.map) m.map.dispose();
          m.dispose();
        });
      }
    });
    delete sceneCache[key];
  }

  /* ---------- time of day: cosmetic relight of any track's theme ----------
     "auto" keeps each mountain's hand-tuned mood. The explicit moods override
     sun position/colour, sky scattering, fog and exposure — never physics, so
     times and ghosts stay comparable across lighting. Sun always sits behind
     the rider (-z): riding into a low sun whites out the whole frame. */

  var TOD_ORDER = ["auto", "dawn", "day", "sunset", "dusk"];
  var TOD_META = {
    auto: { label: "Track mood", emoji: "✨" },
    dawn: { label: "Dawn", emoji: "🌅" },
    day: { label: "Midday", emoji: "☀️" },
    sunset: { label: "Sunset", emoji: "🌇" },
    dusk: { label: "Dusk", emoji: "🌆" }
  };
  var todSel = lsGet("zr3_tod", "auto");
  if (TOD_ORDER.indexOf(todSel) < 0) todSel = "auto";

  /* ---------- weather ----------
     One knob, k: 0 is dry, 1 is honest rain, 1.25 is a storm. It drives the
     look (colours, fog, mist, rain itself), the sound and — through the bike's
     own stats, never through the core — how much grip the tyres have. */
  var WX_MODES = {
    clear: { id: "clear", label: "Clear", k: 0, grip: 1, bolts: 0 },
    rain: { id: "rain", label: "Rain", k: 1, grip: 0.92, bolts: 0 },
    storm: { id: "storm", label: "Storm", k: 1.25, grip: 0.88, bolts: 1 }
  };
  var wxSel = lsGet("zr3_wx", "clear");
  if (!WX_MODES[wxSel]) wxSel = "clear";
  var wxForced = null;         /* the Grand Tour decides its own weather */
  function curWx() { return WX_MODES[wxForced || wxSel] || WX_MODES.clear; }

  function mixHex(a, b2, k) {
    return new THREE.Color(a).lerp(new THREE.Color(b2), k).getHex();
  }
  /* darken a colour towards wet, and pull some of the life out of it */
  function wetHex(hex, mul, greyK, k) {
    var c = new THREE.Color(hex).multiplyScalar(1 - (1 - mul) * k);
    var l = c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722;
    return c.lerp(new THREE.Color(l, l, l), greyK * k).getHex();
  }

  /* the dry world, rained on */
  function rainTheme(T, k) {
    if (k <= 0) return T;
    var d = Object.assign({}, T);
    /* the air closes in: grey-green above, and you cannot see as far */
    d.sky = mixHex(T.sky, 0x6E7A72, 0.62 * k);
    d.skyLow = mixHex(T.skyLow, 0x8E968C, 0.58 * k);
    d.fog = mixHex(T.fog, 0x93A09A, 0.66 * k);
    d.fogNear = Math.max(18, (T.fogNear || 60) * (1 - 0.42 * k));
    d.fogFar = Math.max(120, (T.fogFar || 420) * (1 - 0.44 * k));
    d.cloudCover = Math.min(0.95, (T.cloudCover || 0.4) + 0.42 * k);
    d.cloudTint = mixHex(T.cloudTint || 0xFFFFFF, 0x8A9098, 0.6 * k);
    d.turbidity = (T.turbidity || 4) + 5 * k;
    d.mieCoeff = (T.mieCoeff || 0.003) + 0.006 * k;
    /* the sun goes flat and the fill light does the work */
    d.sun = mixHex(T.sun, 0xCBD4D0, 0.55 * k);
    d.sunI = (T.sunI || 1.35) * (1 - 0.45 * k);
    /* the sun is gone, so the fill light has to carry the whole scene */
    d.hemiSky = mixHex(T.hemiSky || T.sky, 0xC2CCC6, 0.7 * k);
    d.hemiI = (T.hemiI || 0.95) * (1 + 0.85 * k);
    d.ambient = mixHex(T.ambient, 0xBCC4C0, 0.6 * k);
    d.ambI = (T.ambI || 0.35) * (1 + 1.1 * k);
    d.exposure = (T.exposure || 0.6) * (1 - 0.04 * k);
    /* Wet ground is darker and much less colourful — the drop in colour is
       what reads as rain, and it does the work without crushing the trail
       into black. Overcooking the darkening put three quarters of the falls
       under L=32, which is unrideable, not atmospheric. */
    ["grass", "grassDry", "dirt", "dirtDark", "rock", "trunk", "canopy", "canopy2", "sand"].forEach(function (key) {
      if (T[key] !== undefined) d[key] = wetHex(T[key], 0.82, 0.34, k);
    });
    d.water = mixHex(T.water, 0x55636A, 0.4 * k);
    d.wet = Math.min(1, k);
    if (k >= 0.8) d.groundMist = true;
    return d;
  }

  function todTheme(T) {
    if (todSel === "auto") return T;
    var d = Object.assign({}, T);
    /* Mood comes from HUE, not from turning the lights off. Every preset now
       carries its own hemiSky so the ground keeps its fill light, and the sun
       sits high enough that direct light still reaches the trail — a six
       degree sun laid shadows across the whole valley and made dusk
       unrideable rather than atmospheric. */
    if (todSel === "dawn") {
      d.sunPos = [-190, 90, -240];
      d.sun = 0xFFE2C0; d.ambient = 0xB8B2C4; d.ambI = (T.ambI || 0.35) * 1.15;
      d.hemiSky = 0xBFC6E6; d.hemiI = (T.hemiI || 0.95) * 1.15;
      d.turbidity = 4.5; d.rayleigh = 1.9; d.mieCoeff = 0.005; d.mieG = 0.8;
      d.exposure = (T.exposure || 0.6) * 0.98;
      d.fog = 0xE8DCE4; d.sky = 0xA8B8E0; d.skyLow = 0xF5C9A8;
      d.cloudTint = 0xF2D8CC; d.ridgeDim = 0.25;
    } else if (todSel === "day") {
      d.sunPos = [40, 330, -180];
      d.sun = 0xFFFDF4; d.ambient = 0xC2CCB8;
      d.hemiSky = 0xBBD9F2;
      d.turbidity = 2.6; d.rayleigh = 1.1; d.mieCoeff = 0.0025; d.mieG = 0.76;
      d.exposure = (T.exposure || 0.6) * 0.94;
      d.fog = 0xC6D4CC; d.sky = 0x8EC8EE; d.skyLow = 0xEAF4F0;
      d.cloudTint = 0xFFFFFF; d.ridgeDim = 0.05;
    } else if (todSel === "sunset") {
      d.sunPos = [-200, 95, -250];
      d.sun = 0xFFC384; d.ambient = 0xCCAE94; d.ambI = (T.ambI || 0.35) * 1.6;
      d.hemiSky = 0xE8C6A4; d.hemiI = (T.hemiI || 0.95) * 1.55; d.sunI = (T.sunI || 1.35) * 1.25;
      d.turbidity = 7.5; d.rayleigh = 2.9; d.mieCoeff = 0.008; d.mieG = 0.84;
      d.exposure = (T.exposure || 0.6) * 0.94;
      d.fog = 0xE8C8A0; d.sky = 0xE8A868; d.skyLow = 0xFFDCA8;
      d.cloudTint = 0xF5C098; d.ridgeDim = 0.4;
    } else if (todSel === "dusk") {
      d.sunPos = [-170, 80, -230];
      d.sun = 0xE8B48A; d.ambient = 0xB6BDD4; d.ambI = (T.ambI || 0.35) * 2.1;
      d.hemiSky = 0xA2ACC8; d.hemiI = (T.hemiI || 0.95) * 1.9; d.sunI = (T.sunI || 1.35) * 1.45;
      d.turbidity = 4.5; d.rayleigh = 3.6; d.mieCoeff = 0.005; d.mieG = 0.8;
      d.exposure = (T.exposure || 0.6) * 0.9;
      d.fog = 0x8A93AE; d.sky = 0x3A4A74; d.skyLow = 0xB88C88;
      d.cloudTint = 0x707A90; d.ridgeDim = 0.55;
    }
    return d;
  }

  function buildScene(id) {
    var key = id + "|" + todSel + "|" + curWx().id;
    if (sceneCache[key]) return sceneCache[key];
    /* keep at most one other scene alive */
    Object.keys(sceneCache).forEach(function (k) { if (k !== key) disposeScene(k); });

    var wc = getWorld(id);
    var world = wc.world;
    var wx = curWx();
    var wxK = wx.k, bolts = wx.bolts;
    var T = rainTheme(todTheme(world.def.theme), wxK);
    var sceneLeafMats = [];
    function addSway(mat, amp, freq) {
      mat.onBeforeCompile = function (shader) {
        shader.uniforms.uZbTime = { value: 0 };
        shader.vertexShader = "uniform float uZbTime;\n" + shader.vertexShader.replace(
          "#include <begin_vertex>",
          "#include <begin_vertex>\n#ifdef USE_INSTANCING\n{ vec4 zbp = instanceMatrix * vec4(0.0,0.0,0.0,1.0); " +
          "float zbs = sin(uZbTime*" + freq.toFixed(3) + " + zbp.x*0.37 + zbp.z*0.29); " +
          "transformed.x += zbs * max(0.0, transformed.y) * " + amp.toFixed(3) + "; " +
          "transformed.z += cos(uZbTime*" + (freq * 0.8).toFixed(3) + " + zbp.x*0.31) * max(0.0, transformed.y) * " + (amp * 0.6).toFixed(3) + "; }\n#endif"
        );
        mat.userData.swayShader = shader;
      };
      sceneLeafMats.push(mat);
    }
    var scene = new THREE.Scene();
    scene.background = new THREE.Color(T.fog);
    scene.fog = new THREE.Fog(T.fog, T.fogNear, lightMode ? T.fogFar * 0.75 : T.fogFar);

    var sunDirEarly = new THREE.Vector3(T.sunPos[0], T.sunPos[1], T.sunPos[2]).normalize();
    var exposure = lightMode ? 1.12 : (T.exposure || 0.65);

    /* sky: physically-based scattering (full) or the gradient dome (light) */
    var dome = null, skyObj = null;
    if (lightMode) {
      dome = buildSkyDome(T);
      scene.add(dome);
    } else {
      skyObj = new Sky();
      skyObj.scale.setScalar(2000);
      var su = skyObj.material.uniforms;
      su.turbidity.value = T.turbidity || 4;
      su.rayleigh.value = T.rayleigh || 1.5;
      su.mieCoefficient.value = T.mieCoeff || 0.005;
      su.mieDirectionalG.value = T.mieG || 0.8;
      su.sunPosition.value.copy(sunDirEarly);
      if (su.cloudCoverage) {
        su.cloudCoverage.value = T.cloudCover !== undefined ? T.cloudCover : 0.35;
        su.cloudDensity.value = 0.5;
        su.cloudScale.value = 0.00035;
      }
      scene.add(skyObj);
    }
    var fogC = new THREE.Color(T.fog);
    /* low-light moods silhouette the horizon hills instead of glowing */
    var ridgeBase = fogC.clone().lerp(new THREE.Color(0x0E1418), T.ridgeDim || 0);
    var ridgeFar = buildRidge(640, 90, 120, ridgeBase.clone().lerp(new THREE.Color(0x223322), 0.10), world.def.seed % 10);
    var ridgeNear = buildRidge(520, 90, 80, ridgeBase.clone().lerp(new THREE.Color(0x1A2A1A), 0.22), (world.def.seed % 10) + 3);
    scene.add(ridgeFar, ridgeNear);

    /* Physical-sky exposure is low, so lights compensate to keep the ground lit.
       T.sky used to do two unrelated jobs: paint the scenic backdrop AND light
       the ground. That is why Kasanka went black — its deep purple dusk sky
       delivered thirteen times less fill than the falls' pale blue, and the
       trail came out at a median of 3 out of 255. hemiSky splits the two, so
       a mood can be dark to look at without being dark to ride in. */
    var lightBoost = lightMode ? 1 : Math.min(3.2, 1.05 / exposure);
    var hemiLight = new THREE.HemisphereLight(T.hemiSky || T.sky, T.hemiGround || T.dirtDark,
      (T.hemiI || 0.95) * lightBoost);
    scene.add(hemiLight);
    var sun = new THREE.DirectionalLight(T.sun, (T.sunI || 1.35) * lightBoost);
    sun.position.set(T.sunPos[0], T.sunPos[1], T.sunPos[2]);
    scene.add(sun);
    scene.add(sun.target);
    if (!lightMode) {
      sun.castShadow = true;
      sun.shadow.mapSize.set(2048, 2048);
      /* A 120 m shadow box over a 2048 map is 5.9 cm a texel, which needed a
         normalBias of 1.2 WORLD METRES to hide the acne — twenty texels, which
         pushed every contact shadow off its own object. Nothing smaller than a
         tree cast a shadow at all. A 68 m box is 3.3 cm a texel and takes a
         normal bias two orders of magnitude smaller, so the bike, the rider
         and every animal sit on their own shadow again. Past 34 m from the
         rider a shadow is not readable at this camera distance anyway. */
      sun.shadow.camera.left = -34; sun.shadow.camera.right = 34;
      sun.shadow.camera.top = 34; sun.shadow.camera.bottom = -34;
      sun.shadow.camera.near = 20; sun.shadow.camera.far = 520;
      sun.shadow.bias = -0.0009;
      sun.shadow.normalBias = 0.06;
      /* a floor under shadowed ground, so a low sun does not black it out */
      if (sun.shadow.intensity !== undefined) sun.shadow.intensity = 0.72;
    }
    var sunDir = sunDirEarly;
    var amb = new THREE.AmbientLight(T.ambient, (T.ambI || 0.35) * lightBoost);
    scene.add(amb);

    /* sun disc sprite (light mode only — the physical sky draws its own sun) */
    var sunSp = null;
    if (lightMode) {
      sunSp = new THREE.Sprite(new THREE.SpriteMaterial({ map: sunTex, transparent: true, depthWrite: false, fog: false }));
      sunSp.scale.set(220, 220, 1);
      sunSp.position.copy(sunDir).multiplyScalar(700);
      scene.add(sunSp);
    }

    /* ---- terrain mesh with painted vertex colors ---- */
    var nx = world.nx, nz = world.nz, step = world.step;
    var geo = new THREE.PlaneGeometry((nx - 1) * step, (nz - 1) * step, nx - 1, nz - 1);
    geo.rotateX(-Math.PI / 2);
    var pos = geo.attributes.position;
    var colors = new Float32Array(pos.count * 3);
    var cGrass = new THREE.Color(T.grass), cDry = new THREE.Color(T.grassDry),
      cDirt = new THREE.Color(T.dirt), cDirtD = new THREE.Color(T.dirtDark),
      cRock = new THREE.Color(T.rock);
    var tmp = new THREE.Color();
    for (var iz = 0; iz < nz; iz++) {
      for (var ix = 0; ix < nx; ix++) {
        var vi = iz * nx + ix;
        var wx = world.x0 + ix * step;
        var wz = world.z0 + iz * step;
        var h = world.H[vi];
        pos.setXYZ(vi, wx, h, wz);
        var d = world.TD[vi];
        /* slope estimate for rockiness */
        var hR = world.H[iz * nx + Math.min(nx - 1, ix + 1)];
        var hD = world.H[Math.min(nz - 1, iz + 1) * nx + ix];
        var sl = Math.min(1, (Math.abs(hR - h) + Math.abs(hD - h)) / step * 0.9);
        var nse = (Math.sin(wx * 0.31) * Math.sin(wz * 0.23) + Math.sin(wx * 0.071 + wz * 0.083)) * 0.5;
        var sandK = 0;
        if (world.rowWaterY && wx > world.rowEdgeX[iz] - 15) {    /* riverside only */
          var wl = world.rowWaterY[iz];
          if (h < wl - 0.35) sandK = -1;                          /* riverbed */
          else if (h < wl + 1.8) sandK = 1 - (h - wl) / 1.8;      /* beach */
        }
        /* inside the falls gorge everything is wet dark basalt */
        var basaltK = 0;
        if (world.rowGorgeX && wx > world.rowGorgeX[iz] + 1) basaltK = Math.min(1, sl * 1.5 + 0.3);
        if (d < 2.6) {
          tmp.copy(cDirt).lerp(cDirtD, 0.35 + nse * 0.2);
          /* twin tire ruts worn into the trail */
          var rut = Math.exp(-Math.pow((d - 1.15) / 0.34, 2));
          tmp.lerp(cDirtD, rut * 0.45);
        } else if (d < 6.5) {
          tmp.copy(cDirt).lerp(cGrass, (d - 2.6) / 3.9);
        } else {
          tmp.copy(cGrass).lerp(cDry, 0.5 + nse * 0.45);
          if (sl > 0.55) tmp.lerp(cRock, (sl - 0.55) * 1.6);
        }
        if (sandK > 0) tmp.lerp(new THREE.Color(T.sand || 0xD8C08A), Math.min(1, sandK));
        else if (sandK < 0) tmp.copy(cDirtD).multiplyScalar(0.55);
        if (basaltK > 0) tmp.lerp(new THREE.Color(0x39413C), basaltK);
        colors[vi * 3] = tmp.r; colors[vi * 3 + 1] = tmp.g; colors[vi * 3 + 2] = tmp.b;
      }
    }
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    var detailMap = terrainDetailTex.clone();
    detailMap.needsUpdate = true;
    detailMap.repeat.set(((nx - 1) * step) / 15, ((nz - 1) * step) / 15);
    var terrainNrm = terrainNormalTex.clone();
    terrainNrm.needsUpdate = true;
    terrainNrm.repeat.set(((nx - 1) * step) / 15, ((nz - 1) * step) / 15);
    var terrain = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      vertexColors: true, map: detailMap, normalMap: terrainNrm,
      normalScale: new THREE.Vector2(0.55, 0.55), roughness: 0.97, metalness: 0
    }));
    terrain.receiveShadow = true;
    scene.add(terrain);
    /* photo-scanned ground detail (assets/world) swaps in when present */
    loadWorldTex("assets/world/textures/rock/rock-detail.jpg", false, function (t) {
      t.repeat.set(((nx - 1) * step) / 11, ((nz - 1) * step) / 11);
      terrain.material.map = t;
      terrain.material.needsUpdate = true;
    });
    loadWorldTex("assets/world/textures/rock/rock-normal.jpg", false, function (t) {
      t.repeat.set(((nx - 1) * step) / 11, ((nz - 1) * step) / 11);
      terrain.material.normalMap = t;
      terrain.material.normalScale.set(0.75, 0.75);
      terrain.material.needsUpdate = true;
    });

    /* ---- the Zambezi itself: a flowing water ribbon along the bank ---- */
    var riverTex = null;
    if (world.riverEdgeX) {
      var rPos = [], rUv = [], rIdx = [];
      var smoothY = new Float32Array(world.trailN);
      for (var ri2 = 0; ri2 < world.trailN; ri2++) {
        var lo2 = Math.max(0, ri2 - 4), hi2 = Math.min(world.trailN - 1, ri2 + 4), acc2 = 0;
        for (var k2 = lo2; k2 <= hi2; k2++) acc2 += world.waterY[k2];
        smoothY[ri2] = acc2 / (hi2 - lo2 + 1);
      }
      var rStep = 2, rCount = 0;
      for (ri2 = 0; ri2 < world.trailN; ri2 += rStep) {
        var tp2 = world.trail[ri2];
        var lx2 = world.riverEdgeX[ri2] - 8;
        var rx2 = world.riverEdgeX[ri2] + world.def.river.width + 60;
        var wy2 = smoothY[ri2];
        rPos.push(lx2, wy2, tp2.z, rx2, wy2, tp2.z);
        rUv.push(0, ri2 * 0.09, 7, ri2 * 0.09);
        if (ri2 + rStep < world.trailN) {
          var b2 = rCount * 2;
          /* wound so the face normal points up (+y) — the surface is viewed from above */
          rIdx.push(b2, b2 + 2, b2 + 1, b2 + 1, b2 + 2, b2 + 3);
        }
        rCount++;
      }
      var rGeo = new THREE.BufferGeometry();
      rGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(rPos), 3));
      rGeo.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(rUv), 2));
      rGeo.setIndex(rIdx);
      rGeo.computeVertexNormals();
      riverTex = waterNormalTex.clone();
      riverTex.needsUpdate = true;
      var riverMesh = new THREE.Mesh(rGeo, new THREE.MeshPhongMaterial({
        color: T.water, normalMap: riverTex, normalScale: new THREE.Vector2(0.55, 0.55),
        shininess: 130, specular: 0xA8D9C8, transparent: true, opacity: 0.93,
        emissive: T.water, emissiveIntensity: 0.38   /* rivers scatter skylight — never black */
      }));
      riverMesh.receiveShadow = true;
      scene.add(riverMesh);
    }

    /* ---- instanced props ---- */
    var density = lightMode ? 0.55 : 1;
    var parts = {};  /* type -> array of {geo, mat, yOff, sMul} pieces */
    function piece(g2, m2, y2, s2) { return { geo: g2, mat: m2, y: y2 || 0, s: s2 || 1 }; }
    var trunkM = lam(T.trunk), canM = lam(T.canopy), can2M = lam(T.canopy2), rockM = lam(T.rock);
    /* real scanned surfaces on rocks and bark, when the assets exist */
    loadWorldTex("assets/world/textures/rock/rock-albedo.jpg", true, function (t) {
      t.repeat.set(1.6, 1.6);
      rockM.map = t;
      rockM.color.set(0xCFCabe);
      rockM.needsUpdate = true;
    });
    loadWorldTex("assets/world/textures/bark/bark-albedo.jpg", true, function (t) {
      t.repeat.set(1, 2);
      trunkM.map = t;
      trunkM.color.lerp(new THREE.Color(0xffffff), 0.5);
      trunkM.needsUpdate = true;
    });
    /* leaf-card canopies: alpha-tested crossed cards read as organic foliage */
    var leafM = new THREE.MeshLambertMaterial({ map: leafTex, alphaTest: 0.42, side: THREE.DoubleSide, color: T.canopy });
    var leafM2 = new THREE.MeshLambertMaterial({ map: leafTex, alphaTest: 0.42, side: THREE.DoubleSide, color: T.canopy2 });
    addSway(leafM, 0.05, 1.2);
    addSway(leafM2, 0.06, 1.45);

    parts.miombo = [
      piece(new THREE.CylinderGeometry(0.14, 0.24, 3.4, 7), trunkM, 1.7),
      piece(canopyCardGeo.clone().scale(2.3, 1.5, 2.3), leafM, 3.9),
      piece(canopyCardGeo.clone().scale(1.5, 1.1, 1.5), leafM2, 3.1, 0.9),
      piece(new THREE.SphereGeometry(0.9, 6, 5), lam(T.canopy), 3.6)
    ];
    /* baobabs get their own grey-copper bark, not the generic trunk brown */
    var barkM = lam(0x8F7767);
    parts.baobab = [
      piece(baobabGeo, barkM, 0),
      piece(canopyCardGeo.clone().scale(2.2, 0.65, 2.2), leafM2, 7.1)
    ];
    parts.acacia = [
      piece(new THREE.CylinderGeometry(0.12, 0.2, 2.8, 6), trunkM, 1.4),
      piece(canopyCardGeo.clone().scale(2.6, 0.55, 2.6), leafM, 3.1),
      piece(new THREE.ConeGeometry(2.2, 0.5, 8), canM, 2.95)
    ];
    parts.palm = [
      piece(new THREE.CylinderGeometry(0.12, 0.2, 3.6, 6), trunkM, 1.8),
      piece(canopyCardGeo.clone().scale(1.7, 0.9, 1.7), leafM, 4.0)
    ];
    parts.bush = [piece(new THREE.SphereGeometry(0.8, 7, 5).scale(1, 0.6, 1), can2M, 0.45)];
    var reedM = new THREE.MeshLambertMaterial({ color: 0x6E9E52 });
    addSway(reedM, 0.09, 1.6);
    parts.reed = [piece(reedGeo, reedM, 0)];
    parts.fern = [piece(new THREE.ConeGeometry(0.55, 1.1, 5), canM, 0.5)];
    parts.grass = [piece(new THREE.ConeGeometry(0.3, 0.75, 4), can2M, 0.32)];
    parts.rock = [piece(new THREE.DodecahedronGeometry(0.85, 0), rockM, 0.4)];
    parts.termite = [piece(new THREE.ConeGeometry(0.8, 2.2, 6), lam(T.dirtDark), 1.05)];

    var byType = {};
    world.props.forEach(function (p, idx) {
      if (parts[p.type]) {
        if (p.r === 0 && (idx % 100) / 100 > density) return;   /* thin decoratives in light mode */
        (byType[p.type] || (byType[p.type] = [])).push(p);
      }
    });
    var m4 = new THREE.Matrix4(), q4 = new THREE.Quaternion(), v3 = new THREE.Vector3(), s3 = new THREE.Vector3();
    var SOLID_SHADOW = { miombo: 1, baobab: 1, acacia: 1, palm: 1, rock: 1, termite: 1, bush: 1 };
    var jitterC = new THREE.Color();
    Object.keys(byType).forEach(function (type) {
      var list = byType[type];
      parts[type].forEach(function (pc) {
        var im = new THREE.InstancedMesh(pc.geo, pc.mat, list.length);
        for (var i = 0; i < list.length; i++) {
          var p = list[i];
          q4.setFromAxisAngle(v3.set(0, 1, 0), p.rot);
          s3.setScalar(p.s * pc.s);
          m4.compose(new THREE.Vector3(p.x, p.y + pc.y * p.s, p.z), q4, s3);
          im.setMatrixAt(i, m4);
          /* per-instance colour jitter so forests stop looking cloned */
          var h1 = Math.sin(p.x * 12.9898 + p.z * 78.233) * 43758.5453;
          h1 -= Math.floor(h1);
          var h2 = Math.sin(p.x * 39.3468 + p.z * 11.135) * 24634.6345;
          h2 -= Math.floor(h2);
          jitterC.setRGB(
            0.82 + h1 * 0.32,
            0.82 + h2 * 0.34,
            0.84 + (h1 * 0.5 + h2 * 0.5) * 0.24
          );
          im.setColorAt(i, jitterC);
        }
        im.instanceMatrix.needsUpdate = true;
        if (im.instanceColor) im.instanceColor.needsUpdate = true;
        if (!lightMode && SOLID_SHADOW[type]) im.castShadow = true;
        im.receiveShadow = true;
        scene.add(im);
      });
    });

    /* wildlife: little primitive sculptures, each one alive in place */
    var crocs = [], fauna = [];
    world.props.forEach(function (p, pIdx) {
      var g2 = null;
      if (p.type === "elephant") g2 = buildElephant();
      else if (p.type === "giraffe") g2 = buildGiraffe();
      else if (p.type === "zebra") g2 = buildZebra();
      else if (p.type === "antelope") g2 = buildAntelope();
      else if (p.type === "croc") { g2 = buildCroc(); crocs.push(g2); }
      else if (p.type === "hippo") g2 = buildHippo(p.r > 0);
      else if (p.type === "rhino") g2 = buildRhino();
      if (g2) {
        g2.scale.setScalar((p.s || 1) * (p.type === "croc" ? 1.25 : 1));
        g2.position.set(p.x, p.y, p.z);
        g2.rotation.y = p.rot;
        if (!lightMode) g2.traverse(function (o) { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
        scene.add(g2);
        /* A HAZARD RING. Even counter-shaded, a big animal standing in long
           grass at fifty metres is a shape among shapes. Every animal that can
           actually be HIT gets a soft accent-coloured ring on the ground under
           it, which reads as "go round this" long before the animal itself
           resolves. Decorative wildlife well off the trail gets nothing. */
        if (p.r > 0 && !lightMode) {
          var ringM = new THREE.MeshBasicMaterial({
            color: T.accent, transparent: true, opacity: 0.34,
            depthWrite: false, side: THREE.DoubleSide, fog: true
          });
          var ring = new THREE.Mesh(new THREE.RingGeometry(p.r * 1.15, p.r * 1.5, 22), ringM);
          ring.rotation.x = -Math.PI / 2;
          ring.position.set(p.x, p.y + 0.07, p.z);
          ring.renderOrder = 2;
          scene.add(ring);
        }
        if (g2.userData.anim) {
          fauna.push({
            g: g2, a: g2.userData.anim,
            x: p.x, z: p.z, rot: p.rot,
            /* everybody on their own clock, so the herd never moves as one */
            ph: (pIdx * 2.399) % 6.283,
            rate: 0.75 + ((pIdx * 37) % 50) / 100,
            alert: 0, look: 0
          });
        }
      }
    });

    /* ---- grass cards: thousands of alpha-tested tufts near the trail ---- */
    (function () {
      var gVerts = new Float32Array([
        -0.6, 0, 0, 0.6, 0, 0, 0.6, 0.9, 0, -0.6, 0.9, 0,
        0, 0, -0.6, 0, 0, 0.6, 0, 0.9, 0.6, 0, 0.9, -0.6
      ]);
      var gUv = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1]);
      var gIdx = [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7];
      var gGeo = new THREE.BufferGeometry();
      gGeo.setAttribute("position", new THREE.BufferAttribute(gVerts, 3));
      gGeo.setAttribute("uv", new THREE.BufferAttribute(gUv, 2));
      gGeo.setIndex(gIdx);
      gGeo.computeVertexNormals();
      var gMat = new THREE.MeshLambertMaterial({
        map: grassTex, alphaTest: 0.45, side: THREE.DoubleSide, color: 0xffffff
      });
      addSway(gMat, 0.13, 1.9);
      var count = lightMode ? 800 : 2400;
      var gim = new THREE.InstancedMesh(gGeo, gMat, count);
      var lcg = world.def.seed ^ 0x9E3779B9;
      var grnd = function () { lcg = (lcg * 1664525 + 1013904223) >>> 0; return lcg / 4294967296; };
      var zEnd2 = world.trail[world.trailN - 1].z;
      var gCol = new THREE.Color();
      var cG = new THREE.Color(T.grass), cGD = new THREE.Color(T.grassDry);
      var placed = 0, guard = 0;
      while (placed < count && guard++ < count * 12) {
        var gx = (grnd() * 2 - 1) * (CORE.X_HALF - 14);
        var gz2 = 5 + grnd() * (zEnd2 - 10);
        var td = CORE.trailDistAt(world, gx, gz2);
        if (td < 3.2) continue;
        if (td > 40 && grnd() > 0.18) continue;      /* dense near the trail, sparse far away */
        var gy = CORE.heightAt(world, gx, gz2);
        q4.setFromAxisAngle(v3.set(0, 1, 0), grnd() * 6.28);
        var gs = 0.8 + grnd() * 1.1;
        s3.set(gs, gs * (0.85 + grnd() * 0.5), gs);
        m4.compose(new THREE.Vector3(gx, gy, gz2), q4, s3);
        gim.setMatrixAt(placed, m4);
        gCol.copy(cG).lerp(cGD, grnd()).multiplyScalar(1.05 + grnd() * 0.35);
        gim.setColorAt(placed, gCol);
        placed++;
      }
      gim.count = placed;
      gim.instanceMatrix.needsUpdate = true;
      if (gim.instanceColor) gim.instanceColor.needsUpdate = true;
      scene.add(gim);
    })();

    /* ---- coins ---- */
    var coinGeo = new THREE.CylinderGeometry(0.36, 0.36, 0.08, 14);
    coinGeo.rotateX(Math.PI / 2);
    var coinMat = new THREE.MeshLambertMaterial({ color: 0xF7B733, emissive: 0x9A5A10 });
    var coinMesh = new THREE.InstancedMesh(coinGeo, coinMat, world.coins.length);
    scene.add(coinMesh);

    /* ---- gates + finish ---- */
    /* A gate used to be two dark-green sticks 7 cm across: under half a pixel
       wide past sixty metres, where FXAA simply erased them. Now they are pale
       posts with a banner slung between them, so a gate reads as a GATE — a
       horizontal edge eight metres wide — from as far as you can see it. */
    var poleG = new THREE.CylinderGeometry(0.16, 0.16, 3.4, 7);
    var poleM = lam(0xF4EFE4);
    var flagM = lam(T.accent);
    var bannerG = new THREE.BoxGeometry(8.4, 0.5, 0.12);
    world.gates.forEach(function (gi) {
      var p = world.trail[gi];
      var q = world.trail[Math.min(world.trailN - 1, gi + 1)];
      var yaw = Math.atan2(q.x - p.x, q.z - p.z);
      var side = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
      var topY = -1e9;
      [-1, 1].forEach(function (s) {
        var px = p.x + side.x * 4 * s, pz = p.z + side.z * 4 * s;
        var pole = new THREE.Mesh(poleG, poleM);
        pole.position.set(px, CORE.heightAt(world, px, pz) + 1.7, pz);
        scene.add(pole);
        var flag = new THREE.Mesh(new THREE.ConeGeometry(0.55, 1.3, 4), flagM);
        flag.position.copy(pole.position).add(new THREE.Vector3(0, 2.05, 0));
        scene.add(flag);
        if (pole.position.y > topY) topY = pole.position.y;
      });
      var banner = new THREE.Mesh(bannerG, flagM);
      banner.position.set(p.x, topY + 1.5, p.z);
      banner.rotation.y = yaw;
      scene.add(banner);
    });
    /* finish arch */
    (function () {
      var p = world.trail[world.finishIdx];
      var q = world.trail[Math.min(world.trailN - 1, world.finishIdx + 1)];
      var yaw = Math.atan2(q.x - p.x, q.z - p.z);
      var side = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
      var arch = new THREE.Group();
      [-1, 1].forEach(function (s) {
        var pole = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 5.2, 8), poleM);
        pole.position.set(side.x * 5 * s, 2.6, side.z * 5 * s);
        arch.add(pole);
      });
      /* checkered banner (canvas texture) */
      var c = document.createElement("canvas");
      c.width = 256; c.height = 48;
      var g2 = c.getContext("2d");
      g2.fillStyle = "#E8791D"; g2.fillRect(0, 0, 256, 48);
      g2.fillStyle = "#fff";
      for (var i = 0; i < 16; i++) g2.fillRect(i * 16, (i % 2) * 12, 16, 12);
      g2.fillStyle = "#FFF3C4";
      g2.font = "700 26px Fredoka, Arial, sans-serif";
      g2.textAlign = "center";
      g2.fillText("FINISH", 128, 42);
      var tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      var banner = new THREE.Mesh(new THREE.BoxGeometry(10.5, 1.15, 0.12),
        new THREE.MeshBasicMaterial({ map: tex }));
      banner.position.y = 4.9;
      arch.add(banner);
      arch.position.set(p.x, p.y, p.z);
      arch.rotation.y = yaw;
      scene.add(arch);
    })();

    /* ---- clouds: fluffy flat-bottomed billboards + high cirrus ---- */
    var clouds = [];
    var zSpan = world.trail[world.trailN - 1].z;
    var nClouds = lightMode ? 5 : 13;
    for (var ci = 0; ci < nClouds; ci++) {
      var cm = new THREE.SpriteMaterial({
        map: cloudTex, transparent: true, depthWrite: false, fog: false,
        opacity: 0.55 + (ci % 3) * 0.15, color: T.cloudTint || 0xFFFFFF
      });
      var sp = new THREE.Sprite(cm);
      var sc = 70 + (ci * 41) % 90;
      sp.scale.set(sc * 2.4, sc, 1);
      sp.position.set(((ci * 173) % 560) - 280, 110 + (ci * 29) % 80 - (zSpan * world.def.slope) * (ci / nClouds), (ci / nClouds) * (zSpan + 300) - 100);
      scene.add(sp);
      clouds.push(sp);
    }
    if (!lightMode) {
      for (ci = 0; ci < 4; ci++) {
        var cirrus = new THREE.Sprite(new THREE.SpriteMaterial({
          map: mistTex, transparent: true, depthWrite: false, fog: false, opacity: 0.18
        }));
        cirrus.scale.set(420, 40, 1);
        cirrus.position.set(((ci * 217) % 500) - 250, 200 + ci * 22 - (zSpan * world.def.slope) * (ci / 4), (ci / 4) * zSpan);
        scene.add(cirrus);
        clouds.push(cirrus);
      }
    }

    /* ---- bird flocks wheeling over the valley (bat swirls on Kasanka) ---- */
    var birds = [];
    var batty = !!T.bats;
    if (!lightMode) {
      var birdMat = lam(batty ? 0x241A14 : id === "baobab" ? 0x2E1A08 : 0xF4EFE4);
      var flockN = batty ? 4 : 2;
      for (var fi = 0; fi < flockN; fi++) {
        var flock = { center: null, r: (batty ? 15 + fi * 7 : 24 + fi * 14), h: 0, speed: (batty ? 0.55 : 0.28) + fi * 0.1, members: [] };
        var fz = zSpan * (batty ? 0.14 + fi * 0.23 : 0.28 + fi * 0.42);
        var fIdx = Math.min(world.trailN - 1, Math.floor(fz / 5));
        var fp = world.trail[fIdx];
        flock.center = new THREE.Vector3(fp.x + (fi % 2 ? -26 : 24), fp.y + (batty ? 20 + fi * 7 : 34 + fi * 12), fp.z);
        for (var bi = 0; bi < (batty ? 7 : 5); bi++) {
          var bird = new THREE.Group();
          var wingG = new THREE.PlaneGeometry(batty ? 0.55 : 0.95, batty ? 0.26 : 0.3);
          var wl = new THREE.Mesh(wingG, birdMat);
          wl.position.x = -0.45;
          var wr = new THREE.Mesh(wingG, birdMat);
          wr.position.x = 0.45;
          bird.add(wl, wr);
          bird.userData = { wl: wl, wr: wr, phase: bi * 1.3, off: bi * 1.256 };
          scene.add(bird);
          flock.members.push(bird);
        }
        birds.push(flock);
      }
    }

    /* ---- Kasanka at dusk: rivers of ten million straw-coloured fruit
       bats crossing the sky, and mist lying on the swamp forest ---- */
    var batStreams = [];
    if (T.bats) {
      var batTex = canvasTexture(64, 32, function (g) {
        g.clearRect(0, 0, 64, 32);
        g.fillStyle = "#1C140E";
        g.beginPath();
        g.moveTo(32, 20);
        g.quadraticCurveTo(18, 4, 2, 14);
        g.quadraticCurveTo(16, 16, 28, 24);
        g.lineTo(36, 24);
        g.quadraticCurveTo(48, 16, 62, 14);
        g.quadraticCurveTo(46, 4, 32, 20);
        g.fill();
      });

      /* A THREE.Points cloud can never look like a bat: one static sprite,
         no silhouette change, no way to point a bat along its own flight.
         So each bat is now an instance of a little horizontal wing card —
         which is exactly how you see a bat from underneath — turned to its
         heading and SQUASHED ACROSS THE WINGSPAN on every beat. That squash
         is the wing beat, and it is one number per bat per frame.

         The other half of "stuck" was the geometry of the thing: bats used
         to fly downhill at 7-12 m/s while the rider does up to 21, so they
         hung in the sky like stickers. Now the streams fly ACROSS and UP the
         valley, so they sweep past you, and the lowest stream comes down to
         head height where you can actually see the wings working. */
      var batGeo = new THREE.PlaneGeometry(1, 1);
      batGeo.rotateX(-Math.PI / 2);            /* lie flat: seen from below */
      var batMat = new THREE.MeshBasicMaterial({
        map: batTex, transparent: true, depthWrite: false, alphaTest: 0.28,
        side: THREE.DoubleSide, color: 0x2A1F17, fog: true
      });

      /* TWO THINGS DECIDE WHETHER YOU SEE ANY OF THIS.

         Altitude. The chase camera looks about 17 degrees down the hill with
         34 degrees of vertical view, so the sky is only the top third of the
         screen and anything above roughly 12 degrees of elevation is off the
         top edge. Bats used to fly 60 m up: never once on screen.

         Density. Spreading a fixed number of bats over the whole two
         kilometres of valley puts about a dozen of them inside the view at
         any moment, which is a few specks, not the largest mammal migration
         on Earth. So the river is recycled AROUND THE RIDER: a bat that
         passes behind you comes back in at the far end of the window, and
         every bat in the scene is always in the 300 m of valley you can
         actually see. Same cost, forty times the spectacle. */
      var STREAMS = lightMode
        ? [{ n: 240, alt: 14, spread: 10, wide: 70, size: 2.2, spd: 13, cross: 0.4 },
           { n: 120, alt: 5, spread: 3.5, wide: 26, size: 2.8, spd: 17, cross: 0.9 }]
        : [{ n: 430, alt: 22, spread: 12, wide: 95, size: 2.0, spd: 12, cross: 0.3 },
           { n: 330, alt: 12, spread: 7, wide: 60, size: 2.5, spd: 15, cross: 0.55 },
           { n: 190, alt: 4.5, spread: 3.2, wide: 22, size: 3.0, spd: 19, cross: 0.9 }];

      var BAT_BEHIND = 70, BAT_AHEAD = 300;   /* the window that follows you */

      STREAMS.forEach(function (S) {
        var bats = new Array(S.n);
        for (var bi2 = 0; bi2 < S.n; bi2++) {
          bats[bi2] = {
            x: (Math.random() - 0.5) * S.wide * 2,
            z: -BAT_BEHIND + Math.random() * (BAT_BEHIND + BAT_AHEAD),
            alt: S.alt + Math.random() * S.spread,
            spd: S.spd * (0.8 + Math.random() * 0.45),
            /* they cross the valley as well as run up it, so they sweep
               through the view instead of pacing the rider */
            cross: (Math.random() < 0.5 ? -1 : 1) * S.cross * (0.6 + Math.random() * 0.8),
            amp: 0.4 + Math.random() * 0.6,      /* how much it rises and falls */
            fr: 6.5 + Math.random() * 4.5,       /* wing beats per second */
            ph: Math.random() * 6.283,
            size: S.size * (0.82 + Math.random() * 0.4)
          };
        }
        var im = new THREE.InstancedMesh(batGeo, batMat, S.n);
        im.frustumCulled = false;
        im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        scene.add(im);
        batStreams.push({
          mesh: im, bats: bats, behind: BAT_BEHIND, ahead: BAT_AHEAD,
          wide: S.wide, alt: S.alt, spread: S.spread,
          slope: world.def.slope, dummy: new THREE.Object3D()
        });
      });
    }
    /* GROUND MIST.
       Ten sprites 130 m wide and 18 m tall, hung five metres up, is not mist
       lying on a swamp — it is a haze band on the far ridge, which is where
       it read. Mist wants to be many small patches sitting ON the trail, at
       about the height of your wheels, recycled around the rider so there is
       always some of it just ahead. */
    var mistPatches = [];
    if (T.groundMist) {
      var mistN = lightMode ? 26 : 58;
      var mistMat = new THREE.SpriteMaterial({
        map: mistTex, transparent: true, depthWrite: false, fog: true,
        opacity: 0.24 + 0.16 * (T.wet || 0), color: T.fog
      });
      for (var gm = 0; gm < mistN; gm++) {
        var gmSp = new THREE.Sprite(mistMat);
        gmSp.scale.set(26 + (gm % 4) * 9, 5.5 + (gm % 3) * 2.2, 1);
        scene.add(gmSp);
        mistPatches.push({
          sp: gmSp,
          lat: (Math.random() - 0.5) * 46,
          z: Math.random() * 320 - 40,
          lift: 1.1 + Math.random() * 1.8,
          drift: (Math.random() - 0.5) * 0.9
        });
      }
    }

    /* ---- Victoria Falls: the mile-wide curtain across the First Gorge ----
       The last stretch of trail rides the Knife-Edge rim. Across the chasm,
       the curtain drops in named segments split by basalt islands — Devil's
       Cataract, Main Falls, Rainbow Falls, the Eastern Cataract — with the
       flat upper Zambezi arriving at the lip and spray columns towering out
       of the gorge. Built in world space; the group sits at the origin. */
    var wf = null;
    if (id === "falls" && world.def.gorge) {
      wf = new THREE.Group();
      var G = world.def.gorge;
      var n3 = world.trailN;
      var trailXAt = function (z2) {
        var ti3 = Math.max(0, Math.min(n3 - 1, Math.round((z2 - world.trail[0].z) / 5)));
        return world.trail[ti3];
      };
      var zA = world.trail[Math.floor(n3 * G.fromFrac)].z + 14;
      var zB = Math.min(world.trail[n3 - 1].z + 80, world.z0 + (world.nz - 1) * world.step - 10);

      var waterTexA = streakTex.clone(); waterTexA.needsUpdate = true;
      waterTexA.repeat.set(3, 2.6);
      var waterTexB = streakTex.clone(); waterTexB.needsUpdate = true;
      waterTexB.repeat.set(4, 1.7);
      wf.waterTexA = waterTexA; wf.waterTexB = waterTexB;
      /* The curtain used to be an UNLIT white at sRGB 245 against a fog colour
         of 227: white on white, and at dusk it stayed bright while the world
         around it went dark. Darkening the basalt behind it gives the water
         something to be white against, and a lit material lets the falls
         follow the mood of the day like everything else. */
      var basaltM = new THREE.MeshStandardMaterial({ color: 0x272D2A, roughness: 0.97 });
      var curtainM = new THREE.MeshLambertMaterial({
        map: waterTexA, transparent: true, opacity: 0.96, color: 0xF2FFFB,
        depthWrite: false, side: THREE.DoubleSide
      });
      var shimmerM = new THREE.MeshBasicMaterial({
        map: waterTexB, transparent: true, opacity: 0.5, color: 0xFFFFFF,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide
      });
      var lipM = new THREE.MeshBasicMaterial({ color: 0xDFF3EE, transparent: true, opacity: 0.9, depthWrite: false });
      var floorM = new THREE.MeshPhongMaterial({
        color: 0x0E211C, shininess: 90, specular: 0x88BCB0, transparent: true, opacity: 0.94
      });

      /* smoothed wall line: anchors average the trail over ±45 m so the
         curtain runs as one continuous wall instead of zigzag slabs */
      function anchor(z2) {
        var sx = 0, sy = 0, cnt = 0;
        for (var ai = 0; ai < n3; ai++) {
          if (Math.abs(world.trail[ai].z - z2) < 45) { sx += world.trail[ai].x; sy += world.trail[ai].y; cnt++; }
        }
        if (!cnt) { var lastP = world.trail[n3 - 1]; sx = lastP.x; sy = lastP.y; cnt = 1; }
        return { x: sx / cnt + G.offset + G.width - 2, lip: sy / cnt + 5, floor: sy / cnt - G.depth };
      }
      function wallQuad(a0, a1, z0q, z1q, mat, xOff, topPad, botPad, vRep) {
        var gq = new THREE.BufferGeometry();
        gq.setAttribute("position", new THREE.BufferAttribute(new Float32Array([
          a0.x + xOff, a0.floor - botPad, z0q,
          a0.x + xOff, a0.lip + topPad, z0q,
          a1.x + xOff, a1.lip + topPad, z1q,
          a1.x + xOff, a1.floor - botPad, z1q
        ]), 3));
        var uw = (z1q - z0q) / 30;
        gq.setAttribute("uv", new THREE.BufferAttribute(new Float32Array([
          0, 0, 0, vRep, uw, vRep, uw, 0
        ]), 2));
        gq.setIndex([0, 1, 2, 0, 2, 3]);
        gq.computeVertexNormals();
        var mq = new THREE.Mesh(gq, mat);
        wf.add(mq);
        return mq;
      }

      /* segment pattern along the gorge: [curtain width, island width] */
      var PATTERN = [[46, 10], [82, 16], [64, 9], [40, 8], [52, 12]];
      var segZ = zA, pat = 0;
      var plunges = [];
      while (segZ < zB - 12) {
        var segW = Math.min(PATTERN[pat % PATTERN.length][0], zB - segZ);
        var islW = PATTERN[pat % PATTERN.length][1];
        var a0 = anchor(segZ), a1 = anchor(segZ + segW);
        var zMid = segZ + segW / 2;

        wallQuad(a0, a1, segZ, segZ + segW, curtainM, 0, 1, 2, 3.2);
        wallQuad(a0, a1, segZ, segZ + segW, shimmerM, -0.4, 0.6, 2, 1.9);
        /* the upper Zambezi arriving flat behind this stretch of lip */
        var riv = new THREE.Mesh(new THREE.PlaneGeometry(52, segW + islW + 4),
          new THREE.MeshBasicMaterial({ color: 0xBFE8E2, transparent: true, opacity: 0.8 }));
        riv.rotation.x = -Math.PI / 2;
        riv.rotation.z = Math.PI / 2;
        riv.position.set((a0.x + a1.x) / 2 + 27, (a0.lip + a1.lip) / 2 + 0.35, zMid + islW / 2);
        wf.add(riv);
        /* bright lip strip where the river folds over the edge */
        var lip = new THREE.Mesh(new THREE.PlaneGeometry(segW, 6), lipM);
        lip.rotation.set(-Math.PI / 2 + 0.1, -Math.PI / 2, 0, "YXZ");
        lip.position.set((a0.x + a1.x) / 2 + 2.4, (a0.lip + a1.lip) / 2 + 0.6, zMid);
        wf.add(lip);
        /* the gorge floor pool under this curtain */
        var pool = new THREE.Mesh(new THREE.PlaneGeometry(G.width - 8, segW + islW), floorM);
        pool.rotation.x = -Math.PI / 2;
        pool.rotation.z = Math.PI / 2;
        pool.position.set((a0.x + a1.x) / 2 - G.width / 2 + 4, (a0.floor + a1.floor) / 2 + 1.6, zMid + islW / 2);
        wf.add(pool);
        plunges.push({ x: (a0.x + a1.x) / 2 - 7, y: (a0.floor + a1.floor) / 2 + 2, z: zMid });

        /* basalt island buttress between this curtain and the next — it just
           breaks the lip line, like Livingstone Island does */
        if (segZ + segW + islW < zB) {
          var am = anchor(segZ + segW + islW / 2);
          var isl = new THREE.Mesh(new THREE.BoxGeometry(12, am.lip - am.floor + 3, islW + 2), basaltM);
          isl.position.set(am.x, (am.lip + am.floor) / 2 + 0.5, segZ + segW + islW / 2);
          wf.add(isl);
        }
        segZ += segW + islW;
        pat++;
      }

      /* towering spray columns — the smoke that thunders — rising from mid
         gorge so they accent the curtain instead of hiding it */
      wf.mists = [];
      for (var mi = 0; mi < plunges.length; mi++) {
        var pl = plunges[mi];
        var m2 = new THREE.Sprite(new THREE.SpriteMaterial({ map: mistTex, transparent: true, opacity: 0.3, depthWrite: false }));
        m2.scale.set(40 + (mi % 3) * 12, 62 + (mi % 2) * 20, 1);
        m2.position.set(pl.x - 24, pl.y + 26, pl.z);
        wf.add(m2);
        wf.mists.push(m2);
      }

      /* plunge rings on the biggest pool */
      wf.rings = [];
      var ringAt = plunges[Math.min(1, plunges.length - 1)];
      for (var qi = 0; qi < 3; qi++) {
        var ring = new THREE.Mesh(new THREE.RingGeometry(1, 1.4, 22),
          new THREE.MeshBasicMaterial({ color: 0xFFFFFF, transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide }));
        ring.rotation.x = -Math.PI / 2;
        ring.position.set(ringAt.x, ringAt.y + 0.3, ringAt.z);
        ring.userData.phase = qi / 3;
        wf.add(ring);
        wf.rings.push(ring);
      }

      /* rising spray particles clustered at the plunge points */
      if (!lightMode) {
        var sprayN = 90;
        var sprayPos = new Float32Array(sprayN * 3);
        wf.sprayData = [];
        for (var pi = 0; pi < sprayN; pi++) {
          var pb = plunges[pi % plunges.length];
          wf.sprayData.push({
            a: Math.random() * 6.28, r: 3 + Math.random() * 12, v: 4 + Math.random() * 6,
            life: Math.random(), bx: pb.x, by: pb.y, bz: pb.z + (Math.random() - 0.5) * 24
          });
        }
        var sprayGeo = new THREE.BufferGeometry();
        sprayGeo.setAttribute("position", new THREE.BufferAttribute(sprayPos, 3));
        var spray = new THREE.Points(sprayGeo, new THREE.PointsMaterial({
          map: mistTex, size: 5, transparent: true, opacity: 0.45, depthWrite: false
        }));
        wf.add(spray);
        wf.spray = spray;
      }

      /* sun shafts + the double rainbow over the chasm */
      var vpTp = trailXAt(world.trail[n3 - 1].z);
      if (!lightMode) {
        for (var hi = 0; hi < 2; hi++) {
          var shaft = new THREE.Mesh(new THREE.PlaneGeometry(9 + hi * 5, 70),
            new THREE.MeshBasicMaterial({
              color: 0xFFF8E0, transparent: true, opacity: 0.09,
              blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false
            }));
          shaft.position.set(vpTp.x + G.offset + 30 + hi * 16, vpTp.y + 26, vpTp.z - 40 - hi * 30);
          shaft.rotation.z = 0.3;
          wf.add(shaft);
        }
      }
      var rcols = [0xE8791D, 0xF7B733, 0x2A9D8F];
      [[34, vpTp.z - 26, 0.34], [23, vpTp.z + 26, 0.2]].forEach(function (rb) {
        for (var ri = 0; ri < 3; ri++) {
          var arc = new THREE.Mesh(new THREE.TorusGeometry(rb[0] - ri * 1.5, 0.55, 6, 30, Math.PI),
            new THREE.MeshBasicMaterial({ color: rcols[ri], transparent: true, opacity: rb[2], depthWrite: false }));
          arc.position.set(vpTp.x + G.offset + G.width * 0.45, vpTp.y - G.depth + 10, rb[1]);
          wf.add(arc);
        }
      });

      wf.worldPos = new THREE.Vector3(vpTp.x + G.offset + G.width / 2, vpTp.y, world.trail[Math.floor(n3 * 0.95)].z);
      scene.add(wf);
    }

    /* ---- RAIN ----
       One draw call, and the CPU never touches a drop. Every streak is an
       instance of a single quad; the vertex shader takes its seed, adds the
       drift (one uniform, advanced once a frame) and wraps it inside a box
       that is anchored to the camera — so the rain is always around you and
       nothing ever has to be respawned. The streak leans back as you speed
       up, which is what rain does when you ride into it. */
    var rain = null;
    if (wxK > 0) {
      /* Many thin, faint, SHORT streaks close in beat a few long bright ones:
         the first reads as rain, the second reads as white poles. A tighter
         box also puts the same number of drops nearer the camera, where they
         are the only ones you can actually see. */
      var RAIN_N = lightMode ? 700 : 2000;
      var RAIN_BOX = new THREE.Vector3(38, 24, 38);
      var quadG = new THREE.PlaneGeometry(1, 1);
      var rGeo = new THREE.InstancedBufferGeometry();
      rGeo.index = quadG.index;
      rGeo.setAttribute("position", quadG.attributes.position.clone());
      rGeo.setAttribute("uv", quadG.attributes.uv.clone());
      var rSeed = new Float32Array(RAIN_N * 4);
      for (var rq = 0; rq < RAIN_N; rq++) {
        rSeed[rq * 4] = Math.random();
        rSeed[rq * 4 + 1] = Math.random();
        rSeed[rq * 4 + 2] = Math.random();
        rSeed[rq * 4 + 3] = 0.55 + Math.random() * 0.55;
      }
      rGeo.setAttribute("aSeed", new THREE.InstancedBufferAttribute(rSeed, 4));
      rGeo.instanceCount = RAIN_N;
      rGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 90);
      var rainMat = new THREE.ShaderMaterial({
        transparent: true, depthWrite: false, blending: THREE.NormalBlending,
        uniforms: {
          uCam: { value: new THREE.Vector3() },
          uDrift: { value: new THREE.Vector3() },
          uBox: { value: RAIN_BOX },
          uLean: { value: new THREE.Vector2(0, 0) },   /* how far the streak lies over */
          uLen: { value: 1.0 },
          uTint: { value: new THREE.Color(0xBACBD6) },
          uAlpha: { value: Math.min(0.4, 0.16 + 0.12 * wxK) }
        },
        vertexShader: [
          "attribute vec4 aSeed;",
          "uniform vec3 uCam; uniform vec3 uDrift; uniform vec3 uBox;",
          "uniform vec2 uLean; uniform float uLen;",
          "varying float vFade;",
          "void main() {",
          "  vec3 base = (aSeed.xyz - 0.5) * uBox;",
          "  vec3 p = base + uDrift;",
          "  p = mod(p + uBox * 0.5, uBox) - uBox * 0.5;",   /* wrap inside the box */
          "  vec3 world = p + uCam;",
          /* the quad: y is the streak's length, x its (thin) width */
          "  float len = (0.42 + aSeed.w * 0.62) * uLen;",
          "  float wid = 0.012 + aSeed.w * 0.016;",
          "  vec3 up = normalize(vec3(uLean.x, -1.0, uLean.y));",
          "  vec3 side = normalize(cross(up, normalize(uCam - world + vec3(0.0, 0.001, 0.0))));",
          "  world += up * (position.y * len) + side * (position.x * wid);",
          "  vec4 mv = modelViewMatrix * vec4(world, 1.0);",
          /* fade the far ones out so the box has no visible edge */
          "  vFade = 1.0 - smoothstep(uBox.x * 0.16, uBox.x * 0.46, length(p.xz));",
          "  gl_Position = projectionMatrix * mv;",
          "}"
        ].join("\n"),
        fragmentShader: [
          "uniform vec3 uTint; uniform float uAlpha;",
          "varying float vFade;",
          "void main() {",
          "  if (vFade <= 0.01) discard;",
          "  gl_FragColor = vec4(uTint, uAlpha * vFade);",
          "}"
        ].join("\n")
      });
      rain = new THREE.Mesh(rGeo, rainMat);
      rain.frustumCulled = false;
      rain.renderOrder = 10;      /* after the opaque world, never before it */
      scene.add(rain);
    }

    var cached = {
      scene: scene, coinMesh: coinMesh, clouds: clouds, wf: wf,
      rain: rain, rainDrift: new THREE.Vector3(), wxK: wxK, bolts: bolts,
      hemi: hemiLight, amb: amb, hemiI0: hemiLight.intensity, ambI0: amb.intensity,
      fogBase: scene.fog ? scene.fog.color.clone() : null,
      flash: 0, flashT: -99, nextFlash: 0,
      dome: dome, sky: skyObj, ridges: [ridgeFar, ridgeNear], sunSp: sunSp, sun: sun, sunDir: sunDir,
      birds: birds, exposure: exposure, swayMats: sceneLeafMats.slice(),
      crocs: crocs, riverTex: riverTex, batStreams: batStreams, fauna: fauna,
      mist: mistPatches, world: world
    };
    sceneCache[key] = cached;
    return cached;
  }

  /* wildlife builders */
  /* ---------------------------------------------------------------
     Wildlife.

     Every animal is built round a few named, movable parts hung on
     g.userData.anim: a head that can lift and turn, ears that flick, a
     tail that swishes. Nothing here moves the animal's POSITION — the
     collision body for a hazard is fixed at world-build time inside the
     deterministic core, shared with the AI riders and with server-side
     ghost checking, so an elephant that wandered would quietly change
     everybody's times. They react in place, and honestly: what you see
     is exactly what you can hit.
     --------------------------------------------------------------- */

  /* a tail on a hinge, so it can swish */
  function tailOn(parent, len, rad, m, x, y, z) {
    var t = new THREE.Group();
    t.position.set(x, y, z);
    var seg = new THREE.Mesh(new THREE.CylinderGeometry(rad * 0.6, rad, len, 5), m);
    seg.position.y = -len / 2;
    t.add(seg);
    parent.add(t);
    return t;
  }
  /* an ear on a hinge at its inner edge */
  function earOn(parent, geo, m, x, y, z, sign) {
    var e = new THREE.Group();
    e.position.set(x, y, z);
    var mesh = new THREE.Mesh(geo, m);
    mesh.position.x = sign * 0.32;
    e.add(mesh);
    parent.add(e);
    return e;
  }

  function buildElephant() {
    var m = lam(0x6E655C), g = new THREE.Group();
    var body = new THREE.Mesh(new THREE.SphereGeometry(1.5, 9, 7).scale(1.25, 1, 0.85), m);
    body.position.y = 2.0;
    g.add(body);
    /* dust-bathed elephants really do carry a pale line along the belly */
    counterShade(g, 1.85, 1.42, 1.25, 2.0, { pale: 0xC9BEAE, dark: 0x2A241F });

    /* head, trunk and those enormous ears all swing together */
    var headG = new THREE.Group();
    headG.position.set(0, 2.45, 1.0);
    var head = new THREE.Mesh(new THREE.SphereGeometry(0.85, 8, 6), m);
    head.position.set(0, 0.05, 0.55);
    headG.add(head);
    var trunk = new THREE.Group();
    trunk.position.set(0, -0.5, 1.05);
    var trunkM = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.24, 1.7, 6), m);
    trunkM.position.y = -0.8;
    trunk.add(trunkM);
    trunk.rotation.x = 0.35;
    headG.add(trunk);
    var earG = new THREE.SphereGeometry(0.55, 6, 5).scale(0.2, 1, 0.8);
    var earL = earOn(headG, earG, m, -0.62, 0.2, 0.35, -1);
    var earR = earOn(headG, earG, m, 0.62, 0.2, 0.35, 1);
    g.add(headG);

    var tail = tailOn(g, 1.0, 0.07, m, 0, 2.2, -1.75);
    [[-0.7, 0.55], [0.7, 0.55], [-0.7, -0.7], [0.7, -0.7]].forEach(function (l) {
      var leg = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.3, 1.5, 6), m);
      leg.position.set(l[0], 0.75, l[1]);
      g.add(leg);
    });
    g.userData.anim = { kind: "elephant", head: headG, trunk: trunk, earL: earL, earR: earR, tail: tail, body: body, graze: 0.2 };
    return g;
  }

  function buildGiraffe() {
    var m = lam(0xC9973F), g = new THREE.Group();
    var body = new THREE.Mesh(new THREE.SphereGeometry(0.95, 8, 6).scale(1.35, 0.9, 0.7), m);
    body.position.y = 2.2;
    g.add(body);
    /* the whole neck hinges at the shoulders — that IS a giraffe */
    var headG = new THREE.Group();
    headG.position.set(0, 2.5, 0.55);
    var neck = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.26, 2.6, 6), m);
    neck.position.set(0, 1.2, 0.4);
    neck.rotation.x = -0.35;
    var head = new THREE.Mesh(new THREE.SphereGeometry(0.32, 7, 5).scale(1, 0.8, 1.4), m);
    head.position.set(0, 2.4, 0.95);
    headG.add(neck, head);
    g.add(headG);
    var tail = tailOn(g, 0.9, 0.05, m, 0, 2.4, -1.25);
    [[-0.5, 0.55], [0.5, 0.55], [-0.5, -0.55], [0.5, -0.55]].forEach(function (l) {
      var leg = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.13, 2.2, 5), m);
      leg.position.set(l[0], 1.1, l[1]);
      g.add(leg);
    });
    g.userData.anim = { kind: "giraffe", head: headG, tail: tail, body: body, graze: 0.16 };
    return g;
  }

  function buildZebra() {
    /* a zebra is already the highest-contrast animal in Africa; it only needs
       its stripes to survive being small on screen */
    var m = lam(0xF2EDE2), dm = lam(0x241F18), g = new THREE.Group();
    var body = new THREE.Mesh(new THREE.SphereGeometry(0.8, 8, 6).scale(1.4, 0.85, 0.65), m);
    body.position.y = 1.35;
    g.add(body);
    var headG = new THREE.Group();
    headG.position.set(0, 1.55, 0.55);
    var neck = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.24, 1.0, 6), m);
    neck.position.set(0, 0.4, 0.3);
    neck.rotation.x = -0.5;
    var head = new THREE.Mesh(new THREE.SphereGeometry(0.24, 7, 5).scale(1, 0.8, 1.5), m);
    head.position.set(0, 0.8, 0.6);
    var earG = new THREE.ConeGeometry(0.07, 0.22, 4);
    var earL = earOn(headG, earG, m, -0.1, 0.95, 0.45, 0);
    var earR = earOn(headG, earG, m, 0.1, 0.95, 0.45, 0);
    headG.add(neck, head);
    g.add(headG);
    for (var i = 0; i < 4; i++) {
      var ring = new THREE.Mesh(new THREE.TorusGeometry(0.62 - Math.abs(i - 1.5) * 0.07, 0.05, 5, 10), dm);
      ring.rotation.y = Math.PI / 2;
      ring.position.set(-0.6 + i * 0.42, 1.35, 0);
      g.add(ring);
    }
    var tail = tailOn(g, 0.75, 0.045, dm, 0, 1.5, -1.05);
    [[-0.45, 0.4], [0.45, 0.4], [-0.45, -0.4], [0.45, -0.4]].forEach(function (l) {
      var leg = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.1, 1.35, 5), m);
      leg.position.set(l[0], 0.68, l[1]);
      g.add(leg);
    });
    g.userData.anim = { kind: "zebra", head: headG, earL: earL, earR: earR, tail: tail, body: body, graze: -0.55 };
    return g;
  }

  /* COUNTER-SHADING.
     A hippo lying on the racing line measured 1.12:1 luminance contrast
     against its own background at every distance from 27 m to 158 m: the
     animal palettes and the trail dirt are the same handful of browns. Real
     antelope are counter-shaded — pale belly, dark flank line — and that is
     also the thing that makes them readable at speed, because a hard
     light-to-dark edge survives distance, fog and bloom in a way that a flat
     brown mass does not. Every hazard now wears one. */
  var HIDE_PALE = 0xF4E9D6, HIDE_DARK = 0x231B12;
  function counterShade(g, w, h, d, y, opts) {
    opts = opts || {};
    var pale = lam(opts.pale || HIDE_PALE), dark = lam(opts.dark || HIDE_DARK);
    var belly = new THREE.Mesh(new THREE.SphereGeometry(1, 8, 6).scale(w * 0.96, h * 0.42, d * 0.9), pale);
    belly.position.set(0, y - h * 0.5, opts.z || 0);
    var band = new THREE.Mesh(new THREE.BoxGeometry(w * 2.05, h * 0.2, d * 1.55), dark);
    band.position.set(0, y - h * 0.16, opts.z || 0);
    g.add(belly, band);
    return { belly: belly, band: band };
  }

  function buildAntelope() {
    var m = lam(0x9A6B3F), g = new THREE.Group();
    var body = new THREE.Mesh(new THREE.SphereGeometry(0.6, 8, 6).scale(1.35, 0.8, 0.6), m);
    body.position.y = 1.05;
    g.add(body);
    counterShade(g, 0.81, 0.48, 0.36, 1.05);
    /* and a rump patch, which is the bit you actually see going away from you */
    var rump = new THREE.Mesh(new THREE.SphereGeometry(0.26, 7, 5), lam(0xF8F1E2));
    rump.position.set(0, 1.12, -0.72);
    g.add(rump);
    var headG = new THREE.Group();
    headG.position.set(0, 1.2, 0.45);
    var neck = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.16, 0.8, 5), m);
    neck.position.set(0, 0.32, 0.2);
    neck.rotation.x = -0.4;
    var head = new THREE.Mesh(new THREE.SphereGeometry(0.17, 6, 5).scale(1, 0.8, 1.4), m);
    head.position.set(0, 0.65, 0.42);
    headG.add(neck, head);
    for (var i = 0; i < 2; i++) {
      var horn = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.045, 0.7, 4), lam(0x4A3A28));
      horn.position.set(i === 0 ? -0.08 : 0.08, 1.0, 0.32);
      horn.rotation.x = -0.3;
      horn.rotation.z = i === 0 ? 0.25 : -0.25;
      headG.add(horn);
    }
    var earG = new THREE.ConeGeometry(0.06, 0.2, 4);
    var earL = earOn(headG, earG, m, -0.09, 0.75, 0.3, 0);
    var earR = earOn(headG, earG, m, 0.09, 0.75, 0.3, 0);
    g.add(headG);
    var tail = tailOn(g, 0.4, 0.03, m, 0, 1.2, -0.8);
    [[-0.32, 0.32], [0.32, 0.32], [-0.32, -0.32], [0.32, -0.32]].forEach(function (l) {
      var leg = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 1.05, 4), m);
      leg.position.set(l[0], 0.5, l[1]);
      g.add(leg);
    });
    g.userData.anim = { kind: "antelope", head: headG, earL: earL, earR: earR, tail: tail, body: body, graze: -0.7 };
    return g;
  }

  /* The black rhino: a grey armoured wedge with two horns and a bad temper.
     Wider and lower than the elephant, and it holds its head DOWN — which is
     exactly what makes it read as a rhino from forty metres out. */
  function buildRhino() {
    var m = lam(0x6E6A66), horn = lam(0xD8D2C4), g = new THREE.Group();
    /* barrel body, hips higher than shoulders, with a shoulder hump */
    var body = new THREE.Mesh(new THREE.SphereGeometry(1.0, 10, 7).scale(1.0, 0.92, 1.9), m);
    body.position.set(0, 1.35, -0.15);
    var hump = new THREE.Mesh(new THREE.SphereGeometry(0.62, 8, 6).scale(1.0, 0.62, 1.25), m);
    hump.position.set(0, 1.95, 0.35);
    g.add(body, hump);
    counterShade(g, 1.0, 0.92, 1.55, 1.35, { pale: 0xBDB6AE, dark: 0x262320, z: -0.15 });

    /* the head hangs low off a thick neck and swings side to side */
    var headG = new THREE.Group();
    headG.position.set(0, 1.65, 1.35);
    var neck = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.5, 0.7, 7), m);
    neck.position.set(0, -0.05, -0.2);
    neck.rotation.x = 1.15;
    var head = new THREE.Mesh(new THREE.SphereGeometry(0.45, 8, 6).scale(0.85, 0.8, 1.5), m);
    head.position.set(0, -0.42, 0.62);
    var snout = new THREE.Mesh(new THREE.SphereGeometry(0.26, 7, 5).scale(0.9, 0.75, 1.1), m);
    snout.position.set(0, -0.55, 1.2);
    headG.add(neck, head, snout);
    /* the front horn is the long one; the second sits behind and above it */
    var h1 = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.95, 7), horn);
    h1.position.set(0, -0.18, 1.32);
    h1.rotation.x = -0.55;
    var h2 = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.42, 6), horn);
    h2.position.set(0, -0.02, 0.86);
    h2.rotation.x = -0.3;
    headG.add(h1, h2);
    /* little tube ears, the give-away that a rhino is listening to you */
    var earG = new THREE.CylinderGeometry(0.09, 0.11, 0.24, 6);
    var earL = earOn(headG, earG, m, -0.24, 0.05, 0.1, 0);
    var earR = earOn(headG, earG, m, 0.24, 0.05, 0.1, 0);
    g.add(headG);

    var tail = tailOn(g, 0.55, 0.05, m, 0, 1.5, -1.95);
    [[-0.55, 1.0], [0.55, 1.0], [-0.55, -1.05], [0.55, -1.05]].forEach(function (l) {
      var leg = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.3, 1.15, 6), m);
      leg.position.set(l[0], 0.58, l[1]);
      g.add(leg);
      var foot = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.3, 0.16, 7), lam(0x565250));
      foot.position.set(l[0], 0.08, l[1]);
      g.add(foot);
    });
    g.userData.anim = { kind: "rhino", head: headG, earL: earL, earR: earR, tail: tail, body: body, graze: 0.18 };
    return g;
  }

  function buildCroc() {
    /* khaki back + near-black scutes + cream jaw: reads as "croc!" from 40 m
       out on green ground, which the kids need to dodge it in time */
    var olive = lam(0x39441F), oliveD = lam(0x161A0C), teeth = lam(0xF2EBD8);
    var g = new THREE.Group();
    /* body + ridged tail */
    var body = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 8), olive);
    body.scale.set(0.44, 0.26, 1.05);
    body.position.set(0, 0.26, -0.2);
    g.add(body);
    /* a cream flank stripe along the waterline of the body: a real crocodile
       has one, and it is the only thing that separates a basking croc from
       the sand it is basking on at forty metres */
    var flank = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 6), teeth);
    flank.scale.set(0.455, 0.09, 1.0);
    flank.position.set(0, 0.17, -0.2);
    g.add(flank);
    var tail = new THREE.Group();
    tail.position.set(0, 0.24, -1.1);
    var seg1 = new THREE.Mesh(new THREE.ConeGeometry(0.22, 1.1, 6), olive);
    seg1.rotation.x = -Math.PI / 2;
    seg1.position.z = -0.5;
    tail.add(seg1);
    var seg2 = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.8, 5), oliveD);
    seg2.rotation.x = -Math.PI / 2;
    seg2.position.z = -1.15;
    tail.add(seg2);
    g.add(tail);
    /* dorsal scutes */
    for (var i = 0; i < 6; i++) {
      var sc2 = new THREE.Mesh(new THREE.ConeGeometry(0.075, 0.15, 4), oliveD);
      sc2.position.set((i % 2 ? 0.09 : -0.09), 0.48 - i * 0.015, -0.55 - i * 0.14);
      g.add(sc2);
    }
    /* head: fixed upper jaw + animated lower jaw */
    var head = new THREE.Group();
    head.position.set(0, 0.26, 0.75);
    var upper = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.14, 0.85), olive);
    upper.position.set(0, 0.06, 0.32);
    head.add(upper);
    var snoutTip = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.11, 0.2), olive);
    snoutTip.position.set(0, 0.045, 0.78);
    head.add(snoutTip);
    [-0.1, 0.1].forEach(function (x) {
      var eye = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 6), oliveD);
      eye.position.set(x, 0.16, 0.12);
      head.add(eye);
      var pupil = new THREE.Mesh(new THREE.SphereGeometry(0.018, 6, 5), lam(0x1A1A10));
      pupil.position.set(x, 0.185, 0.15);
      head.add(pupil);
      var nostril = new THREE.Mesh(new THREE.SphereGeometry(0.028, 6, 5), oliveD);
      nostril.position.set(x * 0.6, 0.11, 0.85);
      head.add(nostril);
    });
    /* teeth on the upper lip */
    for (i = 0; i < 5; i++) {
      [-0.14, 0.14].forEach(function (x) {
        var t2 = new THREE.Mesh(new THREE.ConeGeometry(0.016, 0.05, 4), teeth);
        t2.rotation.x = Math.PI;
        t2.position.set(x, -0.015, 0.25 + i * 0.13);
        head.add(t2);
      });
    }
    var jaw = new THREE.Group();
    jaw.position.set(0, -0.02, 0);
    var lower = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.08, 0.92), lam(0xD8CBA4));
    lower.position.set(0, -0.04, 0.42);
    jaw.add(lower);
    var gape = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.015, 0.8), lam(0xC96A5A));
    gape.position.set(0, 0.005, 0.42);
    jaw.add(gape);
    head.add(jaw);
    g.add(head);
    /* stubby splayed legs */
    [[-0.38, 0.25, 0.55], [0.38, 0.25, 0.55], [-0.4, 0.25, -0.75], [0.4, 0.25, -0.75]].forEach(function (l) {
      var leg = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 0.3, 6), olive);
      leg.position.set(l[0], l[1] - 0.12, l[2]);
      leg.rotation.z = l[0] > 0 ? -0.5 : 0.5;
      g.add(leg);
    });
    g.userData = { jaw: jaw, tail: tail, phase: Math.random() * 6.28 };
    return g;
  }

  function buildHippo(land) {
    var grey = lam(0x574752), greyD = lam(0x2E2429);
    var g = new THREE.Group();
    var back = new THREE.Mesh(new THREE.SphereGeometry(1.3, 10, 8), grey);
    back.scale.set(0.85, land ? 0.62 : 0.5, 1.15);
    back.position.set(0, land ? 0.62 : -0.25, -0.4);
    g.add(back);
    if (land) {
      /* a hippo out of the water is pink-bellied and dark-backed */
      counterShade(g, 1.1, 0.8, 1.35, 0.62, { pale: 0xE8B8A8, dark: 0x1F1A1D, z: -0.4 });
      [[-0.45, 0.35], [0.45, 0.35], [-0.45, -1.1], [0.45, -1.1]].forEach(function (lp) {
        var leg = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.19, 0.6, 8), grey);
        leg.position.set(lp[0], 0.3, lp[1]);
        g.add(leg);
      });
    }
    var hLift = land ? 0.55 : 0;
    var head = new THREE.Mesh(new THREE.SphereGeometry(0.62, 10, 8), grey);
    head.scale.set(0.9, 0.62, 1.25);
    head.position.set(0, 0.02 + hLift, 1.05);
    g.add(head);
    [-0.24, 0.24].forEach(function (x) {
      var ear = new THREE.Mesh(new THREE.SphereGeometry(0.09, 6, 5), greyD);
      ear.position.set(x, 0.42 + hLift, 0.78);
      g.add(ear);
      var eye = new THREE.Mesh(new THREE.SphereGeometry(0.07, 6, 5), greyD);
      eye.position.set(x, 0.3 + hLift, 1.06);
      g.add(eye);
      var nostril = new THREE.Mesh(new THREE.SphereGeometry(0.06, 6, 5), greyD);
      nostril.position.set(x * 0.55, 0.28 + hLift, 1.65);
      g.add(nostril);
    });
    return g;
  }

  /* ---------- dust particles ---------- */

  var dustPool = [];
  var wetSpray = false;
  function initDust(scene) {
    dustPool.forEach(function (d) { if (d.sp.parent) d.sp.parent.remove(d.sp); });
    dustPool = [];
    /* on a wet trail a wheel does not raise dust, it throws water */
    wetSpray = curWx().k > 0;
    var tex = wetSpray ? sprayTex : dustTex;
    for (var i = 0; i < 26; i++) {
      var sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0 }));
      sp.scale.set(0.9, 0.9, 1);
      scene.add(sp);
      dustPool.push({ sp: sp, life: 0, vx: 0, vy: 0, vz: 0 });
    }
  }
  var dustIdx = 0;
  function spawnDust(x, y, z, n, yaw) {
    for (var i = 0; i < n; i++) {
      var d = dustPool[dustIdx++ % dustPool.length];
      d.sp.position.set(x + (Math.random() - 0.5) * 0.8, y + 0.15, z + (Math.random() - 0.5) * 0.8);
      if (wetSpray) {
        /* water is heavier than dust: it goes backwards off the tyre in a
           rooster tail and dies quickly instead of hanging in the air */
        d.life = 0.38;
        d.vy = 0.6 + Math.random() * 0.9;
        var sy = yaw === undefined ? 0 : yaw;
        d.vx = -Math.sin(sy) * 3.5 + (Math.random() - 0.5) * 1.6;
        d.vz = -Math.cos(sy) * 3.5 + (Math.random() - 0.5) * 1.6;
      } else {
        d.life = 0.55;
        d.vx = (Math.random() - 0.5) * 2.2;
        d.vy = 1 + Math.random() * 1.6;
        d.vz = (Math.random() - 0.5) * 2.2;
      }
    }
  }
  function updateDust(dt) {
    dustPool.forEach(function (d) {
      if (d.life <= 0) { d.sp.material.opacity = 0; return; }
      d.life -= dt;
      d.sp.position.x += d.vx * dt;
      d.sp.position.y += d.vy * dt;
      d.sp.position.z += d.vz * dt;
      d.sp.material.opacity = Math.max(0, d.life * (wetSpray ? 1.9 : 1.4));
      var s = 0.9 + ((wetSpray ? 0.38 : 0.55) - d.life) * (wetSpray ? 1.5 : 2.2);
      d.sp.scale.set(s, s, 1);
    });
  }

  /* ====================================================================
     game controller
     ==================================================================== */

  var mode = "menu";
  var selTrack = lsGet("zr3_seltrack", "miombo");
  if (CORE.TRACK3_ORDER.indexOf(selTrack) < 0) selTrack = "miombo";
  if (!CORE.TRACKS3[selTrack]) selTrack = "miombo";
  var run = null;
  var menuT = 0;
  var lastTs = 0;
  var acc = 0;
  var playerRig = null;
  var playerRigs = [];

  /* player one is the saved profile; player two is their own little profile so
     two kids on one keyboard each get their own name and jersey */
  function riderProfile(i) { return i === 1 ? profile2 : profile; }
  var ghostRigs = [];
  var coinDummy = new THREE.Object3D();

  function currentBundle() {
    var wc = getWorld(selTrack);
    var sc = buildScene(selTrack);
    return { wc: wc, sc: sc };
  }

  function placeRig(rig, x, y, z, yaw, lean, extra) {
    rig.group.position.set(x, y, z);
    rig.group.rotation.set(0, yaw, lean || 0, "YXZ");
    if (extra) extra(rig);
  }

  function attachRigs(scene, ghosts) {
    playerRigs.forEach(function (r) { if (r.group.parent) r.group.parent.remove(r.group); });
    playerRigs = [];
    for (var pi = 0; pi < players(); pi++) {
      var rg = buildRiderMesh(new THREE.Color(riderProfile(pi).jersey || "#1F7A48").getHex(), currentBikeCfg());
      enableRigShadows(rg);
      scene.add(rg.group);
      playerRigs.push(rg);
    }
    playerRig = playerRigs[0];
    ghostRigs.forEach(function (r) { if (r.rig.group.parent) r.rig.group.parent.remove(r.rig.group); });
    ghostRigs = [];
    (ghosts || []).forEach(function (gh) {
      var rig = makeGhostRig(gh.name, gh.color || 0x8E44AD);
      scene.add(rig.group);
      ghostRigs.push({ ghost: gh, rig: rig });
    });
  }

  function updateCoins(sc, world, taken, t) {
    var q = new THREE.Quaternion();
    var up = new THREE.Vector3(0, 1, 0);
    var s1 = new THREE.Vector3(1, 1, 1);
    var s0 = new THREE.Vector3(0.0001, 0.0001, 0.0001);
    for (var i = 0; i < world.coins.length; i++) {
      var c = world.coins[i];
      q.setFromAxisAngle(up, t * 2.4 + i * 0.7);
      coinDummy.position.set(c.x, c.y, c.z);
      coinDummy.quaternion.copy(q);
      /* hide taken coins and coins about to hit the camera lens */
      var dcx = c.x - camPos.x, dcy = c.y - camPos.y, dcz = c.z - camPos.z;
      /* hiding a coin about to clip the lens is right for one player and
         maddening for two, where it vanishes out of the other's view */
      var nearCam = players() === 1 && dcx * dcx + dcy * dcy + dcz * dcz < 9;
      coinDummy.scale.copy((taken && taken[i]) || nearCam ? s0 : s1);
      coinDummy.updateMatrix();
      sc.coinMesh.setMatrixAt(i, coinDummy.matrix);
    }
    sc.coinMesh.instanceMatrix.needsUpdate = true;
  }

  /* ---------- race lifecycle ---------- */

  /* Rain does not change the bike, it changes what the bike can do with the
     ground: less bite when you turn, a lot less when you grab the brakes, and
     a shade less drive out of the pedals. */
  function weatherStats(base, grip) {
    if (!grip || grip >= 0.999) return base;
    var k = 1 - grip;
    var out = Object.assign({}, base || {});
    Object.keys(CORE.DEFAULT_STATS || {}).forEach(function (key) {
      if (out[key] === undefined) out[key] = CORE.DEFAULT_STATS[key];
    });
    out.steer = (out.steer || 1) * (1 - k * 1.6);
    out.brake = (out.brake || 1) * (1 - k * 2.8);
    out.pedal = (out.pedal || 1) * (1 - k * 1.0);
    return out;
  }

  /* Build one rider, ready to roll. Everything that used to be spread across
     startRace for the single player now happens once per person on the sofa. */
  function makeRider(i, b, world, devAt, bikeCfg, bikeStats) {
    var st = CORE.newRider3(world);
    if (bikeStats) st.stats = Object.assign({}, bikeStats);   /* never shared */
    /* dev spawn point, e.g. game.html#at=0.9 — handy for testing the finish */
    if (devAt) {
      var gi = Math.max(2, Math.min(world.finishIdx - 4, Math.floor(world.finishIdx * parseFloat(devAt[1]))));
      var dp = world.trail[gi], dq = world.trail[gi + 1];
      st.x = dp.x; st.y = dp.y; st.z = dp.z;
      st.yaw = Math.atan2(dq.x - dp.x, dq.z - dp.z);
      st.trailIdx = gi; st.respawnIdx = gi;
      st.coinPtr = 0;
    }
    /* two riders line up side by side on the gate, not inside each other */
    if (players() === 2) {
      var off = i === 0 ? -1.7 : 1.7;
      st.x += Math.cos(st.yaw) * off;
      st.z += -Math.sin(st.yaw) * off;
      st.y = Math.max(st.y, CORE.heightAt(world, st.x, st.z));
    }
    return {
      st: st,
      view: views[i],
      rig: playerRigs[i] || playerRigs[0],
      input: inputs[i],
      recorder: [],
      step: 0,
      idx: i,
      /* sanitizeName never returns empty, so test the raw string first */
      name: (riderProfile(i).name || "").trim()
        ? CORE.sanitizeName(riderProfile(i).name)
        : (players() === 2 ? "Player " + (i + 1) : "Rider"),
      jersey: riderProfile(i).jersey || (i ? "#E8791D" : "#1F7A48"),
      place: 0,
      bikeName: bikeCfg && BIKES ? BIKES.riderNameForBike(bikeCfg) : "",
      hasBell: !!(bikeCfg && (bikeCfg.extras || []).indexOf("bell") >= 0)
    };
  }

  function startRace() {
    var b = currentBundle();
    var world = b.wc.world;
    var bikeCfg = currentBikeCfg();
    var bikeStats = bikeCfg && BIKES ? BIKES.computeStats(bikeCfg) : null;
    var devAt = /^#at=(0?\.[0-9]+)$/.exec(location.hash || "");
    var practice = !!devAt;
    var ghosts = [];

    /* Weather reaches the bike as numbers the bike already understands, so the
       core, the AI riders and the ghost pipeline never learn that rain exists.
       The AI ghosts deliberately stay DRY: they are the fixed benchmark you
       measure yourself against, exactly as a worn tour bike still races the
       same ghosts. Do not "fix" that. */
    var grip = curWx().grip;
    bikeStats = weatherStats(bikeStats, grip);

    /* on the tour a tired bike really is a tired bike: worn pads, a dragging
       chain and a loose headset all show up in the numbers the physics uses */
    if (tourMode && TOUR && tour) {
      var cs = TOUR.conditionStats(tour.condition);
      var base = bikeStats || {};
      var worn = {};
      Object.keys(CORE.DEFAULT_STATS || {}).concat(Object.keys(base)).forEach(function (k) {
        worn[k] = base[k] !== undefined ? base[k] : 1;
      });
      worn.brake = (worn.brake || 1) * cs.brake;
      worn.steer = (worn.steer || 1) * cs.steer;
      worn.roll = (worn.roll || 1) * cs.roll;
      worn.rough = (worn.rough || 1) * cs.rough;
      bikeStats = worn;
    }

    if (ghostsOn && players() === 1 && !mpMode) {
      ghosts.push(b.wc.armand, b.wc.arthur);
      var mine = lsGet("zr3_bestghost_" + selTrack, null);
      if (validGhostShape(mine)) {
        ghosts.push({ name: "Best " + CORE.sanitizeName(profile.name), color: 0x2A9D8F, samples: mine.samples, timeMs: mine.timeMs });
      }
      friends.filter(function (f) { return f.track === selTrack; }).slice(-2).forEach(function (f) {
        ghosts.push({ name: f.name, color: 0x8E44AD, samples: f.samples, timeMs: f.timeMs });
      });
      /* the two fastest club riders join the start line too */
      (clubGhosts[selTrack] || []).slice(0, 2).forEach(function (c) {
        var dup = ghosts.some(function (g2) { return CORE.sanitizeName(g2.name) === c.name; });
        if (!dup && ghosts.length < 6) ghosts.push({ name: c.name, color: 0xF7B733, samples: c.samples, timeMs: c.timeMs });
      });
    }
    layoutViews();
    attachRigs(b.sc.scene, ghosts);
    initDust(b.sc.scene);

    var riders = [];
    for (var pi2 = 0; pi2 < players(); pi2++) {
      riders.push(makeRider(pi2, b, world, devAt, bikeCfg, bikeStats));
    }

    /* Two riders share one set of coins, so whoever gets there first takes it.
       That is the point: the wide line pays, and only once. */
    var taken = new Array(world.coins.length);
    /* clear coins hovering on a spawn point so none sits on a rider */
    for (var ci2 = 0; ci2 < world.coins.length; ci2++) {
      var co2 = world.coins[ci2];
      for (var ri3 = 0; ri3 < riders.length; ri3++) {
        var dxc = co2.x - riders[ri3].st.x, dzc = co2.z - riders[ri3].st.z;
        if (dxc * dxc + dzc * dzc < 16) { taken[ci2] = 1; break; }
      }
    }
    run = {
      b: b, riders: riders, taken: taken,
      /* aliases so every single-player path keeps working untouched */
      st: riders[0].st, recorder: riders[0].recorder,
      step: 0, ghosts: ghosts, countT: 2.7, endT: 0, lastBeep: 3,
      practice: practice, finishers: 0,
      /* a run with the weather against you cannot set a record, and neither
         can one where somebody else's honesty is part of the result */
      handicapped: grip < 0.999 || mpMode,
      /* the world's own clock, so it keeps turning when rider one is home */
      clock: 0,
      bikeName: riders[0].bikeName,
      hasBell: riders[0].hasBell
    };
    clearInput();
    /* Enter is player two's turbo, so a button left focused by the last click
       would swallow it (and re-fire that button) */
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    acc = 0;
    snapAllViews();
    mode = "count";
    el.menu.hidden = true; el.results.hidden = true; el.pause.hidden = true; el.howto.hidden = true;
    if (el.tour) el.tour.hidden = true;
    if (el.brief) el.brief.hidden = true;
    if (el.shop) el.shop.hidden = true;
    if (el.mp) el.mp.hidden = true;
    el.hud.hidden = false;
    el.countdown.hidden = false;
    if (el.countdown2) el.countdown2.hidden = players() !== 2;
    el.touch.hidden = !isTouch || players() === 2;
    if (el.exitBtn) el.exitBtn.hidden = false;
    if (el.hud2) {
      el.hud2.hidden = players() !== 2;
      if (players() === 2) {
        var e2b = hud2Els();
        e2b[0].key.textContent = "Q";
        e2b[1].key.textContent = "↵";
        eachRider(function (r, i) { if (e2b[i]) e2b[i].flag.hidden = true; });
        updateHUD2(world);
      }
    }
    el.hintKeys.hidden = isTouch || players() === 2;
    if (el.hintKeys2) el.hintKeys2.hidden = isTouch || players() !== 2;
    el.hintTouch.hidden = !isTouch;
    el.hint.hidden = false;
    el.hint.classList.remove("is-fading");
    SFX.count(false);
  }

  function pauseGame() {
    if (mode !== "race" && mode !== "count") return;
    run.pausedFrom = mode;
    mode = "pause";
    clearInput();
    stopRumble();
    stopRain();
    el.pause.hidden = false;
    el.touch.hidden = true;
    if (el.exitBtn) el.exitBtn.hidden = true;
    /* In a live race there is no restarting: your friend is still coming down the
       hill and the clock they are racing is the same one you are. Say so, and take
       the button away rather than leaving a tap that would post an impossible time. */
    var rb = $("btn-restart"), ps = $("pause-sub");
    if (rb) rb.hidden = mpMode;
    if (ps) ps.textContent = mpMode
      ? "The race carries on without you — your friend is still riding."
      : "Even downhill heroes need a mango break.";
  }

  function resumeGame() {
    if (mode !== "pause") return;
    mode = run.pausedFrom || "race";
    el.pause.hidden = true;
    el.touch.hidden = !isTouch;
    if (el.exitBtn) el.exitBtn.hidden = false;
  }

  function quitToMenu() {
    /* abandoning a tour leg drops you back into the roadbook to try again —
       the mechanical is rolled from the stage, so you cannot re-roll your luck */
    var wasTour = tourMode;
    if (mpMode) { if (NET && NET.room) NET.leave(); mpLeaveAll(); }
    tourMode = false;
    pendingFault = null;
    mode = "menu";
    run = null;
    clearInput();
    stopRumble();
    stopRain();
    el.pause.hidden = true; el.results.hidden = true; el.hud.hidden = true;
    el.countdown.hidden = true; el.touch.hidden = true; el.hint.hidden = true;
    if (el.countdown2) el.countdown2.hidden = true;
    if (el.hud2) el.hud2.hidden = true;
    if (el.exitBtn) el.exitBtn.hidden = true;
    if (wasTour && TOUR) { openTour(); return; }
    el.menu.hidden = false;
    refreshMenu();
  }

  function finishRace() {
    var st = run.st;
    var wc = run.b.wc;
    var timeMs = Math.round(st.finishT * 1000);
    var name = CORE.sanitizeName(profile.name);

    /* a live race is a race between the riders in the room: the same deal as
       two on one sofa — no medals, no bests, no ghost, nothing to the board */
    if (mpMode) { mpFinishRace(); return; }

    /* two on the sofa is a race between THEM: no medals, no personal bests,
       no ghost recording and nothing sent to the club board */
    if (players() === 2) { finishVersus(); return; }

    /* a tour leg keeps its own books: no medals, no board, no personal best —
       just the purse, the wear and the clock that runs across all ten */
    if (tourMode && tour) { finishTourStage(st, timeMs); return; }

    var gold = Math.min(wc.armand.timeMs, wc.arthur.timeMs);
    var silver = Math.max(wc.armand.timeMs, wc.arthur.timeMs);
    var bronze = Math.round(silver * 1.35);
    /* the ghosts ride dry, so a wet run is not measured against them */
    var medal = run.handicapped ? "none"
      : timeMs <= gold ? "gold" : timeMs <= silver ? "silver" : timeMs <= bronze ? "bronze" : "none";

    /* workshop career: real riding unlocks garage parts (never in practice) */
    function lockedList() {
      var out = [];
      if (!BIKES) return out;
      Object.keys(BIKES.CATALOG).forEach(function (cat) {
        Object.keys(BIKES.CATALOG[cat].options).forEach(function (id) {
          var def = BIKES.CATALOG[cat].options[id];
          if (def.unlock && !BIKES.isUnlocked(def, career)) out.push(def.name);
        });
      });
      return out;
    }
    var newlyUnlocked = [];
    if (!run.practice && !run.handicapped && BIKES) {
      var beforeLocked = lockedList();
      career.runs = (career.runs || 0) + 1;
      career.coins = (career.coins || 0) + st.coinCount;
      career.finished[selTrack] = true;
      if (st.coinCount > (career.maxCoinsRun || 0)) career.maxCoinsRun = st.coinCount;
      var rank = BIKES.MEDAL_RANK;
      if ((rank[medal] || 0) > (rank[career.medals[selTrack]] || 0)) career.medals[selTrack] = medal;
      BIKES.saveCareer(career);
      var afterLocked = lockedList();
      newlyUnlocked = beforeLocked.filter(function (n) { return afterLocked.indexOf(n) < 0; });
    }

    /* practice spawns (dev #at= hash) never count: no bests, no ghosts, no board */
    var prevBest = bests[selTrack] || Infinity;
    var isBest = !run.practice && !run.handicapped && timeMs < prevBest;
    if (isBest) {
      bests[selTrack] = timeMs;
      lsSet("zr3_best", bests);
      lsSet("zr3_bestghost_" + selTrack, { timeMs: timeMs, samples: run.recorder });
      /* named riders share their new best with the club board; nameless riders stay local */
      if ((profile.name || "").trim()) submitClubGhost(name, timeMs, run.recorder);
    }

    if (!run.practice && !run.handicapped) {
      var list = scores[selTrack] || [];
      list.push({ name: name, timeMs: timeMs, score: st.score, bike: run.bikeName });
      list.sort(function (a, b2) { return a.timeMs - b2.timeMs; });
      scores[selTrack] = list.slice(0, 10);
      lsSet("zr3_scores", scores);
    }

    el.results.classList.remove("is-finale");
    showResultsRow("results-row");

    var medalTxt = {
      gold: ["🥇", "GOLD! You beat Armand down the mountain — club legend!"],
      silver: ["🥈", "Silver! Faster than Arthur — Armand is next."],
      bronze: ["🥉", "Bronze! The ghosts are within reach now."],
      none: ["🚵", "Finished! Every run down the mountain makes you faster."]
    }[medal];

    el.resultsContent.innerHTML =
      '<div class="results-medal">' + medalTxt[0] + "</div>" +
      "<h2>" + wc.world.def.name + " — done!</h2>" +
      '<p class="gr-tag">' + medalTxt[1] + "</p>" +
      '<div class="results-grid">' +
      "<span>Time<strong>" + fmtTime(timeMs) + "</strong></span>" +
      "<span>Best<strong>" + fmtTime(bests[selTrack]) + "</strong></span>" +
      "<span>Score<strong>" + st.score + "</strong></span>" +
      "<span>Coins<strong>" + st.coinCount + "</strong></span>" +
      "<span>Big airs<strong>" + st.bigAirs + "</strong></span>" +
      "</div>" +
      (isBest ? '<p><span class="track-pill track-pill--trail">NEW PERSONAL BEST</span></p>' : "") +
      (run.practice ? '<p><span class="track-pill track-pill--easy">PRACTICE SPAWN — times don\'t count</span></p>' : "") +
      (newlyUnlocked.length ? '<p><span class="track-pill track-pill--hero">🔓 GARAGE UNLOCK: ' + newlyUnlocked.join(" · ") + "</span></p>" : "") +
      '<p class="results-note">' + (run.bikeName ? "Bike: " + run.bikeName + " · " : "") +
      "Armand: " + fmtTime(wc.armand.timeMs) + " · Arthur: " + fmtTime(wc.arthur.timeMs) +
      (st.crashes ? " · Crashes: " + st.crashes + " (helmets, always!)" : " · Clean run — no crashes!") + "</p>" +
      (run.handicapped
        ? '<p class="results-note">🌧️ You rode that in the wet — brilliant, but weather runs don\'t set records. ' +
          "Switch the weather back to Clear for a time that counts.</p>"
        : '<p class="results-note">Copy your Ghost Code below and hand it to a club friend — they can race you without any chat.</p>');

    mode = "results";
    el.results.hidden = false;
    hideRideChrome();
    stopRumble();
    stopRain();
    SFX.finish();
    refreshLeaderboard();
  }

  /* ---------- event fx ---------- */

  /* what to call what just happened in the air */
  function trickName(e) {
    var spinWord = { 1: "360", 2: "720", 3: "1080" }[e.spins] || (e.spins * 360 + "");
    var flipWord = e.back ? "BACKFLIP" : "FRONTFLIP";
    if (e.flips > 1) flipWord = e.flips + "x " + flipWord;
    if (e.flips && e.spins) return spinWord + " " + flipWord + " COMBO! 🔥";
    if (e.flips) return flipWord + "! 🚵";
    return spinWord + " SPIN! 🌀";
  }

  var CRASH_MSG = {
    landing: "OUCH! 💥 Bend those knees on big drops!",
    trick: "SKETCHY! 🌀 Land it level next time!",
    croc: "CROC! 🐊 Give those teeth some space!",
    hippo: "HIPPO! 🦛 Two tonnes of do-not-touch!",
    elephant: "ELEPHANT! 🐘 Give the big fella room!",
    rhino: "RHINO! 🦏 Two horns and no sense of humour!",
    antelope: "PUKU! 🦌 Nearly a puku pancake!",
    miombo: "Tree! 🌳 Keep it on the trail!",
    baobab: "That baobab is 1000 years old — and solid! 💥",
    acacia: "Tree! 🌳 Keep it on the trail!",
    palm: "Tree! 🌴 Watch the line!",
    rock: "Rock! 🪨 Eyes up the trail!",
    termite: "Termite tower! 💥",
    elephant: "Whoa! Give animals space! 🐘",
    rhino: "Whoa! Give the rhino room! 🦏",
    giraffe: "Whoa! Give animals space! 🦒",
    zebra: "Whoa! Give animals space! 🦓",
    antelope: "Whoa! Give animals space!"
  };

  function handleEvents(ev, st, v, pi) {
    v = v || views[0];
    pi = pi || 0;
    var say = function (txt) { toast(txt, pi); };
    for (var i = 0; i < ev.length; i++) {
      var e = ev[i];
      if (e.t === "coin") SFX.coin();
      else if (e.t === "hop") SFX.hop();
      else if (e.t === "land") {
        spawnDust(st.x, st.y, st.z, e.q === "hard" ? 8 : 4, st.yaw);
        v.dip = e.q === "hard" ? 0.55 : 0.25;
        if (e.q === "hard") { SFX.hard(); say("Heavy landing!"); }
        else SFX.land();
      }
      else if (e.t === "bigair") { say("BIG AIR! +75"); SFX.bigair(); }
      else if (e.t === "crash") {
        say(CRASH_MSG[e.why] || CRASH_MSG.landing);
        SFX.crash();
        spawnDust(st.x, st.y, st.z, 14);
        if (!reducedMotion) v.shake = 0.5;
      }
      else if (e.t === "splash") {
        say("SPLASH! 🐊 The Zambezi is NOT a shortcut!");
        SFX.splash();
        spawnDust(st.x, st.y + 0.5, st.z, 12);
      }
      else if (e.t === "gorge") {
        say("THE GORGE! 🌊 Respect the Smoke that Thunders!");
        SFX.splash();
        if (!reducedMotion) v.shake = 0.4;
      }
      else if (e.t === "trick") {
        say(trickName(e) + " +" + e.pts);
        SFX.trick(e.combo);
      }
      else if (e.t === "turboOn") { say("TURBO! ⚡ Tap " + turboKeyName(pi) + " as fast as you can!"); SFX.turboOn(); }
      else if (e.t === "turboOff") SFX.turboOff();
      else if (e.t === "respawn") say("Back on track! 🚵");
      else if (e.t === "gate") SFX.gate();
      else if (e.t === "reset") say("Whoops — back to the trail!");
    }
  }

  /* ---------- camera ---------- */

  /* pointers into the view being updated or drawn right now */
  var camPos = views[0].pos;
  var camLook = views[0].look;
  function useView(v) {
    camera = v.camera;
    camPos = v.pos;
    camLook = v.look;
  }
  function snapAllViews() {
    for (var i = 0; i < views.length; i++) views[i].snap = true;
  }

  /* The camera's fov in three.js is VERTICAL, so a wide, short two-player
     strip would fish-eye if we kept the single-player number. Aim at a
     horizontal field of view instead and solve back — which reproduces the
     one-player look exactly at 16:9 and stays sane in any slice shape. */
  var HFOV_BASE = 98, HFOV_MAX = 116;
  function fovForSpeed(cam, speed) {
    var hf = Math.min(HFOV_MAX, HFOV_BASE + speed * 0.85) * Math.PI / 360;
    return Math.atan(Math.tan(hf) / Math.max(0.35, cam.aspect)) * 360 / Math.PI;
  }

  function updateCamera(v, st, dt, world) {
    var cam = v.camera;
    var fwdX = Math.sin(st.yaw), fwdZ = Math.cos(st.yaw);
    var speed = Math.sqrt(st.vx * st.vx + st.vz * st.vz);
    var back = 6.2 + speed * 0.06;
    var tx = st.x - fwdX * back;
    var tz = st.z - fwdZ * back;
    var ty = st.y + 2.9;
    /* keep the camera above the terrain behind the rider */
    var gY = CORE.heightAt(world, tx, tz) + 1.1;
    if (ty < gY) ty = gY;

    if (v.snap) {
      v.pos.set(tx, ty, tz);
      v.snap = false;
    } else {
      var k = Math.min(1, 5.5 * dt);
      v.pos.x += (tx - v.pos.x) * k;
      v.pos.y += (ty - v.pos.y) * Math.min(1, 4 * dt);
      v.pos.z += (tz - v.pos.z) * k;
    }
    var sx = 0, sy = 0;
    if (v.shake > 0) {
      v.shake -= dt;
      sx = (Math.random() - 0.5) * 0.3 * v.shake;
      sy = (Math.random() - 0.5) * 0.3 * v.shake;
    } else if (st.offTrail && st.onGround && speed > 6 && !reducedMotion) {
      sx = (Math.random() - 0.5) * 0.05;
      sy = (Math.random() - 0.5) * 0.05;
    }
    v.dip *= Math.max(0, 1 - 6 * dt);
    cam.position.set(v.pos.x + sx, v.pos.y + sy - v.dip, v.pos.z);
    v.look.set(st.x + fwdX * 6, st.y + 1.1, st.z + fwdZ * 6);
    cam.lookAt(v.look);
    /* bank gently into the turns */
    if (st.lean) cam.rotateZ(-st.lean * 0.35);
    cam.fov = fovForSpeed(cam, speed);
    cam.updateProjectionMatrix();
  }

  /* ---------- rig animation ---------- */

  function animatePlayer(r, dt) {
    var st = r.st, playerRig = r.rig, input = r.input;
    var speed = Math.sqrt(st.vx * st.vx + st.vz * st.vz);
    placeRig(playerRig, st.x, st.y, st.z, st.yaw + (st.spin || 0), st.lean);
    /* flips rotate the whole rider round the bars */
    playerRig.group.rotateX(st.pitch || 0);
    /* pitch to slope when grounded */
    if (st.onGround) {
      var ahead = CORE.heightAt(run.b.wc.world, st.x + Math.sin(st.yaw) * 1.2, st.z + Math.cos(st.yaw) * 1.2);
      var behind = CORE.heightAt(run.b.wc.world, st.x - Math.sin(st.yaw) * 1.2, st.z - Math.cos(st.yaw) * 1.2);
      playerRig.group.rotation.x = Math.atan2(behind - ahead, 2.4);
    } else {
      playerRig.group.rotation.x *= 0.96;
    }
    if (st.crashT > 0) playerRig.group.rotation.z += 6 * dt;
    playerRig.wheelF.rotation.x -= speed * dt / 0.34;
    playerRig.wheelB.rotation.x -= speed * dt / 0.34;
    var pedaling = st.onGround && input.pedal && st.crashT <= 0;
    if (pedaling) playerRig.crank.rotation.x -= speed * dt * 0.9 + 4 * dt;
    /* pedals stay flat, legs follow the crank */
    var crankA = playerRig.crank.rotation.x;
    playerRig.pedL.rotation.x = -crankA;
    playerRig.pedR.rotation.x = -crankA;
    var lerpR = function (obj, target) { obj.rotation.x += (target - obj.rotation.x) * Math.min(1, 12 * dt); };
    if (pedaling) {
      playerRig.legL.hip.rotation.x = -0.5 + 0.36 * Math.sin(-crankA);
      playerRig.legL.knee.rotation.x = 0.95 + 0.42 * Math.sin(-crankA + 0.9);
      playerRig.legR.hip.rotation.x = -0.5 + 0.36 * Math.sin(-crankA + Math.PI);
      playerRig.legR.knee.rotation.x = 0.95 + 0.42 * Math.sin(-crankA + Math.PI + 0.9);
    } else if (!st.onGround) {
      /* tuck in the air */
      lerpR(playerRig.legL.hip, -0.85); lerpR(playerRig.legL.knee, 1.35);
      lerpR(playerRig.legR.hip, -0.85); lerpR(playerRig.legR.knee, 1.35);
      lerpR(playerRig.torso, 0.75);
    } else {
      /* level-crank attack position */
      lerpR(playerRig.legL.hip, -0.45); lerpR(playerRig.legL.knee, 0.9);
      lerpR(playerRig.legR.hip, -0.45); lerpR(playerRig.legR.knee, 0.9);
      lerpR(playerRig.torso, 0.55);
    }
    playerRig.blob.visible = lightMode && st.onGround;
    /* pedal dust at speed */
    if (st.onGround && speed > 9 && Math.random() < (wetSpray ? 0.55 : 0.25)) spawnDust(st.x, st.y, st.z, 1, st.yaw);
  }

  /* ---------- two riders, one sofa ---------- */

  /* where everybody is, for anything that reacts to a rider */
  function riderSpots() {
    var out = [];
    for (var i = 0; i < run.riders.length; i++) {
      out.push({ x: run.riders[i].st.x, z: run.riders[i].st.z });
    }
    return out;
  }

  function eachRider(fn) {
    for (var i = 0; i < run.riders.length; i++) fn(run.riders[i], i);
  }
  function allRidersDone() {
    for (var i = 0; i < run.riders.length; i++) if (!run.riders[i].st.finished) return false;
    return true;
  }
  function announceFinish(r) {
    if (r.place === 1) {
      toastAll(r.name + " takes it! 🏁");
      SFX.finish();
      /* the rider still out there gets a fair run home, then the flag drops */
      run.chaseT = CHASE_GRACE;
    } else {
      toastAll(r.name + " home too! 🏁");
      SFX.gate();
    }
  }

  function animateGhosts(tSec, dt) {
    ghostRigs.forEach(function (gr) {
      var gp = CORE.ghostPosAt3(gr.ghost, tSec);
      if (gp.empty) { gr.rig.group.visible = false; return; }
      gr.rig.group.visible = true;
      placeRig(gr.rig, gp.x, gp.y, gp.z, gp.yaw, 0);
      gr.rig.wheelF.rotation.x -= 12 * dt;
      gr.rig.wheelB.rotation.x -= 12 * dt;
      gr.rig.group.traverse(function (o) {
        if (o.isMesh && o.material.transparent) o.material.opacity = gp.done ? 0.18 : 0.45;
      });
    });
  }

  /* keep sky, horizon, sun disc and shadow frustum glued to the action */
  /* the infinite backdrop rides on whichever camera is about to draw */
  function parkBackdrop(sc) {
    if (sc.dome) sc.dome.position.copy(camera.position);
    if (sc.sky) sc.sky.position.copy(camera.position);
    sc.ridges[0].position.set(camera.position.x, camera.position.y - 55, camera.position.z);
    sc.ridges[1].position.set(camera.position.x, camera.position.y - 55, camera.position.z);
    if (sc.sunSp) sc.sunSp.position.copy(camera.position).addScaledVector(sc.sunDir, 700);
    /* the rain box is anchored to the camera, so both players ride through it */
    if (sc.rain) sc.rain.material.uniforms.uCam.value.copy(camera.position);
  }

  /* The shadow camera is a fixed 120-unit box, so with two riders it aims at
     the point between them and widens just enough to cover both — up to a
     limit, past which the trailing rider loses their shadow rather than the
     whole map going soft. */
  function aimSun(sc, fx, fy, fz, spread) {
    sc.sun.position.set(fx, fy, fz).addScaledVector(sc.sunDir, 220);
    sc.sun.target.position.set(fx, fy, fz);
    if (!sc.sun.castShadow) return;
    var want = Math.max(34, Math.min(80, 34 + (spread || 0) * 0.6));
    if (Math.abs(want - sc.sun.shadow.camera.right) > 1) {
      var c = sc.sun.shadow.camera;
      c.left = -want; c.right = want; c.top = want; c.bottom = -want;
      c.updateProjectionMatrix();
    }
  }

  /* one call site for the common single-rider case */
  function followEnvironment(sc, fx, fy, fz) {
    parkBackdrop(sc);
    aimSun(sc, fx, fy, fz, 0);
  }

  /* the sound of rain: filtered noise, not an oscillator */
  var FLASH_COL = new THREE.Color(0xE8F0FF);
  var rainGain = null;
  function rainHiss(level) {
    var ac = audio();
    if (!ac) return;
    if (!rainGain) {
      var len = ac.sampleRate * 2;
      var buf = ac.createBuffer(1, len, ac.sampleRate);
      var d = buf.getChannelData(0);
      for (var i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * 0.6;
      var src = ac.createBufferSource();
      src.buffer = buf; src.loop = true;
      var hp = ac.createBiquadFilter();
      hp.type = "highpass"; hp.frequency.value = 900;
      var lp = ac.createBiquadFilter();
      lp.type = "lowpass"; lp.frequency.value = 7000;
      rainGain = ac.createGain();
      rainGain.gain.value = 0;
      src.connect(hp); hp.connect(lp); lp.connect(rainGain); rainGain.connect(masterGain);
      src.start();
    }
    rainGain.gain.value = level * 0.09;
  }
  function stopRain() { if (rainGain) rainGain.gain.value = 0; }

  /* low waterfall rumble that swells as you approach the falls */
  var rumbleGain = null;
  function fallsRumble(level) {
    var ac = audio();
    if (!ac) return;
    if (!rumbleGain) {
      var len = ac.sampleRate * 2;
      var buf = ac.createBuffer(1, len, ac.sampleRate);
      var d = buf.getChannelData(0);
      var last = 0;
      for (var i = 0; i < len; i++) {
        last = last * 0.95 + (Math.random() * 2 - 1) * 0.05;
        d[i] = last * 3.2;
      }
      var src = ac.createBufferSource();
      src.buffer = buf; src.loop = true;
      var lp = ac.createBiquadFilter();
      lp.type = "lowpass"; lp.frequency.value = 300;
      rumbleGain = ac.createGain();
      rumbleGain.gain.value = 0;
      src.connect(lp); lp.connect(rumbleGain); rumbleGain.connect(masterGain);
      src.start();
    }
    rumbleGain.gain.value = level * 0.55;
  }
  function stopRumble() { if (rumbleGain) rumbleGain.gain.value = 0; }

  /* Idle, then alert, then startled: what a big animal does when a bicycle
     comes down the hill at it. Nothing here MOVES an animal — the collision
     body is fixed in the deterministic core — so all of it is head, ears,
     tail and a shift of weight, which is plenty. */
  var ALERT_R = 34;       /* it looks up from here in */
  var STARTLE_R = 11;     /* and properly flinches from here in */

  function animateFauna(sc, t, dt, who) {
    var list = sc.fauna;
    if (!list || !list.length) return;
    for (var i = 0; i < list.length; i++) {
      var f = list[i], a = f.a;

      /* how close is the nearest rider, and which way are they? */
      var near = 1e9, nx = 0, nz = 0;
      for (var w = 0; w < who.length; w++) {
        var dx = who[w].x - f.x, dz = who[w].z - f.z;
        var d2 = dx * dx + dz * dz;
        if (d2 < near) { near = d2; nx = dx; nz = dz; }
      }
      near = Math.sqrt(near);
      /* far away costs almost nothing: idle only, no maths for the head */
      if (near > 120) { f.alert += (0 - f.alert) * Math.min(1, 2 * dt); }
      else {
        var want = near < STARTLE_R ? 1 : near < ALERT_R ? 0.55 : 0;
        f.alert += (want - f.alert) * Math.min(1, (want > f.alert ? 7 : 1.4) * dt);
      }
      var k = f.alert;
      var ph = t * f.rate + f.ph;

      /* the head: grazing when calm, up and turned to the rider when not */
      if (a.head) {
        var graze = (a.graze || 0) + Math.sin(ph * 0.9) * 0.06;
        a.head.rotation.x = graze * (1 - k) + (a.kind === "rhino" ? 0.1 : -0.12) * k;
        /* turn to face the intruder, but only as far as a neck really goes */
        var toRider = Math.atan2(nx, nz) - f.rot;
        while (toRider > Math.PI) toRider -= 6.283;
        while (toRider < -Math.PI) toRider += 6.283;
        var turn = Math.max(-1.1, Math.min(1.1, toRider));
        a.head.rotation.y = turn * k + Math.sin(ph * 0.55) * 0.14 * (1 - k);
      }
      /* ears swivel forward and flick */
      var flick = Math.max(0, Math.sin(ph * 2.1 + 1.7)) * Math.pow(Math.abs(Math.sin(ph * 0.7)), 6);
      if (a.earL) a.earL.rotation.z = -0.25 * k - flick * 0.5;
      if (a.earR) a.earR.rotation.z = 0.25 * k + flick * 0.5;
      /* an elephant's ears are the whole story: they fan hard when bothered */
      if (a.kind === "elephant") {
        var fan = Math.sin(ph * 1.5) * (0.12 + k * 0.5);
        if (a.earL) a.earL.rotation.y = 0.5 + fan;
        if (a.earR) a.earR.rotation.y = -0.5 - fan;
        if (a.trunk) a.trunk.rotation.x = 0.35 + Math.sin(ph * 0.8) * 0.22 - k * 0.75;
      }
      /* the tail: a slow swish, faster when the rider is close */
      if (a.tail) {
        a.tail.rotation.z = Math.sin(ph * (1.3 + k * 2.6)) * (0.18 + k * 0.3);
        a.tail.rotation.x = -k * 0.5;
      }
      /* weight shifts back off the front feet as it tenses */
      if (a.body) a.body.rotation.x = -k * 0.06 + Math.sin(ph * 0.7) * 0.012;
      /* and the whole animal braces, without ever leaving its spot */
      f.g.rotation.z = Math.sin(ph * 1.1) * 0.01 + Math.sin(t * 9 + f.ph) * 0.02 * Math.max(0, k - 0.6);
    }
  }

  function animateScene(sc, t, dt, riderX, riderY, riderZ, who) {
    for (var i = 0; i < sc.clouds.length; i++) {
      sc.clouds[i].position.x += Math.sin(i * 1.7) * 0.7 * dt;
    }
    /* Bat rivers. Every bat flies its own line — its own airspeed, its own
       angle across the valley, its own wing beat — and when one runs off the
       end it is recycled alone, so the river keeps streaming instead of the
       whole cloud snapping back. The wing beat is a squash across the
       wingspan, which from underneath is exactly what wings look like. */
    /* anchored on the TRAILING rider: the window reaches 300 m ahead and only
       70 m behind, so following the leader would fly the second player
       through empty sky */
    var anchor = (who && who.length) ? who[0] : { x: riderX || 0, z: riderZ || 0 };
    for (var wq = 1; wq < (who ? who.length : 0); wq++) {
      if (who[wq].z < anchor.z) anchor = who[wq];
    }
    var batAnchorZ = anchor.z, batAnchorX = anchor.x;

    /* mist lies on the trail ahead of you, and there is always some of it */
    if (sc.mist && sc.mist.length) {
      var mw = sc.world, mz0 = batAnchorZ - 40, mSpan = 340;
      for (var mq = 0; mq < sc.mist.length; mq++) {
        var mp = sc.mist[mq];
        mp.lat += mp.drift * dt;
        if (mp.lat > 26) mp.lat -= 52; else if (mp.lat < -26) mp.lat += 52;
        var mzz = mz0 + ((mp.z - mz0) % mSpan + mSpan) % mSpan;
        mp.z = mzz;
        var mi = Math.max(0, Math.min(mw.trailN - 1, Math.floor(mzz / 5)));
        var mtp = mw.trail[mi];
        mp.sp.position.set(mtp.x + mp.lat, mtp.y + mp.lift, mzz);
      }
    }

    /* ---- rain: one uniform advanced per frame, nothing per drop ---- */
    if (sc.rain) {
      var spd = (run && run.st) ? Math.sqrt(run.st.vx * run.st.vx + run.st.vz * run.st.vz) : 0;
      var dr = sc.rainDrift, bx = sc.rain.material.uniforms.uBox.value;
      dr.x += 4.5 * dt;                    /* a steady slant of wind */
      dr.y -= (24 + 10 * sc.wxK) * dt;     /* fall rate */
      dr.z += 1.5 * dt;
      dr.x %= bx.x; dr.y %= bx.y; dr.z %= bx.z;
      var u = sc.rain.material.uniforms;
      /* ride into it and the streaks lie over and stretch out */
      u.uLean.value.set(0.22 + spd * 0.035, spd * 0.012);
      u.uLen.value = 1 + spd * 0.16;   /* ride into it and it stretches out */
    }

    /* ---- lightning: rare, soft, and never twice in a hurry ---- */
    if (sc.bolts > 0 && !reducedMotion) {
      if (sc.nextFlash === 0) sc.nextFlash = t + 7 + Math.random() * 12;
      if (t >= sc.nextFlash) {
        sc.flashT = t;
        sc.nextFlash = t + 12 + Math.random() * 16;
        SFX.thunder(2.0 + Math.random() * 4.5);
      }
      var age = t - sc.flashT;
      /* a double blink: up fast, most of the way down, up again, then out */
      sc.flash = age < 0 || age > 0.34 ? 0
        : age < 0.05 ? age / 0.05
        : age < 0.13 ? 1 - (age - 0.05) / 0.08 * 0.75
        : age < 0.18 ? 0.25 + (age - 0.13) / 0.05 * 0.6
        : 1 - (age - 0.18) / 0.16;
      sc.flash = Math.max(0, Math.min(1, sc.flash)) * 0.55;
      if (sc.hemi) sc.hemi.intensity = sc.hemiI0 * (1 + sc.flash * 2.6);
      if (sc.amb) sc.amb.intensity = sc.ambI0 * (1 + sc.flash * 3.2);
      if (sc.scene.fog && sc.fogBase) {
        sc.scene.fog.color.copy(sc.fogBase).lerp(FLASH_COL, sc.flash * 0.75);
      }
    }
    if (sc.wxK > 0) rainHiss(muted ? 0 : Math.min(1, sc.wxK));
    var batGroundY = riderY !== undefined ? riderY : 0;
    for (i = 0; i < sc.batStreams.length; i++) {
      var bs = sc.batStreams[i];
      var list = bs.bats, d3 = bs.dummy;
      var zLo = batAnchorZ - bs.behind, zHi = batAnchorZ + bs.ahead;
      var span = zHi - zLo;
      for (var bq = 0; bq < list.length; bq++) {
        var bt = list[bq];
        /* upstream, against the rider, so they sweep past instead of hanging */
        bt.z -= bt.spd * dt;
        bt.x += bt.cross * bt.spd * dt;
        /* the window travels with the rider: anything that drops off the back
           comes straight back in at the far end, with a fresh line */
        if (bt.z < zLo) {
          bt.z += span;
          bt.x = batAnchorX + (Math.random() - 0.5) * bs.wide * 2;
          bt.alt = bs.alt + Math.random() * bs.spread;
        } else if (bt.z > zHi) {
          bt.z -= span;
        }
        var dx = bt.x - batAnchorX;
        if (dx > bs.wide) bt.x -= bs.wide * 2;
        else if (dx < -bs.wide) bt.x += bs.wide * 2;

        var beat = Math.sin(t * bt.fr + bt.ph);
        /* altitude is measured above the valley floor, which falls away with z */
        d3.position.set(
          bt.x,
          batGroundY - (bt.z - batAnchorZ) * bs.slope + bt.alt + beat * bt.amp,
          bt.z
        );
        /* nose into the flight direction, and bank into the turn */
        d3.rotation.set(0, Math.atan2(bt.cross, -1), beat * 0.5);
        /* the beat: wings sweep in on the downstroke, out on the upstroke */
        d3.scale.set(bt.size * (0.42 + 0.58 * Math.abs(beat)), 1, bt.size * 0.72);
        d3.updateMatrix();
        bs.mesh.setMatrixAt(bq, d3.matrix);
      }
      bs.mesh.instanceMatrix.needsUpdate = true;
    }
    /* birds wheel in slow circles, wings flapping */
    for (i = 0; i < sc.birds.length; i++) {
      var fl = sc.birds[i];
      for (var b = 0; b < fl.members.length; b++) {
        var bird = fl.members[b];
        var a = t * fl.speed + bird.userData.off;
        var px = fl.center.x + Math.cos(a) * fl.r;
        var pz = fl.center.z + Math.sin(a) * fl.r;
        var py = fl.center.y + Math.sin(t * 0.5 + bird.userData.phase) * 3;
        bird.position.set(px, py, pz);
        bird.rotation.y = -a;
        var flap = Math.sin(t * 9 + bird.userData.phase) * 0.7;
        bird.userData.wl.rotation.y = flap;
        bird.userData.wr.rotation.y = -flap;
      }
    }
    for (i = 0; i < sc.swayMats.length; i++) {
      var sm = sc.swayMats[i];
      if (sm.userData.swayShader) sm.userData.swayShader.uniforms.uZbTime.value = t;
    }
    animateFauna(sc, t, dt, who || [{ x: riderX || 0, z: riderZ || 0 }]);

    /* crocs yawn slowly and sweep their tails; the river flows */
    for (i = 0; i < sc.crocs.length; i++) {
      var cr = sc.crocs[i].userData;
      var yawn = Math.max(0, Math.sin(t * 0.45 + cr.phase));
      cr.jaw.rotation.x = 0.06 + Math.pow(yawn, 8) * 0.55;
      cr.tail.rotation.y = Math.sin(t * 1.1 + cr.phase) * 0.16;
    }
    if (sc.riverTex) {
      sc.riverTex.offset.y -= dt * 0.22;
      sc.riverTex.offset.x = Math.sin(t * 0.3) * 0.02;
    }
    if (sc.wf) {
      if (sc.wf.water) sc.wf.water.material.uniforms.time.value += dt * 0.55;
      sc.wf.waterTexA.offset.y += 1.05 * dt;
      sc.wf.waterTexB.offset.y += 1.65 * dt;
      for (i = 0; i < sc.wf.mists.length; i++) {
        sc.wf.mists[i].material.opacity = 0.3 + 0.18 * Math.sin(t * 0.8 + i * 1.7);
      }
      for (i = 0; i < sc.wf.rings.length; i++) {
        var ring = sc.wf.rings[i];
        var ph = (t * 0.32 + ring.userData.phase) % 1;
        var rs = 1.5 + ph * 11;
        ring.scale.set(rs, rs, 1);
        ring.material.opacity = 0.45 * (1 - ph);
      }
      if (sc.wf.spray) {
        var pos = sc.wf.spray.geometry.attributes.position;
        for (i = 0; i < sc.wf.sprayData.length; i++) {
          var sd = sc.wf.sprayData[i];
          sd.life += dt * 0.5;
          if (sd.life > 1) sd.life -= 1;
          pos.setXYZ(i,
            sd.bx + Math.cos(sd.a) * sd.r,
            sd.by + sd.life * sd.v * 7,
            sd.bz + Math.sin(sd.a) * sd.r * 0.5);
        }
        pos.needsUpdate = true;
        sc.wf.spray.material.opacity = 0.4;
      }
      /* rumble by distance (race modes only pass rider coords) */
      if (riderX !== undefined) {
        var dxw = sc.wf.worldPos.x - riderX, dzw = sc.wf.worldPos.z - riderZ;
        var distW = Math.sqrt(dxw * dxw + dzw * dzw);
        fallsRumble(Math.max(0, Math.min(1, 1 - distW / 320)));
      }
    }
  }

  /* ---------- HUD ---------- */

  function updateHUD(world) {
    if (players() === 2) { updateHUD2(world); return; }
    var st = run.st;
    updateTurboHUD(st);
    /* In a live race the clock on screen is the club server's, counted from the
       moment the flag dropped — the same clock the result is measured on. Your
       own timer stops when your frame loop does; the race does not. */
    var ms;
    if (mpMode && NET && NET.room && NET.room.startAt) {
      if (!st.finished) run.mpMs = Math.max(0, NET.clock.serverNow() - NET.room.startAt);
      ms = run.mpMs || 0;
    } else {
      ms = Math.round((st.finished ? st.finishT : st.t) * 1000);
    }
    el.time.textContent = fmtTime(ms);
    el.score.textContent = "🪙 " + st.score;
    var sp = Math.sqrt(st.vx * st.vx + st.vz * st.vz);
    el.speed.textContent = Math.round(sp * 3.6) + " km/h";
    var prog = Math.max(0, Math.min(1, st.trailIdx / world.finishIdx));
    el.progress.style.width = (prog * 100).toFixed(1) + "%";
  }

  /* the two compact strips, one tucked into the top of each half */
  var h2 = null;
  function hud2Els() {
    if (h2) return h2;
    h2 = [];
    for (var i = 1; i <= 2; i++) {
      h2.push({
        side: $("hud2-p" + i), tag: $("p" + i + "-tag"), time: $("p" + i + "-time"),
        score: $("p" + i + "-score"), speed: $("p" + i + "-speed"),
        turbo: $("p" + i + "-turbo"), key: $("p" + i + "-turbo-label"),
        fill: $("p" + i + "-turbo-fill"), prog: $("p" + i + "-prog"), flag: $("p" + i + "-flag")
      });
    }
    return h2;
  }

  var PLACE_WORD = ["", "1st 🏆", "2nd"];
  function updateHUD2(world) {
    var e2 = hud2Els();
    eachRider(function (r, i) {
      var g = e2[i];
      if (!g || !g.side) return;
      var st = r.st;
      g.side.style.setProperty("--p-tint", r.jersey);
      g.tag.textContent = r.name;
      g.time.textContent = fmtTime(Math.round((st.finished ? st.finishT : st.t) * 1000));
      g.score.textContent = "🪙 " + st.score;
      g.speed.textContent = Math.round(Math.sqrt(st.vx * st.vx + st.vz * st.vz) * 3.6) + " km/h";
      g.prog.style.width = (Math.max(0, Math.min(1, st.trailIdx / world.finishIdx)) * 100).toFixed(1) + "%";

      var pct = Math.round((st.throttle || 0) * 100);
      if (st.turboT > 0) {
        g.turbo.dataset.state = "on";
        g.fill.style.width = pct + "%";
      } else if (st.turboCd > 0) {
        g.turbo.dataset.state = "cool";
        g.fill.style.width = (100 - (st.turboCd / CORE.TURBO_COOLDOWN) * 100).toFixed(0) + "%";
      } else {
        g.turbo.dataset.state = "ready";
        g.fill.style.width = "100%";
      }

      if (st.finished) {
        g.flag.hidden = false;
        g.flag.textContent = r.timedOut ? "flagged" : (PLACE_WORD[r.place] || "home");
      } else if (run.chaseT > 0) {
        g.flag.hidden = false;
        g.flag.textContent = Math.ceil(run.chaseT) + "s to get home!";
      } else {
        g.flag.hidden = true;
      }
    });
  }

  /* the throttle readout: how the turbo works, and how hard you are working */
  function updateTurboHUD(st) {
    if (!el.turbo) return;
    var pct = Math.round((st.throttle || 0) * 100);
    if (st.turboT > 0) {
      el.turbo.dataset.state = "on";
      el.turboState.textContent = st.turboT.toFixed(1) + "s left";
      el.turboHint.innerHTML = "tap <kbd>K</kbd> faster!";
      el.turboGain.textContent = pct + "%";
      el.turboFill.style.width = pct + "%";
    } else if (st.turboCd > 0) {
      el.turbo.dataset.state = "cool";
      el.turboState.textContent = "recharging";
      el.turboHint.textContent = Math.ceil(st.turboCd) + "s";
      el.turboGain.textContent = "";
      el.turboFill.style.width =
        (100 - (st.turboCd / CORE.TURBO_COOLDOWN) * 100).toFixed(0) + "%";
    } else {
      el.turbo.dataset.state = "ready";
      el.turboState.innerHTML = "Press <kbd>K</kbd>";
      el.turboHint.innerHTML = "tap <kbd>K</kbd> fast for a speed boost";
      el.turboGain.textContent = "";
      el.turboFill.style.width = "100%";
    }
  }

  /* ====================================================================
     THE GREAT ZAMBIA TOUR
     Ten legs around the country with the clock running across all of them.
     Between legs you stand in the workshop and decide what to fix and what
     to carry — which is where the tour is actually won.
     ==================================================================== */

  var TOUR = window.ZR_TOUR || null;
  if (TOUR) TOUR.register(CORE);

  var tour = null;                 /* live progress, or null outside the tour */
  var tourMode = false;            /* is the current run a tour stage? */
  var pendingFault = null;         /* the mechanical waiting to strike */
  var tourSnap = null;             /* the tour exactly as it stood before this leg */
  var preTourTrack = null;         /* the mountain the rider was on before the tour */

  /* the tour borrows selTrack for its stages; the main menu gets its own back */
  function leaveTour() {
    tourMode = false;
    wxForced = null;              /* give the menu its own weather back */
    pendingFault = null;
    if (preTourTrack && CORE.TRACK3_ORDER.indexOf(selTrack) < 0) selectTrack(preTourTrack);
    preTourTrack = null;
  }

  /* A rider can be forty minutes into their own tour and still be invited into
     a convoy. Those are two different tours — different legs, different purse,
     different bike — so they are kept under two different keys and the solo one
     is picked back up untouched when the convoy is over. */
  var TOUR_LIVE_KEY = "zr3_tourlive";
  var tourKey = null;            /* set once TOUR is known */

  function loadTour(key) {
    var t = lsGet(key || tourKey, null);
    return TOUR.validTour(t) ? t : null;
  }
  function saveTour() { if (tour) lsSet(tourKey, tour); }

  /* step into the convoy's own tour, keeping the solo one where it was */
  function useLiveTour() {
    if (tourKey === TOUR_LIVE_KEY) return;
    tourKey = TOUR_LIVE_KEY;
    tour = loadTour() || TOUR.freshTour(profile.name);
  }
  /* and step back out of it */
  function useSoloTour() {
    if (tourKey === TOUR.KEY) return;
    tourKey = TOUR.KEY;
    tour = loadTour();
  }

  /* the fastest lap of the whole country this device has ever done */
  function bestTour() {
    var b = lsGet("zr3_tourbest", null);
    return b && typeof b.timeMs === "number" && b.timeMs > 0 ? b : null;
  }

  function tourStage() { return tour ? TOUR.stageAt(tour.stage) : null; }
  if (TOUR) tourKey = TOUR.KEY;

  function showOnly(which) {
    [el.menu, el.tour, el.brief, el.shop, el.results, el.howto, el.pause, el.mp].forEach(function (o) {
      if (o) o.hidden = o !== which;
    });
  }

  /* ---------- the roadbook: every leg, and where you have got to ---------- */

  function openTour() {
    if (!TOUR) return;
    setPlayers(1, false);          /* the tour is one rider, one clock */
    useSoloTour();                 /* the roadbook is always your own tour */
    if (!tour) tour = loadTour() || TOUR.freshTour(profile.name);
    if (!preTourTrack) preTourTrack = CORE.TRACK3_ORDER.indexOf(selTrack) >= 0 ? selTrack : CORE.TRACK3_ORDER[0];
    tour.rider = profile.name || tour.rider;
    saveTour();
    mode = "tour";
    renderTour();
    showOnly(el.tour);
  }

  function renderTour() {
    var done = tour.stage;
    var total = TOUR.STAGES.length;
    $("tour-sub").textContent = done >= total
      ? "Tour complete — " + fmtTime(TOUR.totalMs(tour)) + " around the whole country."
      : "Ten legs, " + (TOUR.TOTAL_M / 1000).toFixed(1) + " km, one clock. " +
        (done ? "Stage " + (done + 1) + " of " + total + " next." : "Roll out from Livingstone.");

    var html = "";
    TOUR.STAGES.forEach(function (st, i) {
      var r = tour.results[i];
      var state = r ? "done" : i === done ? "next" : "todo";
      html += '<li class="rb-row rb-row--' + state + '">' +
        '<span class="rb-n">' + st.n + "</span>" +
        '<span class="rb-main"><b>' + st.name + "</b>" +
        '<i>' + st.from + " → " + st.to + " · " + st.length + " m · " +
          TOUR.SURFACES[st.surface].label + " " + TOUR.WEATHER[st.weather].icon + "</i></span>" +
        '<span class="rb-time">' + (r
          ? fmtTime(r.timeMs) + (r.lostMs ? ' <em title="lost to a mechanical">+' + Math.round(r.lostMs / 1000) + "s</em>" : "")
          : i === done ? "▶" : "—") + "</span></li>";
    });
    $("tour-roadbook").innerHTML = html;

    $("tour-total").textContent = tour.results.length ? fmtTime(TOUR.totalMs(tour)) : "—";
    $("tour-cash").textContent = "K " + tour.kwacha;
    $("tour-cond").textContent = Math.round(tour.condition) + "%";
    setCondBar($("tour-cond-bar"), tour.condition);
    $("tour-number").textContent = "#" + tour.number + " · rolls out " + TOUR.startTimeLabel(tour.number);
    var bt = bestTour();
    $("tour-best").textContent = bt ? fmtTime(bt.timeMs) + (bt.rider ? " · " + bt.rider : "") : "not yet";
    $("tour-note").innerHTML = done >= total
      ? "You brought it home. The board in the clubhouse has your name on it."
      : "Your race number is your start time, the way it was on the old road races — number " +
        tour.number + " leaves at " + TOUR.startTimeLabel(tour.number) + ".";

    var go = $("btn-tour-go");
    go.textContent = done >= total ? "Ride the tour again" : done ? "Continue — stage " + (done + 1) : "Start stage 1";
  }

  function setCondBar(bar, c) {
    if (!bar) return;
    bar.style.width = Math.max(0, Math.min(100, c)) + "%";
    bar.className = c > 72 ? "is-good" : c > 45 ? "is-worn" : "is-bad";
  }

  /* ---------- the briefing card ---------- */

  function openBrief() {
    var st = tourStage();
    if (!st) { openTour(); return; }
    mode = "tour";
    /* the mountain behind the card is the one you are about to ride, and the
       world it builds is the world the stage starts in — nothing wasted */
    selTrack = st.id;
    var W = TOUR.WEATHER[st.weather], S = TOUR.SURFACES[st.surface];
    $("brief-kicker").textContent = "Stage " + st.n + " of " + TOUR.STAGES.length +
      " · leaves at " + TOUR.startTimeLabel(tour.number);
    $("brief-name").textContent = st.name;
    $("brief-route").textContent = st.from + " → " + st.to;
    $("brief-blurb").textContent = st.blurb;
    var mapEl = $("brief-map");
    if (mapEl) mapEl.innerHTML = courseMapSVG(st.id);
    $("brief-grid").innerHTML =
      briefCell("Distance", st.length + " m") +
      briefCell("Surface", S.label, S.note) +
      briefCell("Weather", W.icon + " " + W.label) +
      briefCell("Par time", fmtTime(TOUR.targetMs(st))) +
      briefCell("Condition", Math.round(tour.condition) + "%") +
      briefCell("In the bag", tour.bag.length + " / " + TOUR.BAG_SLOTS);

    var risk = TOUR.faultRisk(tour.condition);
    var riskEl = $("brief-risk");
    riskEl.className = "brief-risk" + (risk <= 0 ? " brief-risk--ok" : "");
    riskEl.innerHTML = risk <= 0
      ? "🔧 The bike is in good order — nothing should break today."
      : "⚠️ <b>" + Math.round(risk * 100) + "% chance of a mechanical</b> on this leg. " +
        "Carrying the right spare turns a disaster into a roadside stop.";

    $("brief-bag").innerHTML = tour.bag.length
      ? "<b>In the bag:</b> " + tour.bag.map(function (id) {
          return "<em>" + TOUR.SPARES[id].icon + " " + TOUR.SPARES[id].name + "</em>";
        }).join(" · ")
      : "<b>In the bag:</b> nothing at all. Anything that breaks out there stays broken.";
    showOnly(el.brief);
  }

  function briefCell(k, v, note) {
    return '<div class="brief-cell"><b>' + k + "</b><span>" + v + "</span>" +
      (note ? "<i>" + note + "</i>" : "") + "</div>";
  }

  /* ---------- the workshop ---------- */

  function openShop() {
    mode = "tour";
    renderShop();
    var done = $("btn-shop-done");
    if (done) done.textContent = mpInShop ? "Back to the convoy 📡" : "Back to the stage";
    showOnly(el.shop);
  }

  function renderShop() {
    var st = mpInShop && NET && NET.room && NET.room.tour && TOUR
      ? TOUR.stageAt(NET.room.stage) : tourStage();
    $("shop-sub").textContent = st
      ? "Before stage " + st.n + " — " + st.name + ". You have K " + tour.kwacha + "."
      : "You have K " + tour.kwacha + ".";
    $("shop-floor").textContent = TOUR.RISK_FLOOR;
    $("shop-van").innerHTML = "🚐 The Grown-Up Crew's support van meets you at every stage finish and " +
      "gives the bike a free once-over — that is the <b>+" + TOUR.FREE_FETTLE +
      "%</b> already in the bar. Everything past it costs kwacha.";
    setCondBar($("shop-cond-bar"), tour.condition);
    var missing = Math.round(100 - tour.condition);
    $("shop-cond").innerHTML = "Bike condition <b>" + Math.round(tour.condition) + "%</b>" +
      (missing ? " — a full rebuild costs <b>K " + (missing * TOUR.REPAIR_PER_POINT) + "</b>" : " — nothing to fix.");

    /* three tiers, but only the ones that are actually different: on a
       nearly-new bike "quick fettle" and "full rebuild" are the same job */
    var rep = "", offered = {};
    [[10, "Quick fettle"], [30, "Proper service"], [missing, "Full rebuild"]].forEach(function (o) {
      var pts = Math.min(o[0], missing);
      if (pts <= 0 || offered[pts]) return;
      offered[pts] = 1;
      var label = pts >= missing ? "Full rebuild" : o[1];
      var cost = pts * TOUR.REPAIR_PER_POINT;
      var can = tour.kwacha >= cost;
      rep += '<button type="button" class="btn btn--small ' + (can ? "btn--forest" : "btn--ghost") +
        '" data-repair="' + pts + '"' + (can ? "" : " disabled") + ">" + label +
        " → " + Math.round(tour.condition + pts) + "% · K " + cost + "</button>";
    });
    $("shop-repair").innerHTML = rep || '<span class="shop-hint">The bike is perfect. Go and ride it.</span>';

    $("bag-count").textContent = tour.bag.length + " / " + TOUR.BAG_SLOTS;
    $("bag-list").innerHTML = tour.bag.length
      ? tour.bag.map(function (id, i) {
          var sp = TOUR.SPARES[id];
          return '<li><span>' + sp.icon + " " + sp.name + "</span>" +
            '<button type="button" class="bag-drop" data-drop="' + i + '" aria-label="Leave behind">✕</button></li>';
        }).join("")
      : '<li class="bag-empty">Empty. Anything that breaks out there stays broken.</li>';

    var grid = "";
    Object.keys(TOUR.SPARES).forEach(function (id) {
      var sp = TOUR.SPARES[id];
      var have = tour.bag.indexOf(id) >= 0;
      var full = tour.bag.length >= TOUR.BAG_SLOTS;
      var afford = tour.kwacha >= sp.kwacha;
      var dis = have || full || !afford;
      grid += '<button type="button" class="spare' + (have ? " is-packed" : "") + '"' +
        (dis ? " disabled" : "") + ' data-buy="' + id + '">' +
        '<span class="spare-i">' + sp.icon + "</span>" +
        "<b>" + sp.name + "</b>" +
        '<i>' + sp.desc + "</i>" +
        '<span class="spare-k">' + (have ? "packed" : "K " + sp.kwacha) + "</span></button>";
    });
    $("spare-grid").innerHTML = grid;
  }

  /* ---------- running a stage ---------- */

  function startTourStage() {
    var st = tourStage();
    if (!st) { openTour(); return; }
    /* keep the tour exactly as it stands, so "ride it again" can put it back */
    tourSnap = JSON.parse(JSON.stringify(tour));
    /* decide the mechanical now, so the briefing's stated risk was honest.
       It is seeded off the stage, so riding the leg again meets the same
       mechanical — you can ride better, you cannot re-roll your luck. */
    /* Seeded off the rider's race number and the stage, so a rider's luck is
       their own and riding the same leg again meets the same mechanical.
       You can ride better; you cannot re-roll your luck. */
    /* the roadbook says 🌧️, so the roadbook gets rain */
    var legWx = TOUR.stageWx(st);
    wxForced = legWx === "clear" ? null : legWx;
    pendingFault = TOUR.rollFault(st, tour.condition, tour.bag, tour.number + tour.stage);
    selTrack = st.id;
    tourMode = true;
    startRace();
  }

  /* put the tour back exactly as it was before the last leg, then ride it again */
  function retryTourStage() {
    if (!tourSnap) return;
    tour = JSON.parse(JSON.stringify(tourSnap));
    saveTour();
    startTourStage();
  }

  /* what the tour does with a finished stage, instead of the normal results */
  /* THE BOOKS FOR ONE LEG. What it paid, what it took out of the bike, what
     broke on the road and whether the bag had the part. The solo tour and the
     live one keep exactly the same books — only the screen around them differs,
     so this is the one place the numbers are worked out. */
  function tourStageBooks(st, st2, timeMs) {
    var coins = st2.coinCount, crashes = st2.crashes;
    var pay = TOUR.stageEarnings(st, timeMs, coins, crashes);
    var wear = TOUR.stageWear(st, crashes);
    var lostMs = 0, faultLine = "";

    if (pendingFault) {
      lostMs = pendingFault.lostS * 1000;
      var f = pendingFault.fault;
      if (pendingFault.fixedBy) {
        var used = pendingFault.fixedBy;
        tour.bag.splice(tour.bag.indexOf(used), 1);
        faultLine = '<p class="res-fault res-fault--ok">' + f.icon + " <b>" + f.name + "!</b> " +
          f.story + " You had the " + TOUR.SPARES[used].name.toLowerCase() +
          " in the bag — fixed at the roadside, <b>" + pendingFault.lostS + "s</b> lost.</p>";
      } else {
        faultLine = '<p class="res-fault">' + f.icon + " <b>" + f.name + "!</b> " + f.story +
          " Nothing in the bag would fix it, so you nursed it home — <b>" +
          pendingFault.lostS + "s</b> lost.</p>";
      }
    }
    pendingFault = null;

    tour.kwacha += pay.total;
    tour.condition = Math.max(5, tour.condition - wear);
    /* the Grown-Up Crew's support van is waiting at every stage finish */
    var vanPts = TOUR.fettle(tour);
    tour.results.push({ id: st.id, timeMs: timeMs, lostMs: lostMs, coins: coins, crashes: crashes, pay: pay.total });
    tour.stage++;
    saveTour();

    return { pay: pay, wear: wear, lostMs: lostMs, faultLine: faultLine, vanPts: vanPts,
             coins: coins, crashes: crashes,
             beatPar: timeMs <= TOUR.targetMs(st),
             last: tour.stage >= TOUR.STAGES.length };
  }

  function finishTourStage(st2, timeMs) {
    var st = tourStage();
    var books = tourStageBooks(st, st2, timeMs);
    var pay = books.pay, wear = books.wear, vanPts = books.vanPts;
    var faultLine = books.faultLine, beatPar = books.beatPar, last = books.last;

    /* the payoff for forty minutes of riding: a whole-country time to beat */
    var finale = "";
    if (last) {
      var total = TOUR.totalMs(tour);
      var prev = bestTour();
      var record = !prev || total < prev.timeMs;
      if (record) lsSet("zr3_tourbest", { timeMs: total, rider: CORE.sanitizeName(tour.rider || profile.name) });
      var brokeCount = tour.results.filter(function (r) { return r.lostMs > 0; }).length;
      var lostAll = tour.results.reduce(function (a2, r) { return a2 + (r.lostMs || 0); }, 0);
      finale =
        '<div class="tour-finale">' +
          "<h3>The Great Zambia Tour — <em>complete</em></h3>" +
          '<p class="tf-time">' + fmtTime(total) + "</p>" +
          '<p class="tf-line">Ten legs · ' + (TOUR.TOTAL_M / 1000).toFixed(1) +
            " km · Livingstone to Livingstone the long way round.</p>" +
          '<p class="tf-line">' + (brokeCount
            ? brokeCount + (brokeCount === 1 ? " mechanical" : " mechanicals") + " on the road cost you " +
              Math.round(lostAll / 1000) + " seconds."
            : "Ten legs and not a single mechanical — that bike was looked after.") +
            " You finished with <b>K " + tour.kwacha + "</b> in the purse.</p>" +
          (record
            ? '<p class="tf-record">🏅 A new best time around Zambia' +
              (prev ? " — " + fmtTime(prev.timeMs - total) + " quicker than your last one." : ".") + "</p>"
            : '<p class="tf-line">Your best is still ' + fmtTime(prev.timeMs) + " — " +
              fmtTime(total - prev.timeMs) + " to find.</p>") +
        "</div>";
    }
    el.resultsContent.innerHTML =
      '<div class="results-medal">' + (last ? "🏆" : beatPar ? "⏱️" : "🚵") + "</div>" +
      "<h2>Stage " + st.n + " — " + st.name + "</h2>" +
      '<p class="gr-tag">' + st.from + " → " + st.to + "</p>" +
      '<div class="res-stats">' +
        resStat("Stage time", fmtTime(timeMs)) +
        resStat("Par", fmtTime(TOUR.targetMs(st)), beatPar ? "beaten" : "missed") +
        resStat("Tour total", fmtTime(TOUR.totalMs(tour))) +
      "</div>" +
      faultLine +
      '<div class="res-stats res-stats--pay">' +
        resStat("Distance", "K " + pay.base) +
        resStat("Coins", "K " + pay.coins) +
        resStat("Under par", "K " + pay.bonus) +
        resStat("No crashes", "K " + pay.tidy) +
        resStat("Earned", "K " + pay.total) +
      "</div>" +
      '<p class="res-wear">🔧 The leg took <b>' + wear + "%</b> out of the bike" +
        (vanPts ? ", and the club van 🚐 put <b>" + vanPts + "%</b> back for free" : "") +
        " — condition now <b>" + Math.round(tour.condition) + "%</b>. Purse: <b>K " +
        tour.kwacha + "</b>.</p>" +
      finale;

    var next = $("btn-tour-next");
    showResultsRow("results-row-tour");
    if (next) {
      next.hidden = last;
      next.textContent = "Workshop, then stage " + (st.n + 1) + " 🔧";
    }
    el.results.classList.toggle("is-finale", last);
    tourMode = false;
    wxForced = null;
    mode = "results";
    hideRideChrome();
    stopRumble();
    stopRain();
    SFX.finish();
    showOnly(el.results);
  }

  function hideRideChrome() {
    /* the results overlay lets the mountain show through on purpose; the HUD,
       the turbo meter and the exit button showing through with it is clutter */
    el.hud.hidden = true;          /* the turbo meter lives inside the HUD */
    if (el.hud2) el.hud2.hidden = true;
    if (el.mpBoard) el.mpBoard.hidden = true;
    var mpT = $("mp-tags");
    if (mpT) mpT.hidden = true;
    el.countdown.hidden = true;
    if (el.countdown2) el.countdown2.hidden = true;
    el.touch.hidden = true;
    el.hint.hidden = true;
    if (el.exitBtn) el.exitBtn.hidden = true;
  }

  /* the head to head */
  function finishVersus() {
    var order = run.riders.slice().sort(function (a, b2) {
      if (a.timedOut !== b2.timedOut) return a.timedOut ? 1 : -1;
      return a.st.finishT - b2.st.finishT;
    });
    var win = order[0], lose = order[1];
    var gap = lose && !lose.timedOut && !win.timedOut
      ? Math.round((lose.st.finishT - win.st.finishT) * 1000) : 0;

    var cards = run.riders.map(function (r) {
      var won = r === win && !r.timedOut;
      return '<div class="vs-card' + (won ? " is-winner" : "") + '" style="--p-tint:' + r.jersey + '">' +
        '<span class="vs-crown">' + (won ? "🏆" : r.timedOut ? "🏳️" : "🚵") + "</span>" +
        '<span class="vs-name">' + r.name + "</span>" +
        '<span class="vs-time">' + (r.timedOut ? "—" : fmtTime(Math.round(r.st.finishT * 1000))) + "</span>" +
        '<span class="vs-line">🪙 ' + r.st.score + " · " +
          (r.st.crashes ? r.st.crashes + (r.st.crashes === 1 ? " crash" : " crashes") : "clean run") +
          (r.st.tricks ? " · " + r.st.tricks + " tricks" : "") + "</span>" +
        "</div>";
    }).join("");

    el.results.classList.remove("is-finale");
    showResultsRow("results-row-vs");

    el.resultsContent.innerHTML =
      '<div class="results-medal">🏁</div>' +
      "<h2>" + (win.timedOut ? "Time!" : win.name + " wins!") + "</h2>" +
      '<p class="gr-tag">' + CORE.TRACKS3[selTrack].name + "</p>" +
      '<div class="vs-grid">' + cards + "</div>" +
      (gap
        ? '<p class="vs-gap">' + fmtTime(gap) + " between them" +
          (gap < 1500 ? " — a photo finish! 📸" : "") + "</p>"
        : lose && lose.timedOut
          ? '<p class="vs-gap">' + lose.name + " ran out of road before the flag.</p>"
          : "") +
      '<p class="results-note">Two-up races stay between the two of you: no personal bests, ' +
      "no Ghost Codes and nothing goes to the club board. Ride solo for those.</p>";

    mode = "results";
    el.results.hidden = false;
    hideRideChrome();
    stopRumble();
    stopRain();
    SFX.finish();
  }

  function resStat(k, v, note) {
    var nil = /^K 0$/.test(String(v));
    return '<span class="res-stat' + (nil ? " res-stat--nil" : "") + '"><b>' + k + "</b>" + v +
      (note ? '<i class="res-note">' + note + "</i>" : "") + "</span>";
  }

  /* ---------- wiring ---------- */

  if (TOUR) {
    var onTour = function (id, fn) {
      var b = $(id);
      if (b) b.addEventListener("click", fn);
    };
    onTour("btn-tour-open", openTour);
    onTour("btn-tour-exit", function () { leaveTour(); mode = "menu"; showOnly(el.menu); refreshMenu(); });
    onTour("btn-tour-go", function () {
      if (tour.stage >= TOUR.STAGES.length) { tour = TOUR.freshTour(profile.name); saveTour(); }
      openBrief();
    });
    onTour("btn-tour-restart", function () {
      tour = TOUR.freshTour(profile.name);
      saveTour();
      renderTour();
    });
    onTour("btn-brief-go", startTourStage);
    onTour("btn-brief-shop", openShop);
    onTour("btn-brief-back", openTour);
    onTour("btn-shop-done", function () {
      /* on a live tour the workshop leads back to the convoy, not to a briefing
         only this rider can see */
      if (mpInShop) { mpInShop = false; mode = "mp"; showOnly(el.mp); renderMp(); return; }
      openBrief();
    });

    $("shop-repair").addEventListener("click", function (e) {
      var b = e.target.closest("[data-repair]");
      if (!b) return;
      var pts = Number(b.getAttribute("data-repair"));
      var cost = pts * TOUR.REPAIR_PER_POINT;
      if (tour.kwacha < cost) return;
      tour.kwacha -= cost;
      tour.condition = Math.min(100, tour.condition + pts);
      saveTour();
      renderShop();
      SFX.gate();
    });
    $("spare-grid").addEventListener("click", function (e) {
      var b = e.target.closest("[data-buy]");
      if (!b) return;
      var id = b.getAttribute("data-buy");
      var sp = TOUR.SPARES[id];
      if (tour.bag.indexOf(id) >= 0 || tour.bag.length >= TOUR.BAG_SLOTS || tour.kwacha < sp.kwacha) return;
      tour.kwacha -= sp.kwacha;
      tour.bag.push(id);
      saveTour();
      renderShop();
      SFX.coin();
    });
    $("bag-list").addEventListener("click", function (e) {
      var b = e.target.closest("[data-drop]");
      if (!b) return;
      tour.bag.splice(Number(b.getAttribute("data-drop")), 1);
      saveTour();
      renderShop();
    });
    onTour("btn-tour-next", openShop);
    onTour("btn-tour-retry", retryTourStage);
    onTour("btn-tour-road", openTour);
    /* the roadbook's own way into a convoy — a rider looking at the Tour should
       not have to know that "Race a friend" is where the Tour lives too */
    onTour("btn-tour-live", function () {
      if (!NET) return;
      openMp();
      var setup = mpSetup();
      setup.tour = true;
      if (NET.state === "open") NET.create(CORE.sanitizeName(profile.name), profile.jersey, setup);
      else mpPendingTour = setup;
    });
    onTour("btn-tour-menu", function () { leaveTour(); quitToMenu(); });
  }

  /* ====================================================================
     LIVE RACING
     Everybody simulates their own bike, exactly as in single player, and
     tells the room where they are about fifteen times a second. Nobody's
     input crosses the wire, so a slow connection costs you a smooth view of
     your friend and never control of your own bike.

     What that buys in honesty it spends in trust, so a live race is treated
     like the two-up race on one sofa: no personal bests, no medals, no
     unlocks, nothing to the club board. Records still come only from a solo
     run whose ghost the server re-simulates.
     ==================================================================== */

  var NET = window.ZR_NET || null;
  var MPC = window.ZR_MP || null;
  var mpMode = false;            /* is this run a live race? */
  var mpRigs = {};               /* peer id -> a rig on the hill */
  var mpFlags = {};              /* peer id -> the name floating over them */
  var mpArmed = false;           /* waiting on the server's countdown */
  var mpPending = null;          /* your own result, until the server echoes it */
  var mpLost = false;            /* the club server went away mid-race */
  var mpSaved = null;            /* the rider's own track/light/weather, borrowed */
  var mpTourBooks = null;        /* the leg just ridden, while its sheet is up */
  var mpInShop = false;          /* at the workshop between two legs of a live tour */
  var mpPendingTour = null;      /* a convoy asked for before the socket was up */

  function mpSetup() {
    return { track: selTrack, tod: todSel, wx: wxSel };
  }

  /* ---------- the lobby ---------- */

  function openMp() {
    if (!NET) return;
    mode = "mp";
    mpErr("");                       /* never open on the last refusal */
    if (NET.state !== "open") NET.connect();
    renderMp();
    showOnly(el.mp);
    /* a child who came here to join a race wants the box their friend's code
       goes in, not a hunt for it */
    var box = $("mp-code");
    if (box && !NET.room) { try { box.focus(); } catch (e) { /* not focusable yet */ } }
  }

  function mpErr(txt) {
    var e = $("mp-err");
    if (e) e.textContent = txt || "";
  }

  function hostName(room) {
    var h = room.players.filter(function (p) { return p.id === room.hostId; })[0];
    return h ? h.name : "the host";
  }

  function renderMp() {
    if (!NET) return;
    var entry = $("mp-entry"), lobby = $("mp-lobby");
    var room = NET.room;
    if (entry) entry.hidden = !!room;
    if (lobby) lobby.hidden = !room;

    var sub = $("mp-sub");
    if (sub) {
      sub.textContent = NET.state === "open"
        ? (room ? (room.tour ? "Ten legs, one convoy, one clock each."
                             : "Everyone here rides the same hill at the same moment.")
                : "Two devices, one hill, at the same time.")
        : NET.state === "connecting" ? "Finding the club server…"
        : "The club server is not answering — live racing needs it running.";
    }
    if (!room) return;

    var tag = $("mp-code-tag");
    if (tag) tag.textContent = room.code;

    var list = $("mp-riders");
    if (list) {
      list.innerHTML = room.players.map(function (p) {
        var bits = "";
        if (p.id === NET.you) bits += '<span class="mp-tag mp-tag--you">you</span>';
        if (p.id === room.hostId) bits += '<span class="mp-tag mp-tag--host">host</span>';
        bits += p.ready
          ? '<span class="mp-tag mp-tag--ready">ready</span>'
          : '<span class="mp-tag">waiting</span>';
        return '<li style="--p-tint:' + p.jersey + '"><span class="mp-name">' +
          p.name + "</span>" + bits + "</li>";
      }).join("");
    }

    /* on a tour the lobby is a roadbook page: which leg is next, where it goes,
       what the sky is doing, and where everybody stands overall */
    var road = $("mp-road");
    if (road) {
      var leg = room.tour && TOUR ? TOUR.stageAt(room.stage) : null;
      if (!leg) { road.hidden = true; road.innerHTML = ""; }
      else {
        var w = TOUR.WEATHER[leg.weather] || {};
        var sf = TOUR.SURFACES[leg.surface] || {};
        road.hidden = false;
        road.innerHTML =
          '<p class="mp-road-leg">Leg <b>' + leg.n + "</b> of " + TOUR.STAGES.length +
            " · <b>" + leg.name + "</b></p>" +
          '<p class="mp-road-line">' + leg.from + " → " + leg.to + " · " +
            (leg.length / 1000).toFixed(2) + " km · " + (sf.icon || "") + " " +
            (sf.label || leg.surface) + " · " + (w.icon || "") + " " + (w.label || leg.weather) + "</p>" +
          (room.gc && room.gc.some(function (g) { return g.legs > 0; })
            ? '<h4 class="gc-head gc-head--lobby">General classification</h4>' + mpGc(room)
            : '<p class="mp-road-line">Livingstone, and the whole country to go.</p>');
      }
    }

    var hint = $("mp-hosthint");
    if (hint && room.tour) {
      hint.innerHTML = room.players.length < 2
        ? "<b>Read the code out — the convoy leaves when everybody is here.</b>"
        : NET.isHost() ? "When everybody is ready, roll them out."
                       : "Waiting for " + hostName(room) + " to roll the convoy out.";
    } else if (hint) {
      var t = CORE.TRACKS3[room.track];
      hint.innerHTML = "Everyone rides <b>" + (t ? t.name : room.track) + "</b>" +
        (room.wx !== "clear" ? " in the " + room.wx : "") +
        (room.tod !== "auto" ? " at " + room.tod : "") + ". " +
        (room.players.length < 2
          ? "<b>Read the code to your friend — the race starts when they are here.</b>"
          : NET.isHost()
            ? "When everybody is ready, drop the flag."
            : "Waiting for " + hostName(room) + " to drop the flag.");
    }

    var me = NET.me();
    var rdy = $("btn-mp-ready");
    if (rdy) {
      rdy.textContent = me && me.ready ? "Not ready yet" : "I\u2019m ready 👍";
      rdy.className = "btn btn--small " + (me && me.ready ? "btn--ghost" : "btn--forest");
    }
    var startBtn = $("btn-mp-start");
    if (startBtn) {
      startBtn.hidden = !NET.isHost();
      var can = room.players.length >= 2 && room.players.every(function (p) { return p.ready; });
      startBtn.disabled = !can;
      startBtn.textContent = room.tour
        ? (room.stage ? "Roll out for leg " + (room.stage + 1) + " 🇿🇲" : "Roll out of Livingstone 🇿🇲")
        : "Drop the flag 🏁";
      startBtn.className = "btn btn--small " + (can ? "btn--copper" : "btn--ghost");
    }
  }

  /* ---------- riders on the hill ---------- */

  function mpClearRigs() {
    Object.keys(mpRigs).forEach(function (id) {
      var r = mpRigs[id];
      if (r.group.parent) r.group.parent.remove(r.group);
    });
    mpRigs = {};
    var tags = $("mp-tags");
    if (tags) { tags.innerHTML = ""; tags.hidden = true; }
    mpFlags = {};
  }

  function mpAttachRigs(scene) {
    mpClearRigs();
    NET.others().forEach(function (p) {
      var rig = buildRiderMesh(new THREE.Color(p.jersey).getHex());
      enableRigShadows(rig);
      scene.add(rig.group);
      mpRigs[p.id] = rig;
    });
    var tags = $("mp-tags");
    if (tags) {
      tags.hidden = false;
      tags.innerHTML = NET.others().map(function (p) {
        return '<span class="mp-flag" id="mpf-' + p.id + '" style="--p-tint:' + p.jersey + '">' +
          p.name + "</span>";
      }).join("");
      NET.others().forEach(function (p) { mpFlags[p.id] = $("mpf-" + p.id); });
    }
  }

  var mpVec = new THREE.Vector3();
  function mpAnimate(dt) {
    if (!mpMode || !NET) return;
    var nowMs = performance.now();
    var stage = stageEl ? stageEl.getBoundingClientRect() : null;
    NET.others().forEach(function (p) {
      var rig = mpRigs[p.id];
      if (!rig) return;
      var at = NET.peerAt(p.id, nowMs);
      var flag = mpFlags[p.id];
      if (!at) {
        rig.group.visible = false;
        if (flag) flag.style.display = "none";
        return;
      }
      rig.group.visible = true;
      placeRig(rig, at.x, at.y, at.z, at.yaw, 0);
      if (at.dwn) rig.group.rotation.z += 6 * dt;
      rig.wheelF.rotation.x -= at.sp * dt / 0.34;
      rig.wheelB.rotation.x -= at.sp * dt / 0.34;
      rig.blob.visible = lightMode && !at.air;
      /* a rider who has gone quiet fades rather than vanishing */
      rig.group.traverse(function (o) {
        if (o.isMesh && o.material && o.material.transparent) o.material.opacity = at.stale ? 0.3 : 1;
      });
      /* their name, over their head, in screen space */
      if (flag && stage) {
        mpVec.set(at.x, at.y + 2.4, at.z).project(views[0].camera);
        var onScreen = mpVec.z < 1 && Math.abs(mpVec.x) < 1.3 && Math.abs(mpVec.y) < 1.3;
        if (onScreen) {
          flag.style.display = "block";
          flag.style.left = ((mpVec.x * 0.5 + 0.5) * stage.width).toFixed(0) + "px";
          flag.style.top = ((-mpVec.y * 0.5 + 0.5) * stage.height).toFixed(0) + "px";
        } else {
          flag.style.display = "none";
        }
      }
    });
  }

  /* who is where, down the hill */
  function mpBoard(world) {
    var board = el.mpBoard;
    if (!board || !mpMode || !NET.room) return;
    var me = NET.me();
    var rows = [];
    rows.push({ id: NET.you, name: (me && me.name) || "You", jersey: (me && me.jersey) || "#1F7A48",
      z: run.st.z, done: run.st.finished, you: true, gone: false });
    NET.others().forEach(function (p) {
      var at = NET.peerAt(p.id, performance.now());
      rows.push({ id: p.id, name: p.name, jersey: p.jersey,
        z: at ? at.z : -1e9, done: p.finished, you: false, gone: !at || at.stale });
    });
    rows.sort(function (a, b2) { return (b2.done ? 1e9 : b2.z) - (a.done ? 1e9 : a.z); });
    var lead = rows[0];
    board.innerHTML = rows.map(function (r) {
      var gap = r === lead ? "" : Math.round(lead.z - r.z) + " m";
      return '<li class="' + (r.you ? "is-you " : "") + (r.gone ? "is-gone" : "") +
        '" style="--p-tint:' + r.jersey + '"><span class="mpb-dot"></span>' +
        '<span class="mpb-name">' + r.name + "</span>" +
        '<span class="mpb-gap">' + (r.done ? "🏁" : gap) + "</span></li>";
    }).join("");
  }

  /* ---------- starting together ---------- */

  /* The host drops the flag; the server names a moment; every device counts
     down to that same moment on its own clock. */
  function mpArm() {
    if (!NET.room || mpArmed) return;
    mpArmed = true;
    mpMode = true;
    mpPending = null;
    mpLost = false;
    setPlayers(1, false);            /* a live race is one rider per screen */
    /* The host picks the mountain and the weather for the race, not for their
       friend's game. Borrow the settings, remember what this rider had, and
       give it back when the race is over — otherwise a friend's choice of storm
       quietly follows them home and disqualifies their solo runs. */
    mpSaved = { track: selTrack, tod: todSel, wx: wxSel };
    if (NET.room.tour) { mpTourArm(); }
    else if (NET.room.track !== selTrack) selectTrack(NET.room.track, false);
    todSel = NET.room.tod;
    wxSel = NET.room.wx;
    refreshTodChips();
    startRace();
    /* replace the local 3-2-1 with one keyed to the server's moment */
    run.countT = Math.max(0.2, NET.clock.until(NET.room.startAt) / 1000);
    run.lastBeep = Math.ceil(run.countT) + 1;
    mpAttachRigs(run.b.sc.scene);
    if (el.mpBoard) {
      /* wipe last race's standings: opening a countdown on a board that says
         everybody already finished reads like the race is over before it starts */
      el.mpBoard.innerHTML = "";
      el.mpBoard.hidden = false;
    }
  }

  /* ==================================================================
     THE TOUR, TOGETHER

     Ten legs, one convoy. Each leg is an ordinary live race on that leg's
     own track and sky — the roadbook picks them, in order, not the host —
     and between legs everybody goes to their own workshop and readies up.

     Each rider's purse, bike condition and bag stay entirely on their own
     machine: nothing about the workshop crosses the wire. What crosses is
     what the standings need — the time the server took at the line, and
     the seconds a mechanical cost, which is the one number a rider reports
     about themselves and can only ever use to slow themselves down.

     The times add up. That is the whole point: the rider in front on the
     road is not always the rider in front on the tour.
     ================================================================== */

  function mpTourLeg() {
    return NET.room && NET.room.tour && TOUR ? TOUR.stageAt(NET.room.stage) : null;
  }

  function mpTourArm() {
    var leg = mpTourLeg();
    if (!leg) return;
    /* the rider's own tour: their purse, their bike, their bag. Only the leg
       number is the room's to say. */
    useLiveTour();
    if (!tour || !TOUR.validTour(tour)) tour = TOUR.freshTour(profile.name);
    if (NET.room.stage === 0 && tour.stage !== 0) tour = TOUR.freshTour(profile.name);
    tour.stage = NET.room.stage;
    saveTour();
    var legWx = TOUR.stageWx(leg);
    wxForced = legWx === "clear" ? null : legWx;
    pendingFault = TOUR.rollFault(leg, tour.condition, tour.bag, tour.number + tour.stage);
    selTrack = leg.id;
    tourMode = true;
  }

  /* the classification, as a table: everybody's legs added up, leader first */
  function mpGc(room) {
    var gc = room.gc || [];
    if (!gc.length) return "";
    var rows = gc.map(function (r) {
      var lead = r.place === 1 && r.legs > 0;
      return '<tr class="' + (r.id === NET.you ? "gc-you " : "") + (r.away ? "gc-away" : "") + '">' +
        "<td>" + (lead ? "👕" : r.place) + "</td>" +
        '<td><span class="gc-dot" style="background:' + r.jersey + '"></span>' +
          r.name + (r.id === NET.you ? " (you)" : "") + (r.away ? " · back soon" : "") + "</td>" +
        "<td>" + (r.legs ? fmtTime(r.gcMs) : "—") + "</td>" +
        "<td>" + (r.place === 1 || !r.legs ? "" : "+" + fmtTime(r.gapMs)) + "</td>" +
        "</tr>";
    }).join("");
    return '<table class="gc-table"><thead><tr><th></th><th>Rider</th>' +
      "<th>Tour</th><th>Gap</th></tr></thead><tbody>" + rows + "</tbody></table>";
  }

  function mpFinishRace() {
    var st = run.st;
    if (NET.room && NET.room.tour) { mpTourFinish(st); return; }
    var r = {
      timeMs: Math.round(st.finishT * 1000),
      coins: st.coinCount,
      crashes: st.crashes
    };
    if (!NET.room) { mpLost = true; renderMpResults(); return; }
    NET.finish(r);
    /* The server's word on the finishing order is a round trip away. Keep our own
       result here so the screen can show it at once, rather than leaving the rider
       who just crossed the line reading their own name under "still out there". */
    mpPending = r;
    renderMpResults();
  }

  function mpTourFinish(st2) {
    var leg = mpTourLeg() || tourStage();
    var localMs = Math.round(st2.finishT * 1000);
    /* the books first: the mechanical, the purse, the wear. Same numbers the
       solo tour keeps, and they stay on this machine. */
    var books = tourStageBooks(leg, st2, localMs);
    tourMode = false;
    wxForced = null;
    mpTourBooks = { books: books, leg: leg, localMs: localMs };
    if (!NET.room) { mpLost = true; renderMpResults(); return; }
    NET.finish({ timeMs: localMs, coins: books.coins, crashes: books.crashes,
                 lostMs: books.lostMs });
    mpPending = { timeMs: localMs, coins: books.coins, crashes: books.crashes };
    renderMpResults();
  }

  /* one leg of a live tour: the stage sheet a solo rider gets, with the
     classification under it and the convoy's next move as the button */
  function renderMpTourResults() {
    var room = NET.room, tb = mpTourBooks;
    if (!room || !tb) return false;
    var leg = tb.leg, books = tb.books;
    var mine = null;
    (room.finishOrder || []).forEach(function (f) { if (f.id === NET.you) mine = f; });
    /* the server's number once it lands; ours until then */
    var timeMs = mine && mine.result ? mine.result.timeMs : tb.localMs;
    var waiting = room.players.filter(function (p) {
      return !p.finished && p.id !== NET.you;
    });
    var over = room.state === "tourover";
    var last = room.stage >= (MPC && MPC.TOUR_LEGS ? MPC.TOUR_LEGS - 1 : 9);

    el.results.classList.toggle("is-finale", over);
    showResultsRow("results-row-mp");
    var canGo = room.state === "done" || over;
    var againBtn = $("btn-mp-again");
    if (againBtn) {
      againBtn.hidden = over;
      againBtn.disabled = !canGo;
      againBtn.className = "btn btn--big " + (canGo ? "btn--copper" : "btn--ghost");
      againBtn.textContent = canGo
        ? (last ? "Roll into Livingstone 🏁" : "Workshop, then leg " + (room.stage + 2) + " 🔧")
        : waiting.length
          ? "Waiting for " + waiting.map(function (p) { return p.name; }).join(" and ") + "…"
          : "Waiting for the leg to finish…";
    }
    var backBtn = $("btn-mp-back");
    if (backBtn) { backBtn.disabled = false; backBtn.textContent = "The convoy"; }

    el.resultsContent.innerHTML =
      '<div class="results-medal">' + (over ? "🏆" : books.beatPar ? "⏱️" : "🚵") + "</div>" +
      "<h2>Leg " + leg.n + " — " + leg.name + "</h2>" +
      '<p class="gr-tag">' + leg.from + " → " + leg.to + " · code " + room.code + "</p>" +
      '<div class="res-stats">' +
        resStat("Your leg", fmtTime(timeMs)) +
        resStat("Par", fmtTime(TOUR.targetMs(leg)), books.beatPar ? "beaten" : "missed") +
        resStat("Earned", "K " + books.pay.total) +
      "</div>" +
      books.faultLine +
      '<h3 class="gc-head">' + (over ? "The Great Zambia Tour — final classification"
                                     : "General classification after leg " + leg.n) + "</h3>" +
      mpGc(room) +
      (waiting.length
        ? '<p class="vs-gap">Still out there: ' + waiting.map(function (p) { return p.name; }).join(", ") + "</p>"
        : "") +
      '<p class="res-wear">🔧 The leg took <b>' + books.wear + "%</b> out of the bike" +
        (books.vanPts ? ", and the club van 🚐 put <b>" + books.vanPts + "%</b> back for free" : "") +
        " — condition now <b>" + Math.round(tour.condition) + "%</b>. Purse: <b>K " +
        tour.kwacha + "</b>.</p>" +
      '<p class="results-note">A tour ridden together stays between the riders in the convoy: ' +
      "the legs, the purse and the bike are yours, but no ⏱ bests, no Ghost Codes and nothing " +
      "goes to the club board. Ride the tour on your own for those.</p>";

    mode = "results";
    el.results.hidden = false;
    hideRideChrome();
    stopRumble();
    stopRain();
    return true;
  }

  /* The club server went away while they were riding. They still rode it, and
     they are owed a screen that says what happened instead of the single-player
     panel congratulating them on a run nobody was watching. */
  function mpLostResults() {
    el.results.classList.remove("is-finale");
    showResultsRow("results-row-mp");
    var againBtn = $("btn-mp-again");
    if (againBtn) againBtn.hidden = true;
    var backBtn = $("btn-mp-back");
    if (backBtn) { backBtn.disabled = false; backBtn.textContent = "Start another race"; }

    var t = run && run.st ? fmtTime(Math.round(run.st.finishT * 1000)) : "—";
    el.resultsContent.innerHTML =
      '<div class="results-medal">📡</div>' +
      "<h2>Lost the club server</h2>" +
      '<p class="gr-tag">You finished the run — but the race could not be timed.</p>' +
      '<div class="vs-grid"><div class="vs-card is-winner" style="--p-tint:' +
        (MPC && MPC.JERSEYS ? MPC.JERSEYS[0] : "#1F7A48") + '">' +
        '<span class="vs-crown">🚵</span>' +
        '<span class="vs-name">Your run</span>' +
        '<span class="vs-time">' + t + "</span>" +
        '<span class="vs-line">on your own clock</span></div></div>' +
      '<p class="results-note">The connection went away mid-race, so this one counts for ' +
      "nobody — not your friend, not your ⏱ bests, not the club board. Check the wifi and " +
      "read out a new code.</p>";

    mode = "results";
    el.results.hidden = false;
    hideRideChrome();
    stopRumble();
    stopRain();
    mpLeaveAll();   /* so the next ordinary run counts again */
  }

  function renderMpResults() {
    var room = NET.room;
    if (!room) { mpLostResults(); return; }
    if (room.tour && renderMpTourResults()) return;
    var order = room.finishOrder.slice();
    var mine = null;
    order.forEach(function (f) { if (f.id === NET.you) mine = f; });
    /* Not in the server's order yet? Then we only just crossed and the echo is
       still in flight: show our own time now and let the echo correct the place. */
    if (!mine && mpPending) {
      var me = NET.me();
      mine = {
        id: NET.you,
        name: (me && me.name) || "You",
        jersey: (me && me.jersey) || (MPC && MPC.JERSEYS ? MPC.JERSEYS[0] : "#1F7A48"),
        place: order.length + 1,
        result: mpPending,
        pending: true
      };
      order.push(mine);
    }
    var waiting = room.players.filter(function (p) {
      return !p.finished && !(mine && p.id === NET.you);
    });

    var cards = order.map(function (f, i) {
      var crown = i === 0 ? "🏆" : i === 1 ? "🥈" : "🚵";
      return '<div class="vs-card' + (i === 0 ? " is-winner" : "") + '" style="--p-tint:' + f.jersey + '">' +
        '<span class="vs-crown">' + crown + "</span>" +
        '<span class="vs-name">' + f.name + (f.id === NET.you ? " (you)" : "") + "</span>" +
        '<span class="vs-time">' + fmtTime(f.result.timeMs) + "</span>" +
        '<span class="vs-line">🪙 ' + f.result.coins + " · " +
          (f.result.crashes ? f.result.crashes + " crash" + (f.result.crashes === 1 ? "" : "es") : "clean run") +
        "</span></div>";
    }).join("");

    var gap = order.length >= 2 && order[1].result
      ? order[1].result.timeMs - order[0].result.timeMs : 0;

    el.results.classList.remove("is-finale");
    showResultsRow("results-row-mp");
    /* Anybody in the room may line them up again — but not while a friend is
       still coming down. Until then the button is there, plainly not ready yet,
       so nobody taps it and collects an error. */
    var canAgain = room.state === "done";
    var againBtn = $("btn-mp-again");
    if (againBtn) {
      againBtn.hidden = false;
      againBtn.disabled = !canAgain;
      againBtn.className = "btn btn--big " + (canAgain ? "btn--copper" : "btn--ghost");
      againBtn.textContent = canAgain ? "Race again 🏁"
        : waiting.length
          ? "Waiting for " + waiting.map(function (p) { return p.name; }).join(" and ") + "…"
          : "Waiting for the race to finish…";
    }
    var backBtn = $("btn-mp-back");
    if (backBtn) {
      backBtn.disabled = !canAgain;
      backBtn.textContent = canAgain ? "Back to the start line" : "Back to the start line — not yet";
    }

    el.resultsContent.innerHTML =
      '<div class="results-medal">📡</div>' +
      "<h2>" + (mine && mine.pending ? "Across the line!" :
        mine && mine.place === 1 ? "You win!" :
        order.length ? order[0].name + " wins" : "Race over") + "</h2>" +
      '<p class="gr-tag">' + (CORE.TRACKS3[room.track] ? CORE.TRACKS3[room.track].name : room.track) +
        " · code " + room.code + "</p>" +
      '<div class="vs-grid">' + cards + "</div>" +
      (gap ? '<p class="vs-gap">' + fmtTime(gap) + " between first and second" +
        (gap < 1500 ? " — a photo finish! 📸" : "") + "</p>" : "") +
      (waiting.length
        ? '<p class="vs-gap">Still out there: ' + waiting.map(function (p) { return p.name; }).join(", ") + "</p>"
        : "") +
      '<p class="results-note">Live races stay between the riders in the room: no personal ⏱ bests, ' +
      "no Ghost Codes and nothing goes to the club board. Ride on your own for those.</p>";

    mode = "results";
    el.results.hidden = false;
    hideRideChrome();
    stopRumble();
    stopRain();
  }

  function mpLeaveAll() {
    mpMode = false;
    mpArmed = false;
    mpPending = null;
    mpLost = false;
    mpTourBooks = null;
    mpInShop = false;
    tourMode = false;
    wxForced = null;
    /* Between two legs the convoy is still on, so the convoy's tour stays
       loaded. Once the room is gone, the rider's own tour comes back. */
    if (TOUR && (!NET || !NET.room || !NET.room.tour)) useSoloTour();
    if (mpSaved) {
      if (mpSaved.track !== selTrack) selectTrack(mpSaved.track, false);
      todSel = mpSaved.tod;
      wxSel = mpSaved.wx;
      mpSaved = null;
      refreshTodChips();
    }
    mpClearRigs();
    if (el.mpBoard) el.mpBoard.hidden = true;
  }

  /* ---------- wiring ---------- */

  if (NET) {
    NET.onEvent = function (type, data) {
      if (type === "error") { mpErr(data.why); renderMp(); return; }
      if (type === "lost") {
        if (mpMode && !mpLost) {
          mpLost = true;
          mpClearRigs();          /* no phantom friend frozen on the trail */
          if (el.mpBoard) el.mpBoard.hidden = true;
          toastAll("📡 Lost the club server — you are riding on your own");
        }
        renderMp();
        return;
      }
      if (type === "state") {
        if (mpPendingTour && NET.state === "open" && !NET.room) {
          var setup = mpPendingTour;
          mpPendingTour = null;
          NET.create(CORE.sanitizeName(profile.name), profile.jersey, setup);
        }
        renderMp();
        return;
      }
      if (type === "room") {
        mpErr("");
        renderMp();
        if (data.joined && mode !== "mp") openMp();
        /* the host dropped the flag: everybody rolls out together */
        if (NET.room && NET.room.state === "countdown" && !mpArmed) mpArm();
        /* somebody joined or left mid-race — keep the rigs honest */
        if (mpMode && run && NET.room && NET.room.state !== "lobby") {
          var live = {};
          NET.others().forEach(function (p) { live[p.id] = 1; });
          var stale = Object.keys(mpRigs).some(function (id) { return !live[id]; }) ||
            NET.others().some(function (p) { return !mpRigs[p.id]; });
          if (stale) mpAttachRigs(run.b.sc.scene);
        }
        if (mpMode && mode === "results") renderMpResults();
        if (NET.room && NET.room.state === "lobby" && mpArmed) {
          /* the host lined everyone up again */
          stopRumble();
          stopRain();
          var shopping = mpInShop;
          mpLeaveAll();
          mpInShop = shopping;      /* mid-repair: finish before rejoining the convoy */
          if (!shopping) {
            mode = "mp";
            showOnly(el.mp);
          }
          renderMp();
        }
        return;
      }
    };

    var onMp = function (id, fn) { var b = $(id); if (b) b.addEventListener("click", fn); };
    onMp("btn-mp-open", openMp);
    onMp("btn-mp-exit", function () {
      if (NET.room) NET.leave();
      mpLeaveAll();
      mode = "menu";
      showOnly(el.menu);
      refreshMenu();
    });
    onMp("btn-mp-create", function () {
      mpErr("");
      NET.create(CORE.sanitizeName(profile.name), profile.jersey, mpSetup());
    });
    onMp("btn-mp-tour", function () {
      mpErr("");
      var setup = mpSetup();
      setup.tour = true;
      NET.create(CORE.sanitizeName(profile.name), profile.jersey, setup);
    });
    onMp("btn-mp-join", function () {
      var box = $("mp-code");
      var code = box ? box.value : "";
      if (!MPC.cleanCode(code)) { mpErr("A code is four letters or numbers — check it and try again."); return; }
      mpErr("");
      NET.join(code, CORE.sanitizeName(profile.name), profile.jersey);
    });
    onMp("btn-mp-ready", function () {
      var me = NET.me();
      NET.ready(!(me && me.ready));
    });
    onMp("btn-mp-start", function () { NET.start(); });
    onMp("btn-mp-leave", function () { NET.leave(); mpLeaveAll(); renderMp(); });
    onMp("btn-mp-again", function () {
      var room0 = NET.room;
      var moreLegs = !!(room0 && room0.tour && TOUR &&
                        room0.stage < TOUR.STAGES.length - 1);
      NET.again();
      /* On a tour this is the convoy moving on: everybody stops at their own
         workshop before the next leg, so open it rather than dropping them
         straight back at the start line. After the tenth there is no next leg
         and no workshop — only the final classification. */
      if (moreLegs && tour) { mpInShop = true; openShop(); }
    });
    onMp("btn-mp-back", function () {
      /* This used to show the lobby without telling the server, which left the
         room finished for good: the flag could never drop again and the only way
         out was to leave and swap a fresh code. */
      NET.again();
      mpLeaveAll();
      mode = "mp";
      showOnly(el.mp);
      renderMp();
    });
    onMp("btn-mp-quit", function () {
      if (NET.room) NET.leave();
      mpLeaveAll();
      quitToMenu();
    });

    var codeBox = $("mp-code");
    if (codeBox) {
      codeBox.addEventListener("input", function () {
        codeBox.value = codeBox.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);
      });
      codeBox.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); var b = $("btn-mp-join"); if (b) b.click(); }
      });
    }

    /* only offer live racing if a server is actually behind this page */
    NET.probe(function (live) {
      var btn = $("btn-mp-open");
      if (btn) btn.hidden = !live;
      var tbtn = $("btn-tour-live");
      if (tbtn) tbtn.hidden = !live;
    });
  }

  /* ---------- one rider or two ---------- */

  function setPlayers(n, persist) {
    n = n === 2 ? 2 : 1;
    if (n === numPlayers) return;
    numPlayers = n;
    /* the Grand Tour forces one rider for its own duration; it must not
       quietly throw away a two-up choice made in the menu */
    if (persist !== false) lsSet("zr3_players", n);
    if (stageEl) stageEl.classList.toggle("is-2p", n === 2);
    var row2 = $("rider-row-2"), keys = $("two-up-keys");
    if (row2) row2.hidden = n !== 2;
    if (keys) keys.hidden = n !== 2;
    document.querySelectorAll("[data-players]").forEach(function (b2) {
      b2.classList.toggle("is-selected", Number(b2.getAttribute("data-players")) === n);
    });
    /* Two strips need more height than one, so the stage goes from 16:9 to
       4:3 and the drawing buffer follows it. */
    syncRenderSize();
    layoutViews();
    initComposer();
    snapAllViews();
    /* on-screen thumb controls only ever drive player one, so they step aside */
    if (n === 2 && el.touch) el.touch.hidden = true;
    refreshMenu();
  }

  (function () {
    var row = $("players-row");
    if (row) {
      row.addEventListener("click", function (e) {
        var b2 = e.target.closest("[data-players]");
        if (b2) setPlayers(Number(b2.getAttribute("data-players")));
      });
    }
    var n2 = $("rider-name-2");
    if (n2) {
      n2.value = profile2.name || "";
      n2.addEventListener("input", function () {
        profile2.name = CORE.sanitizeName(n2.value);
        lsSet("zr_profile2", profile2);
      });
    }
    document.querySelectorAll("[data-jersey2]").forEach(function (b2) {
      b2.classList.toggle("is-selected", b2.getAttribute("data-jersey2") === profile2.jersey);
      b2.addEventListener("click", function () {
        profile2.jersey = b2.getAttribute("data-jersey2");
        lsSet("zr_profile2", profile2);
        document.querySelectorAll("[data-jersey2]").forEach(function (o) {
          o.classList.toggle("is-selected", o === b2);
        });
      });
    });
  })();

  /* ---------- menu ---------- */

  /* ---------- arcade course select ----------
     The course map is drawn from the real trail spline (CORE.trailPreview),
     so what a rider studies here is exactly the line they get. */

  var previewCache = {};
  function trackPreview(id) {
    if (!previewCache[id]) previewCache[id] = CORE.trailPreview(CORE.TRACKS3[id]);
    return previewCache[id];
  }

  function pips(v) {
    var s = "";
    for (var i = 1; i <= 5; i++) s += i <= v ? "▰" : "▱";
    return s;
  }

  function courseRatings(def) {
    function span(v, lo, hi) { return Math.max(1, Math.min(5, Math.round(1 + ((v - lo) / (hi - lo)) * 4))); }
    var wild = 2 + (def.hazards ? 1 : 0) + (def.river ? 1 : 0) + (def.gorge ? 1 : 0) + (def.theme.bats ? 2 : 0);
    return {
      Speed: span(def.slope, 0.05, 0.165),
      Twist: span(def.wobble, 0.8, 1.15),
      Air: span(-def.kickerEvery, -150, -100),
      Wild: Math.min(5, wild)
    };
  }

  function courseMapSVG(id) {
    var def = CORE.TRACKS3[id];
    var pv = trackPreview(id);
    var W = 200, H = 210, PAD = 16;
    var sx = (W - PAD * 2) / Math.max(1, pv.maxX - pv.minX);
    var sz = (H - PAD * 2) / Math.max(1, pv.zEnd);
    function px(x) { return PAD + (x - pv.minX) * sx; }
    function py(z) { return PAD + z * sz; }

    var s = "";
    /* faint CRT grid */
    for (var g = 0; g <= 4; g++) {
      s += '<line x1="0" y1="' + (g * H / 4) + '" x2="' + W + '" y2="' + (g * H / 4) + '" class="csm-grid"/>';
      s += '<line x1="' + (g * W / 4) + '" y1="0" x2="' + (g * W / 4) + '" y2="' + H + '" class="csm-grid"/>';
    }

    /* the river / the gorge, drawn beside the line they run beside */
    if (def.river) {
      var rv = "";
      for (var r = 0; r < pv.n; r += 6) {
        rv += (r ? " L" : "M") + (px(pv.pts[r].x + def.river.offset + def.river.width / 2)).toFixed(1) + " " + py(pv.pts[r].z).toFixed(1);
      }
      s += '<path d="' + rv + '" class="csm-river"/>';
    }
    if (def.gorge) {
      var gv = "", started = false;
      for (var q = Math.floor(pv.n * def.gorge.fromFrac); q < pv.n; q += 4) {
        gv += (started ? " L" : "M") + (px(pv.pts[q].x + def.gorge.offset + def.gorge.width / 2)).toFixed(1) + " " + py(pv.pts[q].z).toFixed(1);
        started = true;
      }
      if (started) s += '<path d="' + gv + '" class="csm-gorge"/>';
    }

    /* the trail itself: dark casing, bright core, dashed centre line */
    var d = "";
    for (var i = 0; i < pv.n; i += 3) {
      d += (i ? " L" : "M") + px(pv.pts[i].x).toFixed(1) + " " + py(pv.pts[i].z).toFixed(1);
    }
    d += " L" + px(pv.pts[pv.n - 1].x).toFixed(1) + " " + py(pv.pts[pv.n - 1].z).toFixed(1);
    s += '<path d="' + d + '" class="csm-case"/><path d="' + d + '" class="csm-line"/><path d="' + d + '" class="csm-dash"/>';

    /* kicker ticks across the trail */
    var kStep = Math.max(4, Math.floor(pv.n / pv.kickers));
    for (var k = kStep; k < pv.n - 4; k += kStep) {
      var a = pv.pts[k - 2], b = pv.pts[k + 2];
      var ax = px(a.x), ay = py(a.z), bx = px(b.x), by = py(b.z);
      var dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1;
      var nx = -dy / len * 5, ny = dx / len * 5;
      var cx = px(pv.pts[k].x), cy = py(pv.pts[k].z);
      s += '<line x1="' + (cx - nx).toFixed(1) + '" y1="' + (cy - ny).toFixed(1) +
        '" x2="' + (cx + nx).toFixed(1) + '" y2="' + (cy + ny).toFixed(1) + '" class="csm-kick"/>';
    }

    /* hazard zones, spaced the way the world places them — both the generic
       trail hazards and the river tracks' bespoke basking crocodiles */
    var hazZ = [];
    (def.hazards || []).forEach(function (hz) {
      for (var z = hz.from; z < def.length - 120; z += hz.every + 55) hazZ.push(z);
    });
    if (def.river) {
      for (var cz = 140; cz < def.length - 120; cz += 165) hazZ.push(cz);
    }
    hazZ.forEach(function (z) {
      var hi = Math.min(pv.n - 1, Math.floor(z / 5));
      s += '<circle cx="' + (px(pv.pts[hi].x) + 6).toFixed(1) + '" cy="' + py(pv.pts[hi].z).toFixed(1) + '" r="3" class="csm-haz"/>';
    });

    /* start and finish */
    var s0 = pv.pts[0], s1 = pv.pts[pv.n - 1];
    s += '<circle cx="' + px(s0.x).toFixed(1) + '" cy="' + py(s0.z).toFixed(1) + '" r="5" class="csm-start"/>';
    s += '<text x="' + px(s0.x).toFixed(1) + '" y="' + (py(s0.z) - 8).toFixed(1) + '" class="csm-tx">START</text>';
    for (var c = 0; c < 4; c++) {
      s += '<rect x="' + (px(s1.x) - 6 + (c % 2) * 6).toFixed(1) + '" y="' + (py(s1.z) - 3 + Math.floor(c / 2) * 3).toFixed(1) +
        '" width="6" height="3" fill="' + (c % 3 === 0 ? "#fff" : "#1A1A1A") + '"/>';
    }
    s += '<text x="' + px(s1.x).toFixed(1) + '" y="' + (py(s1.z) + 14).toFixed(1) + '" class="csm-tx">FINISH</text>';
    return s;
  }

  function renderCourseSelect() {
    var def = CORE.TRACKS3[selTrack];
    var pv = trackPreview(selTrack);
    var mapEl = $("cs-map");
    if (mapEl) mapEl.innerHTML = courseMapSVG(selTrack);
    $("cs-name").textContent = def.name;
    var lv = $("cs-level");
    lv.textContent = def.levelLabel;
    lv.className = "track-pill track-pill--" + def.level;
    $("cs-len").textContent = def.length + " m · " + pv.drop + " m drop";
    $("cs-unique").textContent = def.unique || def.desc;
    $("cs-feats").innerHTML = (def.feats || []).map(function (f) {
      return "<li>" + f + "</li>";
    }).join("");
    var R = courseRatings(def);
    $("cs-stats").innerHTML = Object.keys(R).map(function (k) {
      return '<span class="cs-stat"><b>' + k + '</b><i>' + pips(R[k]) + "</i></span>";
    }).join("");
    var best = bests[selTrack];
    $("cs-best").innerHTML = best
      ? "Your best <strong>" + fmtTime(best) + "</strong>"
      : "<em>Not ridden yet — set a time!</em>";
  }

  /* persist defaults to true; a live race passes false, because the mountain is
     the host's choice for that race and not a change to this rider's own game */
  function selectTrack(id, persist) {
    if (!CORE.TRACKS3[id] || id === selTrack) return;
    selTrack = id;
    if (persist !== false) lsSet("zr3_seltrack", selTrack);
    snapAllViews();
    refreshMenu();
    if (clubOn && !clubGhosts[selTrack]) fetchClubGhosts(selTrack);
  }

  function refreshMenu() {
    var html = "";
    CORE.TRACK3_ORDER.forEach(function (id) {
      var t = CORE.TRACKS3[id];
      html +=
        '<button type="button" class="track-card' + (id === selTrack ? " is-selected" : "") + '" data-track="' + id + '" aria-pressed="' + (id === selTrack) + '">' +
        '<span class="track-card__name">' + t.name + "</span>" +
        '<span class="track-card__best">' + (bests[id] ? fmtTime(bests[id]) : "— · —") + "</span>" +
        "</button>";
    });
    el.trackCards.innerHTML = html;
    renderCourseSelect();
    el.riderName.value = profile.name;
    var mb = $("menu-bike");
    if (mb && BIKES) {
      var mcfg = currentBikeCfg();
      var mstats = BIKES.computeStats(mcfg);
      mb.innerHTML = "🚲 Your bike: <strong>" + BIKES.riderNameForBike(mcfg) + "</strong> · " +
        mstats.weightKg.toFixed(1) + ' kg · <a href="garage.html" style="color:var(--sun-soft)">tune it in the Garage 🔧</a>';
    }
    el.ghostToggle.checked = !!ghostsOn;
    el.btnSound.textContent = muted ? "🔇 Sound off" : "🔊 Sound on";
    el.btnSound.setAttribute("aria-pressed", muted ? "false" : "true");
    if (el.btnDetail) el.btnDetail.textContent = lightMode ? "✨ Detail: light" : "✨ Detail: full";
    document.querySelectorAll(".jersey:not(.jersey2)").forEach(function (b) {
      b.classList.toggle("is-selected", b.getAttribute("data-jersey") === profile.jersey);
    });
    snapAllViews();
  }

  el.trackCards.addEventListener("click", function (e) {
    var btn = e.target.closest("[data-track]");
    if (!btn) return;
    selectTrack(btn.getAttribute("data-track"));
  });

  /* time-of-day chips */
  function refreshTodChips() {
    document.querySelectorAll("[data-tod]").forEach(function (c) {
      c.classList.toggle("is-selected", c.getAttribute("data-tod") === todSel);
    });
    document.querySelectorAll("[data-wx]").forEach(function (c) {
      c.classList.toggle("is-selected", c.getAttribute("data-wx") === wxSel);
    });
  }
  refreshTodChips();
  var todRow = $("tod-row");
  if (todRow) todRow.addEventListener("click", function (e) {
    var chip = e.target.closest("[data-tod]");
    if (!chip) return;
    todSel = chip.getAttribute("data-tod");
    if (TOD_ORDER.indexOf(todSel) < 0) todSel = "auto";
    lsSet("zr3_tod", todSel);
    refreshTodChips();
    snapAllViews();   /* menu attract loop rebuilds against the relit scene */
  });

  /* weather chips */
  var wxRow = $("wx-row");
  if (wxRow) wxRow.addEventListener("click", function (e) {
    var chip = e.target.closest("[data-wx]");
    if (!chip) return;
    wxSel = chip.getAttribute("data-wx");
    if (!WX_MODES[wxSel]) wxSel = "clear";
    lsSet("zr3_wx", wxSel);
    refreshTodChips();
    refreshMenu();
    snapAllViews();
  });

  document.querySelectorAll(".jersey:not(.jersey2)").forEach(function (b) {
    b.addEventListener("click", function () {
      profile.jersey = b.getAttribute("data-jersey");
      lsSet("zr_profile", profile);
      refreshMenu();
    });
  });

  el.riderName.addEventListener("change", function () {
    profile.name = CORE.sanitizeName(el.riderName.value);
    el.riderName.value = profile.name;
    lsSet("zr_profile", profile);
  });

  el.ghostToggle.addEventListener("change", function () {
    ghostsOn = el.ghostToggle.checked;
    lsSet("zr3_ghoston", ghostsOn);
  });

  $("btn-sound").addEventListener("click", function () {
    muted = !muted;
    lsSet("zr3_muted", muted);
    if (muted) { stopRumble(); stopRain(); }
    refreshMenu();
  });

  if (el.btnDetail) el.btnDetail.addEventListener("click", function () {
    lightMode = !lightMode;
    lsSet("zr3_light", lightMode);
    /* rebuild scenes + renderer quality with the new detail level */
    Object.keys(sceneCache).forEach(disposeScene);
    renderer.setPixelRatio(lightMode ? 1 : Math.min(window.devicePixelRatio || 1, 1.6));
    renderer.shadowMap.enabled = !lightMode;
    initComposer();
    refreshMenu();
  });

  $("btn-start").addEventListener("click", function () {
    profile.name = CORE.sanitizeName(el.riderName.value);
    lsSet("zr_profile", profile);
    audio();
    startRace();
  });
  $("btn-howto").addEventListener("click", function () { el.howto.hidden = false; });
  $("btn-howto-back").addEventListener("click", function () { el.howto.hidden = true; });
  $("btn-resume").addEventListener("click", resumeGame);
  $("btn-restart").addEventListener("click", function () { startRace(); });
  $("btn-quit").addEventListener("click", quitToMenu);
  $("btn-retry").addEventListener("click", function () { startRace(); });
  (function () {
    var again = $("btn-vs-again"), back = $("btn-vs-menu");
    if (again) again.addEventListener("click", function () { startRace(); });
    if (back) back.addEventListener("click", quitToMenu);
  })();
  $("btn-menu").addEventListener("click", quitToMenu);

  /* ---------- ghost codes ---------- */

  $("btn-copy-ghost").addEventListener("click", function () {
    var g = lsGet("zr3_bestghost_" + selTrack, null);
    var btn = this;
    if (!validGhostShape(g)) { btn.textContent = "No best run yet!"; return; }
    var code = CORE.packGhost3({ name: CORE.sanitizeName(profile.name), track: selTrack, timeMs: g.timeMs, samples: g.samples });
    var done = function () {
      btn.textContent = "Copied! Send it to a friend 👻";
      setTimeout(function () { btn.textContent = "Copy my Ghost Code"; }, 2600);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(code).then(done, function () { fallbackCopy(code); done(); });
    } else { fallbackCopy(code); done(); }
  });

  function fallbackCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } catch (e) { /* ignore */ }
    document.body.removeChild(ta);
  }

  function refreshGhostList() {
    if (!el.ghostList) return;
    if (!friends.length) {
      el.ghostList.innerHTML = '<li style="justify-content:center;color:var(--ink-soft)">No friend ghosts yet — paste a code above!</li>';
      return;
    }
    var html = "";
    friends.forEach(function (f, i) {
      html += "<li><span>👻 " + f.name + " · " + CORE.TRACKS3[f.track].name + " · " + fmtTime(f.timeMs) + "</span>" +
        '<button type="button" data-del-ghost="' + i + '" aria-label="Remove ghost">remove</button></li>';
    });
    el.ghostList.innerHTML = html;
  }

  el.ghostList.addEventListener("click", function (e) {
    var b = e.target.closest("[data-del-ghost]");
    if (!b) return;
    friends.splice(Number(b.getAttribute("data-del-ghost")), 1);
    lsSet("zr3_friends", friends);
    refreshGhostList();
  });

  $("btn-import-ghost").addEventListener("click", function () {
    var g = CORE.unpackGhost3(el.ghostInput.value);
    if (!g) {
      el.ghostMsg.textContent = "Hmm, that code doesn't look right.";
      el.ghostMsg.style.color = "var(--flame)";
      return;
    }
    friends.push({ name: g.name, track: g.track, timeMs: g.timeMs, samples: g.samples });
    while (friends.length > 6) friends.shift();
    lsSet("zr3_friends", friends);
    el.ghostInput.value = "";
    el.ghostMsg.textContent = "Ghost saved! Pick " + CORE.TRACKS3[g.track].name + " and race " + g.name + " 👻";
    el.ghostMsg.style.color = "var(--forest-700)";
    refreshGhostList();
  });

  /* ---------- leaderboard ---------- */

  var lbTrack = selTrack;
  function refreshLeaderboard() {
    var tabs = "";
    CORE.TRACK3_ORDER.forEach(function (id) {
      tabs += '<button type="button" class="lb-tab' + (id === lbTrack ? " is-selected" : "") + '" data-lb="' + id + '">' + CORE.TRACKS3[id].name + "</button>";
    });
    el.lbTabs.innerHTML = tabs;
    var list = scores[lbTrack] || [];
    if (!list.length) {
      el.lbList.innerHTML = '<li class="lb-empty" style="grid-template-columns:1fr">No runs yet — be the first down the mountain!</li>';
      return;
    }
    var html = "";
    list.forEach(function (r, i) {
      var bikeTag = r.bike ? ' <span style="font-weight:600;color:var(--ink-soft);font-size:0.82em">· ' + CORE.sanitizeName(r.bike) + "</span>" : "";
      html += '<li><span class="lb-rank">' + (i + 1) + '.</span><span>' + CORE.sanitizeName(r.name) + bikeTag + '</span><span class="lb-time">' + fmtTime(r.timeMs) + "</span></li>";
    });
    el.lbList.innerHTML = html;
  }

  el.lbTabs.addEventListener("click", function (e) {
    var b = e.target.closest("[data-lb]");
    if (!b) return;
    lbTrack = b.getAttribute("data-lb");
    refreshLeaderboard();
    refreshClubBoard();
    if (clubOn && !clubGhosts[lbTrack]) fetchClubGhosts(lbTrack);
  });

  /* ---------- club server: shared leaderboard + club ghosts ----------
     When the site runs on its Node server (Railway), /api/health answers and
     the game turns on the club layer: new personal bests upload as Ghost
     Codes (re-validated server-side by this same engine), the club's fastest
     ghosts ride beside you, and the club board shows everyone's times.
     On static hosting nothing answers and all of this stays silently off. */

  var clubOn = false;
  var clubGhosts = {};   /* track id -> [{name, timeMs, samples}] fastest first */

  function refreshClubBoard() {
    var card = $("club-card");
    if (!card) return;
    card.hidden = !clubOn;
    if (!clubOn) return;
    var nameEl = $("club-track-name");
    if (nameEl) nameEl.textContent = CORE.TRACKS3[lbTrack].name;
    var listEl = $("club-list");
    var list = clubGhosts[lbTrack];
    if (!list) {
      listEl.innerHTML = '<li class="lb-empty" style="grid-template-columns:1fr">Fetching club times…</li>';
      return;
    }
    if (!list.length) {
      listEl.innerHTML = '<li class="lb-empty" style="grid-template-columns:1fr">Nobody has posted a time here yet — go set one!</li>';
      return;
    }
    var html = "";
    list.forEach(function (r, i) {
      html += '<li><span class="lb-rank">' + (i + 1) + '.</span><span>' + CORE.sanitizeName(r.name) +
        '</span><span class="lb-time">' + fmtTime(r.timeMs) + "</span></li>";
    });
    listEl.innerHTML = html;
  }

  function fetchClubGhosts(track) {
    if (!clubOn || !CORE.TRACKS3[track]) return;
    fetch("/api/ghosts?track=" + encodeURIComponent(track))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j || !Array.isArray(j.ghosts)) return;
        clubGhosts[track] = j.ghosts.map(function (row) {
          var g = CORE.unpackGhost3(row.code);
          return (g && g.track === track) ? { name: g.name, timeMs: g.timeMs, samples: g.samples } : null;
        }).filter(Boolean).slice(0, 10);
        refreshClubBoard();
      })
      .catch(function () { /* server went away — stay quiet */ });
  }

  function submitClubGhost(gName, timeMs, samples) {
    if (!clubOn || !gName) return;
    try {
      var code = CORE.packGhost3({ name: gName, track: selTrack, timeMs: timeMs, samples: samples });
      fetch("/api/ghosts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ track: selTrack, name: gName, timeMs: timeMs, code: code })
      }).then(function (r) { if (r.ok) fetchClubGhosts(selTrack); }).catch(function () {});
    } catch (e) { /* ignore */ }
  }

  if (window.fetch) {
    fetch("/api/health")
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (j && j.ok) {
          clubOn = true;
          refreshClubBoard();
          fetchClubGhosts(selTrack);
          if (lbTrack !== selTrack) fetchClubGhosts(lbTrack);
        }
      })
      .catch(function () { /* static hosting — no club layer */ });
  }

  /* ---------- main loop ---------- */

  /* Once the first rider is home the other gets this long to get there too,
     so a two-player race can never stall on a kid stuck in a river. */
  var CHASE_GRACE = 45;

  var DT = CORE.DT;
  var menuGhostRig = null;

  function loop(ts) {
    requestAnimationFrame(loop);
    var dt = Math.min(0.1, (ts - lastTs) / 1000 || 0.016);
    lastTs = ts;

    if (mode === "menu" || mode === "tour" || mode === "mp") {
      menuT += dt;
      var b = currentBundle();
      var dur = b.wc.armand.timeMs / 1000;
      var gt = menuT % (dur + 2.5);
      var gp = CORE.ghostPosAt3(b.wc.armand, Math.min(gt, dur));
      if (!menuGhostRig || menuGhostRig.sceneId !== selTrack + "|" + todSel + "|" + curWx().id) {
        if (menuGhostRig && menuGhostRig.rig.group.parent) menuGhostRig.rig.group.parent.remove(menuGhostRig.rig.group);
        var rig = buildRiderMesh(0x1F7A48);
        enableRigShadows(rig);
        rig.blob.visible = lightMode;
        b.sc.scene.add(rig.group);
        menuGhostRig = { rig: rig, sceneId: selTrack + "|" + todSel + "|" + curWx().id };
      }
      placeRig(menuGhostRig.rig, gp.x, gp.y, gp.z, gp.yaw, 0);
      menuGhostRig.rig.wheelF.rotation.x -= 14 * dt;
      menuGhostRig.rig.wheelB.rotation.x -= 14 * dt;
      updateCoins(b.sc, b.wc.world, null, menuT);
      animateScene(b.sc, menuT, dt, gp.x, gp.y, gp.z, [{ x: gp.x, z: gp.z }]);
      /* orbiting-ish chase cam for the attract loop */
      var st0 = { x: gp.x, y: gp.y, z: gp.z, yaw: gp.yaw, vx: 0, vz: 0, offTrail: false, onGround: true };
      updateCamera(views[0], st0, dt, b.wc.world);
      aimSun(b.sc, gp.x, gp.y, gp.z, 0);
      renderFrame(b.sc);
      return;
    }

    if (!run) return;
    var world = run.b.wc.world;
    var sc = run.b.sc;

    if (menuGhostRig && menuGhostRig.rig.group.parent) {
      menuGhostRig.rig.group.parent.remove(menuGhostRig.rig.group);
      menuGhostRig = null;
    }

    if (mode === "count") {
      /* A live countdown is read off the server's deadline every frame, not
         counted down locally: dt is clamped at 0.1s, so a device having a slow
         moment would otherwise drift behind and roll out late through no fault
         of the child holding it. */
      if (mpMode && NET && NET.room && NET.room.startAt) {
        run.countT = NET.clock.until(NET.room.startAt) / 1000;
      } else {
        run.countT -= dt;
      }
      var n = Math.ceil(run.countT);
      if (n !== run.lastBeep && n > 0) { run.lastBeep = n; SFX.count(false); }
      var cdTxt = run.countT > 0 ? String(Math.max(1, n)) : "GO!";
      el.countdown.textContent = cdTxt;
      if (el.countdown2) el.countdown2.textContent = cdTxt;
      if (run.countT <= -0.7) {
        el.countdown.hidden = true;
        if (el.countdown2) el.countdown2.hidden = true;
        el.hint.classList.add("is-fading");   /* linger, then melt away */
        mode = "race";
      } else if (run.countT <= 0 && run.lastBeep !== 0) {
        run.lastBeep = 0; SFX.count(true);
      }
      eachRider(function (r) {
        animatePlayer(r, dt);
        updateCamera(r.view, r.st, dt, world);
      });
      if (mpMode && NET) { NET.pushPos(run.st); mpAnimate(dt); mpBoard(world); }
      animateGhosts(0, dt);
      updateCoins(sc, world, run.taken, run.clock);
      animateScene(sc, run.clock, dt, run.st.x, run.st.y, run.st.z, riderSpots());
      updateHUD(world);
      renderFrame(sc);
      return;
    }

    if (mode === "race") {
      acc += dt;
      var ev = [];
      var steps = 0;
      /* One fixed-rate accumulator, both riders stepped inside it: they share a
         clock, a world and a coin field, and stepRider3 keeps all its state on
         the rider it is given, so two of them never tread on each other. */
      while (acc >= DT && steps < 5) {
        for (var ri = 0; ri < run.riders.length; ri++) {
          var rr = run.riders[ri];
          if (rr.st.finished) continue;
          var inp = rr.input;
          inp.turbo = turboTaps[rr.idx] > 0;
          if (inp.turbo) turboTaps[rr.idx]--;
          /* in the air the same keys mean tricks: pedal/brake flip, steer spins */
          var aloft = !rr.st.onGround;
          inp.flipF = aloft && inp.pedal;
          inp.flipB = aloft && inp.brake;
          inp.spinL = aloft && inp.left;
          inp.spinR = aloft && inp.right;
          ev.length = 0;
          CORE.stepRider3(rr.st, inp, world, ev, run.taken);
          handleEvents(ev, rr.st, rr.view, rr.idx);
          if (players() === 1 && !mpMode && rr.step % 6 === 0) {
            rr.recorder.push([Math.round(rr.st.x * 10), Math.round(rr.st.y * 10), Math.round(rr.st.z * 10), Math.round(rr.st.yaw * 100)]);
          }
          rr.step++;
          /* first past the arch takes the win; the other rides their leg out */
          if (rr.st.finished && !rr.place) {
            run.finishers++;
            rr.place = run.finishers;
            if (players() === 2) announceFinish(rr);
          }
        }
        run.step++;
        run.clock += DT;
        acc -= DT;
        steps++;
      }
      if (steps === 5) acc = 0;

      /* the flag falls on the stragglers when the grace period runs out */
      if (run.chaseT > 0 && !allRidersDone()) {
        run.chaseT -= dt;
        if (run.chaseT <= 0) {
          eachRider(function (r) {
            if (r.st.finished) return;
            r.st.finished = true;
            r.st.finishT = r.st.t;
            r.timedOut = true;
            run.finishers++;
            r.place = run.finishers;
          });
          toastAll("Flag's down! 🏁");
        }
      }

      /* a rider who is home watches whoever is still out there, rather than
         staring at their own parked bike for the rest of the grace period */
      var live = null;
      for (var li = 0; li < run.riders.length; li++) {
        if (!run.riders[li].st.finished) { live = run.riders[li]; break; }
      }
      eachRider(function (r) {
        animatePlayer(r, dt);
        updateCamera(r.view, (r.st.finished && live) ? live.st : r.st, dt, world);
      });
      if (mpMode && NET) {
        if (!run.st.finished) NET.pushPos(run.st);
        mpAnimate(dt);
        mpBoard(world);
      }
      var lead = live || run.riders[0];
      animateGhosts(run.clock, dt);
      updateCoins(sc, world, run.taken, run.clock);
      animateScene(sc, run.clock, dt, lead.st.x, lead.st.y, lead.st.z, riderSpots());
      updateDust(dt);
      updateHUD(world);
      renderFrame(sc);
      if (location.search.indexOf("dbg3d") !== -1) {
        window.__dbg = { sc: sc, camera: camera, renderer: renderer, world: world,
          st: run.st, riders: run.riders, views: views, THREE: THREE };
      }

      if (allRidersDone()) {
        run.endT += dt;
        if (run.endT > 1.4) finishRace();
      }
      return;
    }

    if (mode === "pause" || mode === "results") {
      renderFrame(sc);
    }
  }

  /* ---------- boot ---------- */

  refreshMenu();
  refreshGhostList();
  refreshLeaderboard();
  /* a saved two-up choice survives a reload — restored here, once everything
     the menu reads from actually exists */
  /* two children cannot share one set of thumb controls, so a touch-only
     device is not offered the two-up mode at all */
  if (isTouch && !(window.matchMedia && window.matchMedia("(pointer: fine)").matches)) {
    var chip2 = document.querySelector('[data-players="2"]');
    if (chip2) chip2.hidden = true;
  } else if (lsGet("zr3_players", 1) === 2) {
    setPlayers(2);
  }
  requestAnimationFrame(loop);
})();
