/* ==========================================================================
   THE GARAGE v2 — engineering-detail bike builder for Zambia Rush
   Every component is modelled like the real thing: cross-laced spokes on
   flanged hubs, toothed chainrings and cassettes, a derailleur with jockey
   wheels, drilled rotors, brake hoses, dust seals, welds, valve stems and
   frame decals. Every zone takes paint; the Tune bench sets sag, rebound
   and tire pressure — and all of it feeds the riding physics.
   ========================================================================== */

import * as THREE from "three";
import { OrbitControls } from "./vendor/addons/controls/OrbitControls.js";

(function () {
  "use strict";

  var B = window.ZB_BIKES;
  var canvas = document.getElementById("garage-canvas");
  if (!B || !canvas) return;

  var career = B.loadCareer();
  var config = B.loadConfig(career);

  /* ---------- renderer / scene ---------- */

  var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true });
  var stage = document.getElementById("garage-stage");
  function fitCanvas() {
    var w = stage.clientWidth, h = stage.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  var scene = new THREE.Scene();
  scene.background = new THREE.Color(0xF3E7D0);

  var camera = new THREE.PerspectiveCamera(38, 4 / 3, 0.02, 60);
  camera.position.set(1.9, 0.95, 2.3);

  /* environment reflections: a tiny sunset room */
  (function () {
    var envScene = new THREE.Scene();
    var envGeo = new THREE.SphereGeometry(10, 16, 10);
    var pos = envGeo.attributes.position;
    var cols = new Float32Array(pos.count * 3);
    var top = new THREE.Color(0xBFE8F2), mid = new THREE.Color(0xFFE9B0), low = new THREE.Color(0x8A6238);
    var t2 = new THREE.Color();
    for (var i = 0; i < pos.count; i++) {
      var y = pos.getY(i) / 10;
      if (y > 0) t2.copy(mid).lerp(top, Math.min(1, y * 1.4));
      else t2.copy(mid).lerp(low, Math.min(1, -y * 1.7));
      cols[i * 3] = t2.r; cols[i * 3 + 1] = t2.g; cols[i * 3 + 2] = t2.b;
    }
    envGeo.setAttribute("color", new THREE.BufferAttribute(cols, 3));
    envScene.add(new THREE.Mesh(envGeo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));
    var win = new THREE.Mesh(new THREE.PlaneGeometry(6, 4), new THREE.MeshBasicMaterial({ color: 0xFFFFFF }));
    win.position.set(-6, 3, 2);
    win.lookAt(0, 0, 0);
    envScene.add(win);
    var pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(envScene, 0.05).texture;
    pmrem.dispose();
  })();

  scene.add(new THREE.HemisphereLight(0xFFF4DC, 0x9A8060, 0.75));
  var key = new THREE.DirectionalLight(0xFFF6E0, 2.2);
  key.position.set(2.6, 3.4, 2.2);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.left = -1.6; key.shadow.camera.right = 1.6;
  key.shadow.camera.top = 1.6; key.shadow.camera.bottom = -1.6;
  key.shadow.camera.near = 1; key.shadow.camera.far = 10;
  key.shadow.normalBias = 0.015;
  scene.add(key);
  var rim = new THREE.DirectionalLight(0xBFE8F2, 0.8);
  rim.position.set(-2.5, 1.6, -2.4);
  scene.add(rim);

  var floor = new THREE.Mesh(new THREE.CircleGeometry(4.5, 40),
    new THREE.MeshStandardMaterial({ color: 0xE3D3B4, roughness: 0.95 }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);
  var ringMesh = new THREE.Mesh(new THREE.RingGeometry(1.28, 1.34, 48),
    new THREE.MeshBasicMaterial({ color: 0xC9B58E }));
  ringMesh.rotation.x = -Math.PI / 2;
  ringMesh.position.y = 0.002;
  scene.add(ringMesh);

  var controls = new OrbitControls(camera, canvas);
  controls.target.set(0, 0.52, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 0.55;
  controls.maxDistance = 4.5;
  controls.maxPolarAngle = Math.PI / 2 + 0.05;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 1.0;
  canvas.addEventListener("pointerdown", function () { controls.autoRotate = false; });

  /* ---------- component data ---------- */

  var FORK_TRAVEL = { kafue_100: 0.10, kafue_120: 0.12, muchinga_140: 0.14, muchinga_160: 0.16, mosi_dc_200: 0.20 };
  var TIRE_FAT = { dambo_semislick: 0.026, miombo_grip: 0.031, mudzimu_spike: 0.035, copper_wall: 0.036 };
  var ROTOR_R = { two_pot: 0.09, four_pot: 0.1015, v_brake: 0 };
  var RING_R = { ring_30: 0.057, ring_32: 0.061, ring_34: 0.065 };
  var RING_T = { ring_30: 30, ring_32: 32, ring_34: 34 };
  var BAR_W = { bar_narrow: 0.35, bar_trail: 0.38, bar_wide: 0.4 };

  /* ---------- shared textures / geometry helpers ---------- */

  function canvasTex(w, h, draw) {
    var c = document.createElement("canvas");
    c.width = w; c.height = h;
    draw(c.getContext("2d"), w, h);
    var tx = new THREE.CanvasTexture(c);
    tx.colorSpace = THREE.SRGBColorSpace;
    return tx;
  }

  /* drilled brake rotor face */
  var rotorTex = canvasTex(256, 256, function (g, w, h) {
    g.clearRect(0, 0, w, h);
    var cx = w / 2, cy = h / 2;
    g.fillStyle = "#D2D6DB";
    g.beginPath(); g.arc(cx, cy, 122, 0, 6.284); g.arc(cx, cy, 78, 0, 6.284, true); g.fill();
    g.fillStyle = "#B8BCC4";
    for (var a = 0; a < 6; a++) {
      g.save();
      g.translate(cx, cy);
      g.rotate((a / 6) * Math.PI * 2);
      g.beginPath();
      g.moveTo(-9, -18); g.lineTo(9, -18); g.lineTo(16, -86); g.lineTo(-16, -86);
      g.closePath(); g.fill();
      g.restore();
    }
    g.fillStyle = "#C9CDD2";
    g.beginPath(); g.arc(cx, cy, 22, 0, 6.284); g.fill();
    /* drilled holes punched out of the braking band */
    g.globalCompositeOperation = "destination-out";
    for (var i = 0; i < 28; i++) {
      var aa = (i / 28) * Math.PI * 2;
      var rr = i % 2 ? 116 : 86;
      g.beginPath(); g.arc(cx + Math.cos(aa) * rr, cy + Math.sin(aa) * rr, 5, 0, 6.284); g.fill();
    }
    g.globalCompositeOperation = "source-over";
  });

  /* chain link plates */
  var chainTex = canvasTex(64, 8, function (g) {
    g.fillStyle = "#3A3A3E"; g.fillRect(0, 0, 64, 8);
    g.fillStyle = "#22221F";
    for (var i = 0; i < 8; i++) g.fillRect(i * 8 + 4, 0, 4, 8);
  });
  chainTex.wrapS = THREE.RepeatWrapping;
  chainTex.repeat.set(70, 1);

  function decalTex(text) {
    return canvasTex(512, 64, function (g) {
      g.clearRect(0, 0, 512, 64);
      g.font = "italic 700 40px Fredoka, Arial, sans-serif";
      g.textAlign = "center"; g.textBaseline = "middle";
      g.lineWidth = 7; g.strokeStyle = "rgba(12,46,28,0.85)";
      g.strokeText(text.toUpperCase(), 256, 32);
      g.fillStyle = "#FFF3C4";
      g.fillText(text.toUpperCase(), 256, 32);
    });
  }

  var badgeTex = canvasTex(64, 64, function (g) {
    g.clearRect(0, 0, 64, 64);
    g.fillStyle = "#0C2E1C"; g.beginPath(); g.arc(32, 32, 30, 0, 6.284); g.fill();
    g.fillStyle = "#F7B733"; g.beginPath(); g.arc(32, 26, 11, 0, 6.284); g.fill();
    g.fillStyle = "#0C2E1C"; g.fillRect(8, 36, 48, 20);
    g.fillStyle = "#E8791D"; g.font = "700 15px Fredoka, Arial"; g.textAlign = "center";
    g.fillText("ZB", 32, 51);
  });

  function plateTexture(name) {
    return canvasTex(128, 96, function (g) {
      g.fillStyle = "#F7B733"; g.fillRect(0, 0, 128, 96);
      g.fillStyle = "#0C2E1C";
      g.font = "700 44px Fredoka, Arial, sans-serif"; g.textAlign = "center";
      g.fillText("10", 64, 48);
      g.font = "700 20px Fredoka, Arial, sans-serif";
      g.fillText((name || "RIDER").toUpperCase().slice(0, 9), 64, 78);
    });
  }

  /* a gear: real teeth, optional centre hole. Lies in XY, extruded along Z. */
  function gearGeo(rTip, rRoot, teeth, depth, rHole) {
    var shape = new THREE.Shape();
    var N = teeth * 4;
    for (var i = 0; i <= N; i++) {
      var seg = i % 4;
      var a = (i / N) * Math.PI * 2;
      var r = (seg === 1 || seg === 2) ? rTip : rRoot;
      var x = Math.cos(a) * r, y = Math.sin(a) * r;
      if (i === 0) shape.moveTo(x, y); else shape.lineTo(x, y);
    }
    if (rHole) {
      var hole = new THREE.Path();
      hole.absarc(0, 0, rHole, 0, Math.PI * 2, true);
      shape.holes.push(hole);
    }
    var g = new THREE.ExtrudeGeometry(shape, { depth: depth, bevelEnabled: false, curveSegments: 3 });
    g.translate(0, 0, -depth / 2);
    g.rotateY(Math.PI / 2);          /* now faces along X like a real cog */
    return g;
  }

  /* ---------- materials ---------- */

  var mats = {};
  function M(keyName, params) {
    if (!mats[keyName]) mats[keyName] = new THREE.MeshStandardMaterial(params);
    return mats[keyName];
  }
  function paintMat(paintId) {
    var def = B.getOption("paint", paintId) || {};
    return new THREE.MeshStandardMaterial({
      color: new THREE.Color(def.color || "#1F7A48"),
      metalness: def.metal ? 0.85 : 0.25,
      roughness: def.metal ? 0.22 : 0.42
    });
  }

  var bikeGroup = null;
  var V = function (x, y, z) { return new THREE.Vector3(x, y, z); };

  function tube(a, b, r, mat, group, r2) {
    var d = new THREE.Vector3().subVectors(b, a);
    var len = d.length();
    var mesh = new THREE.Mesh(new THREE.CylinderGeometry(r2 !== undefined ? r2 : r, r, len, 12), mat);
    mesh.position.copy(a).addScaledVector(d, 0.5);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize());
    mesh.castShadow = true;
    group.add(mesh);
    return mesh;
  }
  function weld(p, r, mat, group) {
    var w = new THREE.Mesh(new THREE.SphereGeometry(r, 10, 8), mat);
    w.position.copy(p);
    w.castShadow = true;
    group.add(w);
    return w;
  }
  function bolt(p, r, len, axis, mat, group) {
    var m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 6), mat);
    m.position.copy(p);
    if (axis === "x") m.rotation.z = Math.PI / 2;
    if (axis === "z") m.rotation.x = Math.PI / 2;
    group.add(m);
    return m;
  }

  /* ---------- wheels: laced spokes, hooked rim, valve, rotor, tread ---------- */

  function buildWheel(opts) {
    var w = new THREE.Group();
    var r = opts.r, fat = opts.fat;
    var wallDef = B.WALL_OPTIONS[opts.wall] || B.WALL_OPTIONS.black;
    var wallM = M("wall_" + opts.wall, { color: new THREE.Color(wallDef.color), roughness: 0.92 });
    var rubberM = M("rubber", { color: 0x25201B, roughness: 0.95 });

    /* casing (sidewall colour) + tread band over the crown */
    var casing = new THREE.Mesh(new THREE.TorusGeometry(r - fat, fat, 14, 40), wallM);
    casing.castShadow = true;
    w.add(casing);
    var tread = new THREE.Mesh(new THREE.TorusGeometry(r - fat + fat * 0.32, fat * 0.74, 12, 40), rubberM);
    tread.castShadow = true;
    w.add(tread);

    /* knob pattern by tire model: centre row + shoulder rows */
    var pat = opts.knobs;   /* {c:[count,size], s:[count,size]} */
    if (pat) {
      var totalKnobs = pat.c[0] + (pat.s ? pat.s[0] * 2 : 0);
      var knobG = new THREE.BoxGeometry(1, 1, 1);
      var knobs = new THREE.InstancedMesh(knobG, rubberM, totalKnobs);
      var m4 = new THREE.Matrix4(), q4 = new THREE.Quaternion(), s3 = new THREE.Vector3();
      var idx = 0;
      function ringOf(count, size, xOff, rr) {
        for (var i = 0; i < count; i++) {
          var a = (i / count) * Math.PI * 2 + xOff * 3;
          q4.setFromAxisAngle(new THREE.Vector3(1, 0, 0), a);
          s3.set(size, size, size * 1.4);
          m4.compose(new THREE.Vector3(xOff, Math.cos(a) * rr, Math.sin(a) * rr), q4, s3);
          knobs.setMatrixAt(idx++, m4);
        }
      }
      ringOf(pat.c[0], pat.c[1], 0, r - 0.006);
      if (pat.s) {
        ringOf(pat.s[0], pat.s[1], fat * 0.52, r - fat * 0.22);
        ringOf(pat.s[0], pat.s[1], -fat * 0.52, r - fat * 0.22);
      }
      w.add(knobs);
    }

    /* rim with a real cross-section + nipples + valve */
    var rimR = r - fat * 2 - 0.004;
    var rimProfile = [
      new THREE.Vector2(rimR - 0.013, -0.012), new THREE.Vector2(rimR, -0.009),
      new THREE.Vector2(rimR + 0.004, -0.006), new THREE.Vector2(rimR + 0.004, 0.006),
      new THREE.Vector2(rimR, 0.009), new THREE.Vector2(rimR - 0.013, 0.012),
      new THREE.Vector2(rimR - 0.013, -0.012)
    ];
    var rimGeo = new THREE.LatheGeometry(rimProfile, 44);
    rimGeo.rotateZ(Math.PI / 2);
    var rimMesh = new THREE.Mesh(rimGeo, opts.rimMat);
    rimMesh.castShadow = true;
    w.add(rimMesh);

    var alloyM = M("alloy", { color: 0x9A9AA2, metalness: 0.8, roughness: 0.35 });
    var steelM = M("steel", { color: 0xC9CDD2, metalness: 0.85, roughness: 0.3 });

    /* hub: shell + two flanges + thru-axle caps */
    var hub = new THREE.Mesh(new THREE.CylinderGeometry(0.017, 0.017, 0.1, 12), alloyM);
    hub.rotation.z = Math.PI / 2;
    w.add(hub);
    [-0.042, 0.042].forEach(function (x) {
      var fl = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, 0.006, 16), alloyM);
      fl.rotation.z = Math.PI / 2;
      fl.position.x = x;
      w.add(fl);
    });
    [-0.056, 0.056].forEach(function (x) {
      var cap = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.009, 0.01, 8), steelM);
      cap.rotation.z = Math.PI / 2;
      cap.position.x = x;
      w.add(cap);
    });

    /* 28 spokes, two-cross laced: flange hole -> rim seat offset ~40 degrees */
    var spokeM = M("spoke", { color: 0xB8B8BE, metalness: 0.7, roughness: 0.4 });
    var nipG = new THREE.CylinderGeometry(0.0032, 0.0032, 0.009, 6);
    for (var i = 0; i < 28; i++) {
      var side = i % 2 ? 0.042 : -0.042;
      var a = (Math.floor(i / 2) / 14) * Math.PI * 2 + (i % 2) * 0.22;
      var dir = (Math.floor(i / 2) % 2) ? 0.62 : -0.62;   /* alternating cross direction */
      var hubP = V(side, Math.cos(a) * 0.026, Math.sin(a) * 0.026);
      var rimA = a + dir;
      var rimP = V(side * 0.14, Math.cos(rimA) * (rimR - 0.006), Math.sin(rimA) * (rimR - 0.006));
      tube(hubP, rimP, 0.0016, spokeM, w).castShadow = false;
      var nip = new THREE.Mesh(nipG, steelM);
      nip.position.copy(rimP);
      nip.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), rimP.clone().setX(0).normalize());
      w.add(nip);
    }

    /* valve stem at a fixed angle */
    var vAng = 0.6;
    var vBase = V(0, Math.cos(vAng) * (rimR - 0.01), Math.sin(vAng) * (rimR - 0.01));
    var vTip = V(0, Math.cos(vAng) * (rimR - 0.042), Math.sin(vAng) * (rimR - 0.042));
    tube(vBase, vTip, 0.0035, steelM, w);
    weld(vTip, 0.005, steelM, w);

    /* rotor: drilled disc via alpha-tested texture + lockring */
    if (opts.rotorR > 0) {
      var rotor = new THREE.Mesh(new THREE.CircleGeometry(opts.rotorR, 36),
        new THREE.MeshStandardMaterial({
          map: rotorTex, alphaMap: rotorTex, transparent: false, alphaTest: 0.4,
          metalness: 0.85, roughness: 0.3, side: THREE.DoubleSide
        }));
      rotor.rotation.y = Math.PI / 2;
      rotor.position.x = -0.052;
      w.add(rotor);
      var lock = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.008, 12), steelM);
      lock.rotation.z = Math.PI / 2;
      lock.position.x = -0.052;
      w.add(lock);
    }
    return w;
  }

  /* ---------- the bike ---------- */

  function buildBike(cfg) {
    var g = new THREE.Group();
    var C = cfg.colors || {};
    var frameM = paintMat(C.frame);
    var forkM = paintMat(C.fork);
    var rimMat = paintMat(C.rims);
    var saddleM = paintMat(C.saddle);
    var gripM = paintMat(C.grips);
    var darkM = M("dark", { color: 0x24201C, roughness: 0.7 });
    var stanchM = M("stanch", { color: 0xD9A441, metalness: 0.75, roughness: 0.25 });
    var alloyM = M("alloy", { color: 0x9A9AA2, metalness: 0.8, roughness: 0.35 });
    var steelM = M("steel", { color: 0xC9CDD2, metalness: 0.85, roughness: 0.3 });
    var hoseM = M("hose", { color: 0x1A1A1A, roughness: 0.85 });

    var frame = cfg.frame;
    var wheelR = (B.getOption("wheels", cfg.wheels) || {}).radius || 0.345;
    var fat = TIRE_FAT[cfg.tires] || 0.031;
    var rotorR = ROTOR_R[cfg.brakes] !== undefined ? ROTOR_R[cfg.brakes] : 0.09;
    var travel = FORK_TRAVEL[cfg.fork] || 0.12;
    var isDC = cfg.fork === "mosi_dc_200";
    var isDJ = frame === "kabwata_dj";
    var isDH = frame === "mosi_dh";
    var isFS = frame === "zambezi_fs" || frame === "muchinga_enduro" || isDH;
    var single = cfg.drivetrain === "one_gear";
    var barW = BAR_W[cfg.bar] || 0.38;

    /* knob patterns per tire model */
    var KNOBS = {
      dambo_semislick: { c: [88, 0.005], s: [30, 0.007] },
      miombo_grip: { c: [56, 0.0085], s: [34, 0.01] },
      mudzimu_spike: { c: [40, 0.012], s: [28, 0.013] },
      copper_wall: { c: [48, 0.01], s: [32, 0.012] }
    };

    /* ----- anchors ----- */
    var RA = V(0, wheelR, -0.58 + (isDJ ? 0.05 : 0));
    var FA = V(0, wheelR, 0.58);
    var BB = V(0, 0.3, -0.02);
    var sttY = isDJ ? 0.6 : isDH ? 0.64 : 0.74;
    var STT = V(0, sttY, -0.2);
    var htTopY = isDH ? 0.75 : 0.8;
    var HTt = V(0, htTopY, 0.4);
    var HTb = V(0, htTopY - 0.12, 0.445);
    var tubeR = isDH ? 0.028 : 0.023;

    /* ----- front triangle with welds, gusset, bosses, decals ----- */
    tube(HTt, STT, tubeR * 0.92, frameM, g, tubeR);            /* top tube, tapered */
    var dtMesh = tube(HTb, BB, tubeR * 1.1, frameM, g, tubeR * 1.3); /* down tube */
    tube(BB, V(0, sttY + 0.03, -0.21), tubeR * 0.95, frameM, g);
    tube(HTt.clone().add(V(0, 0.012, -0.005)), HTb.clone().add(V(0, -0.012, 0.005)), tubeR * 1.3, frameM, g);
    [HTt, HTb, STT, BB].forEach(function (p) { weld(p, tubeR * 1.12, frameM, g); });
    /* head gusset */
    tube(HTb.clone().add(V(0, 0.02, -0.01)), HTb.clone().lerp(BB, 0.12), tubeR * 0.5, frameM, g);
    /* bottle bosses when no bottle fitted */
    if ((cfg.extras || []).indexOf("bottle") < 0 && !isDJ) {
      bolt(V(0, 0.5, 0.1), 0.005, 0.01, "z", steelM, g);
      bolt(V(0, 0.44, 0.06), 0.005, 0.01, "z", steelM, g);
    }
    /* downtube decals: model name both sides */
    var frameDef = B.getOption("frame", frame);
    var dTex = decalTex(frameDef ? frameDef.name : "ZAMBIA");
    dTex.wrapS = THREE.RepeatWrapping;
    dTex.repeat.set(1.6, 1);
    dTex.offset.x = -0.28;
    var dtDir = new THREE.Vector3().subVectors(BB, HTb);
    var dtMid = HTb.clone().addScaledVector(dtDir, 0.5);
    var sleeve = new THREE.Mesh(
      new THREE.CylinderGeometry(tubeR * 1.24 + 0.0008, tubeR * 1.32 + 0.0008, 0.3, 20, 1, true),
      new THREE.MeshBasicMaterial({ map: dTex, transparent: true, side: THREE.DoubleSide }));
    sleeve.position.copy(dtMid);
    sleeve.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dtDir.clone().normalize());
    sleeve.rotateY(Math.PI * 0.75);
    g.add(sleeve);
    /* head badge */
    var badge = new THREE.Mesh(new THREE.PlaneGeometry(0.036, 0.036),
      new THREE.MeshBasicMaterial({ map: badgeTex, transparent: true }));
    badge.position.copy(HTt.clone().lerp(HTb, 0.5)).add(V(0, 0, tubeR * 1.35));
    badge.rotation.x = -0.35;
    g.add(badge);

    /* ----- rear end: stays, bridges, dropouts ----- */
    var stayM = isFS ? alloyM : frameM;
    [-0.045, 0.045].forEach(function (x) {
      tube(V(x, BB.y, BB.z), V(x, RA.y, RA.z), 0.011, stayM, g, 0.014);
      tube(V(x, RA.y, RA.z), isFS ? V(x, 0.6, -0.14) : V(x, STT.y, STT.z), 0.009, stayM, g, 0.012);
      /* dropout plates */
      var drop = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.05, 0.04), alloyM);
      drop.position.set(x, RA.y, RA.z + 0.005);
      g.add(drop);
    });
    /* stay bridges */
    tube(V(-0.045, RA.y + 0.09, RA.z + 0.09), V(0.045, RA.y + 0.09, RA.z + 0.09), 0.007, stayM, g);
    tube(V(-0.045, BB.y + 0.015, BB.z - 0.14), V(0.045, BB.y + 0.015, BB.z - 0.14), 0.008, stayM, g);

    /* ----- suspension: rocker plates + air can or DH coil ----- */
    if (isFS) {
      [-0.02, 0.02].forEach(function (x) {
        var plate = new THREE.Mesh(new THREE.BoxGeometry(0.007, 0.028, 0.1), alloyM);
        plate.position.set(x, 0.615, -0.155);
        plate.rotation.x = -0.35;
        g.add(plate);
      });
      bolt(V(0, 0.6, -0.14), 0.009, 0.055, "x", steelM, g);
      bolt(V(0, 0.63, -0.185), 0.009, 0.055, "x", steelM, g);
      var shockA = isDH ? V(0, 0.37, -0.05) : V(0, 0.6, -0.13);
      var shockB = isDH ? V(0, 0.66, 0.06) : V(0, 0.47, 0.12);
      tube(shockA.clone().lerp(shockB, 0.45), shockB, 0.02, darkM, g);      /* body */
      tube(shockA, shockA.clone().lerp(shockB, 0.5), 0.009, stanchM, g);    /* shaft */
      if (isDH) {
        /* coil spring wound around the shock */
        var coilPts = [];
        var axis = new THREE.Vector3().subVectors(shockB, shockA);
        var len = axis.length();
        axis.normalize();
        var side = new THREE.Vector3(1, 0, 0);
        var up2 = new THREE.Vector3().crossVectors(axis, side).normalize();
        for (var ci = 0; ci <= 40; ci++) {
          var t3 = ci / 40;
          var ang = t3 * Math.PI * 12;
          coilPts.push(shockA.clone().addScaledVector(axis, 0.06 + t3 * (len - 0.13))
            .addScaledVector(side, Math.cos(ang) * 0.026)
            .addScaledVector(up2, Math.sin(ang) * 0.026));
        }
        var coil = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(coilPts), 80, 0.0045, 6),
          M("spring", { color: 0xD64533, metalness: 0.6, roughness: 0.4 }));
        g.add(coil);
      } else {
        var can = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.05, 12), alloyM);
        can.position.copy(shockA.clone().lerp(shockB, 0.72));
        can.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3().subVectors(shockB, shockA).normalize());
        g.add(can);
        /* red rebound dial — the thing the Tune bench adjusts */
        var dial = new THREE.Mesh(new THREE.CylinderGeometry(0.013, 0.013, 0.012, 10),
          M("spring", { color: 0xD64533, metalness: 0.6, roughness: 0.4 }));
        dial.position.copy(shockA);
        g.add(dial);
      }
    }

    /* ----- fork: crowns, stanchions with dust seals, lowers, arch ----- */
    var crown = HTb.clone().add(V(0, -0.015, 0.012));
    var lowerTop = crown.clone().lerp(FA, 0.28).add(V(0, -travel * 0.55, 0));
    var crownBar = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.03, 0.055), darkM);
    crownBar.position.copy(crown);
    crownBar.rotation.x = 0.28;
    g.add(crownBar);
    [-0.052, 0.052].forEach(function (x) {
      var cx = V(x, crown.y, crown.z);
      var lx = V(x, lowerTop.y, lowerTop.z);
      var ax = V(x, FA.y, FA.z);
      tube(cx, lx, 0.016, stanchM, g);
      var seal = new THREE.Mesh(new THREE.TorusGeometry(0.019, 0.004, 6, 14), darkM);
      seal.position.copy(lx.clone().add(V(0, 0.018, 0)));
      seal.rotation.x = Math.PI / 2;
      g.add(seal);
      tube(lx.clone().add(V(0, 0.02, 0)), ax, 0.017, forkM, g, 0.023);
    });
    /* lowers arch over the tire */
    var arch = new THREE.Mesh(new THREE.TorusGeometry(0.055, 0.009, 8, 12, Math.PI), forkM);
    arch.position.copy(lowerTop.clone().add(V(0, 0.01, 0.012)));
    arch.rotation.y = 0;
    g.add(arch);
    if (isDC) {
      var upper = V(0, HTt.y + 0.03, HTt.z + 0.01);
      var crown2 = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.026, 0.05), darkM);
      crown2.position.set(0, upper.y, upper.z - 0.02);
      g.add(crown2);
      [-0.052, 0.052].forEach(function (x) {
        tube(V(x, upper.y, upper.z - 0.02), V(x, crown.y, crown.z), 0.016, stanchM, g);
      });
    }

    /* ----- cockpit: steerer, spacers, stem + faceplate bolts, bent bar ----- */
    var barC = V(0, HTt.y + 0.075, HTt.z - 0.02);
    tube(HTt, V(0, barC.y + 0.005, HTt.z - 0.006), 0.0145, darkM, g);
    for (var sp2 = 0; sp2 < 3; sp2++) {
      var spacer = new THREE.Mesh(new THREE.CylinderGeometry(0.017, 0.017, 0.008, 12),
        sp2 === 1 ? M("spacerR", { color: 0xD64533, roughness: 0.5 }) : darkM);
      spacer.position.set(0, HTt.y + 0.02 + sp2 * 0.011, HTt.z - 0.002 - sp2 * 0.004);
      g.add(spacer);
    }
    var topcap = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.006, 12), alloyM);
    topcap.position.set(0, barC.y + 0.012, barC.z + 0.006);
    g.add(topcap);
    var stem = new THREE.Mesh(new THREE.BoxGeometry(0.036, 0.03, 0.065), darkM);
    stem.position.set(0, barC.y + 0.008, barC.z + 0.025);
    g.add(stem);
    var facepl = new THREE.Mesh(new THREE.BoxGeometry(0.034, 0.028, 0.008), darkM);
    facepl.position.set(0, barC.y + 0.008, barC.z + 0.058);
    g.add(facepl);
    [[-0.011, 0.008], [0.011, 0.008], [-0.011, -0.008], [0.011, -0.008]].forEach(function (bp) {
      bolt(V(bp[0], barC.y + 0.008 + bp[1], barC.z + 0.062), 0.0022, 0.004, "z", steelM, g);
    });
    /* handlebar: rise + backsweep via a real curve */
    var rise = cfg.bar === "bar_wide" ? 0.03 : cfg.bar === "bar_narrow" ? 0.02 : 0.025;
    var barPts = [
      V(-barW, barC.y + rise, barC.z - 0.035),
      V(-barW * 0.55, barC.y + rise * 0.8, barC.z - 0.012),
      V(-barW * 0.2, barC.y, barC.z + 0.008),
      V(0, barC.y, barC.z + 0.01),
      V(barW * 0.2, barC.y, barC.z + 0.008),
      V(barW * 0.55, barC.y + rise * 0.8, barC.z - 0.012),
      V(barW, barC.y + rise, barC.z - 0.035)
    ];
    var barCurve = new THREE.CatmullRomCurve3(barPts);
    var barMesh = new THREE.Mesh(new THREE.TubeGeometry(barCurve, 32, 0.0115, 10), darkM);
    barMesh.castShadow = true;
    g.add(barMesh);
    /* grips with lock rings + end plugs, brake levers with reservoirs */
    [-1, 1].forEach(function (sd) {
      var tip = barPts[sd > 0 ? 6 : 0];
      var inn = barPts[sd > 0 ? 5 : 1].clone().lerp(tip, 0.55);
      tube(inn, tip, 0.0145, gripM, g);
      [inn, tip].forEach(function (p) {
        var lock = new THREE.Mesh(new THREE.TorusGeometry(0.0155, 0.0028, 6, 12), alloyM);
        lock.position.copy(p);
        lock.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3().subVectors(tip, inn).normalize());
        g.add(lock);
      });
      if (rotorR > 0 || cfg.brakes === "v_brake") {
        var lp = inn.clone().lerp(tip, -0.45);
        var res = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.018, 0.02), darkM);
        res.position.copy(lp).add(V(0, -0.004, 0.02));
        g.add(res);
        tube(lp.clone().add(V(0, -0.01, 0.028)), lp.clone().add(V(sd * -0.03, -0.02, 0.055)), 0.004, alloyM, g);
      }
    });

    /* ----- brake hoses: lever -> caliper, the detail everyone forgets ----- */
    if (rotorR > 0) {
      var hoseF = new THREE.CatmullRomCurve3([
        V(-0.16, barC.y - 0.01, barC.z + 0.02),
        V(-0.09, barC.y - 0.09, barC.z + 0.05),
        V(-0.06, crown.y - 0.04, crown.z + 0.01),
        V(-0.055, FA.y + rotorR * 0.6, FA.z + 0.035)
      ]);
      g.add(new THREE.Mesh(new THREE.TubeGeometry(hoseF, 20, 0.0025, 6), hoseM));
      var hoseR = new THREE.CatmullRomCurve3([
        V(0.16, barC.y - 0.01, barC.z + 0.02),
        V(0.03, HTb.y + 0.02, HTb.z - 0.02),
        V(0.028, BB.y + 0.06, BB.z + 0.1),
        V(0.05, RA.y + 0.045, RA.z + 0.2),
        V(-0.055, RA.y + rotorR * 0.55, RA.z - 0.03)
      ]);
      g.add(new THREE.Mesh(new THREE.TubeGeometry(hoseR, 26, 0.0025, 6), hoseM));
      /* calipers */
      var calF = new THREE.Mesh(new THREE.BoxGeometry(0.026, 0.052, 0.03), darkM);
      calF.position.set(-0.058, FA.y + rotorR * 0.55, FA.z + 0.035);
      g.add(calF);
      var calR = new THREE.Mesh(new THREE.BoxGeometry(0.026, 0.048, 0.03), darkM);
      calR.position.set(-0.058, RA.y + rotorR * 0.55, RA.z - 0.035);
      g.add(calR);
    } else {
      /* v-brake arms at the rim */
      [-1, 1].forEach(function (sd) {
        tube(V(sd * 0.05, FA.y + wheelR - 0.07, FA.z + 0.03), V(sd * 0.02, FA.y + wheelR + 0.02, FA.z + 0.02), 0.006, alloyM, g);
      });
    }

    /* ----- saddle with rails + post (dropper gets collar + cable) ----- */
    var isDropper = cfg.seatpost === "dropper";
    var saddleY = isDJ ? sttY + 0.08 : sttY + 0.14;
    tube(V(0, sttY + 0.02, -0.205), V(0, saddleY, -0.24), isDropper ? 0.016 : 0.0125, isDropper ? darkM : alloyM, g);
    if (isDropper) {
      var collar = new THREE.Mesh(new THREE.CylinderGeometry(0.021, 0.021, 0.022, 12), alloyM);
      collar.position.set(0, sttY + 0.05, -0.211);
      g.add(collar);
      var dropCable = new THREE.CatmullRomCurve3([
        V(0.14, barC.y - 0.005, barC.z + 0.015),
        V(0.02, HTt.y - 0.03, HTt.z - 0.1),
        V(0.015, sttY + 0.06, -0.19)
      ]);
      g.add(new THREE.Mesh(new THREE.TubeGeometry(dropCable, 16, 0.002, 6), hoseM));
    }
    var saddle = new THREE.Mesh(new THREE.SphereGeometry(0.09, 14, 10), saddleM);
    saddle.scale.set(0.52, 0.28, 1.5);
    saddle.position.set(0, saddleY + 0.035, -0.25);
    saddle.castShadow = true;
    g.add(saddle);
    [-0.018, 0.018].forEach(function (x) {
      tube(V(x, saddleY + 0.012, -0.33), V(x, saddleY + 0.012, -0.17), 0.003, steelM, g);
    });

    /* ----- drivetrain: toothed ring, cranks, cassette, mech, chain ----- */
    var ringR2 = RING_R[cfg.ring] || 0.061;
    var ringGeoM = new THREE.Mesh(gearGeo(ringR2, ringR2 - 0.007, RING_T[cfg.ring] || 32, 0.004, ringR2 * 0.55), darkM);
    ringGeoM.position.set(0.052, BB.y, BB.z);
    g.add(ringGeoM);
    /* 4-arm spider + bolts */
    for (var sa = 0; sa < 4; sa++) {
      var ang2 = sa * Math.PI / 2 + 0.4;
      tube(V(0.05, BB.y, BB.z), V(0.05, BB.y + Math.cos(ang2) * ringR2 * 0.55, BB.z + Math.sin(ang2) * ringR2 * 0.55), 0.0045, alloyM, g);
    }
    /* BB shell */
    var bbShell = new THREE.Mesh(new THREE.CylinderGeometry(0.021, 0.021, 0.075, 12), frameM);
    bbShell.rotation.z = Math.PI / 2;
    bbShell.position.copy(BB);
    g.add(bbShell);
    /* cranks + pedals with pins */
    var hasPins = cfg.pedals === "pedal_pins";
    [-1, 1].forEach(function (sd) {
      var armEnd = V(sd * 0.075, BB.y + sd * 0.115, BB.z + sd * 0.05);
      tube(V(sd * 0.062, BB.y, BB.z), armEnd, 0.008, alloyM, g, 0.011);
      var pedal = new THREE.Mesh(new THREE.BoxGeometry(0.085, 0.012, 0.06), hasPins ? alloyM : darkM);
      pedal.position.copy(armEnd).add(V(sd * 0.045, 0, 0));
      g.add(pedal);
      if (hasPins) {
        for (var pi2 = 0; pi2 < 6; pi2++) {
          bolt(armEnd.clone().add(V(sd * (0.02 + (pi2 % 3) * 0.022), 0.008, -0.02 + Math.floor(pi2 / 3) * 0.04)), 0.0015, 0.006, "y", steelM, g);
        }
      }
    });
    /* cassette or single cog, with real teeth on the big sprockets */
    var casTopR = single ? 0.036 : 0.05;
    if (single) {
      var cog = new THREE.Mesh(gearGeo(0.036, 0.031, 16, 0.003, 0.016), steelM);
      cog.position.set(0.05, RA.y, RA.z);
      g.add(cog);
    } else {
      for (var ci2 = 0; ci2 < 7; ci2++) {
        var cr = 0.05 - ci2 * 0.0052;
        var cogM = ci2 < 3
          ? new THREE.Mesh(gearGeo(cr, cr - 0.004, Math.round(cr * 640), 0.0022, cr * 0.45), steelM)
          : new THREE.Mesh(new THREE.CylinderGeometry(cr, cr, 0.0022, 20), steelM);
        if (ci2 >= 3) cogM.rotation.z = Math.PI / 2;
        cogM.position.set(0.038 + ci2 * 0.0068, RA.y, RA.z);
        g.add(cogM);
      }
      /* rear derailleur: knuckle, cage plates, two jockey wheels */
      var mechB = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.035, 0.03), darkM);
      mechB.position.set(0.055, RA.y - 0.045, RA.z - 0.01);
      g.add(mechB);
      var j1 = V(0.052, RA.y - 0.075, RA.z + 0.005);
      var j2 = V(0.052, RA.y - 0.105, RA.z - 0.025);
      [j1, j2].forEach(function (jp) {
        var jw = new THREE.Mesh(gearGeo(0.014, 0.011, 11, 0.004, 0.004), darkM);
        jw.position.copy(jp);
        g.add(jw);
      });
      [-0.006, 0.006].forEach(function (x) {
        var cage = new THREE.Mesh(new THREE.BoxGeometry(0.0025, 0.06, 0.02), darkM);
        cage.position.set(0.052 + x, RA.y - 0.09, RA.z - 0.01);
        cage.rotation.x = 0.5;
        g.add(cage);
      });
    }
    /* chain with link texture: ring -> cassette -> under the jockey wheels */
    var chainPts = [];
    var ringC = V(0.05, BB.y, BB.z), casC = V(0.05, RA.y, RA.z);
    for (var a3 = -Math.PI / 2; a3 <= Math.PI / 2; a3 += 0.45) {
      chainPts.push(V(0.05, ringC.y + Math.sin(a3) * (ringR2 + 0.004), ringC.z + Math.cos(a3) * (ringR2 + 0.004)));
    }
    if (single) {
      for (a3 = Math.PI / 2; a3 <= Math.PI * 1.5; a3 += 0.45) {
        chainPts.push(V(0.05, casC.y + Math.sin(a3) * 0.04, casC.z - Math.cos(a3) * 0.04));
      }
    } else {
      chainPts.push(V(0.05, casC.y + casTopR + 0.004, casC.z - 0.01));
      chainPts.push(V(0.05, casC.y, casC.z - casTopR - 0.006));
      chainPts.push(V(0.052, RA.y - 0.075, RA.z + 0.02));   /* around jockey 1 */
      chainPts.push(V(0.052, RA.y - 0.118, RA.z - 0.028));  /* under jockey 2 */
    }
    var chainMesh = new THREE.Mesh(
      new THREE.TubeGeometry(new THREE.CatmullRomCurve3(chainPts, true), 72, 0.0058, 6, true),
      new THREE.MeshStandardMaterial({ map: chainTex, metalness: 0.6, roughness: 0.5 }));
    g.add(chainMesh);

    /* ----- extras ----- */
    var ex = cfg.extras || [];
    if (ex.indexOf("bottle") >= 0 && !isDJ) {
      var bottle = new THREE.Mesh(new THREE.CylinderGeometry(0.031, 0.031, 0.17, 12),
        M("bottle", { color: 0x2A9D8F, roughness: 0.5 }));
      bottle.position.set(0, 0.47, 0.09);
      bottle.rotation.x = -0.45;
      g.add(bottle);
      [-0.02, 0.05].forEach(function (o) {
        var cage = new THREE.Mesh(new THREE.TorusGeometry(0.034, 0.0028, 6, 14, Math.PI * 1.4), alloyM);
        cage.position.set(0, 0.45 + o, 0.08 + o * 0.5);
        cage.rotation.x = Math.PI / 2 - 0.45;
        g.add(cage);
      });
    }
    if (ex.indexOf("mudguard") >= 0) {
      var guard = new THREE.Mesh(new THREE.TorusGeometry(wheelR + 0.03, 0.024, 5, 14, Math.PI * 0.7), darkM);
      guard.position.copy(FA);
      guard.rotation.z = Math.PI / 2;
      guard.rotation.y = Math.PI / 2;
      guard.rotation.x = Math.PI * 0.16;
      guard.scale.x = 0.32;
      g.add(guard);
    }
    if (ex.indexOf("bell") >= 0) {
      var bell = new THREE.Mesh(new THREE.SphereGeometry(0.019, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.55),
        M("bellm", { color: 0xD9A441, metalness: 0.9, roughness: 0.2 }));
      bell.position.set(-0.11, barC.y + rise + 0.018, barC.z - 0.03);
      g.add(bell);
      bolt(V(-0.11, barC.y + rise + 0.008, barC.z - 0.03), 0.003, 0.014, "y", steelM, g);
    }
    if (ex.indexOf("plate") >= 0) {
      var pname = "";
      try { pname = (JSON.parse(localStorage.getItem("zr_profile") || "{}").name) || ""; } catch (e) { /* ignore */ }
      var plate = new THREE.Mesh(new THREE.PlaneGeometry(0.13, 0.1),
        new THREE.MeshBasicMaterial({ map: plateTexture(pname), side: THREE.DoubleSide }));
      plate.position.set(0, HTt.y - 0.04, HTt.z + 0.085);
      plate.rotation.x = -0.12;
      g.add(plate);
    }
    if (ex.indexOf("kickstand") >= 0) {
      tube(V(-0.045, BB.y, BB.z - 0.12), V(-0.1, 0.015, BB.z - 0.2), 0.007, alloyM, g);
    }

    /* ----- wheels ----- */
    var knobPat = KNOBS[cfg.tires];
    var rear = buildWheel({ r: wheelR, fat: fat, wall: (cfg.colors || {}).wall, knobs: knobPat, rimMat: rimMat, rotorR: rotorR });
    rear.position.copy(RA);
    g.add(rear);
    var front = buildWheel({ r: wheelR, fat: fat, wall: (cfg.colors || {}).wall, knobs: knobPat, rimMat: rimMat, rotorR: rotorR });
    front.position.copy(FA);
    g.add(front);

    g.traverse(function (o) { if (o.isMesh) o.castShadow = true; });
    return g;
  }

  function rebuildBike() {
    if (bikeGroup) {
      scene.remove(bikeGroup);
      bikeGroup.traverse(function (o) {
        if (o.geometry) o.geometry.dispose();
        if (o.material && o.material.map && o.material.map.isCanvasTexture && o.material.map !== rotorTex && o.material.map !== chainTex) o.material.map.dispose();
      });
    }
    bikeGroup = buildBike(config);
    scene.add(bikeGroup);
  }

  /* ====================================================================
     UI
     ==================================================================== */

  var elTabs = document.getElementById("garage-tabs");
  var elParts = document.getElementById("garage-parts");
  var elName = document.getElementById("bike-name");
  var elWeight = document.getElementById("bike-weight");
  var elCareer = document.getElementById("garage-career");
  var activeTab = "frame";

  var ZONE_LABELS = { frame: "Frame", fork: "Fork lowers", rims: "Rims", saddle: "Saddle", grips: "Grips" };

  var STAT_LABELS = {
    pedal: ["Sprint", false], vcap: ["Top speed", false], brake: ["Brakes", false],
    steer: ["Agility", false], hop: ["Pop", false],
    roll: ["Rolling speed", true], rough: ["Rough lines", true]
  };

  function statChips(def) {
    var chips = "";
    var st = def.stats || {};
    Object.keys(st).forEach(function (k) {
      if (k === "landSoft") {
        var v = st[k];
        chips += '<span class="pchip ' + (v > 0 ? "pchip--up" : "pchip--down") + '">Landing armour ' + (v > 0 ? "+" : "") + Math.round(v * 100) + "%</span>";
        return;
      }
      var meta = STAT_LABELS[k];
      if (!meta) return;
      var mult = st[k];
      var better = meta[1] ? mult < 1 : mult > 1;
      var pct = Math.round((meta[1] ? (1 - mult) : (mult - 1)) * 100);
      chips += '<span class="pchip ' + (better ? "pchip--up" : "pchip--down") + '">' + meta[0] + " " + (pct >= 0 ? "+" : "") + pct + "%</span>";
    });
    return chips;
  }

  function renderTabs() {
    var html = "";
    Object.keys(B.CATALOG).forEach(function (cat) {
      if (cat === "paint") return;   /* replaced by the per-zone paint booth */
      html += '<button type="button" role="tab" class="gtab' + (cat === activeTab ? " is-selected" : "") + '" data-tab="' + cat + '">' + B.CATALOG[cat].label + "</button>";
    });
    html += '<button type="button" role="tab" class="gtab' + (activeTab === "__paint" ? " is-selected" : "") + '" data-tab="__paint">🎨 Paint booth</button>';
    html += '<button type="button" role="tab" class="gtab' + (activeTab === "__tune" ? " is-selected" : "") + '" data-tab="__tune">🔧 Tune bench</button>';
    elTabs.innerHTML = html;
  }

  function renderParts() {
    if (activeTab === "__paint") { renderPaintBooth(); return; }
    if (activeTab === "__tune") { renderTuneBench(); return; }
    var cat = B.CATALOG[activeTab];
    var html = "";
    Object.keys(cat.options).forEach(function (id) {
      var def = cat.options[id];
      var unlocked = B.isUnlocked(def, career);
      var equipped = cat.multi ? (config.extras || []).indexOf(id) >= 0 : config[activeTab] === id;
      var cls = "part-card" + (equipped ? " is-equipped" : "") + (unlocked ? "" : " is-locked");
      html +=
        '<button type="button" class="' + cls + '" data-part="' + id + '"' + (unlocked ? "" : " aria-disabled='true'") + ">" +
        '<span class="part-head"><h3>' + def.name + (equipped ? " ✓" : "") + "</h3>" +
        '<span class="part-kg">' + (def.kg ? def.kg.toFixed(2) + " kg" : "") + "</span></span>" +
        '<span class="part-spec">' + (def.spec || "") + "</span>" +
        '<p class="part-desc">' + def.desc + "</p>" +
        '<span class="part-chips">' + statChips(def) +
        (unlocked ? "" : '<span class="pchip pchip--lock">🔒 ' + def.unlock.label + "</span>") +
        "</span></button>";
    });
    elParts.innerHTML = html;
  }

  function renderPaintBooth() {
    var html = '<p class="part-desc" style="margin:0 0 0.3rem">Every zone takes paint. Tap a swatch — the sprayer works instantly.</p>';
    B.COLOR_ZONES.forEach(function (zone) {
      html += '<div class="paint-zone"><h3>' + ZONE_LABELS[zone] + "</h3><div class='swatch-row'>";
      Object.keys(B.CATALOG.paint.options).forEach(function (pid) {
        var def = B.CATALOG.paint.options[pid];
        var unlocked = B.isUnlocked(def, career);
        var sel = (config.colors || {})[zone] === pid;
        html += '<button type="button" class="swatch' + (sel ? " is-selected" : "") + (unlocked ? "" : " is-locked") +
          '" data-zone="' + zone + '" data-paint="' + pid + '" title="' + def.name + (unlocked ? "" : " — 🔒 " + def.unlock.label) + '"' +
          ' style="background:' + def.color + (def.metal ? ";box-shadow:inset 0 0 6px rgba(255,255,255,0.8)" : "") + '">' +
          (unlocked ? "" : "🔒") + "</button>";
      });
      html += "</div></div>";
    });
    html += '<div class="paint-zone"><h3>Tire sidewalls</h3><div class="swatch-row">';
    Object.keys(B.WALL_OPTIONS).forEach(function (wid) {
      var wd = B.WALL_OPTIONS[wid];
      var sel = (config.colors || {}).wall === wid;
      html += '<button type="button" class="swatch swatch--wide' + (sel ? " is-selected" : "") +
        '" data-wall="' + wid + '" style="background:' + wd.color + '">' + wd.name + "</button>";
    });
    html += "</div></div>";
    elParts.innerHTML = html;
  }

  function renderTuneBench() {
    var verdicts = B.tuneVerdict(config.tune);
    var html = '<p class="part-desc" style="margin:0 0 0.3rem">Setup is speed. Every dial below changes the physics on the mountain — the green band is the Grown-Up Crew\'s recommendation.</p>';
    Object.keys(B.TUNE_SPEC).forEach(function (k) {
      var sp = B.TUNE_SPEC[k];
      var v = config.tune[k];
      var verdict = verdicts[k];
      var recL = ((sp.recLo - sp.min) / (sp.max - sp.min)) * 100;
      var recR = ((sp.recHi - sp.min) / (sp.max - sp.min)) * 100;
      html +=
        '<div class="tune-row"><div class="tune-head"><h3>' + sp.label + '</h3>' +
        '<span class="tune-val">' + v + sp.unit + "</span></div>" +
        '<div class="tune-slider" style="--recl:' + recL + "%;--recr:" + recR + '%">' +
        '<input type="range" min="' + sp.min + '" max="' + sp.max + '" step="1" value="' + v + '" data-tune="' + k + '" aria-label="' + sp.label + '"></div>' +
        '<div class="tune-verdict ' + (verdict.ok ? "is-ok" : "is-off") + '">' + verdict.text + "</div>" +
        '<p class="part-desc">' + sp.blurb + "</p></div>";
    });
    elParts.innerHTML = html;
    elParts.querySelectorAll("[data-tune]").forEach(function (input) {
      input.addEventListener("input", function () {
        config.tune[input.getAttribute("data-tune")] = Number(input.value);
        config = B.normalizeConfig(config, career);
        B.saveConfig(config);
        var vd = B.tuneVerdict(config.tune)[input.getAttribute("data-tune")];
        var row = input.closest(".tune-row");
        row.querySelector(".tune-val").textContent = input.value + B.TUNE_SPEC[input.getAttribute("data-tune")].unit;
        var vEl = row.querySelector(".tune-verdict");
        vEl.textContent = vd.text;
        vEl.className = "tune-verdict " + (vd.ok ? "is-ok" : "is-off");
        renderStats();
      });
    });
  }

  function renderStats() {
    var S = B.computeStats(config);
    elName.textContent = B.riderNameForBike(config);
    elWeight.textContent = S.weightKg.toFixed(1) + " kg";
    Object.keys(S.bars).forEach(function (k) {
      var el2 = document.querySelector('[data-bar="' + k + '"]');
      if (el2) el2.style.width = (S.bars[k] * 10) + "%";
    });
  }

  function renderCareer() {
    var medals = Object.keys(career.medals || {}).map(function (t) { return career.medals[t]; });
    var golds = medals.filter(function (m) { return m === "gold"; }).length;
    var locked = [];
    Object.keys(B.CATALOG).forEach(function (cat) {
      Object.keys(B.CATALOG[cat].options).forEach(function (id) {
        var def = B.CATALOG[cat].options[id];
        if (def.unlock && !B.isUnlocked(def, career)) locked.push(def.name + " — " + def.unlock.label);
      });
    });
    elCareer.innerHTML =
      "<strong>Workshop log:</strong> " + (career.runs || 0) + " runs · " + (career.coins || 0) +
      " copper coins collected · " + golds + " gold" + (golds === 1 ? "" : "s") +
      (locked.length
        ? "<br><strong>Still locked:</strong> " + locked.slice(0, 3).join(" · ") + (locked.length > 3 ? " · +" + (locked.length - 3) + " more" : "")
        : "<br>🏆 Everything is unlocked. The Garage bows to you.");
  }

  elTabs.addEventListener("click", function (e) {
    var b = e.target.closest("[data-tab]");
    if (!b) return;
    activeTab = b.getAttribute("data-tab");
    renderTabs();
    renderParts();
  });

  elParts.addEventListener("click", function (e) {
    var sw = e.target.closest(".swatch");
    if (sw) {
      if (sw.classList.contains("is-locked")) return;
      if (sw.hasAttribute("data-wall")) {
        config.colors.wall = sw.getAttribute("data-wall");
      } else {
        config.colors[sw.getAttribute("data-zone")] = sw.getAttribute("data-paint");
      }
      config = B.normalizeConfig(config, career);
      B.saveConfig(config);
      renderParts();
      rebuildBike();
      return;
    }
    var b = e.target.closest("[data-part]");
    if (!b || b.classList.contains("is-locked")) return;
    var id = b.getAttribute("data-part");
    if (B.CATALOG[activeTab] && B.CATALOG[activeTab].multi) {
      var list = config.extras || [];
      var at = list.indexOf(id);
      if (at >= 0) list.splice(at, 1); else list.push(id);
      config.extras = list;
    } else {
      config[activeTab] = id;
    }
    config = B.normalizeConfig(config, career);
    B.saveConfig(config);
    renderParts();
    renderStats();
    rebuildBike();
  });

  document.getElementById("btn-reset-build").addEventListener("click", function () {
    config = B.normalizeConfig(null, career);
    B.saveConfig(config);
    renderTabs();
    renderParts();
    renderStats();
    rebuildBike();
  });

  /* ---------- loop ---------- */

  window.addEventListener("resize", fitCanvas);
  fitCanvas();
  rebuildBike();
  renderTabs();
  renderParts();
  renderStats();
  renderCareer();

  (function loop() {
    requestAnimationFrame(loop);
    controls.update();
    renderer.render(scene, camera);
  })();
})();
