/* ==========================================================================
   ORBIT — simulation tests

   The renderer needs a browser, but everything that decides whether the game
   is *fair* lives in js/orbit-core.js and runs under plain node. These tests
   pin down the promises the generator makes: one seed is one sector, the
   line down the middle is always clear — of still rock and tumbling rock
   alike — every frame can be threaded by a hull that rolls to meet it, and
   a pilot who flies the line reaches the refinery every single time.

       node --test test/
   ========================================================================== */

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const O = require("../js/orbit-core.js");

/* ---------- helpers ---------- */

const NO_INPUT = {
  up: false, down: false, left: false, right: false,
  rollL: false, rollR: false, boost: false, brake: false, beam: false
};

function world(opts) {
  return O.buildWorld(O.makeSpec(Object.assign(
    { seed: 812345, sector: "kariba", modifier: "none", length: 3000 }, opts)));
}

/* Fly a sector with the reference pilot — the same one the menu flies. */
function fly(w, opts) {
  opts = opts || {};
  const st = O.newShip(w, { assist: opts.assist !== false, ship: opts.ship || "kite" });
  const events = [];
  let steps = 0;
  while (!st.finished && !st.dead && steps < 60 * 700) {
    events.length = 0;
    O.stepShip(st, O.autoInput(st, w, opts), w, events);
    steps++;
  }
  return { st: st, sum: O.summarise(st, w) };
}

/* Hold one set of keys down from a standstill, facing straight down +z. */
function hold(w, input, ticks, opts) {
  const st = O.newShip(w, opts || {});
  st.q = O.qIdent();
  O.refreshBasis(st);
  st.x = st.y = st.z = 0;
  st.vx = st.vy = st.vz = 0;
  for (let i = 0; i < ticks; i++) O.stepShip(st, Object.assign({}, NO_INPUT, input), w, []);
  return st;
}

/* A spread of seeds that is the same on every machine and every run. */
function seeds(n, salt) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(O.normSeed(1000 + i * 777331 + (salt || 0)));
  return out;
}

const ALL_MODS = Object.keys(O.MODIFIERS);

/* ---------- one seed, one sector ---------- */

test("a flight code round-trips to the seed that made it", () => {
  for (const seed of seeds(40)) {
    const code = O.codeFromSeed(seed);
    assert.match(code, /^[2-9A-HJ-NP-Z]{3}-[2-9A-HJ-NP-Z]{3}$/);
    assert.strictEqual(O.seedFromCode(code), seed);
    assert.strictEqual(O.seedFromCode(code.toLowerCase()), seed);
  }
});

test("a typed code is always a valid sector, however mangled", () => {
  for (const junk of ["", "   ", "!!!", "hello", "0O1I", "zzzzzzzzzzzzzzzz", "5pr map", "🚀"]) {
    const seed = O.seedFromCode(junk);
    if (junk === "") { assert.strictEqual(seed, null); continue; }
    assert.ok(seed >= 1 && seed <= O.SEED_MASK, junk + " -> " + seed);
    const w = world({ seed: seed });
    assert.ok(w.gates.length > 0 && w.rocks.length > 0);
  }
});

test("the same seed builds an identical sector every time", () => {
  for (const sector of O.SECTOR_ORDER) {
    const a = world({ seed: 5150, sector: sector });
    const b = world({ seed: 5150, sector: sector });
    assert.strictEqual(a.rocks.length, b.rocks.length);
    assert.strictEqual(a.gates.length, b.gates.length);
    assert.strictEqual(a.ore.length, b.ore.length);
    for (let i = 0; i < a.rocks.length; i += 7) {
      assert.strictEqual(a.rocks[i].x, b.rocks[i].x);
      assert.strictEqual(a.rocks[i].r, b.rocks[i].r);
    }
    for (let i = 0; i < a.gates.length; i++) {
      assert.strictEqual(a.gates[i].roll, b.gates[i].roll);
      assert.strictEqual(a.gates[i].halfH, b.gates[i].halfH);
    }
    const c = world({ seed: 5151, sector: sector });
    assert.notStrictEqual(a.rocks[10].x, c.rocks[10].x);
  }
});

/* ---------- the line is always clear ---------- */

