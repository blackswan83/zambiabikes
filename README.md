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
- **`js/game3d.js`** — the Three.js renderer + UI: ACES filmic tone mapping,
  real-time PCF soft shadows that follow the rider, a gradient sky dome with
  layered hazy horizon ridges, detail-textured terrain with worn tire ruts,
  per-instance colour-varied instanced vegetation (miombo, baobabs, acacias,
  rocks) plus thousands of alpha-card grass tufts, fluffy flat-bottomed
  clouds and cirrus, wheeling bird flocks, low-poly wildlife (elephants,
  giraffes, zebras, antelope), a fully animated Mosi Falls set piece
  (scrolling water layers, spray particles, foam rings, sun shafts, rainbow
  and a distance-based rumble), an articulated rider with crank-driven
  pedalling legs, banking chase camera with landing dips, dust, vignette,
  HUD, menus and a Detail: full/light toggle (light = no shadows, fewer
  props, for older devices). All textures are generated procedurally on a
  canvas — the game ships zero image assets.

Three 3D mountains: **Miombo Meander** (1.25 km), **Baobab Ridge** (1.5 km,
sunset), **Mosi Falls Drop** (1.75 km canyon). Armand and Arthur's ghosts
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

---

Built with muddy hands by Armand & Arthur (both 10) and the Grown-Up Crew.
