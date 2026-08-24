/* ==========================================================================
   ZAMBIA BIKES — the Garage catalog
   Frames, forks, wheels, tires, drivetrains, brakes and extras, written for
   real mountain-bike fans. Every part changes how the bike RIDES in Zambia
   Rush 3D (see computeStats), not just how it looks.

   Nothing here is ever bought with money — the club promise stands. A few
   dream parts are EARNED by riding (see `unlock` fields + isUnlocked).

   Classic script: exposes window.ZB_BIKES; module.exports under node.
   ========================================================================== */

(function () {
  "use strict";

  /* Stat multipliers: 1.0 = the reference Zambezi FS trail bike.
     pedal    – acceleration when you stomp on the pedals
     vcap     – how fast you can pedal up to on the flat
     brake    – stopping power
     steer    – how quickly the bike changes direction
     roll     – rolling resistance (LOWER is faster)
     rough    – penalty off the smooth line (LOWER is better; suspension+tires)
     landSoft – landing forgiveness: raises the crash threshold, keeps speed
     hop      – bunny-hop height
     kg       – real weight of the part */

  var CATALOG = {

    frame: {
      label: "Frame",
      options: {
        mopane_ht: {
          name: "Mopane HT", spec: "Hardtail · aluminium · 68.5° head angle",
          desc: "One gear of suspension: your legs. Nothing pedals harder or snaps between corners quicker — but every root comes straight through the seat of your shorts.",
          kg: 1.9, stats: { pedal: 1.08, steer: 1.06, roll: 0.95, rough: 1.25, landSoft: -0.08 }
        },
        zambezi_fs: {
          name: "Zambezi FS 140", spec: "Full suspension · 140 mm rear · 66° HA",
          desc: "The do-everything trail bike and the club reference. 140 mm out back smooths the chatter, the seat tube still likes a long climb. Armand rides one of these.",
          kg: 2.9, stats: { rough: 0.9, landSoft: 0.1 }
        },
        muchinga_enduro: {
          name: "Muchinga 160", spec: "Enduro · 160 mm rear · 64° HA",
          desc: "Slack, long and calm when the trail turns violent. Gives back a little sprint and a little agility, and in exchange simply does not care what you land on.",
          kg: 3.4, stats: { pedal: 0.94, vcap: 1.03, steer: 0.95, rough: 0.7, landSoft: 0.25 },
          unlock: { type: "finish", track: "baobab", label: "Finish Baobab Ridge" }
        },
        mosi_dh: {
          name: "Mosi 200 DH", spec: "Downhill · 200 mm rear · 62.5° HA · dual-crown ready",
          desc: "A park bike with a passport. Pedals like a wheelbarrow full of river sand, corners like a freight barge — and turns the roughest line on the mountain into velvet.",
          kg: 4.2, stats: { pedal: 0.86, vcap: 1.08, steer: 0.85, brake: 1.05, rough: 0.5, landSoft: 0.45 },
          unlock: { type: "finish", track: "falls", label: "Finish Mosi Falls Drop" }
        },
        kabwata_dj: {
          name: "Kabwata DJ", spec: "Dirt jumper · rigid rear · 26\" native",
          desc: "Arthur's pick. A pump-track scalpel: tiny, stiff, and it leaves the ground if you so much as think about it. Bring your own suspension (knees).",
          kg: 2.2, stats: { pedal: 1.04, vcap: 0.92, steer: 1.18, hop: 1.25, rough: 1.35, landSoft: 0.02 },
          unlock: { type: "coinsRun", n: 60, label: "Grab 60 coins in one run" }
        }
      }
    },

    fork: {
      label: "Fork",
      options: {
        kafue_100: {
          name: "Kafue 100", spec: "100 mm air · 32 mm stanchions",
          desc: "Short-travel and feathery. Locks out stiff for sprints; run 20% sag and it still pops off every root lip.",
          kg: 1.5, stats: { pedal: 1.02, rough: 1.08, landSoft: -0.05 }
        },
        kafue_120: {
          name: "Kafue 120", spec: "120 mm air · 34 mm stanchions",
          desc: "The trail all-rounder. Mid-stroke support for pumping, enough travel to shrug off a botched line through the rock garden.",
          kg: 1.7, stats: {}
        },
        muchinga_140: {
          name: "Muchinga 140", spec: "140 mm air · 35 mm stanchions",
          desc: "A size up in confidence. The extra 20 mm shows up exactly when the front wheel finds the hole you didn't.",
          kg: 1.9, stats: { pedal: 0.99, rough: 0.94, landSoft: 0.06 }
        },
        muchinga_160: {
          name: "Muchinga 160", spec: "160 mm air · 36 mm chassis",
          desc: "Enduro spec: plusher, taller, a touch lazier in the steering. Point it into braking bumps and laugh.",
          kg: 2.1, stats: { pedal: 0.97, steer: 0.97, rough: 0.88, landSoft: 0.12 }
        },
        mosi_dc_200: {
          name: "Mosi DC 200", spec: "200 mm dual-crown · 38 mm stanchions",
          desc: "The downhill sledgehammer. Two crowns clamp the steerer so the front end never twists — huck to flat and apologise to nobody.",
          kg: 2.9, stats: { pedal: 0.94, steer: 0.9, rough: 0.8, landSoft: 0.22 },
          unlock: { type: "medal", track: "falls", medal: "bronze", label: "Bronze on Mosi Falls Drop" }
        }
      }
    },

    wheels: {
      label: "Wheels",
      options: {
        w26: {
          name: "26\" Classics", spec: "26 × 30 mm alloy",
          desc: "The old-school flick-machines. Nothing whips through tight miombo switchbacks or throws sideways off a lip like a 26.",
          kg: 1.7, radius: 0.32, stats: { steer: 1.1, vcap: 0.97, rough: 1.08, hop: 1.08 }
        },
        w275: {
          name: "27.5\" All-round", spec: "27.5 × 30 mm alloy",
          desc: "The Goldilocks hoop: rolls fast enough, turns quick enough, argues with nobody.",
          kg: 1.8, radius: 0.345, stats: {}
        },
        w29: {
          name: "29\" Roll-over King", spec: "29 × 30 mm alloy",
          desc: "The big wheels don't fall into holes — they bridge them. Carries speed like a train; asks politely before changing direction.",
          kg: 2.0, radius: 0.365, stats: { vcap: 1.04, roll: 0.96, rough: 0.92, steer: 0.93, hop: 0.95 }
        }
      }
    },

    tires: {
      label: "Tires",
      options: {
        dambo_semislick: {
          name: "Dambo Semi-Slick", spec: "2.25\" · file-tread centre, micro side knobs",
          desc: "A drag racer for hardpack. The centre tread barely touches the dirt — glorious in a straight line, spicy the moment you lean it in the loose stuff.",
          kg: 1.4, stats: { roll: 0.86, steer: 0.92, rough: 1.1 }
        },
        miombo_grip: {
          name: "Miombo Grip", spec: "2.4\" · open all-round tread",
          desc: "The club standard. Predictable everywhere, brilliant nowhere, never scary. Tubeless at 22 psi and forget about it.",
          kg: 1.7, stats: {}
        },
        mudzimu_spike: {
          name: "Mudzimu Spike", spec: "2.5\" · tall spaced knobs · soft compound",
          desc: "Rainy-season armour. The tall knobs bite through loose-over-hard like teeth — and hum like a swarm of bees on the smooth trail while they slow you down.",
          kg: 2.1, stats: { roll: 1.1, steer: 1.12, rough: 0.88 }
        },
        copper_wall: {
          name: "Copper Wall DH", spec: "2.5\" · dual-ply downhill casing",
          desc: "A tire built like a truck sidewall. Heavy? Yes. But rocks that would taco lesser rubber just… lose.",
          kg: 2.6, stats: { roll: 1.06, steer: 1.05, rough: 0.9, landSoft: 0.08 },
          unlock: { type: "medal", track: "any", medal: "silver", label: "Beat Arthur's ghost anywhere" }
        }
      }
    },

    drivetrain: {
      label: "Drivetrain",
      options: {
        trail_1x11: {
          name: "1×11 Trail", spec: "30T ring · 11–46T cassette",
          desc: "Eleven honest gears. Climbs most things, sprints most things, never drops a chain thanks to the clutch mech.",
          kg: 1.5, stats: {}
        },
        eagle_1x12: {
          name: "1×12 Big Wing", spec: "32T ring · 10–52T cassette",
          desc: "The 52-tooth dinner plate out back means no climb ends the conversation. Snappier out of every corner.",
          kg: 1.55, stats: { pedal: 1.06 }
        },
        dh_7speed: {
          name: "DH 7-Speed", spec: "36T ring · 11–25T close-ratio block",
          desc: "Seven tightly-stacked gears for people who only ever point downhill. Spin out later, accelerate like a barge.",
          kg: 1.4, stats: { pedal: 0.92, vcap: 1.06 }
        },
        one_gear: {
          name: "One-Gear Wonder", spec: "32×16 singlespeed",
          desc: "No derailleur, no cables, no mercy. Absurdly light and direct — until the mountain tilts up and it's all legs.",
          kg: 1.0, stats: { pedal: 1.1, vcap: 0.88 },
          unlock: { type: "medal", track: "any", medal: "gold", label: "Beat Armand's ghost anywhere" }
        }
      }
    },

    bar: {
      label: "Handlebar",
      options: {
        bar_narrow: {
          name: "700 mm Whippet", spec: "700 × 20 mm rise · 8° backsweep",
          desc: "Narrow bars turn tiny inputs into big direction changes — darty in the trees, twitchy when the trail hits back.",
          kg: 0.26, stats: { steer: 1.08, rough: 1.05 }
        },
        bar_trail: {
          name: "760 mm Trail", spec: "760 × 25 mm rise · 9° backsweep",
          desc: "The modern do-it-all width. Enough leverage to muscle the front wheel, not so wide you clip a mopane on the way past.",
          kg: 0.3, stats: {}
        },
        bar_wide: {
          name: "800 mm Gorilla", spec: "800 × 30 mm rise · 10° backsweep",
          desc: "Maximum leverage, maximum calm. The bike stops arguing in the rough — just mind your knuckles in tight forest.",
          kg: 0.34, stats: { steer: 0.94, rough: 0.95, landSoft: 0.03 }
        }
      }
    },

    ring: {
      label: "Chainring",
      options: {
        ring_30: {
          name: "30T Climber", spec: "30 T narrow-wide · steel",
          desc: "A small ring spins up instantly — snap out of corners, dance up the climbs, run out of gear on the fast straights.",
          kg: 0.07, stats: { pedal: 1.05, vcap: 0.96 }
        },
        ring_32: {
          name: "32T All-round", spec: "32 T narrow-wide · alloy",
          desc: "The reference ring. Nobody ever got dropped for running a 32.",
          kg: 0.06, stats: {}
        },
        ring_34: {
          name: "34T Big Ring", spec: "34 T narrow-wide · alloy",
          desc: "For riders with diesel in their legs: slower to wind up, but the top end just keeps giving.",
          kg: 0.065, stats: { pedal: 0.95, vcap: 1.05 }
        }
      }
    },

    pedals: {
      label: "Pedals",
      options: {
        pedal_comp: {
          name: "Composite Flats", spec: "Nylon body · moulded grip",
          desc: "Light, cheap, kind to shins. The moulded studs hold fine until things get properly wild.",
          kg: 0.35, stats: {}
        },
        pedal_pins: {
          name: "Alloy Pin Flats", spec: "6061 body · 10 traction pins a side",
          desc: "Ten steel pins per side lock your shoes to the bike — bunny-hops come up with you instead of staying behind.",
          kg: 0.42, stats: { hop: 1.07, landSoft: 0.02 }
        }
      }
    },

    brakes: {
      label: "Brakes",
      options: {
        two_pot: {
          name: "2-Piston Trail", spec: "180 mm rotors",
          desc: "Light, consistent, plenty for most days. Drag them down the whole falls canyon and they'll gently remind you they're only 180s.",
          kg: 0.5, stats: {}
        },
        four_pot: {
          name: "4-Piston Gravity", spec: "203 mm rotors · sintered pads",
          desc: "One-finger anchors. The kind of braking that moves your eyeballs. Later braking = faster riding — Armand's favourite upgrade.",
          kg: 0.8, stats: { brake: 1.25 }
        },
        v_brake: {
          name: "Granddad's V-Brakes", spec: "Rim brakes · character included",
          desc: "Squeal like a fish eagle, stop like a suggestion. Kept in the catalog for educational purposes.",
          kg: 0.3, stats: { brake: 0.78 }
        }
      }
    },

    seatpost: {
      label: "Seatpost",
      options: {
        rigid_post: {
          name: "Rigid Post", spec: "Alloy · classic",
          desc: "Set the height, ride the bike. Simple, light, always in the way on the steep stuff.",
          kg: 0.25, stats: {}
        },
        dropper: {
          name: "Dropper Post", spec: "150 mm travel · bar remote",
          desc: "Thumb the lever, the saddle vanishes, and suddenly you have room to move. The single biggest confidence upgrade in mountain biking.",
          kg: 0.65, stats: { hop: 1.06, landSoft: 0.06 }
        }
      }
    },

    extras: {
      label: "Extras",
      multi: true,
      options: {
        bell: {
          name: "Brass Bell", spec: "Ding-ding · press B while riding",
          desc: "Trail etiquette AND a musical instrument. Mandatory equipment for greeting zebras.",
          kg: 0.05, stats: {}
        },
        mudguard: {
          name: "Front Mudguard", spec: "Fork-mounted",
          desc: "Keeps rainy-season Zambia off your face. Mud Monster patch not included.",
          kg: 0.05, stats: {}
        },
        bottle: {
          name: "Bottle & Cage", spec: "750 ml",
          desc: "Zambian sun is not a joke — the Grown-Up Crew checks you're carrying water anyway.",
          kg: 0.85, stats: {}
        },
        plate: {
          name: "Number Plate", spec: "Race plate · your name on it",
          desc: "Zip-tied to the bars like race day. Instant +10 to feeling fast (actual speed effect: none).",
          kg: 0.05, stats: {}
        },
        kickstand: {
          name: "Kickstand", spec: "Absolutely not race legal",
          desc: "The Grown-Up Crew would like it noted, for the record, that no self-respecting race bike has ever had one of these. Arthur fitted one anyway.",
          kg: 0.35, stats: { steer: 0.99 }
        }
      }
    },

    paint: {
      label: "Paint",
      options: {
        p_forest: { name: "Forest Green", color: "#1F7A48", desc: "Club colours. Miombo camouflage.", kg: 0, stats: {} },
        p_copper: { name: "Copperbelt Orange", color: "#E8791D", desc: "Painted like the ore that built the railways.", kg: 0, stats: {} },
        p_river: { name: "Zambezi Teal", color: "#2A9D8F", desc: "The river at midday.", kg: 0, stats: {} },
        p_night: { name: "Miombo Night", color: "#22303A", desc: "Stealth. Extra fast at dusk (citation needed).", kg: 0, stats: {} },
        p_sunset: { name: "Kariba Sunset", color: "#D95F2B", desc: "Golden hour, all day.", kg: 0, stats: {} },
        p_purple: { name: "Jacaranda", color: "#8E44AD", desc: "October in Lusaka, when the whole city turns purple.", kg: 0, stats: {} },
        p_chrome: {
          name: "Copper Chrome", color: "#D8A05A", metal: true, desc: "Mirror-polished show finish. Blinds the ghosts behind you.",
          kg: 0, stats: {}, unlock: { type: "medal", track: "any", medal: "silver", label: "Beat Arthur's ghost anywhere" }
        },
        p_eagle: {
          name: "Eagle Red", color: "#D64533", metal: true, desc: "Champion's paint. Only riders who have beaten Armand get to run it.",
          kg: 0, stats: {}, unlock: { type: "medal", track: "any", medal: "gold", label: "Beat Armand's ghost anywhere" }
        }
      }
    }
  };

  var BASE_KG = 3.6;   /* bars, stem, saddle, cables, pedals, headset */

  var DEFAULT_CONFIG = {
    frame: "zambezi_fs", fork: "kafue_120", wheels: "w275", tires: "miombo_grip",
    drivetrain: "trail_1x11", brakes: "two_pot", seatpost: "rigid_post",
    bar: "bar_trail", ring: "ring_32", pedals: "pedal_comp",
    extras: ["bottle"], paint: "p_forest"
  };

  /* every paintable zone on the bike + the workshop tune bench */
  var COLOR_ZONES = ["frame", "fork", "rims", "saddle", "grips"];
  var DEFAULT_COLORS = { frame: "p_forest", fork: "p_night", rims: "p_night", saddle: "p_night", grips: "p_night", wall: "black" };
  var WALL_OPTIONS = { black: { name: "Blackwall", color: "#2A2420" }, tan: { name: "Tanwall", color: "#C9995C" }, gum: { name: "Gumwall", color: "#A9764C" } };
  var DEFAULT_TUNE = { sag: 27, rebound: 5, psi: 22 };
  var TUNE_SPEC = {
    sag: { label: "Suspension sag", unit: "%", min: 15, max: 35, recLo: 25, recHi: 30,
      blurb: "How far the suspension settles under your weight. Low sag = a firm, sprinty platform; high sag = plush and forgiving but wallowy on the pedals." },
    rebound: { label: "Rebound damping", unit: " clicks", min: 0, max: 10, recLo: 4, recHi: 6,
      blurb: "How fast the suspension returns. Too fast (low clicks) and the bike bucks you on landings; too slow and it packs up through repeated hits." },
    psi: { label: "Tire pressure", unit: " psi", min: 16, max: 30, recLo: 20, recHi: 24,
      blurb: "The cheapest suspension you own. Low pressure grips and floats over roots but rolls slow and risks rim strikes; high pressure is fast and skittery." }
  };

  var MEDAL_RANK = { none: 0, bronze: 1, silver: 2, gold: 3 };

  function emptyCareer() {
    return { coins: 0, runs: 0, finished: {}, medals: {}, maxCoinsRun: 0 };
  }

  function isUnlocked(def, career) {
    if (!def.unlock) return true;
    var u = def.unlock;
    career = career || emptyCareer();
    if (u.type === "finish") return !!(career.finished && career.finished[u.track]);
    if (u.type === "coinsRun") return (career.maxCoinsRun || 0) >= u.n;
    if (u.type === "medal") {
      var need = MEDAL_RANK[u.medal] || 1;
      var medals = career.medals || {};
      if (u.track === "any") {
        return Object.keys(medals).some(function (t) { return (MEDAL_RANK[medals[t]] || 0) >= need; });
      }
      return (MEDAL_RANK[medals[u.track]] || 0) >= need;
    }
    return true;
  }

  function getOption(cat, id) {
    var c = CATALOG[cat];
    return (c && c.options[id]) || null;
  }

  /* fill config gaps + swap locked parts back to legal defaults */
  function normalizeConfig(cfg, career) {
    cfg = cfg && typeof cfg === "object" ? cfg : {};
    var out = {};
    Object.keys(DEFAULT_CONFIG).forEach(function (cat) {
      if (cat === "extras") {
        var list = Array.isArray(cfg.extras) ? cfg.extras : DEFAULT_CONFIG.extras;
        out.extras = list.filter(function (id) {
          var d = getOption("extras", id);
          return d && isUnlocked(d, career);
        });
        return;
      }
      var id = cfg[cat];
      var def = getOption(cat, id);
      if (!def || !isUnlocked(def, career)) id = DEFAULT_CONFIG[cat];
      out[cat] = id;
    });
    /* per-zone colours: values are paint ids; legacy configs painted only the frame */
    var colors = cfg.colors && typeof cfg.colors === "object" ? cfg.colors : {};
    out.colors = {};
    COLOR_ZONES.forEach(function (zone) {
      var pid = colors[zone] || (zone === "frame" ? out.paint : DEFAULT_COLORS[zone]);
      var pd = getOption("paint", pid);
      if (!pd || !isUnlocked(pd, career)) pid = DEFAULT_COLORS[zone];
      out.colors[zone] = pid;
    });
    out.colors.wall = WALL_OPTIONS[colors.wall] ? colors.wall : DEFAULT_COLORS.wall;
    out.paint = out.colors.frame;   /* keep legacy field in sync */
    /* tune bench values, clamped to the physical range */
    var tune = cfg.tune && typeof cfg.tune === "object" ? cfg.tune : {};
    out.tune = {};
    Object.keys(TUNE_SPEC).forEach(function (k) {
      var v = Number(tune[k]);
      var sp = TUNE_SPEC[k];
      if (!isFinite(v)) v = DEFAULT_TUNE[k];
      out.tune[k] = Math.max(sp.min, Math.min(sp.max, Math.round(v)));
    });
    return out;
  }

  /* one verdict per tune dial, used by the garage UI and worth reading */
  function tuneVerdict(tune) {
    var out = {};
    Object.keys(TUNE_SPEC).forEach(function (k) {
      var sp = TUNE_SPEC[k];
      var v = tune[k];
      if (v >= sp.recLo && v <= sp.recHi) out[k] = { ok: true, text: "Dialled ✓" };
      else if (k === "sag") out[k] = { ok: false, text: v < sp.recLo ? "Firm: sprinty but harsh" : "Plush: forgiving but wallowy" };
      else if (k === "rebound") out[k] = { ok: false, text: v < sp.recLo ? "Too fast: the bike bucks" : "Too slow: packs up in the rough" };
      else out[k] = { ok: false, text: v < sp.recLo ? "Squishy: grippy, slow, rim-strike risk" : "Rock hard: fast rolling, skittery" };
    });
    return out;
  }

  function computeStats(cfg) {
    var S = { pedal: 1, vcap: 1, brake: 1, steer: 1, roll: 1, rough: 1, landSoft: 0, hop: 1 };
    var kg = BASE_KG;
    function apply(def) {
      if (!def) return;
      kg += (def.kg || 0);
      var st = def.stats || {};
      Object.keys(st).forEach(function (k) {
        if (k === "landSoft") S.landSoft += st[k];
        else S[k] *= st[k];
      });
    }
    apply(getOption("frame", cfg.frame));
    apply(getOption("fork", cfg.fork));
    apply(getOption("wheels", cfg.wheels));
    apply(getOption("tires", cfg.tires));
    apply(getOption("drivetrain", cfg.drivetrain));
    apply(getOption("brakes", cfg.brakes));
    apply(getOption("seatpost", cfg.seatpost));
    apply(getOption("bar", cfg.bar));
    apply(getOption("ring", cfg.ring));
    apply(getOption("pedals", cfg.pedals));
    (cfg.extras || []).forEach(function (id) { apply(getOption("extras", id)); });

    /* --- the tune bench: setup is real mechanics, not decoration --- */
    var tune = cfg.tune || DEFAULT_TUNE;
    var sagDev = (tune.sag - 27) / 10;            /* -1.2 .. +0.8 */
    S.pedal *= 1 - Math.max(0, sagDev) * 0.05 + Math.max(0, -sagDev) * 0.02;
    S.rough *= 1 - sagDev * 0.10;                 /* more sag soaks more chatter */
    S.landSoft += sagDev * 0.10;
    var rebOff = Math.abs(tune.rebound - 5);      /* distance from the sweet spot */
    if (rebOff > 1) {
      S.landSoft -= (rebOff - 1) * 0.03;
      S.rough *= 1 + (rebOff - 1) * 0.02;
    }
    var psiDev = (tune.psi - 22) / 8;             /* -0.75 .. +1 */
    S.roll *= 1 - psiDev * 0.07;                  /* hard tires roll fast */
    S.steer *= 1 - psiDev * 0.08;                 /* soft tires bite */
    S.rough *= 1 + psiDev * 0.06;
    S.landSoft += -Math.max(0, psiDev) * 0.03 - Math.max(0, -psiDev - 0.5) * 0.06; /* rim-strike territory */

    /* weight matters: every kilo over the reference bike costs a little sprint */
    S.pedal *= 1 + (13.5 - kg) * 0.008;
    S.vcap *= 1 + (13.5 - kg) * 0.003;
    if (S.landSoft < -0.1) S.landSoft = -0.1;
    S.weightKg = Math.round(kg * 10) / 10;

    /* 0–10 bars for the garage UI */
    function bar(v, lo, hi) {
      return Math.max(0.5, Math.min(10, ((v - lo) / (hi - lo)) * 10));
    }
    S.bars = {
      sprint: bar(S.pedal, 0.75, 1.2),
      topSpeed: bar(S.vcap, 0.85, 1.15),
      handling: bar(S.steer * (2 - S.roll) / 1, 0.7, 1.35),
      suspension: bar((1.45 - S.rough) + S.landSoft, 0.1, 1.5),
      braking: bar(S.brake, 0.7, 1.3)
    };
    return S;
  }

  function riderNameForBike(cfg) {
    var f = getOption("frame", cfg.frame);
    return f ? f.name : "Custom";
  }

  /* ---------- storage (browser only) ---------- */

  function loadConfig(career) {
    var cfg = null;
    try { cfg = JSON.parse(localStorage.getItem("zr3_bike")); } catch (e) { /* ignore */ }
    return normalizeConfig(cfg, career);
  }
  function saveConfig(cfg) {
    try { localStorage.setItem("zr3_bike", JSON.stringify(cfg)); } catch (e) { /* ignore */ }
  }
  function loadCareer() {
    var c = null;
    try { c = JSON.parse(localStorage.getItem("zr3_career")); } catch (e) { /* ignore */ }
    if (!c || typeof c !== "object") c = emptyCareer();
    c.finished = c.finished || {};
    c.medals = c.medals || {};
    return c;
  }
  function saveCareer(c) {
    try { localStorage.setItem("zr3_career", JSON.stringify(c)); } catch (e) { /* ignore */ }
  }

  var API = {
    CATALOG: CATALOG, DEFAULT_CONFIG: DEFAULT_CONFIG, BASE_KG: BASE_KG,
    MEDAL_RANK: MEDAL_RANK, COLOR_ZONES: COLOR_ZONES, DEFAULT_COLORS: DEFAULT_COLORS,
    WALL_OPTIONS: WALL_OPTIONS, DEFAULT_TUNE: DEFAULT_TUNE, TUNE_SPEC: TUNE_SPEC,
    tuneVerdict: tuneVerdict,
    getOption: getOption, isUnlocked: isUnlocked, normalizeConfig: normalizeConfig,
    computeStats: computeStats, riderNameForBike: riderNameForBike, emptyCareer: emptyCareer,
    loadConfig: loadConfig, saveConfig: saveConfig, loadCareer: loadCareer, saveCareer: saveCareer
  };

  if (typeof module !== "undefined" && module.exports) module.exports = API;
  if (typeof window !== "undefined") window.ZB_BIKES = API;
})();
