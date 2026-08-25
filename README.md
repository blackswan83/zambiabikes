# Zambia Bikes 🚵🇿🇲

**Ride wild. Ride kind. Ride Zambia.**

The website of Zambia Bikes — a kids' mountain-biking club founded by two
10-year-old best friends, **Armand** (Chief Trail Officer) and **Arthur**
(Chief Fun & Games Officer), and safeguarded by their Grown-Up Crew.

The site organizes guided mountain-bike tours across Zambia for kids and
hosts **Zambia Rush**, a free Descenders-inspired downhill game set in
Zambian landscapes — miombo forest, baobab ridges and the Mosi-oa-Tunya
falls canyon.

## What's inside

| Page | What it does |
| --- | --- |
| `index.html` | Home — animated hero, next-ride countdown, club overview |
| `tours.html` | Tour & event calendar with "Request to join" flow |
| `game.html` | **Zambia Rush 3D** — the full 3D downhill game |
| `game2d.html` | **Zambia Rush Classic** — the 2D version, runs on anything |
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
stem faceplate bolts and pinned pedals. 47 parts across eleven categories —
frames, forks, wheels, tires, drivetrains, chainring sizes, handlebars,
pedals, brakes, seatposts, extras — each with honest stat trade-offs that
feed the riding physics via `computeStats`. The **paint booth** sprays every
zone independently (frame, fork lowers, rims, saddle, grips, plus black /
tan / gum tire walls) and the **Tune bench** sets suspension sag %, rebound
clicks and tire pressure psi — real setup mechanics with recommended bands
and verdicts, all of which change the ride. Dream parts are **earned by
riding** (finish tracks, beat ghosts, collect coins — tracked in
`zr3_career`), never bought.

Four 3D mountains: **Miombo Meander** (1.25 km), **Baobab Ridge** (1.5 km,
sunset), **Lower Zambezi** (1.6 km riverside — a flowing river with sandy
beaches, reed beds, hippo pods, and crocodiles basking right on the trail
edge; clip one and you crash, ride into the river and you splash), and
**Mosi Falls Drop** (1.75 km canyon). Armand and Arthur's ghosts
are simulated through the same physics, so their times are honestly
beatable — gold medal = beat Armand. **Ghost Codes** (`ZR3G1…`) give kid-safe
multiplayer with no server: positions + a first name, nothing else. If a
device has no WebGL, the page offers **Zambia Rush Classic** (`game2d.html`,
engine in `js/game.js`) — the original 2D side-scroller with backflips,
which shares the same design and its own `ZRG1…` ghost codes.

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

1. Create a new Railway service from this repo — it detects `package.json`
   and runs `npm start` automatically.
2. Add the **Postgres plugin** to the project and attach it to the service,
   so `DATABASE_URL` is injected. Tables are created on boot.
3. Set `ADMIN_TOKEN` to a long random string (e.g. `openssl rand -hex 32`).
   This guards the Grown-Up Crew's request list and ghost moderation.
4. That's it — Railway sets `PORT` automatically.

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

---

Built with muddy hands by Armand & Arthur (both 10) and the Grown-Up Crew.
