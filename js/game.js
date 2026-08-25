/* ==========================================================================
   ZAMBIA RUSH — the Zambia Bikes downhill game
   A Descenders-inspired 2D physics racer set in Zambian landscapes.

   Design promises (see safety.html):
   - no chat, no messages, no accounts, no ads, no purchases
   - opponents are GHOSTS: recorded runs of Armand & Arthur (simulated
     riders) and pasteable "Ghost Codes" holding only positions + a name
   - deterministic seeded tracks so every rider races the same hills
   ========================================================================== */

(function () {
  "use strict";

  /* ================= deterministic PRNG ================= */

  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ================= track definitions ================= */

  var TRACKS = {
    miombo: {
      id: "miombo", name: "Miombo Meander", level: "easy", levelLabel: "Easy Rider",
      seed: 20260912, length: 40000, slope: 0.055, hills: 0.8,
      desc: "Rolling forest singletrack",
      theme: {
        sky: ["#BFE8F2", "#E8F7E0", "#FFF6D9"], sun: "#FFFBE6",
        farHill: "#A7CFAE", midHill: "#5E9B6B", silTree: "#2F6E45",
        dirtTop: "#7A5230", dirtBot: "#4A3115", grass: "#2F8F52", grassDark: "#1F6B3B",
        deco: "#1C4D30", decoAlt: "#2F6E45", mist: null
      }
    },
    baobab: {
      id: "baobab", name: "Baobab Ridge", level: "trail", levelLabel: "Trail Star",
      seed: 20261010, length: 50000, slope: 0.068, hills: 1.05,
      desc: "Sunset savanna with big kickers",
      theme: {
        sky: ["#FFE9A8", "#F7B733", "#E8791D"], sun: "#FFF3C4",
        farHill: "#C97A2B", midHill: "#8A4A12", silTree: "#5A3812",
        dirtTop: "#8A5324", dirtBot: "#43290F", grass: "#C89A3F", grassDark: "#8A5A00",
        deco: "#43290F", decoAlt: "#5A3812", mist: null
      }
    },
    falls: {
      id: "falls", name: "Mosi Falls Drop", level: "hero", levelLabel: "Downhill Hero",
      seed: 20260926, length: 60000, slope: 0.082, hills: 1.3,
      desc: "Steep canyon by the thundering falls",
      theme: {
        sky: ["#CFEFF4", "#9FDCE2", "#8AD1C4"], sun: "#F6FFF0",
        farHill: "#4E8E80", midHill: "#2E6E62", silTree: "#1F5348",
        dirtTop: "#5C5138", dirtBot: "#332C1C", grass: "#3E7C4F", grassDark: "#2A5A38",
        deco: "#17362B", decoAlt: "#1F5348", mist: "#F3FBFA"
      }
    }
  };
  var TRACK_ORDER = ["miombo", "baobab", "falls"];

  /* ================= terrain ================= */

  var STEP = 4;              /* heightmap resolution in px */
  var RUNOUT = 2600;         /* flat-ish ground after the finish line */

  function buildTrack(def) {
    var rng = mulberry32(def.seed);
    var n = Math.ceil((def.length + RUNOUT) / STEP) + 2;
    var hm = new Float32Array(n);
    var hs = def.hills;

    var oct = [
      { a: 100 * hs, w: 1600, p: rng() * 6.28 },
      { a: 40 * hs, w: 700, p: rng() * 6.28 },
      { a: 14 * hs, w: 320, p: rng() * 6.28 },
      { a: 5, w: 150, p: rng() * 6.28 }
    ];

    /* jump features: gaussian kickers + tanh drop-offs */
    var feats = [];
    var fx = 1400 + rng() * 800;
    while (fx < def.length - 1500) {
      if (rng() < 0.62) {
        feats.push({ type: "kick", p: fx, a: (45 + rng() * 45) * hs, w: 60 + rng() * 40 });
      } else {
        feats.push({ type: "drop", p: fx, a: (55 + rng() * 70) * hs, w: 40 + rng() * 30 });
      }
      fx += 900 + rng() * 900;
    }

    for (var i = 0; i < n; i++) {
      var x = i * STEP;
      var ramp = Math.min(1, x / 750);              /* gentle start */
      var h = def.slope * x;
      for (var o = 0; o < 4; o++) {
        h += ramp * oct[o].a * Math.sin((x * 2 * Math.PI) / oct[o].w + oct[o].p);
      }
      for (var f = 0; f < feats.length; f++) {
        var ft = feats[f], d = x - ft.p;
        if (d > -500 && d < 500) {
          if (ft.type === "kick") h -= ft.a * Math.exp(-(d * d) / (ft.w * ft.w));
          else h += ft.a * 0.5 * (1 + Math.tanh(d / ft.w));
        } else if (ft.type === "drop" && d >= 500) {
          h += ft.a;                                  /* settled after the ledge */
        }
      }
      hm[i] = h;
    }

    /* clip sustained climbs so young riders can always pedal out */
    var MAX_CLIMB = 0.55 * STEP;
    for (i = 1; i < n; i++) if (hm[i] < hm[i - 1] - MAX_CLIMB) hm[i] = hm[i - 1] - MAX_CLIMB;
    /* light smoothing, twice */
    for (var pass = 0; pass < 2; pass++) {
      for (i = 1; i < n - 1; i++) hm[i] = (hm[i - 1] + hm[i] * 2 + hm[i + 1]) / 4;
    }

    var track = {
      def: def, hm: hm, n: n, finishX: def.length,
      coins: [], decos: [], feats: feats
    };

    /* coins: arcs over kickers + lines elsewhere */
    var cx = 900;
    while (cx < def.length - 800) {
      var overKick = null;
      for (f = 0; f < feats.length; f++) {
        if (feats[f].type === "kick" && Math.abs(feats[f].p - cx) < 260) { overKick = feats[f]; break; }
      }
      var count = 5, spacing = 46;
      for (var c = 0; c < count; c++) {
        var px = cx + c * spacing;
        var lift = overKick ? 70 + 55 * Math.sin((c / (count - 1)) * Math.PI) : 62;
        track.coins.push({ x: px, y: groundYOf(track, px) - lift });
      }
      cx += 520 + rng() * 620;
    }

    /* decorations */
    var themes = {
      miombo: ["treeM", "treeM", "treeM", "grass", "rock", "bush"],
      baobab: ["baobab", "acacia", "grass", "grass", "rock", "termite"],
      falls: ["palm", "treeM", "grass", "rock", "bush", "fern"]
    };
    var pool = themes[def.id] || themes.miombo;
    var dx = 300;
    while (dx < def.length + RUNOUT - 300) {
      var type = pool[Math.floor(rng() * pool.length)];
      track.decos.push({ type: type, x: dx, s: 0.7 + rng() * 0.7, fl: rng() < 0.5 });
      dx += 140 + rng() * 340;
    }
    /* rare wildlife, always behind the action */
    var animals = { miombo: ["antelope", "eagle"], baobab: ["giraffe", "elephant", "zebra"], falls: ["antelope", "eagle"] };
    var ax = 2600;
    var apool = animals[def.id];
    while (ax < def.length - 1000) {
      track.decos.push({ type: apool[Math.floor(rng() * apool.length)], x: ax, s: 0.9 + rng() * 0.4, fl: rng() < 0.5 });
      ax += 3400 + rng() * 2600;
    }
    track.decos.sort(function (a, b) { return a.x - b.x; });
    return track;
  }

  function groundYOf(track, x) {
    if (x < 0) x = 0;
    var i = x / STEP;
    var i0 = Math.floor(i);
    if (i0 >= track.n - 1) i0 = track.n - 2;
    var t = i - i0;
    return track.hm[i0] * (1 - t) + track.hm[i0 + 1] * t;
  }

  function slopeAngleOf(track, x) {
    var e = 6;
    var dh = groundYOf(track, x + e) - groundYOf(track, x - e);
    return Math.atan2(dh, 2 * e);
  }

  /* ================= physics ================= */

  var DT = 1 / 60;
  var G = 1500;
  var PEDAL = 650;
  var DRAG_K = 0.00045;
  var ROLL = 25;
  var BRAKE = 1600;
  var TUCK_G = 950;
  var FLIP_VEL = 5.4;
  var FLIP_ACC = 26;
  var ASSIST = 1.7;

  function newRider(track) {
    var x = 120;
    return {
      x: x, y: groundYOf(track, x), vx: 0, vy: 0,
      rot: slopeAngleOf(track, x), angVel: 0,
      onGround: true, airTime: 0, airRot: 0,
      crashT: 0, crashes: 0,
      t: 0, finished: false, finishT: 0,
      score: 0, coinCount: 0, flipCount: 0,
      coinPtr: 0, wheelPhase: 0, power: 1, noCrash: false
    };
  }

  function angleDiff(a, b) {
    var d = a - b;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return d;
  }

  function lerpAngle(a, b, t) {
    return a + angleDiff(b, a) * Math.min(1, t);
  }

  function approach(v, target, delta) {
    if (v < target) return Math.min(target, v + delta);
    return Math.max(target, v - delta);
  }

  /* One fixed step. `inp` = {pedal, brake, left, right}. `ev` collects
     effect events (sounds/toasts); scoring happens right here so AI runs
     score identically. Returns nothing; mutates st. */
  function stepRider(st, inp, track, ev, taken) {
    var pedal = inp.pedal && !st.finished;
    var a, s;

    if (st.crashT > 0) {
      st.crashT -= DT;
      pedal = false;
      st.rot += 8.5 * DT;
      if (st.crashT <= 0 && st.onGround) st.rot = slopeAngleOf(track, st.x);
    }

    if (st.onGround) {
      a = slopeAngleOf(track, st.x);
      s = st.vx * Math.cos(a) + st.vy * Math.sin(a);
      s += G * Math.sin(a) * DT;
      if (pedal && st.crashT <= 0) s += PEDAL * st.power * (s < 260 ? 1.35 : 1) * DT;
      if (inp.brake && st.crashT <= 0) s = Math.max(0, s - BRAKE * DT);
      if (st.crashT > 0) s *= Math.max(0, 1 - 3 * DT);
      s -= s * Math.abs(s) * DRAG_K * DT;
      s -= Math.sign(s) * Math.min(Math.abs(s), ROLL * DT);

      st.vx = s * Math.cos(a);
      st.vy = s * Math.sin(a);
      st.x += st.vx * DT;

      var ny = groundYOf(track, st.x);
      var projY = st.y + st.vy * DT;
      if (ny - projY > 2) {
        st.onGround = false;
        st.y = projY;
        st.airTime = 0; st.airRot = 0;
        ev.push({ t: "takeoff" });
      } else {
        st.y = ny;
        if (st.crashT <= 0) st.rot = lerpAngle(st.rot, a, 18 * DT);
      }
      st.wheelPhase += s * DT / 26;
    } else {
      var g = G + (inp.brake && st.crashT <= 0 ? TUCK_G : 0);
      st.vy += g * DT;
      st.x += st.vx * DT;
      st.y += st.vy * DT;
      st.airTime += DT;

      if (st.crashT <= 0) {
        var target = inp.left ? -FLIP_VEL : (inp.right ? FLIP_VEL : 0);
        if (target !== 0) {
          st.angVel = approach(st.angVel, target, FLIP_ACC * DT);
        } else {
          st.angVel = approach(st.angVel, 0, 16 * DT);
          var la = slopeAngleOf(track, st.x + st.vx * 0.35);
          st.rot = lerpAngle(st.rot, la, ASSIST * DT);
        }
        st.rot += st.angVel * DT;
        st.airRot += st.angVel * DT;
      }

      var gy = groundYOf(track, st.x);
      if (st.y >= gy) {
        st.y = gy;
        a = slopeAngleOf(track, st.x);
        s = st.vx * Math.cos(a) + st.vy * Math.sin(a);
        var diff = Math.abs(angleDiff(st.rot, a));
        var bigAir = st.airTime > 1.2;
        var flips = Math.min(3, Math.floor(Math.abs(st.airRot) / 5.2));
        var crashed = false;

        if (st.crashT > 0) {
          s = Math.min(s * 0.4, 160);
        } else if (diff < 0.32) {
          s = s * 1.05 + 40;
          st.score += 50;
          ev.push({ t: "land", q: "perfect" });
        } else if (diff < 0.95) {
          ev.push({ t: "land", q: "clean" });
        } else if (diff < 1.4 || st.noCrash) {
          s *= 0.72;
          ev.push({ t: "land", q: "sloppy" });
        } else {
          crashed = true;
          st.crashT = 1.15;
          st.crashes++;
          s = Math.min(s * 0.25, 140);
          ev.push({ t: "crash" });
        }

        if (!crashed && st.crashT <= 0) {
          if (flips > 0) {
            st.flipCount += flips;
            st.score += 150 * flips;
            ev.push({ t: "flip", n: flips, dir: st.airRot < 0 ? "back" : "front" });
          }
          if (bigAir) { st.score += 75; ev.push({ t: "bigair" }); }
          st.rot = a;
        }

        st.onGround = true;
        st.vx = s * Math.cos(a);
        st.vy = s * Math.sin(a);
        st.airRot = 0;
      }
    }

    /* coins */
    var coins = track.coins;
    while (st.coinPtr < coins.length && coins[st.coinPtr].x < st.x - 80) st.coinPtr++;
    for (var ci = st.coinPtr; ci < coins.length && ci < st.coinPtr + 8; ci++) {
      if (taken[ci]) continue;
      var co = coins[ci];
      if (Math.abs(co.x - st.x) < 36 && Math.abs(co.y - st.y) < 52) {
        taken[ci] = 1;
        st.coinCount++;
        st.score += 25;
        ev.push({ t: "coin" });
      }
    }

    if (!st.finished && st.x >= track.finishX) {
      st.finished = true;
      st.finishT = st.t + DT;
      ev.push({ t: "finish" });
    }
    st.t += DT;
  }

  /* ================= AI riders (Armand & Arthur ghosts) ================= */

  function simulateAI(track, style) {
    var st = newRider(track);
    st.power = style.power;
    st.noCrash = true;
    var rng = mulberry32(track.def.seed ^ style.aiSeed);
    var taken = new Array(track.coins.length);
    var samples = [];
    var ev = [];
    var step = 0;
    var planFlip = 0;

    while (!st.finished && st.t < 300) {
      var inp = { pedal: true, brake: false, left: false, right: false };
      if (!st.onGround && st.crashT <= 0) {
        var heightAbove = groundYOf(track, st.x) - st.y;
        if (planFlip === 0 && style.flipper && st.airTime < 0.1 && st.vy < -420 && rng() < 0.75) {
          planFlip = rng() < 0.7 ? -1 : 1;   /* mostly backflips */
        }
        if (planFlip !== 0 && heightAbove > 120 && Math.abs(st.airRot) < 5.6) {
          inp.left = planFlip < 0; inp.right = planFlip > 0;
        } else {
          planFlip = planFlip !== 0 && Math.abs(st.airRot) >= 5.6 ? 0 : planFlip;
          var la = slopeAngleOf(track, st.x + st.vx * 0.3);
          var d = angleDiff(st.rot, la);
          inp.left = d > 0.14; inp.right = d < -0.14;
          if (style.tucker && heightAbove > 90 && Math.abs(d) < 0.3) inp.brake = true;
        }
      } else {
        planFlip = 0;
      }
      ev.length = 0;
      stepRider(st, inp, track, ev, taken);
      if (step % 4 === 0) samples.push([Math.round(st.x), Math.round(st.y), Math.round(st.rot * 100)]);
      step++;
    }
    samples.push([Math.round(st.x), Math.round(st.y), Math.round(st.rot * 100)]);
    return {
      name: style.name, color: style.color,
      samples: samples, timeMs: Math.round(st.finishT * 1000),
      score: st.score
    };
  }

  var AI_STYLES = {
    armand: { name: "Armand", color: "#1F7A48", power: 1.0, flipper: false, tucker: true, aiSeed: 11 },
    arthur: { name: "Arthur", color: "#E8791D", power: 0.94, flipper: true, tucker: false, aiSeed: 23 }
  };

  /* ================= ghost codes ================= */

  function packGhost(g) {
    var out = [];
    var px = 0, py = 0, pr = 0;
    for (var i = 0; i < g.samples.length; i++) {
      var s = g.samples[i];
      out.push((s[0] - px) + "," + (s[1] - py) + "," + (s[2] - pr));
      px = s[0]; py = s[1]; pr = s[2];
    }
    var payload = JSON.stringify({ v: 1, n: g.name, t: g.track, ms: g.timeMs, s: out.join(";") });
    return "ZRG1." + btoa(payload);
  }

  function sanitizeName(n) {
    var s = String(n || "").replace(/[^A-Za-z0-9 _-]/g, "").trim().slice(0, 12);
    return s || "Rider";
  }

  function unpackGhost(code) {
    try {
      code = String(code || "").trim();
      if (code.indexOf("ZRG1.") !== 0) return null;
      var payload = JSON.parse(atob(code.slice(5)));
      if (!payload || payload.v !== 1) return null;
      if (!TRACKS[payload.t]) return null;
      var ms = Number(payload.ms);
      if (!isFinite(ms) || ms < 3000 || ms > 900000) return null;
      var parts = String(payload.s).split(";");
      if (parts.length < 10 || parts.length > 30000) return null;
      var samples = [];
      var px = 0, py = 0, pr = 0;
      for (var i = 0; i < parts.length; i++) {
        var trio = parts[i].split(",");
        if (trio.length !== 3) return null;
        px += Number(trio[0]); py += Number(trio[1]); pr += Number(trio[2]);
        if (!isFinite(px) || !isFinite(py) || !isFinite(pr)) return null;
        samples.push([px, py, pr]);
      }
      return { name: sanitizeName(payload.n), color: "#8E44AD", track: payload.t, timeMs: Math.round(ms), samples: samples };
    } catch (e) { return null; }
  }

  function ghostPosAt(ghost, tSec) {
    if (!ghost.samples || !ghost.samples.length) return { x: 0, y: 0, rot: 0, done: true, empty: true };
    var idx = tSec * 15;                     /* samples at 15 Hz */
    var i0 = Math.floor(idx);
    var last = ghost.samples.length - 1;
    if (i0 >= last) {
      var end = ghost.samples[last];
      return { x: end[0], y: end[1], rot: end[2] / 100, done: true };
    }
    var t = idx - i0;
    var A = ghost.samples[i0], B = ghost.samples[i0 + 1];
    return {
      x: A[0] * (1 - t) + B[0] * t,
      y: A[1] * (1 - t) + B[1] * t,
      rot: (A[2] * (1 - t) + B[2] * t) / 100,
      done: false
    };
  }

  /* ================= exports for tests / debugging ================= */

  var ENGINE = {
    TRACKS: TRACKS, TRACK_ORDER: TRACK_ORDER,
    buildTrack: buildTrack, groundYOf: groundYOf, slopeAngleOf: slopeAngleOf,
    newRider: newRider, stepRider: stepRider, simulateAI: simulateAI,
    AI_STYLES: AI_STYLES, packGhost: packGhost, unpackGhost: unpackGhost,
    sanitizeName: sanitizeName, ghostPosAt: ghostPosAt, DT: DT
  };

  if (typeof module !== "undefined" && module.exports) module.exports = ENGINE;
  if (typeof window !== "undefined") window.ZambiaRush = ENGINE;

  /* ======================================================================
     Everything below is browser-only: rendering, input, UI.
     ====================================================================== */

  if (typeof document === "undefined") return;
  var canvas = document.getElementById("game-canvas");
  if (!canvas) return;

  var ctx = canvas.getContext("2d");
  var W = canvas.width, H = canvas.height;

  /* ---------- storage ---------- */

  function lsGet(k, fallback) {
    try {
      var v = localStorage.getItem(k);
      return v == null ? fallback : JSON.parse(v);
    } catch (e) { return fallback; }
  }
  function lsSet(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* full/private */ }
  }

  /* stored data is untrusted: validate shapes so one bad entry can't kill the game */
  function validGhostShape(g) {
    return g && typeof g === "object" && Array.isArray(g.samples) && g.samples.length > 1 &&
      isFinite(Number(g.timeMs));
  }

  var profile = lsGet("zr_profile", { name: "", jersey: "#1F7A48" });
  if (!profile || typeof profile !== "object") profile = { name: "", jersey: "#1F7A48" };
  var bests = lsGet("zr_best", {});          /* trackId -> timeMs */
  if (!bests || typeof bests !== "object" || Array.isArray(bests)) bests = {};
  var scores = lsGet("zr_scores", {});       /* trackId -> [{name,timeMs,score}] */
  if (!scores || typeof scores !== "object" || Array.isArray(scores)) scores = {};
  var friends = lsGet("zr_friends", []);     /* [{name,track,timeMs,samples}] */
  if (!Array.isArray(friends)) friends = [];
  friends = friends.filter(function (f) { return validGhostShape(f) && TRACKS[f.track]; });
  var muted = lsGet("zr_muted", false);
  var ghostsOn = lsGet("zr_ghoston", true);

  /* ---------- audio (tiny synth) ---------- */

  var AC = null, masterGain = null;
  function audio() {
    if (muted) return null;
    if (!AC) {
      try {
        AC = new (window.AudioContext || window.webkitAudioContext)();
        masterGain = AC.createGain();
        masterGain.gain.value = 0.16;
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
    perfect: function () { tone(660, 0.1, "triangle"); tone(990, 0.14, "triangle", 0.07); },
    land: function () { tone(150, 0.1, "sine", 0, 70); },
    crash: function () { tone(300, 0.35, "sawtooth", 0, 60); },
    flip: function () { tone(520, 0.16, "triangle", 0, 900); },
    count: function (hi) { tone(hi ? 880 : 440, 0.14, "square"); },
    finish: function () { [523, 659, 784, 1047].forEach(function (f, i) { tone(f, 0.16, "triangle", i * 0.12); }); }
  };

  /* ---------- input ---------- */

  var input = { pedal: false, brake: false, left: false, right: false };
  var KEYMAP = {
    ArrowUp: "pedal", KeyW: "pedal", Space: "pedal",
    ArrowDown: "brake", KeyS: "brake",
    ArrowLeft: "left", KeyA: "left",
    ArrowRight: "right", KeyD: "right"
  };

  function clearInput() {
    input.pedal = input.brake = input.left = input.right = false;
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

  function bindTouch(id, key) {
    var el = document.getElementById(id);
    if (!el) return;
    var down = function (e) { e.preventDefault(); input[key] = true; el.classList.add("is-down"); };
    var up = function (e) { e.preventDefault(); input[key] = false; el.classList.remove("is-down"); };
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    el.addEventListener("pointerleave", up);
    el.addEventListener("contextmenu", function (e) { e.preventDefault(); });
  }
  bindTouch("tc-pedal", "pedal");
  bindTouch("tc-brake", "brake");
  bindTouch("tc-left", "left");
  bindTouch("tc-right", "right");

  window.addEventListener("blur", function () {
    clearInput();
    if (mode === "race" || mode === "count") pauseGame();
  });

  var isTouch = window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
  var reducedMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------- DOM refs ---------- */

  function $(id) { return document.getElementById(id); }
  var el = {
    hud: $("hud"), time: $("hud-time"), score: $("hud-score"), speed: $("hud-speed"),
    progress: $("hud-progress-fill"), toast: $("trick-toast"), countdown: $("countdown"),
    menu: $("screen-menu"), howto: $("screen-howto"), pause: $("screen-pause"),
    results: $("screen-results"), resultsContent: $("results-content"),
    touch: $("touch-controls"), trackCards: $("track-cards"),
    riderName: $("rider-name"), ghostToggle: $("ghost-toggle"),
    btnSound: $("btn-sound"), lbTabs: $("lb-tabs"), lbList: $("lb-list"),
    ghostList: $("ghost-list"), ghostInput: $("ghost-input"), ghostMsg: $("ghost-import-msg")
  };

  /* ---------- track cache (built terrain + AI ghosts) ---------- */

  var cache = {};
  function getTrack(id) {
    if (!cache[id]) {
      var built = buildTrack(TRACKS[id]);
      var armand = simulateAI(built, AI_STYLES.armand);
      var arthur = simulateAI(built, AI_STYLES.arthur);
      armand.track = id; arthur.track = id;
      cache[id] = { built: built, armand: armand, arthur: arthur };
    }
    return cache[id];
  }

  /* ---------- game state ---------- */

  var mode = "menu";           /* menu | count | race | pause | results */
  var selTrack = lsGet("zr_seltrack", "miombo");
  if (!TRACKS[selTrack]) selTrack = "miombo";
  var run = null;              /* current race bundle */
  var menuT = 0;               /* attract-mode clock */
  var shakeT = 0;
  var particles = [];
  var lastTs = 0;
  var acc = 0;

  function fmtTime(ms) {
    ms = Math.round(ms / 100) * 100;      /* round to tenths first so 1:59.96 -> 2:00.0 */
    var m = Math.floor(ms / 60000);
    var s = (ms % 60000) / 1000;
    var ss = s.toFixed(1);
    if (s < 10) ss = "0" + ss;
    return m + ":" + ss;
  }

  /* ---------- race lifecycle ---------- */

  function startRace() {
    var tc = getTrack(selTrack);
    var st = newRider(tc.built);
    var ghosts = [];
    if (ghostsOn) {
      ghosts.push(tc.armand, tc.arthur);
      var myBestGhost = lsGet("zr_bestghost_" + selTrack, null);
      if (validGhostShape(myBestGhost)) {
        ghosts.push({ name: "Best " + sanitizeName(profile.name), color: "#2A9D8F", samples: myBestGhost.samples, timeMs: myBestGhost.timeMs });
      }
      var fr = friends.filter(function (f) { return f.track === selTrack; }).slice(-2);
      fr.forEach(function (f) { ghosts.push({ name: f.name, color: "#8E44AD", samples: f.samples, timeMs: f.timeMs }); });
    }
    run = {
      tc: tc, st: st, taken: new Array(tc.built.coins.length),
      recorder: [], step: 0, ghosts: ghosts,
      countT: 2.7, endT: 0
    };
    particles.length = 0;
    clearInput();
    acc = 0;
    cam.init = false;
    mode = "count";
    el.menu.hidden = true; el.results.hidden = true; el.pause.hidden = true; el.howto.hidden = true;
    el.hud.hidden = false;
    el.countdown.hidden = false;
    el.touch.hidden = !isTouch;
    SFX.count(false);
    run.lastBeep = 3;
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
    var timeMs = Math.round(st.finishT * 1000);
    var tc = run.tc;
    var name = sanitizeName(profile.name);

    /* medal vs AI ghosts */
    var gold = Math.min(tc.armand.timeMs, tc.arthur.timeMs);
    var silver = Math.max(tc.armand.timeMs, tc.arthur.timeMs);
    var bronze = Math.round(silver * 1.35);
    var medal = timeMs <= gold ? "gold" : timeMs <= silver ? "silver" : timeMs <= bronze ? "bronze" : "none";

    /* personal best + ghost */
    var prevBest = bests[selTrack] || Infinity;
    var isBest = timeMs < prevBest;
    if (isBest) {
      bests[selTrack] = timeMs;
      lsSet("zr_best", bests);
      lsSet("zr_bestghost_" + selTrack, { timeMs: timeMs, samples: run.recorder });
    }

    /* leaderboard */
    var list = scores[selTrack] || [];
    list.push({ name: name, timeMs: timeMs, score: st.score });
    list.sort(function (a, b) { return a.timeMs - b.timeMs; });
    scores[selTrack] = list.slice(0, 10);
    lsSet("zr_scores", scores);

    var medalTxt = {
      gold: ["🥇", "GOLD! You beat Armand's time — club legend!"],
      silver: ["🥈", "Silver! Faster than Arthur — Armand is next."],
      bronze: ["🥉", "Bronze! The ghosts are within reach now."],
      none: ["🚵", "Finished! Every run makes you faster."]
    }[medal];

    el.resultsContent.innerHTML =
      '<div class="results-medal">' + medalTxt[0] + "</div>" +
      "<h2>" + tc.built.def.name + " — done!</h2>" +
      '<p class="gr-tag">' + medalTxt[1] + "</p>" +
      '<div class="results-grid">' +
      "<span>Time<strong>" + fmtTime(timeMs) + "</strong></span>" +
      "<span>Best<strong>" + fmtTime(bests[selTrack]) + "</strong></span>" +
      "<span>Score<strong>" + st.score + "</strong></span>" +
      "<span>Coins<strong>" + st.coinCount + "</strong></span>" +
      "<span>Flips<strong>" + st.flipCount + "</strong></span>" +
      "</div>" +
      (isBest ? '<p><span class="track-pill track-pill--trail">NEW PERSONAL BEST</span></p>' : "") +
      '<p class="results-note">Armand: ' + fmtTime(tc.armand.timeMs) + " · Arthur: " + fmtTime(tc.arthur.timeMs) +
      (st.crashes ? " · Crashes: " + st.crashes + " (helmets, always!)" : " · Clean run — no crashes!") + "</p>" +
      '<p class="results-note">Copy your Ghost Code below and hand it to a club friend — they can race you without any chat.</p>';

    mode = "results";
    el.results.hidden = false;
    el.hud.hidden = true;
    el.touch.hidden = true;
    SFX.finish();
    refreshLeaderboard();
  }

  /* ---------- toasts & particles ---------- */

  function toast(txt) {
    el.toast.textContent = txt;
    el.toast.classList.remove("pop");
    void el.toast.offsetWidth;
    el.toast.classList.add("pop");
  }

  function spawnDust(x, y, n, color) {
    for (var i = 0; i < n; i++) {
      particles.push({
        x: x + (Math.random() - 0.5) * 26, y: y + (Math.random() - 0.5) * 8,
        vx: (Math.random() - 0.5) * 130, vy: -Math.random() * 150 - 20,
        life: 0.5 + Math.random() * 0.4, r: 2.5 + Math.random() * 4, c: color
      });
    }
  }

  function handleEvents(ev, st) {
    for (var i = 0; i < ev.length; i++) {
      var e = ev[i];
      if (e.t === "coin") { SFX.coin(); }
      else if (e.t === "land") {
        spawnDust(st.x, st.y + 6, e.q === "perfect" ? 14 : 8, "rgba(190,150,90,0.8)");
        if (e.q === "perfect") { toast("SMOOTH! +50"); SFX.perfect(); }
        else if (e.q === "sloppy") { toast("Wobbly landing!"); SFX.land(); }
        else SFX.land();
      }
      else if (e.t === "crash") {
        toast("OUCH! 💥 Keep pedalling!");
        SFX.crash();
        spawnDust(st.x, st.y, 22, "rgba(190,150,90,0.9)");
        if (!reducedMotion) shakeT = 0.45;
      }
      else if (e.t === "flip") {
        toast((e.dir === "back" ? "BACKFLIP" : "FRONTFLIP") + (e.n > 1 ? " ×" + e.n : "") + "! +" + (150 * e.n));
        SFX.flip();
      }
      else if (e.t === "bigair") { toast("BIG AIR! +75"); }
      else if (e.t === "finish") { /* handled by timer in loop */ }
    }
  }

  /* ---------- drawing helpers ---------- */

  function drawWheel(x, y, r, phase) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, 6.284);
    ctx.strokeStyle = "#241505";
    ctx.lineWidth = 5;
    ctx.stroke();
    ctx.strokeStyle = "rgba(120,90,60,0.9)";
    ctx.lineWidth = 1.6;
    for (var i = 0; i < 3; i++) {
      var a = phase + i * 2.094;
      ctx.beginPath();
      ctx.moveTo(x - Math.cos(a) * r, y - Math.sin(a) * r);
      ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
      ctx.stroke();
    }
    ctx.fillStyle = "#E8791D";
    ctx.beginPath(); ctx.arc(x, y, 3, 0, 6.284); ctx.fill();
  }

  function drawRiderSprite(jersey, skin, phase, pedaling, crashed, alpha) {
    ctx.globalAlpha = alpha;
    drawWheel(-30, 17, 16, phase);
    drawWheel(30, 17, 16, phase * 1.02);
    /* frame */
    ctx.strokeStyle = "#2B1B10";
    ctx.lineWidth = 4.5;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(-30, 17); ctx.lineTo(-4, 17); ctx.lineTo(7, 0); ctx.lineTo(30, 17);
    ctx.moveTo(-4, 17); ctx.lineTo(-11, -3); ctx.lineTo(7, 0);
    ctx.moveTo(-11, -3); ctx.lineTo(-16, -7);
    ctx.moveTo(7, 0); ctx.lineTo(11, -9);
    ctx.stroke();
    ctx.beginPath(); ctx.moveTo(11, -9); ctx.lineTo(19, -12); ctx.stroke();
    /* pedalling leg */
    var pl = pedaling ? Math.sin(phase * 2) * 4 : 0;
    ctx.strokeStyle = "#43290F";
    ctx.lineWidth = 5.5;
    ctx.beginPath(); ctx.moveTo(-13 + pl * 0.4, 24 + pl); ctx.lineTo(-8, 4); ctx.stroke();
    /* torso */
    ctx.strokeStyle = jersey;
    ctx.lineWidth = 6.5;
    ctx.beginPath(); ctx.moveTo(-8, 4); ctx.lineTo(-14, -16); ctx.stroke();
    /* arm */
    ctx.lineWidth = 5;
    ctx.beginPath(); ctx.moveTo(-14, -16); ctx.lineTo(2, -19); ctx.lineTo(18, -11); ctx.stroke();
    /* head + helmet */
    ctx.fillStyle = skin;
    ctx.beginPath(); ctx.arc(-7, -26, 7.5, 0, 6.284); ctx.fill();
    ctx.strokeStyle = "#E8791D";
    ctx.lineWidth = 5;
    ctx.beginPath(); ctx.arc(-7, -27, 8.5, Math.PI * 0.95, Math.PI * 1.95); ctx.stroke();
    if (crashed) {
      ctx.fillStyle = "rgba(255,243,196,0.95)";
      for (var i = 0; i < 3; i++) {
        var a = phase * 3 + i * 2.09;
        ctx.beginPath();
        ctx.arc(-7 + Math.cos(a) * 16, -26 + Math.sin(a) * 10, 2.2, 0, 6.284);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  function drawRiderAt(wx, wy, rot, camX, camY, opts) {
    ctx.save();
    ctx.translate(wx - camX, wy - camY - 16);
    ctx.rotate(rot);
    drawRiderSprite(opts.jersey, opts.skin || "#8C5A33", opts.phase || 0, opts.pedaling, opts.crashed, opts.alpha || 1);
    ctx.restore();
    if (opts.name) {
      var sx = wx - camX, sy = wy - camY - 58;
      ctx.font = "600 12px Fredoka, Arial, sans-serif";
      var w = ctx.measureText(opts.name).width + 12;
      ctx.globalAlpha = Math.min(0.85, opts.alpha + 0.2);
      ctx.fillStyle = "rgba(12,46,28,0.75)";
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(sx - w / 2, sy - 12, w, 17, 8);
      else ctx.rect(sx - w / 2, sy - 12, w, 17);
      ctx.fill();
      ctx.fillStyle = "#FFF3C4";
      ctx.textAlign = "center";
      ctx.fillText(opts.name, sx, sy);
      ctx.globalAlpha = 1;
      ctx.textAlign = "start";
    }
  }

  /* decoration painters — drawn at ground anchor, world scale */

  function drawDeco(d, gy, camX, camY, theme, t) {
    var x = d.x - camX, y = gy - camY, s = d.s;
    ctx.save();
    ctx.translate(x, y);
    if (d.fl) ctx.scale(-1, 1);
    ctx.scale(s, s);
    ctx.fillStyle = theme.deco;
    switch (d.type) {
      case "treeM":
        ctx.fillRect(-3, -34, 6, 34);
        ctx.beginPath(); ctx.ellipse(0, -44, 26, 14, 0, 0, 6.284); ctx.fill();
        ctx.beginPath(); ctx.ellipse(-16, -36, 14, 8, 0, 0, 6.284); ctx.fill();
        ctx.beginPath(); ctx.ellipse(16, -36, 14, 8, 0, 0, 6.284); ctx.fill();
        break;
      case "baobab":
        ctx.save(); ctx.scale(1.6, 1.6);
        ctx.beginPath();
        ctx.moveTo(-9, 0);
        ctx.bezierCurveTo(-8, -14, -8, -24, -10, -32);
        ctx.bezierCurveTo(-18, -35, -25, -41, -28, -49);
        ctx.bezierCurveTo(-21, -44, -14, -41, -9, -40);
        ctx.bezierCurveTo(-11, -46, -15, -51, -20, -56);
        ctx.bezierCurveTo(-13, -53, -8, -48, -5, -43);
        ctx.bezierCurveTo(-5, -51, -6, -58, -9, -65);
        ctx.bezierCurveTo(-3, -58, 0, -50, 1, -43);
        ctx.bezierCurveTo(5, -49, 11, -53, 19, -55);
        ctx.bezierCurveTo(13, -49, 8, -44, 5, -39);
        ctx.bezierCurveTo(12, -41, 19, -40, 25, -37);
        ctx.bezierCurveTo(17, -35, 10, -33, 5, -30);
        ctx.bezierCurveTo(3, -21, 3, -11, 4, 0);
        ctx.closePath(); ctx.fill();
        ctx.restore();
        break;
      case "acacia":
        ctx.beginPath(); ctx.moveTo(-2, 0); ctx.lineTo(-6, -30); ctx.lineTo(-2, -30); ctx.lineTo(2, 0); ctx.closePath(); ctx.fill();
        ctx.beginPath(); ctx.ellipse(-2, -34, 30, 8, 0, 0, 6.284); ctx.fill();
        break;
      case "palm":
        ctx.fillRect(-2.5, -36, 5, 36);
        ctx.strokeStyle = theme.deco; ctx.lineWidth = 4; ctx.lineCap = "round";
        for (var i = 0; i < 5; i++) {
          var a = -0.5 - i * 0.55;
          ctx.beginPath(); ctx.moveTo(0, -36);
          ctx.quadraticCurveTo(Math.cos(a) * 18, -36 + Math.sin(a) * 18 - 6, Math.cos(a) * 30, -36 + Math.sin(a) * 26);
          ctx.stroke();
        }
        break;
      case "bush":
        ctx.beginPath(); ctx.ellipse(0, -8, 16, 9, 0, 0, 6.284); ctx.fill();
        ctx.beginPath(); ctx.ellipse(10, -12, 10, 7, 0, 0, 6.284); ctx.fill();
        break;
      case "fern":
        ctx.strokeStyle = theme.decoAlt; ctx.lineWidth = 2.5; ctx.lineCap = "round";
        for (i = 0; i < 4; i++) {
          ctx.beginPath(); ctx.moveTo(0, 0);
          ctx.quadraticCurveTo(i * 4 - 6, -14, i * 7 - 10, -20);
          ctx.stroke();
        }
        break;
      case "grass":
        ctx.strokeStyle = theme.decoAlt; ctx.lineWidth = 2; ctx.lineCap = "round";
        for (i = 0; i < 4; i++) {
          ctx.beginPath(); ctx.moveTo(i * 4 - 6, 0);
          ctx.quadraticCurveTo(i * 4 - 6 + 2, -8, i * 4 - 4 + Math.sin(i) * 3, -13);
          ctx.stroke();
        }
        break;
      case "rock":
        ctx.beginPath();
        ctx.moveTo(-14, 0); ctx.lineTo(-9, -10); ctx.lineTo(2, -13); ctx.lineTo(12, -6); ctx.lineTo(14, 0);
        ctx.closePath(); ctx.fill();
        break;
      case "termite":
        ctx.beginPath();
        ctx.moveTo(-10, 0); ctx.quadraticCurveTo(-6, -22, -1, -30); ctx.quadraticCurveTo(3, -22, 8, 0);
        ctx.closePath(); ctx.fill();
        break;
      case "antelope":
        ctx.beginPath(); ctx.ellipse(0, -16, 14, 7, 0, 0, 6.284); ctx.fill();     /* body */
        ctx.fillRect(-11, -14, 3, 14); ctx.fillRect(8, -14, 3, 14);                /* legs */
        ctx.beginPath(); ctx.moveTo(12, -20); ctx.lineTo(19, -26); ctx.lineTo(17, -18); ctx.closePath(); ctx.fill(); /* neck+head */
        ctx.strokeStyle = theme.deco; ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.moveTo(18, -26); ctx.lineTo(22, -34); ctx.stroke();  /* horns */
        ctx.beginPath(); ctx.moveTo(16, -26); ctx.lineTo(18, -34); ctx.stroke();
        break;
      case "zebra":
        ctx.beginPath(); ctx.ellipse(0, -18, 16, 8, 0, 0, 6.284); ctx.fill();
        ctx.fillRect(-13, -14, 3.5, 14); ctx.fillRect(9, -14, 3.5, 14);
        ctx.fillRect(13, -30, 4, 14);
        ctx.beginPath(); ctx.ellipse(16, -31, 6, 3.5, -0.4, 0, 6.284); ctx.fill();
        ctx.strokeStyle = "rgba(255,246,220,0.75)"; ctx.lineWidth = 2;
        for (i = 0; i < 4; i++) { ctx.beginPath(); ctx.moveTo(i * 6 - 9, -25); ctx.lineTo(i * 6 - 6, -11); ctx.stroke(); }
        break;
      case "giraffe":
        ctx.fillRect(-8, -26, 16, 10);
        ctx.fillRect(-7, -18, 3, 18); ctx.fillRect(4, -18, 3, 18);
        ctx.save(); ctx.rotate(-0.28); ctx.fillRect(4, -52, 4.5, 30); ctx.restore();
        ctx.beginPath(); ctx.ellipse(19, -52, 6, 3.5, -0.3, 0, 6.284); ctx.fill();
        break;
      case "elephant":
        ctx.beginPath(); ctx.ellipse(0, -22, 20, 12, 0, 0, 6.284); ctx.fill();
        ctx.fillRect(-15, -14, 6, 14); ctx.fillRect(9, -14, 6, 14);
        ctx.beginPath(); ctx.arc(21, -28, 9, 0, 6.284); ctx.fill();
        ctx.strokeStyle = theme.deco; ctx.lineWidth = 4; ctx.lineCap = "round";
        ctx.beginPath(); ctx.moveTo(28, -26); ctx.quadraticCurveTo(33, -16, 30, -6); ctx.stroke();
        ctx.beginPath(); ctx.ellipse(16, -34, 6, 5, 0.5, 0, 6.284); ctx.fill();
        break;
      case "eagle":
        var flap = Math.sin(t * 7 + d.x) * 6;
        ctx.strokeStyle = theme.deco; ctx.lineWidth = 3; ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(-14, -90 + flap); ctx.quadraticCurveTo(-6, -96, 0, -90);
        ctx.quadraticCurveTo(6, -96, 14, -90 + flap);
        ctx.stroke();
        break;
    }
    ctx.restore();
  }

  /* far-background painter */

  function drawBackground(camX, camY, theme, trackId, t) {
    /* sky */
    var g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, theme.sky[0]);
    g.addColorStop(0.55, theme.sky[1]);
    g.addColorStop(1, theme.sky[2]);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    /* sun */
    var sunX = W * 0.72 - (camX * 0.015) % W;
    var sunY = H * 0.24 - camY * 0.01;
    ctx.fillStyle = theme.sun;
    ctx.globalAlpha = 0.35;
    ctx.beginPath(); ctx.arc(sunX, sunY, 74, 0, 6.284); ctx.fill();
    ctx.globalAlpha = 1;
    ctx.beginPath(); ctx.arc(sunX, sunY, 46, 0, 6.284); ctx.fill();

    /* falls backdrop: repeating giant waterfall */
    if (trackId === "falls") {
      var period = 2400;
      var px = camX * 0.12;
      var off = (px % period + period) % period;
      var baseX = W * 0.55 - off;
      var topY = H * 0.18 - camY * 0.05;
      for (var rep = -1; rep <= 1; rep++) {
        var bx = baseX + rep * period;
        if (bx < -400 || bx > W + 200) continue;
        /* canyon walls */
        ctx.fillStyle = theme.midHill;
        ctx.fillRect(bx - 320, topY, 250, H);
        ctx.fillRect(bx + 90, topY, 320, H);
        /* falling water */
        ctx.fillStyle = "rgba(243,251,250,0.92)";
        ctx.fillRect(bx - 70, topY, 160, H);
        ctx.strokeStyle = "rgba(189,232,226,0.9)";
        ctx.lineWidth = 7;
        for (var l = 0; l < 4; l++) {
          var lx = bx - 52 + l * 42;
          ctx.beginPath(); ctx.moveTo(lx, topY); ctx.lineTo(lx, H); ctx.stroke();
        }
        /* drifting mist puffs */
        ctx.fillStyle = "rgba(243,251,250,0.55)";
        for (l = 0; l < 3; l++) {
          var my = H * 0.6 + l * 40 + Math.sin(t * 0.7 + l * 2 + rep) * 12;
          ctx.beginPath(); ctx.ellipse(bx + 10 + Math.sin(t * 0.4 + l) * 26, my, 120, 26, 0, 0, 6.284); ctx.fill();
        }
        /* rainbow */
        ctx.lineWidth = 5;
        var cols = ["rgba(232,121,29,0.5)", "rgba(247,183,51,0.5)", "rgba(42,157,143,0.5)"];
        for (l = 0; l < 3; l++) {
          ctx.strokeStyle = cols[l];
          ctx.beginPath(); ctx.arc(bx + 20, H * 0.75, 150 - l * 10, Math.PI * 1.05, Math.PI * 1.95); ctx.stroke();
        }
      }
    }

    /* far hills */
    ctx.fillStyle = theme.farHill;
    ctx.beginPath();
    ctx.moveTo(0, H);
    for (var sx = 0; sx <= W; sx += 16) {
      var wx = sx + camX * 0.15;
      var y = H * 0.52 + 44 * Math.sin(wx * 0.0021) + 24 * Math.sin(wx * 0.0009 + 2) - camY * 0.08;
      ctx.lineTo(sx, y);
    }
    ctx.lineTo(W, H);
    ctx.closePath(); ctx.fill();

    /* mid silhouette tree line */
    ctx.fillStyle = theme.midHill;
    ctx.beginPath();
    ctx.moveTo(0, H);
    for (sx = 0; sx <= W; sx += 12) {
      wx = sx + camX * 0.38;
      y = H * 0.66 + 30 * Math.sin(wx * 0.0032 + 1) + 12 * Math.sin(wx * 0.011) - camY * 0.2;
      ctx.lineTo(sx, y);
    }
    ctx.lineTo(W, H);
    ctx.closePath(); ctx.fill();

    /* simple silhouette trees on the mid line */
    ctx.fillStyle = theme.silTree;
    var spacing = 210;
    var start = Math.floor((camX * 0.38) / spacing) - 1;
    for (var k = start; k < start + 8; k++) {
      var twx = k * spacing + ((k * 97) % 71);
      var tsx = twx - camX * 0.38;
      if (tsx < -60 || tsx > W + 60) continue;
      var ty = H * 0.66 + 30 * Math.sin(twx * 0.0032 + 1) + 12 * Math.sin(twx * 0.011) - camY * 0.2;
      var scale = 0.8 + ((k * 31) % 5) / 10;
      ctx.save();
      ctx.translate(tsx, ty + 4);
      ctx.scale(scale, scale);
      ctx.fillRect(-2.5, -22, 5, 22);
      ctx.beginPath(); ctx.ellipse(0, -30, 18, 11, 0, 0, 6.284); ctx.fill();
      ctx.restore();
    }
  }

  function drawTerrain(track, camX, camY, theme) {
    var x0 = camX - 30, x1 = camX + W + 30;
    ctx.beginPath();
    ctx.moveTo(x0 - camX, H + 60);
    for (var x = x0; x <= x1; x += 6) {
      ctx.lineTo(x - camX, groundYOf(track, x) - camY);
    }
    ctx.lineTo(x1 - camX, H + 60);
    ctx.closePath();
    var g = ctx.createLinearGradient(0, H * 0.35, 0, H);
    g.addColorStop(0, theme.dirtTop);
    g.addColorStop(1, theme.dirtBot);
    ctx.fillStyle = g;
    ctx.fill();

    /* grass lip */
    ctx.beginPath();
    for (x = x0; x <= x1; x += 6) {
      var sy = groundYOf(track, x) - camY;
      if (x === x0) ctx.moveTo(x - camX, sy); else ctx.lineTo(x - camX, sy);
    }
    ctx.strokeStyle = theme.grass;
    ctx.lineWidth = 9;
    ctx.lineCap = "round";
    ctx.stroke();
    ctx.strokeStyle = theme.grassDark;
    ctx.lineWidth = 3;
    ctx.stroke();
  }

  function drawCoins(track, taken, camX, camY, t) {
    var coins = track.coins;
    for (var i = 0; i < coins.length; i++) {
      var c = coins[i];
      if (c.x < camX - 40 || c.x > camX + W + 40) continue;
      if (taken && taken[i]) continue;
      var sx = c.x - camX, sy = c.y - camY;
      var squish = Math.abs(Math.sin(t * 4 + i * 0.9));
      ctx.fillStyle = "#F7B733";
      ctx.strokeStyle = "#C05E10";
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.ellipse(sx, sy, 9 * (0.35 + 0.65 * squish), 9, 0, 0, 6.284);
      ctx.fill(); ctx.stroke();
    }
  }

  function drawFinish(track, camX, camY) {
    var fx = track.finishX;
    if (fx < camX - 100 || fx > camX + W + 100) return;
    var gy = groundYOf(track, fx);
    var sx = fx - camX;
    var topY = gy - camY - 120;
    ctx.fillStyle = "#0C2E1C";
    ctx.fillRect(sx - 3, gy - camY - 118, 6, 118);
    ctx.fillRect(sx - 3 + 150, groundYOf(track, fx + 150) - camY - 118, 6, 118 + (groundYOf(track, fx + 150) - gy));
    /* banner */
    ctx.fillStyle = "#E8791D";
    ctx.fillRect(sx, topY, 156, 30);
    ctx.fillStyle = "#fff";
    for (var i = 0; i < 12; i++) {
      if (i % 2 === 0) ctx.fillRect(sx + i * 13, topY, 13, 8);
      else ctx.fillRect(sx + i * 13, topY + 22, 13, 8);
    }
    ctx.fillStyle = "#FFF3C4";
    ctx.font = "700 16px Fredoka, Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("FINISH", sx + 78, topY + 21);
    ctx.textAlign = "start";
  }

  function drawParticles(camX, camY, dt) {
    for (var i = particles.length - 1; i >= 0; i--) {
      var p = particles[i];
      p.life -= dt;
      if (p.life <= 0) { particles.splice(i, 1); continue; }
      p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 500 * dt;
      ctx.globalAlpha = Math.min(1, p.life * 2);
      ctx.fillStyle = p.c;
      ctx.beginPath(); ctx.arc(p.x - camX, p.y - camY, p.r, 0, 6.284); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  /* ---------- main scene ---------- */

  var cam = { x: 0, y: 0, init: false };

  function renderScene(track, focusX, focusY, st, ghosts, tSec, dt, racing) {
    var targetX = focusX - W * 0.34;
    var targetY = focusY - H * 0.58;
    if (!cam.init) { cam.x = targetX; cam.y = targetY; cam.init = true; }
    cam.x += (targetX - cam.x) * Math.min(1, 7 * dt);
    cam.y += (targetY - cam.y) * Math.min(1, 5 * dt);

    var shX = 0, shY = 0;
    if (shakeT > 0) {
      shakeT -= dt;
      shX = (Math.random() - 0.5) * 12 * shakeT;
      shY = (Math.random() - 0.5) * 12 * shakeT;
    }
    var camX = cam.x + shX, camY = cam.y + shY;
    var theme = track.def.theme;

    drawBackground(camX, camY, theme, track.def.id, tSec);

    /* decos behind terrain-line but standing on it */
    var decos = track.decos;
    for (var i = 0; i < decos.length; i++) {
      var d = decos[i];
      if (d.x < camX - 120 || d.x > camX + W + 120) continue;
      drawDeco(d, groundYOf(trackRef, d.x), camX, camY, theme, tSec);
    }

    drawTerrain(trackRef, camX, camY, theme);
    drawCoins(trackRef, racing ? run.taken : null, camX, camY, tSec);
    drawFinish(trackRef, camX, camY);

    /* ghosts */
    if (ghosts) {
      for (i = 0; i < ghosts.length; i++) {
        var gh = ghosts[i];
        var gp = ghostPosAt(gh, tSec);
        if (gp.empty) continue;
        drawRiderAt(gp.x, gp.y, gp.rot, camX, camY, {
          jersey: gh.color, alpha: gp.done ? 0.22 : 0.45,
          phase: tSec * 8, pedaling: !gp.done, name: gh.name, skin: "#9C6B3F"
        });
      }
    }

    /* the player */
    if (st) {
      drawRiderAt(st.x, st.y, st.rot, camX, camY, {
        jersey: profile.jersey, alpha: 1, phase: st.wheelPhase,
        pedaling: st.onGround && input.pedal, crashed: st.crashT > 0
      });
    }

    drawParticles(camX, camY, dt);
    return { camX: camX, camY: camY };
  }

  /* trackRef: module-level handle used by renderScene helpers */
  var trackRef = null;

  /* ---------- HUD ---------- */

  function updateHUD(st, track) {
    var ms = Math.round((st.finished ? st.finishT : st.t) * 1000);
    el.time.textContent = fmtTime(ms);
    el.score.textContent = "🪙 " + st.score;
    var sp = Math.sqrt(st.vx * st.vx + st.vy * st.vy);
    el.speed.textContent = Math.round(sp / 45 * 3.6) + " km/h";
    var prog = Math.max(0, Math.min(1, st.x / track.finishX));
    el.progress.style.width = (prog * 100).toFixed(1) + "%";
  }

  /* ---------- menu / attract mode ---------- */

  function refreshMenu() {
    /* track cards */
    var html = "";
    TRACK_ORDER.forEach(function (id) {
      var t = TRACKS[id];
      var best = bests[id];
      html +=
        '<button type="button" class="track-card' + (id === selTrack ? " is-selected" : "") + '" data-track="' + id + '" aria-pressed="' + (id === selTrack) + '">' +
        '<span class="track-card__name">' + t.name + "</span>" +
        '<span class="track-card__meta"><span class="track-pill track-pill--' + t.level + '">' + t.levelLabel + "</span> " + t.desc + "</span>" +
        '<span class="track-card__best">' + (best ? "Your best: " + fmtTime(best) : "Not ridden yet") + "</span>" +
        "</button>";
    });
    el.trackCards.innerHTML = html;
    el.riderName.value = profile.name;
    el.ghostToggle.checked = !!ghostsOn;
    el.btnSound.textContent = muted ? "🔇 Sound off" : "🔊 Sound on";
    el.btnSound.setAttribute("aria-pressed", muted ? "false" : "true");
    document.querySelectorAll(".jersey").forEach(function (b) {
      b.classList.toggle("is-selected", b.getAttribute("data-jersey") === profile.jersey);
    });
    cam.init = false;
  }

  el.trackCards.addEventListener("click", function (e) {
    var btn = e.target.closest("[data-track]");
    if (!btn) return;
    selTrack = btn.getAttribute("data-track");
    lsSet("zr_seltrack", selTrack);
    cam.init = false;
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
    profile.name = sanitizeName(el.riderName.value);
    el.riderName.value = profile.name;
    lsSet("zr_profile", profile);
  });

  el.ghostToggle.addEventListener("change", function () {
    ghostsOn = el.ghostToggle.checked;
    lsSet("zr_ghoston", ghostsOn);
  });

  $("btn-sound").addEventListener("click", function () {
    muted = !muted;
    lsSet("zr_muted", muted);
    refreshMenu();
  });

  $("btn-start").addEventListener("click", function () {
    profile.name = sanitizeName(el.riderName.value);
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

  $("btn-copy-ghost").addEventListener("click", function () {
    var g = lsGet("zr_bestghost_" + selTrack, null);
    var btn = this;
    if (!g || !g.samples) { btn.textContent = "No best run yet!"; return; }
    var code = packGhost({ name: sanitizeName(profile.name), track: selTrack, timeMs: g.timeMs, samples: g.samples });
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

  /* ---------- friend ghosts ---------- */

  function refreshGhostList() {
    if (!el.ghostList) return;
    if (!friends.length) {
      el.ghostList.innerHTML = '<li style="justify-content:center;color:var(--ink-soft)">No friend ghosts yet — paste a code above!</li>';
      return;
    }
    var html = "";
    friends.forEach(function (f, i) {
      html += "<li><span>👻 " + f.name + " · " + TRACKS[f.track].name + " · " + fmtTime(f.timeMs) + "</span>" +
        '<button type="button" data-del-ghost="' + i + '" aria-label="Remove ghost">remove</button></li>';
    });
    el.ghostList.innerHTML = html;
  }

  el.ghostList.addEventListener("click", function (e) {
    var b = e.target.closest("[data-del-ghost]");
    if (!b) return;
    friends.splice(Number(b.getAttribute("data-del-ghost")), 1);
    lsSet("zr_friends", friends);
    refreshGhostList();
  });

  $("btn-import-ghost").addEventListener("click", function () {
    var g = unpackGhost(el.ghostInput.value);
    if (!g) {
      el.ghostMsg.textContent = "Hmm, that code doesn't look right.";
      el.ghostMsg.style.color = "var(--flame)";
      return;
    }
    friends.push({ name: g.name, track: g.track, timeMs: g.timeMs, samples: g.samples });
    while (friends.length > 6) friends.shift();
    lsSet("zr_friends", friends);
    el.ghostInput.value = "";
    el.ghostMsg.textContent = "Ghost saved! Pick " + TRACKS[g.track].name + " and race " + g.name + " 👻";
    el.ghostMsg.style.color = "var(--forest-700)";
    refreshGhostList();
  });

  /* ---------- leaderboard ---------- */

  var lbTrack = selTrack;
  function refreshLeaderboard() {
    var tabs = "";
    TRACK_ORDER.forEach(function (id) {
      tabs += '<button type="button" class="lb-tab' + (id === lbTrack ? " is-selected" : "") + '" data-lb="' + id + '">' + TRACKS[id].name + "</button>";
    });
    el.lbTabs.innerHTML = tabs;
    var list = scores[lbTrack] || [];
    if (!list.length) {
      el.lbList.innerHTML = '<li class="lb-empty" style="grid-template-columns:1fr">No runs yet — be the first down the mountain!</li>';
      return;
    }
    var html = "";
    list.forEach(function (r, i) {
      html += '<li><span class="lb-rank">' + (i + 1) + '.</span><span>' + sanitizeName(r.name) + '</span><span class="lb-time">' + fmtTime(r.timeMs) + "</span></li>";
    });
    el.lbList.innerHTML = html;
  }

  el.lbTabs.addEventListener("click", function (e) {
    var b = e.target.closest("[data-lb]");
    if (!b) return;
    lbTrack = b.getAttribute("data-lb");
    refreshLeaderboard();
  });

  /* ---------- pause on tab switch ---------- */

  document.addEventListener("visibilitychange", function () {
    if (document.hidden && (mode === "race" || mode === "count")) pauseGame();
  });

  /* ---------- main loop ---------- */

  function loop(ts) {
    requestAnimationFrame(loop);
    var dt = Math.min(0.1, (ts - lastTs) / 1000 || 0.016);
    lastTs = ts;

    if (mode === "menu") {
      /* attract mode: Armand's ghost rides the selected track */
      menuT += dt;
      var tc = getTrack(selTrack);
      trackRef = tc.built;
      var dur = tc.armand.timeMs / 1000;
      var gt = menuT % (dur + 2.5);
      var gp = ghostPosAt(tc.armand, Math.min(gt, dur));
      renderScene(tc.built, gp.x, gp.y, null, [tc.armand], gt, dt, false);
      return;
    }

    if (!run) return;
    trackRef = run.tc.built;

    if (mode === "count") {
      run.countT -= dt;
      var n = Math.ceil(run.countT);
      if (n !== run.lastBeep && n > 0) { run.lastBeep = n; SFX.count(false); }
      el.countdown.textContent = run.countT > 0 ? String(Math.max(1, n)) : "GO!";
      if (run.countT <= -0.7) {
        el.countdown.hidden = true;
        mode = "race";
        SFX.count(true);
      } else if (run.countT <= 0 && run.lastBeep !== 0) {
        run.lastBeep = 0; SFX.count(true);
      }
      renderScene(run.tc.built, run.st.x, run.st.y, run.st, null, 0, dt, true);
      updateHUD(run.st, run.tc.built);
      return;
    }

    if (mode === "race") {
      acc += dt;
      var ev = [];
      var steps = 0;
      while (acc >= DT && steps < 5) {
        ev.length = 0;
        stepRider(run.st, input, run.tc.built, ev, run.taken);
        handleEvents(ev, run.st);
        if (run.step % 4 === 0) {
          run.recorder.push([Math.round(run.st.x), Math.round(run.st.y), Math.round(run.st.rot * 100)]);
        }
        run.step++;
        acc -= DT;
        steps++;
      }
      if (steps === 5) acc = 0;   /* dropped frames: don't spiral */

      /* dust while pedalling fast on the ground */
      if (run.st.onGround && input.pedal && Math.random() < 0.3) {
        spawnDust(run.st.x - 24, run.st.y + 2, 1, "rgba(190,150,90,0.5)");
      }

      renderScene(run.tc.built, run.st.x, run.st.y, run.st, run.ghosts, run.st.t, dt, true);
      updateHUD(run.st, run.tc.built);

      if (run.st.finished) {
        run.endT += dt;
        if (run.endT > 1.4) finishRace();
      }
      return;
    }

    if (mode === "pause" || mode === "results") {
      /* freeze-frame behind the overlay */
      renderScene(run.tc.built, run.st.x, run.st.y, run.st, run.ghosts, run.st.t, dt, true);
    }
  }

  /* ---------- boot ---------- */

  refreshMenu();
  refreshGhostList();
  refreshLeaderboard();
  requestAnimationFrame(loop);
})();
