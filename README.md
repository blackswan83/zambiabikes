# Zambia Bikes 🚵🇿🇲

**Ride wild. Ride kind. Ride Zambia.**

The website of Zambia Bikes — a kids' mountain-biking club founded by two
10-year-old best friends, **Armand** (Chief Trail Officer) and **Arthur**
(Chief Fun & Games Officer), and safeguarded by their Grown-Up Crew.

The site organizes guided mountain-bike tours across Zambia for kids and
hosts two free Descenders-inspired games: **Zambia Rush**, a downhill racer
across five hand-built Zambian mountains, and **Trial**, a freeride game where
every mountain is generated from a single number.

## What's inside

| Page | What it does |
| --- | --- |
| `index.html` | Home — animated hero, next-ride countdown, club overview |
| `tours.html` | Tour & event calendar with "Request to join" flow |
| `game.html` | **Zambia Rush 3D** — the full 3D downhill game |
| `game2d.html` | **Zambia Rush Classic** — the 2D version, runs on anything |
| `trial.html` | **Trial** — the freeride game: every mountain generated from one number |
| `garage.html` | **The Garage** — build and mod your bike in 3D |
| `join.html` | Membership request form (vetted, never automatic) |
| `about.html` | The founders' story, values, the Grown-Up Crew |
| `safety.html` | For parents: vetting, trail safety, online safety, privacy |

No build step and no CDN dependencies: Three.js is vendored into
`js/vendor/` (MIT, license included), fonts come from Google Fonts. Serve
the folder statically (GitHub Pages works as-is; the 3D game uses ES
modules, so use `http://`, not `file://`).

```bash
# local preview
python3 -m http.server 8000
# → http://localhost:8000
```

## The game — Zambia Rush 3D

A Descenders-inspired third-person downhill simulator in Three.js, split in
two layers:

- **`js/game3d-core.js`** — the renderer-independent simulation: seeded
  heightfield mountains, a wandering trail spline carved into the terrain
  with kickers and checkpoint gates, prop placement and collisions, arcade
  bike physics (pedal, brake, steer, bunny-hop, crash-on-hard-landing,
  respawn at the last gate), trail-following AI riders, and Ghost Code
  packing. Runs headless under node for tests (`module.exports`).
- **`js/game3d.js`** — the Three.js renderer + UI. Full detail runs a
  physically-based pipeline: the three.js `Sky` shader (real Rayleigh/Mie
  atmospheric scattering with animated procedural clouds, tuned per track —
  morning forest, low sunset, bright canyon light), an EffectComposer chain
  (UnrealBloom on true HDR highlights + FXAA + OutputPass), ACES filmic tone
  mapping with per-track exposure, PCF soft shadows that follow the rider,
  normal-mapped PBR terrain (FBM height → sobel normal map, all generated on
  canvas) with worn tire ruts, organic leaf-card tree canopies that cast
  leafy shadows and sway in the wind along with the grass (a vertex-shader
  injection), a real reflective `Water` plunge pool under the animated Mosi
  Falls (plus spray, foam rings, sun shafts, rainbow and a distance-based
  rumble), per-instance colour-varied vegetation, wheeling bird flocks,
  low-poly wildlife, an articulated rider with crank-driven pedalling legs,
  a banking chase camera with landing dips, and hazy layered horizon
  ridges. The Detail: light toggle falls back to the cheap pipeline (gradient
  sky dome, no composer/shadows/water, fewer props) for older devices. All
  textures are generated procedurally — the game ships zero image assets.

**The Garage** (`garage.html`, `js/garage.js`, catalog in `js/bikes.js`):
an engineering-detail bike builder for real MTB fans. The interactive 3D
viewer (OrbitControls, studio lighting, PMREM reflections) shows every
component as real geometry: cross-laced spokes on flanged hubs with nipples
and valve stems, hooked rim profiles, toothed chainrings and cassettes, a
rear derailleur with jockey wheels, drilled rotors (alpha-tested canvas
texture), brake hoses routed lever-to-caliper, fork dust seals and arches,
coil or air shocks with rocker links, welds, head badges, downtube decals,
stem faceplate bolts and pinned pedals. 58 parts across twelve categories —
frames, forks, wheels, tires, drivetrains, chainring sizes, handlebars,
pedals, brakes, seatposts, extras and decal patterns (racing stripes,
flames, chitenge chevrons, leopard spots) — each with honest stat trade-offs
that feed the riding physics via `computeStats`. The **paint booth** sprays
every zone independently (frame, fork lowers, rims, saddle, grips, decal
colour, spokes and chain, plus black / tan / gum tire walls) and the
**Tune bench** sets suspension sag %, rebound
clicks and tire pressure psi — real setup mechanics with recommended bands
and verdicts, all of which change the ride. Dream parts are **earned by
riding** (finish tracks, beat ghosts, collect coins — tracked in
`zr3_career`), never bought.

