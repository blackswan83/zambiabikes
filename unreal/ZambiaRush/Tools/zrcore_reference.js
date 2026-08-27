#!/usr/bin/env node
/* zrcore_reference.js — ground truth for the C++ port.
 *
 * Runs the SHIPPING js/game3d-core.js under Node and dumps its world, its AI
 * ghosts and a scripted player run in a format Tools/zrcore_verify.cpp
 * reproduces exactly. Every floating-point value is emitted as a raw IEEE-754
 * bit pattern, not as decimal text, because the whole point is bit-exactness
 * and decimal formatting would hide a 1-ULP difference.
 *
 *   node zrcore_reference.js miombo > reference-miombo.txt
 *
 * See Tools/zrcore_verify.cpp for the other half.
 */
"use strict";

const path = require("path");
const CORE = require(path.join(__dirname, "..", "..", "..", "js", "game3d-core.js"));

const trackId = process.argv[2] || "miombo";
const def = CORE.TRACKS3[trackId];
if (!def) { console.error("unknown track: " + trackId); process.exit(2); }

const buf = Buffer.alloc(8);
function d64(x) { buf.writeDoubleLE(x, 0); return buf.toString("hex"); }
function f32bits(f32arr, i) {
  const u = new Uint32Array(f32arr.buffer, f32arr.byteOffset, f32arr.length);
  return u[i].toString(16).padStart(8, "0");
}

const out = [];
const emit = (s) => out.push(s);

/* ---------- world ---------- */
const world = CORE.buildWorld(def);

emit("WORLD " + world.nx + " " + world.nz + " " + d64(world.z0) + " " + d64(world.x0) +
     " " + d64(world.step) + " " + world.trailN + " " + world.finishIdx);

for (let i = 0; i < world.H.length; i++) emit("H " + i + " " + f32bits(world.H, i));
for (let i = 0; i < world.TD.length; i++) emit("D " + i + " " + f32bits(world.TD, i));

for (let i = 0; i < world.trailN; i++) {
  const p = world.trail[i];
  emit("T " + i + " " + d64(p.x) + " " + d64(p.y) + " " + d64(p.z) + " " + d64(p.yaw) + " " + d64(p.dist));
}
emit("KICKERS " + world.kickers.length + " " + world.kickers.join(","));
emit("GATES " + world.gates.length + " " + world.gates.join(","));
emit("NCOINS " + world.coins.length);
for (let i = 0; i < world.coins.length; i++) {
  const c = world.coins[i];
  emit("C " + i + " " + d64(c.x) + " " + d64(c.y) + " " + d64(c.z));
}
emit("NPROPS " + world.props.length);
for (let i = 0; i < world.props.length; i++) {
  const p = world.props[i];
  emit("P " + i + " " + p.type + " " + d64(p.x) + " " + d64(p.z) + " " + d64(p.y) +
       " " + d64(p.s) + " " + d64(p.rot) + " " + d64(p.r));
}

/* ---------- terrain queries, including off-grid and out-of-bounds ---------- */
{
  const r = (function (a) { a >>>= 0; return function () { a |= 0; a = (a + 0x6D2B79F5) | 0;
    var t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; })(4242);
  for (let i = 0; i < 3000; i++) {
    const x = (r() * 2 - 1) * 300;      // deliberately past X_HALF
    const z = r() * (def.length + 200) - 80;
    emit("Q " + d64(x) + " " + d64(z) + " " + d64(CORE.heightAt(world, x, z)) +
         " " + d64(CORE.trailDistAt(world, x, z)));
    const n = CORE.normalAt(world, x, z);
    emit("N " + d64(n.x) + " " + d64(n.y) + " " + d64(n.z));
  }
}

/* ---------- AI ghosts ---------- */
for (const key of ["armand", "arthur"]) {
  const g = CORE.simulateAI3(world, CORE.AI3_STYLES[key]);
  emit("AI " + key + " " + g.timeMs + " " + g.score + " " + g.crashes + " " +
       g.coinCount + " " + g.samples.length);
  for (let i = 0; i < g.samples.length; i++) emit("S " + i + " " + g.samples[i].join(","));
  g.track = trackId;
  emit("GCODE " + key + " " + CORE.packGhost3(g));
}

/* ---------- scripted player run ----------
 * The AI never hops, never uses turbo and never does a trick, so it leaves
 * most of stepRider3 untested. This run drives every input.               */
{
  const st = CORE.newRider3(world);
  const taken = new Array(world.coins.length);
  const ev = [];
  const F = ["x","y","z","vx","vy","vz","yaw","airT","crashT","hopCd","trailD","t","finishT",
             "wheelSpin","lean","turboT","turboCd","throttle","pitch","pitchV","spin","spinV"];
  const I = ["crashes","trailIdx","respawnIdx","score","coinCount","bigAirs","coinPtr",
             "turboTaps","turboUses","tricks","trickPts"];
  for (let step = 0; step < 6000; step++) {
    const aloft = !st.onGround;
    const inp = {
      pedal: (step % 97) < 80,
      brake: (step % 211) < 25,
      left:  (step % 53) < 18,
      right: (step % 71) < 15,
      hop:   (step % 137) === 0,
      turbo: (step % 17) === 0
    };
    inp.flipF = aloft && inp.pedal;  inp.flipB = aloft && inp.brake;
    inp.spinL = aloft && inp.left;   inp.spinR = aloft && inp.right;
    ev.length = 0;
    CORE.stepRider3(st, inp, world, ev, taken);
    if (step % 30 === 0) {
      let line = "R " + step;
      for (const f of F) line += " " + d64(st[f]);
      for (const f of I) line += " " + st[f];
      line += " " + (st.onGround ? 1 : 0) + (st.finished ? 1 : 0) + (st.offTrail ? 1 : 0);
      emit(line);
    }
    emit("EV " + step + " " + ev.map((e) => e.t + (e.q ? ":" + e.q : "") +
         (e.why ? ":" + e.why : "") + (e.pts !== undefined ? ":" + e.flips + ":" + e.spins + ":" + e.pts : "")).join("|"));
  }
}

/* ---------- ghost codec round-trip ---------- */
{
  const g = CORE.simulateAI3(world, CORE.AI3_STYLES.armand);
  g.track = trackId;
  const code = CORE.packGhost3(g);
  const back = CORE.unpackGhost3(code);
  emit("ROUNDTRIP " + (back ? back.name + " " + back.track + " " + back.timeMs + " " +
       back.samples.length : "null"));
  for (const bad of ["", "nope", "ZR3G1.", "ZR3G1.!!!!", "ZR3G1." + Buffer.from('{"v":2}').toString("base64")]) {
    emit("REJECT " + JSON.stringify(bad) + " " + (CORE.unpackGhost3(bad) === null ? "null" : "accepted"));
  }
  for (const nm of ["  Armand  ", "<script>x", "", "ThisNameIsFarTooLong", "a_b-c 1"]) {
    emit("SANITIZE " + JSON.stringify(nm) + " " + JSON.stringify(CORE.sanitizeName(nm)));
  }
}

process.stdout.write(out.join("\n") + "\n");