test("the whole world can be found from a ship's z alone", () => {
  /* Everything — the corridor, the frames, which bucket of rock to test —
     is looked up from z with no searching, which only works while the line
     never leans far enough off +z to double back on itself. */
  for (const sector of O.SECTOR_ORDER) {
    const w = world({ sector: sector, seed: 77123, length: 4800 });
    for (let i = 0; i < w.courseN; i++) {
      assert.ok(w.course[i].tz > 0.88,
        sector + " sample " + i + " leans too far off downrange: tz=" + w.course[i].tz);
      assert.strictEqual(w.course[i].z, i * O.COURSE_DS);
    }
  }
});

test("nothing solid ever stands in the flight corridor", () => {
  const lat = {};
  for (const sector of O.SECTOR_ORDER) {
    for (const modifier of ALL_MODS) {
      const w = world({ sector: sector, modifier: modifier, seed: 424242 });
      assert.ok(w.corridor >= O.MIN_CORRIDOR, sector + "/" + modifier + " corridor collapsed");
      for (let i = 0; i < w.rocks.length; i++) {
        const r = w.rocks[i];
        O.lateralOf(w, r.x, r.y, r.z, lat);
        assert.ok(lat.d >= w.corridor + r.r,
          sector + "/" + modifier + ": rock " + i + " is " + (w.corridor + r.r - lat.d).toFixed(2) +
          "m inside the corridor");
      }
    }
  }
});

test("no tumbling rock ever enters the corridor either, at any moment", () => {
  const lat = {}, p = {};
  for (const sector of O.SECTOR_ORDER) {
    const w = world({ sector: sector, modifier: "swarm", seed: 91117, length: 4200 });
    assert.ok(w.drifters.length > 0);
    for (const d of w.drifters) {
      for (let t = 0; t < 240; t += 0.2) {
        O.drifterAt(w, d, t, p);
        O.lateralOf(w, p.x, p.y, p.z, lat);
        assert.ok(lat.d >= w.corridor + d.r,
          sector + ": a drifter reached " + lat.d.toFixed(1) + "m from the line at t=" + t.toFixed(1));
      }
    }
  }
});

test("copper always sits inside the corridor, never inside a rock", () => {
  const lat = {};
  for (const sector of O.SECTOR_ORDER) {
    const w = world({ sector: sector, modifier: "haul", seed: 31337, length: 4000 });
    assert.ok(w.ore.length > 20, sector + " has almost no copper in it");
    for (const o of w.ore) {
      O.lateralOf(w, o.x, o.y, o.z, lat);
      assert.ok(lat.d < w.corridor,
        sector + ": copper sits " + lat.d.toFixed(1) + "m out, past the " + w.corridor.toFixed(0) + "m corridor");
      for (const r of w.rocks) {
        if (Math.abs(r.z - o.z) > r.r + 2) continue;
        const dx = r.x - o.x, dy = r.y - o.y, dz = r.z - o.z;
        assert.ok(Math.sqrt(dx * dx + dy * dy + dz * dz) > r.r, sector + ": copper buried in a rock");
      }
    }
  }
});

/* ---------- the frames ---------- */

test("every frame sits on the line and squares up to it", () => {
  const lat = {};
  for (const sector of O.SECTOR_ORDER) {
    for (const modifier of ALL_MODS) {
      const w = world({ sector: sector, modifier: modifier, seed: 606060, length: 4200 });
      assert.ok(w.gates.length >= 8, sector + "/" + modifier + " barely has any frames");
      for (const g of w.gates) {
        O.lateralOf(w, g.x, g.y, g.z, lat);
        assert.ok(lat.d < 1e-6, "a frame drifted off the line");
        assert.ok(g.halfH >= O.GATE_MIN_H - 1e-9, "a slot is narrower than the floor");
        assert.ok(g.halfW <= w.corridor, "a frame is wider than the corridor it stands in");
        /* the three axes are a proper frame: mutually square, unit length */
        const dotAB = g.ax * g.bx + g.ay * g.by + g.az * g.bz;
        const dotAT = g.ax * g.tx + g.ay * g.ty + g.az * g.tz;
        assert.ok(Math.abs(dotAB) < 1e-9 && Math.abs(dotAT) < 1e-9);
        assert.ok(Math.abs(Math.hypot(g.ax, g.ay, g.az) - 1) < 1e-9);
      }
    }
  }
});