Five 3D mountains: **Miombo Meander** (1.25 km), **Baobab Ridge** (1.5 km,
sunset), **Kasanka Bat Storm** (1.4 km of dusk swamp forest under rivers of
ten million straw-coloured fruit bats, with mist on the ground), **Lower Zambezi** (1.6 km riverside — a flowing river with sandy
beaches, reed beds, hippo pods, and crocodiles basking right on the trail
edge; clip one and you crash, ride into the river and you splash), and
**Mosi Falls Drop** (1.75 km canyon). Armand and Arthur's ghosts
are simulated through the same physics, so their times are honestly
beatable — gold medal = beat Armand. **Ghost Codes** (`ZR3G1…`) give kid-safe
multiplayer with no server: positions + a first name, nothing else. If a
device has no WebGL, the page offers **Zambia Rush Classic** (`game2d.html`,
engine in `js/game.js`) — the original 2D side-scroller with backflips,
which shares the same design and its own `ZRG1…` ghost codes.

## The other game — Trial

Where Zambia Rush gives you five hand-built mountains, **Trial** builds a new
one every time. A run is one seed, so a trail code like `5PR-MAP` *is* the
whole hill — the same ridge, the same corners, the same jumps in the same
places for anyone who types it in.

- **`js/trial-core.js`** — the headless simulation (`window.TRIAL`; exports
  under node). Five biome recipes grow a heightfield; a wandering trail is
  carved *and banked* into it, with the bank taken from the trail's own
  curvature so every corner rides like a built berm. Seven feature builders
  then cut into that trail — kickers, road gaps, step-downs, whoops, berms,
  hips and rock gardens — writing into delta layers (local shape, permanent
  step, bank, carve width, lateral shift) that are applied *after* grade
  clamping, so a 3 m lip survives.
- **`js/trial.js`** — the Three.js renderer, the HUD and the career.

**What makes it Trial and not Zambia Rush**

| | |
| --- | --- |
| Air | Three axes — spin (`A`/`D`), flip (`W`/`S`), whip (`Q`/`E`). Rotation must come back round before the wheels touch. |
| Hops | Hold `Space` to preload, release to pop. Let go right on a lip for extra height. |
| Scoring | Style points per landed trick, escalating with rotation, plus a combo multiplier that stacks while you keep landing them. |
| Damage | A bail bar, not lives. Every crash takes a bite; style refills it; at zero the run is over. |
| Never stuck | Go down in the same place three times and you walk that section. A checkpoint that cannot deliver enough speed to clear what is in front of it would otherwise loop until the bar was empty, with no way down at all. |
| Progress | Five career stages, three nodes each, seeded from *your* career number — your Batoka is nobody else's Batoka. |
| Assist | Landing assist is on by default (~115° of forgiveness). Off, it is ~55°. |
| Bike | The build on the stand in **the Garage** is the bike you ride — the same eight stats Zambia Rush uses, and the same per-zone paint. |

**Tests.** `npm test` runs the simulation suite in `test/trial.test.js` under
plain node — no browser needed. It pins down the promises the generator
makes: one seed is one mountain, a printed trail code rebuilds exactly that
mountain, nothing solid ever stands on the line, checkpoints never land
inside a feature, every feature is survivable, and no landing meets the
hillside at an angle sharp enough to launch the rider off its own knuckle.

**Feature geometry is measured, not guessed.** A generator that *can* build an
unrideable jump will build one, so each builder sizes its gully or landing
ramp from the flight a rider can actually make off that specific lip. A
harness then drops a rider onto the line ahead of every generated feature at
9, 13, 17, 21 and 25 m/s — about 2 700 landings across five biomes and both
jump sizes — and counts the crashes:

| Feature | Tries | Bail rate | Where it bites |
| --- | --- | --- | --- |
| Berm | 605 | 0.0 % | nowhere |
| Hip jump | 340 | 0.0 % | nowhere |
| Rock garden | 435 | 0.0 % | nowhere |
| Kicker | 1 700 | 0.3 % | 25 m/s off the biggest lips |
| Whoops | 820 | 0.7 % | even across all speeds |
| Step-down | 440 | 5.2 % | 21–25 m/s with no brakes |
| Road gap | 515 | 5.2 % | 17–25 m/s, cased |

Gaps and drops are *allowed* to punish you — but only for sending it flat
out, which is what the brake is for.

## Kid-safety design decisions

- **Every sign-up is a request** — tour and membership forms create pending
  requests that the club owners review; nothing auto-approves.
- **No chat anywhere**, no DMs, no friend requests, no external social links.
- Public forms collect a rider's **first name and age only** — contact
  details are the parent/guardian's.
- Leaderboard names are sanitized to a small character set, capped at 12
  characters, and live only on the player's device.
- Ghost Codes are validated and sanitized on import and contain nothing but
  rider positions, a time and a first name.

## Wiring it up for real

The site is intentionally backend-free. To take requests for real, point the
two form handlers in `js/main.js` (`initJoinForm`, the modal submit in
`openRequestModal`) at your endpoint of choice (e.g. a Formspree form or a
small serverless function that emails the Grown-Up Crew), and replace
`hello@zambiabikes.org` with the club's real inbox. Tours are edited in one
place: `js/tours-data.js`.

## Running the server (Railway)

The site now ships with a tiny Node backend (`server.js`) that serves the
static pages, takes membership requests for real, and hosts a shared Ghost
Code leaderboard — every code is re-validated server-side by the same
`js/game3d-core.js` engine the game runs on.

```bash
npm install
npm start
# → http://localhost:3000  (no DATABASE_URL → in-memory mode, perfect for tinkering)
```

**Deploying on Railway:**

1. **New Project → Deploy from GitHub repo**, pick this repo, and choose the
   branch you want live (Railway watches that one branch and redeploys on
   every push to it).
2. `railway.json` in the repo root does the rest: Nixpacks build, `npm start`,
   and a healthcheck against `/api/health` so a broken deploy is rolled back
   instead of served.
3. Add the **Postgres database** to the project (`+ New → Database → Postgres`)
   and attach it to the service, so `DATABASE_URL` is injected. Tables are
   created on boot.
4. Set `ADMIN_TOKEN` to a long random string (e.g. `openssl rand -hex 32`).
   This guards the Grown-Up Crew's request list and ghost moderation.
5. Under **Settings → Networking**, click *Generate Domain* to get a public
   URL. Railway sets `PORT` for you — never hard-code it.

Without a Postgres database attached the site still comes up, but it runs in
in-memory mode: join requests and ghost codes vanish on every redeploy.

**Environment variables:**

| Variable | What it does |
| --- | --- |
| `DATABASE_URL` | Postgres connection string (Railway injects it). Unset → in-memory storage, lost on restart. |
| `ADMIN_TOKEN` | Bearer token for `/api/admin/requests` and ghost deletion. Unset → admin routes answer 503. |
| `PORT` | Port to listen on (Railway sets it; defaults to 3000). |

**Reading the membership requests** (Grown-Up Crew only):

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" https://your-app.up.railway.app/api/admin/requests
```

The static site still works completely standalone (GitHub Pages) — with no
server behind it, the join form simply falls back to the original
prepared-email flow.

## Making the mountains more realistic

Every texture, sky and tree in the game is generated in code, which is why
the game ships with no image files at all. The way past that ceiling is real
photo-scanned assets: drop CC0 textures, HDRI skies and `.glb` models into
[`assets/world/`](assets/world/README.md), which documents the exact file
names and size limits. Anything present gets used; anything missing falls
back to the procedural version, so the folder can be filled one material at
a time.

---

Built with muddy hands by Armand & Arthur (both 10) and the Grown-Up Crew.

### Playing Trial without a server

`dist/trial-standalone.html` is the whole game in one file — the simulation,
the renderer, the audio, Three.js and every stylesheet inlined, with each ES
module carried as a `data:` URL and wired together by an import map. Open it
straight off disk (`file://`) and it plays: no server, no build step, no
network. Handy for a laptop with no internet, or for handing the game to
somebody on a memory stick.

Rebuild it after changing any game file:

```bash
python3 tools/bundle-trial.py
```

The generator is deliberately dumb about nothing: it walks the real import
graph from `js/trial.js`, so a new addon or module is picked up automatically.
