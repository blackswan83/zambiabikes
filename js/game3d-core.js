/* ==========================================================================
   ZAMBIA RUSH 3D — simulation core (no rendering, no DOM)

   Everything deterministic and renderer-independent lives here: seeded
   terrain, the carved trail, props, coins, arcade bike physics, the AI
   riders whose ghosts you race, and Ghost Code packing. The Three.js
   renderer (js/game3d.js) only *reads* this world. Loaded in the browser
   it exposes window.ZR3; under node it exports the same API for tests.

   Units are meters, +z is downhill along the mountain, +y is up.
   ========================================================================== */

(function () {
  "use strict";

  /* ================= deterministic PRNG + value noise ================= */

  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function hash2(ix, iz, seed) {
    var h = (ix * 374761393 + iz * 668265263 + seed * 2246822519) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return (((h ^ (h >>> 16)) >>> 0) / 4294967296) * 2 - 1;
  }

  function smooth(t) { return t * t * (3 - 2 * t); }

  function vnoise(x, z, seed) {
    var ix = Math.floor(x), iz = Math.floor(z);
    var fx = x - ix, fz = z - iz;
    var a = hash2(ix, iz, seed), b = hash2(ix + 1, iz, seed);
    var c = hash2(ix, iz + 1, seed), d = hash2(ix + 1, iz + 1, seed);
    var u = smooth(fx), v = smooth(fz);
    return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
  }

  /* ================= track definitions ================= */

  var TRACKS3 = {
    miombo: {
      id: "miombo", name: "Miombo Meander", level: "easy", levelLabel: "Easy Rider",
      hazards: [{ type: "hippo", from: 260, every: 290, lat: 2.6, spread: 1.6, r: 1.5 }],
      seed: 20260912, length: 1250, slope: 0.105, wobble: 0.85, kickerEvery: 130,
      desc: "Flowing forest singletrack",
      unique: "The one every club rider learns on. Fast, flowing singletrack under the msasa trees, with just enough kickers to get you comfortable in the air, and hippos grazing the trail edges to keep you honest.",
      feats: ["Flowing singletrack", "Grazing hippos", "Gentle gradient"],
      theme: {
        sky: 0xBFE8F2, skyLow: 0xFFF6D9, fog: 0xD8EFDC, fogNear: 60, fogFar: 420,
        sun: 0xFFF7DC, sunPos: [140, 220, -160], ambient: 0x9CC5A8,
        turbidity: 4, rayleigh: 1.4, mieCoeff: 0.003, mieG: 0.78, cloudCover: 0.42, exposure: 0.52,
        grass: 0x4E9B58, grassDry: 0x7FAE5A, dirt: 0x8A6238, dirtDark: 0x6B4826, rock: 0x8B8570,
        trunk: 0x5A4028, canopy: 0x2F7A44, canopy2: 0x57944B, accent: 0xE8791D,
        water: 0x6FBFB4
      }
    },
    baobab: {
      id: "baobab", name: "Baobab Ridge", level: "trail", levelLabel: "Trail Star",
      hazards: [{ type: "elephant", from: 300, every: 340, lat: 3.0, spread: 1.6, r: 1.8 }],
      seed: 20261010, length: 1500, slope: 0.13, wobble: 1.0, kickerEvery: 110,
      desc: "Sunset savanna, big kickers",
      unique: "Golden hour on the ridge, with the biggest kickers in the game and thousand-year-old baobabs to thread between. Elephants graze the open savanna. This is where you learn to jump properly.",
      feats: ["Biggest air", "Ancient baobabs", "Elephants"],
      theme: {
        sky: 0xFFC969, skyLow: 0xF7B733, fog: 0xE09B55, fogNear: 80, fogFar: 480,
        sun: 0xFFE9B0, sunPos: [-200, 70, -280], ambient: 0xD9B08C,
        sunI: 1.6, hemiI: 1.05, ambI: 0.45, hemiGround: 0x7A5A30, cloudTint: 0xFFD9C0,
        turbidity: 7, rayleigh: 1.7, mieCoeff: 0.0035, mieG: 0.8, cloudCover: 0.22, exposure: 0.46,
        grass: 0xA8933E, grassDry: 0xC2A94E, dirt: 0x7E4A20, dirtDark: 0x5E3616, rock: 0x8A6A4C,
        trunk: 0x6E4A26, canopy: 0x6E5A2A, canopy2: 0x8A6F33, accent: 0xE8791D,
        water: 0xE8A45C
      }
    },
    kasanka: {
      id: "kasanka", name: "Kasanka Bat Storm", level: "trail", levelLabel: "Trail Star",
      seed: 20261121, length: 1400, slope: 0.05, wobble: 0.85, kickerEvery: 140,
      hazards: [{ type: "antelope", from: 240, every: 330, lat: 2.2, spread: 1.5, r: 1.0 }],
      desc: "Dusk in the swamp forest — ten million bats overhead",
      unique: "Every November ten million straw-coloured fruit bats pour into one patch of Kasanka swamp forest, the largest mammal migration on Earth. You ride under it at dusk, through ground mist, with rivers of bats crossing the sky.",
      feats: ["10 million bats", "Ground mist", "Dusk light"],
      theme: {
        sky: 0x4A3E68, skyLow: 0xF2A05C, fog: 0x9A8A96, fogNear: 45, fogFar: 300,
        sun: 0xFFB877, sunPos: [-170, 38, -250], ambient: 0xA89AB0,
        turbidity: 6, rayleigh: 3.2, mieCoeff: 0.009, mieG: 0.85, cloudCover: 0.25, exposure: 0.56,
        grass: 0x2E6E44, grassDry: 0x6E8448, dirt: 0x6B4E36, dirtDark: 0x4E3826, rock: 0x686458,
        trunk: 0x4A3828, canopy: 0x1F5438, canopy2: 0x2E6E44, accent: 0xE8791D,
        water: 0x2E5E56, bats: true, groundMist: true, cloudTint: 0xD9A8A0, ridgeDim: 0.45
      }
    },
    zambezi: {
      id: "zambezi", name: "Lower Zambezi", level: "trail", levelLabel: "Trail Star",
      seed: 20261107, length: 1600, slope: 0.062, wobble: 0.8, kickerEvery: 150,
      river: { offset: 24, width: 70, depth: 2.2 },
      desc: "Riverside flow — mind the crocs",
      unique: "A flowing riverside line beside the real Zambezi, with sandy beaches, reed beds and hippo pods out in the water. Crocodiles bask right on the trail edge, and the river is very much not a shortcut.",
      feats: ["The real Zambezi", "Basking crocs", "Hippo pods"],
      theme: {
        sky: 0xC2E4EE, skyLow: 0xF5E6B8, fog: 0xD8E4C4, fogNear: 70, fogFar: 450,
        sun: 0xFFF2CC, sunPos: [-150, 130, -260], ambient: 0xB0C49A,
        turbidity: 5, rayleigh: 1.7, mieCoeff: 0.004, mieG: 0.8, cloudCover: 0.3, exposure: 0.56,
        grass: 0x3E8E52, grassDry: 0x8AA84E, dirt: 0x8A6238, dirtDark: 0x6B4826, rock: 0x7E7A64,
        trunk: 0x5A4028, canopy: 0x2F7A44, canopy2: 0x4E9B58, accent: 0xE8791D,
        water: 0x2E6E5E, sand: 0xD8C08A
      }
    },
    falls: {
      id: "falls", name: "Mosi Falls Drop", level: "hero", levelLabel: "Downhill Hero",
      seed: 20260926, length: 1750, slope: 0.165, wobble: 1.15, kickerEvery: 100,
      /* the finale rides the Knife-Edge rim: a transverse chasm opens on +x
         and the mile-wide Victoria Falls curtain forms its far wall */
      gorge: { fromFrac: 0.84, offset: 32, width: 95, depth: 60 },
      hazards: [{ type: "croc", from: 220, every: 300, lat: 2.0, spread: 1.7, r: 1.05 }],
      desc: "Steep canyon to the thundering Victoria Falls",
      unique: "The hero line. The steepest, longest descent in the game, finishing along the Knife-Edge rim with Victoria Falls thundering across the gorge beside you. Beat Armand here and you have beaten the mountain.",
      feats: ["Victoria Falls", "The gorge", "Steepest drop"],
      theme: {
        sky: 0xC6ECEF, skyLow: 0xEAF9F4, fog: 0xCDE9E2, fogNear: 45, fogFar: 380,
        sun: 0xF6FFF0, sunPos: [180, 260, -60], ambient: 0x8FB8A8,
        turbidity: 3, rayleigh: 1.0, mieCoeff: 0.003, mieG: 0.76, cloudCover: 0.5, exposure: 0.55,
        grass: 0x3F8A50, grassDry: 0x5E9B58, dirt: 0x74583A, dirtDark: 0x54402A, rock: 0x6E6A5E,
        trunk: 0x4E3A24, canopy: 0x2A6E48, canopy2: 0x3F8A50, accent: 0x2A9D8F,
        water: 0xBFE8E2
      }
    }
  };
  var TRACK3_ORDER = ["miombo", "baobab", "kasanka", "zambezi", "falls"];

  /* ================= world building ================= */

  var GRID_STEP = 4;
  var X_HALF = 240;              /* world half-width in x */
  var TRAIL_DS = 5;              /* trail sample spacing */
  var CARVE_R = 9;               /* trail carve radius */

  function baseHeight(def, x, z) {
    var s = def.seed;
    var h = -z * def.slope;
    h += 10 * vnoise(x / 210, z / 210, s);
    h += 5 * vnoise(x / 88, z / 88, s + 7);
    h += 2.1 * vnoise(x / 37, z / 37, s + 13);
    h += 0.7 * vnoise(x / 13, z / 13, s + 29);
    /* valley walls keep the ride in a broad corridor; river tracks stay open
       on the water side so the bank can fall away to the Zambezi */
    var wall;
    if (def.river) wall = smoothstepN(-x, 100, 240) * 30;
    else if (def.id === "falls") wall = smoothstepN(Math.abs(x), 70, 200) * 55;
    else wall = smoothstepN(Math.abs(x), 120, 250) * 34;
    return h + wall;
  }

  function smoothstepN(v, a, b) {
    var t = Math.min(1, Math.max(0, (v - a) / (b - a)));
    return t * t * (3 - 2 * t);
  }

  /* The trail spline is generated from the track definition alone, so the
     menu's course map can draw the real line without building a heightfield.
     `rng` supplies only the three phase offsets (its first three draws), which
     keeps buildWorld's random stream identical to a bare mulberry32(seed). */
  function buildTrailPath(def, rng) {
    var n = Math.floor(def.length / TRAIL_DS);
    var pts = new Array(n);
    var phi1 = rng() * 6.28, phi2 = rng() * 6.28, phi3 = rng() * 6.28;
    var x = 0, z = 0, i;
    for (i = 0; i < n; i++) {
      var t = i * TRAIL_DS;
      var theta = def.wobble * (0.62 * Math.sin(t * 0.011 + phi1) +
        0.34 * Math.sin(t * 0.027 + phi2) + 0.18 * Math.sin(t * 0.052 + phi3));
      if (theta > 1.0) theta = 1.0; if (theta < -1.0) theta = -1.0;
      x += Math.sin(theta) * TRAIL_DS;
      z += Math.cos(theta) * TRAIL_DS;
      if (x > X_HALF - 60) x = X_HALF - 60;
      if (x < -(X_HALF - 60)) x = -(X_HALF - 60);
      pts[i] = { x: x, z: z, y: 0, yaw: theta, dist: t };
    }

    /* trail heights from terrain, then smoothed hard so it's rideable */
    for (i = 0; i < n; i++) pts[i].y = baseHeight(def, pts[i].x, pts[i].z);
    for (var pass = 0; pass < 3; pass++) {
      for (i = 2; i < n - 2; i++) {
        pts[i].y = (pts[i - 2].y + pts[i - 1].y * 2 + pts[i].y * 3 + pts[i + 1].y * 2 + pts[i + 2].y) / 9;
      }
    }
    /* clamp trail grade so climbs stay pedalable */
    for (i = 1; i < n; i++) {
      if (pts[i].y > pts[i - 1].y + TRAIL_DS * 0.14) pts[i].y = pts[i - 1].y + TRAIL_DS * 0.14;
      if (pts[i].y < pts[i - 1].y - TRAIL_DS * 0.55) pts[i].y = pts[i - 1].y - TRAIL_DS * 0.55;
    }
    return { pts: pts, n: n };
  }

  /* compact summary for the menu's course map — no grid, cheap to call */
  function trailPreview(def) {
    var path = buildTrailPath(def, mulberry32(def.seed));
    var pts = path.pts, n = path.n;
    var minX = Infinity, maxX = -Infinity, i;
    for (i = 0; i < n; i++) {
      if (pts[i].x < minX) minX = pts[i].x;
      if (pts[i].x > maxX) maxX = pts[i].x;
    }
    return {
      pts: pts, n: n,
      minX: minX, maxX: maxX,
      zEnd: pts[n - 1].z,
      drop: Math.round(pts[0].y - pts[n - 1].y),
      kickers: Math.max(1, Math.round(def.length / def.kickerEvery))
    };
  }

  function buildWorld(def) {
    var rng = mulberry32(def.seed);

    /* ---- trail path: wandering descent, z strictly increasing ---- */
    var path = buildTrailPath(def, rng);
    var pts = path.pts, n = path.n, i;
    var zEnd = pts[n - 1].z;

    /* kickers: shaped bumps that launch you; on falls, extra step-downs */
    var kickers = [];
    var kz = 25 + rng() * def.kickerEvery;
    while (kz < def.length - 120) {
      var ki = Math.floor(kz / TRAIL_DS);
      if (ki > 4 && ki < n - 6) {
        kickers.push(ki);
        var amp = 0.9 + rng() * 0.7;
        pts[ki - 1].y += amp * 0.35;
        pts[ki].y += amp;             /* lip */
        /* landing stays as-is: the drop after the lip is the jump */
      }
      kz += def.kickerEvery * (0.75 + rng() * 0.6);
    }

    /* ---- heightfield grid with trail carved in ---- */
    var nx = Math.floor((X_HALF * 2) / GRID_STEP) + 1;
    var z0 = -40, z1 = zEnd + 100;
    var nz = Math.floor((z1 - z0) / GRID_STEP) + 1;
    var H = new Float32Array(nx * nz);
    var TD = new Float32Array(nx * nz);   /* distance to trail, for coloring + physics */

    /* trail index lookup by z (z is strictly increasing along the trail) */
    function trailRangeForZ(zz) {
      var lo = 0, hi = n - 1;
      while (lo < hi) { var mid = (lo + hi) >> 1; if (pts[mid].z < zz) lo = mid + 1; else hi = mid; }
      return lo;
    }

    for (var gz = 0; gz < nz; gz++) {
      var wz = z0 + gz * GRID_STEP;
      var ci = trailRangeForZ(wz);
      for (var gx = 0; gx < nx; gx++) {
        var wx = -X_HALF + gx * GRID_STEP;
        var h = baseHeight(def, wx, wz);
        /* nearest trail point in a window around ci */
        var best = 1e9, bestY = 0;
        for (var k = Math.max(0, ci - 8); k < Math.min(n, ci + 8); k++) {
          var dx = pts[k].x - wx, dz = pts[k].z - wz;
          var d2 = dx * dx + dz * dz;
          if (d2 < best) { best = d2; bestY = pts[k].y; }
        }
        var d = Math.sqrt(best);
        var w = 1 - smoothstepN(d, 2.2, CARVE_R);
        H[gz * nx + gx] = h * (1 - w) + bestY * w;
        TD[gz * nx + gx] = d;
      }
    }

    /* river tracks: drop everything beyond the bank to the water, with a
       sandy beach slope, and remember the water level per grid row */
    var rowWaterY = null;
    var rowEdgeX = null;
    if (def.river) {
      rowWaterY = new Float32Array(nz);
      rowEdgeX = new Float32Array(nz);
      for (gz = 0; gz < nz; gz++) {
        var wz2 = z0 + gz * GRID_STEP;
        var ti2 = trailRangeForZ(wz2);
        var tp = pts[Math.min(n - 1, ti2)];
        var edge = tp.x + def.river.offset;
        var wY = tp.y - def.river.depth;
        rowWaterY[gz] = wY;
        rowEdgeX[gz] = edge;
        for (gx = 0; gx < nx; gx++) {
          var wx2 = -X_HALF + gx * GRID_STEP;
          var dEdge = wx2 - edge;
          var vi2 = gz * nx + gx;
          if (dEdge <= -14) {
            /* the floodplain never dips under the waterline — the only
               place to get wet is the river itself */
            if (H[vi2] < wY + 1.3) H[vi2] = wY + 1.3;
          } else if (dEdge < 12) {
            /* beach: ease the bank down toward the water */
            var k = smoothstepN(dEdge, -14, 12);
            var hLand = H[vi2] < wY + 1.3 ? wY + 1.3 : H[vi2];
            H[vi2] = hLand * (1 - k) + (wY - 1.2) * k;
          } else if (dEdge < def.river.width) {
            H[vi2] = wY - 1.2 - Math.min(2.2, (dEdge - 12) * 0.1);
          } else {
            /* far bank rises into hazy tree line */
            H[vi2] = wY - 1 + smoothstepN(dEdge, def.river.width, def.river.width + 36) * 9;
          }
        }
      }
    }

    /* Victoria Falls finale: a transverse chasm opens beside the rim trail,
       its far wall carrying the curtain, the upper Zambezi flat behind it */
    var rowGorgeX = null;
    if (def.gorge) {
      var G = def.gorge;
      rowGorgeX = new Float32Array(nz);
      rowGorgeX.fill(Infinity);
      for (gz = 0; gz < nz; gz++) {
        var gwz = z0 + gz * GRID_STEP;
        var gti = Math.min(n - 1, trailRangeForZ(gwz));
        var gFrac = gti / (n - 1);
        var fade = smoothstepN(gFrac, G.fromFrac - 0.05, G.fromFrac + 0.02);
        if (fade <= 0) continue;
        var gtp = pts[gti];
        var edgeG = gtp.x + G.offset;
        var floorY = gtp.y - G.depth;
        var lipY = gtp.y + 5;
        if (fade > 0.4) rowGorgeX[gz] = edgeG;
        for (gx = 0; gx < nx; gx++) {
          var gwx = -X_HALF + gx * GRID_STEP;
          var dG = gwx - edgeG;
          if (dG <= 0) continue;
          var gvi = gz * nx + gx;
          var carved;
          if (dG < 7) {
            carved = H[gvi] + smoothstepN(dG, 0, 7) * (floorY - H[gvi]);
          } else if (dG < G.width - 10) {
            carved = floorY;
          } else if (dG < G.width) {
            carved = floorY + smoothstepN(dG, G.width - 10, G.width) * (lipY - floorY);
          } else if (dG < G.width + 70) {
            carved = lipY + (dG - G.width) * 0.03;   /* upper river plateau */
          } else {
            carved = lipY + 2.1 + smoothstepN(dG, G.width + 70, G.width + 120) * (H[gvi] - lipY - 2.1);
          }
          H[gvi] = H[gvi] * (1 - fade) + carved * fade;
        }
      }
    }

    var world = {
      def: def, nx: nx, nz: nz, z0: z0, x0: -X_HALF, step: GRID_STEP,
      H: H, TD: TD, trail: pts, trailN: n, finishIdx: n - 4,
      kickers: kickers, props: [], coins: [], gates: [], hash: {}, hashCell: 8,
      rowWaterY: rowWaterY, rowEdgeX: rowEdgeX, rowGorgeX: rowGorgeX, riverEdgeX: null, waterY: null
    };

    /* re-sample trail y from the carved grid so physics and path agree */
    for (i = 0; i < n; i++) pts[i].y = heightAt(world, pts[i].x, pts[i].z);

    if (def.river) {
      world.riverEdgeX = new Float32Array(n);
      world.waterY = new Float32Array(n);
      for (i = 0; i < n; i++) {
        world.riverEdgeX[i] = pts[i].x + def.river.offset;
        world.waterY[i] = pts[i].y - def.river.depth;
      }
    }

    /* ---- gates (checkpoints) every ~150 m + finish ---- */
    for (i = 30; i < n - 8; i += Math.round(150 / TRAIL_DS)) world.gates.push(i);

    /* ---- coins along the trail, arcs over kickers ---- */
    var cz = 40;
    while (cz < def.length - 60) {
      var ciX = Math.floor(cz / TRAIL_DS);
      if (ciX >= n - 6) break;
      var overKick = false;
      for (k = 0; k < kickers.length; k++) if (Math.abs(kickers[k] - ciX) < 4) { overKick = true; break; }
      var count = 4;
      for (k = 0; k < count; k++) {
        var p = pts[Math.min(n - 1, ciX + k)];
        var lift = overKick ? 1.4 + 1.5 * Math.sin((k / (count - 1)) * Math.PI) : 1.2;
        world.coins.push({ x: p.x, y: p.y + lift, z: p.z });
      }
      cz += 30 + rng() * 36;
    }

    /* ---- props: trees, rocks, wildlife — never on the trail ---- */
    var POOLS = {
      miombo: [["miombo", 5, 2.0], ["miombo", 5, 2.0], ["bush", 2, 0], ["rock", 2, 1.1], ["fern", 1, 0], ["grass", 4, 0]],
      baobab: [["baobab", 2, 2.6], ["acacia", 3, 1.6], ["termite", 2, 0.9], ["grass", 5, 0], ["rock", 2, 1.1], ["bush", 1, 0]],
      kasanka: [["miombo", 4, 2.0], ["palm", 2, 1.4], ["reed", 3, 0], ["fern", 3, 0], ["grass", 2, 0], ["bush", 2, 0]],
      zambezi: [["palm", 3, 1.4], ["miombo", 3, 2.0], ["reed", 3, 0], ["bush", 2, 0], ["grass", 3, 0], ["rock", 1, 1.1]],
      falls: [["miombo", 4, 2.0], ["palm", 2, 1.4], ["rock", 4, 1.4], ["fern", 3, 0], ["grass", 3, 0], ["bush", 1, 0]]
    };
    var pool = [];
    POOLS[def.id].forEach(function (e) { for (var q = 0; q < e[1]; q++) pool.push([e[0], e[2]]); });

    var propCount = Math.floor(def.length * 1.35);
    for (i = 0; i < propCount; i++) {
      var px = (rng() * 2 - 1) * (X_HALF - 12);
      var pz = rng() * (zEnd - 20) + 5;
      var ti = trailRangeForZ(pz);
      var dBest = 1e9;
      for (k = Math.max(0, ti - 6); k < Math.min(n, ti + 6); k++) {
        var ddx = pts[k].x - px, ddz = pts[k].z - pz;
        var dd = ddx * ddx + ddz * ddz;
        if (dd < dBest) dBest = dd;
      }
      dBest = Math.sqrt(dBest);
      var pick = pool[Math.floor(rng() * pool.length)];
      var margin = pick[1] > 0 ? 7.5 : 4.5;
      if (dBest < margin) continue;
      /* keep land props out of the river */
      if (def.river) {
        var rti = trailRangeForZ(pz);
        if (px > pts[Math.min(n - 1, rti)].x + def.river.offset - 5) continue;
      }
      /* and out of the falls gorge + curtain wall */
      if (def.gorge) {
        var gpi = Math.min(n - 1, trailRangeForZ(pz));
        if (gpi / (n - 1) > def.gorge.fromFrac - 0.06 &&
            px > pts[gpi].x + def.gorge.offset - 6) continue;
      }
      world.props.push({
        type: pick[0], x: px, z: pz, y: heightAt(world, px, pz),
        s: 0.75 + rng() * 0.7, rot: rng() * 6.28, r: pick[1]
      });
    }

    /* ---- Lower Zambezi hazards & riverside life ---- */
    if (def.river) {
      /* crocs sun themselves ON the trail edges — the racing line stays open,
         but a lazy line meets teeth. Straight-ish segments only, so the AI
         ghosts' centre line never clips one. */
      var cz2 = 140;
      var side2 = 1;
      while (cz2 < def.length - 120) {
        var ciT = Math.floor(cz2 / TRAIL_DS);
        if (ciT > 6 && ciT < n - 8) {
          var yawA = Math.atan2(pts[ciT + 3].x - pts[ciT - 3].x, pts[ciT + 3].z - pts[ciT - 3].z);
          var yawB = pts[ciT].yaw;
          var bend = Math.abs(yawA - yawB);
          if (bend < 0.14) {
            var cp = pts[ciT];
            var lat = side2 * (1.7 + rng() * 1.9);
            world.props.push({
              type: "croc", x: cp.x + lat, z: cp.z, y: heightAt(world, cp.x + lat, cp.z),
              s: 0.85 + rng() * 0.4, rot: rng() * 6.28, r: 1.05
            });
            side2 = -side2;
          }
        }
        cz2 += 120 + rng() * 90;
      }
      /* a few more crocs hauled out on the beach, plus hippo pods in the water */
      var bz = 200;
      while (bz < def.length - 150) {
        var bti = Math.floor(bz / TRAIL_DS);
        var bp = pts[Math.min(n - 1, bti)];
        if (rng() < 0.6) {
          world.props.push({
            type: "croc", x: bp.x + def.river.offset - 5 - rng() * 5, z: bp.z,
            y: heightAt(world, bp.x + def.river.offset - 5, bp.z),
            s: 0.9 + rng() * 0.45, rot: 1.2 + rng() * 0.8, r: 1.05
          });
        } else {
          var hx = bp.x + def.river.offset + 16 + rng() * 24;
          world.props.push({
            type: "hippo", x: hx, z: bp.z, y: (world.waterY ? bp.y - def.river.depth : bp.y) + 0.1,
            s: 1, rot: rng() * 6.28, r: 0
          });
        }
        bz += 240 + rng() * 200;
      }
    }
    /* wildlife, well away from the trail */
    var FAUNA = { miombo: ["antelope", "antelope", "zebra"], baobab: ["giraffe", "elephant", "zebra", "antelope"], kasanka: ["antelope", "antelope", "elephant"], zambezi: ["elephant", "antelope", "zebra"], falls: ["antelope", "elephant"] };
    var fz = 150;
    while (fz < zEnd - 150) {
      var side = rng() < 0.5 ? -1 : 1;
      var ti2 = trailRangeForZ(fz);
      var fx = pts[Math.min(n - 1, ti2)].x + side * (26 + rng() * 40);
      if (Math.abs(fx) < X_HALF - 20) {
        var ft = FAUNA[def.id][Math.floor(rng() * FAUNA[def.id].length)];
        world.props.push({ type: ft, x: fx, z: fz, y: heightAt(world, fx, fz), s: 1, rot: rng() * 6.28, r: 2.2 });
      }
      fz += 260 + rng() * 240;
    }

    /* ---- trail hazards: big animals dozing on the racing line's edges ----
       Straight-ish segments only, alternating sides, never on the centre
       line — the AI ghosts stay clean and a good line always exists, but a
       lazy line meets two tonnes of hippo. Placed last so the rng draws of
       everything above stay untouched. */
    (def.hazards || []).forEach(function (hz) {
      var hzZ = hz.from;
      var hzSide = 1;
      while (hzZ < def.length - 120) {
        var hzI = Math.floor(hzZ / TRAIL_DS);
        if (hzI > 6 && hzI < n - 8) {
          var hYawA = Math.atan2(pts[hzI + 3].x - pts[hzI - 3].x, pts[hzI + 3].z - pts[hzI - 3].z);
          var hBend = Math.abs(hYawA - pts[hzI].yaw);
          if (hBend < 0.14) {
            var hzP = pts[hzI];
            var hzLat = hzSide * (hz.lat + rng() * hz.spread);
            world.props.push({
              type: hz.type, x: hzP.x + hzLat, z: hzP.z, y: heightAt(world, hzP.x + hzLat, hzP.z),
              s: 0.9 + rng() * 0.25, rot: rng() * 6.28, r: hz.r
            });
            hzSide = -hzSide;
          }
        }
        hzZ += hz.every + rng() * 110;
      }
    });

    /* spatial hash of solid props for collisions */
    for (i = 0; i < world.props.length; i++) {
      var pr = world.props[i];
      if (pr.r <= 0) continue;
      var key = Math.floor(pr.x / world.hashCell) + "," + Math.floor(pr.z / world.hashCell);
      (world.hash[key] || (world.hash[key] = [])).push(i);
    }

    return world;
  }

  /* ================= terrain queries ================= */

  function heightAt(world, x, z) {
    var fx = (x - world.x0) / world.step;
    var fz = (z - world.z0) / world.step;
    var ix = Math.floor(fx), iz = Math.floor(fz);
    if (ix < 0) ix = 0; if (iz < 0) iz = 0;
    if (ix > world.nx - 2) ix = world.nx - 2;
    if (iz > world.nz - 2) iz = world.nz - 2;
    var tx = fx - ix, tz = fz - iz;
    var i00 = iz * world.nx + ix;
    var a = world.H[i00], b = world.H[i00 + 1];
    var c = world.H[i00 + world.nx], d = world.H[i00 + world.nx + 1];
    return a * (1 - tx) * (1 - tz) + b * tx * (1 - tz) + c * (1 - tx) * tz + d * tx * tz;
  }

  function trailDistAt(world, x, z) {
    var fx = (x - world.x0) / world.step;
    var fz = (z - world.z0) / world.step;
    var ix = Math.round(fx), iz = Math.round(fz);
    if (ix < 0) ix = 0; if (iz < 0) iz = 0;
    if (ix > world.nx - 1) ix = world.nx - 1;
    if (iz > world.nz - 1) iz = world.nz - 1;
    return world.TD[iz * world.nx + ix];
  }

  function normalAt(world, x, z) {
    var e = 1.2;
    var hx = heightAt(world, x + e, z) - heightAt(world, x - e, z);
    var hz = heightAt(world, x, z + e) - heightAt(world, x, z - e);
    var nx = -hx / (2 * e), nz = -hz / (2 * e);
    var len = Math.sqrt(nx * nx + 1 + nz * nz);
    return { x: nx / len, y: 1 / len, z: nz / len };
  }

  /* ================= physics ================= */

  var DT = 1 / 60;
  var GRAV = 14.5;
  var PEDAL_A = 13;
  var VCAP = 21;           /* pedal speed cap on the flat; gravity can exceed it */
  var BRAKE_A = 20;
  var DRAG = 0.011;
  var ROLL = 0.4;
  var STEER_RATE = 2.3;
  var HOP_V = 4.9;
  var CRASH_IMPACT = 11.5;

  function newRider3(world) {
    var p0 = world.trail[2];
    var p1 = world.trail[3];
    return {
      x: p0.x, y: p0.y, z: p0.z,
      vx: 0, vy: 0, vz: 0,
      yaw: Math.atan2(p1.x - p0.x, p1.z - p0.z),
      onGround: true, airT: 0, crashT: 0, crashes: 0, hopCd: 0,
      trailIdx: 2, trailD: 0, respawnIdx: 2,
      t: 0, finished: false, finishT: 0,
      score: 0, coinCount: 0, bigAirs: 0,
      coinPtr: 0, wheelSpin: 0, lean: 0, power: 1, noCrash: false,
      offTrail: false
    };
  }

  var DEFAULT_STATS = { pedal: 1, vcap: 1, brake: 1, steer: 1, roll: 1, rough: 1, landSoft: 0, hop: 1 };

  function stepRider3(st, inp, world, ev, taken) {
    var speed, i, f;
    var S = st.stats || DEFAULT_STATS;

    st.hopCd -= DT;

    /* --- crash state: tumble briefly, then respawn at the last gate --- */
    if (st.crashT > 0) {
      st.crashT -= DT;
      st.vx *= 0.9; st.vz *= 0.9;
      if (!st.onGround) { st.vy -= GRAV * DT; st.y += st.vy * DT; }
      st.x += st.vx * DT; st.z += st.vz * DT;
      var gh = heightAt(world, st.x, st.z);
      if (st.y <= gh) { st.y = gh; st.onGround = true; st.vy = 0; }
      if (st.crashT <= 0) {
        var rp = world.trail[st.respawnIdx];
        var rq = world.trail[Math.min(world.trailN - 1, st.respawnIdx + 1)];
        st.x = rp.x; st.z = rp.z; st.y = rp.y;
        st.yaw = Math.atan2(rq.x - rp.x, rq.z - rp.z);
        st.vx = st.vy = st.vz = 0;
        st.onGround = true;
        st.trailIdx = st.respawnIdx;
        ev.push({ t: "respawn" });
      }
      st.t += DT;
      return;
    }

    /* rider faces +z and the chase camera sits behind, so screen-right is
       world -x: "right" must turn the heading toward -x, i.e. lower yaw */
    var steer = (inp.left ? 1 : 0) - (inp.right ? 1 : 0);

    if (st.onGround) {
      var n = normalAt(world, st.x, st.z);
      /* forward projected onto the slope */
      var fx0 = Math.sin(st.yaw), fz0 = Math.cos(st.yaw);
      var dot = fx0 * n.x + fz0 * n.z;   /* f·n with f.y=0 */
      f = { x: fx0 - n.x * dot, y: -dot * n.y, z: fz0 - n.z * dot };
      var fl = Math.sqrt(f.x * f.x + f.y * f.y + f.z * f.z) || 1;
      f.x /= fl; f.y /= fl; f.z /= fl;

      speed = st.vx * f.x + st.vy * f.y + st.vz * f.z;

      /* forces along the trail direction */
      speed += (-GRAV * f.y) * DT;                       /* slope: f.y<0 going down */
      if (inp.pedal && speed < VCAP * S.vcap) speed += PEDAL_A * S.pedal * (speed < 6 ? 1.55 : 1) * st.power * DT;
      if (inp.brake) { speed -= BRAKE_A * S.brake * DT; if (speed < 0) speed = 0; }
      var offT = st.trailD > CARVE_R;
      st.offTrail = offT;
      var drag = DRAG * (offT ? 1 + 1.4 * S.rough : 1);
      speed -= speed * Math.abs(speed) * drag * DT;
      speed -= Math.sign(speed) * Math.min(Math.abs(speed), ROLL * S.roll * (offT ? 1 + 1.2 * S.rough : 1) * DT * 10);

      /* steering, softer at speed */
      st.yaw += steer * STEER_RATE * S.steer / (1 + Math.abs(speed) / 16) * DT * (speed >= 0 ? 1 : -1);
      st.lean += ((-steer * Math.min(1, Math.abs(speed) / 12) * 0.45) - st.lean) * Math.min(1, 8 * DT);

      st.vx = f.x * speed; st.vy = f.y * speed; st.vz = f.z * speed;

      /* hop */
      if (inp.hop && st.hopCd <= 0) {
        st.vy += HOP_V * S.hop;
        st.hopCd = 0.55;
        st.onGround = false;
        st.airT = 0;
        ev.push({ t: "hop" });
      }

      st.x += st.vx * DT; st.z += st.vz * DT;
      var hNew = heightAt(world, st.x, st.z);
      var yBallistic = st.y + st.vy * DT;
      if (!st.onGround) {
        st.y = yBallistic;                                /* just hopped */
      } else if (hNew < yBallistic - 0.32) {
        st.onGround = false; st.airT = 0;                 /* crest launch */
        st.y = yBallistic;
        ev.push({ t: "takeoff" });
      } else {
        st.y = hNew;
      }
      st.wheelSpin += speed * DT / 0.34;
    } else {
      /* --- airborne --- */
      st.airT += DT;
      st.vy -= GRAV * DT;
      st.yaw += steer * 1.0 * DT;
      st.lean += ((-steer * 0.35) - st.lean) * Math.min(1, 5 * DT);
      st.x += st.vx * DT; st.y += st.vy * DT; st.z += st.vz * DT;
      var hg = heightAt(world, st.x, st.z);
      if (st.y <= hg) {
        st.y = hg;
        var nl = normalAt(world, st.x, st.z);
        var impact = -(st.vx * nl.x + st.vy * nl.y + st.vz * nl.z);
        var wasBig = st.airT > 0.9;
        if (impact > CRASH_IMPACT * (1 + S.landSoft) && !st.noCrash) {
          st.crashT = 1.0;
          st.crashes++;
          ev.push({ t: "crash", why: "landing" });
        } else {
          /* keep the tangent component of velocity */
          var vn = st.vx * nl.x + st.vy * nl.y + st.vz * nl.z;
          st.vx -= nl.x * vn; st.vy -= nl.y * vn; st.vz -= nl.z * vn;
          if (impact > 8.5 * (1 + 0.5 * S.landSoft)) {
            var keep = 0.75 + 0.2 * S.landSoft;
            st.vx *= keep; st.vy *= keep; st.vz *= keep;
            ev.push({ t: "land", q: "hard" });
          } else {
            ev.push({ t: "land", q: "clean" });
          }
          if (wasBig) { st.bigAirs++; st.score += 75; ev.push({ t: "bigair" }); }
        }
        st.onGround = true;
      }
    }

    /* --- solid props: trees hurt at speed --- */
    speed = Math.sqrt(st.vx * st.vx + st.vz * st.vz);
    if (st.crashT <= 0 && speed > 0.5) {
      var cellX = Math.floor(st.x / world.hashCell), cellZ = Math.floor(st.z / world.hashCell);
      for (var cx = cellX - 1; cx <= cellX + 1 && st.crashT <= 0; cx++) {
        for (var cz = cellZ - 1; cz <= cellZ + 1 && st.crashT <= 0; cz++) {
          var bucket = world.hash[cx + "," + cz];
          if (!bucket) continue;
          for (i = 0; i < bucket.length; i++) {
            var pr = world.props[bucket[i]];
            var dx = pr.x - st.x, dz = pr.z - st.z;
            if (dx * dx + dz * dz < (pr.r * 0.55 + 0.4) * (pr.r * 0.55 + 0.4) && st.y < pr.y + 3) {
              if (speed > 6 && !st.noCrash) {
                st.crashT = 1.0; st.crashes++;
                ev.push({ t: "crash", why: pr.type });
              } else {
                /* low-speed bump: push out and stop */
                var dl = Math.sqrt(dx * dx + dz * dz) || 1;
                st.x -= (dx / dl) * 0.3; st.z -= (dz / dl) * 0.3;
                st.vx *= 0.2; st.vz *= 0.2;
              }
              break;
            }
          }
        }
      }
    }

    /* --- trail progress (greedy forward search) --- */
    var tr = world.trail;
    var best = st.trailIdx, bestD = dist2Trail(tr[best], st);
    for (i = st.trailIdx + 1; i < Math.min(world.trailN, st.trailIdx + 10); i++) {
      var d2 = dist2Trail(tr[i], st);
      if (d2 < bestD) { bestD = d2; best = i; }
    }
    st.trailIdx = best;
    st.trailD = Math.sqrt(bestD);
    for (i = world.gates.length - 1; i >= 0; i--) {
      if (world.gates[i] <= st.trailIdx) {
        if (world.gates[i] > st.respawnIdx) { st.respawnIdx = world.gates[i]; ev.push({ t: "gate" }); }
        break;
      }
    }

    /* --- coins --- */
    var coins = world.coins;
    while (st.coinPtr < coins.length && coins[st.coinPtr].z < st.z - 12) st.coinPtr++;
    for (i = st.coinPtr; i < coins.length && i < st.coinPtr + 14; i++) {
      if (taken[i]) continue;
      var co = coins[i];
      var ddx = co.x - st.x, ddy = co.y - (st.y + 0.9), ddz = co.z - st.z;
      if (ddx * ddx + ddy * ddy + ddz * ddz < 2.2 * 2.2) {
        taken[i] = 1;
        st.coinCount++; st.score += 25;
        ev.push({ t: "coin" });
      }
    }

    /* --- ride into the river: below the water line means swimming --- */
    if (world.rowWaterY && st.crashT <= 0) {
      var gzI = Math.max(0, Math.min(world.nz - 1, Math.round((st.z - world.z0) / world.step)));
      if (st.y < world.rowWaterY[gzI] - 0.12) {
        st.crashT = 0.7;
        ev.push({ t: "splash" });
      }
    }

    /* --- ride off the Knife-Edge rim: the gorge is not a shortcut --- */
    if (world.rowGorgeX && st.crashT <= 0) {
      var ggI = Math.max(0, Math.min(world.nz - 1, Math.round((st.z - world.z0) / world.step)));
      if (st.x > world.rowGorgeX[ggI] - 1.5) {
        st.crashT = 0.7;
        ev.push({ t: "gorge" });
      }
    }

    /* --- lost down a ravine / out of bounds → gentle reset --- */
    if (Math.abs(st.x) > X_HALF - 4 || st.z < world.z0 + 6) {
      st.crashT = 0.4;
      ev.push({ t: "reset" });
    }

    /* --- finish --- */
    if (!st.finished && st.trailIdx >= world.finishIdx) {
      st.finished = true;
      st.finishT = st.t + DT;
      ev.push({ t: "finish" });
    }
    st.t += DT;
  }

  function dist2Trail(p, st) {
    var dx = p.x - st.x, dz = p.z - st.z;
    return dx * dx + dz * dz;
  }

  /* ================= AI riders ================= */

  var AI3_STYLES = {
    armand: { name: "Armand", color: 0x1F7A48, power: 1.0, brakeCurve: 0.30, vBrake: 26, aiSeed: 11 },
    arthur: { name: "Arthur", color: 0xE8791D, power: 0.93, brakeCurve: 0.24, vBrake: 23, aiSeed: 23 }
  };

  function angleWrap(a) {
    while (a > Math.PI) a -= 2 * Math.PI;
    while (a < -Math.PI) a += 2 * Math.PI;
    return a;
  }

  function simulateAI3(world, style) {
    var st = newRider3(world);
    st.power = style.power;
    if (style.stats) st.stats = style.stats;
    st.noCrash = !style.allowCrash;
    var taken = new Array(world.coins.length);
    var samples = [];
    var ev = [];
    var step = 0;
    var tr = world.trail;

    while (!st.finished && st.t < 300) {
      var speed = Math.sqrt(st.vx * st.vx + st.vz * st.vz);
      var ahead = Math.max(3, Math.round(speed * 0.6 / TRAIL_DS));
      var L = tr[Math.min(world.trailN - 1, st.trailIdx + ahead)];
      var want = Math.atan2(L.x - st.x, L.z - st.z);
      var dyaw = angleWrap(want - st.yaw);
      /* upcoming curvature: how much the trail bends over the next 40 m */
      var a1 = tr[Math.min(world.trailN - 1, st.trailIdx + 2)];
      var a2 = tr[Math.min(world.trailN - 1, st.trailIdx + 8)];
      var h1 = Math.atan2(a1.x - st.x, a1.z - st.z);
      var h2 = Math.atan2(a2.x - a1.x, a2.z - a1.z);
      var curve = Math.abs(angleWrap(h2 - h1));

      var inp = {
        pedal: true,
        brake: (curve > style.brakeCurve && speed > 13) || speed > style.vBrake,
        left: dyaw > 0.06,    /* +yaw turns toward +x, the rider's left */
        right: dyaw < -0.06,
        hop: false
      };
      ev.length = 0;
      stepRider3(st, inp, world, ev, taken);
      if (step % 6 === 0) {
        samples.push([Math.round(st.x * 10), Math.round(st.y * 10), Math.round(st.z * 10), Math.round(st.yaw * 100)]);
      }
      step++;
    }
    samples.push([Math.round(st.x * 10), Math.round(st.y * 10), Math.round(st.z * 10), Math.round(st.yaw * 100)]);
    return {
      name: style.name, color: style.color,
      samples: samples, timeMs: Math.round(st.finishT * 1000),
      score: st.score, crashes: st.crashes
    };
  }

  /* ================= ghosts ================= */

  var GHOST_HZ = 10;

  function ghostPosAt3(ghost, tSec) {
    var s = ghost.samples;
    if (!s || !s.length) return { x: 0, y: 0, z: 0, yaw: 0, done: true, empty: true };
    var idx = tSec * GHOST_HZ;
    var i0 = Math.floor(idx);
    var last = s.length - 1;
    if (i0 >= last) {
      var e = s[last];
      return { x: e[0] / 10, y: e[1] / 10, z: e[2] / 10, yaw: e[3] / 100, done: true };
    }
    var t = idx - i0;
    var A = s[i0], B = s[i0 + 1];
    return {
      x: (A[0] * (1 - t) + B[0] * t) / 10,
      y: (A[1] * (1 - t) + B[1] * t) / 10,
      z: (A[2] * (1 - t) + B[2] * t) / 10,
      yaw: (A[3] * (1 - t) + B[3] * t) / 100,
      done: false
    };
  }

  function sanitizeName(nm) {
    var s = String(nm || "").replace(/[^A-Za-z0-9 _-]/g, "").trim().slice(0, 12);
    return s || "Rider";
  }

  function packGhost3(g) {
    var out = [];
    var px = 0, py = 0, pz = 0, pr = 0;
    for (var i = 0; i < g.samples.length; i++) {
      var s = g.samples[i];
      out.push((s[0] - px) + "," + (s[1] - py) + "," + (s[2] - pz) + "," + (s[3] - pr));
      px = s[0]; py = s[1]; pz = s[2]; pr = s[3];
    }
    var payload = JSON.stringify({ v: 1, n: g.name, t: g.track, ms: g.timeMs, s: out.join(";") });
    return "ZR3G1." + btoa64(payload);
  }

  function unpackGhost3(code) {
    try {
      code = String(code || "").trim();
      if (code.indexOf("ZR3G1.") !== 0) return null;
      var payload = JSON.parse(atob64(code.slice(6)));
      if (!payload || payload.v !== 1) return null;
      if (!TRACKS3[payload.t]) return null;
      var ms = Number(payload.ms);
      if (!isFinite(ms) || ms < 5000 || ms > 900000) return null;
      var parts = String(payload.s).split(";");
      if (parts.length < 10 || parts.length > 30000) return null;
      var samples = [];
      var px = 0, py = 0, pz = 0, pr = 0;
      for (var i = 0; i < parts.length; i++) {
        var q = parts[i].split(",");
        if (q.length !== 4) return null;
        px += Number(q[0]); py += Number(q[1]); pz += Number(q[2]); pr += Number(q[3]);
        if (!isFinite(px) || !isFinite(py) || !isFinite(pz) || !isFinite(pr)) return null;
        samples.push([px, py, pz, pr]);
      }
      return { name: sanitizeName(payload.n), track: payload.t, timeMs: Math.round(ms), samples: samples };
    } catch (e) { return null; }
  }

  /* base64 that works in browser and node */
  function btoa64(s) {
    if (typeof btoa === "function") return btoa(s);
    return Buffer.from(s, "binary").toString("base64");
  }
  function atob64(s) {
    if (typeof atob === "function") return atob(s);
    return Buffer.from(s, "base64").toString("binary");
  }

  /* ================= exports ================= */

  var CORE = {
    TRACKS3: TRACKS3, TRACK3_ORDER: TRACK3_ORDER,
    buildWorld: buildWorld, heightAt: heightAt, normalAt: normalAt, trailDistAt: trailDistAt,
    newRider3: newRider3, stepRider3: stepRider3, simulateAI3: simulateAI3, AI3_STYLES: AI3_STYLES,
    ghostPosAt3: ghostPosAt3, packGhost3: packGhost3, unpackGhost3: unpackGhost3,
    sanitizeName: sanitizeName, DT: DT, CARVE_R: CARVE_R, GHOST_HZ: GHOST_HZ, X_HALF: X_HALF,
    trailPreview: trailPreview
  };

  if (typeof module !== "undefined" && module.exports) module.exports = CORE;
  if (typeof window !== "undefined") window.ZR3 = CORE;
})();
