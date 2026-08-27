/* ==========================================================================
   TRIAL — simulation tests

   The renderer needs a browser, but everything that decides whether the game
   is *fair* lives in js/trial-core.js and runs under plain node. These tests
   pin down the promises the generator makes: one seed is one mountain, the
   line is always clear, and a rider who holds the line can survive every
   feature the generator is willing to build.

       node --test test/
   ========================================================================== */

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const T = require("../js/trial-core.js");

/* ---------- helpers ---------- */

const NO_INPUT = {
  pedal: false, brake: false, left: false, right: false,
  hop: false, flipBack: false, flipFwd: false, whipL: false, whipR: false
};

function world(opts) {
  return T.buildWorld(T.makeSpec(Object.assign(
    { seed: 700123, biome: "nyika", modifier: "none", length: 1200 }, opts)));
}

/* A rider who only tries to stay on the line — no tricks, no heroics. */
function follow(w, opts) {
  opts = opts || {};
  const st = T.newRider(w, { assist: opts.assist !== false });
  if (opts.at !== undefined) {
    const p = w.trail[opts.at], q = w.trail[opts.at + 2];
    st.x = p.x; st.y = p.y; st.z = p.z;
    st.yaw = Math.atan2(q.x - p.x, q.z - p.z);
    st.trailIdx = st.respawnIdx = opts.at;
    const v = opts.speed || 0;
    st.vx = Math.sin(st.yaw) * v;
    st.vz = Math.cos(st.yaw) * v;
  }
  const events = [];
  const until = opts.until || (() => st.finished || st.dead);
  let steps = 0;
  while (!until(st) && steps < 60 * 400) {
    const speed = Math.hypot(st.vx, st.vz);
    const look = st.onGround ? Math.max(3, Math.round(speed * 0.42)) : 3;
    const ahead = w.trail[Math.min(w.trailN - 1, st.trailIdx + look)];
    const far = w.trail[Math.min(w.trailN - 1, st.trailIdx + 14)];
    const want = Math.atan2(ahead.x - st.x, ahead.z - st.z);
    const dyaw = T.wrapPi(want - st.yaw);
    const curve = Math.abs(T.wrapPi(Math.atan2(far.x - ahead.x, far.z - ahead.z) - want));
    const dead = st.onGround ? 0.04 : 0.3;
    const ev = [];
    T.stepRider(st, Object.assign({}, NO_INPUT, {
      pedal: st.onGround && (opts.pedal !== false) && speed < (opts.vMax || 22),
      brake: st.onGround && ((curve > 0.3 && speed > 12) || speed > (opts.vMax || 22)),
      left: dyaw > dead, right: dyaw < -dead
    }), w, ev);
    for (const e of ev) events.push(e);
    steps++;
  }
  return { st, events, steps };
}

/* ---------- one seed is one mountain ---------- */

test("a trail code round-trips to the seed that made it", () => {
  for (const seed of [1, 42, 123456789, T.SEED_MASK, T.dailySeed(new Date(2026, 7, 27))]) {
    assert.strictEqual(T.seedFromCode(T.codeFromSeed(seed)), T.normSeed(seed));
  }
  /* the seed space is exactly what six characters can carry */
  assert.strictEqual(T.SEED_MASK, Math.pow(32, 6) - 1);
});

test("a typed code is always a valid mountain, however mangled", () => {
  for (const typed of ["abc", "5PR-map", "!!!", "zzz-zzz", "0O1I", "a"]) {
    const seed = T.seedFromCode(typed);
    assert.ok(Number.isInteger(seed) && seed >= 0, `${typed} -> ${seed}`);
    assert.doesNotThrow(() => T.buildWorld(T.makeSpec({ seed, biome: "nyika", length: 600 })));
  }
  assert.strictEqual(T.seedFromCode(""), null);
});

test("the same seed builds an identical mountain every time", () => {
  const a = world({ seed: 555001, biome: "batoka" });
  const b = world({ seed: 555001, biome: "batoka" });
  assert.strictEqual(a.trailN, b.trailN);
  assert.strictEqual(a.features.length, b.features.length);
  assert.strictEqual(a.props.length, b.props.length);
  for (let i = 0; i < a.trailN; i += 17) {
    assert.strictEqual(a.trail[i].x, b.trail[i].x);
    assert.strictEqual(a.trail[i].y, b.trail[i].y);
  }
  assert.notStrictEqual(a.trail[100].y, world({ seed: 555002, biome: "batoka" }).trail[100].y);
});

/* ---------- the line is always rideable ---------- */

