/* ==========================================================================
   TRIAL — Three.js renderer + game controller

   The mountain and everything that happens on it live in js/trial-core.js
   (window.TRIAL). This file draws that world, wires the controls, and runs
   the career. Same club promises as the rest of the site: no chat, no
   accounts, no strangers — your progress lives in this browser and nowhere
   else.
   ========================================================================== */

import * as THREE from "three";
import { mergeGeometries } from "./vendor/addons/utils/BufferGeometryUtils.js";
import { Sky } from "./vendor/addons/objects/Sky.js";
import { EffectComposer } from "./vendor/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "./vendor/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "./vendor/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "./vendor/addons/postprocessing/OutputPass.js";
import { FXAAPass } from "./vendor/addons/postprocessing/FXAAPass.js";

(function () {
  "use strict";

  var CORE = window.TRIAL;
  var canvas = document.getElementById("trial-canvas");
  if (!canvas || !CORE) return;

  /* ---------- WebGL check ---------- */

  var glOK = (function () {
    try {
      var c = document.createElement("canvas");
      return !!(window.WebGLRenderingContext && (c.getContext("webgl2") || c.getContext("webgl")));
    } catch (e) { return false; }
  })();
  if (!glOK) {
    var fb = document.getElementById("webgl-fallback");
    if (fb) fb.hidden = false;
    var mm = document.getElementById("screen-map");
    if (mm) mm.hidden = true;
    return;
  }

  /* ---------- small helpers ---------- */

  function $(id) { return document.getElementById(id); }
  function on(el, ev, fn) { if (el) el.addEventListener(ev, fn); }

  function lsGet(k, fallback) {
    try {
      var v = localStorage.getItem(k);
      return v == null ? fallback : JSON.parse(v);
    } catch (e) { return fallback; }
  }
  function lsSet(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ }
  }

  function fmtTime(sec) {
    var m = Math.floor(sec / 60);
    var s = sec % 60;
    var ss = s.toFixed(1);
    if (s < 10) ss = "0" + ss;
    return m + ":" + ss;
  }

  var clamp = CORE.clamp;

  /* ---------- saved profile ----------
     One key holds the lot: career progress, rep, personal bests and the
     handful of settings. Nothing leaves the browser. */

  var SAVE_KEY = "zb-trial-v1";
  var save = lsGet(SAVE_KEY, null) || {
    careerSeed: 20260101,
    rep: 0,
    done: {},          /* nodeId -> { style, time, bails, rep } */
    best: {},          /* seed  -> best style on that mountain */
    daily: {},         /* yyyymmdd -> best style */
    settings: { assist: true, sound: true, detail: "full", invertLook: false }
  };
  if (!save.settings) save.settings = { assist: true, sound: true, detail: "full" };
  function persist() { lsSet(SAVE_KEY, save); }

  var career = CORE.makeCareer(save.careerSeed);

  /* ---------- renderer ---------- */

  var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: false, powerPreference: "high-performance" });
  renderer.setClearColor(0x9ec9dd, 1);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.55;

  var scene = new THREE.Scene();
  var camera = new THREE.PerspectiveCamera(64, 16 / 9, 0.35, 2600);
  var composer = null, bloomPass = null, renderPass = null;

  function pixelRatioFor(detail) {
    var dpr = window.devicePixelRatio || 1;
    if (detail === "low") return Math.min(1, dpr);
    if (detail === "medium") return Math.min(1.35, dpr);
    return Math.min(1.75, dpr);
  }

  function resize() {
    var w = canvas.clientWidth || 960;
    var h = canvas.clientHeight || 540;
    renderer.setPixelRatio(pixelRatioFor(save.settings.detail));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (composer) composer.setSize(w, h);
  }
  window.addEventListener("resize", resize);

  function buildComposer() {
    if (composer) { composer.dispose && composer.dispose(); composer = null; }
    if (save.settings.detail === "low") return;
    composer = new EffectComposer(renderer);
    renderPass = new RenderPass(scene, camera);
    composer.addPass(renderPass);
    if (save.settings.detail === "full") {
      bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.42, 0.62, 0.86);
      composer.addPass(bloomPass);
    } else {
      bloomPass = null;
    }
    composer.addPass(new FXAAPass());
    composer.addPass(new OutputPass());
    resize();
  }

  /* ==========================================================================
     Procedural textures — canvas only, so nothing is fetched over the wire
     ========================================================================== */

  var texCache = {};

  function noiseCanvas(size, fn) {
    var c = document.createElement("canvas");
    c.width = c.height = size;
    var ctx = c.getContext("2d");
    var img = ctx.createImageData(size, size);
    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++) {
        var i = (y * size + x) * 4;
        var v = fn(x / size, y / size, x, y);
        img.data[i] = v[0]; img.data[i + 1] = v[1]; img.data[i + 2] = v[2]; img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  /* seamless fbm on a torus, so the tile never shows a seam */
  function fbm(u, v, seed, octaves) {
    var total = 0, amp = 1, norm = 0, f = 4;
    for (var o = 0; o < octaves; o++) {
      var a = u * Math.PI * 2, b = v * Math.PI * 2;
      total += amp * CORE.vnoise(Math.cos(a) * f, Math.sin(a) * f, seed + o * 31) *
        0.5 + amp * CORE.vnoise(Math.cos(b) * f, Math.sin(b) * f, seed + 100 + o * 31) * 0.5;
      norm += amp;
      amp *= 0.5; f *= 2;
    }
    return total / norm;
  }

  /* Ground detail: a grain map used as a multiplier over the vertex colours,
     plus a matching normal map so low sun rakes across the dirt. */
  function groundTextures() {
    if (texCache.ground) return texCache.ground;
    var S = 256;
    var height = new Float32Array(S * S);
    for (var y = 0; y < S; y++) {
      for (var x = 0; x < S; x++) {
        var u = x / S, v = y / S;
        height[y * S + x] = fbm(u, v, 4231, 4) * 0.6 + fbm(u * 3, v * 3, 991, 3) * 0.4;
      }
    }
    var albedo = noiseCanvas(S, function (u, v, x, y) {
      var h = height[y * S + x];
      var g = Math.round(clamp(178 + h * 74, 96, 255));
      return [g, g, g];
    });
    var normal = noiseCanvas(S, function (u, v, x, y) {
      var xm = (x - 1 + S) % S, xp = (x + 1) % S, ym = (y - 1 + S) % S, yp = (y + 1) % S;
      var dx = (height[y * S + xp] - height[y * S + xm]) * 2.6;
      var dy = (height[yp * S + x] - height[ym * S + x]) * 2.6;
      var nx = -dx, ny = -dy, nz = 1;
      var l = Math.sqrt(nx * nx + ny * ny + nz * nz);
      return [
        Math.round((nx / l * 0.5 + 0.5) * 255),
        Math.round((ny / l * 0.5 + 0.5) * 255),
        Math.round((nz / l * 0.5 + 0.5) * 255)
      ];
    });
    var tA = new THREE.CanvasTexture(albedo);
    var tN = new THREE.CanvasTexture(normal);
    [tA, tN].forEach(function (t) {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    });
    tA.colorSpace = THREE.SRGBColorSpace;
    texCache.ground = { albedo: tA, normal: tN };
    return texCache.ground;
  }

  /* Leaf card for tree canopies: a soft blob with a ragged alpha edge. */
  function leafTexture(hexA, hexB, key) {
    if (texCache[key]) return texCache[key];
    var S = 128;
    var c = document.createElement("canvas");
    c.width = c.height = S;
    var ctx = c.getContext("2d");
    ctx.clearRect(0, 0, S, S);
    var ca = new THREE.Color(hexA), cb = new THREE.Color(hexB);
    var rng = CORE.mulberry32(key.length * 7919 + 13);
    for (var i = 0; i < 150; i++) {
      var a = rng() * Math.PI * 2;
      var r = Math.pow(rng(), 0.55) * S * 0.46;
      var x = S / 2 + Math.cos(a) * r, y = S / 2 + Math.sin(a) * r;
      var rad = 6 + rng() * 16 * (1 - r / (S * 0.5));
      var mix = rng();
      var col = ca.clone().lerp(cb, mix);
      ctx.fillStyle = "rgba(" + Math.round(col.r * 255) + "," + Math.round(col.g * 255) + "," +
        Math.round(col.b * 255) + "," + (0.55 + rng() * 0.45) + ")";
      ctx.beginPath();
      ctx.ellipse(x, y, rad, rad * (0.6 + rng() * 0.6), rng() * 3.14, 0, 6.29);
      ctx.fill();
    }
    var t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    texCache[key] = t;
    return t;
  }

  /* ------------------------------------------------------------------------
     Work in progress: scene building, the rider, the camera rig, the HUD and
     the game loop land in the next commit. Nothing loads this file yet —
     trial.html does not exist — so it is inert until then.
     ------------------------------------------------------------------------ */

  buildComposer();
  resize();
  groundTextures();
})();
