/* ==========================================================================
   ZAMBIA RUSH 3D — Three.js renderer + game controller
   The simulation itself lives in js/game3d-core.js (window.ZR3); this file
   only draws the world and wires the UI. Same club promises as everywhere:
   no chat, no accounts, ghosts instead of strangers.
   ========================================================================== */

import * as THREE from "./vendor/three.module.min.js";

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

  var camera = new THREE.PerspectiveCamera(68, 16 / 9, 0.1, 900);

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

  /* ---------- rider / bike model ---------- */

  function lam(color) { return new THREE.MeshLambertMaterial({ color: color }); }

  function buildRiderMesh(jerseyHex) {
    var gp = new THREE.Group();
    var dark = lam(0x241505), frameM = lam(0x2B1B10), jersey = lam(jerseyHex),
      skin = lam(0x8C5A33), helmet = lam(0xE8791D), shorts = lam(0x43290F);

    var wheelG = new THREE.TorusGeometry(0.34, 0.055, 8, 18);
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
    var wheelB = wheel(); wheelB.position.set(0, 0.34, -0.52);
    var wheelF = wheel(); wheelF.position.set(0, 0.34, 0.52);

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
    var legL = tube(V(-0.09, 0.72, -0.12), V(-0.13, 0.36, -0.02), 0.055, shorts);
    var legR = tube(V(0.09, 0.72, -0.12), V(0.13, 0.38, -0.08), 0.055, shorts);
    rider.add(torso, head, helm, armL, armR, legL, legR);

    gp.add(wheelB, wheelF, frame, bars, seat, crank, rider);

    /* soft blob shadow */
    var blob = new THREE.Mesh(
      new THREE.CircleGeometry(0.75, 14),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28, depthWrite: false })
    );
    blob.rotation.x = -Math.PI / 2;
    blob.position.y = 0.02;
    gp.add(blob);

    return { group: gp, wheelF: wheelF, wheelB: wheelB, crank: crank, rider: rider, blob: blob };
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
    var scene = new THREE.Scene();
    scene.background = new THREE.Color(T.sky);
    scene.fog = new THREE.Fog(T.fog, T.fogNear, lightMode ? T.fogFar * 0.75 : T.fogFar);

    scene.add(new THREE.HemisphereLight(T.sky, T.hemiGround || T.dirtDark, T.hemiI || 0.95));
    var sun = new THREE.DirectionalLight(T.sun, T.sunI || 1.35);
    sun.position.set(T.sunPos[0], T.sunPos[1], T.sunPos[2]);
    scene.add(sun);
    var amb = new THREE.AmbientLight(T.ambient, T.ambI || 0.35);
    scene.add(amb);

    /* sun disc */
    var sunSp = new THREE.Sprite(new THREE.SpriteMaterial({ map: sunTex, transparent: true, depthWrite: false, fog: false }));
    sunSp.scale.set(160, 160, 1);
    sunSp.position.set(T.sunPos[0] * 2.4, T.sunPos[1] * 2.0, T.sunPos[2] * 2.4);
    scene.add(sunSp);

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
        if (d < 2.6) tmp.copy(cDirt).lerp(cDirtD, 0.35 + nse * 0.2);
        else if (d < 6.5) tmp.copy(cDirt).lerp(cGrass, (d - 2.6) / 3.9);
        else {
          tmp.copy(cGrass).lerp(cDry, 0.5 + nse * 0.45);
          if (sl > 0.55) tmp.lerp(cRock, (sl - 0.55) * 1.6);
        }
        colors[vi * 3] = tmp.r; colors[vi * 3 + 1] = tmp.g; colors[vi * 3 + 2] = tmp.b;
      }
    }
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    var terrain = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }));
    scene.add(terrain);

    /* ---- instanced props ---- */
    var density = lightMode ? 0.55 : 1;
    var parts = {};  /* type -> array of {geo, mat, yOff, sMul} pieces */
    function piece(g2, m2, y2, s2) { return { geo: g2, mat: m2, y: y2 || 0, s: s2 || 1 }; }
    var trunkM = lam(T.trunk), canM = lam(T.canopy), can2M = lam(T.canopy2), rockM = lam(T.rock);

    parts.miombo = [
      piece(new THREE.CylinderGeometry(0.14, 0.22, 3.4, 6), trunkM, 1.7),
      piece(new THREE.SphereGeometry(2.0, 8, 6).scale(1, 0.55, 1), canM, 3.6),
      piece(new THREE.SphereGeometry(1.3, 7, 5).scale(1, 0.5, 1), can2M, 3.0, 0.9)
    ];
    parts.baobab = [
      piece(new THREE.CylinderGeometry(0.9, 1.5, 5.2, 8), trunkM, 2.6),
      piece(new THREE.SphereGeometry(2.4, 8, 6).scale(1, 0.42, 1), can2M, 5.6),
      piece(new THREE.CylinderGeometry(0.16, 0.3, 1.6, 5), trunkM, 5.6, 1)
    ];
    parts.acacia = [
      piece(new THREE.CylinderGeometry(0.12, 0.2, 2.8, 6), trunkM, 1.4),
      piece(new THREE.ConeGeometry(2.4, 0.8, 8), canM, 3.0)
    ];
    parts.palm = [
      piece(new THREE.CylinderGeometry(0.12, 0.2, 3.6, 6), trunkM, 1.8),
      piece(new THREE.ConeGeometry(1.5, 1.2, 6).scale(1, -1, 1), canM, 4.1)
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
        }
        im.instanceMatrix.needsUpdate = true;
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
        scene.add(g2);
      }
    });

    /* ---- coins ---- */
    var coinGeo = new THREE.CylinderGeometry(0.42, 0.42, 0.09, 14);
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

    /* ---- clouds ---- */
    var clouds = [];
    if (!lightMode) {
      var cloudTex = radialSprite("rgba(255,250,235,0.85)", "rgba(255,250,235,0)", 128);
      for (var ci = 0; ci < 8; ci++) {
        var sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: cloudTex, transparent: true, depthWrite: false, opacity: 0.8 }));
        var sc = 60 + (ci * 37) % 60;
        sp.scale.set(sc * 2.2, sc, 1);
        sp.position.set(((ci * 131) % 400) - 200, 90 + (ci * 23) % 60, (ci / 8) * world.trail[world.trailN - 1].z);
        scene.add(sp);
        clouds.push(sp);
      }
    }

    /* ---- Mosi Falls set piece ---- */
    var wf = null;
    if (id === "falls") {
      wf = new THREE.Group();
      var mid = world.trail[Math.floor(world.trailN * 0.45)];
      var wfx = mid.x + 62, wfz = mid.z;
      var wallH = 58;
      var water = new THREE.Mesh(new THREE.BoxGeometry(20, wallH, 2),
        new THREE.MeshLambertMaterial({ color: 0xF3FBFA, emissive: 0x9BC8C2 }));
      water.position.set(0, wallH / 2 - 6, 0);
      wf.add(water);
      wf.streaks = [];
      for (var si = 0; si < 7; si++) {
        var st2 = new THREE.Mesh(new THREE.BoxGeometry(1.6, 9, 0.5),
          new THREE.MeshLambertMaterial({ color: 0xBDE8E2 }));
        st2.position.set(-8 + si * 2.7, ((si * 13) % wallH) - 6, 1.1);
        wf.add(st2);
        wf.streaks.push(st2);
      }
      wf.mists = [];
      for (var mi = 0; mi < 5; mi++) {
        var m2 = new THREE.Sprite(new THREE.SpriteMaterial({ map: mistTex, transparent: true, opacity: 0.5, depthWrite: false }));
        m2.scale.set(26 + mi * 6, 12 + mi * 2, 1);
        m2.position.set(-6 + mi * 4, -4 + (mi % 2) * 3, 4 + mi);
        wf.add(m2);
        wf.mists.push(m2);
      }
      /* rainbow arcs */
      var rcols = [0xE8791D, 0xF7B733, 0x2A9D8F];
      for (var ri = 0; ri < 3; ri++) {
        var arc = new THREE.Mesh(new THREE.TorusGeometry(16 - ri * 1.2, 0.35, 6, 24, Math.PI),
          new THREE.MeshBasicMaterial({ color: rcols[ri], transparent: true, opacity: 0.5 }));
        arc.position.set(-4, -4, 8);
        wf.add(arc);
      }
      wf.position.set(wfx, CORE.heightAt(world, wfx, wfz), wfz);
      wf.rotation.y = -Math.PI / 2.3;
      wf.wallH = wallH;
      scene.add(wf);
    }

    var cached = { scene: scene, coinMesh: coinMesh, clouds: clouds, wf: wf };
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
    playerRig = buildRiderMesh(new THREE.Color(profile.jersey || "#1F7A48").getHex());
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
    run = {
      b: b, st: st, taken: new Array(world.coins.length),
      recorder: [], step: 0, ghosts: ghosts, countT: 2.7, endT: 0, lastBeep: 3,
      practice: practice
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
      list.push({ name: name, timeMs: timeMs, score: st.score });
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
      '<p class="results-note">Armand: ' + fmtTime(wc.armand.timeMs) + " · Arthur: " + fmtTime(wc.arthur.timeMs) +
      (st.crashes ? " · Crashes: " + st.crashes + " (helmets, always!)" : " · Clean run — no crashes!") + "</p>" +
      '<p class="results-note">Copy your Ghost Code below and hand it to a club friend — they can race you without any chat.</p>';

    mode = "results";
    el.results.hidden = false;
    el.hud.hidden = true;
    el.touch.hidden = true;
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
    camera.position.set(camPos.x + sx, camPos.y + sy, camPos.z);
    camLook.set(st.x + fwdX * 6, st.y + 1.1, st.z + fwdZ * 6);
    camera.lookAt(camLook);
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
    if (st.onGround && input.pedal) playerRig.crank.rotation.x -= speed * dt * 0.9 + 4 * dt;
    playerRig.blob.visible = st.onGround;
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

  function animateScene(sc, t, dt) {
    sc.clouds.forEach(function (sp, i) {
      sp.position.x += Math.sin(i) * 0.6 * dt;
    });
    if (sc.wf) {
      sc.wf.streaks.forEach(function (st2, i) {
        st2.position.y -= (14 + i * 2) * dt;
        if (st2.position.y < -8) st2.position.y = sc.wf.wallH - 8;
      });
      sc.wf.mists.forEach(function (m2, i) {
        m2.material.opacity = 0.35 + 0.2 * Math.sin(t * 0.8 + i * 1.7);
      });
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
    refreshMenu();
  });

  if (el.btnDetail) el.btnDetail.addEventListener("click", function () {
    lightMode = !lightMode;
    lsSet("zr3_light", lightMode);
    /* rebuild scenes + renderer quality with the new detail level */
    Object.keys(sceneCache).forEach(disposeScene);
    renderer.setPixelRatio(lightMode ? 1 : Math.min(window.devicePixelRatio || 1, 1.6));
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
      html += '<li><span class="lb-rank">' + (i + 1) + '.</span><span>' + CORE.sanitizeName(r.name) + '</span><span class="lb-time">' + fmtTime(r.timeMs) + "</span></li>";
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
      renderer.render(b.sc.scene, camera);
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
      animateScene(sc, run.st.t, dt);
      updateCamera(run.st, dt, world);
      updateHUD(run.st, world);
      renderer.render(sc.scene, camera);
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
      animateScene(sc, run.st.t, dt);
      updateDust(dt);
      updateCamera(run.st, dt, world);
      updateHUD(run.st, world);
      renderer.render(sc.scene, camera);

      if (run.st.finished) {
        run.endT += dt;
        if (run.endT > 1.4) finishRace();
      }
      return;
    }

    if (mode === "pause" || mode === "results") {
      renderer.render(sc.scene, camera);
    }
  }

  /* ---------- boot ---------- */

  refreshMenu();
  refreshGhostList();
  refreshLeaderboard();
  requestAnimationFrame(loop);
})();
