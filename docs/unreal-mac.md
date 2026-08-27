# Zambia Rush on Unreal Engine 5 — building the Mac app

The Unreal port lives in `unreal/ZambiaRush/`. The web game is untouched and
still the canonical version.

Everything in the repository is text. `Content/` is generated, not committed.

---

## What was built and why it is shaped this way

`js/game3d-core.js` was already renderer-independent — `server.js` re-simulates
submitted Ghost Codes through it to validate leaderboard times. So the port is
a transliteration of those 1,082 lines into C++ (`ZRCore`), with a new renderer
written against Unreal instead of Three.js on top.

The consequence worth knowing: **the bike does not use Unreal physics at all.**
No Chaos Vehicles, no rigid bodies. `AZRRiderPawn` writes its transform
directly from `ZR::StepRider` each fixed 1/60 s step; terrain contact is
`ZR::HeightAt` and prop collision is ZRCore's own spatial hash. That is what
makes the feel identical rather than "retuned to feel similar", keeps Armand's
and Arthur's times honestly comparable, and lets a Ghost Code recorded in a
browser replay in the Mac app.

---

## Prerequisites

- macOS 13 or later. (Nanite is deliberately **not** used — it would require
  SM6, macOS 15+, and an M2 or newer, for no benefit on an 83k-triangle
  hillside. Lumen is on.)
- Unreal Engine 5.8, installed through the Epic Games Launcher.
- Xcode, at a version UE 5.8 supports, plus command line tools:
  `xcode-select --install`. **Check this before anything else** — a mismatched
  Xcode is the classic first-day loss.
- Node 18+ and a C++17 compiler, for the parity check. Both are almost
  certainly already there.

There is **no Live Coding on Mac** (Live++ is Windows-only). Every C++ change
means quit editor → rebuild → reopen: a 1–3 minute cycle, after a first build
of 20–60 minutes. This is why the sky and post-process values are console
variables rather than constants — see *Tuning the look* below.

---

## 0. Verify the simulation first

This needs no Unreal, no Xcode and about thirty seconds. Do it before anything
else, because everything else rests on it.

```bash
cd unreal/ZambiaRush/Tools
./verify.sh
```

Expected:

```
  miombo   bit-exact (93020 lines)
  baobab   bit-exact (104373 lines)
  kasanka  bit-exact (100934 lines)
  zambezi  bit-exact (112624 lines)
  falls    bit-exact (114229 lines)
ZRCore matches js/game3d-core.js exactly.
```

That compares the C++ core against the shipping JavaScript running under Node:
every heightfield and trail-distance cell as raw bit patterns, all 250 trail
points, every prop in order, coins, gates, kickers, 3,000 terrain queries with
normals, both AI ghosts and their full sample streams, the Ghost Codes
themselves, a scripted player run exercising hop / turbo / tricks, and the
codec's rejection cases.

**It is exact, not tolerant.** If it ever reports a mismatch, stop: the port has
diverged from the game and nothing built on top of it is trustworthy.

---

## 1. Generate the Xcode project and build

```bash
# From the repository root.
UE=/Users/Shared/Epic\ Games/UE_5.8      # wherever yours lives
"$UE/Engine/Build/BatchFiles/Mac/GenerateProjectFiles.sh" \
    -project="$PWD/unreal/ZambiaRush/ZambiaRush.uproject" -game -engine
```

Open `unreal/ZambiaRush/ZambiaRush.xcworkspace` and build the
**ZambiaRushEditor** scheme. First build is slow.

---

## 2. Generate the material

The editor target has to exist before this will run — a commandlet cannot run
against C++ that has not compiled.

```bash
"$UE/Engine/Binaries/Mac/UnrealEditor-Cmd" \
    "$PWD/unreal/ZambiaRush/ZambiaRush.uproject" \
    -run=pythonscript \
    -script="$PWD/unreal/ZambiaRush/Tools/gen_assets.py" \
    -unattended -nosplash
```

This writes `Content/Materials/M_ZRVertexColor` and `M_ZRGhost` — the only
binary assets in the project. Everything else (the level, all input, every
mesh) is either engine content or generated in C++ at runtime.