test("a hull lying along the slot fits every frame the generator builds", () => {
  /* The claim the frames rest on: match the roll and the hull's footprint in
     the narrow direction is its own thickness, with room to spare — for
     every hull on the pad, assist or no assist. */
  for (const sector of O.SECTOR_ORDER) {
    const w = world({ sector: sector, modifier: "dense", seed: 24680, length: 4200 });
    for (const hull of O.SHIP_ORDER) {
      for (const assist of [true, false]) {
        const st = O.newShip(w, { ship: hull, assist: assist });
        for (const g of w.gates) {
          O.aimShipAt(st, g.tx, g.ty, g.tz, g.bx, g.by, g.bz);   /* wings along the slot */
          O.refreshBasis(st);
          const fv = O.footprint(st, g.bx, g.by, g.bz);
          const fu = O.footprint(st, g.ax, g.ay, g.az);
          assert.ok(fv < g.halfH - 1.5, hull + " does not fit the slot in " + sector);
          assert.ok(fu < g.halfW - 1.5, hull + " does not fit the width in " + sector);
        }
      }
    }
  }
});

test("rolling to the slot is what buys the margin", () => {
  const w = world({ sector: "batoka", seed: 5150, length: 3000 });
  const g = w.gates.find((x) => x.halfH < x.halfW * 0.55);
  assert.ok(g, "batoka should build slots, not doorways");
  const st = O.newShip(w, { ship: "hauler", assist: false });

  O.aimShipAt(st, g.tx, g.ty, g.tz, g.bx, g.by, g.bz);
  O.refreshBasis(st);
  const matched = O.footprint(st, g.bx, g.by, g.bz);

  O.aimShipAt(st, g.tx, g.ty, g.tz, g.ax, g.ay, g.az);          /* a quarter turn out */
  O.refreshBasis(st);
  const crossed = O.footprint(st, g.bx, g.by, g.bz);

  assert.ok(crossed > matched * 2, "a quarter turn out should cost most of the slot");
  assert.ok(matched < g.halfH, "squared up, it fits");
});

/* ---------- flying it ---------- */

test("the controls do what the how-to says they do", () => {
  const w = world({ length: 800 });
  assert.ok(hold(w, { up: true }, 30).fwd.y > 0.3, "W should lift the nose");
  assert.ok(hold(w, { down: true }, 30).fwd.y < -0.3, "S should drop it");
  assert.ok(hold(w, { right: true }, 30).fwd.x > 0.25, "D should swing right");
  assert.ok(hold(w, { left: true }, 30).fwd.x < -0.25, "A should swing left");
  assert.ok(hold(w, { rollR: true }, 30).right.y < -0.4, "E should drop the right wing");
  assert.ok(hold(w, { rollL: true }, 30).right.y > 0.4, "Q should lift it");
});

test("attitude stays a unit quaternion through a long tumble", () => {
  const w = world({ length: 800 });
  const st = hold(w, { up: true, right: true, rollR: true }, 60 * 120);
  const n = Math.hypot(st.q.x, st.q.y, st.q.z, st.q.w);
  assert.ok(Math.abs(n - 1) < 1e-9, "quaternion drifted to " + n);
  assert.ok(Math.abs(Math.hypot(st.fwd.x, st.fwd.y, st.fwd.z) - 1) < 1e-9);
  const dot = st.fwd.x * st.up.x + st.fwd.y * st.up.y + st.fwd.z * st.up.z;
  assert.ok(Math.abs(dot) < 1e-9, "the hull sheared");
});

test("no sector Orbit builds is unflyable", () => {
  /* Every sector, every twist, every hull, assist on and off: a pilot who
     holds the line reaches the refinery with shield to spare. */
  for (const seed of seeds(2, 17)) {
    for (const sector of O.SECTOR_ORDER) {
      for (const modifier of ALL_MODS) {
        for (const assist of [true, false]) {
          const w = world({ seed: seed, sector: sector, modifier: modifier, length: 3400 });
          const r = fly(w, { assist: assist });
          const where = sector + "/" + modifier + (assist ? "/assist" : "/free") + " seed " + seed;
          assert.ok(r.sum.finished, where + " never reached the refinery (" + r.sum.why + ")");
          assert.ok(r.sum.shield > r.sum.maxShield * 0.5, where + " arrived on " +
            r.sum.shield.toFixed(0) + " shield");
        }
      }
    }
  }
});

test("holding the line threads the frames", () => {
  /* The frames sit on the line, so flying the line is the technique — with
     the assist on, the reference pilot gets through most of them. */
  for (const seed of seeds(3, 5)) {
    for (const sector of O.SECTOR_ORDER) {
      const w = world({ seed: seed, sector: sector, length: 3400 });
      const r = fly(w, { assist: true });
      assert.ok(r.sum.gates >= r.sum.gatesTotal * 0.7,
        sector + " seed " + seed + ": only " + r.sum.gates + " of " + r.sum.gatesTotal + " frames");
      assert.ok(r.sum.gatesClean > 0, sector + " never once squared one up");
    }
  }
});

