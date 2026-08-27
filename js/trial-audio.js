/* ==========================================================================
   TRIAL — procedural audio

   Every sound here is synthesised in the browser: filtered noise for tyres
   and wind, oscillators for the drivetrain and the impacts. Nothing is
   fetched, so the game stays a folder of text files and works offline.

   The model is simple: three continuous layers whose gain and filtering
   follow the bike (tyre roll, wind, drivetrain), a couple of click
   schedulers riding on top (pedal strokes, freewheel ratchet), and one-shots
   fired from the simulation's own events. What the tyres sound like depends
   on what is under them — hardpack, sand, rock or scrub.

   Exposes window.TRIAL_AUDIO. Silent and harmless if Web Audio is missing.
   ========================================================================== */

(function () {
  "use strict";

  var ctx = null, master = null, ready = false, failed = false;
  var enabled = true, running = false;
  var noiseBuf = null;
  var L = null;                  /* the continuous layers */
  var phase = { pedal: 0, free: 0, grain: 0 };
  var lastSurface = "dirt";

  /* ---------- surfaces ----------
     band/q shape the hiss, low/lowGain the rumble under it, grain how much
     the surface rattles the bike. Hardpack hums, sand hisses, rock chatters,
     scrub swishes. */
  var SURFACES = {
    dirt:  { band: 950,  q: 0.9,  gain: 0.55, low: 90,  lowGain: 0.34, grain: 0.16, grainF: 420 },
    sand:  { band: 3100, q: 0.55, gain: 0.80, low: 140, lowGain: 0.12, grain: 0.04, grainF: 900 },
    rock:  { band: 760,  q: 1.7,  gain: 0.72, low: 70,  lowGain: 0.46, grain: 0.80, grainF: 260 },
    grass: { band: 4500, q: 0.7,  gain: 0.52, low: 120, lowGain: 0.08, grain: 0.30, grainF: 1500 }
  };

  function surfaceFor(st, world) {
    if (st.chatter > 0.15) return "rock";
    var sandy = world && world.biome && world.biome.id === "kalahari";
    if (st.offTrail) return sandy ? "sand" : "grass";
    return sandy ? "sand" : "dirt";
  }

  /* ---------- context ---------- */

  function boot() {
    if (ready || failed) return ready;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) { failed = true; return false; }
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = enabled ? 0.5 : 0;
      master.connect(ctx.destination);
      noiseBuf = makeNoise(2.4);
      buildLayers();
      ready = true;
    } catch (e) { failed = true; }
    return ready;
  }

  function makeNoise(seconds) {
    var n = Math.floor(ctx.sampleRate * seconds);
    var buf = ctx.createBuffer(1, n, ctx.sampleRate);
    var d = buf.getChannelData(0);
    /* a touch of smoothing keeps it from sounding like a broken speaker */
    var last = 0;
    for (var i = 0; i < n; i++) {
      var white = Math.random() * 2 - 1;
      last = last * 0.35 + white * 0.65;
      d[i] = last;
    }
    return buf;
  }

  function noiseSource() {
    var s = ctx.createBufferSource();
    s.buffer = noiseBuf;
    s.loop = true;
    return s;
  }

  function buildLayers() {
    /* --- tyre roll: filtered noise, plus a rumble under it --- */
    var rollSrc = noiseSource();
    var rollBand = ctx.createBiquadFilter();
    rollBand.type = "bandpass";
    rollBand.frequency.value = SURFACES.dirt.band;
    rollBand.Q.value = SURFACES.dirt.q;
    var rollGain = ctx.createGain();
    rollGain.gain.value = 0;
    rollSrc.connect(rollBand).connect(rollGain).connect(master);

    var rumbleSrc = noiseSource();
    var rumbleLow = ctx.createBiquadFilter();
    rumbleLow.type = "lowpass";
    rumbleLow.frequency.value = 150;
    var rumbleGain = ctx.createGain();
    rumbleGain.gain.value = 0;
    rumbleSrc.connect(rumbleLow).connect(rumbleGain).connect(master);

    /* --- wind: rises with speed, and takes over in the air --- */
    var windSrc = noiseSource();
    var windLow = ctx.createBiquadFilter();
    windLow.type = "lowpass";
    windLow.frequency.value = 500;
    var windGain = ctx.createGain();
    windGain.gain.value = 0;
    windSrc.connect(windLow).connect(windGain).connect(master);

    /* --- drivetrain hum while you are actually pedalling --- */
    var chainOsc = ctx.createOscillator();
    chainOsc.type = "sawtooth";
    chainOsc.frequency.value = 60;
    var chainLow = ctx.createBiquadFilter();
    chainLow.type = "lowpass";
    chainLow.frequency.value = 320;
    var chainGain = ctx.createGain();
    chainGain.gain.value = 0;
    chainOsc.connect(chainLow).connect(chainGain).connect(master);

    /* --- brake squeal: a narrow resonant band, only under hard braking --- */
    var brakeSrc = noiseSource();
    var brakeBand = ctx.createBiquadFilter();
    brakeBand.type = "bandpass";
    brakeBand.frequency.value = 2600;
    brakeBand.Q.value = 14;
    var brakeGain = ctx.createGain();
    brakeGain.gain.value = 0;
    brakeSrc.connect(brakeBand).connect(brakeGain).connect(master);

    [rollSrc, rumbleSrc, windSrc, brakeSrc].forEach(function (s) { s.start(0); });
    chainOsc.start(0);

    L = {
      rollBand: rollBand, rollGain: rollGain,
      rumbleLow: rumbleLow, rumbleGain: rumbleGain,
      windLow: windLow, windGain: windGain,
      chainOsc: chainOsc, chainGain: chainGain,
      brakeBand: brakeBand, brakeGain: brakeGain
    };
  }

  function at(param, value, tau) {
    param.setTargetAtTime(value, ctx.currentTime, tau || 0.06);
  }

  /* ---------- one-shot builders ---------- */

  function tone(freq, dur, type, vol, slideTo, delay) {
    if (!ready || !enabled) return;
    var t0 = ctx.currentTime + (delay || 0);
    var osc = ctx.createOscillator();
    var g = ctx.createGain();
    osc.type = type || "sine";
    osc.frequency.setValueAtTime(freq, t0);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(24, slideTo), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.03);
  }

  /* A shaped burst of noise — the basis of every impact and scrape. */
  function burst(opts) {
    if (!ready || !enabled) return;
    var t0 = ctx.currentTime + (opts.delay || 0);
    var dur = opts.dur || 0.12;
    var src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    var f = ctx.createBiquadFilter();
    f.type = opts.type || "bandpass";
    f.frequency.setValueAtTime(opts.freq || 800, t0);
    if (opts.freqTo) f.frequency.exponentialRampToValueAtTime(Math.max(40, opts.freqTo), t0 + dur);
    f.Q.value = opts.q === undefined ? 1 : opts.q;
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, opts.vol || 0.3), t0 + (opts.attack || 0.006));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f).connect(g).connect(master);
    src.start(t0);
    src.stop(t0 + dur + 0.03);
  }

  /* ---------- the sound of hitting things ----------
     Object impacts are the one place the game has to tell you *what* you hit
     without you having seen it. Wood, stone and scrub get separate voices. */

  var OBJECT_SOUNDS = {
    tree: function (force) {
      tone(168, 0.20, "triangle", 0.42 * force, 96);
      burst({ freq: 430, q: 2.4, dur: 0.14, vol: 0.34 * force });
      burst({ type: "highpass", freq: 2600, dur: 0.42, vol: 0.13 * force, attack: 0.03 });
    },
    rock: function (force) {
      burst({ type: "highpass", freq: 1700, dur: 0.09, vol: 0.42 * force, attack: 0.002 });
      tone(880, 0.13, "triangle", 0.24 * force, 320);
      tone(150, 0.16, "sine", 0.30 * force, 70);
    },
    scrub: function (force) {
      burst({ type: "highpass", freq: 3200, freqTo: 1400, dur: 0.3, vol: 0.2 * force, attack: 0.04 });
    },
    mound: function (force) {
      tone(120, 0.22, "sine", 0.38 * force, 58);
      burst({ freq: 300, q: 1.2, dur: 0.18, vol: 0.26 * force });
    }
  };

  function objectHit(kind, force) {
    var fn = OBJECT_SOUNDS[kind] || OBJECT_SOUNDS.scrub;
    fn(Math.max(0.15, Math.min(1.4, force === undefined ? 1 : force)));
  }

  /* ---------- run-level control ---------- */

  var API = {
    /* browsers only allow audio after a gesture, so every control calls this */
    unlock: function () {
      if (!enabled) return;
      if (!boot()) return;
      if (ctx.state === "suspended") ctx.resume();
    },

    isEnabled: function () { return enabled; },

    /* Only records the preference — the context itself is not created until
       a real gesture reaches unlock(), or the browser logs an autoplay
       warning on every frame that touches it. */
    enable: function (on) {
      enabled = !!on;
      if (ready) {
        at(master.gain, enabled ? 0.5 : 0, 0.05);
        if (enabled && ctx.state === "suspended") ctx.resume();
      }
    },

    begin: function () {
      if (!enabled) return;
      if (!boot()) return;
      if (ctx.state === "suspended") ctx.resume();
      running = true;
      phase.pedal = phase.free = phase.grain = 0;
    },

    end: function () {
      running = false;
      if (!ready) return;
      at(L.rollGain.gain, 0, 0.08);
      at(L.rumbleGain.gain, 0, 0.08);
      at(L.windGain.gain, 0, 0.08);
      at(L.chainGain.gain, 0, 0.05);
      at(L.brakeGain.gain, 0, 0.05);
    },

    /* Called once a frame with the live rider state. */
    update: function (st, world, dt, input) {
      if (!ready || !enabled || !running) return;
      var speed = Math.sqrt(st.vx * st.vx + st.vz * st.vz);
      var down = st.onGround && st.crashT <= 0;

      var name = surfaceFor(st, world);
      var S = SURFACES[name] || SURFACES.dirt;
      if (name !== lastSurface) {
        lastSurface = name;
        /* a quick scuff as the tyres cross onto something new */
        if (speed > 6) burst({ freq: S.band, q: 1.1, dur: 0.16, vol: 0.12 });
      }

      /* tyres: nothing at a standstill, filling out as the speed climbs */
      var rollAmt = down ? Math.min(1, speed / 15) : 0;
      rollAmt *= rollAmt * 0.9 + rollAmt * 0.1;
      at(L.rollBand.frequency, S.band * (0.85 + Math.min(0.5, speed / 46)), 0.09);
      at(L.rollBand.Q, S.q, 0.15);
      at(L.rollGain.gain, rollAmt * S.gain * 0.5, 0.05);
      at(L.rumbleLow.frequency, S.low + speed * 2.6, 0.12);
      at(L.rumbleGain.gain, rollAmt * S.lowGain * 0.5, 0.06);

      /* rock gardens rattle: random grains on top of the roll */
      if (down && S.grain > 0.1 && speed > 4) {
        phase.grain += dt * speed * S.grain * 2.4;
        while (phase.grain >= 1) {
          phase.grain -= 1;
          burst({
            freq: S.grainF * (0.7 + Math.random() * 0.8), q: 3,
            dur: 0.035 + Math.random() * 0.04,
            vol: (0.05 + Math.random() * 0.1) * Math.min(1, speed / 14) * S.grain
          });
        }
      }

      /* wind: always some, much more once the wheels are off the ground */
      var windAmt = Math.max(0, (speed - 4) / 24);
      if (!st.onGround) windAmt *= 1.7;
      at(L.windLow.frequency, 260 + speed * 46, 0.1);
      at(L.windGain.gain, Math.min(1, windAmt) * 0.16, 0.1);

      /* drivetrain: hum plus one click per pedal stroke */
      var pedalling = input && input.pedal && down && speed < 24;
      at(L.chainGain.gain, pedalling ? 0.028 : 0, 0.07);
      if (pedalling) {
        var cadence = 1.25 + Math.min(1.5, speed / 13);
        at(L.chainOsc.frequency, 52 + cadence * 15, 0.08);
        phase.pedal += dt * cadence;
        while (phase.pedal >= 1) {
          phase.pedal -= 1;
          burst({ freq: 1500, q: 5, dur: 0.03, vol: 0.05 });
          tone(96, 0.07, "sine", 0.05, 62);
        }
      } else {
        phase.pedal = 0;
      }

      /* freewheel ratchet whenever you are coasting */
      if (down && !pedalling && speed > 1.4) {
        phase.free += dt * speed * 2.6;
        while (phase.free >= 1) {
          phase.free -= 1;
          burst({ freq: 2900, q: 9, dur: 0.016, vol: 0.028 });
        }
      } else {
        phase.free = 0;
      }

      /* brakes only squeal when they are working for a living */
      var braking = input && input.brake && down && speed > 7;
      at(L.brakeBand.frequency, 2200 + speed * 22, 0.1);
      at(L.brakeGain.gain, braking ? Math.min(0.05, 0.012 + speed * 0.0016) : 0, 0.05);
    },

    /* One-shots, driven by the simulation's own event stream. */
    event: function (ev, st) {
      if (!ready || !enabled) return;
      var speed = st ? Math.sqrt(st.vx * st.vx + st.vz * st.vz) : 10;
      switch (ev.t) {
        case "hop":
          tone(300, 0.09, "triangle", 0.1, 520);
          burst({ freq: 900, q: 2, dur: 0.07, vol: 0.08 });
          break;
        case "takeoff":
          burst({ type: "highpass", freq: 900, freqTo: 2600, dur: 0.3, vol: 0.11, attack: 0.05 });
          break;
        case "land":
          if (ev.q === "hard") {
            tone(104, 0.22, "sine", 0.4, 52);
            burst({ freq: 260, q: 1.1, dur: 0.24, vol: 0.3 });
          } else {
            tone(150, 0.12, "sine", 0.22, 78);
            burst({ freq: 520, q: 1.4, dur: 0.13, vol: 0.16 });
          }
          break;
        case "trick":
          /* the better the trick, the higher and longer it sings */
          var steps = Math.min(5, 2 + Math.floor(ev.pts / 700));
          var base = 520 * Math.pow(1.05, Math.min(12, ev.combo || 1));
          for (var i = 0; i < steps; i++) {
            tone(base * Math.pow(1.26, i), 0.16, "triangle", 0.11, 0, i * 0.055);
          }
          if (ev.perfect) tone(base * 4, 0.4, "sine", 0.07, 0, steps * 0.055);
          break;
        case "bail":
          objectHit(ev.why === "tree" ? "tree" : (ev.why === "rock" ? "rock" : "scrub"),
            Math.min(1.3, 0.55 + speed * 0.03));
          burst({ freq: 380, freqTo: 120, q: 0.8, dur: 0.55, vol: 0.3, attack: 0.01 });
          tone(210, 0.4, "sawtooth", 0.16, 62);
          break;
        case "bump":
          objectHit(ev.what === "tree" ? "tree" : (ev.what === "boulder" ? "rock" : "scrub"), 0.35);
          break;
        case "gate":
          tone(720, 0.1, "triangle", 0.13);
          tone(1080, 0.16, "triangle", 0.1, 0, 0.07);
          break;
        case "respawn":
          tone(420, 0.14, "sine", 0.1, 620);
          break;
        case "combo-end":
          tone(300, 0.18, "triangle", 0.05, 190);
          break;
        case "broken":
          [330, 262, 208, 156].forEach(function (f, i) {
            tone(f, 0.32, "triangle", 0.13, 0, i * 0.13);
          });
          break;
        case "finish":
          [523, 659, 784, 1047].forEach(function (f, i) {
            tone(f, 0.26, "triangle", 0.14, 0, i * 0.1);
          });
          break;
        default:
          break;
      }
    },

    countdown: function (high) {
      if (!ready || !enabled) return;
      tone(high ? 880 : 520, 0.13, "square", 0.1);
    },

    /* exposed so the renderer can voice things the simulation does not
       model, like brushing through scrub */
    objectHit: objectHit,

    /* what the mixer is actually doing right now — used by the tests */
    debug: function () {
      if (!ready) return { ready: false, failed: failed, enabled: enabled };
      return {
        ready: true, failed: failed, enabled: enabled, running: running,
        state: ctx.state, surface: lastSurface,
        master: +master.gain.value.toFixed(3),
        roll: +L.rollGain.gain.value.toFixed(4),
        rumble: +L.rumbleGain.gain.value.toFixed(4),
        wind: +L.windGain.gain.value.toFixed(4),
        chain: +L.chainGain.gain.value.toFixed(4),
        brake: +L.brakeGain.gain.value.toFixed(4),
        band: Math.round(L.rollBand.frequency.value)
      };
    }
  };

  if (typeof window !== "undefined") window.TRIAL_AUDIO = API;
  if (typeof module !== "undefined" && module.exports) module.exports = API;
})();