test("nothing solid ever stands on the trail corridor", () => {
  for (const biome of T.BIOME_ORDER) {
    for (const seed of [11, 2222, 333333]) {
      const w = world({ seed, biome, length: 1200 });
      for (const p of w.props) {
        if (!p.r) continue;                       /* cover and rock-garden stones */
        const d = T.trailDistAt(w, p.x, p.z);
        assert.ok(d >= 10, `${biome}/${seed}: solid ${p.type} only ${d.toFixed(1)} m from the line`);
      }
    }
  }
});

test("rock-garden stones sit on the line but can never be collided with", () => {
  let seen = 0;
  for (const seed of [7, 77, 777, 7777]) {
    const w = world({ seed, biome: "batoka", length: 1400 });
    for (const p of w.props) {
      if (p.type !== "boulder") continue;
      seen++;
      assert.strictEqual(p.r, 0, "a rock garden must be rollable, not fatal");
    }
  }
  assert.ok(seen > 0, "expected at least one rock garden across four Batoka seeds");
});

test("checkpoints never land inside a feature", () => {
  for (const biome of T.BIOME_ORDER) {
    const w = world({ seed: 90210, biome, length: 1500 });
    assert.ok(w.gates.length > 0);
    for (const g of w.gates) {
      for (const f of w.features) {
        assert.ok(g < f.i0 - 3 || g > f.i1 + 3,
          `${biome}: checkpoint ${g} sits inside a ${f.kind} (${f.i0}-${f.i1})`);
      }
    }
  }
});

/* ---------- every feature has to be survivable ---------- */

/* Drop a rider onto the run-in at a fixed speed and see whether holding the
   line is enough. A generator that can build an unrideable jump will. */
function hitFeature(w, f, v0) {
  const start = Math.max(2, f.i0 - Math.round(28 / T.TRAIL_DS));
  const endIdx = Math.min(w.trailN - 2, f.i1 + Math.round(30 / T.TRAIL_DS));
  const { st, events } = follow(w, {
    at: start, speed: v0, vMax: v0,
    until: (s) => s.trailIdx >= endIdx || s.dead || s.bails > 0
  });
  const bail = events.find((e) => e.t === "bail");
  return bail ? bail.why : null;
}

test("kickers, hips, berms and rock gardens are essentially never fatal", () => {
  const tally = {};
  for (const biome of T.BIOME_ORDER) {
    for (const seed of [700001, 707919, 715838]) {
      const w = world({ seed, biome, length: 1300 });
      for (const f of w.features) {
        for (const v of [9, 13, 17, 21, 25]) {
          const t = (tally[f.kind] = tally[f.kind] || { n: 0, fail: 0 });
          t.n++;
          if (hitFeature(w, f, v)) t.fail++;
        }
      }
    }
  }
  /* thresholds are the promise: forgiving features stay forgiving, and the
     two that are allowed to punish you only do so at speed */
  const LIMIT = { kicker: 0.03, hip: 0.03, berm: 0.03, rocks: 0.03, roller: 0.05, drop: 0.10, gap: 0.09 };
  for (const kind of Object.keys(tally)) {
    const { n, fail } = tally[kind];
    assert.ok(n > 0);
    const rate = fail / n;
    assert.ok(rate <= LIMIT[kind],
      `${kind}: ${(rate * 100).toFixed(1)}% bail over ${n} attempts, limit ${LIMIT[kind] * 100}%`);
  }
});

test("a rider riding within themselves reaches the bottom of every biome", () => {
  for (const biome of T.BIOME_ORDER) {
    const w = world({ seed: 424242, biome, length: 1200 });
    /* 50 km/h — quick, but braking for the corners rather than sending it.
       Flat out down a gorge is supposed to hurt; that is what the brake is
       for, and the per-feature test above already covers every speed. */
    const { st } = follow(w, { vMax: 14 });
    assert.ok(st.finished, `${biome}: ended at ${(st.trailIdx / w.finishIdx * 100).toFixed(0)}%`);
    assert.ok(st.finishT > 10 && st.finishT < 400, `${biome}: finished in ${st.finishT}s`);
    assert.ok(st.bails <= 3, `${biome}: ${st.bails} bails at a sensible pace`);
  }
});

