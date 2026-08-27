# Zambia Bikes 🚵🇿🇲

**Ride wild. Ride kind. Ride Zambia.**

The website of Zambia Bikes — a kids' mountain-biking club founded by two
10-year-old best friends, **Armand** (Chief Trail Officer) and **Arthur**
(Chief Fun & Games Officer), and safeguarded by their Grown-Up Crew.

The site organizes guided mountain-bike tours across Zambia for kids and
hosts **Zambia Rush**, a free Descenders-inspired downhill game set in
Zambian landscapes — miombo forest, baobab ridges, the Kasanka bat swamp,
the Lower Zambezi and the Mosi-oa-Tunya falls canyon — plus **The Great
Zambia Tour**, a ten-stage rally around the whole country.

## What's inside

| Page | What it does |
| --- | --- |
| `index.html` | Home — animated hero, next-ride countdown, club overview |
| `tours.html` | Tour & event calendar with "Request to join" flow |
| `game.html` | **Zambia Rush 3D** — the full 3D downhill game (one player or two, same screen) |
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
  respawn at the last gate), a tap-to-boost **turbo** (one press opens a
  10-second window; the throttle then tracks how fast you tap, settling at
  taps-per-second x 0.10 / 0.8, so ~4 taps/s is half throttle and ~8 is
  full, with an 18-second recharge scaled by the fitted turbo level),
  **air tricks** (flips and spins wind up their own rotations while
  airborne, level out when you let go, and bank points only on a level
  landing — they never touch velocity or heading, so ghost times are
  unaffected), trail-following AI riders, and Ghost Code packing. Runs
  headless under node for tests (`module.exports`).
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
  **wildlife that notices you** — elephants, rhinos, hippos, zebra and antelope
  graze on their own clocks, lift their heads, swivel their ears and swish their
  tails, and turn to face a rider who gets close, all strictly in place because
  the collision bodies are fixed in the deterministic core; a rider with
  crank-driven pedalling legs,
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

