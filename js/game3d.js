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

  function fmtTime(ms) {
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
    count: function (hi) { tone(hi ? 880 : 440, 0.14, "square"); },
    finish: function () { [523, 659, 784, 1047].forEach(function (f, i) { tone(f, 0.16, "triangle", i * 0.12); }); }
  };

  /* ---------- input ---------- */

  var input = { pedal: false, brake: false, left: false, right: false, hop: false };
  var KEYMAP = {
    ArrowUp: "pedal", KeyW: "pedal",
    ArrowDown: "brake", KeyS: "brake",
    ArrowLeft: "left", KeyA: "left",
    ArrowRight: "right", KeyD: "right",
    Space: "hop"
  };

  function clearInput() {
    input.pedal = input.brake = input.left = input.right = input.hop = false;
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
    if (e.code === "KeyB" && mode === "race" && run && run.hasBell) { SFX.bell(); return; }
    if (e.code === "KeyP" || e.code === "Escape") {
      if (mode === "race" || mode === "count") { pauseGame(); e.preventDefault(); }
      else if (mode === "pause") { resumeGame(); e.preventDefault(); }
      return;
    }
    var k = KEYMAP[e.code];
    if (k) {
      if (mode === "race" || mode === "count") e.preventDefault();
      input[k] = true;
    }
  });
  document.addEventListener("keyup", function (e) {
    var k = KEYMAP[e.code];
    if (k) input[k] = false;
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

  var isTouch = window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
  var reducedMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

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
    fsBtn: $("btn-fs"), hint: $("controls-hint"), hintKeys: $("hint-keys"), hintTouch: $("hint-touch")
  };

  function toast(txt) {
    el.toast.textContent = txt;
    el.toast.classList.remove("pop");
    void el.toast.offsetWidth;
    el.toast.classList.add("pop");
  }

  /* ====================================================================
     THREE setup
     ==================================================================== */

  var viewW = 960, viewH = 540;
  var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: !lightMode });
  renderer.setSize(viewW, viewH, false);
  renderer.setPixelRatio(lightMode ? 1 : Math.min(window.devicePixelRatio || 1, 1.6));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;
  renderer.shadowMap.enabled = !lightMode;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  var camera = new THREE.PerspectiveCamera(68, viewW / viewH, 0.1, 4200);

  /* ---------- post-processing (full detail only): bloom + FXAA ---------- */

  var composer = null, cRenderPass = null;
  function initComposer() {
    if (composer) { composer.dispose(); composer = null; }
    if (lightMode) return;
    var pr = Math.min(window.devicePixelRatio || 1, 1.6);
    composer = new EffectComposer(renderer);
    composer.setPixelRatio(pr);
    composer.setSize(viewW, viewH);
    cRenderPass = new RenderPass(new THREE.Scene(), camera);
    composer.addPass(cRenderPass);
    composer.addPass(new UnrealBloomPass(new THREE.Vector2(viewW, viewH), 0.14, 0.45, 1.0));
    composer.addPass(new OutputPass());
    var fxaa = new FXAAPass();
    fxaa.setSize(viewW * pr, viewH * pr);
    composer.addPass(fxaa);
  }
  initComposer();

  /* ---------- fullscreen: the stage takes the whole display ---------- */

  var stageEl = document.getElementById("game-stage");
  function setRenderSize(w, h) {
    viewW = w; viewH = h;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    initComposer();
  }
  function toggleFullscreen() {
    if (document.fullscreenElement) {
      if (document.exitFullscreen) document.exitFullscreen();
    } else if (stageEl.requestFullscreen) {
      stageEl.requestFullscreen();
    }
  }
  function syncRenderSize() {
    if (document.fullscreenElement === stageEl) {
      /* cap the buffer so weak GPUs keep their frame rate on huge screens */
      var s = Math.min(1, 1920 / window.innerWidth);
      setRenderSize(Math.round(window.innerWidth * s), Math.round(window.innerHeight * s));
    } else if (viewW !== 960) {
      setRenderSize(960, 540);
    }
  }
  if (el.fsBtn && stageEl && stageEl.requestFullscreen && document.fullscreenEnabled !== false) {
    el.fsBtn.hidden = false;
    el.fsBtn.addEventListener("click", toggleFullscreen);
    document.addEventListener("fullscreenchange", function () {
      syncRenderSize();
      el.fsBtn.textContent = document.fullscreenElement ? "🗗" : "⛶";
      el.fsBtn.title = document.fullscreenElement ? "Exit full screen (F)" : "Full screen (F)";
    });
    window.addEventListener("resize", function () {
      if (document.fullscreenElement === stageEl) syncRenderSize();
    });
  }

  /* optional photo-scanned textures from assets/world — every load fails
     silently back to the procedural look, so static hosting keeps working */
  var worldTexLoader = new THREE.TextureLoader();
  function loadWorldTex(url, srgb, done) {
    worldTexLoader.load(url, function (t) {
      if (srgb) t.colorSpace = THREE.SRGBColorSpace;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      done(t);
    }, undefined, function () { /* asset absent — procedural stays */ });
  }

  function renderFrame(sc) {
    renderer.toneMappingExposure = sc.exposure;
    if (composer) {
      cRenderPass.scene = sc.scene;
      cRenderPass.camera = camera;
      composer.render();
    } else {
      renderer.render(sc.scene, camera);
    }
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
  var sunTex = radialSprite("rgba(255,250,225,1)", "rgba(255,250,225,0)", 256);

  /* ---------- procedural textures (no external assets) ---------- */

  function canvasTexture(w, h, draw, wrap) {
    var c = document.createElement("canvas");
    c.width = w; c.height = h;
    draw(c.getContext("2d"), w, h);
    var tx = new THREE.CanvasTexture(c);
    tx.colorSpace = THREE.SRGBColorSpace;
    if (wrap) { tx.wrapS = THREE.RepeatWrapping; tx.wrapT = THREE.RepeatWrapping; }
    return tx;
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

  function todTheme(T) {
    if (todSel === "auto") return T;
    var d = Object.assign({}, T);
    if (todSel === "dawn") {
      d.sunPos = [-190, 48, -240];
      d.sun = 0xFFE2C0; d.ambient = 0xB8B2C4;
      d.turbidity = 4.5; d.rayleigh = 1.9; d.mieCoeff = 0.005; d.mieG = 0.8;
      d.exposure = (T.exposure || 0.6) * 0.98;
      d.fog = 0xE8DCE4; d.sky = 0xA8B8E0; d.skyLow = 0xF5C9A8;
      d.cloudTint = 0xF2D8CC; d.ridgeDim = 0.25;
    } else if (todSel === "day") {
      d.sunPos = [40, 330, -180];
      d.sun = 0xFFFDF4; d.ambient = 0xC2CCB8;
      d.turbidity = 2.6; d.rayleigh = 1.1; d.mieCoeff = 0.0025; d.mieG = 0.76;
      d.exposure = (T.exposure || 0.6) * 1.08;
      d.fog = 0xE2EEE8; d.sky = 0x8EC8EE; d.skyLow = 0xEAF4F0;
      d.cloudTint = 0xFFFFFF; d.ridgeDim = 0.05;
    } else if (todSel === "sunset") {
      d.sunPos = [-200, 52, -250];
      d.sun = 0xFFC384; d.ambient = 0xC0A088;
      d.turbidity = 7.5; d.rayleigh = 2.9; d.mieCoeff = 0.008; d.mieG = 0.84;
      d.exposure = (T.exposure || 0.6) * 0.9;
      d.fog = 0xE8C8A0; d.sky = 0xE8A868; d.skyLow = 0xFFDCA8;
      d.cloudTint = 0xF5C098; d.ridgeDim = 0.4;
    } else if (todSel === "dusk") {
      d.sunPos = [-170, 30, -230];
      d.sun = 0xE0A87A; d.ambient = 0x9AA4C0;
      d.turbidity = 4.5; d.rayleigh = 3.6; d.mieCoeff = 0.005; d.mieG = 0.8;
      d.exposure = (T.exposure || 0.6) * 0.78;
      d.fog = 0x9AA4BC; d.sky = 0x3A4A74; d.skyLow = 0xB88C88;
      d.cloudTint = 0x707A90; d.ridgeDim = 0.55;
    }
    return d;
  }

  function buildScene(id) {
    var key = id + "|" + todSel;
    if (sceneCache[key]) return sceneCache[key];
    /* keep at most one other scene alive */
    Object.keys(sceneCache).forEach(function (k) { if (k !== key) disposeScene(k); });

    var wc = getWorld(id);
    var world = wc.world;
    var T = todTheme(world.def.theme);
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

    /* physical-sky exposure is low, so lights compensate to keep the ground lit */
    var lightBoost = lightMode ? 1 : Math.min(2.4, 1.05 / exposure);
    scene.add(new THREE.HemisphereLight(T.sky, T.hemiGround || T.dirtDark, (T.hemiI || 0.95) * lightBoost));
    var sun = new THREE.DirectionalLight(T.sun, (T.sunI || 1.35) * lightBoost);
    sun.position.set(T.sunPos[0], T.sunPos[1], T.sunPos[2]);
    scene.add(sun);
    scene.add(sun.target);
    if (!lightMode) {
      sun.castShadow = true;
      sun.shadow.mapSize.set(2048, 2048);
      sun.shadow.camera.left = -60; sun.shadow.camera.right = 60;
      sun.shadow.camera.top = 60; sun.shadow.camera.bottom = -60;
      sun.shadow.camera.near = 20; sun.shadow.camera.far = 520;
      sun.shadow.bias = -0.0004;
      sun.shadow.normalBias = 1.2;
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

    /* wildlife: little primitive sculptures */
    var crocs = [];
    world.props.forEach(function (p) {
      var g2 = null;
      if (p.type === "elephant") g2 = buildElephant();
      else if (p.type === "giraffe") g2 = buildGiraffe();
      else if (p.type === "zebra") g2 = buildZebra();
      else if (p.type === "antelope") g2 = buildAntelope();
      else if (p.type === "croc") { g2 = buildCroc(); crocs.push(g2); }
      else if (p.type === "hippo") g2 = buildHippo(p.r > 0);
      if (g2) {
        g2.scale.setScalar((p.s || 1) * (p.type === "croc" ? 1.25 : 1));
        g2.position.set(p.x, p.y, p.z);
        g2.rotation.y = p.rot;
        if (!lightMode) g2.traverse(function (o) { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
        scene.add(g2);
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
    var poleG = new THREE.CylinderGeometry(0.07, 0.07, 2.6, 6);
    var poleM = lam(0x0C2E1C);
    var flagM = lam(T.accent);
    world.gates.forEach(function (gi) {
      var p = world.trail[gi];
      var q = world.trail[Math.min(world.trailN - 1, gi + 1)];
      var yaw = Math.atan2(q.x - p.x, q.z - p.z);
      var side = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
      [-1, 1].forEach(function (s) {
        var pole = new THREE.Mesh(poleG, poleM);
        pole.position.set(p.x + side.x * 4 * s, CORE.heightAt(world, p.x + side.x * 4 * s, p.z + side.z * 4 * s) + 1.3, p.z + side.z * 4 * s);
        scene.add(pole);
        var flag = new THREE.Mesh(new THREE.ConeGeometry(0.28, 0.7, 4), flagM);
        flag.position.copy(pole.position).add(new THREE.Vector3(0, 1.55, 0));
        scene.add(flag);
      });
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
      var streamN = lightMode ? 1 : 3;
      for (var si = 0; si < streamN; si++) {
        var bn = lightMode ? 320 : 720;
        var bp = new Float32Array(bn * 3);
        for (var bi2 = 0; bi2 < bn; bi2++) {
          var bz2 = Math.random() * (zSpan + 400) - 150;
          var bx2 = Math.sin(bz2 * 0.004 + si * 2.1) * 70 + (Math.random() - 0.5) * (70 + si * 34);
          var by2 = -bz2 * world.def.slope + 46 + si * 18 + Math.random() * 30;
          bp[bi2 * 3] = bx2; bp[bi2 * 3 + 1] = by2; bp[bi2 * 3 + 2] = bz2;
        }
        var bGeo = new THREE.BufferGeometry();
        bGeo.setAttribute("position", new THREE.BufferAttribute(bp, 3));
        var bPts = new THREE.Points(bGeo, new THREE.PointsMaterial({
          map: batTex, size: 3.4 + si * 0.9, transparent: true, depthWrite: false,
          color: 0xFFFFFF, alphaTest: 0.25
        }));
        scene.add(bPts);
        batStreams.push(bPts);
      }
    }
    if (T.groundMist) {
      for (var gm = 0; gm < 10; gm++) {
        var gmi = Math.min(world.trailN - 1, Math.floor(world.trailN * (0.06 + gm * 0.1)));
        var gmp = world.trail[gmi];
        var gmSp = new THREE.Sprite(new THREE.SpriteMaterial({
          map: mistTex, transparent: true, opacity: 0.3, depthWrite: false
        }));
        gmSp.scale.set(130 + (gm % 3) * 30, 18 + (gm % 2) * 7, 1);
        gmSp.position.set(gmp.x + ((gm % 2) ? -22 : 18), gmp.y + 5, gmp.z);
        scene.add(gmSp);
        clouds.push(gmSp);
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
      var basaltM = new THREE.MeshStandardMaterial({ color: 0x3E4440, roughness: 0.97 });
      var curtainM = new THREE.MeshBasicMaterial({
        map: waterTexA, transparent: true, opacity: 0.96, color: 0xEAF9F6,
        depthWrite: false, side: THREE.DoubleSide
      });
      var shimmerM = new THREE.MeshBasicMaterial({
        map: waterTexB, transparent: true, opacity: 0.5, color: 0xFFFFFF,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide
      });
      var lipM = new THREE.MeshBasicMaterial({ color: 0xDFF3EE, transparent: true, opacity: 0.9, depthWrite: false });
      var floorM = new THREE.MeshPhongMaterial({
        color: 0x16342E, shininess: 90, specular: 0x88BCB0, transparent: true, opacity: 0.94
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

    var cached = {
      scene: scene, coinMesh: coinMesh, clouds: clouds, wf: wf,
      dome: dome, sky: skyObj, ridges: [ridgeFar, ridgeNear], sunSp: sunSp, sun: sun, sunDir: sunDir,
      birds: birds, exposure: exposure, swayMats: sceneLeafMats.slice(),
      crocs: crocs, riverTex: riverTex, batStreams: batStreams
    };
    sceneCache[key] = cached;
    return cached;
  }

  /* wildlife builders */
  function buildElephant() {
    var m = lam(0x7A7168), g = new THREE.Group();
    var body = new THREE.Mesh(new THREE.SphereGeometry(1.5, 9, 7).scale(1.25, 1, 0.85), m);
    body.position.y = 2.0;
    var head = new THREE.Mesh(new THREE.SphereGeometry(0.85, 8, 6), m);
    head.position.set(0, 2.5, 1.55);
    var trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.24, 1.7, 6), m);
    trunk.position.set(0, 1.6, 2.1);
    trunk.rotation.x = 0.35;
    var earG = new THREE.SphereGeometry(0.55, 6, 5).scale(0.2, 1, 0.8);
    var earL = new THREE.Mesh(earG, m); earL.position.set(-0.85, 2.65, 1.35);
    var earR = new THREE.Mesh(earG, m); earR.position.set(0.85, 2.65, 1.35);
    g.add(body, head, trunk, earL, earR);
    [[-0.7, 0.55], [0.7, 0.55], [-0.7, -0.7], [0.7, -0.7]].forEach(function (l) {
      var leg = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.3, 1.5, 6), m);
      leg.position.set(l[0], 0.75, l[1]);
      g.add(leg);
    });
    return g;
  }
  function buildGiraffe() {
    var m = lam(0xC9973F), g = new THREE.Group();
    var body = new THREE.Mesh(new THREE.SphereGeometry(0.95, 8, 6).scale(1.35, 0.9, 0.7), m);
    body.position.y = 2.2;
    var neck = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.26, 2.6, 6), m);
    neck.position.set(0, 3.6, 0.9);
    neck.rotation.x = -0.35;
    var head = new THREE.Mesh(new THREE.SphereGeometry(0.32, 7, 5).scale(1, 0.8, 1.4), m);
    head.position.set(0, 4.85, 1.4);
    g.add(body, neck, head);
    [[-0.5, 0.55], [0.5, 0.55], [-0.5, -0.55], [0.5, -0.55]].forEach(function (l) {
      var leg = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.13, 2.2, 5), m);
      leg.position.set(l[0], 1.1, l[1]);
      g.add(leg);
    });
    return g;
  }
  function buildZebra() {
    var m = lam(0xE8E2D4), dm = lam(0x3A342C), g = new THREE.Group();
    var body = new THREE.Mesh(new THREE.SphereGeometry(0.8, 8, 6).scale(1.4, 0.85, 0.65), m);
    body.position.y = 1.35;
    var neck = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.24, 1.0, 6), m);
    neck.position.set(0, 1.95, 0.85);
    neck.rotation.x = -0.5;
    var head = new THREE.Mesh(new THREE.SphereGeometry(0.24, 7, 5).scale(1, 0.8, 1.5), m);
    head.position.set(0, 2.35, 1.15);
    g.add(body, neck, head);
    for (var i = 0; i < 4; i++) {
      var ring = new THREE.Mesh(new THREE.TorusGeometry(0.62 - Math.abs(i - 1.5) * 0.07, 0.05, 5, 10), dm);
      ring.rotation.y = Math.PI / 2;
      ring.position.set(-0.6 + i * 0.42, 1.35, 0);
      g.add(ring);
    }
    [[-0.45, 0.4], [0.45, 0.4], [-0.45, -0.4], [0.45, -0.4]].forEach(function (l) {
      var leg = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.1, 1.35, 5), m);
      leg.position.set(l[0], 0.68, l[1]);
      g.add(leg);
    });
    return g;
  }
  function buildAntelope() {
    var m = lam(0x9A6B3F), g = new THREE.Group();
    var body = new THREE.Mesh(new THREE.SphereGeometry(0.6, 8, 6).scale(1.35, 0.8, 0.6), m);
    body.position.y = 1.05;
    var neck = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.16, 0.8, 5), m);
    neck.position.set(0, 1.5, 0.62);
    neck.rotation.x = -0.4;
    var head = new THREE.Mesh(new THREE.SphereGeometry(0.17, 6, 5).scale(1, 0.8, 1.4), m);
    head.position.set(0, 1.85, 0.85);
    g.add(body, neck, head);
    for (var i = 0; i < 2; i++) {
      var horn = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.045, 0.7, 4), lam(0x4A3A28));
      horn.position.set(i === 0 ? -0.08 : 0.08, 2.2, 0.75);
      horn.rotation.x = -0.3;
      horn.rotation.z = i === 0 ? 0.25 : -0.25;
      g.add(horn);
    }
    [[-0.32, 0.32], [0.32, 0.32], [-0.32, -0.32], [0.32, -0.32]].forEach(function (l) {
      var leg = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 1.05, 4), m);
      leg.position.set(l[0], 0.5, l[1]);
      g.add(leg);
    });
    return g;
  }

  function buildCroc() {
    /* khaki back + near-black scutes + cream jaw: reads as "croc!" from 40 m
       out on green ground, which the kids need to dodge it in time */
    var olive = lam(0x767B3B), oliveD = lam(0x2E351A), teeth = lam(0xF2EBD8);
    var g = new THREE.Group();
    /* body + ridged tail */
    var body = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 8), olive);
    body.scale.set(0.44, 0.26, 1.05);
    body.position.set(0, 0.26, -0.2);
    g.add(body);
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
    var grey = lam(0x6E5A64), greyD = lam(0x59464F);
    var g = new THREE.Group();
    var back = new THREE.Mesh(new THREE.SphereGeometry(1.3, 10, 8), grey);
    back.scale.set(0.85, land ? 0.62 : 0.5, 1.15);
    back.position.set(0, land ? 0.62 : -0.25, -0.4);
    g.add(back);
    if (land) {
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
  function initDust(scene) {
    dustPool.forEach(function (d) { if (d.sp.parent) d.sp.parent.remove(d.sp); });
    dustPool = [];
    for (var i = 0; i < 26; i++) {
      var sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: dustTex, transparent: true, depthWrite: false, opacity: 0 }));
      sp.scale.set(0.9, 0.9, 1);
      scene.add(sp);
      dustPool.push({ sp: sp, life: 0, vx: 0, vy: 0, vz: 0 });
    }
  }
  var dustIdx = 0;
  function spawnDust(x, y, z, n) {
    for (var i = 0; i < n; i++) {
      var d = dustPool[dustIdx++ % dustPool.length];
      d.life = 0.55;
      d.sp.position.set(x + (Math.random() - 0.5) * 0.8, y + 0.15, z + (Math.random() - 0.5) * 0.8);
      d.vx = (Math.random() - 0.5) * 2.2;
      d.vy = 1 + Math.random() * 1.6;
      d.vz = (Math.random() - 0.5) * 2.2;
    }
  }
  function updateDust(dt) {
    dustPool.forEach(function (d) {
      if (d.life <= 0) { d.sp.material.opacity = 0; return; }
      d.life -= dt;
      d.sp.position.x += d.vx * dt;
      d.sp.position.y += d.vy * dt;
      d.sp.position.z += d.vz * dt;
      d.sp.material.opacity = Math.max(0, d.life * 1.4);
      var s = 0.9 + (0.55 - d.life) * 2.2;
      d.sp.scale.set(s, s, 1);
    });
  }

  /* ====================================================================
     game controller
     ==================================================================== */

  var mode = "menu";
  var selTrack = lsGet("zr3_seltrack", "miombo");
  if (!CORE.TRACKS3[selTrack]) selTrack = "miombo";
  var run = null;
  var menuT = 0;
  var lastTs = 0;
  var acc = 0;
  var shakeT = 0;
  var playerRig = null;
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
    if (playerRig && playerRig.group.parent) playerRig.group.parent.remove(playerRig.group);
    playerRig = buildRiderMesh(new THREE.Color(profile.jersey || "#1F7A48").getHex(), currentBikeCfg());
    enableRigShadows(playerRig);
    scene.add(playerRig.group);
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
      var nearCam = dcx * dcx + dcy * dcy + dcz * dcz < 9;
      coinDummy.scale.copy((taken && taken[i]) || nearCam ? s0 : s1);
      coinDummy.updateMatrix();
      sc.coinMesh.setMatrixAt(i, coinDummy.matrix);
    }
    sc.coinMesh.instanceMatrix.needsUpdate = true;
  }

  /* ---------- race lifecycle ---------- */

  function startRace() {
    var b = currentBundle();
    var world = b.wc.world;
    var st = CORE.newRider3(world);
    var bikeCfg = currentBikeCfg();
    var bikeStats = bikeCfg && BIKES ? BIKES.computeStats(bikeCfg) : null;
    if (bikeStats) st.stats = bikeStats;
    /* dev spawn point, e.g. game.html#at=0.9 — handy for testing the finish */
    var devAt = /^#at=(0?\.[0-9]+)$/.exec(location.hash || "");
    var practice = !!devAt;
    if (devAt) {
      var gi = Math.max(2, Math.min(world.finishIdx - 4, Math.floor(world.finishIdx * parseFloat(devAt[1]))));
      var dp = world.trail[gi], dq = world.trail[gi + 1];
      st.x = dp.x; st.y = dp.y; st.z = dp.z;
      st.yaw = Math.atan2(dq.x - dp.x, dq.z - dp.z);
      st.trailIdx = gi; st.respawnIdx = gi;
      st.coinPtr = 0;
    }
    var ghosts = [];
    if (ghostsOn) {
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
    attachRigs(b.sc.scene, ghosts);
    initDust(b.sc.scene);
    var taken = new Array(world.coins.length);
    /* clear coins hovering on the spawn point so none sits on the rider */
    for (var ci2 = 0; ci2 < world.coins.length; ci2++) {
      var co2 = world.coins[ci2];
      var dxc = co2.x - st.x, dzc = co2.z - st.z;
      if (dxc * dxc + dzc * dzc < 16) taken[ci2] = 1;
    }
    run = {
      b: b, st: st, taken: taken,
      recorder: [], step: 0, ghosts: ghosts, countT: 2.7, endT: 0, lastBeep: 3,
      practice: practice,
      bikeName: bikeCfg && BIKES ? BIKES.riderNameForBike(bikeCfg) : "",
      hasBell: !!(bikeCfg && (bikeCfg.extras || []).indexOf("bell") >= 0)
    };
    clearInput();
    acc = 0;
    camSnap = true;
    mode = "count";
    el.menu.hidden = true; el.results.hidden = true; el.pause.hidden = true; el.howto.hidden = true;
    el.hud.hidden = false;
    el.countdown.hidden = false;
    el.touch.hidden = !isTouch;
    el.hintKeys.hidden = isTouch;
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
    el.pause.hidden = false;
    el.touch.hidden = true;
  }

  function resumeGame() {
    if (mode !== "pause") return;
    mode = run.pausedFrom || "race";
    el.pause.hidden = true;
    el.touch.hidden = !isTouch;
  }

  function quitToMenu() {
    mode = "menu";
    run = null;
    clearInput();
    stopRumble();
    el.pause.hidden = true; el.results.hidden = true; el.hud.hidden = true;
    el.countdown.hidden = true; el.touch.hidden = true; el.hint.hidden = true;
    el.menu.hidden = false;
    refreshMenu();
  }

  function finishRace() {
    var st = run.st;
    var wc = run.b.wc;
    var timeMs = Math.round(st.finishT * 1000);
    var name = CORE.sanitizeName(profile.name);

    var gold = Math.min(wc.armand.timeMs, wc.arthur.timeMs);
    var silver = Math.max(wc.armand.timeMs, wc.arthur.timeMs);
    var bronze = Math.round(silver * 1.35);
    var medal = timeMs <= gold ? "gold" : timeMs <= silver ? "silver" : timeMs <= bronze ? "bronze" : "none";

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
    if (!run.practice && BIKES) {
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
    var isBest = !run.practice && timeMs < prevBest;
    if (isBest) {
      bests[selTrack] = timeMs;
      lsSet("zr3_best", bests);
      lsSet("zr3_bestghost_" + selTrack, { timeMs: timeMs, samples: run.recorder });
      /* named riders share their new best with the club board; nameless riders stay local */
      if ((profile.name || "").trim()) submitClubGhost(name, timeMs, run.recorder);
    }

    if (!run.practice) {
      var list = scores[selTrack] || [];
      list.push({ name: name, timeMs: timeMs, score: st.score, bike: run.bikeName });
      list.sort(function (a, b2) { return a.timeMs - b2.timeMs; });
      scores[selTrack] = list.slice(0, 10);
      lsSet("zr3_scores", scores);
    }

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
      '<p class="results-note">Copy your Ghost Code below and hand it to a club friend — they can race you without any chat.</p>';

    mode = "results";
    el.results.hidden = false;
    el.hud.hidden = true;
    el.touch.hidden = true;
    stopRumble();
    SFX.finish();
    refreshLeaderboard();
  }

  /* ---------- event fx ---------- */

  var CRASH_MSG = {
    landing: "OUCH! 💥 Bend those knees on big drops!",
    croc: "CROC! 🐊 Give those teeth some space!",
    hippo: "HIPPO! 🦛 Two tonnes of do-not-touch!",
    elephant: "ELEPHANT! 🐘 Give the big fella room!",
    antelope: "PUKU! 🦌 Nearly a puku pancake!",
    miombo: "Tree! 🌳 Keep it on the trail!",
    baobab: "That baobab is 1000 years old — and solid! 💥",
    acacia: "Tree! 🌳 Keep it on the trail!",
    palm: "Tree! 🌴 Watch the line!",
    rock: "Rock! 🪨 Eyes up the trail!",
    termite: "Termite tower! 💥",
    elephant: "Whoa! Give animals space! 🐘",
    giraffe: "Whoa! Give animals space! 🦒",
    zebra: "Whoa! Give animals space! 🦓",
    antelope: "Whoa! Give animals space!"
  };

  function handleEvents(ev, st) {
    for (var i = 0; i < ev.length; i++) {
      var e = ev[i];
      if (e.t === "coin") SFX.coin();
      else if (e.t === "hop") SFX.hop();
      else if (e.t === "land") {
        spawnDust(st.x, st.y, st.z, e.q === "hard" ? 8 : 4);
        camDip = e.q === "hard" ? 0.55 : 0.25;
        if (e.q === "hard") { SFX.hard(); toast("Heavy landing!"); }
        else SFX.land();
      }
      else if (e.t === "bigair") { toast("BIG AIR! +75"); SFX.bigair(); }
      else if (e.t === "crash") {
        toast(CRASH_MSG[e.why] || CRASH_MSG.landing);
        SFX.crash();
        spawnDust(st.x, st.y, st.z, 14);
        if (!reducedMotion) shakeT = 0.5;
      }
      else if (e.t === "splash") {
        toast("SPLASH! 🐊 The Zambezi is NOT a shortcut!");
        SFX.splash();
        spawnDust(st.x, st.y + 0.5, st.z, 12);
      }
      else if (e.t === "gorge") {
        toast("THE GORGE! 🌊 Respect the Smoke that Thunders!");
        SFX.splash();
        if (!reducedMotion) shakeT = 0.4;
      }
      else if (e.t === "respawn") toast("Back on track! 🚵");
      else if (e.t === "gate") SFX.gate();
      else if (e.t === "reset") toast("Whoops — back to the trail!");
    }
  }

  /* ---------- camera ---------- */

  var camPos = new THREE.Vector3();
  var camLook = new THREE.Vector3();
  var camSnap = true;
  var camDip = 0;

  function updateCamera(st, dt, world) {
    var fwdX = Math.sin(st.yaw), fwdZ = Math.cos(st.yaw);
    var speed = Math.sqrt(st.vx * st.vx + st.vz * st.vz);
    var back = 6.2 + speed * 0.06;
    var tx = st.x - fwdX * back;
    var tz = st.z - fwdZ * back;
    var ty = st.y + 2.9;
    /* keep the camera above the terrain behind the rider */
    var gY = CORE.heightAt(world, tx, tz) + 1.1;
    if (ty < gY) ty = gY;

    if (camSnap) {
      camPos.set(tx, ty, tz);
      camSnap = false;
    } else {
      var k = Math.min(1, 5.5 * dt);
      camPos.x += (tx - camPos.x) * k;
      camPos.y += (ty - camPos.y) * Math.min(1, 4 * dt);
      camPos.z += (tz - camPos.z) * k;
    }
    var sx = 0, sy = 0;
    if (shakeT > 0) {
      shakeT -= dt;
      sx = (Math.random() - 0.5) * 0.3 * shakeT;
      sy = (Math.random() - 0.5) * 0.3 * shakeT;
    } else if (st.offTrail && st.onGround && speed > 6 && !reducedMotion) {
      sx = (Math.random() - 0.5) * 0.05;
      sy = (Math.random() - 0.5) * 0.05;
    }
    camDip *= Math.max(0, 1 - 6 * dt);
    camera.position.set(camPos.x + sx, camPos.y + sy - camDip, camPos.z);
    camLook.set(st.x + fwdX * 6, st.y + 1.1, st.z + fwdZ * 6);
    camera.lookAt(camLook);
    /* bank gently into the turns */
    if (st.lean) camera.rotateZ(-st.lean * 0.35);
    camera.fov = Math.min(84, 66 + speed * 0.5);
    camera.updateProjectionMatrix();
  }

  /* ---------- rig animation ---------- */

  function animatePlayer(st, dt) {
    var speed = Math.sqrt(st.vx * st.vx + st.vz * st.vz);
    placeRig(playerRig, st.x, st.y, st.z, st.yaw, st.lean);
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
    if (st.onGround && speed > 9 && Math.random() < 0.25) spawnDust(st.x, st.y, st.z, 1);
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
  function followEnvironment(sc, fx, fy, fz) {
    if (sc.dome) sc.dome.position.copy(camera.position);
    if (sc.sky) sc.sky.position.copy(camera.position);
    sc.ridges[0].position.set(camera.position.x, camera.position.y - 55, camera.position.z);
    sc.ridges[1].position.set(camera.position.x, camera.position.y - 55, camera.position.z);
    if (sc.sunSp) sc.sunSp.position.copy(camera.position).addScaledVector(sc.sunDir, 700);
    sc.sun.position.set(fx, fy, fz).addScaledVector(sc.sunDir, 220);
    sc.sun.target.position.set(fx, fy, fz);
  }

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

  function animateScene(sc, t, dt, riderX, riderY, riderZ) {
    for (var i = 0; i < sc.clouds.length; i++) {
      sc.clouds[i].position.x += Math.sin(i * 1.7) * 0.7 * dt;
    }
    /* bat rivers drift down the valley */
    for (i = 0; i < sc.batStreams.length; i++) {
      var bs = sc.batStreams[i];
      bs.position.z = ((t * (9 + i * 3)) % 420) - 210;
      bs.position.x = Math.sin(t * 0.08 + i * 1.7) * 9;
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

  function updateHUD(st, world) {
    var ms = Math.round((st.finished ? st.finishT : st.t) * 1000);
    el.time.textContent = fmtTime(ms);
    el.score.textContent = "🪙 " + st.score;
    var sp = Math.sqrt(st.vx * st.vx + st.vz * st.vz);
    el.speed.textContent = Math.round(sp * 3.6) + " km/h";
    var prog = Math.max(0, Math.min(1, st.trailIdx / world.finishIdx));
    el.progress.style.width = (prog * 100).toFixed(1) + "%";
  }

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

  function selectTrack(id) {
    if (!CORE.TRACKS3[id] || id === selTrack) return;
    selTrack = id;
    lsSet("zr3_seltrack", selTrack);
    camSnap = true;
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
    document.querySelectorAll(".jersey").forEach(function (b) {
      b.classList.toggle("is-selected", b.getAttribute("data-jersey") === profile.jersey);
    });
    camSnap = true;
  }

  el.trackCards.addEventListener("click", function (e) {
    var btn = e.target.closest("[data-track]");
    if (!btn) return;
    selectTrack(btn.getAttribute("data-track"));
  });

  /* time-of-day chips */
  function refreshTodChips() {
    document.querySelectorAll(".tod-chip").forEach(function (c) {
      c.classList.toggle("is-selected", c.getAttribute("data-tod") === todSel);
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
    camSnap = true;   /* menu attract loop rebuilds against the relit scene */
  });

  document.querySelectorAll(".jersey").forEach(function (b) {
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
    if (muted) stopRumble();
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

  var DT = CORE.DT;
  var menuGhostRig = null;

  function loop(ts) {
    requestAnimationFrame(loop);
    var dt = Math.min(0.1, (ts - lastTs) / 1000 || 0.016);
    lastTs = ts;

    if (mode === "menu") {
      menuT += dt;
      var b = currentBundle();
      var dur = b.wc.armand.timeMs / 1000;
      var gt = menuT % (dur + 2.5);
      var gp = CORE.ghostPosAt3(b.wc.armand, Math.min(gt, dur));
      if (!menuGhostRig || menuGhostRig.sceneId !== selTrack + "|" + todSel) {
        if (menuGhostRig && menuGhostRig.rig.group.parent) menuGhostRig.rig.group.parent.remove(menuGhostRig.rig.group);
        var rig = buildRiderMesh(0x1F7A48);
        enableRigShadows(rig);
        rig.blob.visible = lightMode;
        b.sc.scene.add(rig.group);
        menuGhostRig = { rig: rig, sceneId: selTrack + "|" + todSel };
      }
      placeRig(menuGhostRig.rig, gp.x, gp.y, gp.z, gp.yaw, 0);
      menuGhostRig.rig.wheelF.rotation.x -= 14 * dt;
      menuGhostRig.rig.wheelB.rotation.x -= 14 * dt;
      updateCoins(b.sc, b.wc.world, null, menuT);
      animateScene(b.sc, menuT, dt);
      /* orbiting-ish chase cam for the attract loop */
      var st0 = { x: gp.x, y: gp.y, z: gp.z, yaw: gp.yaw, vx: 0, vz: 0, offTrail: false, onGround: true };
      updateCamera(st0, dt, b.wc.world);
      followEnvironment(b.sc, gp.x, gp.y, gp.z);
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
      run.countT -= dt;
      var n = Math.ceil(run.countT);
      if (n !== run.lastBeep && n > 0) { run.lastBeep = n; SFX.count(false); }
      el.countdown.textContent = run.countT > 0 ? String(Math.max(1, n)) : "GO!";
      if (run.countT <= -0.7) {
        el.countdown.hidden = true;
        el.hint.classList.add("is-fading");   /* linger, then melt away */
        mode = "race";
      } else if (run.countT <= 0 && run.lastBeep !== 0) {
        run.lastBeep = 0; SFX.count(true);
      }
      animatePlayer(run.st, dt);
      animateGhosts(0, dt);
      updateCoins(sc, world, run.taken, run.st.t);
      animateScene(sc, run.st.t, dt, run.st.x, run.st.y, run.st.z);
      updateCamera(run.st, dt, world);
      followEnvironment(sc, run.st.x, run.st.y, run.st.z);
      updateHUD(run.st, world);
      renderFrame(sc);
      return;
    }

    if (mode === "race") {
      acc += dt;
      var ev = [];
      var steps = 0;
      while (acc >= DT && steps < 5) {
        ev.length = 0;
        CORE.stepRider3(run.st, input, world, ev, run.taken);
        handleEvents(ev, run.st);
        if (run.step % 6 === 0) {
          run.recorder.push([Math.round(run.st.x * 10), Math.round(run.st.y * 10), Math.round(run.st.z * 10), Math.round(run.st.yaw * 100)]);
        }
        run.step++;
        acc -= DT;
        steps++;
      }
      if (steps === 5) acc = 0;

      animatePlayer(run.st, dt);
      animateGhosts(run.st.t, dt);
      updateCoins(sc, world, run.taken, run.st.t);
      animateScene(sc, run.st.t, dt, run.st.x, run.st.y, run.st.z);
      updateDust(dt);
      updateCamera(run.st, dt, world);
      followEnvironment(sc, run.st.x, run.st.y, run.st.z);
      updateHUD(run.st, world);
      renderFrame(sc);
      if (location.search.indexOf("dbg3d") !== -1) window.__dbg = { sc: sc, camera: camera, renderer: renderer, world: world, st: run.st, THREE: THREE };

      if (run.st.finished) {
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
  requestAnimationFrame(loop);
})();