test("no landing or open trail breaks sharply enough to launch a rider", () => {
  /* The failure this guards against: a landing ramp that meets the hillside
     at an angle is a kicker in disguise. One did, and it threw riders off
     its own knuckle onto the flat run-in of the next feature — which, with
     the checkpoint sitting between the two, made the run unwinnable. Lips
     and the ramp falling away behind them are deliberate and exempt; the
     landing half of a feature and the open hillside are not. */
  let worst = 0, where = "";
  for (const biome of T.BIOME_ORDER) {
    for (const modifier of ["none", "bigair"]) {
      for (const seed of [424242, 700001, 715838]) {
        const w = world({ seed, biome, modifier, length: 1300 });
        const inside = new Set(), landing = new Set();
        for (const f of w.features) {
          for (let k = f.i0; k <= f.i1; k++) inside.add(k);
          if (f.kind === "roller") continue;       /* whoops are meant to buck you */
          const from = Math.round(f.iLip + (f.i1 - f.iLip) * 0.55);
          for (let k = from; k <= f.i1 + 1; k++) landing.add(k);
        }
        for (let i = 2; i < w.trailN - 3; i++) {
          if (inside.has(i) && !landing.has(i)) continue;
          const s1 = (w.trail[i].y - w.trail[i - 1].y) / T.TRAIL_DS;
          const s2 = (w.trail[i + 1].y - w.trail[i].y) / T.TRAIL_DS;
          if (s1 - s2 > worst) { worst = s1 - s2; where = `${biome}/${modifier}/${seed}@${i}`; }
        }
      }
    }
  }
  assert.ok(worst < 0.5,
    `slope breaks by ${worst.toFixed(2)} (${(Math.atan(worst) * 180 / Math.PI).toFixed(0)} deg) at ${where}`);
});

test("a cautious rider is never trapped in front of a feature", () => {
  /* Regression: on this mountain a rider who braked for the corners could
     not carry enough speed to clear a road gap, cased it, respawned at a
     checkpoint that could not deliver any more speed, and repeated that
     until the bail bar was empty — with no way down the mountain at all. */
  const w = world({ seed: 424242, biome: "kalahari", length: 1200 });
  const { st, events } = follow(w, { vMax: 14 });
  assert.ok(st.finished, `stuck at ${(st.trailIdx / w.finishIdx * 100).toFixed(0)}%`);

  /* and no single spot may account for a pile of bails */
  const spots = {};
  for (const e of events) if (e.t === "bail") spots[e.at || "?"] = (spots[e.at || "?"] || 0) + 1;
  assert.ok(st.bails <= 3, `${st.bails} bails riding within yourself`);
});

/* ---------- tricks ---------- */

/* Put the rider in the air with a known rotation and land them. */
function airborneWith(w, { spin = 0, flip = 0, whip = 0, assist = true }) {
  const st = T.newRider(w, { assist });
  const i = 40;
  const p = w.trail[i], q = w.trail[i + 2];
  /* a jump you could actually take: any higher and the landing bails on
     impact alone, which would tell us nothing about the rotation */
  st.x = p.x; st.z = p.z; st.y = p.y + 3;
  st.yaw = Math.atan2(q.x - p.x, q.z - p.z);
  st.trailIdx = st.respawnIdx = i;
  st.vx = Math.sin(st.yaw) * 14;
  st.vz = Math.cos(st.yaw) * 14;
  st.vy = 4;
  st.onGround = false;
  st.airT = 0.5;
  st.spin = spin; st.flip = flip; st.whip = whip;
  st.whipMax = Math.abs(whip);
  const events = [];
  let steps = 0;
  while (!st.onGround && steps < 600) {
    const ev = [];
    T.stepRider(st, NO_INPUT, w, ev);
    for (const e of ev) events.push(e);
    steps++;
  }
  return { st, events };
}

test("a completed 360 scores; a half-finished one puts you down", () => {
  const w = world({ seed: 31337 });
  const full = airborneWith(w, { spin: Math.PI * 2 });
  const trick = full.events.find((e) => e.t === "trick");
  assert.ok(trick, "a full rotation should land and score");
  assert.ok(/360/.test(trick.name), `expected a 360, got ${trick.name}`);
  assert.ok(trick.pts > 0);

  const half = airborneWith(w, { spin: Math.PI });
  assert.ok(half.events.some((e) => e.t === "bail" && e.why === "rotation"),
    "landing sideways out of a half rotation must bail");
});

test("landing assist widens the window without removing it", () => {
  const w = world({ seed: 31337 });
  /* assist forgives about 117 degrees, riding without it about 58, so the
     value that tells them apart has to sit between the two */
  const sloppy = 1.4;                              /* ~80 degrees off */
  assert.ok(!airborneWith(w, { spin: sloppy, assist: true }).events.some((e) => e.t === "bail"),
    "assist should forgive a sloppy but recognisable landing");
  assert.ok(airborneWith(w, { spin: sloppy, assist: false }).events.some((e) => e.t === "bail"),
    "with assist off the same landing should not be forgiven");
});