Why a material at all: terrain colour is baked into vertex colours, no shipped
engine material reads vertex colour in a lit pass, and materials cannot be
created at runtime because shader compilation is editor-only.

---

## 3. Run it

Open the project in the editor and press Play. The whole world is spawned by
`AZRGameMode::StartPlay` into the engine's empty `/Engine/Maps/Entry`; there is
no level to open.

**Controls** — the same as the browser game, plus a gamepad:

| | Keyboard | Gamepad |
|---|---|---|
| Pedal | `W` / `↑` | Right shoulder |
| Brake | `S` / `↓` | Left shoulder |
| Steer | `A` `D` / `←` `→` | D-pad |
| Bunny hop | `Space` | A |
| Turbo | `K` — press once, then **tap fast** | B |
| Pause | `Esc` / `P` | Start |

In the air those same keys become tricks: pedal/brake flip, steer spins. Tricks
never touch velocity or heading, so they cost nothing but a bad landing.

Turbo is tap-**rate** driven: one press opens a ten-second window, then the
throttle tracks how fast you tap (~4 taps/s is half, ~8 is full). This is why
input is read in `AZRPlayerController::InputKey` rather than through Enhanced
Input, which fires at most once per frame per action and structurally cannot
count taps.

---

## 4. Package the Mac app

**Do this early, not at the end.** The most likely failure in the whole project
only shows up at cook time.

```bash
"$UE/Engine/Build/BatchFiles/RunUAT.sh" BuildCookRun \
    -project="$PWD/unreal/ZambiaRush/ZambiaRush.uproject" \
    -platform=Mac -clientconfig=Development \
    -build -cook -stage -pak -package -archive \
    -archivedirectory="$PWD/unreal/ZambiaRush/Build"
```

Switch `-clientconfig=Development` to `Shipping` for a release build.

### If the packaged app is a black screen but the editor was fine

That is the string-reference trap, and it is the expected first failure. The
game loads engine content by path — `/Engine/BasicShapes` for the bike and
props, `/Engine/EngineFonts` for the HUD, `/Engine/EngineSky` for the cloud
material, `/Engine/Maps/Entry` for the level. String references are invisible
to the cooker: they resolve in the editor and return `nullptr` in a packaged
build.

The fix is already in `Config/DefaultGame.ini` as `+DirectoriesToAlwaysCook`
entries. If you add anything else loaded by path, add it there too.

---

## 5. Sign and notarise

Needs your Apple Developer ID. An ad-hoc-signed build runs only on the machine
that made it.

```bash
APP="unreal/ZambiaRush/Build/Mac/ZambiaRush.app"
IDENT="Developer ID Application: YOUR NAME (TEAMID)"

codesign --force --deep --options runtime --timestamp \
    --entitlements unreal/ZambiaRush/Build/Mac/ZambiaRush.entitlements \
    --sign "$IDENT" "$APP"

hdiutil create -volname "Zambia Rush" -srcfolder "$APP" -ov -format UDZO ZambiaRush.dmg
codesign --force --sign "$IDENT" ZambiaRush.dmg

xcrun notarytool submit ZambiaRush.dmg \
    --apple-id you@example.com --team-id TEAMID --password "$APP_SPECIFIC_PASSWORD" \
    --wait
xcrun stapler staple ZambiaRush.dmg
```

Verify on a Mac that has never had Unreal installed. `spctl -a -vvv "$APP"`
should say `accepted`.

If you hand someone an unsigned build to try, they will need
`xattr -dr com.apple.quarantine ZambiaRush.app`.

---

## Tuning the look

The theme block in each track definition carries the browser game's sky and
lighting values, and the mapping onto Unreal is honest but not exact —
`turbidity` is a Preetham parameter with no `ASkyAtmosphere` equivalent, and
the sky/fog hex colours do not map onto a physical atmosphere at all.

Because there is no Live Coding on Mac, these are console variables. Tune them
in PIE with the `~` console, then paste the values you settled on back into
the source:

