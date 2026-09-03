/* ==========================================================================
   ORBIT — procedural audio

   Every sound here is synthesised in the browser: oscillators for the drive,
   filtered noise for the dust going past the hull, and short envelopes for
   everything that happens. Nothing is fetched, so the game stays a folder of
   text files and works offline.

   Space is silent, and a silent game is no fun, so this is the film version:
   two continuous layers that follow the throttle and the airspeed, a beam
   whine that only exists while the beam does, and one-shots fired from the
   simulation's own events.

   Exposes window.ORBIT_AUDIO. Silent and harmless if Web Audio is missing.
   ========================================================================== */

(function () {
  "use strict";

  var ctx = null, master = null, ready = false, failed = false;
  var enabled = true, running = false;
  var noiseBuf = null;
  var L = null;                  /* the continuous layers */
  var lastShield = 1, alarmT = 0;

  /* ---------- context ---------- */

  function boot() {
    if (ready || failed) return ready;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) { failed = true; return false; }
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = enabled ? 0.45 : 0;
      master.connect(ctx.destination);
      noiseBuf = makeNoise(2.5);
      buildLayers();
      ready = true;
    } catch (e) { failed = true; }
    return ready;
  }

  function makeNoise(seconds) {
    var n = Math.floor(ctx.sampleRate * seconds);
    var buf = ctx.createBuffer(1, n, ctx.sampleRate);
    var d = buf.getChannelData(0);
    var last = 0;
    for (var i = 0; i < n; i++) {
      var white = Math.random() * 2 - 1;
      last = last * 0.72 + white * 0.28;
      d[i] = last * 1.6;
    }
    return buf;
  }

  function noiseSource() {
    var src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    return src;
  }

  /* Three things run the whole time a run is in progress: the drive itself
     (two detuned saws through a lowpass), the belt dust hissing past the
     hull, and the cutting beam, which is kept alive at zero gain so it can
     be opened in a millisecond rather than started from cold. */
  function buildLayers() {
    L = {};

    var driveGain = ctx.createGain(); driveGain.gain.value = 0;
    var driveFilter = ctx.createBiquadFilter();
    driveFilter.type = "lowpass"; driveFilter.frequency.value = 900; driveFilter.Q.value = 3.5;
    driveFilter.connect(driveGain); driveGain.connect(master);

    var oscA = ctx.createOscillator(); oscA.type = "sawtooth"; oscA.frequency.value = 70;
    var oscB = ctx.createOscillator(); oscB.type = "sawtooth"; oscB.frequency.value = 70.9;
    var sub = ctx.createOscillator(); sub.type = "sine"; sub.frequency.value = 35;
    var subGain = ctx.createGain(); subGain.gain.value = 0.6;
    oscA.connect(driveFilter); oscB.connect(driveFilter);
    sub.connect(subGain); subGain.connect(driveGain);
    oscA.start(); oscB.start(); sub.start();
    L.drive = { gain: driveGain, filter: driveFilter, a: oscA, b: oscB, sub: sub };

    var dustGain = ctx.createGain(); dustGain.gain.value = 0;
    var dustFilter = ctx.createBiquadFilter();
    dustFilter.type = "bandpass"; dustFilter.frequency.value = 1400; dustFilter.Q.value = 0.6;
    var dustSrc = noiseSource();
    dustSrc.connect(dustFilter); dustFilter.connect(dustGain); dustGain.connect(master);
    dustSrc.start();
    L.dust = { gain: dustGain, filter: dustFilter };

    var beamGain = ctx.createGain(); beamGain.gain.value = 0;
    var beamOsc = ctx.createOscillator(); beamOsc.type = "square"; beamOsc.frequency.value = 1180;
    var beamFilter = ctx.createBiquadFilter();
    beamFilter.type = "bandpass"; beamFilter.frequency.value = 1600; beamFilter.Q.value = 6;
    var beamNoise = noiseSource();
    beamOsc.connect(beamGain); beamNoise.connect(beamFilter); beamFilter.connect(beamGain);
    beamGain.connect(master);
    beamOsc.start(); beamNoise.start();
    L.beam = { gain: beamGain, osc: beamOsc };
  }

  /* Ramp a parameter with a time constant rather than a step: every one of
     these is following something continuous, and steps click. */
  function at(param, value, tau) {
    try { param.setTargetAtTime(value, ctx.currentTime, tau || 0.05); } catch (e) { /* closed */ }
  }

  /* ---------- one-shot builders ---------- */

  function tone(freq, dur, type, vol, slideTo, delay) {
    if (!ready || !enabled) return;
    var t0 = ctx.currentTime + (delay || 0);
    var osc = ctx.createOscillator();
    var g = ctx.createGain();
    osc.type = type || "sine";
    osc.frequency.setValueAtTime(freq, t0);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + Math.min(0.02, dur * 0.25));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g); g.connect(master);
    osc.start(t0); osc.stop(t0 + dur + 0.03);
  }

  function burst(opts) {
    if (!ready || !enabled) return;
    var t0 = ctx.currentTime + (opts.delay || 0);
    var src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.playbackRate.value = opts.rate || 1;
    var f = ctx.createBiquadFilter();
    f.type = opts.type || "bandpass";
    f.frequency.setValueAtTime(opts.freq || 900, t0);
    if (opts.sweepTo) f.frequency.exponentialRampToValueAtTime(opts.sweepTo, t0 + opts.dur);
    f.Q.value = opts.q || 1;
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(opts.vol || 0.3, t0 + (opts.attack || 0.01));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + opts.dur);
    src.connect(f); f.connect(g); g.connect(master);
    src.start(t0); src.stop(t0 + opts.dur + 0.05);
  }

  /* ---------- run-level control ---------- */

  function begin() {
    if (!boot()) return;
    running = true;
    lastShield = 1; alarmT = 0;
    if (ctx.state === "suspended") ctx.resume();
  }

  function end() {
    running = false;
    if (!ready) return;
    at(L.drive.gain.gain, 0, 0.25);
    at(L.dust.gain.gain, 0, 0.25);
    at(L.beam.gain.gain, 0, 0.05);
  }

  /* The drive note rides the throttle, the dust rides the speed, and the
     boost opens the filter — the same three numbers the HUD is showing. */
  function update(st, world, dt, input) {
    if (!ready || !running || !enabled) return;
    var cruise = world.spec.cruise;
    var frac = Math.min(2, st.speed / Math.max(1, cruise));
    var throttle = st.boosting ? 1 : (input && input.brake ? 0.35 : 0.7);

    var base = 62 + frac * 46 + (st.boosting ? 24 : 0);
    at(L.drive.a.frequency, base, 0.09);
    at(L.drive.b.frequency, base * 1.008, 0.09);
    at(L.drive.sub.frequency, base * 0.5, 0.12);
    at(L.drive.filter.frequency, 420 + throttle * 1500 + frac * 500, 0.08);
    at(L.drive.gain.gain, 0.05 + throttle * 0.13, 0.1);

    at(L.dust.filter.frequency, 700 + frac * 2400, 0.1);
    at(L.dust.gain.gain, 0.02 + Math.min(0.11, frac * 0.09), 0.12);

    at(L.beam.gain.gain, st.beamOn ? 0.06 : 0, 0.02);
    if (st.beamOn) at(L.beam.osc.frequency, 900 + st.beamT * 1400, 0.05);

    /* the shield alarm: not a sound effect, a warning that keeps going */
    var frac2 = st.shield / st.maxShield;
    if (frac2 < 0.26 && !st.dead) {
      alarmT -= dt;
      if (alarmT <= 0) { alarmT = 0.85; tone(760, 0.1, "square", 0.06); tone(600, 0.1, "square", 0.05, null, 0.13); }
    }
    lastShield = frac2;
  }

  function event(e) {
    if (!ready || !enabled) return;
    switch (e.t) {
      case "gate":
        if (e.clean) {
          tone(880, 0.1, "triangle", 0.16);
          tone(1320, 0.16, "triangle", 0.13, null, 0.06);
          tone(1760, 0.22, "sine", 0.09, null, 0.12);
        } else {
          tone(620, 0.12, "triangle", 0.11);
        }
        break;
      case "miss":
        tone(330, 0.18, "sine", 0.09, 220);
        break;
      case "clip":
        burst({ freq: 2600, dur: 0.3, vol: 0.3, q: 3, sweepTo: 700 });
        tone(180, 0.25, "square", 0.12, 90);
        break;
      case "ore":
        tone(1180, 0.07, "sine", 0.12, 1580);
        break;
      case "crack":
        burst({ freq: 300, dur: 0.45, vol: 0.4, q: 0.7, sweepTo: 120, rate: 0.7 });
        tone(1400, 0.3, "triangle", 0.1, 2400, 0.05);
        break;
      case "hit":
        burst({ freq: 420, dur: 0.34, vol: Math.min(0.5, 0.16 + e.force * 0.006), q: 0.8, sweepTo: 110, rate: 0.75 });
        tone(96, 0.35, "sine", 0.22, 48);
        break;
      case "boost":
        burst({ freq: 300, dur: 0.5, vol: 0.22, q: 0.8, sweepTo: 2600, attack: 0.12 });
        break;
      case "overheat":
        tone(520, 0.14, "square", 0.14);
        tone(390, 0.2, "square", 0.13, null, 0.16);
        break;
      case "cool":
        tone(700, 0.12, "sine", 0.07, 950);
        break;
      case "stray":
        if (e.on) { tone(300, 0.2, "sawtooth", 0.09, 220); }
        break;
      case "finish":
        tone(660, 0.16, "triangle", 0.16);
        tone(880, 0.16, "triangle", 0.16, null, 0.14);
        tone(1320, 0.42, "triangle", 0.15, null, 0.28);
        break;
      case "down":
        tone(300, 0.7, "sawtooth", 0.16, 70);
        burst({ freq: 900, dur: 0.7, vol: 0.24, sweepTo: 90, rate: 0.6 });
        break;
      default: break;
    }
  }

  function countdown(final) {
    if (!ready || !enabled) return;
    if (final) { tone(880, 0.35, "triangle", 0.2); tone(1320, 0.4, "sine", 0.12, null, 0.05); }
    else tone(520, 0.12, "triangle", 0.13);
  }

  function unlock() {
    if (!boot()) return;
    if (ctx.state === "suspended") ctx.resume();
  }

  function enable(v) {
    enabled = !!v;
    if (ready) master.gain.setTargetAtTime(enabled ? 0.45 : 0, ctx.currentTime, 0.05);
  }

  window.ORBIT_AUDIO = {
    unlock: unlock, enable: enable, isEnabled: function () { return enabled; },
    begin: begin, end: end, update: update, event: event, countdown: countdown
  };
})();
