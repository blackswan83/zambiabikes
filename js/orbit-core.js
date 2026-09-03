/* ==========================================================================
   ORBIT — simulation core (no rendering, no DOM)

   Orbit is the club's space game: you fly a mining skiff through a seeded
   asteroid belt, thread the survey frames the club bolted to the rocks, and
   bring copper home before the shield gives out. Everything deterministic
   lives here — the course, the field grown around it, the frames cut into
   it, flight physics, scoring and the career. The Three.js renderer
   (js/orbit.js) only *reads* this world.

   Loaded in the browser it exposes window.ORBIT; under node it exports the
   same API for tests.

   Units are metres and seconds. +z is downrange, +y is "up" relative to the
   belt plane, and the course is sampled at a fixed step in z — so the
   whole world can be looked up from a ship's z with no searching at all.
   One seed = one sector.
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

  function hash1(i, seed) {
    var h = (i * 374761393 + seed * 2246822519) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  function smooth(t) { return t * t * (3 - 2 * t); }

  /* 1D value noise — the course only ever wanders as a function of z. */
  function vnoise(x, seed) {
    var ix = Math.floor(x), fx = x - ix;
    var a = hash1(ix, seed) * 2 - 1;
    var b = hash1(ix + 1, seed) * 2 - 1;
    return a + (b - a) * smooth(fx);
  }

  function fbm1(x, seed, octaves) {
    var sum = 0, amp = 1, norm = 0, f = 1;
    for (var o = 0; o < octaves; o++) {
      sum += amp * vnoise(x * f, seed + o * 131);
      norm += amp;
      amp *= 0.5; f *= 2.03;
    }
    return sum / norm;
  }

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  function wrapPi(a) {
    while (a > Math.PI) a -= 2 * Math.PI;
    while (a < -Math.PI) a += 2 * Math.PI;
    return a;
  }

  function smoothstepN(v, a, b) {
    var t = clamp((v - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  }

  /* ================= quaternions =================
     A ship in a belt has no up and no horizon, so attitude is a quaternion:
     Euler angles would lock the moment somebody loops. Everything here
     writes into an `out` object, because this runs 60 times a second and
     the garbage collector is not invited. */

  function qIdent() { return { x: 0, y: 0, z: 0, w: 1 }; }

  function qNormalize(q) {
    var n = Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w);
    if (n < 1e-9) { q.x = q.y = q.z = 0; q.w = 1; return q; }
    q.x /= n; q.y /= n; q.z /= n; q.w /= n;
    return q;
  }

  function qMul(a, b, out) {
    var ax = a.x, ay = a.y, az = a.z, aw = a.w;
    var bx = b.x, by = b.y, bz = b.z, bw = b.w;
    out.x = aw * bx + ax * bw + ay * bz - az * by;
    out.y = aw * by - ax * bz + ay * bw + az * bx;
    out.z = aw * bz + ax * by - ay * bx + az * bw;
    out.w = aw * bw - ax * bx - ay * by - az * bz;
    return out;
  }

  /* Rotate a vector by a quaternion: v + 2w(q×v) + 2q×(q×v). */
  function qRotate(q, vx, vy, vz, out) {
    var tx = 2 * (q.y * vz - q.z * vy);
    var ty = 2 * (q.z * vx - q.x * vz);
    var tz = 2 * (q.x * vy - q.y * vx);
    out.x = vx + q.w * tx + (q.y * tz - q.z * ty);
    out.y = vy + q.w * ty + (q.z * tx - q.x * tz);
    out.z = vz + q.w * tz + (q.x * ty - q.y * tx);
    return out;
  }

  /* Advance an attitude by a body-frame angular velocity, exactly: the
     rotation for this tick is built as a real axis-angle turn rather than
     the usual first-order approximation, so a hard roll does not shrink
     the quaternion and slew the ship's scale in the renderer. */
  var _dq = qIdent(), _qtmp = qIdent();
  function qIntegrate(q, wx, wy, wz, dt) {
    var mag = Math.sqrt(wx * wx + wy * wy + wz * wz);
    if (mag < 1e-8) return q;
    var half = mag * dt * 0.5;
    var s = Math.sin(half) / mag;
    _dq.x = wx * s; _dq.y = wy * s; _dq.z = wz * s; _dq.w = Math.cos(half);
    qMul(q, _dq, _qtmp);          /* body-frame rate: q * dq, not dq * q */
    q.x = _qtmp.x; q.y = _qtmp.y; q.z = _qtmp.z; q.w = _qtmp.w;
    return qNormalize(q);
  }

  /* ================= sectors =================
     A sector is a belt recipe: how wide the flight corridor is, how thick
     the rock around it, what the frames look like and how the sky over it
     is lit. Everything a run needs beyond its seed. */

  var SECTORS = {
    kariba: {
      id: "kariba", name: "Kariba Shallows", short: "Kariba",
      desc: "The club's training water. Thin rock, wide frames, and the lake shining a long way below.",
      corridor: 34, shell: 90, density: 2.6, rockMin: 3.5, rockMax: 13,
      gateGap: 150, gateW: 17, gateSlot: 0.62, gateRoll: 0.5,
      cruise: 88, drifters: 5, driftSize: 12, currents: 0, veins: 0.10, ore: 1.0,
      theme: {
        space: 0x060B14, nebulaA: 0x1E5A6E, nebulaB: 0x0B2436, fogNear: 260, fogFar: 1500,
        sun: 0xFFF3D8, sunPos: [400, 260, 900], ambient: 0x2A4258,
        rock: 0x6E6A63, rockDark: 0x3A3833, ore: 0xE8791D, gate: 0x2A9D8F,
        planet: 0x2C6E5A, planetSea: 0x123E52, dust: 0x9FC7DA, exposure: 0.66, bloom: 0.8
      }
    },
    copperbelt: {
      id: "copperbelt", name: "The Copperbelt", short: "Copperbelt",
      desc: "The seam everybody comes for. Metal-heavy rock packed tight, and more copper in it than you can carry.",
      corridor: 27, shell: 120, density: 5.2, rockMin: 3, rockMax: 17,
      gateGap: 132, gateW: 14, gateSlot: 0.46, gateRoll: 1.0,
      cruise: 98, drifters: 9, driftSize: 16, currents: 0, veins: 0.22, ore: 1.35,
      theme: {
        space: 0x0B0703, nebulaA: 0x7A3A0E, nebulaB: 0x2A1405, fogNear: 200, fogFar: 1200,
        sun: 0xFFD9A0, sunPos: [-500, 180, 700], ambient: 0x4A2C16,
        rock: 0x8A6A46, rockDark: 0x4A3420, ore: 0xFFA33C, gate: 0xF7B733,
        planet: 0x6B4A2A, planetSea: 0x2A1A10, dust: 0xE0A870, exposure: 0.62, bloom: 1.0
      }
    },
    kafue: {
      id: "kafue", name: "Kafue Drift", short: "Kafue",
      desc: "A dust river running through the belt. You will not see far, and the dust pushes back.",
      corridor: 31, shell: 100, density: 3.8, rockMin: 4, rockMax: 15,
      gateGap: 140, gateW: 15, gateSlot: 0.52, gateRoll: 0.8,
      cruise: 94, drifters: 7, driftSize: 14, currents: 6, veins: 0.15, ore: 1.1,
      theme: {
        space: 0x08110C, nebulaA: 0x2E6B44, nebulaB: 0x0F2A1B, fogNear: 90, fogFar: 620,
        sun: 0xDFF0D2, sunPos: [300, 420, 500], ambient: 0x2E4A38,
        rock: 0x6A7062, rockDark: 0x333A30, ore: 0xE8791D, gate: 0x8FE0A2,
        planet: 0x35704A, planetSea: 0x14364A, dust: 0xBFE0C4, exposure: 0.70, bloom: 0.85
      }
    },
    mosi: {
      id: "mosi", name: "Mosi Rings", short: "Mosi",
      desc: "Ice, in a sheet a thousand kilometres wide. The frames sit above it and below it, and never in it.",
      corridor: 25, shell: 130, density: 4.6, rockMin: 2.5, rockMax: 11,
      gateGap: 124, gateW: 13, gateSlot: 0.42, gateRoll: 1.25,
      cruise: 106, drifters: 8, driftSize: 13, currents: 0, veins: 0.12, ore: 1.15,
      theme: {
        space: 0x040810, nebulaA: 0x2B5F9E, nebulaB: 0x0A1830, fogNear: 240, fogFar: 1400,
        sun: 0xEAF4FF, sunPos: [600, 120, -400], ambient: 0x2C4870,
        rock: 0x93A9BC, rockDark: 0x46586A, ore: 0xFFB855, gate: 0x7FD8F5,
        planet: 0x35506E, planetSea: 0x11294A, dust: 0xDCEBFA, exposure: 0.46, bloom: 0.9
      }
    },
    batoka: {
      id: "batoka", name: "Batoka Deep", short: "Batoka",
      desc: "A rift in the belt with walls you cannot see the top of. The tightest line the club has ever surveyed.",
      corridor: 21, shell: 150, density: 6.4, rockMin: 4, rockMax: 22,
      gateGap: 118, gateW: 12, gateSlot: 0.38, gateRoll: 1.5,
      cruise: 110, drifters: 12, driftSize: 20, currents: 3, veins: 0.18, ore: 1.5,
      theme: {
        space: 0x070512, nebulaA: 0x53308A, nebulaB: 0x180C33, fogNear: 150, fogFar: 900,
        sun: 0xF0D8FF, sunPos: [-300, -260, 800], ambient: 0x342A55,
        rock: 0x5A5468, rockDark: 0x2A2636, ore: 0xFF8A2B, gate: 0xC08CF5,
        planet: 0x3A2C58, planetSea: 0x1A1436, dust: 0xC0A8E0, exposure: 0.60, bloom: 1.25
      }
    }
  };

  var SECTOR_ORDER = ["kariba", "copperbelt", "kafue", "mosi", "batoka"];

  /* ================= modifiers =================
     A twist is applied to the spec before anything is built, so it changes
     the sector itself and not just the scoring. */

  var MODIFIERS = {
    none:   { id: "none", name: "Standard", icon: "🛰️", desc: "The belt as the survey left it." },
    dense:  { id: "dense", name: "Dense Field", icon: "🪨", desc: "Half again as much rock, and less room between it.",
              apply: function (s) { s.density *= 1.5; s.corridor *= 0.86; s.shell *= 1.15; } },
    swarm:  { id: "swarm", name: "Swarm", icon: "☄️", desc: "Loose rock tumbling around the line, right where the copper is.",
              apply: function (s) { s.drifters = Math.round(s.drifters * 2.2) + 3; s.driftSpeed *= 1.5; } },
    squall: { id: "squall", name: "Dust Squall", icon: "🌪️", desc: "Cross-currents down the whole run. Fly it crabbed.",
              apply: function (s) { s.currents += 8; s.currentGain *= 1.5; s.cruise *= 0.94; } },
    eclipse:{ id: "eclipse", name: "Eclipse", icon: "🌑", desc: "The planet between you and the sun. Frame lights only.",
              apply: function (s) { s.dark = true; s.gateW *= 0.9; s.scoreBonus += 0.3; } },
    sprint: { id: "sprint", name: "Sprint", icon: "⚡", desc: "Short, fast, and the frames come at you twice as quick.",
              apply: function (s) { s.length = Math.round(s.length * 0.62); s.gateGap *= 0.82; s.cruise *= 1.18; } },
    haul:   { id: "haul", name: "Long Haul", icon: "⛏️", desc: "A run half again as long, with copper strung the whole way down.",
              apply: function (s) { s.length = Math.round(s.length * 1.5); s.ore *= 1.3; s.veins *= 1.4; } }
  };

  /* ================= ships =================
     Three hulls on the club's pad. The trainer flies itself; the other two
     are earned with rep and ask for more of you. */

  var SHIPS = {
    kite: {
      id: "kite", name: "Chipata Kite", tag: "Trainer",
      desc: "Light, forgiving and quick to turn. The hull every club member learns on.",
      rep: 0, shield: 100, thrust: 1.0, agility: 1.0, cargo: 1.0, cool: 1.0, span: 3.6, height: 1.2
    },
    hauler: {
      id: "hauler", name: "Copper Hauler", tag: "Heavy",
      desc: "Twice the plating and a hold to match. Slow to turn — plan the frame two before you reach it.",
      rep: 900, shield: 160, thrust: 0.92, agility: 0.74, cargo: 1.5, cool: 1.25, span: 4.6, height: 1.5
    },
    needle: {
      id: "needle", name: "Zambezi Needle", tag: "Racer",
      desc: "Thin, fast and unforgiving. Nothing to hide behind and nothing in the way.",
      rep: 2400, shield: 72, thrust: 1.22, agility: 1.26, cargo: 0.85, cool: 0.8, span: 2.9, height: 0.95
    }
  };

  var SHIP_ORDER = ["kite", "hauler", "needle"];

  /* ================= objectives ================= */

  function fmtClock(sec) {
    var m = Math.floor(sec / 60);
    var s = Math.round(sec % 60);
    if (s === 60) { s = 0; m++; }
    return m + ":" + (s < 10 ? "0" : "") + s;
  }

  var OBJECTIVES = {
    finish: {
      id: "finish", icon: "🏁",
      label: function () { return "Reach the refinery"; },
      check: function (r) { return r.finished; }
    },
    score: {
      id: "score", icon: "✨",
      label: function (t) { return "Score " + t.toLocaleString(); },
      check: function (r, t) { return r.finished && r.score >= t; }
    },
    gates: {
      id: "gates", icon: "⭕",
      label: function (t) { return "Thread " + t + " frames"; },
      check: function (r, t) { return r.finished && r.gates >= t; }
    },
    clean: {
      id: "clean", icon: "🛡️",
      label: function (t) { return t === 0 ? "Finish without touching a thing" : "Finish with " + t + " knock" + (t === 1 ? "" : "s") + " or fewer"; },
      check: function (r, t) { return r.finished && r.hits <= t; }
    },
    ore: {
      id: "ore", icon: "⛏️",
      label: function (t) { return "Bring back " + t + " copper"; },
      check: function (r, t) { return r.finished && r.ore >= t; }
    },
    time: {
      id: "time", icon: "⏱️",
      label: function (t) { return "Finish inside " + fmtClock(t); },
      check: function (r, t) { return r.finished && r.finishT <= t; }
    }
  };

  /* ================= run spec ================= */

  /* A spec is the full recipe for one sector: the belt params merged with
     the node's twist. buildWorld only ever reads a spec. */
  function makeSpec(opts) {
    opts = opts || {};
    var b = SECTORS[opts.sector] || SECTORS.kariba;
    var spec = {
      seed: normSeed(opts.seed),
      sector: b.id, sectorDef: b,
      modifier: opts.modifier || "none",
      length: opts.length || 3200,
      corridor: b.corridor, shell: b.shell, density: b.density,
      rockMin: b.rockMin, rockMax: b.rockMax,
      gateGap: b.gateGap, gateW: b.gateW, gateSlot: b.gateSlot, gateRoll: b.gateRoll,
      cruise: b.cruise, drifters: b.drifters, driftSize: b.driftSize, driftSpeed: 1,
      currents: b.currents, currentGain: 1, veins: b.veins, ore: b.ore,
      dark: false, scoreBonus: 0
    };
    var mod = MODIFIERS[spec.modifier];
    if (mod && mod.apply) mod.apply(spec);
    /* however the twists stack up, the corridor stays wide enough for a hull
       to fly down the middle of it with room on both sides */
    spec.corridor = Math.max(MIN_CORRIDOR, spec.corridor);
    return spec;
  }

  /* ================= constants ================= */

  var DT = 1 / 60;              /* simulation tick */
  var COURSE_DS = 8;            /* metres in z between course samples */
  var MIN_CORRIDOR = 16;        /* the free radius around the line, always */
  var MAX_GRAD = 0.42;          /* how far the line may lean off +z */
  var BUCKET = 40;              /* z-bucket size for the rock and ore index */
  var SHIP_R = 2.4;             /* hull collision radius */
  var PICKUP_R = 7.5;           /* how close copper has to pass to be scooped */
  var BEAM_RANGE = 70;          /* cutting beam reach */
  var BEAM_COS = 0.955;         /* and how tightly it has to be aimed (~17°) */
  var BEAM_TIME = 0.55;         /* seconds of contact to open a vein */
  var STRAY_GRACE = 6.5;        /* seconds outside the survey before it counts */
  var GATE_RIM = 2.2;           /* frame rim thickness — solid, and it hurts */
  var GATE_MIN_H = 4.2;         /* no slot is ever narrower than this */

  /* ================= world building ================= */

  function makeCourse(spec) {
    var n = Math.floor(spec.length / COURSE_DS) + 1;
    var xs = new Float64Array(n), ys = new Float64Array(n);
    var s = spec.seed, i;

    for (i = 0; i < n; i++) {
      var z = i * COURSE_DS;
      var lead = smoothstepN(z, 0, 240);        /* leave the pad straight */
      var tail = 1 - smoothstepN(z, spec.length - 200, spec.length);
      xs[i] = 110 * fbm1(z / 620, s, 3) * lead * tail;
      ys[i] = 70 * fbm1(z / 500, s + 91, 3) * lead * tail;
    }

    /* A line that leans more than MAX_GRAD off +z breaks the one thing the
       whole world depends on: that a ship's z alone says where it is on the
       course. Rather than hope the noise behaves, measure it and scale the
       whole wander down until it does. */
    var grad = 0;
    for (i = 1; i < n; i++) {
      var dx = (xs[i] - xs[i - 1]) / COURSE_DS;
      var dy = (ys[i] - ys[i - 1]) / COURSE_DS;
      var g = Math.sqrt(dx * dx + dy * dy);
      if (g > grad) grad = g;
    }
    if (grad > MAX_GRAD) {
      var k = MAX_GRAD / grad;
      for (i = 0; i < n; i++) { xs[i] *= k; ys[i] *= k; }
    }

    var course = new Array(n);
    for (i = 0; i < n; i++) {
      var a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
      var tx = (xs[b] - xs[a]), ty = (ys[b] - ys[a]), tz = (b - a) * COURSE_DS;
      var tl = Math.sqrt(tx * tx + ty * ty + tz * tz);
      course[i] = {
        x: xs[i], y: ys[i], z: i * COURSE_DS,
        tx: tx / tl, ty: ty / tl, tz: tz / tl,
        ux: 0, uy: 1, uz: 0, rx: 1, ry: 0, rz: 0
      };
    }

    /* Parallel-transported frame: each sample's up is the previous one with
       the new tangent taken out of it. No twist creeps in, and nothing flips
       over when the line points straight up the way a fixed reference up
       would. */
    var upx = 0, upy = 1, upz = 0;
    for (i = 0; i < n; i++) {
      var c = course[i];
      var d = upx * c.tx + upy * c.ty + upz * c.tz;
      var ax = upx - c.tx * d, ay = upy - c.ty * d, az = upz - c.tz * d;
      var al = Math.sqrt(ax * ax + ay * ay + az * az);
      if (al < 1e-6) { ax = 0; ay = 1; az = 0; al = 1; }
      upx = ax / al; upy = ay / al; upz = az / al;
      c.ux = upx; c.uy = upy; c.uz = upz;
      /* right = up × tangent */
      c.rx = upy * c.tz - upz * c.ty;
      c.ry = upz * c.tx - upx * c.tz;
      c.rz = upx * c.ty - upy * c.tx;
    }
    return course;
  }

  /* The whole point of sampling the course in z: no searching, ever. */
  function courseIdxAt(world, z) {
    var i = Math.round(z / COURSE_DS);
    return i < 0 ? 0 : (i > world.courseN - 1 ? world.courseN - 1 : i);
  }

  /* Where a point sits relative to the line: (u, v) across the corridor in
     the course's own frame, and d, the distance from the line itself. */
  function lateralOf(world, x, y, z, out) {
    var c = world.course[courseIdxAt(world, z)];
    var dx = x - c.x, dy = y - c.y, dz = z - c.z;
    var u = dx * c.rx + dy * c.ry + dz * c.rz;
    var v = dx * c.ux + dy * c.uy + dz * c.uz;
    out = out || {};
    out.u = u; out.v = v; out.d = Math.sqrt(u * u + v * v); out.c = c;
    return out;
  }

  /* A point at (u, v) in the frame of course sample i, back in world space. */
  function fromFrame(c, u, v, out) {
    out = out || {};
    out.x = c.x + c.rx * u + c.ux * v;
    out.y = c.y + c.ry * u + c.uy * v;
    out.z = c.z + c.rz * u + c.uz * v;
    return out;
  }

  function buildGates(spec, course, rng) {
    var n = course.length;
    var step = Math.max(5, Math.round(spec.gateGap / COURSE_DS));
    var gates = [];
    var maxW = Math.max(9, spec.corridor - 3);
    for (var i = Math.max(step, 16); i < n - 8; i += step) {
      var c = course[i];
      var halfW = clamp(spec.gateW * (0.86 + 0.30 * rng()), 9, maxW);
      /* GATE_MIN_H is the floor every frame is held to: an assisted hull
         lying along the slot always has room to spare inside it */
      var halfH = Math.max(GATE_MIN_H, halfW * spec.gateSlot * (0.85 + 0.3 * rng()));
      if (halfH > halfW) halfH = halfW;
      var roll = wrapPi((rng() * 2 - 1) * Math.PI * 0.5 * spec.gateRoll);
      var cr = Math.cos(roll), sr = Math.sin(roll);
      gates.push({
        i: i, n: gates.length,
        x: c.x, y: c.y, z: c.z,
        tx: c.tx, ty: c.ty, tz: c.tz,
        halfW: halfW, halfH: halfH, roll: roll,
        /* the frame's own across/up axes, already rolled */
        ax: c.rx * cr + c.ux * sr, ay: c.ry * cr + c.uy * sr, az: c.rz * cr + c.uz * sr,
        bx: -c.rx * sr + c.ux * cr, by: -c.ry * sr + c.uy * cr, bz: -c.rz * sr + c.uz * cr,
        passed: false, missed: false, clean: false
      });
    }
    return gates;
  }

  function buildRocks(spec, course, rng, world) {
    var n = course.length;
    var rocks = [];
    var lat = {};
    for (var i = 6; i < n - 2; i++) {
      var c = course[i];
      var want = spec.density;
      var k = Math.floor(want) + (rng() < (want - Math.floor(want)) ? 1 : 0);
      for (var j = 0; j < k; j++) {
        var rr = spec.rockMin + (spec.rockMax - spec.rockMin) * Math.pow(rng(), 1.7);
        var ang = rng() * Math.PI * 2;
        var rad = spec.corridor + rr + 2 + spec.shell * Math.pow(rng(), 1.35);
        var zj = c.z + (rng() * 2 - 1) * COURSE_DS * 0.5;
        var p = fromFrame(course[courseIdxAt(world, zj)], Math.cos(ang) * rad, Math.sin(ang) * rad);
        p.z = zj;
        /* the jitter in z moved it against a slightly different frame, so
           measure the clearance where the rock actually ended up */
        lateralOf(world, p.x, p.y, p.z, lat);
        if (lat.d < spec.corridor + rr + 1) continue;
        rocks.push({
          x: p.x, y: p.y, z: p.z, r: rr,
          shape: (rng() * 4) | 0,
          spin: (rng() * 2 - 1) * 0.5,
          phase: rng() * Math.PI * 2,
          vein: rr > spec.rockMin + 1.2 && rng() < spec.veins,
          cracked: false
        });
      }
    }
    return rocks;
  }

  function buildOre(spec, course, rng, world) {
    var n = course.length;
    var ore = [];
    function drop(i, u, v) {
      var p = fromFrame(course[i], u, v);
      ore.push({ x: p.x, y: p.y, z: p.z, taken: false, phase: rng() * Math.PI * 2 });
    }
    var i = 10;
    while (i < n - 6) {
      if (rng() < 0.17 * spec.ore) {
        var ang = rng() * Math.PI * 2;
        var rad = spec.corridor * (0.12 + 0.62 * rng());
        drop(i, Math.cos(ang) * rad, Math.sin(ang) * rad);
      }
      /* a seam: a run of copper strung out at the edge of the corridor,
         where the tumbling rock is. Worth the detour, and meant to be. */
      if (rng() < 0.055 * spec.ore) {
        var a0 = rng() * Math.PI * 2;
        var sweep = (rng() < 0.5 ? -1 : 1) * (0.10 + rng() * 0.16);
        var count = 5 + ((rng() * 5) | 0);
        var edge = spec.corridor * (0.74 + 0.18 * rng());
        for (var s = 0; s < count && i + s * 2 < n - 6; s++) {
          drop(i + s * 2, Math.cos(a0 + sweep * s) * edge, Math.sin(a0 + sweep * s) * edge);
        }
        i += count * 2;
      }
      i++;
    }
    return ore;
  }

  function buildDrifters(spec, course, rng) {
    var n = course.length;
    var out = [];
    for (var d = 0; d < spec.drifters; d++) {
      var i0 = 20 + Math.floor(rng() * Math.max(1, n - 40));
      var rr = spec.driftSize * (0.7 + 0.6 * rng());
      out.push({
        z0: course[i0].z, r: rr,
        ang0: rng() * Math.PI * 2,
        w: (rng() < 0.5 ? -1 : 1) * (0.18 + rng() * 0.34) * spec.driftSpeed,
        radMin: spec.corridor + rr + 2.5,
        radAmp: (14 + rng() * 20) * spec.driftSpeed,
        radW: (0.22 + rng() * 0.3) * spec.driftSpeed,
        radPh: rng() * Math.PI * 2,
        vz: (rng() * 2 - 1) * 9 * spec.driftSpeed,
        zSpan: 130 + rng() * 90,
        spin: (rng() * 2 - 1) * 0.35,
        shape: (rng() * 4) | 0
      });
    }
    return out;
  }

  /* Where a drifter is at time t. Its radius is built to stay outside the
     corridor at every t, so the line down the middle is never blocked —
     but the copper at the edge of the corridor is another matter. */
  function drifterAt(world, d, t, out) {
    out = out || {};
    var z = d.z0 + d.vz * t;
    var span = d.zSpan * 2;
    var off = ((z - d.z0 + d.zSpan) % span + span) % span - d.zSpan;
    z = d.z0 + off;
    z = clamp(z, 0, world.length);
    var c = world.course[courseIdxAt(world, z)];
    var rad = d.radMin + d.radAmp * (0.5 + 0.5 * Math.sin(t * d.radW + d.radPh));
    var ang = d.ang0 + d.w * t;
    fromFrame(c, Math.cos(ang) * rad, Math.sin(ang) * rad, out);
    out.z = z + (out.z - c.z);
    out.r = d.r;
    return out;
  }

  function buildCurrents(spec, course, rng) {
    var n = course.length;
    var out = [];
    for (var k = 0; k < spec.currents; k++) {
      var i0 = 12 + Math.floor(rng() * Math.max(1, n - 60));
      var len = 22 + Math.floor(rng() * 40);
      var ang = rng() * Math.PI * 2;
      out.push({
        i0: i0, i1: Math.min(n - 2, i0 + len),
        u: Math.cos(ang), v: Math.sin(ang),
        gain: (7 + rng() * 10) * spec.currentGain,
        w: 0.5 + rng() * 0.8, ph: rng() * Math.PI * 2
      });
    }
    return out;
  }

  /* Everything solid gets filed under the z-buckets it overlaps, so a hull
     only ever tests the rock it is actually flying through. */
  function bucketize(items, length) {
    var count = Math.floor(length / BUCKET) + 3;
    var buckets = new Array(count);
    for (var b = 0; b < count; b++) buckets[b] = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var rr = it.r || PICKUP_R;
      var lo = Math.max(0, Math.floor((it.z - rr) / BUCKET));
      var hi = Math.min(count - 1, Math.floor((it.z + rr) / BUCKET));
      for (var b2 = lo; b2 <= hi; b2++) buckets[b2].push(i);
    }
    return buckets;
  }

  function buildWorld(spec) {
    if (!spec || !spec.sectorDef) spec = makeSpec(spec || {});
    var rng = mulberry32(spec.seed ^ 0x5EED1);
    var course = makeCourse(spec);
    var world = {
      spec: spec, sector: spec.sectorDef, seed: spec.seed,
      length: spec.length, corridor: spec.corridor,
      course: course, courseN: course.length, courseDS: COURSE_DS,
      finishIdx: course.length - 1, finishZ: (course.length - 1) * COURSE_DS,
      dark: !!spec.dark, scoreBonus: spec.scoreBonus
    };
    world.gates = buildGates(spec, course, rng);
    world.rocks = buildRocks(spec, course, rng, world);
    world.ore = buildOre(spec, course, rng, world);
    world.drifters = buildDrifters(spec, course, rng);
    world.currents = buildCurrents(spec, course, rng);
    world.rockBuckets = bucketize(world.rocks, world.length);
    world.oreBuckets = bucketize(world.ore, world.length);
    world.veins = 0;
    for (var i = 0; i < world.rocks.length; i++) if (world.rocks[i].vein) world.veins++;
    world.strayLimit = spec.corridor + spec.shell + 90;
    /* par is what a pilot who flies the line and never stops for copper
       takes: the finish bonus pays for every second under it */
    world.par = spec.length / (spec.cruise * 0.78);
    world.code = codeFromSeed(spec.seed);
    return world;
  }

  /* ==========================================================================
     FLIGHT

     Body axes: +z is where the nose points, +y is the canopy, +x the right
     wing. Attitude is a quaternion and control is rate-based — you command
     how fast the ship turns, not where it ends up.

     There is no level in a belt, so pitch, yaw and roll are kept strictly
     separate: W/S pitches, A/D yaws, Q/E rolls, and nothing is coupled to
     anything else. The lean you see in a turn is the renderer tilting the
     hull inside its rig; the simulation never fakes it.
     ========================================================================== */

  var PITCH_RATE = 2.05;        /* rad/s at full deflection */
  var YAW_RATE   = 1.80;
  var ROLL_RATE  = 3.40;
  var RATE_K     = 8.0;         /* how fast a rate reaches what you asked for */
  var DAMP_ASSIST = 4.2;        /* and how fast it bleeds off when you let go */
  var DAMP_FREE   = 1.15;
  var LAT_ASSIST  = 2.9;        /* sideways-drift damping — the whole assist */
  var LAT_FREE    = 0.70;
  var ACCEL = 52, DECEL = 74;
  var BOOST_MUL = 1.62, BRAKE_MUL = 0.52;
  var HEAT_UP = 1 / 2.8, HEAT_DOWN = 1 / 3.6, HEAT_CLEAR = 0.42;
  var MAX_SHIELD = 100;
  var COMBO_WINDOW = 5.0;

  function newShip(world, opts) {
    opts = opts || {};
    var hull = SHIPS[opts.ship] || SHIPS.kite;
    var c = world.course[2];
    var st = {
      x: c.x, y: c.y, z: c.z,
      vx: c.tx * world.spec.cruise * 0.55,
      vy: c.ty * world.spec.cruise * 0.55,
      vz: c.tz * world.spec.cruise * 0.55,
      q: qIdent(), wx: 0, wy: 0, wz: 0,
      fwd: { x: 0, y: 0, z: 1 }, up: { x: 0, y: 1, z: 0 }, right: { x: 1, y: 0, z: 0 },
      speed: world.spec.cruise * 0.55, topSpeed: 0,
      heat: 0, overheat: false, boosting: false,
      shield: MAX_SHIELD * (hull.shield / 100), maxShield: MAX_SHIELD * (hull.shield / 100),
      score: 0, combo: 0, comboBest: 0, comboT: 0,
      gates: 0, gatesClean: 0, gatesMissed: 0, gateNext: 0,
      ore: 0, cracks: 0, hits: 0,
      t: 0, finishT: 0, finished: false, dead: false, deadT: 0, deadWhy: "",
      courseIdx: 2, prevZ: c.z, progress: 0, lateral: 0,
      beamOn: false, beamT: 0, beamTarget: -1,
      strayT: 0, stray: false, stunT: 0, shakeT: 0,
      assist: opts.assist !== false,
      hull: hull, cargo: hull.cargo,
      gateState: new Uint8Array(world.gates.length),   /* 0 pending 1 threaded 2 missed */
      oreTaken: new Uint8Array(world.ore.length),
      cracked: new Uint8Array(world.rocks.length)
    };
    /* point the nose down the line rather than down +z: the first sample of
       a wandering course is already leaning */
    aimShipAt(st, c.tx, c.ty, c.tz, c.ux, c.uy, c.uz);
    refreshBasis(st);
    return st;
  }

  /* Build an attitude straight from a forward and an up vector. */
  function aimShipAt(st, fx, fy, fz, ux, uy, uz) {
    var fl = Math.sqrt(fx * fx + fy * fy + fz * fz) || 1;
    fx /= fl; fy /= fl; fz /= fl;
    var d = ux * fx + uy * fy + uz * fz;
    ux -= fx * d; uy -= fy * d; uz -= fz * d;
    var ul = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1;
    ux /= ul; uy /= ul; uz /= ul;
    var rx = uy * fz - uz * fy, ry = uz * fx - ux * fz, rz = ux * fy - uy * fx;
    /* columns of the rotation matrix are right, up, forward */
    var m00 = rx, m01 = ux, m02 = fx;
    var m10 = ry, m11 = uy, m12 = fy;
    var m20 = rz, m21 = uz, m22 = fz;
    var tr = m00 + m11 + m22, s;
    var q = st.q;
    if (tr > 0) {
      s = Math.sqrt(tr + 1) * 2;
      q.w = 0.25 * s; q.x = (m21 - m12) / s; q.y = (m02 - m20) / s; q.z = (m10 - m01) / s;
    } else if (m00 > m11 && m00 > m22) {
      s = Math.sqrt(1 + m00 - m11 - m22) * 2;
      q.w = (m21 - m12) / s; q.x = 0.25 * s; q.y = (m01 + m10) / s; q.z = (m02 + m20) / s;
    } else if (m11 > m22) {
      s = Math.sqrt(1 + m11 - m00 - m22) * 2;
      q.w = (m02 - m20) / s; q.x = (m01 + m10) / s; q.y = 0.25 * s; q.z = (m12 + m21) / s;
    } else {
      s = Math.sqrt(1 + m22 - m00 - m11) * 2;
      q.w = (m10 - m01) / s; q.x = (m02 + m20) / s; q.y = (m12 + m21) / s; q.z = 0.25 * s;
    }
    qNormalize(q);
    return st;
  }

  function refreshBasis(st) {
    qRotate(st.q, 0, 0, 1, st.fwd);
    qRotate(st.q, 0, 1, 0, st.up);
    qRotate(st.q, 1, 0, 0, st.right);
  }

  function axisOf(a, b) { return (a ? 1 : 0) - (b ? 1 : 0); }

  var _lat = {}, _dpos = {};

  function stepShip(st, input, world, events) {
    input = input || {};
    events = events || [];
    if (st.dead || st.finished) { st.deadT += DT; return st; }

    var spec = world.spec;
    var stun = st.stunT > 0 ? 0.35 : 1;

    /* ---------- attitude ---------- */

    var pitchIn = axisOf(input.up, input.down);
    var yawIn = axisOf(input.right, input.left);
    var rollIn = axisOf(input.rollR, input.rollL);
    var agility = st.hull.agility * stun;

    /* +x is the right wing, so a nose-up command is a negative rate about it */
    var tWx = -pitchIn * PITCH_RATE * agility;
    var tWy = yawIn * YAW_RATE * agility;
    var tWz = -rollIn * ROLL_RATE * agility;

    var k = 1 - Math.exp(-RATE_K * DT);
    var damp = Math.exp(-(st.assist ? DAMP_ASSIST : DAMP_FREE) * DT);
    st.wx = pitchIn ? st.wx + (tWx - st.wx) * k : st.wx * damp;
    st.wy = yawIn ? st.wy + (tWy - st.wy) * k : st.wy * damp;
    st.wz = rollIn ? st.wz + (tWz - st.wz) * k : st.wz * damp;

    qIntegrate(st.q, st.wx, st.wy, st.wz, DT);
    refreshBasis(st);

    /* ---------- throttle, boost and heat ---------- */

    var wantBoost = !!input.boost && !st.overheat && st.stunT <= 0;
    if (wantBoost) {
      st.heat += HEAT_UP * DT;
      if (st.heat >= 1) { st.heat = 1; st.overheat = true; events.push({ t: "overheat" }); }
    } else {
      st.heat -= HEAT_DOWN * st.hull.cool * DT;
      if (st.heat < 0) st.heat = 0;
      if (st.overheat && st.heat <= HEAT_CLEAR) { st.overheat = false; events.push({ t: "cool" }); }
    }
    if (wantBoost && !st.boosting) events.push({ t: "boost" });
    st.boosting = wantBoost;

    var target = spec.cruise * st.hull.thrust;
    if (wantBoost) target *= BOOST_MUL;
    else if (input.brake) target *= BRAKE_MUL;

    var f = st.fwd;
    var along = st.vx * f.x + st.vy * f.y + st.vz * f.z;
    var da = clamp((target - along) * 1.6, -DECEL, ACCEL) * DT;
    st.vx += f.x * da; st.vy += f.y * da; st.vz += f.z * da;

    /* Flight assist is one idea: bleed off the part of the velocity that is
       not pointing where the nose is. With it on the ship flies where it is
       aimed; with it off the belt is Newtonian and a hard turn is a drift. */
    var lat = st.assist ? LAT_ASSIST : LAT_FREE;
    along = st.vx * f.x + st.vy * f.y + st.vz * f.z;
    var sx = st.vx - f.x * along, sy = st.vy - f.y * along, sz = st.vz - f.z * along;
    var bleed = 1 - Math.exp(-lat * DT);
    st.vx -= sx * bleed; st.vy -= sy * bleed; st.vz -= sz * bleed;

    /* ---------- dust currents ---------- */

    if (world.currents.length) {
      var ci = st.courseIdx;
      for (var q2 = 0; q2 < world.currents.length; q2++) {
        var cur = world.currents[q2];
        if (ci < cur.i0 || ci > cur.i1) continue;
        var edge = smoothstepN(ci, cur.i0, cur.i0 + 8) * (1 - smoothstepN(ci, cur.i1 - 8, cur.i1));
        var c0 = world.course[ci];
        var g = cur.gain * edge * (0.65 + 0.35 * Math.sin(st.t * cur.w + cur.ph)) * DT;
        st.vx += (c0.rx * cur.u + c0.ux * cur.v) * g;
        st.vy += (c0.ry * cur.u + c0.uy * cur.v) * g;
        st.vz += (c0.rz * cur.u + c0.uz * cur.v) * g;
      }
    }

    /* ---------- move ---------- */

    st.prevZ = st.z;
    var px = st.x, py = st.y, pz = st.z;
    st.x += st.vx * DT; st.y += st.vy * DT; st.z += st.vz * DT;
    st.speed = Math.sqrt(st.vx * st.vx + st.vy * st.vy + st.vz * st.vz);
    if (st.speed > st.topSpeed) st.topSpeed = st.speed;
    st.t += DT;
    if (st.stunT > 0) st.stunT -= DT;
    if (st.shakeT > 0) st.shakeT -= DT;
    if (st.comboT > 0) {
      st.comboT -= DT;
      if (st.comboT <= 0) st.combo = 0;
    }

    st.courseIdx = courseIdxAt(world, st.z);
    lateralOf(world, st.x, st.y, st.z, _lat);
    st.lateral = _lat.d;
    st.progress = clamp(st.z / world.finishZ, 0, 1);

    /* ---------- what we ran into ---------- */

    collideRocks(st, world, events);
    collideDrifters(st, world, events);
    crossGates(st, world, px, py, pz, events);
    scoopOre(st, world, events);
    runBeam(st, input, world, events);

    /* ---------- leaving the survey ---------- */

    if (st.lateral > world.strayLimit || st.z < -60) {
      if (!st.stray) { st.stray = true; events.push({ t: "stray", on: true }); }
      st.strayT += DT;
      if (st.strayT > STRAY_GRACE) die(st, world, "lost", events);
    } else if (st.stray) {
      st.stray = false; st.strayT = 0;
      events.push({ t: "stray", on: false });
    }

    if (st.shield <= 0) die(st, world, "shield", events);

    if (!st.dead && st.z >= world.finishZ) {
      st.finished = true;
      st.finishT = st.t;
      finishBonus(st, world, events);
      events.push({ t: "finish" });
    }
    return st;
  }

  function die(st, world, why, events) {
    if (st.dead || st.finished) return;
    st.dead = true; st.deadWhy = why; st.shield = 0; st.finishT = st.t;
    events.push({ t: "down", why: why });
  }

  function multiplier(st) { return 1 + 0.2 * Math.min(st.combo, 15); }

  function award(st, world, pts) {
    /* flying it free-drift is harder, and pays like it */
    st.score += pts * multiplier(st) * (1 + world.scoreBonus) * (st.assist ? 1 : 1.25);
  }

  function bumpCombo(st) {
    st.combo++;
    st.comboT = COMBO_WINDOW;
    if (st.combo > st.comboBest) st.comboBest = st.combo;
  }

  function breakCombo(st) { st.combo = 0; st.comboT = 0; }

  function heal(st, amount) {
    st.shield = Math.min(st.maxShield, st.shield + amount);
  }

  function takeHit(st, world, force, kind, events) {
    var dmg = clamp((force - 9) * 0.62, 2.5, 46);
    st.shield -= dmg;
    st.hits++;
    st.stunT = Math.min(0.85, 0.22 + force * 0.008);
    st.shakeT = 0.5;
    breakCombo(st);
    events.push({ t: "hit", kind: kind, force: force, dmg: dmg });
    if (st.shield <= 0) die(st, world, "shield", events);
  }

  /* Bounce off a sphere: push clear, then reflect what was going into it. */
  function bounce(st, nx, ny, nz, overlap) {
    st.x += nx * overlap; st.y += ny * overlap; st.z += nz * overlap;
    var into = st.vx * nx + st.vy * ny + st.vz * nz;
    if (into < 0) {
      st.vx -= nx * into * 1.5; st.vy -= ny * into * 1.5; st.vz -= nz * into * 1.5;
    }
    st.vx *= 0.72; st.vy *= 0.72; st.vz *= 0.72;
  }

  function collideRocks(st, world, events) {
    var b = Math.floor(st.z / BUCKET);
    for (var bi = b - 1; bi <= b + 1; bi++) {
      if (bi < 0 || bi >= world.rockBuckets.length) continue;
      var list = world.rockBuckets[bi];
      for (var i = 0; i < list.length; i++) {
        var r = world.rocks[list[i]];
        var dx = st.x - r.x, dy = st.y - r.y, dz = st.z - r.z;
        var rad = r.r + SHIP_R;
        var d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= rad * rad) continue;
        var d = Math.sqrt(d2) || 1e-4;
        var force = Math.max(0, -(st.vx * dx + st.vy * dy + st.vz * dz) / d);
        bounce(st, dx / d, dy / d, dz / d, rad - d);
        takeHit(st, world, force, "rock", events);
        if (st.dead) return;
      }
    }
  }

  var _dpt = {};
  function collideDrifters(st, world, events) {
    for (var i = 0; i < world.drifters.length; i++) {
      var d = world.drifters[i];
      if (Math.abs(d.z0 - st.z) > d.zSpan + 200) continue;
      drifterAt(world, d, st.t, _dpt);
      var dx = st.x - _dpt.x, dy = st.y - _dpt.y, dz = st.z - _dpt.z;
      var rad = d.r + SHIP_R;
      var d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= rad * rad) continue;
      var dist = Math.sqrt(d2) || 1e-4;
      var force = Math.max(0, -(st.vx * dx + st.vy * dy + st.vz * dz) / dist) + 8;
      bounce(st, dx / dist, dy / dist, dz / dist, rad - dist);
      takeHit(st, world, force, "drifter", events);
      if (st.dead) return;
    }
  }

  /* The hull's footprint in a frame's own plane: an oriented box seen
     end-on. Roll the ship to match the slot and the footprint shrinks to
     the width of the wings; ignore the slot and it is the whole span. */
  function footprint(st, gx, gy, gz) {
    var span = st.hull.span * (st.assist ? 0.62 : 1);
    var high = st.hull.height * (st.assist ? 0.7 : 1);
    return Math.abs(span * (st.right.x * gx + st.right.y * gy + st.right.z * gz)) +
           Math.abs(high * (st.up.x * gx + st.up.y * gy + st.up.z * gz));
  }

  function crossGates(st, world, px, py, pz, events) {
    var gates = world.gates;
    while (st.gateNext < gates.length && st.z >= gates[st.gateNext].z) {
      var g = gates[st.gateNext];
      st.gateNext++;
      if (st.gateState[g.n]) continue;
      var span = st.z - pz;
      var f = Math.abs(span) < 1e-6 ? 0 : clamp((g.z - pz) / span, 0, 1);
      var cx = px + (st.x - px) * f, cy = py + (st.y - py) * f, cz = pz + (st.z - pz) * f;
      var dx = cx - g.x, dy = cy - g.y, dz = cz - g.z;
      var u = dx * g.ax + dy * g.ay + dz * g.az;
      var v = dx * g.bx + dy * g.by + dz * g.bz;
      var fu = footprint(st, g.ax, g.ay, g.az);
      var fv = footprint(st, g.bx, g.by, g.bz);
      var au = Math.abs(u), av = Math.abs(v);

      if (au + fu <= g.halfW && av + fv <= g.halfH) {
        /* a clean thread is centred *and* squared up with the slot — the
           whole reason the frames are cut long in one direction */
        var clean = au <= g.halfW * 0.4 && av <= g.halfH * 0.4 &&
                    fv <= st.hull.height * 1.7;
        st.gateState[g.n] = 1;
        st.gates++;
        if (clean) st.gatesClean++;
        bumpCombo(st);
        award(st, world, clean ? 340 : 150);
        heal(st, clean ? 3.2 : 1.6);
        events.push({ t: "gate", clean: clean, n: g.n, u: u, v: v });
      } else if (au - fu <= g.halfW + GATE_RIM && av - fv <= g.halfH + GATE_RIM) {
        st.gateState[g.n] = 2;
        st.gatesMissed++;
        var force = 14 + st.speed * 0.10;
        var nx = u >= 0 ? g.ax : -g.ax, ny = u >= 0 ? g.ay : -g.ay, nz = u >= 0 ? g.az : -g.az;
        bounce(st, nx, ny, nz, 0.5);
        takeHit(st, world, force, "frame", events);
        events.push({ t: "clip", n: g.n });
      } else {
        st.gateState[g.n] = 2;
        st.gatesMissed++;
        breakCombo(st);
        events.push({ t: "miss", n: g.n });
      }
      if (st.dead) return;
    }
  }

  function scoopOre(st, world, events) {
    var b = Math.floor(st.z / BUCKET);
    for (var bi = b - 1; bi <= b + 1; bi++) {
      if (bi < 0 || bi >= world.oreBuckets.length) continue;
      var list = world.oreBuckets[bi];
      for (var i = 0; i < list.length; i++) {
        var idx = list[i];
        if (st.oreTaken[idx]) continue;
        var o = world.ore[idx];
        var dx = st.x - o.x, dy = st.y - o.y, dz = st.z - o.z;
        if (dx * dx + dy * dy + dz * dz >= PICKUP_R * PICKUP_R) continue;
        st.oreTaken[idx] = 1;
        st.ore++;
        bumpCombo(st);
        award(st, world, 55 * st.cargo);
        heal(st, 0.6);
        events.push({ t: "ore", n: idx, x: o.x, y: o.y, z: o.z });
      }
    }
  }

  function runBeam(st, input, world, events) {
    var want = !!input.beam && st.stunT <= 0;
    st.beamOn = want;
    if (!want) { st.beamT = 0; st.beamTarget = -1; return; }

    var best = -1, bestD = BEAM_RANGE;
    var b = Math.floor(st.z / BUCKET);
    var reach = Math.ceil(BEAM_RANGE / BUCKET) + 1;
    for (var bi = b - 1; bi <= b + reach; bi++) {
      if (bi < 0 || bi >= world.rockBuckets.length) continue;
      var list = world.rockBuckets[bi];
      for (var i = 0; i < list.length; i++) {
        var idx = list[i];
        var r = world.rocks[idx];
        if (!r.vein || st.cracked[idx]) continue;
        var dx = r.x - st.x, dy = r.y - st.y, dz = r.z - st.z;
        var d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d > bestD || d < 1e-3) continue;
        if ((dx * st.fwd.x + dy * st.fwd.y + dz * st.fwd.z) / d < BEAM_COS) continue;
        best = idx; bestD = d;
      }
    }
    if (best < 0) { st.beamT = 0; st.beamTarget = -1; return; }
    if (best !== st.beamTarget) { st.beamTarget = best; st.beamT = 0; }
    st.beamT += DT;
    if (st.beamT < BEAM_TIME) return;

    var rock = world.rocks[best];
    st.cracked[best] = 1;
    st.beamT = 0; st.beamTarget = -1;
    var yield_ = 2 + Math.floor(rock.r / 4);
    st.ore += yield_;
    st.cracks++;
    bumpCombo(st);
    award(st, world, 120 + 40 * yield_ * st.cargo);
    heal(st, 2.4);
    events.push({ t: "crack", n: best, x: rock.x, y: rock.y, z: rock.z, ore: yield_ });
  }

  function finishBonus(st, world, events) {
    var par = world.par;
    var early = Math.max(0, par - st.finishT);
    var pts = 500 + early * 14 + (st.shield / st.maxShield) * 350;
    if (st.gatesMissed === 0 && world.gates.length) pts += 750;
    st.score += pts * (1 + world.scoreBonus);
    events.push({ t: "bonus", pts: pts });
  }

  function summarise(st, world) {
    return {
      finished: st.finished, dead: st.dead, why: st.deadWhy,
      finishT: st.finishT || st.t,
      score: Math.round(st.score),
      gates: st.gates, gatesClean: st.gatesClean, gatesMissed: st.gatesMissed,
      gatesTotal: world.gates.length,
      ore: st.ore, oreTotal: world.ore.length, cracks: st.cracks,
      hits: st.hits, combo: st.comboBest,
      shield: Math.max(0, st.shield), maxShield: st.maxShield,
      topSpeed: st.topSpeed,
      hull: st.hull.id,
      progress: clamp(st.z / world.finishZ, 0, 1)
    };
  }

  /* ==========================================================================
     REFERENCE PILOT

     One honest autopilot, used by the test suite to prove every sector can
     actually be flown, and by the menu to fly the belt behind the map while
     you pick where to go. It only knows what a player knows: where the line
     goes, where the next frame is, and how it is rolled.
     ========================================================================== */

  var _conj = qIdent(), _bdir = { x: 0, y: 0, z: 0 };

  function autoInput(st, world, opts) {
    opts = opts || {};
    var out = {
      up: false, down: false, left: false, right: false,
      rollL: false, rollR: false, boost: false, brake: false, beam: false
    };
    if (st.dead || st.finished) return out;

    /* Cross-track guidance, not pure pursuit. Chasing a point on the line
       makes a fast hull weave across it; asking instead for the sideways
       speed that would null the offset settles onto the line and stays
       there. Every frame sits on the line, so holding it threads them all. */
    var c0 = world.course[st.courseIdx];
    lateralOf(world, st.x, st.y, st.z, _lat);
    var vu = st.vx * c0.rx + st.vy * c0.ry + st.vz * c0.rz;
    var vv = st.vx * c0.ux + st.vy * c0.uy + st.vz * c0.uz;
    var g = world.gates[st.gateNext];
    var near = g && g.z > st.z && g.z - st.z < Math.max(140, st.speed * 1.8);
    var cap = 0.45 * Math.max(20, st.speed);
    var pull = near ? 1.7 : 1.1;    /* pull harder onto the line for a frame */
    var wantU = clamp(-_lat.u * pull, -cap, cap);
    var wantV = clamp(-_lat.v * pull, -cap, cap);

    /* aim off the tangent a little ahead, so a bend is met rather than chased */
    var leadIdx = Math.round(clamp(st.speed * 0.5, 30, 150) / COURSE_DS);
    var lead = world.course[Math.min(world.courseN - 1, st.courseIdx + leadIdx)];
    var dx = lead.tx * st.speed + c0.rx * wantU + c0.ux * wantV;
    var dy = lead.ty * st.speed + c0.ry * wantU + c0.uy * wantV;
    var dz = lead.tz * st.speed + c0.rz * wantU + c0.uz * wantV;

    /* With the assist on the hull goes where it is aimed, so the nose points
       at the velocity we want. With it off the thrust only *changes* the
       velocity, so the nose has to point at the difference instead — which
       is why free drift feels like flying a boat until it clicks. */
    if (!st.assist) {
      var mix = 1.8;
      dx += (dx - st.vx) * mix; dy += (dy - st.vy) * mix; dz += (dz - st.vz) * mix;
    }

    /* the aim direction, seen from the cockpit */
    _conj.x = -st.q.x; _conj.y = -st.q.y; _conj.z = -st.q.z; _conj.w = st.q.w;
    qRotate(_conj, dx, dy, dz, _bdir);
    var ahead = Math.max(1, _bdir.z);
    var pitchErr = Math.atan2(_bdir.y, ahead);
    var yawErr = Math.atan2(_bdir.x, ahead);

    /* the rates are the derivative term: a nose already swinging the right
       way does not need the stick held over */
    var pitchCmd = pitchErr * 3.2 + st.wx * 0.85;
    var yawCmd = yawErr * 3.2 - st.wy * 0.85;
    var dead = 0.03;
    if (pitchCmd > dead) out.up = true; else if (pitchCmd < -dead) out.down = true;
    if (yawCmd > dead) out.right = true; else if (yawCmd < -dead) out.left = true;

    /* lie the wings along the slot: the angle from the canopy to the frame's
       short axis, wrapped into a quarter turn because a frame does not care
       which way up you go through it */
    if (near) {
      var th = Math.atan2(
        g.bx * st.right.x + g.by * st.right.y + g.bz * st.right.z,
        g.bx * st.up.x + g.by * st.up.y + g.bz * st.up.z);
      if (th > Math.PI / 2) th -= Math.PI;
      if (th < -Math.PI / 2) th += Math.PI;
      var rollCmd = th * 2.4 + st.wz * 0.5;
      if (rollCmd > 0.06) out.rollR = true; else if (rollCmd < -0.06) out.rollL = true;
      if (_lat.d > g.halfH * 0.5 && g.z - st.z < 90) out.brake = true;
    }
    /* a long way off the line is a bad place to be going fast */
    if (_lat.d > world.corridor * 0.7) out.brake = true;
    if (opts.boost && !near && !out.brake && st.heat < 0.7 && _lat.d < world.corridor * 0.3) out.boost = true;
    if (opts.brake) out.brake = true;
    return out;
  }

  /* ================= career map =================
     Five stages out through the belt. Clear any node in a stage to open the
     next one; clear all three for the badge. */

  var STAGE_PLAN = [
    { name: "Shakedown", pool: ["kariba"], mods: ["none", "none", "sprint"], len: 2600, tier: 1 },
    { name: "The Copperbelt", pool: ["copperbelt", "kariba"], mods: ["none", "dense", "haul"], len: 3200, tier: 2 },
    { name: "Kafue Drift", pool: ["kafue", "copperbelt"], mods: ["squall", "none", "dense"], len: 3600, tier: 3 },
    { name: "Mosi Rings", pool: ["mosi", "kafue"], mods: ["none", "swarm", "eclipse"], len: 4200, tier: 4 },
    { name: "Batoka Deep", pool: ["batoka", "mosi"], mods: ["eclipse", "dense", "swarm"], len: 4800, tier: 5 }
  ];

  var OBJ_PLAN = [
    ["finish", "ore", "clean"],
    ["score", "gates", "ore"],
    ["clean", "score", "time"],
    ["gates", "ore", "score"],
    ["score", "clean", "time"]
  ];

  /* How many frames a spec will end up with, without building the sector —
     the career map has to print a target before anything is generated. */
  function gateCountFor(spec) {
    var n = Math.floor(spec.length / COURSE_DS) + 1;
    var step = Math.max(5, Math.round(spec.gateGap / COURSE_DS));
    var count = 0;
    for (var i = Math.max(step, 16); i < n - 8; i += step) count++;
    return count;
  }

  function objectiveTarget(kind, tier, spec, rng) {
    switch (kind) {
      case "score": return Math.round((3200 + tier * 2400 + rng() * 800) / 100) * 100;
      case "gates": return Math.max(1, Math.round(gateCountFor(spec) * (0.60 + tier * 0.055)));
      case "ore": return 8 + tier * 5 + Math.round(rng() * 4);
      case "clean": return Math.max(0, 4 - tier);
      case "time": return Math.round(spec.length / (spec.cruise * 0.70) / 5) * 5;
      default: return 0;
    }
  }

  function makeCareer(careerSeed) {
    var rng = mulberry32(normSeed(careerSeed || 20260101));
    var stages = [];
    for (var s = 0; s < STAGE_PLAN.length; s++) {
      var plan = STAGE_PLAN[s];
      var nodes = [];
      for (var nI = 0; nI < 3; nI++) {
        var sector = plan.pool[nI % plan.pool.length];
        var mod = plan.mods[nI];
        var seed = normSeed(Math.floor(rng() * 0x40000000));
        var spec = makeSpec({ seed: seed, sector: sector, modifier: mod, length: plan.len });
        var kind = OBJ_PLAN[s][nI];
        nodes.push({
          id: "s" + s + "n" + nI,
          stage: s, index: nI,
          seed: seed, sector: sector, modifier: mod,
          length: spec.length, tier: plan.tier,
          objective: kind, target: objectiveTarget(kind, plan.tier, spec, rng),
          rep: 140 * plan.tier + (kind === "finish" ? 0 : 70),
          code: codeFromSeed(seed)
        });
      }
      stages.push({ index: s, name: plan.name, tier: plan.tier, nodes: nodes });
    }
    return { seed: careerSeed, stages: stages };
  }

  function objectiveLabel(node) {
    var o = OBJECTIVES[node.objective];
    return o ? o.icon + "  " + o.label(node.target) : "Reach the refinery";
  }

  function objectiveMet(node, summary) {
    var o = OBJECTIVES[node.objective];
    return o ? !!o.check(summary, node.target) : !!summary.finished;
  }

  /* Objective progress 0..1, for the live HUD readout. */
  function objectiveProgress(node, st) {
    switch (node.objective) {
      case "score": return clamp(st.score / node.target, 0, 1);
      case "gates": return clamp(st.gates / node.target, 0, 1);
      case "ore": return clamp(st.ore / node.target, 0, 1);
      case "clean": return st.hits <= node.target ? 1 : 0;
      case "time": return st.t <= node.target ? 1 : 0;
      default: return 0;
    }
  }

  /* Which hulls this much rep has earned. */
  function shipsFor(rep) {
    var out = [];
    for (var i = 0; i < SHIP_ORDER.length; i++) {
      var s = SHIPS[SHIP_ORDER[i]];
      if (rep >= s.rep) out.push(s.id);
    }
    return out;
  }

  /* ================= flight codes =================
     A run is one number, so a run is one short code you can read out loud. */

  var ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";   /* no 0/O/1/I */

  /* Six base-32 characters hold exactly 30 bits, so 30 bits is the whole seed
     space. Every seed the game invents is folded into it before use — a code
     that cannot rebuild its own sector is worse than no code at all. */
  var SEED_MASK = 0x3FFFFFFF;

  function normSeed(v) {
    var n = (v >>> 0) & SEED_MASK;
    return n === 0 ? 1 : n;
  }

  function randomSeed() {
    return normSeed(Math.floor(Math.random() * 0x40000000));
  }

  function codeFromSeed(seed) {
    var v = normSeed(seed), out = "";
    for (var i = 0; i < 6; i++) {
      out = ALPHABET[v & 31] + out;
      v = v >>> 5;
    }
    return out.slice(0, 3) + "-" + out.slice(3);
  }

  function seedFromCode(code) {
    var raw = String(code == null ? "" : code);
    if (!raw.length) return null;
    var s = raw.toUpperCase().replace(/[^0-9A-Z]/g, "");
    /* Anything typed is a valid sector. Even a handful of punctuation gets
       one, by hashing what was actually typed rather than refusing it. */
    var source = s.length ? s : raw;
    var v = 0;
    for (var i = 0; i < source.length; i++) {
      var idx = s.length ? ALPHABET.indexOf(source[i]) : -1;
      if (idx < 0) idx = source.charCodeAt(i) % 32;
      v = ((v * 32) + idx) >>> 0;
    }
    return normSeed(v);
  }

  /* Today's sector: the same belt for everyone, new at midnight local time. */
  function dailySeed(date) {
    var d = date || new Date();
    return normSeed((d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate()) * 2654435761);
  }

  /* ================= exports ================= */

  var API = {
    SECTORS: SECTORS, SECTOR_ORDER: SECTOR_ORDER,
    MODIFIERS: MODIFIERS, OBJECTIVES: OBJECTIVES, STAGE_PLAN: STAGE_PLAN,
    SHIPS: SHIPS, SHIP_ORDER: SHIP_ORDER, shipsFor: shipsFor,
    DT: DT, COURSE_DS: COURSE_DS, MAX_SHIELD: MAX_SHIELD, SHIP_R: SHIP_R,
    PICKUP_R: PICKUP_R, BEAM_RANGE: BEAM_RANGE, BEAM_TIME: BEAM_TIME,
    GATE_RIM: GATE_RIM, GATE_MIN_H: GATE_MIN_H, STRAY_GRACE: STRAY_GRACE,
    MIN_CORRIDOR: MIN_CORRIDOR,
    makeSpec: makeSpec, buildWorld: buildWorld, gateCountFor: gateCountFor,
    newShip: newShip, stepShip: stepShip, summarise: summarise, autoInput: autoInput,
    courseIdxAt: courseIdxAt, lateralOf: lateralOf, fromFrame: fromFrame,
    drifterAt: drifterAt, footprint: footprint, multiplier: multiplier,
    makeCareer: makeCareer, objectiveLabel: objectiveLabel,
    objectiveMet: objectiveMet, objectiveProgress: objectiveProgress,
    codeFromSeed: codeFromSeed, seedFromCode: seedFromCode, dailySeed: dailySeed,
    normSeed: normSeed, randomSeed: randomSeed, SEED_MASK: SEED_MASK,
    fmtClock: fmtClock, mulberry32: mulberry32, vnoise: vnoise, fbm1: fbm1,
    clamp: clamp, wrapPi: wrapPi,
    qIdent: qIdent, qMul: qMul, qRotate: qRotate, qNormalize: qNormalize,
    qIntegrate: qIntegrate, aimShipAt: aimShipAt, refreshBasis: refreshBasis
  };

  if (typeof module !== "undefined" && module.exports) module.exports = API;
  if (typeof window !== "undefined") window.ORBIT = API;
})();