test("style refills the bail bar and the combo multiplier compounds", () => {
  const w = world({ seed: 31337 });
  const { st } = airborneWith(w, { spin: Math.PI * 4, flip: Math.PI * 2 });
  assert.ok(st.tricks === 1 && st.style > 0);
  assert.strictEqual(st.combo, 1);

  /* a second trick without touching down for long keeps the chain */
  const before = st.style;
  st.onGround = false; st.y += 3; st.vy = 4; st.airT = 0.5;
  st.spin = Math.PI * 2; st.whipMax = 0; st.flip = 0; st.whip = 0;
  const ev2 = [];
  let steps = 0;
  while (!st.onGround && steps++ < 600) T.stepRider(st, NO_INPUT, w, ev2);
  assert.ok(!ev2.some((e) => e.t === "bail"), "the second jump should be landable");
  assert.strictEqual(st.combo, 2, "chained tricks must stack the multiplier");
  assert.ok(st.style > before);
});

test("the bail bar empties and ends the run", () => {
  const w = world({ seed: 31337 });
  const st = T.newRider(w, { assist: true });
  let guard = 0;
  while (!st.dead && guard++ < 20) {
    st.health = Math.min(st.health, 100);
    st.crashT = 0; st.invuln = 0;
    const ev = [];
    st.y += 40;                                    /* fall onto the mountain */
    st.onGround = false; st.vy = -30; st.airT = 1;
    let steps = 0;
    while (st.onGround === false && steps++ < 400) T.stepRider(st, NO_INPUT, w, ev);
    for (let i = 0; i < 90; i++) T.stepRider(st, NO_INPUT, w, ev);
  }
  assert.ok(st.dead, "enough hard landings must empty the bar");
  assert.strictEqual(st.health, 0);
  assert.ok(st.bails >= 3, `expected several bails before the end, got ${st.bails}`);
});

/* ---------- the career ---------- */

test("a career is five stages of three playable nodes", () => {
  const c = T.makeCareer(20260101);
  assert.strictEqual(c.stages.length, 5);
  const codes = new Set();
  for (const stage of c.stages) {
    assert.strictEqual(stage.nodes.length, 3);
    for (const n of stage.nodes) {
      assert.ok(T.BIOMES[n.biome], `unknown biome ${n.biome}`);
      assert.ok(T.MODIFIERS[n.modifier], `unknown modifier ${n.modifier}`);
      assert.ok(T.objectiveLabel(n).length > 4);
      assert.strictEqual(T.seedFromCode(n.code), n.seed);
      codes.add(n.code);
      assert.ok(n.length > 300 && n.length < 4000);
      assert.ok(n.rep > 0);
    }
  }
  assert.strictEqual(codes.size, 15, "every node should be its own mountain");
});

test("two careers do not share a mountain", () => {
  const a = T.makeCareer(1).stages[0].nodes.map((n) => n.seed);
  const b = T.makeCareer(2).stages[0].nodes.map((n) => n.seed);
  assert.notDeepStrictEqual(a, b);
});

test("objectives read the run the way the results screen does", () => {
  const node = { objective: "style", target: 3000 };
  assert.ok(T.objectiveMet(node, { finished: true, style: 3200 }));
  assert.ok(!T.objectiveMet(node, { finished: true, style: 2999 }));
  assert.ok(!T.objectiveMet(node, { finished: false, style: 9999 }),
    "you cannot clear an objective you did not finish");

  const clean = { objective: "clean", target: 0 };
  assert.ok(T.objectiveMet(clean, { finished: true, bails: 0 }));
  assert.ok(!T.objectiveMet(clean, { finished: true, bails: 1 }));
  assert.match(T.objectiveLabel({ objective: "clean", target: 1 }), /1 bail or fewer/);
  assert.match(T.objectiveLabel({ objective: "clean", target: 2 }), /2 bails or fewer/);
});

/* ---------- modifiers actually modify ---------- */

test("every modifier changes the mountain it is applied to", () => {
  const base = T.makeSpec({ seed: 8080, biome: "nyika", modifier: "none", length: 1400 });
  for (const id of Object.keys(T.MODIFIERS)) {
    if (id === "none") continue;
    const spec = T.makeSpec({ seed: 8080, biome: "nyika", modifier: id, length: 1400 });
    const changed =
      spec.length !== base.length || spec.slope !== base.slope ||
      spec.grip !== base.grip || spec.treeDensity !== base.treeDensity ||
      spec.featureAmp !== base.featureAmp || spec.wobble !== base.wobble ||
      spec.night !== base.night || spec.gateEvery !== base.gateEvery ||
      JSON.stringify(spec.weights) !== JSON.stringify(base.weights);
    assert.ok(changed, `${id} left the spec untouched`);
  }
});

test("every biome names a real ground character and feature mix", () => {
  for (const id of T.BIOME_ORDER) {
    const b = T.BIOMES[id];
    assert.ok(b.name && b.desc, `${id} needs a name and a description`);
    assert.ok(b.theme.rockiness > 0, `${id} needs a rockiness`);
    const total = Object.values(b.weights).reduce((a, x) => a + x, 0);
    assert.ok(total > 0, `${id} has no features`);
  }
});
