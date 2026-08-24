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
    ghostList: $("ghost-list"), ghostInput: $("ghost-input"), ghostMsg: $("ghost-import-msg")
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

  var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: !lightMode });
  renderer.setSize(960, 540, false);
  renderer.setPixelRatio(lightMode ? 1 : Math.min(window.devicePixelRatio || 1, 1.6));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;
  renderer.shadowMap.enabled = !lightMode;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  var camera = new THREE.PerspectiveCamera(68, 16 / 9, 0.1, 4200);

  /* ---------- post-processing (full detail only): bloom + FXAA ---------- */

  var composer = null, cRenderPass = null;
  function initComposer() {
    if (composer) { composer.dispose(); composer = null; }
    if (lightMode) return;
    var pr = Math.min(window.devicePixelRatio || 1, 1.6);
    composer = new EffectComposer(renderer);
    composer.setPixelRatio(pr);
    composer.setSize(960, 540);
    cRenderPass = new RenderPass(new THREE.Scene(), camera);
    composer.addPass(cRenderPass);
    composer.addPass(new UnrealBloomPass(new THREE.Vector2(960, 540), 0.14, 0.45, 1.0));
    composer.addPass(new OutputPass());
    var fxaa = new FXAAPass();
    fxaa.setSize(960 * pr, 540 * pr);
    composer.addPass(fxaa);
  }
  initComposer();

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

  function disposeScene(id) {
    var sc = sceneCache[id];
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
    delete sceneCache[id];
  }

  function buildScene(id) {
    if (sceneCache[id]) return sceneCache[id];
    /* keep at most one other scene alive */
    Object.keys(sceneCache).forEach(function (k) { if (k !== id) disposeScene(k); });

    var wc = getWorld(id);
    var world = wc.world;
    var T = world.def.theme;
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
    var ridgeFar = buildRidge(640, 90, 120, fogC.clone().lerp(new THREE.Color(0x223322), 0.10), world.def.seed % 10);
    var ridgeNear = buildRidge(520, 90, 80, fogC.clone().lerp(new THREE.Color(0x1A2A1A), 0.22), (world.def.seed % 10) + 3);
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

    /* ---- instanced props ---- */
    var density = lightMode ? 0.55 : 1;
    var parts = {};  /* type -> array of {geo, mat, yOff, sMul} pieces */
    function piece(g2, m2, y2, s2) { return { geo: g2, mat: m2, y: y2 || 0, s: s2 || 1 }; }
    var trunkM = lam(T.trunk), canM = lam(T.canopy), can2M = lam(T.canopy2), rockM = lam(T.rock);
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
    world.props.forEach(function (p) {
      var g2 = null;
      if (p.type === "elephant") g2 = buildElephant();
      else if (p.type === "giraffe") g2 = buildGiraffe();
      else if (p.type === "zebra") g2 = buildZebra();
      else if (p.type === "antelope") g2 = buildAntelope();
      if (g2) {
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

    /* ---- bird flocks wheeling over the valley ---- */
    var birds = [];
    if (!lightMode) {
      var birdMat = lam(id === "baobab" ? 0x2E1A08 : 0xF4EFE4);
      for (var fi = 0; fi < 2; fi++) {
        var flock = { center: null, r: 24 + fi * 14, h: 0, speed: 0.28 + fi * 0.1, members: [] };
        var fz = zSpan * (0.28 + fi * 0.42);
        var fIdx = Math.min(world.trailN - 1, Math.floor(fz / 5));
        var fp = world.trail[fIdx];
        flock.center = new THREE.Vector3(fp.x + (fi ? -30 : 26), fp.y + 34 + fi * 12, fp.z);
        for (var bi = 0; bi < 5; bi++) {
          var bird = new THREE.Group();
          var wingG = new THREE.PlaneGeometry(0.95, 0.3);
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

    /* ---- Mosi Falls set piece: layered animated water, spray, shafts ---- */
    var wf = null;
    if (id === "falls") {
      wf = new THREE.Group();
      var mid = world.trail[Math.floor(world.trailN * 0.45)];
      var wfx = mid.x + 70, wfz = mid.z;
      var wallH = 64;

      /* wet cliff behind the water — wide and hazy so it reads as rock, not a slab */
      var cliff = new THREE.Mesh(new THREE.BoxGeometry(44, wallH + 14, 6),
        new THREE.MeshStandardMaterial({ color: 0x5A6156, roughness: 0.95 }));
      cliff.position.set(0, wallH / 2 - 10, -3.4);
      wf.add(cliff);
      /* river lip where the water goes over the edge */
      var lip = new THREE.Mesh(new THREE.PlaneGeometry(23, 7),
        new THREE.MeshBasicMaterial({ color: 0xDFF3EE, transparent: true, opacity: 0.9, depthWrite: false }));
      lip.rotation.x = -Math.PI / 2 + 0.12;
      lip.position.set(0, wallH - 6.2, -2.6);
      wf.add(lip);

      /* two scrolling water layers: solid + additive shimmer */
      var waterTexA = streakTex.clone(); waterTexA.needsUpdate = true;
      waterTexA.repeat.set(2, 2.4);
      var waterA = new THREE.Mesh(new THREE.PlaneGeometry(22, wallH),
        new THREE.MeshBasicMaterial({ map: waterTexA, transparent: true, opacity: 0.95, color: 0xEAF9F6, depthWrite: false }));
      waterA.position.set(0, wallH / 2 - 6, 0.2);
      wf.add(waterA);
      var waterTexB = streakTex.clone(); waterTexB.needsUpdate = true;
      waterTexB.repeat.set(3, 1.6);
      var waterB = new THREE.Mesh(new THREE.PlaneGeometry(22, wallH),
        new THREE.MeshBasicMaterial({ map: waterTexB, transparent: true, opacity: 0.55, color: 0xFFFFFF, blending: THREE.AdditiveBlending, depthWrite: false }));
      waterB.position.set(0, wallH / 2 - 6, 0.45);
      wf.add(waterB);
      wf.waterTexA = waterTexA; wf.waterTexB = waterTexB;

      /* plunge pool: real reflective water in full detail, flat disc in light */
      if (!lightMode) {
        var poolWater = new Water(new THREE.CircleGeometry(14, 26), {
          textureWidth: 256, textureHeight: 256,
          waterNormals: waterNormalTex,
          sunDirection: sunDir.clone(),
          sunColor: 0xffffff,
          waterColor: 0x18453C,
          distortionScale: 1.5,
          fog: true
        });
        poolWater.rotation.x = -Math.PI / 2;
        poolWater.position.set(0, -5.6, 4);
        wf.add(poolWater);
        wf.water = poolWater;
      } else {
        var pool = new THREE.Mesh(new THREE.CircleGeometry(13, 22),
          new THREE.MeshBasicMaterial({ color: 0xDFF3EE, transparent: true, opacity: 0.85, depthWrite: false }));
        pool.rotation.x = -Math.PI / 2;
        pool.position.set(0, -5.6, 4);
        wf.add(pool);
      }
      wf.rings = [];
      for (var qi = 0; qi < 3; qi++) {
        var ring = new THREE.Mesh(new THREE.RingGeometry(1, 1.4, 22),
          new THREE.MeshBasicMaterial({ color: 0xFFFFFF, transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide }));
        ring.rotation.x = -Math.PI / 2;
        ring.position.set(0, -5.5, 4);
        ring.userData.phase = qi / 3;
        wf.add(ring);
        wf.rings.push(ring);
      }

      /* rising spray particles */
      if (!lightMode) {
        var sprayN = 70;
        var sprayPos = new Float32Array(sprayN * 3);
        wf.sprayData = [];
        for (var pi = 0; pi < sprayN; pi++) {
          wf.sprayData.push({ a: Math.random() * 6.28, r: 2 + Math.random() * 9, v: 2 + Math.random() * 4, life: Math.random() });
        }
        var sprayGeo = new THREE.BufferGeometry();
        sprayGeo.setAttribute("position", new THREE.BufferAttribute(sprayPos, 3));
        var spray = new THREE.Points(sprayGeo, new THREE.PointsMaterial({
          map: mistTex, size: 3.6, transparent: true, opacity: 0.45, depthWrite: false
        }));
        wf.add(spray);
        wf.spray = spray;
      }

      /* drifting mist billboards */
      wf.mists = [];
      for (var mi = 0; mi < 6; mi++) {
        var m2 = new THREE.Sprite(new THREE.SpriteMaterial({ map: mistTex, transparent: true, opacity: 0.45, depthWrite: false }));
        m2.scale.set(30 + mi * 7, 14 + mi * 2.5, 1);
        m2.position.set(-8 + mi * 4, -3 + (mi % 2) * 4, 5 + mi);
        wf.add(m2);
        wf.mists.push(m2);
      }

      /* sun shafts through the mist */
      if (!lightMode) {
        for (var hi = 0; hi < 2; hi++) {
          var shaft = new THREE.Mesh(new THREE.PlaneGeometry(7 + hi * 4, 54),
            new THREE.MeshBasicMaterial({
              color: 0xFFF8E0, transparent: true, opacity: 0.10,
              blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false
            }));
          shaft.position.set(-6 + hi * 10, 16, 6 + hi * 2);
          shaft.rotation.z = 0.35;
          shaft.rotation.y = 0.4;
          wf.add(shaft);
        }
      }

      /* rainbow */
      var rcols = [0xE8791D, 0xF7B733, 0x2A9D8F];
      for (var ri = 0; ri < 3; ri++) {
        var arc = new THREE.Mesh(new THREE.TorusGeometry(17 - ri * 1.2, 0.4, 6, 26, Math.PI),
          new THREE.MeshBasicMaterial({ color: rcols[ri], transparent: true, opacity: 0.32, depthWrite: false }));
        arc.position.set(-4, -5, 9);
        wf.add(arc);
      }

      wf.position.set(wfx, CORE.heightAt(world, wfx, wfz), wfz);
      wf.rotation.y = -Math.PI / 2.3;
      wf.wallH = wallH;
      wf.worldPos = new THREE.Vector3(wfx, CORE.heightAt(world, wfx, wfz), wfz);
      scene.add(wf);
    }

    var cached = {
      scene: scene, coinMesh: coinMesh, clouds: clouds, wf: wf,
      dome: dome, sky: skyObj, ridges: [ridgeFar, ridgeNear], sunSp: sunSp, sun: sun, sunDir: sunDir,
      birds: birds, exposure: exposure, swayMats: sceneLeafMats.slice()
    };
    sceneCache[id] = cached;
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
    el.countdown.hidden = true; el.touch.hidden = true;
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
            Math.cos(sd.a) * sd.r,
            -5 + sd.life * sd.v * 4,
            4 + Math.sin(sd.a) * sd.r * 0.5);
        }
        pos.needsUpdate = true;
        sc.wf.spray.material.opacity = 0.4;
      }
      /* rumble by distance (race modes only pass rider coords) */
      if (riderX !== undefined) {
        var dxw = sc.wf.worldPos.x - riderX, dzw = sc.wf.worldPos.z - riderZ;
        var distW = Math.sqrt(dxw * dxw + dzw * dzw);
        fallsRumble(Math.max(0, Math.min(1, 1 - distW / 150)));
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

  function refreshMenu() {
    var html = "";
    CORE.TRACK3_ORDER.forEach(function (id) {
      var t = CORE.TRACKS3[id];
      var best = bests[id];
      html +=
        '<button type="button" class="track-card' + (id === selTrack ? " is-selected" : "") + '" data-track="' + id + '" aria-pressed="' + (id === selTrack) + '">' +
        '<span class="track-card__name">' + t.name + "</span>" +
        '<span class="track-card__meta"><span class="track-pill track-pill--' + t.level + '">' + t.levelLabel + "</span> " + t.desc + " · " + t.length + " m</span>" +
        '<span class="track-card__best">' + (best ? "Your best: " + fmtTime(best) : "Not ridden yet") + "</span>" +
        "</button>";
    });
    el.trackCards.innerHTML = html;
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
    selTrack = btn.getAttribute("data-track");
    lsSet("zr3_seltrack", selTrack);
    camSnap = true;
    refreshMenu();
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
  });

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
      if (!menuGhostRig || menuGhostRig.sceneId !== selTrack) {
        if (menuGhostRig && menuGhostRig.rig.group.parent) menuGhostRig.rig.group.parent.remove(menuGhostRig.rig.group);
        var rig = buildRiderMesh(0x1F7A48);
        enableRigShadows(rig);
        rig.blob.visible = lightMode;
        b.sc.scene.add(rig.group);
        menuGhostRig = { rig: rig, sceneId: selTrack };
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