test("flight assist damps the drift without removing it", () => {
  const w = world({ length: 1200 });
  function drift(assist) {
    const st = O.newShip(w, { assist: assist });
    st.q = O.qIdent(); O.refreshBasis(st);
    st.x = st.y = st.z = 0;
    st.vx = 40; st.vy = 0; st.vz = 60;         /* thrown sideways */
    for (let i = 0; i < 45; i++) O.stepShip(st, NO_INPUT, w, []);
    return st.x;
  }
  const assisted = drift(true), free = drift(false);
  assert.ok(free > assisted * 1.5, "free flight should carry the drift further");
  assert.ok(assisted > 0.5, "the assist is a damper, not a handbrake");
});

/* ---------- shield, score and heat ---------- */

test("a clean thread scores more and mends more than a scrape", () => {
  const w = world({ sector: "kariba", seed: 5150 });
  function through(offsetV) {
    const g = w.gates[0];
    const st = O.newShip(w, { assist: true });
    O.aimShipAt(st, g.tx, g.ty, g.tz, g.bx, g.by, g.bz);
    O.refreshBasis(st);
    st.x = g.x + g.bx * offsetV - g.tx * 40;
    st.y = g.y + g.by * offsetV - g.ty * 40;
    st.z = g.z + g.bz * offsetV - g.tz * 40;
    st.vx = g.tx * 70; st.vy = g.ty * 70; st.vz = g.tz * 70;
    st.gateNext = 0;
    st.shield = st.maxShield - 20;
    const events = [];
    let score = 0, mend = 0;
    for (let i = 0; i < 60 && !st.gateState[0]; i++) {
      /* measure the frame's own award: a lump of copper scooped on the way
         in would otherwise be counted as part of it */
      const s0 = st.score, h0 = st.shield;
      events.length = 0;
      O.stepShip(st, NO_INPUT, w, events);
      if (events.some((e) => e.t === "gate")) { score = st.score - s0; mend = st.shield - h0; }
    }
    return { st: st, ev: events.filter((e) => e.t === "gate")[0], score: score, mend: mend };
  }
  const centred = through(0);
  const edge = through(w.gates[0].halfH * 0.75);
  assert.ok(centred.ev && centred.ev.clean, "dead centre and squared up is a clean thread");
  assert.ok(edge.ev && !edge.ev.clean, "scraping the edge is not");
  assert.ok(centred.score > edge.score * 1.8, "clean should be worth a lot more");
  assert.ok(centred.mend > edge.mend, "and should mend more");
  assert.strictEqual(centred.st.gates, 1);
});

test("the combo multiplier compounds, and a knock resets it", () => {
  const w = world({ seed: 5150 });
  const r = fly(w, { assist: true });
  assert.ok(r.sum.combo >= 6, "threading frames back to back should stack the multiplier");

  const st = O.newShip(w, { assist: true });
  st.combo = 9; st.comboT = 5;
  assert.ok(O.multiplier(st) > 2.5);
  const events = [];
  /* park the hull inside a rock and let the collision test find it */
  const rock = w.rocks[40];
  st.x = rock.x; st.y = rock.y; st.z = rock.z;
  O.stepShip(st, NO_INPUT, w, events);
  assert.ok(events.some((e) => e.t === "hit"), "that should have hurt");
  assert.strictEqual(st.combo, 0, "a knock ends the run of frames");
  assert.strictEqual(O.multiplier(st), 1);
});

test("the shield empties and ends the run", () => {
  const w = world({ seed: 5150 });
  const st = O.newShip(w, { assist: true });
  const events = [];
  let guard = 0;
  while (!st.dead && guard++ < 400) {
    const rock = w.rocks[(guard * 13) % w.rocks.length];
    st.x = rock.x; st.y = rock.y; st.z = rock.z;
    st.vx = 0; st.vy = 0; st.vz = 120;
    st.stunT = 0;
    events.length = 0;
    O.stepShip(st, NO_INPUT, w, events);
  }
  assert.ok(st.dead, "enough knocks should end it");
  assert.strictEqual(st.deadWhy, "shield");
  assert.ok(st.shield <= 0);
});