| CVar | Default | What it does |
|---|---|---|
| `zr.Track` | `miombo` | Which track to build. All five generate correctly; only miombo's set dressing is finished. |
| `zr.Ghosts` | `1` | Show Armand and Arthur. |
| `zr.Sky.SunIntensity` | `6.0` | Directional light. |
| `zr.Sky.SkyLightIntensity` | `1.0` | Replaces the browser's flat ambient term. |
| `zr.Sky.FogScale` | `1.0` | Multiplier on density derived from `fogFar`. |
| `zr.Sky.Bloom` | `0.22` | Matches the browser's `UnrealBloomPass` strength. |
| `zr.Sky.Clouds` | `1` | Volumetric clouds. First thing to drop if an M1 struggles. |
| `zr.Camera.Roll` | `-0.35` | Camera bank per unit of lean. **Sign may need flipping** — see below. |
| `zr.Terrain.FlipWinding` | `0` | If the hillside renders inside-out. See below. |
| `zr.ReduceMotion` | `0` | Suppresses the off-trail camera rumble. |

### Two things that were derived rather than observed

I could not compile or run any of this — it was written in a Linux container
with no macOS, no Xcode and no Unreal. Two visual details therefore rest on
reasoning rather than on having looked at them:

1. **Triangle winding.** If the terrain is invisible from above or lit from
   underneath, set `zr.Terrain.FlipWinding 1`. Props use the same rule, so
   they will be wrong together and fixed together.
2. **Camera roll direction.** The JS-to-Unreal conversion changes handedness.
   If the camera banks *out* of the turns instead of into them, negate
   `zr.Camera.Roll`.

Both are one-line fixes once seen. Everything about how the game *behaves* is
proven by `verify.sh`; only how it *looks* is unverified.

### A known limitation

`UProceduralMeshComponent` does not generate mesh distance fields, so Lumen
cannot software-trace against the terrain and falls back to screen traces for
it. Sky light and the directional light carry the lighting either way and it
looks fine, but if you want full Lumen GI off the hillside later, the route is
`UStaticMesh::BuildFromMeshDescriptions` — a runtime-capable path that produces
real static meshes without any editor involvement.

---

## Where things are

```
unreal/ZambiaRush/
  Config/                       three .ini files; read DefaultGame.ini's
                                DirectoriesToAlwaysCook comment before packaging
  Source/ZambiaRush/Private/
    Core/ZRMath.{h,cpp}         fdlibm sin/cos/atan/atan2, bit-exact with V8
    Core/ZRCore.{h,cpp}         the simulation, transliterated. No Unreal types.
    Game/ZRConvert.h            the ONE place JS space becomes Unreal space
    Game/ZRGameMode.cpp         builds the world, runs the race
    Game/ZRRiderPawn.cpp        fixed-step loop, render interpolation, camera
    Game/ZRPlayerController.cpp key handling, turbo tap queue
    Game/ZRBikeRig.cpp          rider and bike from engine primitives
    Game/ZRGhostRider.cpp       Armand and Arthur, replayed
    Game/ZRHUD.cpp              Canvas HUD
    World/ZRTerrainActor.cpp    heightfield -> procedural mesh
    World/ZRPropField.cpp       props merged per type and band, coins, gates
    World/ZRSkyRig.cpp          sky, sun, fog, cloud, post process
    Audio/ZRSynth.cpp           every sound, synthesised
  Tools/
    verify.sh                   run this first, and after any ZRCore change
    zrcore_reference.js         ground truth, from the shipping JS
    zrcore_verify.cpp           the C++ half
    gen_assets.py               generates the two materials
```

## What is not in the slice

Miombo Meander only, single player. No Garage, no Great Zambia Tour, no
split-screen, no live racing. The other four tracks generate correctly — ZRCore
is verified bit-exact on all five — but their set dressing (the Zambezi's
water, the Falls' gorge and curtain, Kasanka's bats, rain and storm) is not
built yet. `zr.Track baobab` will give you a rideable, undressed Baobab Ridge.
