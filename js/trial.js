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
  var AUDIO = window.TRIAL_AUDIO || {
    unlock: function () {}, enable: function () {}, isEnabled: function () { return false; },
    begin: function () {}, end: function () {}, update: function () {},
    event: function () {}, countdown: function () {}, objectHit: function () {}
  };
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
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0x9ec9dd, 1);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
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
      bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.09, 0.5, 0.92);
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
      var g = Math.round(clamp(232 + h * 46, 176, 255));
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

  /* A soft round puff for dust motes. */
  function puffTexture() {
    if (texCache.puff) return texCache.puff;
    var S = 64;
    var c = document.createElement("canvas");
    c.width = c.height = S;
    var ctx = c.getContext("2d");
    var grd = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    grd.addColorStop(0, "rgba(255,255,255,0.95)");
    grd.addColorStop(0.45, "rgba(255,255,255,0.45)");
    grd.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, S, S);
    var t = new THREE.CanvasTexture(c);
    texCache.puff = t;
    return t;
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


  /* ==========================================================================
     Scene: sky, light and the mountain itself
     ========================================================================== */

  var scenery = null;          /* everything belonging to the current run */

  function disposeScenery() {
    if (!scenery) return;
    scene.remove(scenery.root);
    scenery.root.traverse(function (o) {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        (Array.isArray(o.material) ? o.material : [o.material]).forEach(function (m) { m.dispose(); });
      }
    });
    scenery = null;
  }

  /* A cylinder laid between two points — the workhorse for frames and limbs. */
  var TUBE_UP = new THREE.Vector3(0, 1, 0);
  function tube(ax, ay, az, bx, by, bz, r, seg) {
    var dx = bx - ax, dy = by - ay, dz = bz - az;
    var len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 0.0001;
    var g = new THREE.CylinderGeometry(r, r, len, seg || 6, 1, false);
    var q = new THREE.Quaternion().setFromUnitVectors(TUBE_UP, new THREE.Vector3(dx / len, dy / len, dz / len));
    g.applyQuaternion(q);
    g.translate((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
    return g;
  }

  /* Wind: a vertex-shader nudge that leans grass and canopies with the gust,
     stronger the higher up the blade you are. */
  function addWind(material, strength) {
    material.onBeforeCompile = function (shader) {
      shader.uniforms.uTime = windUniform;
      shader.vertexShader = "uniform float uTime;\n" + shader.vertexShader.replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\n" +
        "#ifdef USE_INSTANCING\n" +
        "  vec3 wOrigin = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;\n" +
        "#else\n" +
        "  vec3 wOrigin = vec3(0.0);\n" +
        "#endif\n" +
        "  float sway = sin(uTime * 1.7 + wOrigin.x * 0.28 + wOrigin.z * 0.19) * 0.5 +\n" +
        "               sin(uTime * 3.1 + wOrigin.z * 0.44) * 0.22;\n" +
        "  float up = max(transformed.y, 0.0);\n" +
        "  transformed.x += sway * up * " + strength.toFixed(3) + ";\n" +
        "  transformed.z += sway * up * " + (strength * 0.45).toFixed(3) + ";\n"
      );
    };
    material.customProgramCacheKey = function () { return "wind" + strength; };
  }
  var windUniform = { value: 0 };

  /* ---------- prop kits ----------
     Each entry returns { parts: [{ geo, mat }] } — one instanced mesh per
     part, so a tree is a trunk instance plus a canopy instance. */

  function propKits(theme, detail) {
    var trunkMat = function () {
      return new THREE.MeshStandardMaterial({ color: theme.trunk, roughness: 0.94, metalness: 0 });
    };
    var leafMat = function (key) {
      var m = new THREE.MeshStandardMaterial({
        map: leafTexture(theme.canopy, theme.canopy2, key),
        transparent: true, alphaTest: 0.34, side: THREE.DoubleSide,
        roughness: 0.9, metalness: 0
      });
      addWind(m, 0.055);
      return m;
    };
    var rockMat = function () {
      return new THREE.MeshStandardMaterial({ color: theme.rock, roughness: 1, metalness: 0, flatShading: true });
    };

    /* crossed alpha cards, the cheap way to draw a canopy that still reads
       as leaves when the sun comes through it */
    function cards(n, w, h, yBase, spread) {
      var geos = [];
      for (var i = 0; i < n; i++) {
        var g = new THREE.PlaneGeometry(w, h);
        g.rotateY((i / n) * Math.PI + 0.4);
        g.translate(
          Math.cos(i * 2.4) * spread,
          yBase + Math.sin(i * 1.7) * spread * 0.5,
          Math.sin(i * 2.4) * spread
        );
        geos.push(g);
      }
      return mergeGeometries(geos);
    }

    function lumpy(r, detailLevel, sx, sy, sz) {
      var g = new THREE.IcosahedronGeometry(r, detailLevel);
      var pos = g.attributes.position;
      for (var i = 0; i < pos.count; i++) {
        var n = 1 + CORE.vnoise(pos.getX(i) * 2.2, pos.getZ(i) * 2.2, 77) * 0.34;
        pos.setXYZ(i, pos.getX(i) * n * sx, pos.getY(i) * n * sy, pos.getZ(i) * n * sz);
      }
      g.computeVertexNormals();
      return g;
    }

    var lo = detail === "low";

    return {
      msasa: { parts: [
        { geo: tube(0, 0, 0, 0.1, 3.1, 0.05, 0.17, lo ? 5 : 7), mat: trunkMat() },
        { geo: cards(lo ? 2 : 4, 3.5, 2.4, 3.7, 0.55), mat: leafMat("msasa") }
      ] },
      pine: { parts: [
        { geo: tube(0, 0, 0, 0, 2.4, 0, 0.16, lo ? 5 : 7), mat: trunkMat() },
        { geo: (function () { var g = new THREE.ConeGeometry(1.5, 4.6, lo ? 6 : 9); g.translate(0, 4.4, 0); return g; })(),
          mat: new THREE.MeshStandardMaterial({ color: theme.canopy, roughness: 0.92, flatShading: true }) }
      ] },
      acacia: { parts: [
        { geo: tube(0, 0, 0, 0.25, 2.5, 0.1, 0.15, lo ? 5 : 7), mat: trunkMat() },
        { geo: cards(lo ? 2 : 3, 4.6, 1.3, 3.0, 0.3), mat: leafMat("acacia") }
      ] },
      baobab: { parts: [
        { geo: (function () {
            var g = new THREE.CylinderGeometry(0.5, 1.05, 4.2, lo ? 6 : 10);
            g.translate(0, 2.1, 0);
            return mergeGeometries([g,
              tube(0, 4.0, 0, 1.1, 5.4, 0.4, 0.13, 5),
              tube(0, 4.0, 0, -0.9, 5.3, -0.6, 0.12, 5),
              tube(0, 4.1, 0, 0.2, 5.7, -1.0, 0.11, 5)]);
          })(), mat: trunkMat() },
        { geo: cards(2, 2.2, 1.1, 5.6, 0.5), mat: leafMat("baobab") }
      ] },
      bush: { parts: [
        { geo: lumpy(0.62, lo ? 0 : 1, 1.2, 0.85, 1.2), mat: (function () {
            var m = new THREE.MeshStandardMaterial({ color: theme.canopy2, roughness: 0.95, flatShading: true });
            m.color.offsetHSL(0, -0.06, -0.03);
            addWind(m, 0.03);
            return m;
          })() }
      ] },
      protea: { parts: [
        { geo: lumpy(0.5, 0, 1.1, 0.9, 1.1), mat: new THREE.MeshStandardMaterial({ color: theme.grassDry, roughness: 0.95, flatShading: true }) },
        { geo: (function () { var g = new THREE.SphereGeometry(0.2, 6, 5); g.translate(0, 0.72, 0); return g; })(),
          mat: new THREE.MeshStandardMaterial({ color: theme.accent, roughness: 0.7, emissive: theme.accent, emissiveIntensity: 0.12 }) }
      ] },
      termite: { parts: [
        { geo: (function () { var g = new THREE.ConeGeometry(0.75, 2.0, lo ? 5 : 8); g.translate(0, 1.0, 0); return g; })(),
          mat: new THREE.MeshStandardMaterial({ color: theme.dirtDark, roughness: 1, flatShading: true }) }
      ] },
      rock: { parts: [{ geo: lumpy(1.0, lo ? 0 : 1, 1.15, 0.72, 1.0), mat: rockMat() }] },
      boulder: { parts: [{ geo: lumpy(0.85, 0, 1.1, 0.62, 1.05), mat: rockMat() }] },
      fern: { parts: [
        { geo: cards(2, 1.0, 0.85, 0.42, 0.1), mat: (function () {
            var m = leafMat("fern"); m.alphaTest = 0.4; return m;
          })() }
      ] },
      grass: { parts: [
        { geo: cards(2, 0.85, 0.62, 0.3, 0.05), mat: (function () {
            var m = new THREE.MeshStandardMaterial({
              map: leafTexture(theme.grass, theme.grassDry, "tuft"),
              transparent: true, alphaTest: 0.42, side: THREE.DoubleSide, roughness: 0.95
            });
            addWind(m, 0.13);
            return m;
          })() }
      ] }
    };
  }

  /* ---------- terrain ---------- */

  function buildTerrain(world, theme, detail) {
    var stride = detail === "low" ? 2 : 1;
    var nx = Math.floor((world.nx - 1) / stride) + 1;
    var nz = Math.floor((world.nz - 1) / stride) + 1;
    var step = world.step * stride;

    var pos = new Float32Array(nx * nz * 3);
    var col = new Float32Array(nx * nz * 3);
    var uv = new Float32Array(nx * nz * 2);

    var cGrass = new THREE.Color(theme.grass);
    var cDry = new THREE.Color(theme.grassDry);
    var cDirt = new THREE.Color(theme.dirt);
    var cDark = new THREE.Color(theme.dirtDark);
    var cRock = new THREE.Color(theme.rock);
    var tmp = new THREE.Color();

    /* the corridor is wider wherever a feature widened the carve, so ask the
       trail how wide it is at this z rather than assuming */
    var widForRow = new Float32Array(nz);
    var pts = world.trail;
    for (var gz = 0; gz < nz; gz++) {
      var wz = world.z0 + gz * step;
      var lo = 0, hi = world.trailN - 1;
      while (lo < hi) { var mid = (lo + hi) >> 1; if (pts[mid].z < wz) lo = mid + 1; else hi = mid; }
      widForRow[gz] = world.wid[lo];
    }

    var i3 = 0, i2 = 0, vi = 0;
    for (gz = 0; gz < nz; gz++) {
      var srcZ = gz * stride;
      var z = world.z0 + srcZ * world.step;
      var wid = widForRow[gz];
      for (var gx = 0; gx < nx; gx++) {
        var srcX = gx * stride;
        var x = world.x0 + srcX * world.step;
        var src = srcZ * world.nx + srcX;
        var y = world.H[src];
        var td = world.TD[src];

        pos[i3] = x; pos[i3 + 1] = y; pos[i3 + 2] = z;
        uv[i2] = x / 9; uv[i2 + 1] = z / 9;

        /* steepness, from the carved grid itself */
        var xm = Math.max(0, srcX - 1), xp = Math.min(world.nx - 1, srcX + 1);
        var zm = Math.max(0, srcZ - 1), zp = Math.min(world.nz - 1, srcZ + 1);
        var dhx = (world.H[srcZ * world.nx + xp] - world.H[srcZ * world.nx + xm]) / (2 * world.step);
        var dhz = (world.H[zp * world.nx + srcX] - world.H[zm * world.nx + srcX]) / (2 * world.step);
        var slope = Math.sqrt(dhx * dhx + dhz * dhz);

        var grain = CORE.vnoise(x / 21, z / 21, 4242) * 0.5 + 0.5;
        tmp.copy(cGrass).lerp(cDry, grain);

        /* worn dirt on the line, scuffed edges either side of it */
        var onTrail = 1 - smoothstep01(td, wid * 0.3, wid * 0.92);
        if (onTrail > 0) {
          var rut = 1 - smoothstep01(Math.abs(td - wid * 0.3), 0, wid * 0.26);
          var dirt = cDirt.clone().lerp(cDark, rut * 0.55 + grain * 0.2);
          tmp.lerp(dirt, onTrail);
        }
        /* anything genuinely steep is rock, trail or not */
        var rocky = smoothstep01(slope, 0.72, 1.45) * (1 - onTrail * 0.75);
        if (rocky > 0) tmp.lerp(cRock, rocky);
        /* fake a little ambient occlusion into the gullies */
        var shade = 1 - smoothstep01(slope, 0.2, 2.0) * 0.16;
        col[i3] = tmp.r * shade; col[i3 + 1] = tmp.g * shade; col[i3 + 2] = tmp.b * shade;

        i3 += 3; i2 += 2; vi++;
      }
    }

    var idx = [];
    for (gz = 0; gz < nz - 1; gz++) {
      for (gx = 0; gx < nx - 1; gx++) {
        var a = gz * nx + gx, b = a + 1, c = a + nx, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }

    var geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    geo.setIndex(nx * nz > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();

    var tex = groundTextures();
    var mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      map: detail === "low" ? null : tex.albedo,
      normalMap: detail === "low" ? null : tex.normal,
      normalScale: new THREE.Vector2(0.75, 0.75),
      roughness: 0.97, metalness: 0
    });
    if (mat.map) {
      mat.map.repeat.set(1, 1);
    }
    var mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    return mesh;
  }

  function smoothstep01(v, a, b) {
    var t = Math.min(1, Math.max(0, (v - a) / (b - a)));
    return t * t * (3 - 2 * t);
  }

  /* ---------- the whole mountain ---------- */

  function buildScenery(world) {
    disposeScenery();
    var theme = world.biome.theme;
    var night = !!world.spec.night;
    var detail = save.settings.detail;
    var root = new THREE.Group();

    /* --- sky --- */
    var sky = new Sky();
    sky.scale.setScalar(9000);
    var su = sky.material.uniforms;
    su.turbidity.value = night ? 12 : theme.turbidity;
    su.rayleigh.value = night ? 0.35 : theme.rayleigh;
    su.mieCoefficient.value = theme.mieCoeff;
    su.mieDirectionalG.value = theme.mieG;
    var sp = theme.sunPos;
    var sunDir = new THREE.Vector3(sp[0], night ? -18 : sp[1], sp[2]).normalize();
    su.sunPosition.value.copy(sunDir);
    root.add(sky);

    /* --- fog: the mountain fades into its own weather --- */
    var fogCol = new THREE.Color(night ? 0x0C1220 : theme.fog);
    if (!night) fogCol.lerp(new THREE.Color(theme.grassDry), 0.28);   /* haze over land, not milk */
    scene.fog = new THREE.Fog(
      fogCol,
      night ? 30 : theme.fogNear * 2.6,
      night ? 210 : theme.fogFar * 2.0
    );
    renderer.toneMappingExposure = night ? 0.62 : (theme.exposure || 0.55) * 0.62;

    /* --- light --- */
    var sun = new THREE.DirectionalLight(night ? 0x9DB6E0 : theme.sun, night ? 2.4 : 6.0);
    sun.position.copy(sunDir).multiplyScalar(120);
    sun.castShadow = detail !== "low";
    if (sun.castShadow) {
      var sh = detail === "full" ? 2048 : 1024;
      sun.shadow.mapSize.set(sh, sh);
      sun.shadow.camera.near = 1;
      sun.shadow.camera.far = 260;
      var half = 62;
      sun.shadow.camera.left = -half; sun.shadow.camera.right = half;
      sun.shadow.camera.top = half; sun.shadow.camera.bottom = -half;
      sun.shadow.bias = -0.0011;
      sun.shadow.normalBias = 0.045;
    }
    root.add(sun);
    root.add(sun.target);

    var hemi = new THREE.HemisphereLight(
      night ? 0x27304A : theme.sky,
      night ? 0x141C10 : theme.dirtDark,
      night ? 1.9 : 2.0
    );
    root.add(hemi);
    root.add(new THREE.AmbientLight(night ? 0x2A3A5C : theme.ambient, night ? 2.2 : 0.55));

    /* --- ground --- */
    var terrain = buildTerrain(world, theme, detail);
    root.add(terrain);

    /* --- props, one instanced mesh per part --- */
    var kits = propKits(theme, detail);
    var buckets = {};
    world.props.forEach(function (p) { (buckets[p.type] || (buckets[p.type] = [])).push(p); });
    if (detail !== "low") {
      (world.cover || []).forEach(function (p) { (buckets[p.type] || (buckets[p.type] = [])).push(p); });
    }

    var m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), v3 = new THREE.Vector3(), sc = new THREE.Vector3();
    var tint = new THREE.Color();
    Object.keys(buckets).forEach(function (type) {
      var kit = kits[type] || kits.bush;
      var list = buckets[type];
      kit.parts.forEach(function (part) {
        var inst = new THREE.InstancedMesh(part.geo, part.mat, list.length);
        inst.castShadow = detail !== "low" && part.geo.attributes.position.count > 12;
        inst.receiveShadow = false;
        inst.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(list.length * 3), 3);
        for (var i = 0; i < list.length; i++) {
          var p = list[i];
          q.setFromAxisAngle(TUBE_UP, p.rot);
          v3.set(p.x, p.y, p.z);
          sc.set(p.s, p.s * (0.9 + (i % 7) * 0.03), p.s);
          m4.compose(v3, q, sc);
          inst.setMatrixAt(i, m4);
          /* a little colour drift so a hillside of one tree is not one tree */
          var h = (CORE.vnoise(p.x / 17, p.z / 17, 313) * 0.5 + 0.5);
          tint.setRGB(0.86 + h * 0.28, 0.88 + h * 0.22, 0.84 + h * 0.3);
          inst.setColorAt(i, tint);
        }
        inst.instanceMatrix.needsUpdate = true;
        if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
        inst.frustumCulled = false;
        root.add(inst);
      });
    });

    /* --- checkpoint gates and feature markers --- */
    var deco = buildDecorations(world, theme, night);
    root.add(deco.group);

    scene.add(root);
    scenery = {
      root: root, sun: sun, sky: sky, terrain: terrain, theme: theme,
      night: night, fogCol: fogCol
    };
    return scenery;
  }

  function buildDecorations(world, theme, night) {
    var group = new THREE.Group();
    var postMat = new THREE.MeshStandardMaterial({ color: 0x6B4A2C, roughness: 0.9 });
    var tapeMat = new THREE.MeshStandardMaterial({
      color: theme.accent, roughness: 0.6,
      emissive: theme.accent, emissiveIntensity: night ? 0.9 : 0.25
    });
    var flagMat = new THREE.MeshStandardMaterial({
      color: 0xF2F0E4, roughness: 0.85, side: THREE.DoubleSide,
      emissive: 0xF2F0E4, emissiveIntensity: night ? 0.5 : 0
    });

    var postGeos = [], tapeGeos = [], flagGeos = [];

    function place(idx, kind) {
      var p = world.trail[Math.min(world.trailN - 1, Math.max(0, idx))];
      var wid = world.wid[Math.min(world.trailN - 1, Math.max(0, idx))];
      var yaw = p.yaw;
      var nx = Math.cos(yaw), nz = -Math.sin(yaw);          /* trail-left normal */
      var off = wid + 1.2;
      var h = kind === "gate" ? 3.4 : 2.1;
      var lx = p.x + nx * off, lz = p.z + nz * off;
      var rx = p.x - nx * off, rz = p.z - nz * off;
      var ly = CORE.heightAt(world, lx, lz), ry = CORE.heightAt(world, rx, rz);
      postGeos.push(tube(lx, ly - 0.4, lz, lx, ly + h, lz, 0.09, 5));
      postGeos.push(tube(rx, ry - 0.4, rz, rx, ry + h, rz, 0.09, 5));
      if (kind === "gate") {
        var topY = Math.max(ly, ry) + h;
        tapeGeos.push(tube(lx, topY, lz, rx, topY, rz, 0.14, 5));
        var span = Math.sqrt((rx - lx) * (rx - lx) + (rz - lz) * (rz - lz));
        var bg = new THREE.PlaneGeometry(span * 0.72, 0.72);
        bg.rotateY(-yaw);
        bg.translate((lx + rx) / 2, topY - 0.55, (lz + rz) / 2);
        flagGeos.push(bg);
      } else {
        /* a marker flag on each side of a big feature, so you read it early */
        [[lx, ly, lz], [rx, ry, rz]].forEach(function (a) {
          var fg = new THREE.PlaneGeometry(0.85, 0.52);
          fg.rotateY(-yaw);
          fg.translate(a[0], a[1] + h - 0.34, a[2]);
          tapeGeos.push(fg);
        });
      }
    }

    world.gates.forEach(function (g) { place(g, "gate"); });
    world.features.forEach(function (f) { if (f.big) place(Math.max(0, f.i0 - 4), "marker"); });
    place(world.finishIdx - 2, "gate");

    if (postGeos.length) {
      var pm = new THREE.Mesh(mergeGeometries(postGeos), postMat);
      pm.castShadow = true; group.add(pm);
    }
    if (tapeGeos.length) group.add(new THREE.Mesh(mergeGeometries(tapeGeos), tapeMat));
    if (flagGeos.length) group.add(new THREE.Mesh(mergeGeometries(flagGeos), flagMat));

    return { group: group };
  }

  /* ==========================================================================
     The rider
     ========================================================================== */

  function buildRider(jerseyHex, night) {
    var g = new THREE.Group();
    g.rotation.order = "YXZ";

    var matte = function (c, rough) {
      return new THREE.MeshStandardMaterial({ color: c, roughness: rough === undefined ? 0.75 : rough, metalness: 0 });
    };
    var frameMat = matte(jerseyHex, 0.42);
    frameMat.metalness = 0.25;
    var darkMat = matte(0x22201C, 0.85);
    var tyreMat = matte(0x141414, 0.95);
    var skinMat = matte(0x8A5A34, 0.85);
    var kitMat = matte(jerseyHex, 0.8);
    var helmetMat = matte(0xF2EDE0, 0.55);

    /* --- wheels --- */
    var wheels = [];
    [-0.53, 0.53].forEach(function (zOff, i) {
      var w = new THREE.Group();
      var tyre = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.055, 7, 18), tyreMat);
      tyre.rotation.y = Math.PI / 2;
      w.add(tyre);
      var rimGeos = [];
      for (var s = 0; s < 5; s++) {
        var a = (s / 5) * Math.PI * 2;
        rimGeos.push(tube(0, 0, 0, 0, Math.sin(a) * 0.32, Math.cos(a) * 0.32, 0.012, 4));
      }
      var spokes = new THREE.Mesh(mergeGeometries(rimGeos), matte(0xC9C6BE, 0.4));
      spokes.material.metalness = 0.55;
      w.add(spokes);
      w.position.set(0, 0.34, zOff);
      w.castShadow = true;
      g.add(w);
      wheels.push(w);
    });

    /* --- frame: a real-ish double triangle --- */
    var bb = [0, 0.44, 0.02];          /* bottom bracket */
    var seatT = [0, 0.94, -0.16];
    var headT = [0, 0.98, 0.36];
    var rearAx = [0, 0.34, -0.53];
    var frontAx = [0, 0.34, 0.53];
    var frameGeos = [
      tube(bb[0], bb[1], bb[2], seatT[0], seatT[1], seatT[2], 0.038),
      tube(bb[0], bb[1], bb[2], headT[0], headT[1], headT[2], 0.042),
      tube(seatT[0], seatT[1], seatT[2], headT[0], headT[1], headT[2], 0.036),
      tube(bb[0], bb[1], bb[2], rearAx[0], rearAx[1], rearAx[2], 0.03),
      tube(seatT[0], seatT[1], seatT[2], rearAx[0], rearAx[1], rearAx[2], 0.026),
      tube(0, 1.02, -0.2, 0, 1.12, -0.24, 0.03)
    ];
    var frame = new THREE.Mesh(mergeGeometries(frameGeos), frameMat);
    frame.castShadow = true;
    g.add(frame);

    /* saddle + fork + bars */
    var saddle = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.05, 0.30), darkMat);
    saddle.position.set(0, 1.15, -0.24);
    g.add(saddle);

    var forkGeos = [
      tube(-0.085, 0.98, 0.4, -0.085, 0.34, frontAx[2], 0.026),
      tube(0.085, 0.98, 0.4, 0.085, 0.34, frontAx[2], 0.026)
    ];
    var fork = new THREE.Mesh(mergeGeometries(forkGeos), matte(0x3A3835, 0.5));
    fork.castShadow = true;
    g.add(fork);

    var bars = new THREE.Mesh(mergeGeometries([
      tube(-0.31, 1.06, 0.42, 0.31, 1.06, 0.42, 0.021),
      tube(0, 0.98, 0.4, 0, 1.06, 0.42, 0.024)
    ]), matte(0x3A3835, 0.45));
    g.add(bars);

    var cranks = new THREE.Group();
    cranks.add(new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.018, 12), matte(0xB0ADA4, 0.35)));
    cranks.children[0].rotation.z = Math.PI / 2;
    var crankArms = new THREE.Mesh(mergeGeometries([
      tube(0.07, 0, 0, 0.07, -0.15, 0.03, 0.018, 4),
      tube(-0.07, 0, 0, -0.07, 0.15, -0.03, 0.018, 4)
    ]), darkMat);
    cranks.add(crankArms);
    cranks.position.set(0, 0.44, 0.02);
    g.add(cranks);

    /* --- rider --- */
    var rider = new THREE.Group();
    var torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 0.34, 4, 8), kitMat);
    torso.rotation.x = -0.72;
    torso.position.set(0, 1.42, -0.02);
    torso.castShadow = true;
    rider.add(torso);

    var head = new THREE.Mesh(new THREE.SphereGeometry(0.125, 12, 10), skinMat);
    head.position.set(0, 1.70, 0.20);
    rider.add(head);
    var helmet = new THREE.Mesh(new THREE.SphereGeometry(0.148, 12, 10, 0, 6.29, 0, 1.9), helmetMat);
    helmet.position.copy(head.position);
    helmet.rotation.x = -0.34;
    helmet.castShadow = true;
    rider.add(helmet);
    var peak = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.022, 0.14), helmetMat);
    peak.position.set(0, 1.73, 0.34);
    peak.rotation.x = 0.2;
    rider.add(peak);

    var arms = new THREE.Mesh(mergeGeometries([
      tube(-0.17, 1.46, 0.08, -0.30, 1.09, 0.40, 0.045),
      tube(0.17, 1.46, 0.08, 0.30, 1.09, 0.40, 0.045)
    ]), kitMat);
    rider.add(arms);

    var legs = new THREE.Mesh(mergeGeometries([
      tube(-0.10, 1.24, -0.18, -0.13, 0.78, -0.04, 0.062),
      tube(-0.13, 0.78, -0.04, -0.08, 0.46, 0.04, 0.052),
      tube(0.10, 1.24, -0.18, 0.13, 0.80, 0.02, 0.062),
      tube(0.13, 0.80, 0.02, 0.08, 0.56, 0.10, 0.052)
    ]), matte(0x2E3238, 0.85));
    legs.castShadow = true;
    rider.add(legs);

    g.add(rider);

    if (night) {
      var lamp = new THREE.SpotLight(0xFFF0D0, 260, 110, 0.62, 0.4, 0.9);
      lamp.position.set(0, 1.02, 0.5);
      lamp.target.position.set(0, -1.2, 20);
      g.add(lamp);
      g.add(lamp.target);
      var glow = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 6),
        new THREE.MeshBasicMaterial({ color: 0xFFF3D6 }));
      glow.position.set(0, 1.02, 0.48);
      g.add(glow);
    }

    return { group: g, wheels: wheels, rider: rider, cranks: cranks, bars: bars, torso: torso, head: head, helmet: helmet };
  }

  /* ==========================================================================
     Dust, camera and the run itself
     ========================================================================== */

  function buildDust(theme, night) {
    var N = 140;
    var geo = new THREE.BufferGeometry();
    var pos = new Float32Array(N * 3);
    var alpha = new Float32Array(N);
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("aAlpha", new THREE.BufferAttribute(alpha, 1));
    var mat = new THREE.PointsMaterial({
      color: new THREE.Color(theme.dirt).lerp(new THREE.Color(0xFFFFFF), 0.3),
      map: puffTexture(),
      size: 0.55, transparent: true, opacity: night ? 0.18 : 0.42, depthWrite: false,
      sizeAttenuation: true
    });
    var pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    var life = new Float32Array(N);
    var vel = new Float32Array(N * 3);
    var ptr = 0;
    for (var q = 0; q < N; q++) pos[q * 3 + 1] = -9999;
    return {
      object: pts,
      emit: function (x, y, z, amount, spread) {
        for (var k = 0; k < amount; k++) {
          var i = ptr = (ptr + 1) % N;
          pos[i * 3] = x + (Math.random() - 0.5) * 0.4;
          pos[i * 3 + 1] = y + 0.1;
          pos[i * 3 + 2] = z + (Math.random() - 0.5) * 0.4;
          vel[i * 3] = (Math.random() - 0.5) * spread;
          vel[i * 3 + 1] = 0.6 + Math.random() * spread;
          vel[i * 3 + 2] = (Math.random() - 0.5) * spread;
          life[i] = 0.75 + Math.random() * 0.45;
        }
      },
      update: function (dt) {
        var any = false;
        for (var i = 0; i < N; i++) {
          if (life[i] <= 0) { alpha[i] = 0; pos[i * 3 + 1] = -9999; continue; }
          any = true;
          life[i] -= dt;
          pos[i * 3] += vel[i * 3] * dt;
          pos[i * 3 + 1] += vel[i * 3 + 1] * dt;
          pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
          vel[i * 3 + 1] -= 1.4 * dt;
          alpha[i] = Math.max(0, life[i]);
        }
        if (any) {
          geo.attributes.position.needsUpdate = true;
          geo.attributes.aAlpha.needsUpdate = true;
        }
      }
    };
  }

  /* ---------- input ---------- */

  var keys = {};
  var touch = { pedal: false, brake: false, left: false, right: false, hop: false, whipL: false, whipR: false };

  var KEYMAP = {
    KeyW: "up", ArrowUp: "up", KeyS: "down", ArrowDown: "down",
    KeyA: "left", ArrowLeft: "left", KeyD: "right", ArrowRight: "right",
    Space: "hop", KeyQ: "whipL", KeyE: "whipR"
  };

  window.addEventListener("keydown", function (e) {
    if (KEYMAP[e.code]) { keys[KEYMAP[e.code]] = true; e.preventDefault(); }
    if (e.code === "Escape") togglePause();
    if (e.code === "KeyR" && run) restartRun();
    if (e.code === "KeyF") toggleFullscreen();
  });
  window.addEventListener("keyup", function (e) {
    if (KEYMAP[e.code]) { keys[KEYMAP[e.code]] = false; e.preventDefault(); }
  });
  window.addEventListener("blur", function () { keys = {}; });

  /* A key that was already held when the wheels left the ground must not
     become a trick: you pedal into a lip with W down and steer into it with D
     down, and neither of those is a request for a backflip. Held keys are
     latched out until they are released and pressed again in the air. */
  var airLatch = { up: false, down: false, left: false, right: false };

  function latchOnTakeoff() {
    airLatch.up = keys.up || touch.pedal;
    airLatch.down = keys.down || touch.brake;
    airLatch.left = keys.left || touch.left;
    airLatch.right = keys.right || touch.right;
  }

  function readInput(airborne) {
    var up = keys.up || touch.pedal;
    var down = keys.down || touch.brake;
    var left = keys.left || touch.left;
    var right = keys.right || touch.right;

    if (airborne) {
      if (!up) airLatch.up = false;
      if (!down) airLatch.down = false;
      if (!left) airLatch.left = false;
      if (!right) airLatch.right = false;
    }

    var aUp = up && !(airborne && airLatch.up);
    var aDown = down && !(airborne && airLatch.down);
    var aLeft = left && !(airborne && airLatch.left);
    var aRight = right && !(airborne && airLatch.right);

    return {
      pedal: !airborne && up,
      brake: !airborne && down,
      left: airborne ? aLeft : left,
      right: airborne ? aRight : right,
      hop: keys.hop || touch.hop,
      flipBack: airborne && aUp,
      flipFwd: airborne && aDown,
      whipL: keys.whipL || touch.whipL,
      whipR: keys.whipR || touch.whipR
    };
  }

  /* ---------- the run ---------- */

  var run = null;               /* null when nobody is riding */
  var clock = new THREE.Clock();   /* Timer needs an update() call per frame; Clock is enough here */
  var accumulator = 0;

  function startRun(cfg) {
    var spec = CORE.makeSpec({
      seed: cfg.seed, biome: cfg.biome, modifier: cfg.modifier, length: cfg.length
    });
    var world = CORE.buildWorld(spec);
    buildScenery(world);

    var rig = buildRider(cfg.jersey || 0xE8791D, !!spec.night);
    scenery.root.add(rig.group);
    var dust = buildDust(world.biome.theme, !!spec.night);
    scenery.root.add(dust.object);

    var st = CORE.newRider(world, { assist: save.settings.assist });

    run = {
      cfg: cfg, world: world, st: st, rig: rig, dust: dust,
      node: cfg.node || null,
      paused: false, over: false, countdown: 2.2,
      camPos: new THREE.Vector3(), camLook: new THREE.Vector3(),
      shake: 0, fov: 64, events: [], input: null, countBeep: 3
    };
    /* park the camera behind the start line before the countdown runs out */
    var p0 = world.trail[2];
    run.camPos.set(p0.x - Math.sin(st.yaw) * 7, p0.y + 3.4, p0.z - Math.cos(st.yaw) * 7);
    run.camLook.set(p0.x, p0.y + 1.2, p0.z);

    showScreen(null);
    setHudVisible(true);
    drawMinimapBase(world);
    AUDIO.begin();
    return run;
  }

  function endRun(reason) {
    if (!run || run.over) return;
    run.over = true;
    AUDIO.end();
    var summary = CORE.summarise(run.st, run.world);
    summary.reason = reason;
    recordResult(summary);
    showResults(summary, reason);
  }

  function restartRun() {
    if (!run) return;
    var cfg = run.cfg;
    disposeScenery();
    run = null;
    startRun(cfg);
  }

  /* ---------- camera ---------- */

  var vTmp = new THREE.Vector3();
  function updateCamera(dt) {
    var st = run.st, w = run.world;
    var speed = Math.sqrt(st.vx * st.vx + st.vz * st.vz);
    var air = !st.onGround;

    /* sit behind the direction of travel, not the bike — during a spin the
       world should stay put while the rider turns inside it */
    var travel = Math.atan2(st.vx, st.vz);
    if (speed < 2.5) travel = st.yaw;

    var back = air ? 8.6 : 7.0 + speed * 0.085;
    var up = air ? 3.3 : 2.5 + speed * 0.02;
    var want = vTmp.set(
      st.x - Math.sin(travel) * back,
      st.y + up,
      st.z - Math.cos(travel) * back
    );
    /* never let the camera end up inside the hillside */
    var groundY = CORE.heightAt(w, want.x, want.z) + 1.5;
    if (want.y < groundY) want.y = groundY;

    var k = 1 - Math.pow(0.0016, dt);
    run.camPos.lerp(want, k);

    var lookAhead = 6 + speed * 0.34;
    var target = vTmp.set(
      st.x + Math.sin(travel) * lookAhead * 0.55,
      st.y + 1.15 + (air ? 0.5 : 0),
      st.z + Math.cos(travel) * lookAhead * 0.55
    );
    run.camLook.lerp(target, 1 - Math.pow(0.002, dt));

    camera.position.copy(run.camPos);
    if (run.shake > 0) {
      run.shake = Math.max(0, run.shake - dt * 2.6);
      var s = run.shake * 0.4;
      camera.position.x += (Math.random() - 0.5) * s;
      camera.position.y += (Math.random() - 0.5) * s;
      camera.position.z += (Math.random() - 0.5) * s;
    }
    /* chatter through a rock garden comes through the lens, not the bike */
    if (st.chatter > 0.02 && st.onGround) {
      camera.position.y += Math.sin(performance.now() * 0.045) * 0.035 * st.chatter;
      camera.position.x += Math.sin(performance.now() * 0.061) * 0.03 * st.chatter;
    }
    camera.lookAt(run.camLook);

    var wantFov = 62 + Math.min(20, speed * 0.72) + (air ? 3 : 0);
    run.fov += (wantFov - run.fov) * Math.min(1, 3.2 * dt);
    if (Math.abs(camera.fov - run.fov) > 0.01) {
      camera.fov = run.fov;
      camera.updateProjectionMatrix();
    }
  }

  /* ---------- rider mesh follows the simulation ---------- */

  function updateRiderMesh(dt) {
    var st = run.st, rig = run.rig;
    var g = rig.group;
    g.position.set(st.x, st.y, st.z);
    g.rotation.y = st.yaw + st.spin;
    g.rotation.x = -st.flip;
    g.rotation.z = st.lean * 0.9 + st.whip * 0.55;

    /* the whip is in the hips: bars stay pointed where you are going */
    rig.bars.rotation.y = -st.whip * 0.5;
    rig.rider.rotation.z = -st.whip * 0.22;
    rig.rider.rotation.x = st.onGround
      ? (st.crashT > 0 ? 0.5 : -0.05 - Math.min(0.22, Math.abs(st.vy) * 0.02))
      : 0.1;

    var spin = st.wheelSpin;
    rig.wheels[0].rotation.x = spin;
    rig.wheels[1].rotation.x = spin;
    rig.cranks.rotation.x = spin * 0.35;

    if (st.crashT > 0) {
      g.rotation.z += Math.sin(st.crashT * 9) * 0.9;
      g.rotation.x += st.crashT * 0.8;
      g.visible = true;
    }
    g.visible = !(st.dead && st.crashT <= 0);

    /* dust off the back wheel, and a burst when you touch down */
    var speed = Math.sqrt(st.vx * st.vx + st.vz * st.vz);
    if (st.onGround && speed > 5 && st.crashT <= 0) {
      var rate = st.offTrail || st.chatter > 0.2 ? 3 : 1;
      if (Math.random() < speed * 0.045 * rate) {
        run.dust.emit(
          st.x - Math.sin(st.yaw) * 0.55, st.y, st.z - Math.cos(st.yaw) * 0.55,
          1, 0.8 + speed * 0.05
        );
      }
    }
    run.dust.update(dt);
  }

  /* ---------- one frame ---------- */

  var lastNow = 0;
  function frame() {
    requestAnimationFrame(frame);
    var raw = clock.getDelta();
    var dt = Math.min(0.06, raw);
    windUniform.value += dt;

    if (run && !run.paused && !run.over) {
      if (run.countdown > 0) {
        /* the drop-in countdown is wall time, not simulated time — clamping it
           to the frame budget makes it crawl on a slow machine */
        run.countdown -= Math.min(0.4, raw);
        var beep = Math.ceil(run.countdown);
        if (beep < run.countBeep) { run.countBeep = beep; AUDIO.countdown(beep <= 0); }
        setCountdown(run.countdown);
      } else if (elCount && !elCount.hidden) {
        elCount.hidden = true;
      }
      if (run.countdown <= 0) {
        accumulator += dt;
        var steps = 0;
        while (accumulator >= CORE.DT && steps < 5) {
          run.events.length = 0;
          var wasDown = run.st.onGround;
          var inp = readInput(!run.st.onGround);
          run.input = inp;
          CORE.stepRider(run.st, inp, run.world, run.events);
          if (wasDown && !run.st.onGround) latchOnTakeoff();
          handleEvents(run.events);
          accumulator -= CORE.DT;
          steps++;
        }
      }
      updateRiderMesh(dt);
      updateCamera(dt);
      updateHud(dt);
      AUDIO.update(run.st, run.world, dt, run.input || {});

      if (scenery && scenery.sun) {
        scenery.sun.target.position.set(run.st.x, run.st.y, run.st.z);
        scenery.sun.position.set(run.st.x + 90, run.st.y + 150, run.st.z - 90);
      }
      if (run.st.finished) endRun("finish");
      else if (run.st.dead && run.st.crashT <= 0) endRun("broken");
    }

    if (composer) composer.render();
    else renderer.render(scene, camera);
  }

  /* ==========================================================================
     HUD, minimap and screens
     ========================================================================== */

  var hud = $("hud");
  var elTime = $("hud-time"), elSpeed = $("hud-speed"), elStyle = $("hud-style");
  var elCombo = $("hud-combo"), elBail = $("hud-bail-fill"), elProg = $("hud-progress-fill");
  var elObj = $("hud-objective"), elTrick = $("hud-trick"), elCount = $("hud-countdown");
  var mini = $("minimap"), miniCtx = mini ? mini.getContext("2d") : null;
  var miniBase = null;

  function setHudVisible(v) { if (hud) hud.hidden = !v; }

  function setCountdown(t) {
    if (!elCount) return;
    if (t <= 0) { elCount.hidden = true; return; }
    elCount.hidden = false;
    elCount.textContent = t > 1.2 ? "Ready" : "Drop in!";
  }

  /* The map you ride with: the whole run drawn once, your dot moving down it. */
  function drawMinimapBase(world) {
    if (!miniCtx) return;
    var W = mini.width = 150, H = mini.height = 210;
    var c = document.createElement("canvas");
    c.width = W; c.height = H;
    var g = c.getContext("2d");
    var pts = world.trail;
    var minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (var i = 0; i < pts.length; i++) {
      if (pts[i].x < minX) minX = pts[i].x;
      if (pts[i].x > maxX) maxX = pts[i].x;
      if (pts[i].z < minZ) minZ = pts[i].z;
      if (pts[i].z > maxZ) maxZ = pts[i].z;
    }
    var pad = 12;
    var sx = (W - pad * 2) / Math.max(40, maxX - minX);
    var sz = (H - pad * 2) / Math.max(40, maxZ - minZ);
    var s = Math.min(sx, sz);
    var ox = (W - (maxX - minX) * s) / 2 - minX * s;
    var oz = pad - minZ * s;
    miniBase = { canvas: c, s: s, ox: ox, oz: oz, W: W, H: H };

    g.clearRect(0, 0, W, H);
    g.strokeStyle = "rgba(255,246,224,0.22)";
    g.lineWidth = 5; g.lineJoin = g.lineCap = "round";
    g.beginPath();
    for (i = 0; i < pts.length; i += 2) {
      var x = ox + pts[i].x * s, y = oz + pts[i].z * s;
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.stroke();
    g.strokeStyle = "rgba(255,246,224,0.75)";
    g.lineWidth = 1.6;
    g.stroke();

    /* features and checkpoints, so the map tells you what is coming */
    world.features.forEach(function (f) {
      if (!f.big) return;
      var p = pts[Math.min(pts.length - 1, f.iLip)];
      g.fillStyle = "#F7B733";
      g.beginPath();
      g.arc(ox + p.x * s, oz + p.z * s, 2.6, 0, 6.29);
      g.fill();
    });
    world.gates.forEach(function (gt) {
      var p = pts[gt];
      g.fillStyle = "rgba(255,246,224,0.6)";
      g.fillRect(ox + p.x * s - 2, oz + p.z * s - 1, 4, 2);
    });
  }

  function drawMinimap() {
    if (!miniCtx || !miniBase || !run) return;
    var b = miniBase;
    miniCtx.clearRect(0, 0, b.W, b.H);
    miniCtx.drawImage(b.canvas, 0, 0);
    var st = run.st;
    var x = b.ox + st.x * b.s, y = b.oz + st.z * b.s;
    miniCtx.fillStyle = "#E8791D";
    miniCtx.beginPath();
    miniCtx.arc(x, y, 3.4, 0, 6.29);
    miniCtx.fill();
    miniCtx.strokeStyle = "rgba(12,26,16,0.8)";
    miniCtx.lineWidth = 1.2;
    miniCtx.stroke();
  }

  var trickTimer = 0;
  function showTrick(text, pts, mult, perfect) {
    if (!elTrick) return;
    elTrick.innerHTML =
      '<span class="tk-name">' + text + "</span>" +
      (pts ? '<span class="tk-pts">+' + pts.toLocaleString() + "</span>" : "") +
      (mult > 1 ? '<span class="tk-mult">×' + mult.toFixed(2).replace(/0$/, "") + "</span>" : "") +
      (perfect ? '<span class="tk-perfect">perfect</span>' : "");
    elTrick.hidden = false;
    elTrick.classList.remove("is-pop");
    void elTrick.offsetWidth;
    elTrick.classList.add("is-pop");
    trickTimer = 1.7;
  }

  function flash(cls) {
    if (!hud) return;
    hud.classList.remove(cls);
    void hud.offsetWidth;
    hud.classList.add(cls);
  }

  function handleEvents(evs) {
    for (var i = 0; i < evs.length; i++) {
      var e = evs[i];
      AUDIO.event(e, run.st);
      if (e.t === "trick") {
        showTrick(e.name, e.pts, e.mult, e.perfect);
      } else if (e.t === "bail") {
        run.shake = 1;
        flash("is-bail");
        showTrick(bailWord(e.why), 0, 1, false);
      } else if (e.t === "land" && e.q === "hard") {
        run.shake = 0.45;
        run.dust.emit(run.st.x, run.st.y, run.st.z, 8, 2.2);
      } else if (e.t === "land") {
        run.dust.emit(run.st.x, run.st.y, run.st.z, 4, 1.4);
      } else if (e.t === "gate") {
        flash("is-gate");
      } else if (e.t === "takeoff") {
        run.dust.emit(run.st.x, run.st.y, run.st.z, 3, 1.6);
      }
    }
  }

  function bailWord(why) {
    switch (why) {
      case "rotation": return "Came up sideways";
      case "landing": return "Cased it";
      case "tree": return "Found a tree";
      case "rock": return "Found a rock";
      case "lost": return "Off the mountain";
      default: return "Down";
    }
  }

  function updateHud(dt) {
    var st = run.st, w = run.world;
    if (trickTimer > 0) {
      trickTimer -= dt;
      if (trickTimer <= 0 && elTrick) elTrick.hidden = true;
    }
    if (elTime) elTime.textContent = fmtTime(st.t);
    if (elSpeed) elSpeed.textContent = Math.round(Math.sqrt(st.vx * st.vx + st.vz * st.vz) * 3.6) + " km/h";
    if (elStyle) elStyle.textContent = Math.round(st.style).toLocaleString();
    if (elCombo) {
      var showCombo = st.combo > 1;
      elCombo.hidden = !showCombo;
      if (showCombo) {
        elCombo.textContent = "×" + (1 + 0.3 * Math.min(st.combo - 1, 12)).toFixed(2).replace(/0$/, "");
        elCombo.style.opacity = clamp(st.comboT / 1.2, 0.35, 1);
      }
    }
    if (elBail) {
      var pct = clamp(st.health / st.maxHealth, 0, 1);
      elBail.style.transform = "scaleY(" + pct + ")";
      elBail.classList.toggle("is-low", pct < 0.34);
    }
    if (elProg) elProg.style.width = (clamp(st.trailIdx / w.finishIdx, 0, 1) * 100).toFixed(1) + "%";
    if (elObj && run.node) {
      var p = CORE.objectiveProgress(run.node, st);
      elObj.querySelector(".ob-fill").style.width = (p * 100).toFixed(0) + "%";
      elObj.classList.toggle("is-met", p >= 1);
    }
    drawMinimap();
  }

  /* ---------- screens ---------- */

  var SCREENS = ["screen-map", "screen-brief", "screen-pause", "screen-results", "screen-howto"];
  function showScreen(id) {
    SCREENS.forEach(function (s) {
      var el = $(s);
      if (el) el.hidden = (s !== id);
    });
    if (id) setHudVisible(false);
  }

  function togglePause() {
    if (!run || run.over) return;
    run.paused = !run.paused;
    if (run.paused) { showScreen("screen-pause"); AUDIO.end(); }
    else if (run) AUDIO.begin();
    if (!run.paused) { showScreen(null); setHudVisible(true); }
  }

  function toggleFullscreen() {
    var stage = $("trial-stage");
    if (!stage) return;
    if (document.fullscreenElement) document.exitFullscreen();
    else if (stage.requestFullscreen) stage.requestFullscreen();
  }

  function quitToMap() {
    AUDIO.end();
    disposeScenery();
    run = null;
    setHudVisible(false);
    renderCareer();
    showScreen("screen-map");
  }

  /* ---------- results and progress ---------- */

  function recordResult(sum) {
    var node = run.node;
    if (node) {
      var met = CORE.objectiveMet(node, sum);
      sum.objectiveMet = met;
      var prev = save.done[node.id];
      if (met && !prev) {
        save.rep += node.rep;
        sum.repGained = node.rep;
      }
      if (met && (!prev || sum.style > prev.style)) {
        save.done[node.id] = { style: sum.style, time: sum.finishT, bails: sum.bails };
      }
    }
    var seedKey = String(run.cfg.seed);
    if (!save.best[seedKey] || sum.style > save.best[seedKey]) save.best[seedKey] = sum.style;
    if (run.cfg.daily) {
      var k = run.cfg.daily;
      if (!save.daily[k] || sum.style > save.daily[k]) save.daily[k] = sum.style;
    }
    persist();
  }

  function showResults(sum, reason) {
    var el = $("screen-results");
    if (!el) return;
    var node = run.node;
    var title = reason === "broken" ? "Bail bar empty" : "Run complete";
    var sub = reason === "broken"
      ? "You got " + Math.round(sum.progress * 100) + "% of the way down."
      : (node ? (sum.objectiveMet ? "Objective cleared." : "Objective missed — the mountain is still there.") : "Nice line.");

    $("res-title").textContent = title;
    $("res-sub").textContent = sub;
    $("res-title").className = "res-title" + (reason === "broken" ? " is-broken" : (!node || sum.objectiveMet ? " is-won" : ""));

    var rows = [
      ["Style", Math.round(sum.style).toLocaleString()],
      ["Time", fmtTime(sum.finishT)],
      ["Tricks landed", sum.tricks + (sum.perfects ? " (" + sum.perfects + " perfect)" : "")],
      ["Best combo", "×" + (1 + 0.3 * Math.min(Math.max(0, sum.combo - 1), 12)).toFixed(2).replace(/0$/, "")],
      ["Airtime", sum.airTotal.toFixed(1) + "s"],
      ["Top speed", Math.round(sum.topSpeed) + " km/h"],
      ["Bails", String(sum.bails)],
      ["Features cleared", sum.featHit + " of " + sum.features]
    ];
    $("res-stats").innerHTML = rows.map(function (r) {
      return '<div class="rs"><span>' + r[0] + "</span><b>" + r[1] + "</b></div>";
    }).join("");

    var extra = [];
    if (node) extra.push('<p class="res-obj">' + CORE.objectiveLabel(node) + " — " +
      (sum.objectiveMet ? '<b class="ok">cleared</b>' : '<b class="no">missed</b>') + "</p>");
    if (sum.repGained) extra.push('<p class="res-rep">+' + sum.repGained + " rep</p>");
    extra.push('<p class="res-code">Ride this mountain again: <b>' + CORE.codeFromSeed(run.cfg.seed) + "</b></p>");
    $("res-extra").innerHTML = extra.join("");

    showScreen("screen-results");
  }

  /* ---------- the career map ---------- */

  function renderCareer() {
    var host = $("career-stages");
    if (!host) return;
    var repEl = $("rep-total");
    if (repEl) repEl.textContent = save.rep.toLocaleString();

    var unlocked = 0;
    for (var s = 0; s < career.stages.length; s++) {
      var anyDone = career.stages[s].nodes.some(function (n) { return !!save.done[n.id]; });
      if (anyDone) unlocked = s + 1;
    }

    host.innerHTML = career.stages.map(function (stage, si) {
      var locked = si > unlocked;
      return '<section class="stage' + (locked ? " is-locked" : "") + '">' +
        '<header><span class="stage-n">' + (si + 1) + "</span>" +
        "<h3>" + stage.name + "</h3>" +
        (locked ? '<span class="stage-lock">Clear a run above to open</span>' : "") +
        "</header>" +
        '<div class="stage-nodes">' + stage.nodes.map(function (n) {
          var done = save.done[n.id];
          var biome = CORE.BIOMES[n.biome];
          var mod = CORE.MODIFIERS[n.modifier];
          return '<button type="button" class="node-card' + (done ? " is-done" : "") + '"' +
            (locked ? " disabled" : "") + ' data-node="' + n.id + '">' +
            '<span class="nc-code">' + n.code + "</span>" +
            '<span class="nc-where">' + biome.name + "</span>" +
            '<span class="nc-mod">' + mod.icon + " " + mod.name + "</span>" +
            '<span class="nc-obj">' + CORE.objectiveLabel(n) + "</span>" +
            '<span class="nc-meta">' + n.length + " m · +" + n.rep + " rep" +
            (done ? " · best " + done.style.toLocaleString() : "") + "</span>" +
            (done ? '<span class="nc-tick">✓</span>' : "") +
            "</button>";
        }).join("") + "</div></section>";
    }).join("");

    Array.prototype.forEach.call(host.querySelectorAll(".node-card"), function (btn) {
      on(btn, "click", function () {
        var id = btn.getAttribute("data-node");
        var node = null;
        career.stages.forEach(function (st) {
          st.nodes.forEach(function (n) { if (n.id === id) node = n; });
        });
        if (node) showBriefing(node);
      });
    });
  }

  function showBriefing(node) {
    var biome = CORE.BIOMES[node.biome];
    var mod = CORE.MODIFIERS[node.modifier];
    $("brief-where").textContent = biome.name;
    $("brief-desc").textContent = biome.desc;
    $("brief-mod").innerHTML = "<b>" + mod.icon + " " + mod.name + "</b> — " + mod.desc;
    $("brief-obj").textContent = CORE.objectiveLabel(node);
    $("brief-code").textContent = node.code;
    $("brief-meta").textContent = node.length + " m · +" + node.rep + " rep";
    pendingStart = {
      seed: node.seed, biome: node.biome, modifier: node.modifier,
      length: node.length, node: node
    };
    showScreen("screen-brief");
  }

  var pendingStart = null;

  /* ---------- free ride, daily mountain, settings ---------- */

  function fillPickers() {
    var b = $("fr-biome"), m = $("fr-mod");
    if (b) {
      b.innerHTML = CORE.BIOME_ORDER.map(function (id) {
        return '<option value="' + id + '">' + CORE.BIOMES[id].name + "</option>";
      }).join("");
    }
    if (m) {
      m.innerHTML = Object.keys(CORE.MODIFIERS).map(function (id) {
        return '<option value="' + id + '">' + CORE.MODIFIERS[id].icon + " " + CORE.MODIFIERS[id].name + "</option>";
      }).join("");
    }
  }

  function startFreeride() {
    var b = $("fr-biome"), m = $("fr-mod"), c = $("fr-code");
    var typed = c && c.value.trim();
    var seed = typed ? CORE.seedFromCode(typed) : (Math.floor(Math.random() * 0x7FFFFFFF) >>> 0);
    startRun({
      seed: seed,
      biome: b ? b.value : "nyika",
      modifier: m ? m.value : "none",
      length: 1500
    });
  }

  function startDaily() {
    var d = new Date();
    var key = "" + d.getFullYear() + (d.getMonth() + 1) + d.getDate();
    var seed = CORE.dailySeed(d);
    var biomes = CORE.BIOME_ORDER;
    var mods = ["none", "bigair", "steep", "trees", "rain", "night"];
    var rng = CORE.mulberry32(seed);
    startRun({
      seed: seed,
      biome: biomes[Math.floor(rng() * biomes.length)],
      modifier: mods[Math.floor(rng() * mods.length)],
      length: 1600,
      daily: key
    });
  }

  function syncSettingButtons() {
    var a = $("btn-assist");
    if (a) {
      a.textContent = save.settings.assist ? "🪂 Landing assist: on" : "🎯 Landing assist: off";
      a.setAttribute("aria-pressed", save.settings.assist ? "true" : "false");
    }
    var d = $("btn-detail");
    if (d) d.textContent = "✨ Detail: " + save.settings.detail;
    var snd = $("btn-sound");
    if (snd) {
      snd.textContent = save.settings.sound ? "🔊 Sound: on" : "🔇 Sound: off";
      snd.setAttribute("aria-pressed", save.settings.sound ? "true" : "false");
    }
  }

  /* ---------- wiring ---------- */

  fillPickers();
  syncSettingButtons();
  renderCareer();
  showScreen("screen-map");

  on($("btn-start"), "click", function () {
    if (pendingStart) startRun(pendingStart);
  });
  on($("btn-brief-back"), "click", function () { showScreen("screen-map"); });
  on($("btn-freeride"), "click", startFreeride);
  on($("btn-daily"), "click", startDaily);
  on($("btn-resume"), "click", togglePause);
  on($("btn-restart"), "click", function () { showScreen(null); setHudVisible(true); restartRun(); });
  on($("btn-quit"), "click", quitToMap);
  on($("btn-retry"), "click", function () { restartRun(); });
  on($("btn-map"), "click", quitToMap);
  on($("btn-fs"), "click", toggleFullscreen);
  on($("btn-howto"), "click", function () { showScreen("screen-howto"); });
  on($("btn-howto-back"), "click", function () { showScreen("screen-map"); });

  on($("btn-sound"), "click", function () {
    save.settings.sound = !save.settings.sound;
    persist();
    AUDIO.enable(save.settings.sound);
    syncSettingButtons();
  });
  on($("btn-assist"), "click", function () {
    save.settings.assist = !save.settings.assist;
    persist();
    syncSettingButtons();
  });
  on($("btn-detail"), "click", function () {
    var order = ["full", "medium", "low"];
    var i = order.indexOf(save.settings.detail);
    save.settings.detail = order[(i + 1) % order.length];
    persist();
    syncSettingButtons();
    buildComposer();
    if (run) restartRun();
  });

  /* on-screen controls for tablets — the same inputs, bigger targets */
  [["tc-pedal", "pedal"], ["tc-brake", "brake"], ["tc-left", "left"],
   ["tc-right", "right"], ["tc-hop", "hop"], ["tc-whipl", "whipL"], ["tc-whipr", "whipR"]
  ].forEach(function (pair) {
    var el = $(pair[0]);
    if (!el) return;
    var set = function (v) { return function (e) { touch[pair[1]] = v; e.preventDefault(); }; };
    el.addEventListener("pointerdown", set(true));
    el.addEventListener("pointerup", set(false));
    el.addEventListener("pointercancel", set(false));
    el.addEventListener("pointerleave", set(false));
  });
  if (window.matchMedia && window.matchMedia("(pointer: coarse)").matches) {
    var tc = $("touch-controls");
    if (tc) tc.hidden = false;
  }

  AUDIO.enable(save.settings.sound !== false);
  ["pointerdown", "keydown", "touchstart"].forEach(function (evName) {
    window.addEventListener(evName, function once() {
      AUDIO.unlock();
      window.removeEventListener(evName, once);
    }, { passive: true });
  });

  buildComposer();
  resize();
  clock.start();
  requestAnimationFrame(frame);

  /* let the page ask us to boot straight into a mountain (used by tests and
     by the "ride this code" links on the rest of the site) */
  window.TRIAL_START = function (cfg) { startRun(cfg); };
  window.TRIAL_DEBUG = function () { return { run: run, scenery: scenery, save: save, THREE: THREE, camera: camera, renderer: renderer }; };
  window.TRIAL_SKIP_COUNTDOWN = function () { if (run) run.countdown = 0; };
  window.TRIAL_CLOSEUP = function (dist, height) {
    if (!run) return;
    run.paused = true;
    var st = run.st;
    camera.position.set(st.x + dist, st.y + (height || 1.2), st.z - dist * 0.35);
    camera.lookAt(st.x, st.y + 0.9, st.z);
    if (composer) composer.render(); else renderer.render(scene, camera);
  };
})();
