/* ==========================================================================
   THE GREAT ZAMBIA TOUR — a ten-stage rally around the whole country

   Inspired by the old Mille Miglia road races: you ride a long loop in legs,
   the clock never stops between them, and what happens in the workshop
   between stages matters as much as what happens on the trail.

   The rules we borrowed:
     · your race number IS your start time (car 722 left at 07:22)
     · finish a leg, earn money, spend it on repairs and spares
     · you may only CARRY a few spares, so choosing is the game
     · a mechanical costs you time, not your tour

   The rules we deliberately did NOT borrow: instant game-over on a missing
   part, and unsignposted random breakdowns. Kids get a visible condition
   bar, a stated risk, and a bad leg is never the end of the road.

   This file is pure data + arithmetic: no DOM, no Three.js. It registers its
   stages into the shared track table so the existing world builder, physics
   and renderer handle them with no special cases. Runs under node for tests.
   ========================================================================== */

(function () {
  "use strict";

  /* ---------- shared look-up tables ---------- */

  /* how hard each surface is on a bike, and how it rides */
  var SURFACES = {
    tarmac: { label: "Tarmac", wear: 0.55, note: "Smooth and fast" },
    gravel: { label: "Gravel", wear: 1.0, note: "Loose over hard" },
    sand: { label: "Sand", wear: 1.15, note: "Heavy going" },
    rock: { label: "Rock", wear: 1.5, note: "Punishing" },
    mud: { label: "Black cotton", wear: 1.3, note: "Sticky when wet" },
    grass: { label: "Grass", wear: 0.75, note: "Soft and forgiving" }
  };

  /* grip feeds the bike's steering and braking, rainK how hard it is coming
     down, bolts whether there is lightning about */
  var WEATHER = {
    dry: { label: "Dry", icon: "☀️", grip: 1, wear: 1, rainK: 0, bolts: 0 },
    dust: { label: "Dusty", icon: "🌪️", grip: 0.97, wear: 1.15, rainK: 0, bolts: 0 },
    hot: { label: "Hot haze", icon: "🔥", grip: 1, wear: 1.08, rainK: 0, bolts: 0 },
    rain: { label: "Rain", icon: "🌧️", grip: 0.92, wear: 1.25, rainK: 1, bolts: 1 },
    mist: { label: "Mist", icon: "🌫️", grip: 0.96, wear: 1.05, rainK: 0.35, bolts: 0 },
    dusk: { label: "Falling light", icon: "🌆", grip: 0.98, wear: 1, rainK: 0, bolts: 0 }
  };

  /* the spares a rider can carry — one of each, six slots in the bag */
  var SPARES = {
    tube: { name: "Inner tube", kwacha: 70, fixes: "puncture", icon: "🛞",
      desc: "The one nobody regrets carrying." },
    patch: { name: "Patch kit", kwacha: 45, fixes: "puncture", icon: "🩹",
      desc: "Slower than a tube, but it never runs out." },
    tyre: { name: "Spare tyre", kwacha: 150, fixes: "cut", icon: "⭕",
      desc: "For when a rock opens the casing itself." },
    pads: { name: "Brake pads", kwacha: 95, fixes: "brakes", icon: "🛑",
      desc: "Long descents eat these alive." },
    chain: { name: "Chain link", kwacha: 60, fixes: "chain", icon: "⛓️",
      desc: "A snapped chain ends a leg. This ends the snap." },
    spoke: { name: "Spare spokes", kwacha: 55, fixes: "wheel", icon: "🕸️",
      desc: "A wheel with a broken spoke goes out of true fast." },
    cable: { name: "Gear cable", kwacha: 50, fixes: "gears", icon: "🧵",
      desc: "Cheap, light, and the difference between gears and no gears." },
    bearing: { name: "Hub bearings", kwacha: 120, fixes: "bearing", icon: "⚙️",
      desc: "Grit gets in. Bearings grind. Everything slows." },
    pump: { name: "Frame pump", kwacha: 80, fixes: "puncture", icon: "💨",
      desc: "A tube is no use if you cannot put air in it." }
  };

  var BAG_SLOTS = 6;          /* how many spares fit in the bag */

  /* the mechanicals that can strike, and which spare answers them */
  var FAULTS = [
    { id: "puncture", name: "Puncture", icon: "🛞", lostS: 45,
      story: "A thorn through the tread." },
    { id: "chain", name: "Snapped chain", icon: "⛓️", lostS: 70,
      story: "The chain let go under a hard pedal." },
    { id: "brakes", name: "Worn-out pads", icon: "🛑", lostS: 55,
      story: "The pads went to metal on the descent." },
    { id: "wheel", name: "Broken spoke", icon: "🕸️", lostS: 60,
      story: "A spoke pinged and the wheel went out of true." },
    { id: "gears", name: "Snapped gear cable", icon: "🧵", lostS: 50,
      story: "The cable frayed through at the shifter." },
    { id: "cut", name: "Cut tyre", icon: "⭕", lostS: 80,
      story: "A rock opened the casing right up." },
    { id: "bearing", name: "Grinding bearings", icon: "⚙️", lostS: 65,
      story: "Grit got into the hub and the wheel started dragging." }
  ];

  /* ---------- the ten stages ---------- */

  function theme(o) {
    /* fill in the shared defaults so each stage only states what it changes */
    var base = {
      sky: 0xBFE8F2, skyLow: 0xFFF6D9, fog: 0xD8EFDC, fogNear: 60, fogFar: 420,
      sun: 0xFFF7DC, sunPos: [140, 220, -160], ambient: 0x9CC5A8,
      turbidity: 4, rayleigh: 1.4, mieCoeff: 0.003, mieG: 0.78,
      cloudCover: 0.4, exposure: 0.52,
      grass: 0x4E9B58, grassDry: 0x7FAE5A, dirt: 0x8A6238, dirtDark: 0x6B4826,
      rock: 0x8B8570, trunk: 0x5A4028, canopy: 0x2F7A44, canopy2: 0x57944B,
      accent: 0xE8791D, water: 0x6FBFB4
    };
    Object.keys(o).forEach(function (k) { base[k] = o[k]; });
    return base;
  }

  var STAGES = [
    {
      id: "gt1", n: 1, name: "Mosi-oa-Tunya Dash",
      from: "Livingstone", to: "The Falls", surface: "tarmac", weather: "dry",
      blurb: "The tour always starts here, rolling out of Livingstone at dawn with the spray of the falls already standing in the sky ahead of you. Short, fast, and a gentle way to find your legs.",
      seed: 30110101, length: 1300, slope: 0.09, wobble: 0.8, kickerEvery: 150,
      gorge: { fromFrac: 0.82, offset: 32, width: 95, depth: 60 },
      hazards: [{ type: "antelope", from: 300, every: 380, lat: 2.4, spread: 1.4, r: 1.0 }],
      pool: [["miombo", 4, 2.0], ["palm", 2, 1.4], ["rock", 3, 1.4], ["fern", 3, 0], ["grass", 3, 0], ["bush", 1, 0]],
      fauna: ["antelope", "elephant", "rhino"],
      theme: theme({ fog: 0xCDE9E2, water: 0xBFE8E2, canopy: 0x2A6E48 })
    },
    {
      id: "gt2", n: 2, name: "Zambezi Bank Run",
      from: "The Falls", to: "Kazungula", surface: "sand", weather: "hot",
      blurb: "Downstream along the great river, where the bank is sand, the reeds are taller than you, and the crocodiles have the best sunbathing spots on the whole tour. Do not take the shortcut through the water.",
      seed: 30110202, length: 1650, slope: 0.055, wobble: 0.8, kickerEvery: 160,
      river: { offset: 24, width: 70, depth: 2.2 },
      hazards: [{ type: "hippo", from: 240, every: 300, lat: 2.6, spread: 1.6, r: 1.5 }],
      pool: [["palm", 3, 1.4], ["miombo", 3, 2.0], ["reed", 3, 0], ["bush", 2, 0], ["grass", 3, 0], ["rock", 1, 1.1]],
      fauna: ["elephant", "antelope", "zebra"],
      theme: theme({ sky: 0xC2E4EE, skyLow: 0xF5E6B8, fog: 0xD8E4C4, fogFar: 450,
        sunPos: [-150, 130, -260], grass: 0x3E8E52, grassDry: 0x8AA84E,
        water: 0x2E6E5E, sand: 0xD8C08A, exposure: 0.56 })
    },
    {
      id: "gt3", n: 3, name: "Choma Cattle Trails",
      from: "Kazungula", to: "Choma", surface: "grass", weather: "dust",
      blurb: "Up onto the Southern plateau on the paths the cattle wore in first. Wide, dry, quick country — the fastest average speed of the whole tour if you keep off the brakes.",
      seed: 30110303, length: 1750, slope: 0.075, wobble: 1.05, kickerEvery: 120,
      hazards: [{ type: "antelope", from: 220, every: 260, lat: 2.2, spread: 1.5, r: 1.0 }],
      pool: [["miombo", 2, 2.0], ["baobab", 1, 2.4], ["bush", 3, 0], ["grass", 5, 0], ["rock", 1, 1.1]],
      fauna: ["zebra", "antelope", "antelope"],
      theme: theme({ sky: 0xD8E8F0, skyLow: 0xFFF0C8, fog: 0xE4E0C0, fogFar: 520,
        grass: 0x9AA84E, grassDry: 0xC2B45E, dirt: 0x9A7040, dirtDark: 0x77522C,
        canopy: 0x6E8A44, canopy2: 0x88A055, cloudCover: 0.18, exposure: 0.5 })
    },
    {
      id: "gt4", n: 4, name: "Kafue Flats Crossing",
      from: "Choma", to: "Kafue", surface: "mud", weather: "rain",
      blurb: "The flats flood every year and the lechwe follow the water. Flat, black cotton soil that turns to glue in the rain, and hippo pods where you least want them. Grip is down: brake earlier than feels sensible.",
      seed: 30110404, length: 1550, slope: 0.04, wobble: 0.7, kickerEvery: 200,
      river: { offset: 30, width: 80, depth: 2.0 },
      hazards: [{ type: "hippo", from: 200, every: 250, lat: 2.5, spread: 1.5, r: 1.5 }],
      pool: [["reed", 4, 0], ["palm", 2, 1.4], ["grass", 4, 0], ["bush", 2, 0], ["miombo", 1, 2.0]],
      fauna: ["antelope", "antelope", "elephant"],
      theme: theme({ sky: 0x9EB0B8, skyLow: 0xC8CFC8, fog: 0xB8C4BC, fogNear: 40, fogFar: 330,
        sun: 0xDCE4DC, sunPos: [-120, 150, -240], cloudCover: 0.75, turbidity: 8,
        grass: 0x4A7C4E, grassDry: 0x6E8A50, dirt: 0x4E4038, dirtDark: 0x362C26,
        water: 0x4A6E66, groundMist: true, exposure: 0.5, ridgeDim: 0.3 })
    },
    {
      id: "gt5", n: 5, name: "Lusaka Ridge",
      from: "Kafue", to: "Lusaka", surface: "rock", weather: "hot",
      blurb: "The rocky shoulder above the capital. Technical, broken and hard on a bike — this is the leg that eats brake pads and finds every weakness you did not fix in the workshop.",
      seed: 30110505, length: 1600, slope: 0.125, wobble: 1.15, kickerEvery: 100,
      hazards: [{ type: "elephant", from: 320, every: 360, lat: 3.0, spread: 1.5, r: 1.8 }],
      pool: [["rock", 5, 1.4], ["miombo", 3, 2.0], ["bush", 2, 0], ["grass", 2, 0], ["fern", 1, 0]],
      fauna: ["antelope", "zebra"],
      theme: theme({ sky: 0xC8DCE8, skyLow: 0xFFE8B8, fog: 0xD4CBB0, fogFar: 400,
        grass: 0x7E8A4A, grassDry: 0xA89A52, dirt: 0x8A6A44, dirtDark: 0x64472C,
        rock: 0x8E8878, canopy: 0x4E7A44, canopy2: 0x6E9450, exposure: 0.5 })
    },
    {
      id: "gt6", n: 6, name: "Copperbelt Red Roads",
      from: "Lusaka", to: "Ndola", surface: "gravel", weather: "dust",
      blurb: "North into the copper country, where the earth is properly red and the old mine dumps stand on the skyline like flat-topped hills. Long, rolling, relentless — the leg where the tour is usually won or lost.",
      seed: 30110606, length: 1900, slope: 0.085, wobble: 0.95, kickerEvery: 130,
      hazards: [{ type: "antelope", from: 260, every: 300, lat: 2.3, spread: 1.5, r: 1.0 }],
      pool: [["miombo", 5, 2.0], ["bush", 2, 0], ["grass", 3, 0], ["rock", 2, 1.2]],
      fauna: ["antelope", "zebra", "elephant"],
      theme: theme({ sky: 0xD0DCE0, skyLow: 0xFFDCA8, fog: 0xD8B896, fogFar: 430,
        sun: 0xFFEDC8, grass: 0x6E8A4A, grassDry: 0x94964E,
        dirt: 0xA85A28, dirtDark: 0x7E3E18, rock: 0x8A6248,
        canopy: 0x3F7A46, canopy2: 0x5E9450, cloudCover: 0.25, exposure: 0.5 })
    },
    {
      id: "gt7", n: 7, name: "Kasanka Bat Storm",
      from: "Ndola", to: "Kasanka", surface: "grass", weather: "dusk",
      blurb: "You reach the swamp forest exactly at dusk, which is when ten million straw-coloured fruit bats come off the roost at once. Riders say you feel the air move before you see them. Keep your eyes on the trail.",
      seed: 30110707, length: 1500, slope: 0.05, wobble: 0.85, kickerEvery: 140,
      hazards: [{ type: "antelope", from: 240, every: 330, lat: 2.2, spread: 1.5, r: 1.0 }],
      pool: [["miombo", 4, 2.0], ["palm", 2, 1.4], ["reed", 3, 0], ["fern", 3, 0], ["grass", 2, 0], ["bush", 2, 0]],
      fauna: ["antelope", "antelope", "elephant"],
      theme: theme({ sky: 0x4A3E68, skyLow: 0xF2A05C, fog: 0x9A8A96, fogNear: 45, fogFar: 300,
        sun: 0xFFB877, sunPos: [-170, 38, -250], ambient: 0xA89AB0,
        turbidity: 6, rayleigh: 3.2, mieCoeff: 0.009, mieG: 0.85, cloudCover: 0.25,
        grass: 0x2E6E44, grassDry: 0x6E8448, dirt: 0x6B4E36, dirtDark: 0x4E3826,
        trunk: 0x4A3828, canopy: 0x1F5438, canopy2: 0x2E6E44, water: 0x2E5E56,
        bats: true, groundMist: true, cloudTint: 0xD9A8A0, ridgeDim: 0.45, exposure: 0.56 })
    },
    {
      id: "gt8", n: 8, name: "Bangweulu Shoebill Marsh",
      from: "Kasanka", to: "Bangweulu", surface: "mud", weather: "mist",
      blurb: "\"Where the water meets the sky.\" A dawn crossing of the great marsh on causeways barely wider than your handlebars, in mist thick enough to hide the shoebill storks until you are past them.",
      seed: 30110808, length: 1450, slope: 0.035, wobble: 0.75, kickerEvery: 190,
      river: { offset: 26, width: 90, depth: 1.8 },
      hazards: [{ type: "hippo", from: 210, every: 260, lat: 2.4, spread: 1.4, r: 1.5 }],
      pool: [["reed", 5, 0], ["grass", 4, 0], ["palm", 2, 1.4], ["bush", 2, 0]],
      fauna: ["antelope", "elephant"],
      theme: theme({ sky: 0xC4CFD8, skyLow: 0xF0E0D0, fog: 0xCFD6D2, fogNear: 30, fogFar: 260,
        sun: 0xFFE8CC, sunPos: [-160, 60, -250], ambient: 0xB4BCC0,
        turbidity: 7, rayleigh: 2.4, cloudCover: 0.5,
        grass: 0x4E8A56, grassDry: 0x86A056, dirt: 0x5E4E3A, dirtDark: 0x42342A,
        water: 0x5E8078, groundMist: true, exposure: 0.54, ridgeDim: 0.25 })
    },
    {
      id: "gt9", n: 9, name: "Luangwa Valley Run",
      from: "Bangweulu", to: "South Luangwa", surface: "sand", weather: "hot",
      blurb: "Down the escarpment into the valley, where the sand is deep in the riverbeds and the elephants have absolute right of way. Black rhino were brought back to North Luangwa after Zambia lost every last one, and this is the only leg of the tour where you might meet one. The wildest day on the road.",
      seed: 30110909, length: 1800, slope: 0.115, wobble: 1.1, kickerEvery: 110,
      hazards: [
        { type: "elephant", from: 240, every: 300, lat: 3.0, spread: 1.6, r: 1.8 },
        { type: "croc", from: 420, every: 460, lat: 2.0, spread: 1.5, r: 1.05 },
        { type: "rhino", from: 620, every: 520, lat: 2.9, spread: 1.4, r: 1.7 }
      ],
      pool: [["baobab", 2, 2.4], ["miombo", 3, 2.0], ["bush", 3, 0], ["grass", 3, 0], ["rock", 2, 1.2]],
      fauna: ["elephant", "giraffe", "zebra", "antelope", "rhino"],
      theme: theme({ sky: 0xF0D8A8, skyLow: 0xFFD088, fog: 0xE0B888, fogFar: 470,
        sun: 0xFFE9B0, sunPos: [-200, 90, -270], ambient: 0xD9B08C,
        turbidity: 7, cloudCover: 0.15, sunI: 1.5, hemiGround: 0x7A5A30,
        grass: 0xA8933E, grassDry: 0xC2A94E, dirt: 0xA07A48, dirtDark: 0x765430,
        trunk: 0x6E4A26, canopy: 0x6E7A38, canopy2: 0x8A9448, sand: 0xE0C898,
        exposure: 0.48 })
    },
    {
      id: "gt10", n: 10, name: "The Long Road Home",
      from: "South Luangwa", to: "Livingstone", surface: "gravel", weather: "dry",
      blurb: "The final leg, and the longest. Everything you fixed, everything you skipped, and everything still in your bag decides how this one ends. Ride it home and your name goes on the Tour board.",
      seed: 30111010, length: 2000, slope: 0.1, wobble: 1.05, kickerEvery: 120,
      hazards: [
        { type: "hippo", from: 280, every: 340, lat: 2.6, spread: 1.5, r: 1.5 },
        { type: "elephant", from: 520, every: 520, lat: 3.0, spread: 1.5, r: 1.8 }
      ],
      pool: [["baobab", 2, 2.4], ["miombo", 3, 2.0], ["palm", 1, 1.4], ["bush", 2, 0], ["grass", 3, 0], ["rock", 1, 1.2]],
      fauna: ["giraffe", "elephant", "zebra", "antelope"],
      theme: theme({ sky: 0xFFC969, skyLow: 0xF7B733, fog: 0xE09B55, fogNear: 80, fogFar: 480,
        sun: 0xFFE9B0, sunPos: [-200, 70, -280], ambient: 0xD9B08C,
        sunI: 1.6, hemiI: 1.05, hemiGround: 0x7A5A30, cloudTint: 0xFFD9C0,
        turbidity: 7, rayleigh: 1.7, mieCoeff: 0.0035, cloudCover: 0.22,
        grass: 0xA8933E, grassDry: 0xC2A94E, dirt: 0x7E4A20, dirtDark: 0x5E3616,
        trunk: 0x6E4A26, canopy: 0x6E5A2A, canopy2: 0x8A6F33, water: 0xE8A45C,
        exposure: 0.46 })
    }
  ];

  /* every stage is also a perfectly ordinary track, so the existing world
     builder, physics, AI and renderer need no idea the tour exists */
  STAGES.forEach(function (s) {
    s.level = "tour";
    s.levelLabel = "Stage " + s.n;
    s.desc = s.from + " to " + s.to;
    s.unique = s.blurb;
    s.feats = [SURFACES[s.surface].label, WEATHER[s.weather].label, s.length + " m"];
  });

  var TOTAL_M = STAGES.reduce(function (a, s) { return a + s.length; }, 0);

  /* ---------- the economy ---------- */

  /* One point of condition costs ten kwacha, so a bike rebuilt from nothing
     is a flat K 1000 — a number a ten-year-old can hold in their head and
     weigh against a K 150 spare tyre. Over a whole tour a rider earns
     roughly two thousand kwacha, so keeping the bike perfect AND carrying
     everything is out of reach: that gap is where the workshop gets its
     decisions from. */
  var REPAIR_PER_POINT = 10;   /* kwacha to put one point of condition back */
  var START_KWACHA = 400;      /* a sensible first bag, nowhere near everything */
  var RISK_FLOOR = 72;         /* above this condition, nothing ever breaks */
  var BONUS_CAP = 90;          /* the most a fast leg can pay on top */

  /* What a leg pays. Coins are the big lever and they are worth exactly one
     kwacha each, so the number on the HUD is the money in the purse — the
     rider who takes the wide line for the coins is paid for it. */
  function stageEarnings(stage, timeMs, coins, crashes) {
    var base = Math.round(stage.length / 25);
    var coinPay = coins;
    var target = targetMs(stage);
    var bonus = timeMs > 0 && timeMs <= target
      ? Math.min(BONUS_CAP, Math.round(25 + (target - timeMs) / 900))
      : 0;
    var tidy = crashes === 0 ? 25 : 0;
    return { base: base, coins: coinPay, bonus: bonus, tidy: tidy,
      total: base + coinPay + bonus + tidy };
  }

  /* A generous par time: a rider who keeps moving will beat it. Weather is in
     here because grip really does slow a leg down now — without this, the wet
     stages would quietly lose their under-par bonus the day rain landed. */
  function targetMs(stage) {
    var pace = 10.5 - stage.slope * 12;          /* m/s a steady rider holds */
    var rough = SURFACES[stage.surface].wear;
    var grip = WEATHER[stage.weather].grip;
    return Math.round((stage.length / pace) * (0.94 + rough * 0.1) * (1 + (1 - grip) * 1.1) * 1000);
  }

  /* How much a leg takes out of the bike. Tuned so the condition bar visibly
     MOVES after every leg — a couple of percent would be a decoration. A
     clean leg costs 10-34% before the club van's free fettle puts ten back,
     so a rider who wants a perfect bike AND a full bag spends almost
     everything a tour pays. That gap is the game. */
  function stageWear(stage, crashes) {
    var s = SURFACES[stage.surface].wear;
    var w = WEATHER[stage.weather].wear;
    return Math.min(60, Math.round((stage.length / 75) * s * w + crashes * 4));
  }

  /* THE CLUB VAN. The Grown-Up Crew drive the support van round the whole
     tour, and at every stage finish they give the bike a free once-over —
     chain oiled, bolts checked, brakes trued. It is worth ten points of
     condition and it costs nothing, ever.

     This is the piece that makes the tour safe for a ten-year-old. Without
     it a rider having a bad day earns less, so repairs less, so breaks more,
     so earns less again — the death spiral that made the old road-race games
     unplayable for kids. The van puts a floor under the worst day: the tour
     can go badly, but it can never run away from you. */
  var FREE_FETTLE = 10;

  function fettle(t) {
    var before = t.condition;
    t.condition = Math.min(100, t.condition + FREE_FETTLE);
    return Math.round(t.condition - before);
  }

  /* the chance of a mechanical, stated up front and never a surprise */
  function faultRisk(condition) {
    if (condition >= RISK_FLOOR) return 0;
    return Math.min(0.65, (RISK_FLOOR - condition) / 100);
  }

  /* condition drags on the bike long before anything actually breaks */
  function conditionStats(condition) {
    var k = Math.max(0, Math.min(1, (100 - condition) / 100));
    return {
      brake: 1 - k * 0.3,
      steer: 1 - k * 0.22,
      roll: 1 + k * 0.28,
      rough: 1 + k * 0.25
    };
  }

  /* deterministic per stage+attempt so a briefing's stated risk is honest */
  function rollFault(stage, condition, bag, seedSalt) {
    var risk = faultRisk(condition);
    if (risk <= 0) return null;
    var h = (stage.seed ^ (seedSalt || 0) * 2654435761) >>> 0;
    h = (h ^ (h >>> 15)) * 2246822507 >>> 0;
    var r = ((h ^ (h >>> 13)) >>> 0) / 4294967296;
    if (r > risk) return null;
    var fault = FAULTS[Math.floor((((h >>> 7) & 0xffff) / 65536) * FAULTS.length) % FAULTS.length];
    /* carrying the right spare turns a disaster into a roadside stop */
    var fix = null;
    (bag || []).forEach(function (id) {
      if (!fix && SPARES[id] && SPARES[id].fixes === fault.id) fix = id;
    });
    return {
      fault: fault,
      fixedBy: fix,
      lostS: fix ? Math.round(fault.lostS * 0.28) : fault.lostS
    };
  }

  /* ---------- progress ---------- */

  var KEY = "zr3_tour";

  function freshTour(riderName) {
    return {
      v: 1,
      started: true,
      rider: riderName || "Rider",
      number: raceNumber(riderName),
      stage: 0,                 /* how many stages are done */
      kwacha: START_KWACHA,
      condition: 100,
      bag: ["tube", "pump", "patch"],
      results: [],              /* one entry per finished stage */
      penaltyMs: 0
    };
  }

  /* your race number is your start time, exactly as it was on the real
     Mille Miglia: number 722 rolled out of Brescia at 07:22 */
  function raceNumber(name) {
    var h = 0, s = String(name || "Rider");
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    var hh = 6 + (h % 4);                  /* 06:xx to 09:xx */
    var mm = h % 60;
    return hh * 100 + mm;
  }

  function startTimeLabel(number) {
    var hh = Math.floor(number / 100), mm = number % 100;
    return (hh < 10 ? "0" : "") + hh + ":" + (mm < 10 ? "0" : "") + mm;
  }

  function validTour(t) {
    return !!t && t.v === 1 && typeof t.stage === "number" &&
      t.stage >= 0 && t.stage <= STAGES.length &&
      typeof t.kwacha === "number" && typeof t.condition === "number" &&
      Array.isArray(t.bag) && Array.isArray(t.results);
  }

  function totalMs(t) {
    var sum = t.penaltyMs || 0;
    (t.results || []).forEach(function (r) { sum += r.timeMs + (r.lostMs || 0); });
    return sum;
  }

  function stageAt(i) { return STAGES[i] || null; }

  /* What the sky does on a leg, in the game's own words. One rule, so the leg
     you ride on your own and the leg you ride with three friends have the same
     weather over them — and so the server and the browser cannot disagree about
     what the roadbook said. */
  function stageWx(stage) {
    var w = (stage && WEATHER[stage.weather]) || {};
    return w.bolts ? "storm" : w.rainK > 0 ? "rain" : "clear";
  }

  var API = {
    STAGES: STAGES, SURFACES: SURFACES, WEATHER: WEATHER, SPARES: SPARES,
    FAULTS: FAULTS, BAG_SLOTS: BAG_SLOTS, TOTAL_M: TOTAL_M, KEY: KEY,
    REPAIR_PER_POINT: REPAIR_PER_POINT, START_KWACHA: START_KWACHA,
    RISK_FLOOR: RISK_FLOOR, BONUS_CAP: BONUS_CAP, FREE_FETTLE: FREE_FETTLE,
    fettle: fettle,
    stageEarnings: stageEarnings, targetMs: targetMs, stageWear: stageWear,
    faultRisk: faultRisk, conditionStats: conditionStats, rollFault: rollFault,
    freshTour: freshTour, raceNumber: raceNumber, startTimeLabel: startTimeLabel,
    validTour: validTour, totalMs: totalMs, stageAt: stageAt, stageWx: stageWx,
    /* fold the stages into the shared track table */
    register: function (CORE) {
      STAGES.forEach(function (s) { CORE.TRACKS3[s.id] = s; });
      return STAGES.length;
    }
  };

  if (typeof module !== "undefined" && module.exports) module.exports = API;
  if (typeof window !== "undefined") window.ZR_TOUR = API;
})();
