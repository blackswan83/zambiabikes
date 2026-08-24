/* ==========================================================================
   THE GARAGE — 3D bike builder for Zambia Rush
   Every equipped part is real geometry: frames change silhouette, forks grow
   travel, rotors grow with the brakes, wheels change diameter, the chain is
   an actual chain line. Drag to spin. Build saves to zr3_bike and the game
   reads it — stats AND looks.
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

  var camera = new THREE.PerspectiveCamera(38, 4 / 3, 0.05, 60);
  camera.position.set(1.9, 0.95, 2.3);

  /* environment reflections for the paint: a tiny sunset "room" */
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
    var win = new THREE.Mesh(new THREE.PlaneGeometry(6, 4),
      new THREE.MeshBasicMaterial({ color: 0xFFFFFF }));
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
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.left = -1.6; key.shadow.camera.right = 1.6;
  key.shadow.camera.top = 1.6; key.shadow.camera.bottom = -1.6;
  key.shadow.camera.near = 1; key.shadow.camera.far = 10;
  key.shadow.normalBias = 0.02;
  scene.add(key);
  var rim = new THREE.DirectionalLight(0xBFE8F2, 0.8);
  rim.position.set(-2.5, 1.6, -2.4);
  scene.add(rim);

  /* floor: soft disc + real contact shadow */
  var floor = new THREE.Mesh(new THREE.CircleGeometry(4.5, 40),
    new THREE.MeshStandardMaterial({ color: 0xE3D3B4, roughness: 0.95 }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);
  var ring = new THREE.Mesh(new THREE.RingGeometry(1.28, 1.34, 48),
    new THREE.MeshBasicMaterial({ color: 0xC9B58E }));
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.002;
  scene.add(ring);

  var controls = new OrbitControls(camera, canvas);
  controls.target.set(0, 0.52, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 1.3;
  controls.maxDistance = 4.5;
  controls.maxPolarAngle = Math.PI / 2 + 0.05;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 1.1;
  canvas.addEventListener("pointerdown", function () { controls.autoRotate = false; });

  /* ---------- bike construction ---------- */

  var FORK_TRAVEL = { kafue_100: 0.10, kafue_120: 0.12, muchinga_140: 0.14, muchinga_160: 0.16, mosi_dc_200: 0.20 };
  var TIRE_FAT = { dambo_semislick: 0.026, miombo_grip: 0.031, mudzimu_spike: 0.035, copper_wall: 0.036 };
  var ROTOR_R = { two_pot: 0.09, four_pot: 0.1015, v_brake: 0 };

  var mats = {};
  function M(key, params) {
    if (!mats[key]) mats[key] = new THREE.MeshStandardMaterial(params);
    return mats[key];
  }

  var bikeGroup = null;

  function tube(a, b, r, mat, group) {
    var d = new THREE.Vector3().subVectors(b, a);
    var len = d.length();
    var mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 10), mat);
    mesh.position.copy(a).addScaledVector(d, 0.5);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize());
    mesh.castShadow = true;
    group.add(mesh);
    return mesh;
  }
  var V = function (x, y, z) { return new THREE.Vector3(x, y, z); };

  function plateTexture(name) {
    var c = document.createElement("canvas");
    c.width = 128; c.height = 96;
    var g = c.getContext("2d");
    g.fillStyle = "#F7B733"; g.fillRect(0, 0, 128, 96);
    g.fillStyle = "#0C2E1C";
    g.font = "700 44px Fredoka, Arial, sans-serif";
    g.textAlign = "center";
    g.fillText("10", 64, 48);
    g.font = "700 20px Fredoka, Arial, sans-serif";
    g.fillText((name || "RIDER").toUpperCase().slice(0, 9), 64, 78);
    var tx = new THREE.CanvasTexture(c);
    tx.colorSpace = THREE.SRGBColorSpace;
    return tx;
  }

  function buildWheel(r, tireFat, rotorR, spikes) {
    var w = new THREE.Group();
    var tireM = M("tire" + (spikes ? "s" : ""), { color: spikes ? 0x241D16 : 0x2A2420, roughness: 0.95 });
    var tire = new THREE.Mesh(new THREE.TorusGeometry(r - tireFat, tireFat, 12, 30), tireM);
    tire.castShadow = true;
    w.add(tire);
    if (spikes) {
      var knobG = new THREE.BoxGeometry(0.011, 0.013, 0.011);
      var knobs = new THREE.InstancedMesh(knobG, tireM, 88);
      var m4 = new THREE.Matrix4();
      for (var i = 0; i < 88; i++) {
        var a = ((i >> 1) / 44) * Math.PI * 2 + (i % 2) * 0.07;
        var kr = r - 0.006;
        m4.makeTranslation((i % 2 ? 1 : -1) * 0.017, Math.cos(a) * kr, Math.sin(a) * kr);
        knobs.setMatrixAt(i, m4);
      }
      w.add(knobs);
    }
    var rimR = r - tireFat * 2 - 0.008;
    w.add(new THREE.Mesh(new THREE.TorusGeometry(rimR, 0.011, 8, 30), M("rim", { color: 0x3A3A3E, roughness: 0.5, metalness: 0.6 })));
    var hub = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.024, 0.1, 10), M("hub", { color: 0x8A8A90, metalness: 0.8, roughness: 0.35 }));
    hub.rotation.z = Math.PI / 2;
    w.add(hub);
    var spokeM = M("spoke", { color: 0xB8B8BE, metalness: 0.7, roughness: 0.4 });
    for (var s = 0; s < 16; s++) {
      var a2 = (s / 16) * Math.PI * 2;
      var sp = tube(V((s % 2 ? 0.03 : -0.03), 0, 0), V(0, Math.cos(a2) * rimR, Math.sin(a2) * rimR), 0.0022, spokeM, w);
      sp.castShadow = false;
    }
    if (rotorR > 0) {
      var rotor = new THREE.Mesh(new THREE.CylinderGeometry(rotorR, rotorR, 0.0035, 26), M("rotor", { color: 0xC9CDD2, metalness: 0.9, roughness: 0.3 }));
      rotor.rotation.z = Math.PI / 2;
      rotor.position.x = -0.055;
      w.add(rotor);
      var spider = new THREE.Mesh(new THREE.CylinderGeometry(rotorR * 0.45, rotorR * 0.45, 0.004, 12), M("hub"));
      spider.rotation.z = Math.PI / 2;
      spider.position.x = -0.056;
      w.add(spider);
    }
    return w;
  }

  function buildBike(cfg) {
    var g = new THREE.Group();
    var frame = cfg.frame;
    var paintDef = B.getOption("paint", cfg.paint) || {};
    var paintM = new THREE.MeshStandardMaterial({
      color: new THREE.Color(paintDef.color || "#1F7A48"),
      metalness: paintDef.metal ? 0.85 : 0.25,
      roughness: paintDef.metal ? 0.22 : 0.45
    });
    var darkM = M("dark", { color: 0x24201C, roughness: 0.7 });
    var stanchM = M("stanch", { color: 0xD9A441, metalness: 0.75, roughness: 0.25 });
    var alloyM = M("alloy", { color: 0x9A9AA2, metalness: 0.8, roughness: 0.35 });

    var wheelR = (B.getOption("wheels", cfg.wheels) || {}).radius || 0.345;
    var tireFat = TIRE_FAT[cfg.tires] || 0.031;
    var rotorR = ROTOR_R[cfg.brakes] !== undefined ? ROTOR_R[cfg.brakes] : 0.09;
    var travel = FORK_TRAVEL[cfg.fork] || 0.12;
    var isDC = cfg.fork === "mosi_dc_200";
    var isDJ = frame === "kabwata_dj";
    var isDH = frame === "mosi_dh";
    var isFS = frame === "zambezi_fs" || frame === "muchinga_enduro" || isDH;

    /* anchor points */
    var RA = V(0, wheelR, -0.58 + (isDJ ? 0.05 : 0));
    var FA = V(0, wheelR, 0.58);
    var BB = V(0, 0.3, -0.02);
    var sttY = isDJ ? 0.6 : isDH ? 0.64 : 0.74;
    var STT = V(0, sttY, -0.2);
    var htTopY = isDH ? 0.75 : 0.8;
    var HTt = V(0, htTopY, 0.4);
    var HTb = V(0, htTopY - 0.12, 0.445);
    var tubeR = isDH ? 0.028 : 0.023;

    /* front triangle */
    tube(HTt, STT, tubeR, paintM, g);                       /* top tube */
    tube(HTb, BB, tubeR * 1.2, paintM, g);                  /* down tube */
    tube(BB, V(0, sttY + 0.03, -0.21), tubeR, paintM, g);   /* seat tube */
    tube(HTt, HTb, tubeR * 1.25, paintM, g);                /* head tube */

    /* rear end */
    [-0.045, 0.045].forEach(function (x) {
      tube(V(x, BB.y, BB.z), V(x, RA.y, RA.z), 0.014, isFS ? alloyM : paintM, g);   /* chainstay */
      tube(V(x, RA.y, RA.z), isFS ? V(x, 0.6, -0.14) : V(x, STT.y, STT.z), 0.012, isFS ? alloyM : paintM, g); /* seatstay */
    });
    if (isFS) {
      /* rocker link + shock */
      tube(V(0, 0.6, -0.14), V(0, sttY - 0.05, -0.19), 0.016, alloyM, g);
      var shockA = isDH ? V(0, 0.37, -0.05) : V(0, 0.6, -0.13);
      var shockB = isDH ? V(0, 0.66, 0.06) : V(0, 0.47, 0.12);
      tube(shockA, shockB, 0.026, darkM, g);                /* shock body */
      tube(shockA.clone().lerp(shockB, 0.55), shockB, 0.013, stanchM, g); /* shaft */
      var can = new THREE.Mesh(new THREE.CylinderGeometry(0.034, 0.034, 0.045, 10), alloyM);
      can.position.copy(shockA.clone().lerp(shockB, 0.2));
      g.add(can);
    }

    /* fork: crown, stanchions (travel-length), lowers to the axle */
    var crown = HTb.clone().add(V(0, -0.015, 0.012));
    var lowerTop = crown.clone().lerp(FA, 0.28).add(V(0, -travel * 0.55, 0));
    [-0.052, 0.052].forEach(function (x) {
      var cx = V(x, crown.y, crown.z);
      var lx = V(x, lowerTop.y, lowerTop.z);
      var ax = V(x, FA.y, FA.z);
      tube(cx, lx, 0.017, stanchM, g);                      /* stanchion */
      tube(lx.clone().add(V(0, 0.02, 0)), ax, 0.021, paintM, g); /* lower leg */
    });
    tube(V(-0.052, crown.y, crown.z), V(0.052, crown.y, crown.z), 0.02, darkM, g);
    if (isDC) {
      var upper = V(0, HTt.y + 0.03, HTt.z + 0.01);
      tube(V(-0.052, upper.y, upper.z - 0.02), V(0.052, upper.y, upper.z - 0.02), 0.02, darkM, g);
      [-0.052, 0.052].forEach(function (x) {
        tube(V(x, upper.y, upper.z - 0.02), V(x, crown.y, crown.z), 0.017, stanchM, g);
      });
    }

    /* steerer + cockpit */
    var barC = V(0, HTt.y + 0.075, HTt.z - 0.02);
    tube(HTt, barC, 0.016, darkM, g);
    tube(V(-0.26, barC.y + 0.02, barC.z), V(0.26, barC.y + 0.02, barC.z), 0.011, darkM, g);
    [-1, 1].forEach(function (sd) {
      var grip = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.1, 8),
        M("grip", { color: 0x3A3A3E, roughness: 0.9 }));
      grip.rotation.z = Math.PI / 2;
      grip.position.set(sd * 0.23, barC.y + 0.02, barC.z);
      g.add(grip);
      var lever = tube(V(sd * 0.16, barC.y + 0.01, barC.z + 0.03), V(sd * 0.1, barC.y - 0.005, barC.z + 0.07), 0.006, alloyM, g);
      lever.castShadow = false;
    });

    /* saddle + post */
    var isDropper = cfg.seatpost === "dropper";
    var saddleY = isDJ ? sttY + 0.1 : sttY + 0.2;
    tube(V(0, sttY + 0.02, -0.205), V(0, saddleY, -0.24), isDropper ? 0.017 : 0.013, isDropper ? darkM : alloyM, g);
    if (isDropper) {
      var collar = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.025, 10), alloyM);
      collar.position.set(0, sttY + 0.05, -0.211);
      g.add(collar);
    }
    var saddle = new THREE.Mesh(new THREE.SphereGeometry(0.09, 12, 8), darkM);
    saddle.scale.set(0.55, 0.3, 1.5);
    saddle.position.set(0, saddleY + 0.03, -0.25);
    saddle.castShadow = true;
    g.add(saddle);

    /* drivetrain (drive side +x) */
    var ring2 = new THREE.Mesh(new THREE.CylinderGeometry(0.062, 0.062, 0.008, 22), darkM);
    ring2.rotation.z = Math.PI / 2;
    ring2.position.set(0.055, BB.y, BB.z);
    g.add(ring2);
    [-1, 1].forEach(function (sd) {
      var arm = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.17, 0.03), alloyM);
      arm.position.set(sd * 0.075, BB.y + sd * 0.055, BB.z + sd * 0.02);
      arm.rotation.x = sd * 0.35;
      g.add(arm);
      var pedal = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.015, 0.06), darkM);
      pedal.position.set(sd * 0.11, BB.y + sd * 0.12, BB.z + sd * 0.05);
      g.add(pedal);
    });
    var single = cfg.drivetrain === "one_gear";
    if (single) {
      var cog = new THREE.Mesh(new THREE.CylinderGeometry(0.036, 0.036, 0.006, 16), alloyM);
      cog.rotation.z = Math.PI / 2;
      cog.position.set(0.05, RA.y, RA.z);
      g.add(cog);
    } else {
      for (var ci = 0; ci < 5; ci++) {
        var cogR = 0.048 - ci * 0.0062;
        var c2 = new THREE.Mesh(new THREE.CylinderGeometry(cogR, cogR, 0.0045, 16), alloyM);
        c2.rotation.z = Math.PI / 2;
        c2.position.set(0.042 + ci * 0.0085, RA.y, RA.z);
        g.add(c2);
      }
      var mech = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.07, 0.035), darkM);
      mech.position.set(0.06, RA.y - 0.085, RA.z - 0.01);
      g.add(mech);
    }
    /* chain line */
    var chainPts = [];
    var ringC = V(0.052, BB.y, BB.z), casC = V(0.052, RA.y, RA.z);
    var ringR2 = 0.066, casR2 = single ? 0.04 : 0.05;
    for (var a3 = -Math.PI / 2; a3 <= Math.PI / 2; a3 += 0.5) {
      chainPts.push(V(0.052, ringC.y + Math.sin(a3) * ringR2, ringC.z + Math.cos(a3) * ringR2));
    }
    for (a3 = Math.PI / 2; a3 <= Math.PI * 1.5; a3 += 0.5) {
      chainPts.push(V(0.052, casC.y + Math.sin(a3) * casR2, casC.z - Math.cos(a3) * casR2));
    }
    var chainCurve = new THREE.CatmullRomCurve3(chainPts, true);
    var chain = new THREE.Mesh(new THREE.TubeGeometry(chainCurve, 48, 0.0065, 6, true), darkM);
    g.add(chain);

    /* brake calipers */
    if (rotorR > 0) {
      var calF = new THREE.Mesh(new THREE.BoxGeometry(0.028, 0.055, 0.03), darkM);
      calF.position.set(-0.058, FA.y + rotorR * 0.55, FA.z + 0.035);
      g.add(calF);
      var calR = new THREE.Mesh(new THREE.BoxGeometry(0.028, 0.05, 0.03), darkM);
      calR.position.set(-0.058, RA.y + rotorR * 0.55, RA.z - 0.035);
      g.add(calR);
    }

    /* extras */
    var ex = cfg.extras || [];
    if (ex.indexOf("bottle") >= 0 && !isDJ) {
      var bottle = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.032, 0.17, 10),
        M("bottle", { color: 0x2A9D8F, roughness: 0.5 }));
      bottle.position.set(0, 0.47, 0.09);
      bottle.rotation.x = -0.45;
      g.add(bottle);
    }
    if (ex.indexOf("mudguard") >= 0) {
      var guard = new THREE.Mesh(new THREE.TorusGeometry(wheelR + 0.028, 0.023, 5, 12, Math.PI * 0.7), darkM);
      guard.position.copy(FA);
      guard.rotation.z = Math.PI / 2;
      guard.rotation.y = Math.PI / 2;
      guard.rotation.x = Math.PI * 0.16;
      guard.scale.x = 0.32;
      g.add(guard);
    }
    if (ex.indexOf("bell") >= 0) {
      var bell = new THREE.Mesh(new THREE.SphereGeometry(0.02, 10, 8, 0, Math.PI * 2, 0, Math.PI * 0.55),
        M("bellm", { color: 0xD9A441, metalness: 0.9, roughness: 0.2 }));
      bell.position.set(-0.1, barC.y + 0.045, barC.z);
      g.add(bell);
    }
    if (ex.indexOf("plate") >= 0) {
      var name = "";
      try { name = (JSON.parse(localStorage.getItem("zr_profile") || "{}").name) || ""; } catch (e) { /* ignore */ }
      var plate = new THREE.Mesh(new THREE.PlaneGeometry(0.13, 0.1),
        new THREE.MeshBasicMaterial({ map: plateTexture(name) }));
      plate.position.set(0, HTt.y - 0.04, HTt.z + 0.075);
      plate.rotation.x = -0.12;
      g.add(plate);
    }
    if (ex.indexOf("kickstand") >= 0) {
      tube(V(-0.045, BB.y, BB.z - 0.12), V(-0.1, 0.015, BB.z - 0.2), 0.008, alloyM, g);
    }

    /* wheels last so they sit over everything */
    var rear = buildWheel(wheelR, tireFat, rotorR, cfg.tires === "mudzimu_spike");
    rear.position.copy(RA);
    g.add(rear);
    var front = buildWheel(wheelR, tireFat, rotorR, cfg.tires === "mudzimu_spike");
    front.position.copy(FA);
    g.add(front);

    g.traverse(function (o) { if (o.isMesh && o.castShadow === undefined) o.castShadow = true; });
    return g;
  }

  function rebuildBike() {
    if (bikeGroup) {
      scene.remove(bikeGroup);
      bikeGroup.traverse(function (o) {
        if (o.geometry) o.geometry.dispose();
        if (o.material && o.material.map && o.material.map.isCanvasTexture) o.material.map.dispose();
      });
    }
    bikeGroup = buildBike(config);
    scene.add(bikeGroup);
  }

  /* ---------- UI ---------- */

  var elTabs = document.getElementById("garage-tabs");
  var elParts = document.getElementById("garage-parts");
  var elName = document.getElementById("bike-name");
  var elWeight = document.getElementById("bike-weight");
  var elCareer = document.getElementById("garage-career");
  var activeTab = "frame";

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
      html += '<button type="button" role="tab" class="gtab' + (cat === activeTab ? " is-selected" : "") + '" data-tab="' + cat + '">' + B.CATALOG[cat].label + "</button>";
    });
    elTabs.innerHTML = html;
  }

  function renderParts() {
    var cat = B.CATALOG[activeTab];
    var html = "";
    Object.keys(cat.options).forEach(function (id) {
      var def = cat.options[id];
      var unlocked = B.isUnlocked(def, career);
      var equipped = cat.multi ? (config.extras || []).indexOf(id) >= 0 : config[activeTab] === id;
      var cls = "part-card" + (equipped ? " is-equipped" : "") + (unlocked ? "" : " is-locked");
      var swatch = activeTab === "paint" ? '<span class="paint-dot" style="background:' + def.color + '"></span>' : "";
      html +=
        '<button type="button" class="' + cls + '" data-part="' + id + '"' + (unlocked ? "" : " aria-disabled='true'") + ">" +
        '<span class="part-head"><h3>' + swatch + def.name + (equipped ? " ✓" : "") + "</h3>" +
        '<span class="part-kg">' + (def.kg ? def.kg.toFixed(2) + " kg" : "") + "</span></span>" +
        '<span class="part-spec">' + (def.spec || "") + "</span>" +
        '<p class="part-desc">' + def.desc + "</p>" +
        '<span class="part-chips">' + statChips(def) +
        (unlocked ? "" : '<span class="pchip pchip--lock">🔒 ' + def.unlock.label + "</span>") +
        "</span></button>";
    });
    elParts.innerHTML = html;
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
    var b = e.target.closest("[data-part]");
    if (!b || b.classList.contains("is-locked")) return;
    var id = b.getAttribute("data-part");
    if (B.CATALOG[activeTab].multi) {
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