test("boost heats up, overheats, and stays locked until it has cooled", () => {
  const w = world({ length: 6000 });
  const st = O.newShip(w, { assist: true });
  const events = [];
  let ticks = 0;
  while (!st.overheat && ticks++ < 60 * 20) O.stepShip(st, Object.assign({}, NO_INPUT, { boost: true }), w, events);
  assert.ok(st.overheat, "holding the boost should cook it");
  assert.ok(events.some((e) => e.t === "overheat"));
  assert.ok(st.heat >= 1);

  /* still holding it down, and it must refuse to light */
  for (let i = 0; i < 30; i++) O.stepShip(st, Object.assign({}, NO_INPUT, { boost: true }), w, events);
  assert.strictEqual(st.boosting, false, "an overheated drive stays out");
  assert.ok(st.heat < 1, "and cools even with the key held");

  let cool = 0;
  while (st.overheat && cool++ < 60 * 20) O.stepShip(st, NO_INPUT, w, events);
  assert.ok(!st.overheat && st.boosting === false);
});

test("copper is scooped by flying through it, and the beam opens a vein", () => {
  const w = world({ sector: "copperbelt", seed: 5150, modifier: "haul" });
  const st = O.newShip(w, { assist: true });
  const o = w.ore[12];
  st.x = o.x; st.y = o.y; st.z = o.z;
  const events = [];
  O.stepShip(st, NO_INPUT, w, events);
  assert.strictEqual(st.ore, 1);
  assert.ok(events.some((e) => e.t === "ore"));

  const vein = w.rocks.findIndex((r) => r.vein);
  assert.ok(vein >= 0, "the Copperbelt should have veins in it");
  const rock = w.rocks[vein];
  const st2 = O.newShip(w, { assist: true });
  st2.x = rock.x; st2.y = rock.y; st2.z = rock.z - 40;
  st2.vx = st2.vy = st2.vz = 0;
  O.aimShipAt(st2, rock.x - st2.x, rock.y - st2.y, rock.z - st2.z, 0, 1, 0);
  O.refreshBasis(st2);
  const ev2 = [];
  const before = st2.ore;
  for (let i = 0; i < Math.ceil(O.BEAM_TIME * 60) + 4; i++) {
    st2.vx = st2.vy = st2.vz = 0;                    /* hold station on the rock */
    O.stepShip(st2, Object.assign({}, NO_INPUT, { beam: true }), w, ev2);
  }
  assert.ok(st2.cracked[vein], "the beam should have opened it");
  assert.ok(st2.ore > before + 1, "and a vein is worth more than a loose lump");
  assert.ok(ev2.some((e) => e.t === "crack"));
});

test("leaving the survey ends the run, but not immediately", () => {
  const w = world({ seed: 5150 });
  const st = O.newShip(w, { assist: true });
  const events = [];
  st.x += w.strayLimit + 40;
  O.stepShip(st, NO_INPUT, w, events);
  assert.ok(st.stray, "it should say so at once");
  assert.ok(events.some((e) => e.t === "stray" && e.on));
  assert.ok(!st.dead, "and give you time to turn round");

  let ticks = 0;
  while (!st.dead && ticks++ < 60 * 30) {
    st.x = w.course[st.courseIdx].x + w.strayLimit + 40;
    O.stepShip(st, NO_INPUT, w, events);
  }
  assert.ok(st.dead && st.deadWhy === "lost");
  assert.ok(ticks * O.DT >= O.STRAY_GRACE - 0.2, "the grace period should be real");
});

/* ---------- the career ---------- */

test("a career is five stages of three flyable nodes", () => {
  const career = O.makeCareer(20260101);
  assert.strictEqual(career.stages.length, 5);
  for (const stage of career.stages) {
    assert.strictEqual(stage.nodes.length, 3);
    for (const node of stage.nodes) {
      assert.ok(O.SECTORS[node.sector], "unknown sector " + node.sector);
      assert.ok(O.MODIFIERS[node.modifier], "unknown twist " + node.modifier);
      assert.ok(O.OBJECTIVES[node.objective], "unknown objective " + node.objective);
      assert.strictEqual(O.seedFromCode(node.code), node.seed);
      assert.ok(node.rep > 0);
      assert.ok(typeof O.objectiveLabel(node) === "string" && O.objectiveLabel(node).length > 4);
      const w = world({ seed: node.seed, sector: node.sector, modifier: node.modifier, length: node.length });
      assert.ok(w.gates.length > 4, node.id + " has nothing to thread");
      if (node.objective === "gates") {
        assert.ok(node.target <= w.gates.length,
          node.id + " asks for " + node.target + " frames out of " + w.gates.length);
      }
    }
  }
});

