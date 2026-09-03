/* ==========================================================================
   ORBIT — Three.js renderer + game controller

   The belt and everything that happens in it live in js/orbit-core.js
   (window.ORBIT). This file draws that world, wires the controls, and runs
   the survey career. Same club promises as the rest of the site: no chat, no
   accounts, no strangers — your progress lives in this browser and nowhere
   else.

   Nothing is fetched: the stars, the nebula, the planet below and every rock
   surface are drawn onto canvases at load time, so the game ships with no
   image files at all.
   ========================================================================== */

import * as THREE from "three";
import { EffectComposer } from "./vendor/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "./vendor/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "./vendor/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "./vendor/addons/postprocessing/OutputPass.js";
import { FXAAPass } from "./vendor/addons/postprocessing/FXAAPass.js";

(function () {
  "use strict";

  var CORE = window.ORBIT;
  var AUDIO = window.ORBIT_AUDIO || {
    unlock: function () {}, enable: function () {}, isEnabled: function () { return false; },
    begin: function () {}, end: function () {}, update: function () {},
    event: function () {}, countdown: function () {}
  };
  var canvas = document.getElementById("orbit-canvas");
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

  var SAVE_KEY = "zb-orbit-v1";
  var save = lsGet(SAVE_KEY, null) || {
    careerSeed: 20260101,
    rep: 0,
    done: {},
    best: {},
    settings: { assist: true, sound: true, detail: "full", ship: "kite" }
  };
  if (!save.settings) save.settings = { assist: true, sound: true, detail: "full", ship: "kite" };
  if (!save.settings.ship) save.settings.ship = "kite";
  if (!save.done) save.done = {};
  if (!save.best) save.best = {};

  function persist() { lsSet(SAVE_KEY, save); }

  var career = CORE.makeCareer(save.careerSeed);

  /* the hull on the pad, never one the rep has not earned yet */
  function currentShip() {
    var owned = CORE.shipsFor(save.rep);
    if (owned.indexOf(save.settings.ship) < 0) save.settings.ship = owned[owned.length - 1] || "kite";
    return save.settings.ship;
  }

  /* ---------- renderer ---------- */

  var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: false, powerPreference: "high-performance" });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0x05070E, 1);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.85;

  var scene = new THREE.Scene();
  var camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.4, 60000);
  var composer = null, bloomPass = null, renderPass = null;

  function pixelRatioFor(detail) {
    var dpr = window.devicePixelRatio || 1;
    if (detail === "low") return Math.min(1, dpr);
    if (detail === "medium") return Math.min(1.35, dpr);
    return Math.min(1.75, dpr);
  }

  var overlay = $("hud-canvas");
  var octx = overlay ? overlay.getContext("2d") : null;

  function resize() {
    var w = canvas.clientWidth || 960;
    var h = canvas.clientHeight || 540;
    renderer.setPixelRatio(pixelRatioFor(save.settings.detail));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (composer) composer.setSize(w, h);
    syncBloom(w);
    if (overlay) { overlay.width = w; overlay.height = h; }
  }
  window.addEventListener("resize", resize);

  var bloomBase = 1;

  /* UnrealBloom builds its blur from a mip chain, so on a phone-sized stage
     the top mip is a handful of pixels and the whole picture turns into one
     soft wash. Small canvas, less bloom. */
  function syncBloom(w) {
    if (!bloomPass) return;
    var width = w || canvas.clientWidth || 960;
    bloomPass.strength = 0.5 * bloomBase * (width < 640 ? 0.42 : 1);
  }

  function buildComposer() {
    if (composer) { composer.dispose && composer.dispose(); composer = null; }
    if (save.settings.detail === "low") { bloomPass = null; return; }
    composer = new EffectComposer(renderer);
    renderPass = new RenderPass(scene, camera);
    composer.addPass(renderPass);
    if (save.settings.detail === "full") {
      /* space is mostly black, so the bloom is the picture, not a garnish */
      bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.5 * bloomBase, 0.55, 0.7);
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

  function mixHex(a, b, t) {
    var ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
    var br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
    return ((ar + (br - ar) * t) << 16 | (ag + (bg - ag) * t) << 8 | (ab + (bb - ab) * t)) & 0xFFFFFF;
  }

  function noiseCanvas(size, fn) {
    var c = document.createElement("canvas");
    c.width = c.height = size;
    var g = c.getContext("2d");
    var img = g.createImageData(size, size);
    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++) {
        var i = (y * size + x) * 4;
        var rgb = fn(x / size, y / size);
        img.data[i] = rgb[0]; img.data[i + 1] = rgb[1]; img.data[i + 2] = rgb[2];
        img.data[i + 3] = rgb.length > 3 ? rgb[3] : 255;
      }
    }
    g.putImageData(img, 0, 0);
    return c;
  }

  /* Tiling FBM: the sample point is wrapped onto a torus so the seams meet,
     which is the whole reason a rock can be textured with one 256px canvas. */
  function fbm(u, v, seed, octaves) {
    var sum = 0, amp = 1, norm = 0, f = 2;
    for (var o = 0; o < octaves; o++) {
      var a = Math.sin((u * f + seed * 0.7) * 6.2831) * Math.cos((v * f + seed * 1.3) * 6.2831);
      var b = Math.sin((u * f * 1.7 + v * f * 0.9 + seed) * 6.2831);
      sum += amp * (a * 0.6 + b * 0.4);
      norm += amp;
      amp *= 0.52; f *= 2.11;
    }
    return sum / norm;
  }

  function rockTexture(theme, veined) {
    var key = "rock" + theme.rock + (veined ? "v" : "");
    if (texCache[key]) return texCache[key];
    var base = theme.rock, dark = theme.rockDark, ore = theme.ore;
    var c = noiseCanvas(256, function (u, v) {
      var n = fbm(u, v, 3.1, 5) * 0.5 + 0.5;
      var grain = fbm(u * 4, v * 4, 8.9, 3) * 0.16;
      var col = mixHex(dark, base, clamp(n + grain, 0, 1));
      if (veined) {
        /* a copper seam is a thin bright ribbon, not a stain */
        var seam = Math.abs(fbm(u * 1.6, v * 1.6, 21.7, 4));
        if (seam < 0.09) col = mixHex(col, ore, 1 - seam / 0.09);
      }
      return [(col >> 16) & 255, (col >> 8) & 255, col & 255];
    });
    var t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    texCache[key] = t;
    return t;
  }

  /* One soft dot, used for stars, copper glints, engine sparks and the sun. */
  function dotTexture(inner, outer) {
    var key = "dot" + inner + outer;
    if (texCache[key]) return texCache[key];
    var c = document.createElement("canvas");
    c.width = c.height = 64;
    var g = c.getContext("2d");
    var grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, inner);
    grad.addColorStop(0.35, outer);
    grad.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    var t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    texCache[key] = t;
    return t;
  }

  /* The sky: banded nebula cloud on the inside of a very large sphere, with
     the sector's two colours smeared through it. */
  function nebulaTexture(theme) {
    var key = "neb" + theme.nebulaA + theme.nebulaB;
    if (texCache[key]) return texCache[key];
    var c = noiseCanvas(512, function (u, v) {
      var band = Math.pow(1 - Math.abs(v - 0.52) * 2.2, 2.2);
      var n = fbm(u * 1.4, v * 2.6, 13.3, 5) * 0.5 + 0.5;
      var m = Math.pow(clamp(n * 1.25 * clamp(band, 0, 1), 0, 1), 1.9);
      var col = mixHex(theme.space, mixHex(theme.nebulaB, theme.nebulaA, n), m);
      return [(col >> 16) & 255, (col >> 8) & 255, col & 255];
    });
    /* a handful of bright stars painted into the backdrop itself, so the
       far sky is never a flat wall behind the point stars */
    var g = c.getContext("2d");
    for (var i = 0; i < 900; i++) {
      var x = Math.random() * 512, y = Math.random() * 512;
      var r = Math.random() < 0.94 ? 0.6 : 1.5;
      g.fillStyle = "rgba(255,255,255," + (0.25 + Math.random() * 0.6).toFixed(2) + ")";
      g.beginPath(); g.arc(x, y, r, 0, 6.2832); g.fill();
    }
    var t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    texCache[key] = t;
    return t;
  }

  /* The planet below: land, sea, ice caps and a layer of cloud, all FBM. */
  function planetTexture(theme) {
    var key = "planet" + theme.planet + theme.planetSea;
    if (texCache[key]) return texCache[key];
    var c = noiseCanvas(512, function (u, v) {
      var lat = Math.abs(v - 0.5) * 2;
      var h = fbm(u * 1.1, v * 2.2, 5.5, 6) * 0.5 + 0.5;
      var col;
      if (h > 0.52) col = mixHex(theme.planet, 0xD8C79A, clamp((h - 0.52) * 2.4, 0, 1));
      else col = mixHex(theme.planetSea, mixHex(theme.planetSea, 0x0A1A2A, 0.5), clamp((0.52 - h) * 2, 0, 1));
      if (lat > 0.82) col = mixHex(col, 0xD6E2EE, clamp((lat - 0.82) * 5, 0, 1));
      var cloud = clamp(fbm(u * 2.3, v * 3.4, 17.1, 5) * 0.7 + 0.36, 0, 1);
      col = mixHex(col, 0xE8EEF6, Math.pow(cloud, 3.4) * 0.55);
      return [(col >> 16) & 255, (col >> 8) & 255, col & 255];
    });
    var t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    texCache[key] = t;
    return t;
  }

  /* Only the copper seams, on black — an emissive map, so a veined rock
     glows along its ribbons and stays dark everywhere else. */
  function veinGlowTexture(theme) {
    var key = "vglow" + theme.ore;
    if (texCache[key]) return texCache[key];
    var c = noiseCanvas(256, function (u, v) {
      var seam = Math.abs(fbm(u * 1.6, v * 1.6, 21.7, 4));
      var m = seam < 0.09 ? Math.pow(1 - seam / 0.09, 1.4) : 0;
      var col = mixHex(0x000000, theme.ore, m);
      return [(col >> 16) & 255, (col >> 8) & 255, col & 255];
    });
    var t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    texCache[key] = t;
    return t;
  }

  /* ==========================================================================
     The belt
     ========================================================================== */

  var scenery = null;          /* everything belonging to the current run */

  function disposeScenery() {
    if (!scenery) return;
    scene.remove(scenery.root);
    scene.remove(scenery.sky);
    [scenery.root, scenery.sky].forEach(function (group) {
      group.traverse(function (o) {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          var mats = Array.isArray(o.material) ? o.material : [o.material];
          for (var i = 0; i < mats.length; i++) mats[i].dispose();
        }
      });
    });
    /* the rock shapes are shared by every instanced mesh in the belt, so
       disposing the belt disposes them too — forget the cache and let the
       next sector build its own rather than hand it freed geometry */
    rockGeos = null;
    scenery = null;
  }

  /* An asteroid: a subdivided icosahedron pushed about by a hash of the
     direction each vertex points. The geometry three hands back is
     unindexed, so the same direction always moves to the same place and the
     rock stays welded — while the flat normals keep it properly faceted. */
  function rockGeometry(variant) {
    var g = new THREE.IcosahedronGeometry(1, 1);
    var pos = g.attributes.position;
    var s = 3.3 + variant * 7.1;
    for (var i = 0; i < pos.count; i++) {
      var x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      var n1 = Math.sin(x * 2.7 + s) * Math.cos(y * 3.1 - s) * Math.sin(z * 2.3 + s * 0.5);
      var n2 = Math.sin(x * 6.1 - s) * Math.sin(y * 5.3 + s) * Math.cos(z * 6.7);
      var k = 0.78 + 0.30 * n1 + 0.11 * n2;
      pos.setXYZ(i, x * k, y * k, z * k);
    }
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }

  var ROCK_VARIANTS = 4;
  var rockGeos = null;
  function rockGeoSet() {
    if (!rockGeos) {
      rockGeos = [];
      for (var i = 0; i < ROCK_VARIANTS; i++) rockGeos.push(rockGeometry(i));
    }
    return rockGeos;
  }

  /* A cloud of soft dots that can be switched off one at a time by parking
     the dead one far outside the world. Copper, seam markers and the sparks
     off a cracked rock all use it. */
  function dotCloud(count, color, size, opacity) {
    var geo = new THREE.BufferGeometry();
    var pos = new Float32Array(Math.max(1, count) * 3);
    for (var i = 0; i < pos.length; i++) pos[i] = -99999;
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    var mat = new THREE.PointsMaterial({
      color: color, map: dotTexture("rgba(255,255,255,1)", "rgba(255,190,110,0.55)"),
      size: size, transparent: true, opacity: opacity == null ? 0.95 : opacity,
      depthWrite: false, sizeAttenuation: true, blending: THREE.AdditiveBlending
    });
    var pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    return { object: pts, geo: geo, pos: pos, mat: mat };
  }

  function buildSky(world, theme) {
    var sky = new THREE.Group();

    var neb = new THREE.Mesh(
      new THREE.SphereGeometry(5000, 32, 20),
      new THREE.MeshBasicMaterial({ map: nebulaTexture(theme), side: THREE.BackSide, fog: false, depthWrite: false })
    );
    neb.renderOrder = -3;
    sky.add(neb);

    /* point stars on top of the painted ones, so the sky has depth in it */
    var N = save.settings.detail === "low" ? 900 : 2600;
    var geo = new THREE.BufferGeometry();
    var pos = new Float32Array(N * 3);
    for (var i = 0; i < N; i++) {
      var u = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2;
      var r = Math.sqrt(1 - u * u), R = 4200;
      pos[i * 3] = Math.cos(a) * r * R;
      pos[i * 3 + 1] = u * R;
      pos[i * 3 + 2] = Math.sin(a) * r * R;
    }
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    var stars = new THREE.Points(geo, new THREE.PointsMaterial({
      color: 0xFFFFFF, map: dotTexture("rgba(255,255,255,1)", "rgba(200,220,255,0.5)"),
      size: 26, transparent: true, opacity: 0.9, depthWrite: false, fog: false,
      sizeAttenuation: true, blending: THREE.AdditiveBlending
    }));
    stars.renderOrder = -2;
    sky.add(stars);

    /* the planet the whole club is standing on, a long way down */
    var planet = new THREE.Mesh(
      new THREE.SphereGeometry(1300, 48, 32),
      new THREE.MeshStandardMaterial({
        map: planetTexture(theme), color: 0x7C8794, roughness: 1, metalness: 0,
        fog: false, depthWrite: false
      })
    );
    /* Behind and below: a lit sphere this size fills the view and washes the
       belt out if you fly straight at it, and a planet you left an hour ago
       belongs over your shoulder anyway. Loop and it is there. */
    planet.position.set(-2200, -3000, -2000);
    planet.rotation.z = 0.4;
    planet.renderOrder = -1;
    sky.add(planet);

    /* and the thin bright line of its air, seen edge on. A plain translucent
       shell would be a filled disc the size of the planet — and additively
       blended, a disc that big washes the whole belt out. What air actually
       does is glow at the limb, which is a fresnel term and nothing else. */
    var air = new THREE.Mesh(
      new THREE.SphereGeometry(1352, 48, 32),
      new THREE.ShaderMaterial({
        uniforms: {
          uColor: { value: new THREE.Color(mixHex(theme.nebulaA, 0xFFFFFF, 0.45)) },
          uPower: { value: 3.4 }
        },
        vertexShader: [
          "varying vec3 vN; varying vec3 vV;",
          "void main() {",
          "  vec4 mv = modelViewMatrix * vec4(position, 1.0);",
          "  vN = normalize(normalMatrix * normal);",
          "  vV = normalize(-mv.xyz);",
          "  gl_Position = projectionMatrix * mv;",
          "}"
        ].join("\n"),
        fragmentShader: [
          "uniform vec3 uColor; uniform float uPower;",
          "varying vec3 vN; varying vec3 vV;",
          "void main() {",
          "  float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), uPower);",
          "  gl_FragColor = vec4(uColor * f, f);",
          "}"
        ].join("\n"),
        transparent: true, blending: THREE.AdditiveBlending, side: THREE.BackSide,
        depthWrite: false, fog: false
      })
    );
    air.position.copy(planet.position);
    air.renderOrder = -1;
    sky.add(air);

    /* the sun rides in the sky rig too, so its direction never changes as
       the ship travels — which is what a light-year of distance looks like */
    var sun = new THREE.DirectionalLight(theme.sun, world.dark ? 0.3 : 1.7);
    var sp = theme.sunPos;
    var sl = Math.hypot(sp[0], sp[1], sp[2]) || 1;
    sun.position.set(sp[0] / sl * 3000, sp[1] / sl * 3000, sp[2] / sl * 3000);
    sky.add(sun);
    sky.add(sun.target);

    if (!world.dark) {
      var flare = new THREE.Sprite(new THREE.SpriteMaterial({
        map: dotTexture("rgba(255,255,255,1)", "rgba(255,240,200,0.6)"),
        color: theme.sun, transparent: true, opacity: 0.9, depthWrite: false,
        fog: false, blending: THREE.AdditiveBlending
      }));
      flare.position.copy(sun.position).multiplyScalar(0.9);
      flare.scale.set(260, 260, 1);
      flare.material.opacity = 0.7;
      flare.renderOrder = -1;
      sky.add(flare);
    }

    return { group: sky, planet: planet, air: air, sun: sun };
  }

  function buildRocks(world, theme, root) {
    var geos = rockGeoSet();
    var detail = save.settings.detail;
    var plainMat = new THREE.MeshStandardMaterial({
      map: rockTexture(theme, false), roughness: 0.95, metalness: 0.06,
      color: 0xFFFFFF
    });
    var veinMat = new THREE.MeshStandardMaterial({
      map: rockTexture(theme, true), roughness: 0.82, metalness: 0.38,
      emissiveMap: veinGlowTexture(theme), emissive: 0xFFFFFF,
      emissiveIntensity: detail === "low" ? 0.45 : 0.85
    });

    var lists = [];
    var v, k;
    for (v = 0; v < ROCK_VARIANTS; v++) lists.push([[], []]);
    for (var i = 0; i < world.rocks.length; i++) {
      var r = world.rocks[i];
      lists[r.shape % ROCK_VARIANTS][r.vein ? 1 : 0].push(i);
    }

    var m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
    var pos = new THREE.Vector3(), scl = new THREE.Vector3();
    var meshes = [];
    for (v = 0; v < ROCK_VARIANTS; v++) {
      for (k = 0; k < 2; k++) {
        var list = lists[v][k];
        if (!list.length) continue;
        var inst = new THREE.InstancedMesh(geos[v], k ? veinMat : plainMat, list.length);
        inst.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(list.length * 3), 3);
        for (var j = 0; j < list.length; j++) {
          var rock = world.rocks[list[j]];
          e.set(rock.phase, rock.phase * 1.7, rock.spin * 3.1);
          q.setFromEuler(e);
          pos.set(rock.x, rock.y, rock.z);
          /* rocks are never quite round, and never quite the same colour */
          scl.set(rock.r, rock.r * (0.82 + (rock.phase % 0.4)), rock.r * (0.9 + (rock.spin % 0.3)));
          m.compose(pos, q, scl);
          inst.setMatrixAt(j, m);
          var tint = 0.72 + ((rock.phase * 7) % 1) * 0.5;
          inst.instanceColor.setXYZ(j, tint, tint * 0.99, tint * 0.95);
        }
        inst.instanceMatrix.needsUpdate = true;
        inst.frustumCulled = false;
        root.add(inst);
        meshes.push(inst);
      }
    }

    /* one glowing marker per vein, so a rock worth cutting can be picked out
       at range — and goes dark the moment it is opened */
    var veinIdx = [];
    for (var n = 0; n < world.rocks.length; n++) if (world.rocks[n].vein) veinIdx.push(n);
    var marks = dotCloud(veinIdx.length, theme.ore, 9, 0.85);
    for (var p = 0; p < veinIdx.length; p++) {
      var vr = world.rocks[veinIdx[p]];
      marks.pos[p * 3] = vr.x; marks.pos[p * 3 + 1] = vr.y; marks.pos[p * 3 + 2] = vr.z;
    }
    marks.geo.attributes.position.needsUpdate = true;
    root.add(marks.object);

    return { meshes: meshes, marks: marks, veinIdx: veinIdx, plainMat: plainMat, veinMat: veinMat };
  }

  function buildOre(world, theme, root) {
    var cloud = dotCloud(world.ore.length, theme.ore, 6.5, 1);
    for (var i = 0; i < world.ore.length; i++) {
      var o = world.ore[i];
      cloud.pos[i * 3] = o.x; cloud.pos[i * 3 + 1] = o.y; cloud.pos[i * 3 + 2] = o.z;
    }
    cloud.geo.attributes.position.needsUpdate = true;
    root.add(cloud.object);
    return cloud;
  }

  /* A survey frame: a rectangular collar, cut long one way and narrow the
     other, with a faint curtain across the opening so the slot can be read
     from a long way out. */
  function buildGates(world, theme, root) {
    var out = [];
    var basis = new THREE.Matrix4();
    var vA = new THREE.Vector3(), vB = new THREE.Vector3(), vT = new THREE.Vector3();
    for (var i = 0; i < world.gates.length; i++) {
      var g = world.gates[i];
      var t = 1.5 + g.halfH * 0.10;
      var shape = new THREE.Shape();
      shape.moveTo(-g.halfW - t, -g.halfH - t);
      shape.lineTo(g.halfW + t, -g.halfH - t);
      shape.lineTo(g.halfW + t, g.halfH + t);
      shape.lineTo(-g.halfW - t, g.halfH + t);
      shape.closePath();
      var hole = new THREE.Path();
      hole.moveTo(-g.halfW, -g.halfH);
      hole.lineTo(g.halfW, -g.halfH);
      hole.lineTo(g.halfW, g.halfH);
      hole.lineTo(-g.halfW, g.halfH);
      hole.closePath();
      shape.holes.push(hole);

      var geo = new THREE.ExtrudeGeometry(shape, { depth: 2.2, bevelEnabled: false, curveSegments: 1 });
      geo.translate(0, 0, -1.1);
      var mat = new THREE.MeshStandardMaterial({
        color: 0x27303F, emissive: theme.gate, emissiveIntensity: 1.1,
        roughness: 0.45, metalness: 0.65
      });
      var mesh = new THREE.Mesh(geo, mat);

      var curtain = new THREE.Mesh(
        new THREE.PlaneGeometry(g.halfW * 2, g.halfH * 2),
        new THREE.MeshBasicMaterial({
          color: theme.gate, transparent: true, opacity: 0.075, side: THREE.DoubleSide,
          depthWrite: false, blending: THREE.AdditiveBlending
        })
      );

      var group = new THREE.Group();
      group.add(mesh); group.add(curtain);
      group.position.set(g.x, g.y, g.z);
      vA.set(g.ax, g.ay, g.az); vB.set(g.bx, g.by, g.bz); vT.set(g.tx, g.ty, g.tz);
      basis.makeBasis(vA, vB, vT);
      group.quaternion.setFromRotationMatrix(basis);
      root.add(group);
      out.push({ group: group, mat: mat, curtain: curtain, flash: 0, state: 0 });
    }
    return out;
  }

  function buildDrifters(world, theme, root) {
    var geos = rockGeoSet();
    var mat = new THREE.MeshStandardMaterial({
      map: rockTexture(theme, false), roughness: 0.95, metalness: 0.1,
      color: mixHex(0xFFFFFF, theme.rockDark, 0.25)
    });
    var out = [];
    for (var i = 0; i < world.drifters.length; i++) {
      var d = world.drifters[i];
      var mesh = new THREE.Mesh(geos[d.shape % ROCK_VARIANTS], mat);
      mesh.scale.setScalar(d.r);
      root.add(mesh);
      out.push({ mesh: mesh, d: d });
    }
    return { list: out, mat: mat };
  }

  /* The refinery: the thing at the end of the run that all of this is for. */
  function buildRefinery(world, theme, root) {
    var group = new THREE.Group();
    var ring = new THREE.Mesh(
      new THREE.TorusGeometry(58, 3.2, 8, 48),
      new THREE.MeshStandardMaterial({
        color: 0x2A3040, emissive: 0x8FE0A2, emissiveIntensity: 1.6, roughness: 0.4, metalness: 0.6
      })
    );
    group.add(ring);
    var hullMat = new THREE.MeshStandardMaterial({ color: 0x4A5468, roughness: 0.7, metalness: 0.5 });
    var lampMat = new THREE.MeshBasicMaterial({ color: theme.ore });
    for (var i = 0; i < 7; i++) {
      var a = (i / 7) * Math.PI * 2;
      var arm = new THREE.Mesh(new THREE.BoxGeometry(9, 9, 26), hullMat);
      arm.position.set(Math.cos(a) * 74, Math.sin(a) * 74, -6 + (i % 3) * 8);
      arm.rotation.z = a;
      group.add(arm);
      var lamp = new THREE.Mesh(new THREE.SphereGeometry(1.6, 8, 6), lampMat);
      lamp.position.set(Math.cos(a) * 58, Math.sin(a) * 58, 2.4);
      group.add(lamp);
    }
    var c = world.course[world.courseN - 1];
    group.position.set(c.x, c.y, c.z);
    group.lookAt(c.x - c.tx, c.y - c.ty, c.z - c.tz);
    root.add(group);
    return group;
  }

  /* Dust in the near field: the cue that tells you how fast you are moving
     when everything else is a hundred metres away. It never runs out
     because it wraps around the ship in a box. */
  function buildMotes(theme) {
    var N = save.settings.detail === "low" ? 90 : 260;
    var SIZE = 220;
    var geo = new THREE.BufferGeometry();
    var pos = new Float32Array(N * 3);
    for (var i = 0; i < N * 3; i++) pos[i] = (Math.random() - 0.5) * SIZE;
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    var pts = new THREE.Points(geo, new THREE.PointsMaterial({
      color: theme.dust, map: dotTexture("rgba(255,255,255,0.9)", "rgba(255,255,255,0.2)"),
      size: 0.9, transparent: true, opacity: 0.5, depthWrite: false,
      sizeAttenuation: true, blending: THREE.AdditiveBlending
    }));
    pts.frustumCulled = false;
    return {
      object: pts, size: SIZE, pos: pos, n: N,
      follow: function (x, y, z) {
        var half = SIZE * 0.5, moved = false;
        for (var k = 0; k < N; k++) {
          var i3 = k * 3;
          var dx = pos[i3] - x, dy = pos[i3 + 1] - y, dz = pos[i3 + 2] - z;
          if (Math.abs(dx) > half) { pos[i3] -= Math.sign(dx) * SIZE; moved = true; }
          if (Math.abs(dy) > half) { pos[i3 + 1] -= Math.sign(dy) * SIZE; moved = true; }
          if (Math.abs(dz) > half) { pos[i3 + 2] -= Math.sign(dz) * SIZE; moved = true; }
        }
        if (moved) geo.attributes.position.needsUpdate = true;
      }
    };
  }

  function buildScenery(world) {
    disposeScenery();
    var theme = world.sector.theme;
    var root = new THREE.Group();
    scene.add(root);

    renderer.setClearColor(theme.space, 1);
    renderer.toneMappingExposure = (theme.exposure || 0.7) * (world.dark ? 0.85 : 1);
    bloomBase = theme.bloom || 1;
    syncBloom();
    scene.fog = new THREE.Fog(theme.space, theme.fogNear, theme.fogFar);

    var sky = buildSky(world, theme);
    scene.add(sky.group);
    root.add(new THREE.AmbientLight(theme.ambient, world.dark ? 0.5 : 0.7));

    var rocks = buildRocks(world, theme, root);
    var ore = buildOre(world, theme, root);
    var gates = buildGates(world, theme, root);
    var drifters = buildDrifters(world, theme, root);
    var refinery = buildRefinery(world, theme, root);
    var motes = buildMotes(theme);
    root.add(motes.object);

    /* the sparks off a rock that has just been opened */
    var sparks = dotCloud(80, mixHex(theme.ore, 0xFFFFFF, 0.4), 3.2, 1);
    root.add(sparks.object);
    var sparkLife = new Float32Array(80);
    var sparkVel = new Float32Array(80 * 3);
    var sparkPtr = 0;

    scenery = {
      root: root, sky: sky.group, skyRig: sky, theme: theme,
      rocks: rocks, ore: ore, gates: gates, drifters: drifters,
      refinery: refinery, motes: motes,
      sparks: sparks, sparkLife: sparkLife, sparkVel: sparkVel,
      emitSparks: function (x, y, z, n) {
        for (var k = 0; k < n; k++) {
          var i = sparkPtr = (sparkPtr + 1) % 80;
          sparks.pos[i * 3] = x; sparks.pos[i * 3 + 1] = y; sparks.pos[i * 3 + 2] = z;
          sparkVel[i * 3] = (Math.random() - 0.5) * 26;
          sparkVel[i * 3 + 1] = (Math.random() - 0.5) * 26;
          sparkVel[i * 3 + 2] = (Math.random() - 0.5) * 26;
          sparkLife[i] = 0.5 + Math.random() * 0.5;
        }
      },
      updateSparks: function (dt) {
        var any = false;
        for (var i = 0; i < 80; i++) {
          if (sparkLife[i] <= 0) continue;
          any = true;
          sparkLife[i] -= dt;
          if (sparkLife[i] <= 0) { sparks.pos[i * 3 + 1] = -99999; continue; }
          sparks.pos[i * 3] += sparkVel[i * 3] * dt;
          sparks.pos[i * 3 + 1] += sparkVel[i * 3 + 1] * dt;
          sparks.pos[i * 3 + 2] += sparkVel[i * 3 + 2] * dt;
        }
        if (any) sparks.geo.attributes.position.needsUpdate = true;
      }
    };
    return scenery;
  }

  /* ==========================================================================
     The ship
     ========================================================================== */

  function buildShip(hullId, theme, dark) {
    var hull = CORE.SHIPS[hullId] || CORE.SHIPS.kite;
    var rig = new THREE.Group();          /* position and attitude, from the sim */
    var bank = new THREE.Group();         /* the lean into a turn — cosmetic only */
    rig.add(bank);

    var scale = hull.span / 3.6;
    var body = new THREE.Group();
    body.scale.setScalar(scale);
    bank.add(body);

    var shellMat = new THREE.MeshStandardMaterial({ color: 0xD9DEE8, roughness: 0.42, metalness: 0.55 });
    var trimMat = new THREE.MeshStandardMaterial({ color: 0xE8791D, roughness: 0.5, metalness: 0.4 });
    var darkMat = new THREE.MeshStandardMaterial({ color: 0x2C3240, roughness: 0.6, metalness: 0.5 });

    /* the fuselage: a lathe turned on its side, so the profile runs nose to tail */
    var profile = [
      [0.02, -2.5], [0.30, -2.2], [0.52, -1.4], [0.62, -0.3],
      [0.60, 0.7], [0.44, 1.6], [0.22, 2.3], [0.02, 2.6]
    ].map(function (p) { return new THREE.Vector2(p[0], p[1]); });
    var fuse = new THREE.LatheGeometry(profile, 14);
    fuse.rotateX(Math.PI / 2);
    body.add(new THREE.Mesh(fuse, shellMat));

    /* delta wings, drawn flat and then laid down */
    var wing = new THREE.Shape();
    wing.moveTo(0.35, 1.0);
    wing.lineTo(3.6, -0.7);
    wing.lineTo(3.35, -1.5);
    wing.lineTo(0.35, -1.9);
    wing.closePath();
    var wingGeo = new THREE.ExtrudeGeometry(wing, { depth: 0.16, bevelEnabled: false, curveSegments: 1 });
    wingGeo.rotateX(-Math.PI / 2);
    var left = new THREE.Mesh(wingGeo, shellMat);
    var right = new THREE.Mesh(wingGeo, shellMat);
    right.scale.x = -1;
    body.add(left); body.add(right);

    /* the stripe every Zambia Bikes machine gets */
    var stripe = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.06, 3.4), trimMat);
    stripe.position.set(0, 0.6, 0.1);
    body.add(stripe);

    var canopy = new THREE.Mesh(
      new THREE.SphereGeometry(0.45, 14, 10),
      new THREE.MeshStandardMaterial({
        color: 0x1B4E63, roughness: 0.1, metalness: 0.2,
        transparent: true, opacity: 0.72, emissive: 0x2A9D8F, emissiveIntensity: 0.35
      })
    );
    canopy.scale.set(0.95, 0.62, 1.7);
    canopy.position.set(0, 0.42, 0.75);
    body.add(canopy);

    /* engines and their flames */
    var flames = [];
    var nacelle = new THREE.CylinderGeometry(0.30, 0.34, 1.5, 10);
    nacelle.rotateX(Math.PI / 2);
    var flameGeo = new THREE.ConeGeometry(0.26, 1.9, 10);
    flameGeo.rotateX(-Math.PI / 2);
    flameGeo.translate(0, 0, -0.95);
    for (var s = -1; s <= 1; s += 2) {
      var eng = new THREE.Mesh(nacelle, darkMat);
      eng.position.set(s * 0.86, -0.05, -1.6);
      body.add(eng);
      var flame = new THREE.Mesh(flameGeo, new THREE.MeshBasicMaterial({
        color: 0x7FD8F5, transparent: true, opacity: 0.85,
        depthWrite: false, blending: THREE.AdditiveBlending
      }));
      flame.position.set(s * 0.86, -0.05, -2.35);
      body.add(flame);
      flames.push(flame);
    }

    /* wingtip lights, the only part of the hull you can see in an eclipse */
    var lamp = [0x8FE0A2, 0xD64533];
    for (var w = 0; w < 2; w++) {
      var tip = new THREE.Mesh(
        new THREE.SphereGeometry(0.13, 8, 6),
        new THREE.MeshBasicMaterial({ color: lamp[w] })
      );
      tip.position.set((w ? 1 : -1) * 3.5, 0.06, -0.7);
      body.add(tip);
    }

    /* the cutting beam, parked until it is asked for */
    var beamGeo = new THREE.CylinderGeometry(0.10, 0.5, 1, 7, 1, true);
    beamGeo.rotateX(Math.PI / 2);
    beamGeo.translate(0, 0, 0.5);
    var beam = new THREE.Mesh(beamGeo, new THREE.MeshBasicMaterial({
      color: theme.ore, transparent: true, opacity: 0.5,
      depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide
    }));
    beam.visible = false;
    body.add(beam);

    /* the hull carries its own light: a skiff lit only by a sun somewhere
       behind it is a silhouette, and in an eclipse it is nothing at all */
    var light = new THREE.PointLight(0xCFE4FF, dark ? 5.5 : 1.4, dark ? 210 : 26, 1.5);
    light.position.set(0, 1.4, 1.2);
    body.add(light);

    return { rig: rig, bank: bank, body: body, flames: flames, beam: beam, light: light, hull: hull };
  }

  /* ---------- input ---------- */

  var keys = {};
  var touch = {
    up: false, down: false, left: false, right: false,
    rollL: false, rollR: false, boost: false, brake: false, beam: false
  };

  var KEYMAP = {
    KeyW: "up", ArrowUp: "up",
    KeyS: "down", ArrowDown: "down",
    KeyA: "left", ArrowLeft: "left",
    KeyD: "right", ArrowRight: "right",
    KeyQ: "rollL", KeyE: "rollR",
    Space: "boost",
    ShiftLeft: "brake", ShiftRight: "brake",
    KeyX: "beam"
  };

  var input = {
    up: false, down: false, left: false, right: false,
    rollL: false, rollR: false, boost: false, brake: false, beam: false
  };

  function readInput() {
    for (var k in input) {
      if (input.hasOwnProperty(k)) input[k] = !!keys[k] || !!touch[k];
    }
    return input;
  }

  /* ---------- the run ---------- */

  var run = null;               /* null when nobody is flying */
  var clock = new THREE.Clock();
  var accumulator = 0;

  function startRun(cfg) {
    var spec = CORE.makeSpec({
      seed: cfg.seed, sector: cfg.sector, modifier: cfg.modifier, length: cfg.length
    });
    var world = CORE.buildWorld(spec);
    buildScenery(world);

    var shipId = currentShip();
    var ship = buildShip(shipId, world.sector.theme, world.dark);
    scenery.root.add(ship.rig);

    var st = CORE.newShip(world, { assist: save.settings.assist, ship: shipId });

    run = {
      cfg: cfg, world: world, st: st, ship: ship,
      node: cfg.node || null,
      paused: false, over: false, countdown: 2.4,
      camPos: new THREE.Vector3(), camQ: new THREE.Quaternion(),
      shake: 0, fov: 70, bank: 0, events: [], input: null, countBeep: 3,
      autopilot: false
    };
    placeShipMesh();
    /* park the camera behind the pad before the countdown runs out */
    run.camPos.copy(ship.rig.position);
    run.camQ.copy(ship.rig.quaternion).multiply(CAM_FLIP);
    updateCamera(0.5, true);

    showScreen(null);
    setHudVisible(true);
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
    accumulator = 0;
    startRun(cfg);
  }

  function quitToMap() {
    AUDIO.end();
    disposeScenery();
    run = null;
    accumulator = 0;
    setHudVisible(false);
    if (octx && overlay) octx.clearRect(0, 0, overlay.width, overlay.height);
    renderCareer();
    showScreen("screen-map");
  }

  /* ---------- the ship mesh follows the simulation ---------- */

  function placeShipMesh() {
    var st = run.st, rig = run.ship.rig;
    rig.position.set(st.x, st.y, st.z);
    rig.quaternion.set(st.q.x, st.q.y, st.q.z, st.q.w);
  }

  function updateShipMesh(dt) {
    var st = run.st, ship = run.ship;
    placeShipMesh();

    /* the lean into a turn is drawn, not flown: the simulation keeps pitch,
       yaw and roll strictly separate, and a hull that never banks looks
       like it is on rails */
    var wantBank = clamp(-st.wy * 0.34, -0.5, 0.5);
    run.bank += (wantBank - run.bank) * Math.min(1, 6 * dt);
    ship.bank.rotation.z = run.bank;

    var throttle = st.boosting ? 1 : (run.input && run.input.brake ? 0.25 : 0.62);
    for (var i = 0; i < ship.flames.length; i++) {
      var f = ship.flames[i];
      f.scale.set(0.8 + throttle * 0.5, 0.8 + throttle * 0.5, 0.45 + throttle * 1.8);
      f.material.opacity = 0.35 + throttle * 0.55;
      f.material.color.setHex(st.boosting ? 0xFFD08A : 0x7FD8F5);
    }

    /* the beam is drawn only when it has something to bite on */
    var beam = ship.beam;
    if (st.beamOn && st.beamTarget >= 0) {
      var rock = run.world.rocks[st.beamTarget];
      var dx = rock.x - st.x, dy = rock.y - st.y, dz = rock.z - st.z;
      var dist = Math.max(2, Math.hypot(dx, dy, dz) - rock.r);
      beam.visible = true;
      /* the beam lives inside the scaled hull group, so its length is in
         hull units, not metres */
      beam.scale.set(1, 1, dist / (ship.body.scale.z || 1));
      beam.material.opacity = 0.35 + 0.4 * Math.sin(st.t * 40);
      scenery.emitSparks(rock.x, rock.y, rock.z, 1);
    } else {
      beam.visible = false;
    }
  }

  /* ---------- camera ---------- */

  var CAM_FLIP = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
  var CAM_TILT = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -0.055);
  var _camWant = new THREE.Vector3(), _camQWant = new THREE.Quaternion();

  function updateCamera(dt, snap) {
    var st = run.st, ship = run.ship;
    var fast = clamp(st.speed / Math.max(1, run.world.spec.cruise), 0, 2.2);
    var back = 11.0 + fast * 3.0 + (st.boosting ? 2.2 : 0);
    var up = 2.9 + fast * 0.45;

    /* sit behind the hull in the hull's own frame, so a roll rolls the
       whole world — the only way a belt reads as three-dimensional */
    _camWant.set(0, up, -back).applyQuaternion(ship.rig.quaternion).add(ship.rig.position);
    _camQWant.copy(ship.rig.quaternion).multiply(CAM_FLIP).multiply(CAM_TILT);

    if (snap) {
      run.camPos.copy(_camWant);
      run.camQ.copy(_camQWant);
    } else {
      run.camPos.lerp(_camWant, 1 - Math.pow(0.0009, dt));
      run.camQ.slerp(_camQWant, 1 - Math.pow(0.0016, dt));
    }

    camera.position.copy(run.camPos);
    camera.quaternion.copy(run.camQ);
    if (run.shake > 0) {
      run.shake = Math.max(0, run.shake - dt * 2.4);
      var s = run.shake * 1.1;
      camera.position.x += (Math.random() - 0.5) * s;
      camera.position.y += (Math.random() - 0.5) * s;
      camera.position.z += (Math.random() - 0.5) * s;
    }

    var wantFov = 68 + fast * 8 + (st.boosting ? 9 : 0);
    run.fov += (wantFov - run.fov) * Math.min(1, 3.4 * dt);
    if (Math.abs(camera.fov - run.fov) > 0.01) {
      camera.fov = run.fov;
      camera.updateProjectionMatrix();
    }

    if (scenery) scenery.sky.position.copy(camera.position);
  }

  /* ---------- one frame ---------- */

  var _dpos = {};

  function frame() {
    requestAnimationFrame(frame);
    var raw = clock.getDelta();
    var dt = Math.min(0.06, raw);

    if (run && !run.paused && !run.over) {
      if (run.countdown > 0) {
        /* the launch countdown is wall time, not simulated time — clamping it
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
          var inp = run.autopilot ? CORE.autoInput(run.st, run.world, { boost: true }) : readInput();
          run.input = inp;
          CORE.stepShip(run.st, inp, run.world, run.events);
          handleEvents(run.events);
          accumulator -= CORE.DT;
          steps++;
        }
      }
      updateShipMesh(dt);
      updateCamera(dt);
      updateWorld(dt);
      updateHud(dt);
      AUDIO.update(run.st, run.world, dt, run.input || {});

      if (run.st.finished) endRun("finish");
      else if (run.st.dead) endRun(run.st.deadWhy);
    } else if (run) {
      updateCamera(dt);
    }

    if (composer) composer.render();
    else renderer.render(scene, camera);
  }

  /* Everything in the belt that moves on its own: the tumbling rock, the
     frames cooling off after a thread, the sparks and the near-field dust. */
  function updateWorld(dt) {
    if (!scenery || !run) return;
    var st = run.st, world = run.world;

    for (var i = 0; i < scenery.drifters.list.length; i++) {
      var item = scenery.drifters.list[i];
      CORE.drifterAt(world, item.d, st.t, _dpos);
      item.mesh.position.set(_dpos.x, _dpos.y, _dpos.z);
      item.mesh.rotation.x += item.d.spin * dt;
      item.mesh.rotation.y += item.d.spin * 0.7 * dt;
    }

    for (var g = 0; g < scenery.gates.length; g++) {
      var gv = scenery.gates[g];
      if (gv.flash > 0) {
        gv.flash = Math.max(0, gv.flash - dt * 2.2);
        gv.mat.emissiveIntensity = 1.1 + gv.flash * 1.6;
        gv.curtain.material.opacity = 0.075 + gv.flash * 0.14;
        if (gv.flash === 0 && gv.state) {
          gv.mat.emissiveIntensity = gv.state === 1 ? 0.35 : 0.2;
          gv.curtain.material.opacity = 0.02;
        }
      }
    }

    scenery.updateSparks(dt);
    scenery.motes.follow(st.x, st.y, st.z);
    if (scenery.skyRig.planet) scenery.skyRig.planet.rotation.y += dt * 0.004;
  }

  /* ==========================================================================
     HUD, the projected markers and the screens
     ========================================================================== */

  var hud = $("hud");
  var elTime = $("hud-time"), elSpeed = $("hud-speed"), elScore = $("hud-score");
  var elCombo = $("hud-combo"), elShield = $("hud-shield-fill"), elHeat = $("hud-heat-fill");
  var elGates = $("hud-gates"), elOre = $("hud-ore"), elProg = $("hud-progress-fill");
  var elObj = $("hud-objective"), elToast = $("hud-toast"), elCount = $("hud-countdown");
  var elWarn = $("hud-warn");

  function setHudVisible(v) {
    if (hud) hud.hidden = !v;
    if (overlay) overlay.style.opacity = v ? "1" : "0";
  }

  function setCountdown(t) {
    if (!elCount) return;
    elCount.hidden = false;
    elCount.textContent = t > 1 ? String(Math.ceil(t)) : "Go!";
  }

  var toastTimer = 0;
  function toast(name, pts, mult, tag) {
    if (!elToast) return;
    var html = '<span class="tk-name">' + name + "</span>";
    if (pts) html += '<span class="tk-pts">+' + Math.round(pts).toLocaleString() + "</span>";
    if (mult && mult > 1.001) html += '<span class="tk-mult">×' + mult.toFixed(2).replace(/0$/, "") + "</span>";
    if (tag) html += '<span class="tk-perfect">' + tag + "</span>";
    elToast.innerHTML = html;
    elToast.hidden = false;
    elToast.classList.remove("is-pop");
    void elToast.offsetWidth;
    elToast.classList.add("is-pop");
    toastTimer = 1.5;
  }

  function flash(cls) {
    if (!hud) return;
    hud.classList.remove(cls);
    void hud.offsetWidth;
    hud.classList.add(cls);
    setTimeout(function () { hud.classList.remove(cls); }, 520);
  }

  function handleEvents(evs) {
    for (var i = 0; i < evs.length; i++) {
      var e = evs[i];
      AUDIO.event(e, run.st);
      var gv;
      if (e.t === "gate") {
        gv = scenery.gates[e.n];
        if (gv) {
          gv.state = 1; gv.flash = 1;
          gv.mat.emissive.setHex(e.clean ? 0x8FE0A2 : 0xFFFFFF);
        }
        toast(e.clean ? "Clean thread" : "Frame", e.clean ? 340 : 150,
          CORE.multiplier(run.st), e.clean ? "squared up" : null);
        flash("is-gate");
      } else if (e.t === "clip") {
        gv = scenery.gates[e.n];
        if (gv) { gv.state = 2; gv.flash = 1; gv.mat.emissive.setHex(0xD64533); }
      } else if (e.t === "miss") {
        gv = scenery.gates[e.n];
        if (gv) { gv.state = 2; gv.flash = 0.6; gv.mat.emissive.setHex(0xD64533); }
        toast("Frame missed", 0, 1, null);
      } else if (e.t === "hit") {
        run.shake = Math.min(1.4, 0.5 + e.force * 0.012);
        flash("is-hit");
        toast(e.kind === "frame" ? "Clipped the frame" : "Knock", 0, 1, null);
      } else if (e.t === "ore") {
        var idx = e.n * 3;
        scenery.ore.pos[idx + 1] = -99999;
        scenery.ore.geo.attributes.position.needsUpdate = true;
        flash("is-ore");
      } else if (e.t === "crack") {
        var vpos = scenery.rocks.veinIdx.indexOf(e.n);
        if (vpos >= 0) {
          scenery.rocks.marks.pos[vpos * 3 + 1] = -99999;
          scenery.rocks.marks.geo.attributes.position.needsUpdate = true;
        }
        scenery.emitSparks(e.x, e.y, e.z, 22);
        toast("Vein opened", 120 + 40 * e.ore, CORE.multiplier(run.st), "+" + e.ore + " copper");
      } else if (e.t === "overheat") {
        toast("Drive overheated", 0, 1, null);
      } else if (e.t === "bonus") {
        toast("Docked", e.pts, 1, null);
      }
    }
  }

  function downWord(why) {
    switch (why) {
      case "shield": return "Shield gone";
      case "lost": return "Lost the survey";
      default: return "Run over";
    }
  }

  function updateHud(dt) {
    var st = run.st, w = run.world;
    if (toastTimer > 0) {
      toastTimer -= dt;
      if (toastTimer <= 0 && elToast) elToast.hidden = true;
    }
    if (elTime) elTime.textContent = fmtTime(st.t);
    if (elSpeed) elSpeed.textContent = Math.round(st.speed) + " m/s";
    if (elScore) elScore.textContent = Math.round(st.score).toLocaleString();
    if (elGates) elGates.textContent = "⭕ " + st.gates + "/" + w.gates.length;
    if (elOre) elOre.textContent = "⛏️ " + st.ore;
    if (elCombo) {
      var showCombo = st.combo > 1;
      elCombo.hidden = !showCombo;
      if (showCombo) {
        elCombo.textContent = "×" + CORE.multiplier(st).toFixed(2).replace(/0$/, "");
        elCombo.style.opacity = clamp(st.comboT / 1.5, 0.35, 1);
      }
    }
    if (elShield) {
      var pct = clamp(st.shield / st.maxShield, 0, 1);
      elShield.style.transform = "scaleY(" + pct + ")";
      elShield.classList.toggle("is-low", pct < 0.3);
    }
    if (elHeat) {
      elHeat.style.transform = "scaleY(" + clamp(st.heat, 0, 1) + ")";
      elHeat.classList.toggle("is-hot", st.overheat || st.heat > 0.75);
    }
    if (elProg) elProg.style.width = (clamp(st.progress, 0, 1) * 100).toFixed(1) + "%";
    if (elWarn) elWarn.hidden = !st.stray;
    if (elObj && run.node) {
      var p = CORE.objectiveProgress(run.node, st);
      elObj.querySelector(".ob-fill").style.width = (p * 100).toFixed(0) + "%";
      elObj.classList.toggle("is-met", p >= 1);
    }
    drawOverlay();
  }

  /* ---------- the markers drawn over the belt ----------
     A frame two hundred metres out is a few pixels of glowing rectangle, and
     which way its slot lies is the one thing you need to know early. So the
     next frames are projected onto the HUD as the real rectangle, at the real
     angle, with the range under them — and an arrow at the edge of the screen
     when one is behind you. */

  var _pC = new THREE.Vector3(), _pA = new THREE.Vector3(), _pB = new THREE.Vector3();
  var _scr = { x: 0, y: 0, behind: false, cx: 0, cy: 0 };
  var _hudLat = {};

  /* The camera's inverse matrix is only rebuilt inside render(), and the HUD
     is drawn before it — so rebuild it here rather than mark last frame's
     frames on this frame's screen. */
  function syncCameraMatrices() {
    camera.updateMatrixWorld();
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
  }

  function project(x, y, z) {
    _pC.set(x, y, z).applyMatrix4(camera.matrixWorldInverse);
    _scr.behind = _pC.z > -0.1;              /* the camera looks down -z */
    _scr.cx = _pC.x; _scr.cy = _pC.y;
    _pC.applyMatrix4(camera.projectionMatrix);   /* the perspective divide is in there */
    _scr.x = (_pC.x * 0.5 + 0.5) * overlay.width;
    _scr.y = (-_pC.y * 0.5 + 0.5) * overlay.height;
    return _scr;
  }

  function copyScreen(src, out) {
    out = out || _sC;
    out.x = src.x; out.y = src.y; out.behind = src.behind;
    return out;
  }

  var _sC = { x: 0, y: 0, behind: false }, _sA = { x: 0, y: 0 }, _sB = { x: 0, y: 0 };

  function drawOverlay() {
    if (!octx || !overlay || !run) return;
    var W = overlay.width, H = overlay.height;
    octx.clearRect(0, 0, W, H);
    syncCameraMatrices();
    var st = run.st, world = run.world;
    var theme = world.sector.theme;

    for (var k = 0; k < 2; k++) {
      var g = world.gates[st.gateNext + k];
      if (!g) break;
      var dist = g.z - st.z;
      if (dist < 0 || dist > 900) continue;

      var lead = k === 0;
      var c = copyScreen(project(g.x, g.y, g.z));

      if (c.behind) {
        if (!lead) continue;
        /* behind the wing: a chevron at the edge of the screen, pointing the
           way you have to come back round */
        var side = _scr.cx > 0 ? -1 : 1;
        var ex = side < 0 ? W - 26 : 26, ey = H * 0.5;
        octx.save();
        octx.fillStyle = "rgba(255,140,80,0.8)";
        octx.beginPath();
        octx.moveTo(ex - side * 9, ey - 14);
        octx.lineTo(ex + side * 11, ey);
        octx.lineTo(ex - side * 9, ey + 14);
        octx.closePath(); octx.fill();
        octx.restore();
        continue;
      }

      var a = copyScreen(project(g.x + g.ax * g.halfW, g.y + g.ay * g.halfW, g.z + g.az * g.halfW), _sA);
      var b = copyScreen(project(g.x + g.bx * g.halfH, g.y + g.by * g.halfH, g.z + g.bz * g.halfH), _sB);
      var aux = a.x - c.x, auy = a.y - c.y;
      var bvx = b.x - c.x, bvy = b.y - c.y;

      octx.save();
      octx.lineWidth = lead ? 2.4 : 1.2;
      octx.strokeStyle = lead ? "rgba(220,240,255,0.92)" : "rgba(180,205,230,0.4)";
      octx.beginPath();
      octx.moveTo(c.x - aux - bvx, c.y - auy - bvy);
      octx.lineTo(c.x + aux - bvx, c.y + auy - bvy);
      octx.lineTo(c.x + aux + bvx, c.y + auy + bvy);
      octx.lineTo(c.x - aux + bvx, c.y - auy + bvy);
      octx.closePath();
      octx.stroke();

      if (lead) {
        /* the two long edges, drawn heavy: this is the axis to line the
           wings up with, and it is the whole skill of the game */
        octx.lineWidth = 4;
        octx.strokeStyle = "rgba(255,183,51,0.95)";
        octx.beginPath();
        octx.moveTo(c.x - aux - bvx, c.y - auy - bvy);
        octx.lineTo(c.x + aux - bvx, c.y + auy - bvy);
        octx.moveTo(c.x - aux + bvx, c.y - auy + bvy);
        octx.lineTo(c.x + aux + bvx, c.y + auy + bvy);
        octx.stroke();

        octx.fillStyle = "rgba(220,240,255,0.85)";
        octx.font = "600 12px Nunito, Verdana, sans-serif";
        octx.textAlign = "center";
        octx.fillText(Math.round(dist) + " m", c.x, c.y + Math.abs(bvy) + Math.abs(auy) * 0 + 20);
      }
      octx.restore();
    }

    /* the rock the beam has hold of */
    if (st.beamOn && st.beamTarget >= 0) {
      var rock = world.rocks[st.beamTarget];
      var rp = project(rock.x, rock.y, rock.z);
      if (!rp.behind) {
        octx.save();
        octx.strokeStyle = "rgba(255,163,60,0.9)";
        octx.lineWidth = 2;
        octx.beginPath();
        octx.arc(rp.x, rp.y, 14 + 6 * Math.sin(st.t * 18), 0, 6.2832);
        octx.stroke();
        octx.strokeStyle = "rgba(255,220,140,0.95)";
        octx.lineWidth = 3;
        octx.beginPath();
        octx.arc(rp.x, rp.y, 20, -1.5708, -1.5708 + 6.2832 * clamp(st.beamT / CORE.BEAM_TIME, 0, 1));
        octx.stroke();
        octx.restore();
      }
    }

    /* where the ship sits in the corridor, bottom right */
    var lat = CORE.lateralOf(world, st.x, st.y, st.z, _hudLat);
    var cx = W - 52, cy = H - 52, rad = 30;
    octx.save();
    octx.strokeStyle = "rgba(180,205,230,0.35)";
    octx.lineWidth = 1.5;
    octx.beginPath(); octx.arc(cx, cy, rad, 0, 6.2832); octx.stroke();
    octx.beginPath(); octx.arc(cx, cy, 2, 0, 6.2832);
    octx.fillStyle = "rgba(180,205,230,0.5)"; octx.fill();
    var f = clamp(lat.d / world.corridor, 0, 1.35);
    var ang = Math.atan2(lat.v, lat.u);
    octx.fillStyle = f > 1 ? "rgba(214,69,51,0.95)" : "rgba(" + [(theme.gate >> 16) & 255, (theme.gate >> 8) & 255, theme.gate & 255].join(",") + ",0.95)";
    octx.beginPath();
    octx.arc(cx + Math.cos(ang) * f * rad, cy - Math.sin(ang) * f * rad, 4, 0, 6.2832);
    octx.fill();
    octx.restore();
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
    else { AUDIO.begin(); showScreen(null); setHudVisible(true); }
  }

  function toggleFullscreen() {
    var stage = $("orbit-stage");
    if (!stage) return;
    if (document.fullscreenElement) document.exitFullscreen();
    else if (stage.requestFullscreen) stage.requestFullscreen();
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
      if (met && (!prev || sum.score > prev.score)) {
        save.done[node.id] = { score: sum.score, time: sum.finishT, hits: sum.hits };
      }
    }
    var seedKey = String(run.cfg.seed);
    if (!save.best[seedKey] || sum.score > save.best[seedKey]) save.best[seedKey] = sum.score;
    persist();
  }

  function showResults(sum, reason) {
    var el = $("screen-results");
    if (!el) return;
    var node = run.node;
    var down = reason !== "finish";
    var title = down ? downWord(reason) : "Docked";
    var sub = down
      ? "You made it " + Math.round(sum.progress * 100) + "% of the way out."
      : (node ? (sum.objectiveMet ? "Objective cleared." : "Objective missed — the belt is still there.") : "Good flying.");

    $("res-title").textContent = title;
    $("res-sub").textContent = sub;
    $("res-title").className = "res-title" + (down ? " is-broken" : (!node || sum.objectiveMet ? " is-won" : ""));

    var rows = [
      ["Score", sum.score.toLocaleString()],
      ["Time", fmtTime(sum.finishT)],
      ["Frames", sum.gates + " of " + sum.gatesTotal + (sum.gatesClean ? " (" + sum.gatesClean + " clean)" : "")],
      ["Copper", String(sum.ore)],
      ["Veins opened", String(sum.cracks)],
      ["Best combo", "×" + (1 + 0.2 * Math.min(sum.combo, 15)).toFixed(2).replace(/0$/, "")],
      ["Knocks", String(sum.hits)],
      ["Top speed", Math.round(sum.topSpeed) + " m/s"]
    ];
    $("res-stats").innerHTML = rows.map(function (r) {
      return '<div class="rs"><span>' + r[0] + "</span><b>" + r[1] + "</b></div>";
    }).join("");

    var extra = [];
    if (node) extra.push('<p class="res-obj">' + CORE.objectiveLabel(node) + " — " +
      (sum.objectiveMet ? '<b class="ok">cleared</b>' : '<b class="no">missed</b>') + "</p>");
    if (sum.repGained) extra.push('<p class="res-rep">+' + sum.repGained + " rep</p>");
    if (!save.settings.assist) extra.push('<p class="res-walk">Flown on free drift — every point worth a quarter more</p>');
    extra.push('<p class="res-code">Fly this belt again: <b>' + CORE.codeFromSeed(run.cfg.seed) + "</b></p>");
    $("res-extra").innerHTML = extra.join("");

    showScreen("screen-results");
  }

  /* ---------- the survey map ---------- */

  function renderCareer() {
    var host = $("career-stages");
    if (!host) return;
    var repEl = $("rep-total");
    if (repEl) repEl.textContent = save.rep.toLocaleString();
    renderShips();

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
          var sector = CORE.SECTORS[n.sector];
          var mod = CORE.MODIFIERS[n.modifier];
          return '<button type="button" class="node-card' + (done ? " is-done" : "") + '"' +
            (locked ? " disabled" : "") + ' data-node="' + n.id + '">' +
            '<span class="nc-code">' + n.code + "</span>" +
            '<span class="nc-where">' + sector.name + "</span>" +
            '<span class="nc-mod">' + mod.icon + " " + mod.name + "</span>" +
            '<span class="nc-obj">' + CORE.objectiveLabel(n) + "</span>" +
            '<span class="nc-meta">' + (n.length / 1000).toFixed(1) + " km · +" + n.rep + " rep" +
            (done ? " · best " + done.score.toLocaleString() : "") + "</span>" +
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

  function renderShips() {
    var host = $("ship-picker");
    if (!host) return;
    var owned = CORE.shipsFor(save.rep);
    var chosen = currentShip();
    host.innerHTML = CORE.SHIP_ORDER.map(function (id) {
      var s = CORE.SHIPS[id];
      var have = owned.indexOf(id) >= 0;
      return '<button type="button" class="ship-card' + (id === chosen ? " is-selected" : "") + '"' +
        (have ? "" : " disabled") + ' data-ship="' + id + '">' +
        '<span class="sc-name">' + s.name + "</span>" +
        '<span class="sc-tag">' + s.tag + "</span>" +
        '<span class="sc-desc">' + s.desc + "</span>" +
        (have ? "" : '<span class="sc-lock">🔒 ' + s.rep.toLocaleString() + " rep to earn</span>") +
        "</button>";
    }).join("");
    Array.prototype.forEach.call(host.querySelectorAll(".ship-card"), function (btn) {
      on(btn, "click", function () {
        save.settings.ship = btn.getAttribute("data-ship");
        persist();
        renderShips();
      });
    });
  }

  var pendingStart = null;

  function showBriefing(node) {
    var sector = CORE.SECTORS[node.sector];
    var mod = CORE.MODIFIERS[node.modifier];
    $("brief-where").textContent = sector.name;
    $("brief-desc").textContent = sector.desc;
    $("brief-mod").innerHTML = "<b>" + mod.icon + " " + mod.name + "</b> — " + mod.desc;
    $("brief-obj").textContent = CORE.objectiveLabel(node);
    $("brief-code").textContent = node.code;
    var spec = CORE.makeSpec({ seed: node.seed, sector: node.sector, modifier: node.modifier, length: node.length });
    $("brief-meta").textContent = (spec.length / 1000).toFixed(1) + " km · " +
      CORE.gateCountFor(spec) + " frames · +" + node.rep + " rep";
    var shipEl = $("brief-ship");
    if (shipEl) {
      shipEl.textContent = "🚀 Flying the " + CORE.SHIPS[currentShip()].name +
        (save.settings.assist ? "" : " — free drift");
    }
    pendingStart = {
      seed: node.seed, sector: node.sector, modifier: node.modifier,
      length: node.length, node: node
    };
    showScreen("screen-brief");
  }

  /* ---------- free flight, today's belt, settings ---------- */

  function fillPickers() {
    var b = $("fr-sector"), m = $("fr-mod");
    if (b) {
      b.innerHTML = CORE.SECTOR_ORDER.map(function (id) {
        return '<option value="' + id + '">' + CORE.SECTORS[id].name + "</option>";
      }).join("");
    }
    if (m) {
      m.innerHTML = Object.keys(CORE.MODIFIERS).map(function (id) {
        return '<option value="' + id + '">' + CORE.MODIFIERS[id].icon + " " + CORE.MODIFIERS[id].name + "</option>";
      }).join("");
    }
  }

  function startFreeflight() {
    var b = $("fr-sector"), m = $("fr-mod"), c = $("fr-code");
    var typed = c && c.value.trim();
    var seed = (typed && CORE.seedFromCode(typed)) || CORE.randomSeed();
    startRun({
      seed: seed,
      sector: b ? b.value : "kariba",
      modifier: m ? m.value : "none",
      length: 3400
    });
  }

  function startDaily() {
    var d = new Date();
    var seed = CORE.dailySeed(d);
    var rng = CORE.mulberry32(seed);
    var mods = ["none", "dense", "swarm", "squall", "eclipse", "sprint"];
    startRun({
      seed: seed,
      sector: CORE.SECTOR_ORDER[Math.floor(rng() * CORE.SECTOR_ORDER.length)],
      modifier: mods[Math.floor(rng() * mods.length)],
      length: 3600
    });
  }

  function syncSettingButtons() {
    var a = $("btn-assist");
    if (a) {
      a.textContent = save.settings.assist ? "🪶 Flight assist: on" : "🛰️ Flight assist: off";
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

  fillPickers();
  syncSettingButtons();
  renderCareer();
  showScreen("screen-map");

  on($("btn-start"), "click", function () {
    if (pendingStart) startRun(pendingStart);
  });
  on($("btn-brief-back"), "click", function () { showScreen("screen-map"); });
  on($("btn-freeride"), "click", startFreeflight);
  on($("btn-daily"), "click", startDaily);
  on($("btn-resume"), "click", togglePause);
  on($("btn-restart"), "click", function () { showScreen(null); setHudVisible(true); restartRun(); });
  on($("btn-quit"), "click", quitToMap);
  on($("btn-retry"), "click", function () { showScreen(null); setHudVisible(true); restartRun(); });
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
  [["tc-up", "up"], ["tc-down", "down"], ["tc-left", "left"], ["tc-right", "right"],
   ["tc-rolll", "rollL"], ["tc-rollr", "rollR"], ["tc-boost", "boost"],
   ["tc-brake", "brake"], ["tc-beam", "beam"]
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

  /* let the page ask us to launch straight into a belt (used by the smoke
     test and by the "fly this code" links on the rest of the site) */
  window.ORBIT_START = function (cfg) { startRun(cfg); };
  window.ORBIT_DEBUG = function () { return { run: run, scenery: scenery, save: save, THREE: THREE, camera: camera, renderer: renderer }; };
  window.ORBIT_SKIP_COUNTDOWN = function () { if (run) run.countdown = 0; };
  /* the reference pilot from the core, flying for you — the same one the
     test suite uses to prove every belt can be flown */
  window.ORBIT_AUTOPILOT = function (on) { if (run) run.autopilot = on !== false; };
})();
