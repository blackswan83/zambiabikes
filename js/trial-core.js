/* ==========================================================================
   TRIAL — simulation core (no rendering, no DOM)

   Trial is the club's freeride game: procedurally generated mountains, a
   trick system with real rotation, and a bail bar that style points refill.
   Everything deterministic lives here — seeded terrain, the carved and
   banked trail, the features cut into it (kickers, gaps, drops, berms,
   whoops, rock gardens), bike physics, trick scoring and the career map.
   The Three.js renderer (js/trial.js) only *reads* this world.

   Loaded in the browser it exposes window.TRIAL; under node it exports the
   same API for tests.

   Units are metres, +z is downhill, +y is up. One seed = one mountain.
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

  function smoothstepN(v, a, b) {
    var t = Math.min(1, Math.max(0, (v - a) / (b - a)));
    return t * t * (3 - 2 * t);
  }

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  function wrapPi(a) {
    while (a > Math.PI) a -= 2 * Math.PI;
    while (a < -Math.PI) a += 2 * Math.PI;
    return a;
  }

  /* ================= biomes =================
     A biome is a mountain recipe: how the ground rolls, what grows on it,
     which features the generator likes to cut into the trail, and how the
     sky over it looks. Everything a run needs beyond its seed. */

  var BIOMES = {
    nyika: {
      id: "nyika", name: "Nyika Plateau", short: "Nyika",
      desc: "Rolling grassland at 2 000 m. Wide open, fast, and every crest is a jump.",
      slope: 0.115, wobble: 0.85, rough: 1.0, grip: 1.0, treeDensity: 0.35,
      featureGap: 46, featureAmp: 1.0,
      weights: { kicker: 34, roller: 22, berm: 16, hip: 10, drop: 6, gap: 6, rocks: 6 },
      props: [["grass", 6, 0], ["bush", 3, 0], ["protea", 3, 0.7], ["rock", 2, 1.0], ["msasa", 1, 2.0]],
      theme: {
        sky: 0xBEE3F2, fog: 0xD3E8DE, fogNear: 70, fogFar: 520,
        sun: 0xFFF6DC, sunPos: [150, 240, -140], ambient: 0x9FC7AE,
        turbidity: 3.4, rayleigh: 1.2, mieCoeff: 0.003, mieG: 0.78, exposure: 0.54,
        grass: 0x63A45C, grassDry: 0x9DB65A, dirt: 0x8B6339, dirtDark: 0x6A4826,
        rock: 0x8C8874, trunk: 0x5A4028, canopy: 0x357F49, canopy2: 0x5C9A50,
        rockiness: 0.55, accent: 0xE8791D
      }
    },
    miombo: {
      id: "miombo", name: "Miombo Woodland", short: "Miombo",
      desc: "Tight singletrack through msasa trees. Pick a line early or wear a trunk.",
      slope: 0.10, wobble: 1.25, rough: 1.1, grip: 1.0, treeDensity: 1.55,
      featureGap: 40, featureAmp: 0.85,
      weights: { kicker: 26, roller: 22, berm: 24, drop: 8, rocks: 12, hip: 6, gap: 2 },
      props: [["msasa", 6, 2.0], ["msasa", 4, 2.2], ["bush", 3, 0], ["fern", 3, 0], ["grass", 3, 0], ["rock", 2, 1.1]],
      theme: {
        sky: 0xC6E7EC, fog: 0xCFE4CC, fogNear: 40, fogFar: 340,
        sun: 0xFFF3D0, sunPos: [130, 210, -180], ambient: 0x8FBB97,
        turbidity: 4.2, rayleigh: 1.5, mieCoeff: 0.0035, mieG: 0.79, exposure: 0.52,
        grass: 0x4E9B58, grassDry: 0x7FAE5A, dirt: 0x8A6238, dirtDark: 0x6B4826,
        rock: 0x8B8570, trunk: 0x543C24, canopy: 0x2F7A44, canopy2: 0x4E9B58,
        rockiness: 0.7, accent: 0xE8791D
      }
    },
    batoka: {
      id: "batoka", name: "Batoka Gorge", short: "Batoka",
      desc: "Basalt walls above the Zambezi. Steep, loose and unforgiving — send it clean.",
      slope: 0.175, wobble: 1.0, rough: 1.35, grip: 0.9, treeDensity: 0.5,
      featureGap: 52, featureAmp: 1.25,
      weights: { kicker: 28, drop: 22, gap: 16, rocks: 16, berm: 10, roller: 6, hip: 2 },
      props: [["rock", 7, 1.3], ["rock", 4, 1.7], ["bush", 3, 0], ["grass", 2, 0], ["baobab", 1, 2.4], ["msasa", 1, 1.9]],
      theme: {
        sky: 0xC9E4E4, fog: 0xD6D2BC, fogNear: 55, fogFar: 460,
        sun: 0xFFF8E4, sunPos: [-160, 200, -180], ambient: 0xB4AC92,
        turbidity: 5.5, rayleigh: 1.1, mieCoeff: 0.004, mieG: 0.8, exposure: 0.5,
        grass: 0x7E8B4A, grassDry: 0xA79A52, dirt: 0x8A6440, dirtDark: 0x5E4128,
        rock: 0x6E6A62, trunk: 0x5E4630, canopy: 0x4E7A44, canopy2: 0x6E8E4A,
        rockiness: 2.4, accent: 0x2A9D8F
      }
    },
    kalahari: {
      id: "kalahari", name: "Kalahari Sand Belt", short: "Kalahari",
      desc: "Sunset dunes. The sand eats your speed, so pump every roller and stay off the brakes.",
      slope: 0.125, wobble: 1.1, rough: 1.5, grip: 0.86, treeDensity: 0.28,
      featureGap: 44, featureAmp: 1.15,
      weights: { kicker: 30, roller: 30, hip: 14, berm: 12, gap: 8, drop: 6 },
      props: [["grass", 5, 0], ["acacia", 4, 1.6], ["baobab", 2, 2.6], ["bush", 3, 0], ["rock", 1, 1.0], ["termite", 2, 0.9]],
      theme: {
        sky: 0xFFC469, fog: 0xE7A662, fogNear: 80, fogFar: 520,
        sun: 0xFFE4A8, sunPos: [-220, 60, -260], ambient: 0xD8AE86,
        turbidity: 7.5, rayleigh: 2.0, mieCoeff: 0.0045, mieG: 0.81, exposure: 0.46,
        grass: 0xB09A44, grassDry: 0xCBB157, dirt: 0xB98A46, dirtDark: 0x8A5F2E,
        rock: 0x9A7A56, trunk: 0x6E4A26, canopy: 0x7C6A32, canopy2: 0x96803A,
        rockiness: 0.3, accent: 0xF7B733
      }
    },
    mafinga: {
      id: "mafinga", name: "Mafinga Hills", short: "Mafinga",
      desc: "The roof of Zambia at first light. The longest, steepest, coldest run there is.",
      slope: 0.20, wobble: 1.15, rough: 1.2, grip: 0.94, treeDensity: 0.8,
      featureGap: 42, featureAmp: 1.4,
      weights: { kicker: 30, gap: 18, drop: 16, berm: 14, rocks: 10, roller: 8, hip: 4 },
      props: [["pine", 5, 2.2], ["rock", 4, 1.4], ["msasa", 2, 1.9], ["fern", 3, 0], ["grass", 3, 0], ["bush", 2, 0]],
      theme: {
        sky: 0x8FB6D8, fog: 0xBCC9CE, fogNear: 40, fogFar: 380,
        sun: 0xFFD9A0, sunPos: [200, 70, -220], ambient: 0x8CA0B0,
        turbidity: 4.0, rayleigh: 2.8, mieCoeff: 0.006, mieG: 0.82, exposure: 0.5,
        grass: 0x3E7A50, grassDry: 0x6E8A4E, dirt: 0x6E5238, dirtDark: 0x4E3826,
        rock: 0x74747A, trunk: 0x4A3828, canopy: 0x225C40, canopy2: 0x357F49,
        rockiness: 1.6, accent: 0x9AD1E8
      }
    }
  };
  var BIOME_ORDER = ["nyika", "miombo", "kalahari", "batoka", "mafinga"];

  /* ================= run modifiers =================
     Modifiers are the twist on a node: they rewrite the run spec before the
     mountain is built, so a "Big Air" Nyika and a plain Nyika grown from the
     same seed are the same hillside with different jumps. */

  var MODIFIERS = {
    none:    { id: "none", name: "Standard", icon: "🚵", desc: "The mountain as it comes." },
    bigair:  { id: "bigair", name: "Big Air", icon: "🚀", desc: "Every lip built double size. More hangtime, harder landings.",
               apply: function (s) { s.featureAmp *= 1.45; s.weights.kicker *= 2; s.weights.gap *= 1.6; } },
    steep:   { id: "steep", name: "Steep", icon: "📐", desc: "The fall line, straight down. Speed is not the problem — stopping is.",
               apply: function (s) { s.slope *= 1.4; s.wobble *= 0.75; } },
    trees:   { id: "trees", name: "Tight Trees", icon: "🌳", desc: "Twice the forest, half the room.",
               apply: function (s) { s.treeDensity *= 2.0; s.wobble *= 1.25; } },
    night:   { id: "night", name: "Night Ride", icon: "🌙", desc: "Bar light only. You will hear the drop before you see it.",
               apply: function (s) { s.night = true; } },
    rain:    { id: "rain", name: "Wet Roots", icon: "🌧️", desc: "Rain on the mountain. Less grip, longer braking, slicker landings.",
               apply: function (s) { s.grip *= 0.78; s.wet = true; } },
    marathon:{ id: "marathon", name: "Marathon", icon: "⏱️", desc: "A run half again as long, with the checkpoints spread thin.",
               apply: function (s) { s.length = Math.round(s.length * 1.55); s.gateEvery *= 1.5; } },
    sprint:  { id: "sprint", name: "Sprint", icon: "⚡", desc: "Short, mean and against the clock.",
               apply: function (s) { s.length = Math.round(s.length * 0.62); s.featureGap *= 0.8; } }
  };

  /* ================= objectives =================
     Each node asks for one thing. `check` gets the finished run summary. */

  var OBJECTIVES = {
    finish: {
      id: "finish", icon: "🏁",
      label: function () { return "Reach the bottom"; },
      check: function (r) { return r.finished; }
    },
    style: {
      id: "style", icon: "✨",
      label: function (t) { return "Score " + t.toLocaleString() + " style"; },
      check: function (r, t) { return r.finished && r.style >= t; }
    },
    clean: {
      id: "clean", icon: "🛡️",
      label: function (t) { return t === 0 ? "Finish without a single bail" : "Finish with " + t + " bail" + (t === 1 ? "" : "s") + " or fewer"; },
      check: function (r, t) { return r.finished && r.bails <= t; }
    },
    time: {
      id: "time", icon: "⏱️",
      label: function (t) { return "Finish inside " + fmtClock(t); },
      check: function (r, t) { return r.finished && r.finishT <= t; }
    },
    air: {
      id: "air", icon: "🪂",
      label: function (t) { return "Spend " + t.toFixed(0) + "s in the air"; },
      check: function (r, t) { return r.finished && r.airTotal >= t; }
    },
    tricks: {
      id: "tricks", icon: "🔁",
      label: function (t) { return "Land " + t + " tricks"; },
      check: function (r, t) { return r.finished && r.tricks >= t; }
    }
  };

  function fmtClock(sec) {
    var m = Math.floor(sec / 60);
    var s = Math.round(sec % 60);
    if (s === 60) { s = 0; m++; }
    return m + ":" + (s < 10 ? "0" : "") + s;
  }

  /* ================= run spec ================= */

  /* A spec is the full recipe for one mountain: biome params merged with the
     node's modifier. buildWorld only ever reads a spec. */
  function makeSpec(opts) {
    var b = BIOMES[opts.biome] || BIOMES.nyika;
    var spec = {
      seed: (opts.seed >>> 0) || 1,
      biome: b.id, biomeDef: b,
      modifier: opts.modifier || "none",
      length: opts.length || 1500,
      slope: b.slope, wobble: b.wobble, rough: b.rough, grip: b.grip,
      treeDensity: b.treeDensity, featureGap: b.featureGap, featureAmp: b.featureAmp,
      gateEvery: 210, night: false, wet: false,
      weights: {}
    };
    for (var k in b.weights) if (b.weights.hasOwnProperty(k)) spec.weights[k] = b.weights[k];
    var mod = MODIFIERS[spec.modifier];
    if (mod && mod.apply) mod.apply(spec);
    return spec;
  }

  /* ================= world building ================= */

  var GRAV_G = 16.0;            /* gravity, shared with the physics below */
  var GRID_STEP = 2.5;          /* heightfield cell size */
  var X_HALF = 150;             /* world half-width in x */
  var TRAIL_DS = 2.5;           /* trail sample spacing — fine enough for lips */
  var CARVE_R = 8.5;            /* default trail half-width */

  function baseHeight(spec, x, z) {
    var s = spec.seed;
    var h = -z * spec.slope;
    h += 11 * vnoise(x / 200, z / 200, s);
    h += 5.5 * vnoise(x / 84, z / 84, s + 7);
    h += 2.2 * spec.rough * vnoise(x / 34, z / 34, s + 13);
    h += 0.8 * spec.rough * vnoise(x / 12, z / 12, s + 29);
    /* valley walls hold the run in a corridor you can read at speed */
    h += smoothstepN(Math.abs(x), 82, 190) * 40;
    return h;
  }

  /* ---- trail features ----
     Each builder writes into the delta layers laid over the smoothed trail.
     `dy` is a local shape (a lip, a roller); `after` is a permanent step —
     a jump or a drop leaves you lower down the mountain than the baseline
     said, and the trail below it must follow, or every feature would end in
     an uphill compression. `bank` tilts the cross-slope, `wid` widens the
     carve, `xoff` shifts the line sideways. All applied after grade-clamping
     so a 3 m lip survives. */

  var FEATURE_BUILDERS = {

    /* The shape that makes a jump feel right: a short steep lip, ground that
       falls away hard behind it, and a landing ramp still pointing downhill
       when you get to it. */
    kicker: function (F, i, rng, amp, ctx) {
      var size = 0.75 + rng() * 0.75;              /* 0.75 small … 1.5 huge */
      var lip = Math.round((3.5 + size * 3) / TRAIL_DS);
      var gap = Math.round((11 + size * 11) / TRAIL_DS);
      var land = Math.round((9 + size * 4) / TRAIL_DS);
      var h = (1.5 + size * 1.7) * amp;            /* lip height above baseline */
      var fall = (1.4 + size * 2.3) * amp;         /* drop from the lip to the landing */
      var extra = 0.4 * fall;                      /* landing keeps falling away */
      var k;
      for (k = 0; k <= lip; k++) F.dy[i + k] += h * Math.pow(k / lip, 1.7);
      for (k = 1; k <= gap; k++) F.dy[i + lip + k] += h + (-h - fall) * smoothstepN(k / gap, 0, 1);
      for (k = 1; k <= land; k++) F.dy[i + lip + gap + k] += -fall - extra * (k / land);
      F.stepDown(i + lip + gap + land + 1, fall + extra);
      F.widen(i, i + lip + gap + land, 2.5 + size * 2.5);
      return {
        kind: "kicker", i0: i, iLip: i + lip, i1: i + lip + gap + land,
        size: size, h: h, gapM: gap * TRAIL_DS,
        name: size > 1.25 ? "Big Sender" : (size > 1.0 ? "Kicker" : "Tabletop"),
        big: size > 1.1
      };
    },

    /* Road gap: a kicker with a hollow bitten out of its landing. Clear the
       gully and you touch down on the same steep ramp a kicker would give
       you; come up short and you ride the near wall down into it. The gully
       is sized from the flight a rider can actually make off this lip, not
       from a number picked out of the air. */
    gap: function (F, i, rng, amp, ctx) {
      var size = 0.9 + rng() * 0.7;
      var lip = Math.round(5 / TRAIL_DS);
      var h = (1.7 + size * 1.5) * amp;
      var fall = (2.2 + size * 2.2) * amp;
      var extra = 0.45 * fall;

      /* how far a rider arriving at a realistic clip flies off this lip */
      var ALPHA = 0.45;                            /* ~26 deg of built lip */
      var vRef = 16.5;
      var vLip = Math.sqrt(Math.max(30, vRef * vRef - 2 * GRAV_G * h));
      var vy = vLip * Math.sin(ALPHA), vh = vLip * Math.cos(ALPHA);
      var flight = vh * (vy + Math.sqrt(vy * vy + 2 * GRAV_G * fall)) / GRAV_G;

      var descM = clamp(flight * 1.15, 15, 34);
      var desc = Math.max(4, Math.round(descM / TRAIL_DS));
      var land = Math.round(24 / TRAIL_DS);
      var hole = Math.min(descM * 0.11, 2 + size * 2.4) * amp;

      var k, u;
      for (k = 0; k <= lip; k++) F.dy[i + k] += h * Math.pow(k / lip, 1.7);
      for (k = 1; k <= desc; k++) {
        u = k / desc;
        var ramp = h + (-h - fall) * smoothstepN(u, 0, 1);
        /* the hollow sits in the first half of the ramp, so anything that
           clears it lands on clean, steep, downhill dirt */
        var gully = u < 0.66 ? 0.5 * hole * (1 - Math.cos(2 * Math.PI * u / 0.66)) : 0;
        F.dy[i + lip + k] += ramp - gully;
      }
      for (k = 1; k <= land; k++) F.dy[i + lip + desc + k] += -fall - extra * (k / land);
      F.stepDown(i + lip + desc + land + 1, fall + extra);
      F.widen(i, i + lip + desc + land, 3.4);
      return {
        kind: "gap", i0: i, iLip: i + lip, i1: i + lip + desc + land,
        size: size, h: h, gapM: descM, holeM: hole,
        name: descM > 26 ? "Canyon Gap" : "Road Gap", big: true
      };
    },

    /* Step-down: the hill just stops. Nothing to launch off, everything to
       land on — the feature that teaches you to look ahead. The ramp under
       it steepens with distance, the way the fall does, so the fast line and
       the careful line both find ground angled to meet them. */
    drop: function (F, i, rng, amp, ctx) {
      var size = 0.7 + rng() * 0.9;
      var edge = Math.round(4.5 / TRAIL_DS);
      var fallLen = Math.round(3 / TRAIL_DS);
      var deep = Math.min((2.2 + size * 3.2) * amp, 6.5);
      var landM = clamp(22 * Math.sqrt(2 * deep / GRAV_G) * 1.15, 16, 34);
      var land = Math.round(landM / TRAIL_DS);
      var extra = 0.75 * deep;
      var k;
      for (k = 0; k <= edge; k++) F.dy[i + k] += 0.45 * amp * Math.pow(k / edge, 2);
      for (k = 1; k <= fallLen; k++) {
        F.dy[i + edge + k] += 0.45 * amp + (-0.45 * amp - deep) * smoothstepN(k / fallLen, 0, 1);
      }
      for (k = 1; k <= land; k++) F.dy[i + edge + fallLen + k] += -deep - extra * Math.pow(k / land, 1.7);
      F.stepDown(i + edge + fallLen + land + 1, deep + extra);
      F.widen(i, i + edge + fallLen + land, 2.2);
      return {
        kind: "drop", i0: i, iLip: i + edge, i1: i + edge + fallLen + land,
        size: size, h: deep, gapM: 0,
        name: deep > 4.5 ? "Huck" : "Step-Down", big: deep > 3.6
      };
    },

    /* Whoops: a washboard you either pump or get bucked by. */
    roller: function (F, i, rng, amp, ctx) {
      var n = 3 + Math.floor(rng() * 4);
      var per = Math.round((7 + rng() * 4) / TRAIL_DS);
      var h = (0.5 + rng() * 0.65) * amp;
      var span = n * per;
      for (var k = 0; k <= span; k++) {
        var fade = Math.sin(Math.PI * clamp(k / span, 0, 1));
        F.dy[i + k] += h * Math.sin((k / per) * Math.PI * 2) * (0.4 + 0.6 * fade);
      }
      F.widen(i, i + span, 1.2);
      return { kind: "roller", i0: i, iLip: i, i1: i + span, size: h, h: h, gapM: 0, name: "Whoops", big: false };
    },

    /* Berm: find the nearest real corner and bank it hard. */
    berm: function (F, i, rng, amp, ctx) {
      var best = i, bestC = 0;
      for (var s = -8; s <= 14; s++) {
        var j = i + s;
        if (j < 4 || j > F.n - 12) continue;
        var c = Math.abs(F.curv[j]);
        if (c > bestC) { bestC = c; best = j; }
      }
      if (bestC < 0.02) return null;               /* no corner here — skip */
      var half = Math.round(11 / TRAIL_DS);
      var dir = F.curv[best] > 0 ? -1 : 1;         /* raise the outside */
      var strength = (0.6 + rng() * 0.5) * clamp(bestC / 0.09, 0.5, 1.7);
      for (var k = -half; k <= half; k++) {
        var j2 = best + k;
        if (j2 < 0 || j2 >= F.n) continue;
        var w = Math.cos((k / half) * Math.PI * 0.5);
        F.bank[j2] += dir * strength * w * w;
        F.wid[j2] = Math.max(F.wid[j2], CARVE_R + 4 * w);
      }
      return { kind: "berm", i0: best - half, iLip: best, i1: best + half, size: strength, h: 0, gapM: 0, name: "Berm", big: false };
    },

    /* Hip: a kicker that spits you sideways. The trail steps across as you
       take off, so the landing is somewhere you have to steer to. */
    hip: function (F, i, rng, amp, ctx) {
      var k1 = FEATURE_BUILDERS.kicker(F, i, rng, amp * 0.9, ctx);
      var side = rng() < 0.5 ? -1 : 1;
      var shift = (4 + rng() * 3.5) * side;
      for (var k = k1.iLip; k <= k1.i1 && k < F.n; k++) {
        var u = smoothstepN((k - k1.iLip) / Math.max(1, k1.i1 - k1.iLip), 0, 1);
        F.xoff[k] += shift * u;
        F.wid[k] = Math.max(F.wid[k], CARVE_R + 4.5);
      }
      for (k = k1.i1 + 1; k < F.n; k++) F.xoff[k] += shift;
      k1.kind = "hip"; k1.name = "Hip Jump";
      return k1;
    },

    /* Rock garden: no shaping, just chatter and boulders sitting in the
       middle of the line. Slow down, or pick your way through. */
    rocks: function (F, i, rng, amp, ctx) {
      var span = Math.round((14 + rng() * 16) / TRAIL_DS);
      for (var k = 0; k <= span; k++) F.rough[i + k] = 1;
      F.widen(i, i + span, 1.5);
      return { kind: "rocks", i0: i, iLip: i, i1: i + span, size: 1, h: 0, gapM: 0, name: "Rock Garden", big: false };
    }
  };

  function pickWeighted(weights, rng) {
    var total = 0, k;
    for (k in weights) if (weights.hasOwnProperty(k)) total += weights[k];
    var r = rng() * total;
    for (k in weights) {
      if (!weights.hasOwnProperty(k)) continue;
      r -= weights[k];
      if (r <= 0) return k;
    }
    return "kicker";
  }

  function buildWorld(spec) {
    var rng = mulberry32(spec.seed);
    var i, k;

    /* ---- trail path: a wandering descent, z strictly increasing ---- */
    var n = Math.floor(spec.length / TRAIL_DS);
    var pts = new Array(n);
    var phi1 = rng() * 6.28, phi2 = rng() * 6.28, phi3 = rng() * 6.28;
    var x = 0, z = 0;
    for (i = 0; i < n; i++) {
      var t = i * TRAIL_DS;
      var theta = spec.wobble * (0.60 * Math.sin(t * 0.0105 + phi1) +
        0.34 * Math.sin(t * 0.0262 + phi2) + 0.20 * Math.sin(t * 0.049 + phi3));
      theta = clamp(theta, -1.05, 1.05);
      x += Math.sin(theta) * TRAIL_DS;
      z += Math.cos(theta) * TRAIL_DS;
      x = clamp(x, -(X_HALF - 48), X_HALF - 48);
      pts[i] = { x: x, z: z, y: 0, yaw: theta, dist: t };
    }
    var zEnd = pts[n - 1].z;

    /* ---- trail height: terrain, smoothed hard, then grade-clamped ---- */
    for (i = 0; i < n; i++) pts[i].y = baseHeight(spec, pts[i].x, pts[i].z);
    for (var pass = 0; pass < 4; pass++) {
      for (i = 2; i < n - 2; i++) {
        pts[i].y = (pts[i - 2].y + pts[i - 1].y * 2 + pts[i].y * 3 + pts[i + 1].y * 2 + pts[i + 2].y) / 9;
      }
    }
    for (i = 1; i < n; i++) {
      if (pts[i].y > pts[i - 1].y + TRAIL_DS * 0.10) pts[i].y = pts[i - 1].y + TRAIL_DS * 0.10;
      if (pts[i].y < pts[i - 1].y - TRAIL_DS * 0.62) pts[i].y = pts[i - 1].y - TRAIL_DS * 0.62;
    }

    /* ---- feature pass ---- */
    var F = {
      n: n,
      dy: new Float32Array(n),
      after: new Float32Array(n),      /* permanent drops, prefix-summed later */
      bank: new Float32Array(n),
      wid: new Float32Array(n),
      xoff: new Float32Array(n),
      rough: new Uint8Array(n),
      curv: new Float32Array(n),
      widen: function (a, b, extra) {
        for (var j = Math.max(0, a); j <= Math.min(n - 1, b); j++) {
          if (F.wid[j] < CARVE_R + extra) F.wid[j] = CARVE_R + extra;
        }
      },
      stepDown: function (at, drop) {
        if (at >= 0 && at < n) F.after[at] -= drop;
      }
    };
    for (i = 0; i < n; i++) F.wid[i] = CARVE_R;
    for (i = 2; i < n - 2; i++) F.curv[i] = wrapPi(pts[i + 2].yaw - pts[i - 2].yaw);

    /* natural banking everywhere: corners tilt into the turn a little, so
       the whole mountain rides like a built trail, not a hillside */
    for (i = 0; i < n; i++) {
      var ci = 0;
      for (k = -3; k <= 3; k++) ci += F.curv[clamp(i + k, 0, n - 1)];
      F.bank[i] = clamp(-ci / 7 * 3.4, -0.42, 0.42);
    }

    var features = [];
    var d = 70;
    var endD = spec.length - 90;
    while (d < endD) {
      var idx = Math.round(d / TRAIL_DS);
      var kind = pickWeighted(spec.weights, rng);
      var builder = FEATURE_BUILDERS[kind];
      var amp = spec.featureAmp * (0.85 + rng() * 0.3);
      var feat = null;
      if (builder && idx > 6 && idx < n - 20) feat = builder(F, idx, rng, amp, spec);
      if (feat) {
        feat.dist = feat.iLip * TRAIL_DS;
        feat.id = features.length;
        features.push(feat);
        d = Math.max(d + 20, feat.i1 * TRAIL_DS + spec.featureGap * (0.6 + rng() * 0.7));
      } else {
        d += spec.featureGap * 0.6;
      }
    }

    /* apply the deltas, then a whisker of smoothing so nothing is a cliff
       the physics can catch a wheel on */
    var carry = 0;
    for (i = 0; i < n; i++) {
      carry += F.after[i];
      pts[i].y += F.dy[i] + carry;
      pts[i].x = clamp(pts[i].x + F.xoff[i], -(X_HALF - 40), X_HALF - 40);
    }
    for (i = 1; i < n - 1; i++) pts[i].y = pts[i].y * 0.92 + (pts[i - 1].y + pts[i + 1].y) * 0.04;
    for (i = 1; i < n; i++) pts[i].yaw = Math.atan2(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
    pts[0].yaw = pts[1].yaw;

    /* ---- heightfield with the trail carved and banked into it ---- */
    var nx = Math.floor((X_HALF * 2) / GRID_STEP) + 1;
    var z0 = -30, z1 = zEnd + 80;
    var nz = Math.floor((z1 - z0) / GRID_STEP) + 1;
    var H = new Float32Array(nx * nz);
    var TD = new Float32Array(nx * nz);

    function trailRangeForZ(zz) {
      var lo = 0, hi = n - 1;
      while (lo < hi) { var mid = (lo + hi) >> 1; if (pts[mid].z < zz) lo = mid + 1; else hi = mid; }
      return lo;
    }

    var win = Math.ceil(30 / TRAIL_DS);
    for (var gz = 0; gz < nz; gz++) {
      var wz = z0 + gz * GRID_STEP;
      var ci2 = trailRangeForZ(wz);
      for (var gx = 0; gx < nx; gx++) {
        var wx = -X_HALF + gx * GRID_STEP;
        var h = baseHeight(spec, wx, wz);
        var best = 1e9, bk = 0;
        for (k = Math.max(0, ci2 - win); k < Math.min(n, ci2 + win); k++) {
          var dx = pts[k].x - wx, dz = pts[k].z - wz;
          var d2 = dx * dx + dz * dz;
          if (d2 < best) { best = d2; bk = k; }
        }
        var dist = Math.sqrt(best);
        var p = pts[bk];
        /* signed cross-track offset, for banking */
        var lat = (wx - p.x) * Math.cos(p.yaw) - (wz - p.z) * Math.sin(p.yaw);
        var wid = F.wid[bk];
        var target = p.y + F.bank[bk] * clamp(lat, -wid, wid);
        var w = 1 - smoothstepN(dist, wid * 0.34, wid);
        var vi = gz * nx + gx;
        H[vi] = h * (1 - w) + target * w;
        TD[vi] = dist;
      }
    }

    var world = {
      spec: spec, biome: spec.biomeDef,
      nx: nx, nz: nz, z0: z0, x0: -X_HALF, step: GRID_STEP,
      H: H, TD: TD, trail: pts, trailN: n, trailDS: TRAIL_DS,
      wid: F.wid, bank: F.bank, rough: F.rough,
      features: features, gates: [], props: [], cover: [], hash: {}, hashCell: 8,
      finishIdx: n - 3, lengthM: spec.length, xHalf: X_HALF
    };

    /* re-read the trail height from the carved grid so physics and the drawn
       ground agree exactly */
    for (i = 0; i < n; i++) pts[i].y = heightAt(world, pts[i].x, pts[i].z);

    /* ---- checkpoints ---- */
    var gStep = Math.max(12, Math.round(spec.gateEvery / TRAIL_DS));
    for (i = gStep; i < n - 10; i += gStep) {
      /* never drop a checkpoint inside a feature — you would respawn on a lip */
      var safe = i;
      for (var g = 0; g < features.length; g++) {
        if (safe >= features[g].i0 - 3 && safe <= features[g].i1 + 3) safe = features[g].i1 + 5;
      }
      if (safe < n - 10) world.gates.push(safe);
    }

    /* ---- props ---- */
    placeProps(world, spec, mulberry32(spec.seed + 991));

    return world;
  }

  /* nearest trail index to a z, using the fact that trail z only increases */
  function trailIndexAtZ(world, z) {
    var pts = world.trail, lo = 0, hi = world.trailN - 1;
    while (lo < hi) { var mid = (lo + hi) >> 1; if (pts[mid].z < z) lo = mid + 1; else hi = mid; }
    return lo;
  }

  function placeProps(world, spec, rng) {
    var table = spec.biomeDef.props;
    var totalW = 0, i;
    for (i = 0; i < table.length; i++) totalW += table[i][1];

    var area = (X_HALF * 2) * (world.nz * GRID_STEP);
    var count = Math.floor(area * 0.0062 * spec.treeDensity);
    count = Math.min(count, 7000);

    for (i = 0; i < count; i++) {
      var px = -X_HALF + rng() * X_HALF * 2;
      var pz = world.z0 + 10 + rng() * (world.nz * GRID_STEP - 30);
      var td = trailDistAt(world, px, pz);
      /* nothing solid may stand where the trail is: the corridor is wider
         wherever a feature widened the carve, so ask the trail, not a constant */
      var near = world.wid[trailIndexAtZ(world, pz)] + 4;
      if (td < Math.max(11, near)) continue;
      if (Math.abs(px) > X_HALF - 12) continue;
      /* thin out with distance from the trail so the corridor reads first */
      if (td > 55 && rng() < 0.55) continue;
      var r = rng() * totalW, pick = table[0];
      for (var j = 0; j < table.length; j++) { r -= table[j][1]; if (r <= 0) { pick = table[j]; break; } }
      world.props.push({
        type: pick[0], x: px, z: pz, y: heightAt(world, px, pz),
        s: 0.72 + rng() * 0.75, rot: rng() * 6.28, r: pick[2]
      });
    }

    /* Rock gardens are the one place props sit on the line — and the one
       place they do not end your run. They are rollable: r = 0 keeps them
       out of the collision hash, and the `rough` flag on those trail indices
       does the work, dragging your speed down and shaking the bike. */
    var tr = world.trail;
    for (i = 0; i < world.features.length; i++) {
      var f = world.features[i];
      if (f.kind !== "rocks") continue;
      for (var k = f.i0; k <= f.i1; k++) {
        if (rng() < 0.5) continue;
        var p = tr[k];
        var lat = (rng() * 2 - 1) * 7;
        var bx = p.x + Math.cos(p.yaw) * lat, bz = p.z - Math.sin(p.yaw) * lat;
        world.props.push({
          type: "boulder", x: bx, z: bz, y: heightAt(world, bx, bz) - 0.12,
          s: 0.38 + rng() * 0.42, rot: rng() * 6.28, r: 0
        });
      }
    }

    placeCover(world, spec, mulberry32(spec.seed + 4457));

    /* spatial hash for collision, solid props only */
    for (i = 0; i < world.props.length; i++) {
      var pr = world.props[i];
      if (!pr.r) continue;
      var key = Math.floor(pr.x / world.hashCell) + "," + Math.floor(pr.z / world.hashCell);
      (world.hash[key] || (world.hash[key] = [])).push(i);
    }
  }

  /* Ground cover: tufts and scrub crowding the trail corridor. Kept out of
     world.props so nothing here can ever be collided with, and generated at
     a density the renderer can instance in one draw call per type. */
  function placeCover(world, spec, rng) {
    var cover = [];
    var pts = world.trail;
    var perStep = 9 * (0.6 + spec.treeDensity * 0.5);
    for (var i = 2; i < world.trailN - 2; i++) {
      var p = pts[i];
      var wid = world.wid[i];
      for (var k = 0; k < perStep; k++) {
        if (rng() < 0.35) continue;
        /* push the tufts out past the worn line, thinning with distance */
        var lat = (wid * 0.75 + Math.pow(rng(), 1.7) * 30) * (rng() < 0.5 ? -1 : 1);
        var along = (rng() - 0.5) * TRAIL_DS;
        var cx = p.x + Math.cos(p.yaw) * lat + Math.sin(p.yaw) * along;
        var cz = p.z - Math.sin(p.yaw) * lat + Math.cos(p.yaw) * along;
        if (Math.abs(cx) > X_HALF - 8) continue;
        cover.push({
          type: rng() < 0.82 ? "grass" : "fern",
          x: cx, z: cz, y: heightAt(world, cx, cz),
          s: 0.6 + rng() * 0.9, rot: rng() * 6.28, r: 0
        });
      }
    }
    world.cover = cover;
  }

  /* ================= terrain sampling ================= */

  function heightAt(world, x, z) {
    var fx = (x - world.x0) / world.step;
    var fz = (z - world.z0) / world.step;
    var ix = Math.floor(fx), iz = Math.floor(fz);
    if (ix < 0) ix = 0; if (iz < 0) iz = 0;
    if (ix > world.nx - 2) ix = world.nx - 2;
    if (iz > world.nz - 2) iz = world.nz - 2;
    var tx = fx - ix, tz = fz - iz;
    if (tx < 0) tx = 0; if (tx > 1) tx = 1;
    if (tz < 0) tz = 0; if (tz > 1) tz = 1;
    var i00 = iz * world.nx + ix;
    var a = world.H[i00], b = world.H[i00 + 1];
    var c = world.H[i00 + world.nx], d = world.H[i00 + world.nx + 1];
    return a * (1 - tx) * (1 - tz) + b * tx * (1 - tz) + c * (1 - tx) * tz + d * tx * tz;
  }

  function trailDistAt(world, x, z) {
    var fx = Math.round((x - world.x0) / world.step);
    var fz = Math.round((z - world.z0) / world.step);
    fx = clamp(fx, 0, world.nx - 1);
    fz = clamp(fz, 0, world.nz - 1);
    return world.TD[fz * world.nx + fx];
  }

  function normalAt(world, x, z) {
    var e = 1.1;
    var hx = heightAt(world, x + e, z) - heightAt(world, x - e, z);
    var hz = heightAt(world, x, z + e) - heightAt(world, x, z - e);
    var nx = -hx / (2 * e), nz = -hz / (2 * e);
    var len = Math.sqrt(nx * nx + 1 + nz * nz);
    return { x: nx / len, y: 1 / len, z: nz / len };
  }

  /* ================= physics ================= */

  var DT = 1 / 60;
  var GRAV = GRAV_G;
  var PEDAL_A = 13.5;
  var VCAP = 24;                /* pedalling cap on the flat; gravity beats it */
  var BRAKE_A = 21;
  var DRAG = 0.0105;
  var ROLL = 0.36;
  var STEER_RATE = 2.5;
  var HOP_MIN = 3.6, HOP_MAX = 7.4;
  var CHARGE_T = 0.42;          /* seconds of preload for a full bunny hop */
  var SPIN_RATE = 5.2;          /* rad/s once wound up */
  var FLIP_RATE = 4.5;
  var WHIP_MAX = 1.25;
  var CRASH_IMPACT = 13.5;
  var MAX_HEALTH = 100;

  var TOL = { assist: 1.62, normal: 0.60 };   /* landing tolerance, radians */
  var FREE_ROT = 0.42;          /* free air steering before rotation counts */

  function newRider(world, opts) {
    opts = opts || {};
    var p0 = world.trail[2], p1 = world.trail[4];
    return {
      x: p0.x, y: p0.y, z: p0.z,
      vx: 0, vy: 0, vz: 0,
      yaw: Math.atan2(p1.x - p0.x, p1.z - p0.z),
      lean: 0, pitch: 0,

      onGround: true, airT: 0, groundT: 0,
      hopCharge: 0, hopCd: 0, wheelSpin: 0,

      spin: 0, flip: 0, whip: 0, whipMax: 0,
      spinV: 0, flipV: 0, airVel: 0,

      crashT: 0, crashKind: null, dead: false, invuln: 0, chatter: 0, offTrail: false,
      health: MAX_HEALTH, maxHealth: MAX_HEALTH, bails: 0,

      style: 0, airStyle: 0, combo: 0, comboT: 0, comboBest: 0,
      tricks: 0, bigAirs: 0, perfects: 0,
      airTotal: 0, topSpeed: 0,

      trailIdx: 2, trailD: 0, respawnIdx: 2, gatesHit: 0,
      featPtr: 0, featHit: 0, featBigHit: 0,

      t: 0, finished: false, finishT: 0,
      assist: opts.assist !== false,
      grip: world.spec.grip,
      stats: opts.stats || null
    };
  }

  var DEFAULT_STATS = { pedal: 1, vcap: 1, brake: 1, steer: 1, roll: 1, rough: 1, landSoft: 0, hop: 1 };

  /* Trick naming: what the HUD shouts when you stick one. */
  function trickName(spins, flips, whipAmt, airT, backwards) {
    var parts = [];
    if (spins > 0) parts.push(spins === 1 ? "360" : (spins === 2 ? "720" : (spins === 3 ? "1080" : (spins * 360) + "")));
    if (flips > 0) {
      var word = backwards ? "Frontflip" : "Backflip";
      parts.push(flips === 1 ? word : (flips === 2 ? "Double " + word : flips + "× " + word));
    }
    if (whipAmt > 0.9) parts.push("Big Whip");
    else if (whipAmt > 0.55) parts.push("Whip");
    if (!parts.length) {
      if (airT > 2.0) return "Monster Air";
      if (airT > 1.35) return "Huge Air";
      if (airT > 0.85) return "Big Air";
      return null;
    }
    return parts.join(" ");
  }

  function scoreTrick(st, airT, ev) {
    var spins = Math.round(Math.abs(st.spin) / (Math.PI * 2));
    var flips = Math.round(Math.abs(st.flip) / (Math.PI * 2));
    var whipAmt = st.whipMax;

    var pts = Math.floor(airT * 110);
    if (spins) pts += 200 * spins + 130 * spins * (spins - 1);
    if (flips) pts += 380 * flips + 220 * flips * (flips - 1);
    if (whipAmt > 0.4) pts += Math.floor(190 * ((whipAmt - 0.4) / (WHIP_MAX - 0.4)));
    if (spins && flips) pts = Math.floor(pts * 1.3);       /* combined rotation bonus */

    var err = Math.abs(wrapPi(st.spin)) + Math.abs(wrapPi(st.flip)) * 0.8 + Math.abs(st.whip) * 0.6;
    var perfect = err < 0.16 && (spins || flips || whipAmt > 0.4 || airT > 0.8);
    if (perfect) { pts = Math.floor(pts * 1.25); st.perfects++; }

    if (pts <= 0) return null;

    /* combo: every trick landed without touching down for long, or bailing,
       stacks the multiplier — the Descenders bargain, risk for score */
    st.combo++;
    st.comboT = 3.4;
    if (st.combo > st.comboBest) st.comboBest = st.combo;
    var mult = 1 + 0.3 * Math.min(st.combo - 1, 12);
    var total = Math.floor(pts * mult);

    st.style += total;
    st.tricks++;
    if (airT > 0.9) st.bigAirs++;

    /* style is what patches you up */
    st.health = Math.min(st.maxHealth, st.health + total * 0.006);

    var name = trickName(spins, flips, whipAmt, airT, st.flip < 0);
    ev.push({ t: "trick", name: name || "Air", pts: total, mult: mult, perfect: perfect, combo: st.combo });
    return total;
  }

  function bail(st, why, severity, ev) {
    if (st.invuln > 0 || st.crashT > 0) return;
    st.crashT = 1.15;
    st.crashKind = why;
    st.bails++;
    st.combo = 0;
    st.comboT = 0;
    st.spin = st.flip = st.whip = st.whipMax = 0;
    st.spinV = st.flipV = 0;
    st.health -= severity;
    if (st.health <= 0) {
      st.health = 0;
      st.dead = true;
      ev.push({ t: "broken", why: why });
    }
    ev.push({ t: "bail", why: why, severity: severity });
  }

  function stepRider(st, inp, world, ev) {
    var S = st.stats || DEFAULT_STATS;
    var i, speed;

    st.hopCd -= DT;
    if (st.invuln > 0) st.invuln -= DT;
    if (st.comboT > 0) {
      st.comboT -= DT;
      if (st.comboT <= 0) { st.combo = 0; ev.push({ t: "combo-end" }); }
    }

    /* --- down: tumble, then pick up at the last checkpoint --- */
    if (st.crashT > 0) {
      st.crashT -= DT;
      st.vx *= 0.88; st.vz *= 0.88;
      if (!st.onGround) { st.vy -= GRAV * DT; st.y += st.vy * DT; }
      st.x += st.vx * DT; st.z += st.vz * DT;
      var gh0 = heightAt(world, st.x, st.z);
      if (st.y <= gh0) { st.y = gh0; st.onGround = true; st.vy = 0; }
      if (st.crashT <= 0 && !st.dead) respawn(st, world, ev);
      st.t += DT;
      return;
    }
    if (st.dead || st.finished) { st.t += DT; return; }

    var steer = (inp.left ? 1 : 0) - (inp.right ? 1 : 0);

    if (st.onGround) {
      st.groundT += DT;
      var nrm = normalAt(world, st.x, st.z);

      /* forward, projected onto the slope under the wheels */
      var fx0 = Math.sin(st.yaw), fz0 = Math.cos(st.yaw);
      var dot = fx0 * nrm.x + fz0 * nrm.z;
      var f = { x: fx0 - nrm.x * dot, y: -dot * nrm.y, z: fz0 - nrm.z * dot };
      var fl = Math.sqrt(f.x * f.x + f.y * f.y + f.z * f.z) || 1;
      f.x /= fl; f.y /= fl; f.z /= fl;

      speed = st.vx * f.x + st.vy * f.y + st.vz * f.z;
      speed += (-GRAV * f.y) * DT;

      if (inp.pedal && speed < VCAP * S.vcap) {
        speed += PEDAL_A * S.pedal * (speed < 6 ? 1.6 : 1) * DT;
      }
      if (inp.brake) {
        speed -= BRAKE_A * S.brake * st.grip * DT;
        if (speed < 0) speed = 0;
      }

      var offT = st.trailD > world.wid[st.trailIdx];
      st.offTrail = offT;
      var onRocks = world.rough[st.trailIdx] === 1 && st.trailD < world.wid[st.trailIdx];
      st.chatter = onRocks ? Math.min(1, Math.abs(speed) / 14) : Math.max(0, (st.chatter || 0) - DT * 3);
      var drag = DRAG * (offT ? 1 + 1.5 * S.rough : 1) * (onRocks ? 1.5 : 1);
      speed -= speed * Math.abs(speed) * drag * DT;
      speed -= Math.sign(speed) * Math.min(Math.abs(speed),
        ROLL * S.roll * (offT ? 1 + 1.3 * S.rough : 1) * (onRocks ? 1.8 : 1) * DT * 10);

      /* steering: slower at speed, and the banking under you helps carve */
      var bankHelp = 1 + Math.abs(world.bank[st.trailIdx]) * 0.9;
      st.yaw += steer * STEER_RATE * S.steer * st.grip * bankHelp /
        (1 + Math.abs(speed) / 17) * DT * (speed >= 0 ? 1 : -1);
      st.lean += ((-steer * Math.min(1, Math.abs(speed) / 12) * 0.5) - st.lean) * Math.min(1, 9 * DT);
      st.pitch += (0 - st.pitch) * Math.min(1, 8 * DT);

      st.vx = f.x * speed; st.vy = f.y * speed; st.vz = f.z * speed;

      /* --- bunny hop: hold to preload, release to pop --- */
      if (inp.hop && st.hopCd <= 0) {
        st.hopCharge = Math.min(1, st.hopCharge + DT / CHARGE_T);
      } else if (st.hopCharge > 0.03 && st.hopCd <= 0) {
        var pop = (HOP_MIN + (HOP_MAX - HOP_MIN) * st.hopCharge) * S.hop;
        st.vy += pop;
        st.hopCharge = 0;
        st.hopCd = 0.28;
        st.onGround = false;
        st.airT = 0;
        beginAir(st, ev, "hop");
      } else if (!inp.hop) {
        st.hopCharge = 0;
      }

      st.x += st.vx * DT; st.z += st.vz * DT;
      var hNew = heightAt(world, st.x, st.z);
      var yBal = st.y + st.vy * DT;
      if (!st.onGround) {
        st.y = yBal;                                  /* just popped */
      } else if (hNew < yBal - 0.24) {
        st.onGround = false;
        st.airT = 0;
        st.y = yBal;
        /* pumping the lip: a hop released right at the takeoff adds height */
        if (st.hopCharge > 0.25) { st.vy += 1.6 * st.hopCharge; st.hopCharge = 0; }
        beginAir(st, ev, "lip");
      } else {
        st.y = hNew;
      }
      st.wheelSpin += speed * DT / 0.34;
      if (speed > st.topSpeed) st.topSpeed = speed;

    } else {
      /* --- airborne: this is where the game is played --- */
      st.airT += DT;
      st.airTotal += DT;
      st.groundT = 0;
      st.vy -= GRAV * DT;

      /* spin (A/D), flip (W/S), whip (Q/E) — rates wind up, they don't snap */
      var spinTarget = steer * SPIN_RATE;
      st.spinV += (spinTarget - st.spinV) * Math.min(1, 4.5 * DT);
      st.spin += st.spinV * DT;

      var flipIn = (inp.flipBack ? 1 : 0) - (inp.flipFwd ? 1 : 0);
      var flipTarget = flipIn * FLIP_RATE;
      st.flipV += (flipTarget - st.flipV) * Math.min(1, 6 * DT);
      st.flip += st.flipV * DT;

      var whipIn = (inp.whipL ? 1 : 0) - (inp.whipR ? 1 : 0);
      var whipTarget = whipIn * WHIP_MAX;
      st.whip += (whipTarget - st.whip) * Math.min(1, (whipIn ? 9 : 6) * DT);
      if (Math.abs(st.whip) > st.whipMax) st.whipMax = Math.abs(st.whip);

      /* the bike also drifts the way it is pointing, a little */
      var turn = st.spinV * 0.055 * DT;
      var cs = Math.cos(turn), sn = Math.sin(turn);
      var nvx = st.vx * cs + st.vz * sn;
      var nvz = -st.vx * sn + st.vz * cs;
      st.vx = nvx; st.vz = nvz;

      st.lean += ((-steer * 0.3) - st.lean) * Math.min(1, 5 * DT);

      st.x += st.vx * DT; st.y += st.vy * DT; st.z += st.vz * DT;

      var hg = heightAt(world, st.x, st.z);
      if (st.y <= hg) {
        st.y = hg;
        land(st, world, ev);
      }
    }

    /* --- solid props --- */
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
            var rr = pr.r * 0.55 + 0.42;
            if (dx * dx + dz * dz < rr * rr && st.y < pr.y + 3.2) {
              if (speed > 7.5) {
                bail(st, pr.type === "boulder" ? "rock" : "tree", 17 + Math.min(11, speed * 0.5), ev);
              } else {
                var dl = Math.sqrt(dx * dx + dz * dz) || 1;
                st.x -= (dx / dl) * 0.32; st.z -= (dz / dl) * 0.32;
                st.vx *= 0.2; st.vz *= 0.2;
                ev.push({ t: "bump", what: pr.type, speed: speed });
              }
              break;
            }
          }
        }
      }
    }

    /* --- trail progress --- */
    var tr = world.trail;
    var best = st.trailIdx, bestD = dist2(tr[best], st);
    for (i = st.trailIdx + 1; i < Math.min(world.trailN, st.trailIdx + 18); i++) {
      var d2 = dist2(tr[i], st);
      if (d2 < bestD) { bestD = d2; best = i; }
    }
    st.trailIdx = best;
    st.trailD = Math.sqrt(bestD);

    for (i = world.gates.length - 1; i >= 0; i--) {
      if (world.gates[i] <= st.trailIdx) {
        if (world.gates[i] > st.respawnIdx) {
          st.respawnIdx = world.gates[i];
          st.gatesHit++;
          st.health = Math.min(st.maxHealth, st.health + 12);
          ev.push({ t: "gate", n: st.gatesHit });
        }
        break;
      }
    }

    /* --- features cleared --- */
    var feats = world.features;
    while (st.featPtr < feats.length && feats[st.featPtr].i1 < st.trailIdx - 4) st.featPtr++;
    for (i = st.featPtr; i < feats.length && i < st.featPtr + 5; i++) {
      var ft = feats[i];
      if (ft.done) continue;
      if (st.trailIdx > ft.i1) {
        ft.done = true;
        st.featHit++;
        if (ft.big) st.featBigHit++;
      }
    }

    /* --- off the edge of the world --- */
    if (Math.abs(st.x) > X_HALF - 6 || st.z < world.z0 + 8) {
      bail(st, "lost", 8, ev);
    }

    /* --- the bottom --- */
    if (!st.finished && st.trailIdx >= world.finishIdx) {
      st.finished = true;
      st.finishT = st.t + DT;
      st.style += 500 + st.gatesHit * 40;           /* finish bonus */
      ev.push({ t: "finish" });
    }
    st.t += DT;
  }

  function beginAir(st, ev, why) {
    st.spin = 0; st.flip = 0; st.whip = 0; st.whipMax = 0;
    st.spinV = 0; st.flipV = 0;
    st.airVel = Math.sqrt(st.vx * st.vx + st.vz * st.vz);
    ev.push({ t: "takeoff", why: why });
  }

  function land(st, world, ev) {
    var nl = normalAt(world, st.x, st.z);
    var impact = -(st.vx * nl.x + st.vy * nl.y + st.vz * nl.z);
    var airT = st.airT;
    var tol = st.assist ? TOL.assist : TOL.normal;

    /* rotation has to come back round, or you land on your ear */
    var spinErr = Math.max(0, Math.abs(wrapPi(st.spin)) - FREE_ROT);
    var flipErr = Math.max(0, Math.abs(wrapPi(st.flip)) - FREE_ROT * 0.5);
    var whipErr = Math.abs(st.whip);

    var rotOK = spinErr < tol && flipErr < tol * 1.1 && whipErr < tol * 1.3;
    /* landing on a downslope that matches your fall is what saves big drops */
    var slopeBonus = clamp((1 - nl.y) * 26, 0, 9);
    var impactOK = impact < (CRASH_IMPACT + slopeBonus) * (1 + (st.stats ? st.stats.landSoft : 0));

    if (!rotOK && airT > 0.18) {
      bail(st, "rotation", 15 + Math.min(12, impact * 0.6), ev);
      st.onGround = true;
      return;
    }
    if (!impactOK) {
      bail(st, "landing", 19 + Math.min(15, impact - CRASH_IMPACT), ev);
      st.onGround = true;
      return;
    }

    /* stuck it: keep the tangent velocity, score the trick */
    if (airT > 0.18) scoreTrick(st, airT, ev);

    st.yaw += wrapPi(st.spin);
    var vn = st.vx * nl.x + st.vy * nl.y + st.vz * nl.z;
    st.vx -= nl.x * vn; st.vy -= nl.y * vn; st.vz -= nl.z * vn;

    var hardness = impact / CRASH_IMPACT;
    if (hardness > 0.62) {
      var keep = clamp(1 - (hardness - 0.62) * 0.55, 0.55, 1);
      st.vx *= keep; st.vy *= keep; st.vz *= keep;
      ev.push({ t: "land", q: "hard", airT: airT });
    } else {
      ev.push({ t: "land", q: "clean", airT: airT });
    }

    st.spin = st.flip = st.whip = st.whipMax = 0;
    st.spinV = st.flipV = 0;
    st.onGround = true;
    st.airT = 0;
  }

  function respawn(st, world, ev) {
    var rp = world.trail[st.respawnIdx];
    var rq = world.trail[Math.min(world.trailN - 1, st.respawnIdx + 2)];
    st.x = rp.x; st.z = rp.z; st.y = rp.y + 0.05;
    st.yaw = Math.atan2(rq.x - rp.x, rq.z - rp.z);
    st.vx = st.vy = st.vz = 0;
    st.onGround = true;
    st.trailIdx = st.respawnIdx;
    st.lean = st.pitch = 0;
    st.invuln = 0.8;
    st.crashKind = null;
    ev.push({ t: "respawn" });
  }

  function dist2(p, st) {
    var dx = p.x - st.x, dz = p.z - st.z;
    return dx * dx + dz * dz;
  }

  /* Run summary handed to objectives and the results screen. */
  function summarise(st, world) {
    return {
      finished: st.finished, dead: st.dead,
      finishT: st.finishT || st.t,
      style: Math.round(st.style),
      bails: st.bails, tricks: st.tricks, perfects: st.perfects,
      combo: st.comboBest, airTotal: st.airTotal,
      topSpeed: st.topSpeed * 3.6,
      health: st.health,
      features: world.features.length, featHit: st.featHit, featBigHit: st.featBigHit,
      progress: Math.min(1, st.trailIdx / world.finishIdx)
    };
  }

  /* ================= career map =================
     Five stages down the country. Each stage offers a few nodes; clear any
     one of them to open the next stage, clear them all for the badge. */

  var STAGE_PLAN = [
    { name: "Rookie Ridge", pool: ["nyika"], mods: ["none", "none", "bigair"], len: 1150, tier: 1 },
    { name: "Into the Miombo", pool: ["miombo", "nyika"], mods: ["none", "trees", "sprint"], len: 1350, tier: 2 },
    { name: "Sand & Sun", pool: ["kalahari", "nyika"], mods: ["bigair", "none", "rain"], len: 1500, tier: 3 },
    { name: "The Gorge", pool: ["batoka", "miombo"], mods: ["steep", "none", "marathon"], len: 1650, tier: 4 },
    { name: "Mafinga Crown", pool: ["mafinga", "batoka"], mods: ["night", "steep", "bigair"], len: 1900, tier: 5 }
  ];

  var OBJ_PLAN = [
    ["finish", "style", "clean"],
    ["style", "clean", "tricks"],
    ["air", "style", "time"],
    ["clean", "style", "time"],
    ["style", "tricks", "clean"]
  ];

  function objectiveTarget(kind, tier, spec, rng) {
    switch (kind) {
      case "style": return Math.round((1500 + tier * 1100 + rng() * 500) / 100) * 100;
      case "clean": return Math.max(0, 3 - tier);
      case "time": return Math.round(spec.length / (13.4 + tier * 0.55) / 5) * 5;
      case "air": return Math.round(5 + tier * 2.5);
      case "tricks": return 3 + tier * 2;
      default: return 0;
    }
  }

  function makeCareer(careerSeed) {
    var rng = mulberry32((careerSeed >>> 0) || 20260101);
    var stages = [];
    for (var s = 0; s < STAGE_PLAN.length; s++) {
      var plan = STAGE_PLAN[s];
      var nodes = [];
      for (var nI = 0; nI < 3; nI++) {
        var biome = plan.pool[nI % plan.pool.length];
        var mod = plan.mods[nI];
        var seed = (Math.floor(rng() * 0x7FFFFFFF)) >>> 0;
        var spec = makeSpec({ seed: seed, biome: biome, modifier: mod, length: plan.len });
        var objKind = OBJ_PLAN[s][nI];
        var target = objectiveTarget(objKind, plan.tier, spec, rng);
        nodes.push({
          id: "s" + s + "n" + nI,
          stage: s, index: nI,
          seed: seed, biome: biome, modifier: mod,
          length: spec.length, tier: plan.tier,
          objective: objKind, target: target,
          rep: 120 * plan.tier + (objKind === "finish" ? 0 : 60),
          code: codeFromSeed(seed)
        });
      }
      stages.push({ index: s, name: plan.name, tier: plan.tier, nodes: nodes });
    }
    return { seed: careerSeed, stages: stages };
  }

  function objectiveLabel(node) {
    var o = OBJECTIVES[node.objective];
    return o ? o.icon + "  " + o.label(node.target) : "Reach the bottom";
  }

  function objectiveMet(node, summary) {
    var o = OBJECTIVES[node.objective];
    return o ? !!o.check(summary, node.target) : !!summary.finished;
  }

  /* Objective progress 0..1, for the live HUD readout. */
  function objectiveProgress(node, st) {
    switch (node.objective) {
      case "style": return clamp(st.style / node.target, 0, 1);
      case "tricks": return clamp(st.tricks / node.target, 0, 1);
      case "air": return clamp(st.airTotal / node.target, 0, 1);
      case "clean": return st.bails <= node.target ? 1 : 0;
      case "time": return st.t <= node.target ? 1 : 0;
      default: return 0;
    }
  }

  /* ================= trail codes =================
     A run is one number, so a run is one short code you can read out loud. */

  var ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";   /* no 0/O/1/I */

  function codeFromSeed(seed) {
    var v = (seed >>> 0), out = "";
    for (var i = 0; i < 6; i++) { out = ALPHABET[v % 32] + out; v = Math.floor(v / 32); }
    return out.slice(0, 3) + "-" + out.slice(3);
  }

  function seedFromCode(code) {
    var s = String(code || "").toUpperCase().replace(/[^0-9A-Z]/g, "");
    if (!s.length) return null;
    /* anything the player types is a valid mountain — unknown letters fold in */
    var v = 0;
    for (var i = 0; i < s.length; i++) {
      var idx = ALPHABET.indexOf(s[i]);
      if (idx < 0) idx = s.charCodeAt(i) % 32;
      v = (v * 32 + idx) >>> 0;
    }
    return v >>> 0;
  }

  /* The daily mountain: same for everyone, new at midnight local time. */
  function dailySeed(date) {
    var d = date || new Date();
    return ((d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate()) * 2654435761) >>> 0;
  }

  /* ================= exports ================= */

  var API = {
    BIOMES: BIOMES, BIOME_ORDER: BIOME_ORDER,
    MODIFIERS: MODIFIERS, OBJECTIVES: OBJECTIVES, STAGE_PLAN: STAGE_PLAN,
    DT: DT, MAX_HEALTH: MAX_HEALTH, WHIP_MAX: WHIP_MAX, CHARGE_T: CHARGE_T,
    GRID_STEP: GRID_STEP, TRAIL_DS: TRAIL_DS, X_HALF: X_HALF,
    makeSpec: makeSpec, buildWorld: buildWorld,
    newRider: newRider, stepRider: stepRider, summarise: summarise,
    heightAt: heightAt, normalAt: normalAt, trailDistAt: trailDistAt,
    makeCareer: makeCareer, objectiveLabel: objectiveLabel,
    objectiveMet: objectiveMet, objectiveProgress: objectiveProgress,
    codeFromSeed: codeFromSeed, seedFromCode: seedFromCode, dailySeed: dailySeed,
    fmtClock: fmtClock, mulberry32: mulberry32, vnoise: vnoise, clamp: clamp, wrapPi: wrapPi
  };

  if (typeof module !== "undefined" && module.exports) module.exports = API;
  if (typeof window !== "undefined") window.TRIAL = API;
})();