test("two careers do not share a sector", () => {
  const a = O.makeCareer(20260101), b = O.makeCareer(777);
  const codesA = a.stages.flatMap((s) => s.nodes.map((n) => n.code));
  const codesB = b.stages.flatMap((s) => s.nodes.map((n) => n.code));
  assert.strictEqual(codesA.filter((c) => codesB.includes(c)).length, 0);
});

test("objectives read the run the way the results screen does", () => {
  const career = O.makeCareer(20260101);
  const node = career.stages[0].nodes[0];
  const w = world({ seed: node.seed, sector: node.sector, modifier: node.modifier, length: node.length });
  const r = fly(w, { assist: true });
  assert.ok(r.sum.finished);
  assert.strictEqual(O.objectiveMet(node, r.sum), true, "stage one should be clearable by flying the line");

  const unfinished = Object.assign({}, r.sum, { finished: false });
  for (const stage of career.stages) {
    for (const n of stage.nodes) assert.strictEqual(O.objectiveMet(n, unfinished), false);
  }
  /* the live bar and the results screen must agree about what counts */
  const scoreNode = { objective: "score", target: 100 };
  assert.strictEqual(O.objectiveProgress(scoreNode, { score: 50 }), 0.5);
  assert.strictEqual(O.objectiveProgress(scoreNode, { score: 400 }), 1);
  assert.strictEqual(O.objectiveProgress({ objective: "clean", target: 1 }, { hits: 2 }), 0);
});

test("hulls are earned with rep, never bought", () => {
  assert.deepStrictEqual(O.shipsFor(0), ["kite"]);
  assert.ok(O.shipsFor(1000).includes("hauler"));
  assert.deepStrictEqual(O.shipsFor(99999), O.SHIP_ORDER);
  for (const id of O.SHIP_ORDER) {
    const s = O.SHIPS[id];
    assert.ok(s.name && s.desc && s.shield > 0 && s.span > 0 && s.height > 0);
  }
});

/* ---------- the recipes themselves ---------- */

test("every twist changes the sector it is applied to", () => {
  const base = world({ seed: 5150, sector: "copperbelt", length: 3400 });
  for (const id of ALL_MODS) {
    if (id === "none") continue;
    const w = world({ seed: 5150, sector: "copperbelt", modifier: id, length: 3400 });
    const changed =
      w.rocks.length !== base.rocks.length ||
      w.gates.length !== base.gates.length ||
      w.drifters.length !== base.drifters.length ||
      w.currents.length !== base.currents.length ||
      w.corridor !== base.corridor ||
      w.length !== base.length ||
      w.scoreBonus !== base.scoreBonus ||
      w.spec.cruise !== base.spec.cruise;
    assert.ok(changed, "the " + id + " twist changes nothing");
    assert.ok(O.MODIFIERS[id].name && O.MODIFIERS[id].desc && O.MODIFIERS[id].icon);
  }
});

test("every sector names a real belt and a real sky", () => {
  for (const id of O.SECTOR_ORDER) {
    const s = O.SECTORS[id];
    assert.strictEqual(s.id, id);
    assert.ok(s.name && s.short && s.desc.length > 30);
    assert.ok(s.corridor >= O.MIN_CORRIDOR && s.shell > s.corridor);
    assert.ok(s.rockMax > s.rockMin && s.gateW > 0 && s.gateSlot > 0 && s.gateSlot <= 1);
    assert.ok(s.cruise > 40 && s.cruise < 200);
    for (const key of ["space", "nebulaA", "sun", "ambient", "rock", "ore", "gate", "planet"]) {
      assert.strictEqual(typeof s.theme[key], "number", id + " theme is missing " + key);
    }
  }
  for (const stage of O.STAGE_PLAN) {
    for (const id of stage.pool) assert.ok(O.SECTORS[id], "stage plan names " + id);
    for (const id of stage.mods) assert.ok(O.MODIFIERS[id], "stage plan names twist " + id);
  }
});

test("today's belt is the same belt all day, and a new one tomorrow", () => {
  const a = O.dailySeed(new Date(2026, 8, 3, 6, 0, 0));
  const b = O.dailySeed(new Date(2026, 8, 3, 23, 59, 0));
  const c = O.dailySeed(new Date(2026, 8, 4, 0, 1, 0));
  assert.strictEqual(a, b);
  assert.notStrictEqual(a, c);
  assert.strictEqual(O.seedFromCode(O.codeFromSeed(a)), a);
});