**Two players, one screen** — two children on one keyboard, racing each other
at the same time. The canvas is cut into a top strip and a bottom strip; a
downhill rider needs to see left and right to pick a line round a tree, so the
split runs horizontally and each of them keeps the full width, and the stage
goes from 16:9 to 4:3 so both strips still have some height. Player one takes
the left of the keyboard (**W A S D**, space to jump, **Q** for turbo), player
two the right (**arrows**, **/** to jump, **enter** for turbo) — hop is
deliberately not on either Shift, because five taps of Shift raises the Windows
Sticky Keys dialog and would stop a race dead. Each has their own name, jersey,
camera, readout and turbo. First past the arch wins; the other gets 45 seconds
to get home before the flag drops, so a race can never stall on a kid stuck in a
river. Two-up is a race between *them*: no medals, no personal bests, no ghost
recording and nothing goes to the club board.

Under the hood the EffectComposer is sized to **one view**, not to the canvas —
three.js applies a render target's own viewport while rendering into it and only
applies the renderer's viewport to the final draw, so a half-height composer
processes half-height buffers and its last pass lands in whichever strip the
scissor points at. Both players keep bloom and FXAA, with no wasted fill and no
bloom bleeding across the seam. Field of view is solved from a target
*horizontal* angle rather than set vertically, so a wide, short strip does not
fish-eye.

**Race a friend, live** (`js/mp-core.js`, the WebSocket half of `server.js`,
`js/net.js`) — two children on two devices, on the same hill, at the same
moment. One of them presses **Start a race** and gets a four-character code; the
other types it in. That is the whole of it: there is no lobby, no matchmaking,
no directory, no way to search for a race and no way to be put in one with a
stranger. Codes are generated from an alphabet with no `O`/`0`, `I`/`1`, `S`/`5`
or `B`/`8` in it, because a code has to survive being read out loud by one
ten-year-old to another across a kitchen table.

Every rider simulates their own bike exactly as they do in single player and
broadcasts where they are fifteen times a second; the server relays those
samples and keeps the finishing order. No input crosses the wire and no bike is
simulated on the server, so a slow connection costs you a smooth view of your
friend and never control of your own bike — and a rider who goes quiet fades
rather than freezing. The host drops the flag, the server names a moment, and
every device counts down to that same instant on its own clock (measured the
usual way: send a stamp, halve the round trip). While you ride, your friends
appear as full riders in their own jersey colours with their names floating over
them, and a corner panel shows who is where and by how many metres.

**The clock belongs to the server.** A rider's own timer is their own frame
loop, and a frame loop stops: switch tabs, take a call, lock the iPad, and it
freezes while everybody else keeps riding — so reading the time off it would
hand the quickest run to whoever got interrupted, and would let place (arrival
at the server) and time (measured on the device) disagree on the same screen. A
live race is therefore timed from the moment the flag dropped to the moment the
finish reached the server, on one clock, for everybody, and the on-screen timer
during a live race counts that same clock. Coins and crashes are still the
rider's own count, because they decide nothing.

The trade for that honesty is that a rider could still lie about their position,
which is exactly why **a live race sets no personal bests, wins no medals,
unlocks nothing and never reaches the club board**. Records still come only from
a solo run whose Ghost Code the server re-simulates through `js/game3d-core.js`.

**The Tour, together** (`js/mp-core.js` tour rooms, `mpTourArm`/`mpTourFinish`
in `js/game3d.js`). A room can ride the whole Great Zambia Tour instead of one
hill: ten legs, one convoy. Each leg is an ordinary live race, except that the
roadbook picks the track and the sky — in order, Livingstone outward — and no
host can override it. Between legs everybody stops at their own workshop, then
readies up and the convoy rolls out again.

Each rider's purse, bike condition and bag stay entirely on their own machine;
nothing about the workshop crosses the wire. What crosses is what the standings
need: the time the server took at the line, and the seconds a mechanical cost.
That second number is the one thing a rider reports about themselves, and it is
safe in a way the rest is not — `lostMs` only ever *adds*, so the only thing
lying about it can do is put you further down the tour.

The times add up, which is the whole point: **the rider in front on the road is
not always the rider in front on the tour.** Cross the line three seconds up and
a twenty-second puncture still drops you a place. The classification shows every
rider's total, the leader in the jersey and everyone else's gap to them, and it
is redrawn after every leg and in the lobby before the next one.

A tour is thirty-odd minutes, which is longer than a home wifi connection can be
relied on, so a tour room keeps a dropped rider's seat: their name, jersey and
general classification stay in the standings marked *back soon*, and coming back
to the same code under the same name gives all of it back rather than starting
them again from Livingstone. (Until tomorrow's database, that only survives while
somebody is still in the room.)

**When the wifi goes.** The socket is pinged every thirty seconds and a device
that stops answering is dropped, because wifi does not always say goodbye — a
closed lid or a walk out of range can leave a half-open connection holding a
seat in the room that can never be ready, so the flag can never drop. On the
other side, losing the connection mid-race says so: the friend's rider is
cleared rather than left frozen on the trail, a line goes up on screen, and
crossing the line gives a panel that says the race could not be timed instead of
a single-player results screen congratulating you on a run nobody was watching.

Rooms live in memory and nowhere else — nothing about a race is written to the
database, to disk or to a log. A room exists while somebody is in it and is gone
when the last person leaves, which is the right lifetime for four kids racing
after school and means a race leaves no record of who played with whom. Live
racing only appears at all if a server answers `/api/mp/status`; on GitHub Pages
the button never shows and the game is exactly what it was.

A code is four characters out of an alphabet of twenty-three, so 279,841 of
them, and the whole safety story is that you cannot be put in a race you were
not read into. That only holds if nobody can sit there dialling, so wrong codes
have their own small budget — eight per connection, then the socket is hung up
on — separately from the ordinary message allowance, and one machine cannot hold
open a fleet of connections to widen it.

**Weather.** A chip row beside the time-of-day chips: Clear, 🌧️ Rain, ⛈️ Storm.
Rain is a single instanced sheet whose vertex shader wraps every streak inside a
box anchored to the camera, so the CPU never touches a drop and both players ride
through the same downpour; the streaks lean back and stretch as you speed up. The
world goes grey-green and closes in (heavier fog, thicker cloud, a flat sun, more
fill light so it never goes black), wheels throw water instead of dust, mist lies
on the trail, and a storm adds soft, infrequent, `prefers-reduced-motion`-aware
lightning with thunder that rolls in afterwards. It also **changes how the bike
rides** — less bite when you turn, a lot less on the brakes — and it does that
through the bike's own stats, so `js/game3d-core.js` never learns that rain
exists and the AI ghosts stay dry as the fixed benchmark. A wet run is
deliberately locked out of personal bests, medals, unlocks and the club board.
Grand Tour legs whose roadbook says 🌧️ get real rain, and their par times carry
a matching allowance.

**The Great Zambia Tour** (`js/tour.js` + the tour screens in `js/game3d.js`):
ten legs and 16.5 km around the real country, on one clock that never stops —
Livingstone → the Falls → Kazungula → Choma → Kafue → Lusaka → Ndola →
Kasanka → Bangweulu → South Luangwa → Livingstone. Roughly half an hour of
riding at a good pace, closer to an hour on a first attempt. It borrows its
shape from the old Mille Miglia road races: your **race number is your start
time** (number 822 rolls out at 08:22), each leg pays you in kwacha for
distance, coins, beating par and staying upright, and between legs you stand
in **the workshop**.

That workshop is where the tour is actually won. Every leg wears the bike
down by 10–34% depending on surface, weather and how often you crashed, and a
worn bike genuinely brakes worse, steers slower and drags more — the tour
feeds `conditionStats` straight into the same physics stats the Garage does.
Below 72% condition things start to *break*: seven mechanicals (puncture,
snapped chain, worn pads, broken spoke, gear cable, cut tyre, grinding
bearings), each answered by one of nine spares. The bag holds six, so
choosing what to carry is the game — carry a chain link and a snapped chain
costs 20 seconds instead of 70. A rebuild from nothing is K 1000 against a
tour's earnings of about K 2500, so nobody gets a perfect bike *and* a full
bag.

Three deliberate kindnesses, none of which the old games had: the risk of a
mechanical is **stated on the briefing card before you ride**, never sprung
on you; mechanicals cost time, never the tour; and the Grown-Up Crew's
**support van** meets you at every stage finish with a free +10% once-over,
which is what stops a bad day turning into a death spiral. Every stage can be
ridden again, and doing so rolls the tour back exactly — your luck is seeded
off your race number and the stage, so you can ride better but you can never
re-roll it. The tour is **free**, like everything else here; nothing in
Zambia Rush is behind a payment. Progress lives in `zr3_tour` and your best
lap of the whole country in `zr3_tourbest`.

Five 3D mountains: **Miombo Meander** (1.25 km), **Baobab Ridge** (1.5 km,
sunset), **Kasanka Bat Storm** (1.4 km of dusk swamp forest under rivers of
ten million straw-coloured fruit bats flying on instanced wing cards with a real
wing beat, recycled around the rider so the sky is always full, with mist lying
on the trail), **Lower Zambezi** (1.6 km riverside — a flowing river with sandy
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
- **A live race is private to whoever has the code.** No lobby, no matchmaking,
  no directory, no discovery — the only way into a room is a four-character code
  somebody read out to you. Nobody can join once a race has started.
- **The multiplayer protocol has no message that carries free text.** There is
  no chat because there is nowhere to put one: the only thing a player ever
  sends about themselves is a first name, sanitized to a small character set and
  capped at twelve characters, and a jersey colour from a fixed list of six. A
  position sample is six numbers and two flags, validated field by field on the
  server, and anything else in it is dropped.
- **Rooms are memory only.** Nothing about a race is written to the database, to
  disk or to a log, and a room ceases to exist the moment the last rider leaves.

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

Live racing rides on the same port, at `ws://<host>:<port>/mp`. It needs no
database and no configuration — rooms are in memory, so two kids on the same
home wifi can race each other against a bare `npm start`.


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
| `PORT` | Port to listen on (Railway sets it; defaults to 3000). Live racing shares it on `/mp`. |

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
