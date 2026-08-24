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
| `game.html` | **Zambia Rush** — the full game |
| `join.html` | Membership request form (vetted, never automatic) |
| `about.html` | The founders' story, values, the Grown-Up Crew |
| `safety.html` | For parents: vetting, trail safety, online safety, privacy |

No build step, no frameworks, no dependencies beyond Google Fonts. Open
`index.html` or serve the folder statically (GitHub Pages works as-is).

```bash
# local preview
python3 -m http.server 8000
# → http://localhost:8000
```

## The game — Zambia Rush

`js/game.js` is a self-contained 2D physics engine + renderer:

- **Deterministic seeded terrain** — three tracks built from layered sines,
  gaussian kickers and tanh drop-offs, so every rider races the same hills.
- **Fixed-timestep physics** (60 Hz) — pedal, brake/tuck, back/front flips,
  landing-angle crashes, perfect-landing boosts, copper coins, trick scoring.
- **AI ghosts** — Armand and Arthur's ghost runs are *simulated live* by AI
  rider policies through the same physics, so their times are honestly
  beatable. Gold medal = beat Armand.
- **Ghost Codes** — kid-safe multiplayer without a server: export your best
  run as a pasteable code (positions + first name only, nothing else),
  friends import it and race your ghost. No chat, no accounts, no strangers.
- **Local leaderboard**, touch controls, WebAudio synth SFX, pause-on-blur,
  `prefers-reduced-motion` respected.

The engine is testable headlessly (`node`): it exports
`buildTrack / stepRider / simulateAI / packGhost / unpackGhost` via
`module.exports` when no DOM is present.

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
