# Zambia Rush in Unreal Engine

How Claude drives the Unreal Editor directly, what that is good for, and a
draft scope for bringing Zambia Rush 3D across. Researched 5 September 2026.
This is a working document: the phases and decisions at the end are a
proposal to argue with, not a plan that has been agreed.

## The short answer

Use **Unreal Engine 5.8** and its built-in **Unreal MCP** plugin, with Epic's
own **Claude Code plugin** on the Claude side. Run Claude Code **on the same
machine as the editor**. That combination is first-party on both ends, free,
maintained by Epic, and it is the route Epic has said it will carry into UE6.

- UE 5.8 (released 17 June 2026) ships an experimental plugin, shown in the
  Plugin Browser as *Unreal MCP* and identified in code as
  `ModelContextProtocol`. It runs a Model Context Protocol server inside the
  editor process, at `http://127.0.0.1:8000/mcp` by default.
- Epic publishes `unreal-engine-skills-for-claude-code` (v3.0.4, MIT) in the
  official Claude Code plugin marketplace. It teaches Claude how to discover
  and call the editor's tools and how to stay safe while doing it.
- Together they expose hundreds of editor operations across 30-plus
  "toolsets": actors and levels, Blueprints, materials and material instances,
  static and skeletal meshes, Niagara, Sequencer, Control Rig, State Trees,
  UMG widgets, Gameplay Ability System, automation tests, Live Coding, and
  arbitrary editor Python.

Everything else on the market is either a 5.7-era workaround (UnrealClaude,
mcp-unreal, the Python remote-execution servers) or an add-on that plugs
*into* the official server (VibeUE, ClaudeUnreal). Start with the official
pair and add VibeUE when we reach landscape and foliage work.

## What actually shipped in 5.8

**Architecture.** `ModelContextProtocol` is only the server and transport.
Tools come from a sibling system, the **Toolset Registry**: a toolset is a
class of static, AI-callable functions, and the **AllToolsets** plugin is an
aggregator that enables every toolset Epic ships (SceneTools, ActorTools,
BlueprintTools, MaterialTools, MaterialInstanceTools, ObjectTools,
StaticMeshTools, LevelTools, NiagaraTools, SequencerTools,
LiveCodingToolset, AgentSkillToolset and so on). Enabling the MCP plugin
without AllToolsets gives a server that connects and exposes nothing.

**Tool search.** By default the server advertises only three meta-tools:
`list_toolsets`, `describe_toolset` and `call_tool`. Claude discovers the tool
it needs, reads its schema, then dispatches it by name through `call_tool`.
That keeps the context window small even with hundreds of tools registered.

**Project skills.** A project can register *Agent Skills*: named bundles of
instructions (naming conventions, folder layout, the canonical sequence for a
multi-step job) that Claude loads through `AgentSkillToolset.ListSkills` and
`GetSkills` before starting unfamiliar work. We should write one for Zambia
Rush early: it is how Claude learns "tracks are imported like this, bikes are
named like that".

**Extensible in Python or C++.** A custom toolset is a class deriving from
`unreal.ToolsetDefinition` with `@toolset_registry.tool_call` static methods
(Python), or from `UToolsetDefinition` with `UFUNCTION(meta = (AICallable))`
static methods (C++). Python needs no rebuild. Epic's plugin includes a
`create-toolset` skill that walks Claude through authoring one. This matters
for us: "build the Miombo Meander landscape and trail from seed 4471" can
become a single project tool that Claude calls.

**In-editor terminal.** Epic's troubleshooting notes refer to a Claude Code
tab that can be docked inside asset editors (an `AIAssistantToolset` reads
"docked context" from it). Third-party plugins (ClaudeUnreal, UnrealClaude)
do the same. This is a convenience over running Claude in a terminal next to
the editor, not a different mechanism; the editor docs were not reachable
from the research environment, so treat the detail as unverified.

**Status and safety.** The whole thing is marked Experimental. The server
binds to loopback only, has no authentication and is explicitly not designed
for remote use. `execute_tool_script` runs arbitrary Python with full editor
privileges. Epic's own guidance: never run Claude with
`--dangerously-skip-permissions` while the plugin is active, and commit to
source control before any long MCP session.

**Roadmap.** Coverage of State of Unreal 2026 says Epic intends the MCP
plugins to become integral to Unreal Engine 6, whose early access is
currently slated for late 2027.

## Where Claude has to run

The MCP server accepts same-machine connections only. That has one practical
consequence for how we work:

| Session type | Can it drive the editor? | What it is for |
| --- | --- | --- |
| Claude Code **on the Unreal machine** (terminal, desktop app, or IDE extension) | Yes | Level assembly, Blueprints, materials, Niagara, tests, Live Coding compiles, anything that needs the editor |
| Claude Code **in the cloud** (sessions like this one) | No editor, no engine, no compiler | C++ and Python source, data tables and config, the exporter from the existing JS game, `server.js` changes, docs, code review |

Cloud sessions still do real work on the port: the deterministic core, the
data catalogues, the server protocol and the exporter are all plain code that
can be written and unit-tested without Unreal. Only editor operations and
compiles have to happen locally.

## Setup checklist

Steps 1 to 3 are Epic's own first-time setup, verbatim in substance.

1. **Install UE 5.8** from the Epic Games Launcher. Make a C++ project
   (Games > Blank, C++), for example `ZambiaRush`. On Windows install Visual
   Studio 2022 with the Unreal workload; on macOS, Xcode.
2. **Enable the plugins** in the `.uproject` (Edit > Plugins also works):
   ```json
   { "Name": "ModelContextProtocol", "Enabled": true },
   { "Name": "AllToolsets", "Enabled": true }
   ```
   Also enable **Python Editor Script Plugin** and turn on *Developer Mode*
   in Project Settings > Plugins > Python, which writes
   `Intermediate/PythonStub/unreal.py` (Claude reads it when writing tools).
3. **Auto-start the server** by adding this to
   `<Project>/Saved/Config/<Platform>Editor/EditorPerProjectUserSettings.ini`
   (per-user, not committed), or tick *Auto Start Server* under Editor
   Preferences > General > Model Context Protocol:
   ```ini
   [/Script/ModelContextProtocolEngine.ModelContextProtocolSettings]
   bAutoStartServer=True
   ```
   Manual alternative: `ModelContextProtocol.StartServer [port]` in the
   editor console.
4. **Generate the client config** by running
   `ModelContextProtocol.GenerateClientConfig ClaudeCode` in the console. It
   writes `.mcp.json` next to the `.uproject`:
   ```json
   { "mcpServers": { "unreal-mcp": { "type": "http", "url": "http://127.0.0.1:8000/mcp" } } }
   ```
   We commit this file; it contains nothing machine-specific.
5. **Install Claude Code locally** and Epic's plugin:
   ```
   /plugin marketplace add anthropics/claude-plugins-official   # only if the marketplace is not already present
   /plugin install unreal-engine-skills-for-claude-code@claude-plugins-official
   ```
   For the team, commit `.claude/settings.json` with
   `"enabledPlugins": { "unreal-engine-skills-for-claude-code@claude-plugins-official": true }`
   so anyone opening the project is prompted to install it. On Windows the
   plugin's SessionStart hook needs `bash` on PATH (Git Bash or WSL).
6. **Smoke test.** Editor running, `claude` started in the project folder,
   `/mcp` shows `unreal-mcp` connected, then "list all actors in the current
   level" returns something sensible.
7. **Source control before anything else.** Git with LFS (or Perforce) set
   up, `.gitignore` for `Binaries/`, `Intermediate/`, `Saved/`,
   `DerivedDataCache/`, and a commit before every long session.

Useful console commands for later: `ModelContextProtocol.StopServer`,
`ModelContextProtocol.RefreshTools` (after enabling a new toolset plugin),
`ModelContextProtocol.GenerateClientConfig All`.

## What a session looks like

1. Launch the editor; the server starts on its own.
2. Open Claude Code in the project folder (or the docked tab).
3. Ask for work in plain language: "Import `Import/miombo/height.png` as a
   Landscape at 1 m per vertex, then spawn a spline actor from
   `Import/miombo/trail.json` and place a checkpoint gate Blueprint at each
   gate entry."
4. Claude calls `list_toolsets`, reads the schemas it needs with
   `describe_toolset`, and runs each step with `call_tool`, one at a time.
5. After editing C++, Claude asks for `LiveCodingToolset.CompileLiveCoding`,
   which blocks until the compile finishes and returns the diagnostics.
6. Save, run the automation tests through the automation toolset, commit.

Rules Epic bakes into the plugin, which we keep: save before and after bulk
changes (MCP edits are not reliably undoable); never issue tool calls in
parallel (they run on the game thread); wait out compiles; check every
result flag; stop Play-in-Editor before asset operations.

## Known rough edges

- **Experimental.** Epic says it is not yet possible to safely automate
  every Blueprint graph edit; coverage depends on the toolsets exposed. Node
  wiring works for common cases and fails quietly for others, so Blueprint
  logic should be small and mostly in C++ anyway.
- **Editor asserts crash the editor.** Hands-on reports name spline
  components in particular. A crash loses unsaved work, hence save-first.
- **One thing at a time.** Everything runs on the game thread, so Claude is
  slower in the editor than it is in a code base. Bulk work is best expressed
  as a Python script or a project tool, not hundreds of individual calls.
- **No visual judgement built in.** The official toolsets act on data; they
  do not look at the viewport. Screenshots and "does this look right" remain
  a human step (some third-party add-ons offer viewport capture).
- **Windows needs Git Bash** for the plugin's hook; macOS and Linux work as
  is. Community reports say Apple Silicon works.

## Third-party options, and whether we need them

| Project | Engine | What it adds | Verdict |
| --- | --- | --- | --- |
| [VibeUE](https://github.com/kevinpbuckley/VibeUE) (MIT, ~650 stars) | 5.8+ | Registers extra toolsets into the *official* server: landscape sculpting, foliage, procedural blockout, MetaSound, animation, Niagara HLSL, UMG/MVVM, Behavior Trees, profiling, full Python introspection. About 36 skill packs. | Add in Phase 2 for landscape and foliage. Same endpoint, no second server. |
| [ClaudeUnreal](https://echoulen.github.io/claude-unreal/) | 5.7 / 5.8 | Docked Claude Code terminal in the editor; can mount its tools onto the official server. | Nice to have; evaluate once the basics work. |
| [ZiggyMar/unreal-mcp](https://github.com/ZiggyMar/unreal-mcp) (MIT) | 5.6 / 5.8 | Token-efficient Blueprint *reading*, persistent project index, runtime observation, C++ hot reload. Complements Epic's creation-focused tools. | Consider if reading large Blueprints becomes a bottleneck. |
| [sam-david/unreal-mcp](https://github.com/sam-david/unreal-mcp) (MIT) | 5.3+ | 127 tools over Python remote execution and the Remote Control API, no C++ plugin. | Only if we were stuck on an older engine. |
| [remiphilippe/mcp-unreal](https://github.com/remiphilippe/mcp-unreal) (Apache-2.0) | 5.7 | Headless builds, cooks and automation tests without the editor. | The headless build idea is worth copying as plain scripts; the server itself is 5.7-only. |
| [Natfii/UnrealClaude](https://github.com/Natfii/UnrealClaude) (MIT, ~900 stars) | 5.7 only | In-editor Claude Code panel plus 20-plus tools. | Superseded by the official plugin on 5.8. |
| [ibrews/ue5-mcp](https://github.com/ibrews/ue5-mcp) skill (MIT) | 5.7 / 5.8 | Server-agnostic engine gotchas: crash patterns, reflection rules, PascalCase traps. | Cheap insurance; install alongside Epic's plugin. |
| [immigration2000/unreal-mcp-kit](https://github.com/immigration2000/unreal-mcp-kit) (MIT) | 5.8 | One-command project bootstrap (`.uproject` plugins, `.mcp.json`, `CLAUDE.md`, auto-start `.ini`). | Handy for step 2 to 4 above; tiny project, read the script before running it. |

If the installed engine turns out to be **5.7**, the official plugin does not
exist there. The 5.7 path is VibeUE's 5.7 build plus UnrealClaude, or better,
upgrade to 5.8 before starting; nothing in the project exists yet, so the
upgrade is free.

## What the game is today, and what it becomes in Unreal

The web game is documented in the top-level README. The parts that matter
for a port:

| Today (Three.js) | In Unreal | Notes |
| --- | --- | --- |
| `js/game3d-core.js`: seeded heightfield, trail spline, gates, kickers, props, arcade bike physics, turbo, tricks, AI riders, Ghost Codes. Deterministic, runs headless under Node. | A C++ module with the same fixed-step simulation, driving a custom pawn movement component (not Chaos Vehicles). Terrain sampled from the same function, not from physics traces. | Keeps the feel, keeps ghosts honest, keeps the door open to cross-play and to the existing server-side re-simulation. Port is roughly 1,100 lines of JS, testable against the JS reference. |
| Five procedural mountains (Miombo, Baobab, Kasanka, Zambezi, Mosi) | Exported once from the JS core (16-bit heightmap, trail points, gates, prop placements as JSON) and imported as Landscape plus spline actors; then dressed with real assets. | The exporter is plain Node and can be written in the cloud today. |
| Procedural textures, canvas trees, leaf cards, gradient sky | Quixel Megascans (free for Unreal use via Fab), Nanite foliage, PCG scattering, SkyAtmosphere and volumetric clouds, Lumen (Lumen Lite on low settings). 5.8 adds an experimental Procedural Vegetation Editor and Mesh Terrain; both are optional. | This is where Unreal earns its keep visually. Art assets, not code, are the long pole. |
| Wildlife that notices you; bats; birds; river with hippos and crocodiles; waterfall | Skeletal meshes from Fab with State Tree behaviours; Niagara for bats, birds, spray and dust; the Water plugin for the Zambezi and the plunge pool. | Rigged, animated African animals must be bought or commissioned; nothing generates them. |
| Weather: rain, storm, lightning, wet-physics stat modifiers | Niagara rain sheet, material wetness, post-process, audio; the same stat modifiers in the core. | Design carries over unchanged. |
| The Garage: 58 parts, 12 categories, paint booth, tune bench, unlocks | Data assets generated from `js/bikes.js`; a modular bike built from per-part meshes; material parameters per paint zone; a save game for career and unlocks. | Every part is a mesh someone has to make. Expect to cut the catalogue for the first release. |
| Two players, one keyboard, horizontal split | Native local split-screen with two Enhanced Input mappings. | Near free in Unreal. |
| Live racing over `server.js` (rooms, four-character codes, server clock, 15 Hz samples, no free text) | A WebSocket client in C++ speaking the existing protocol, so `server.js` stays as it is; or Epic Online Services lobbies and P2P with the same code-only joining. | Reusing the protocol preserves every kid-safety decision already made and allows web and Unreal riders to race each other if the core matches. |
| The Great Zambia Tour: ten legs, wear, mechanicals, spares, workshop, kwacha | Tour state machine and economy ported as data plus C++; UMG screens for briefing, workshop and results. | Pure logic, cloud-writable. |
| Ghost Codes and the shared leaderboard re-simulated by the server | Same code format if the C++ core reproduces the JS core within tolerance; otherwise a separate Unreal leaderboard. | Decision below. |
| Runs in any browser, tablets included | No web target exists in UE 5 (HTML5 export ended with 4.24; third-party WebGPU ports cover up to 5.4). Desktop first; iPad and Android are real Unreal targets but need Xcode and store accounts and ship as gigabyte downloads. | The Three.js game stays the browser version. |

## Draft scope

Sizes are rough ranges for one developer plus Claude, and they assume art is
mostly bought from Fab rather than made. Everything after Phase 2 can be
reordered.

**Phase 0: Foundations (about a week).** Engine and project created, plugins
and Claude Code wired up per the checklist, repository with LFS, `CLAUDE.md`
and a first Zambia Rush Agent Skill (naming, folders, import workflow).
In this repo, in the cloud: `tools/export-track.js` that dumps each of the
five tracks from `game3d-core.js` (heightmap, spline, gates, kickers, props)
and a generated `bikes.json` from the parts catalogue. Exit: Claude lists
actors in the editor; the exporter runs under `node` with a test.

**Phase 1: Vertical slice on Miombo Meander (three to four weeks).**
Landscape and trail imported through MCP, C++ fixed-step bike core ported
with parity tests against the JS reference, chase camera, gates and finish,
timer and HUD, keyboard plus gamepad, Armand's ghost riding alongside.
Exit: a run that feels like the web game, playable by the boys.

**Phase 2: The five mountains (four to six weeks).** All tracks imported,
biome kits per track, PCG scattering, water, sky and time of day, weather,
wildlife behaviours, bats and birds, the falls. VibeUE added for landscape
and foliage tooling. Exit: every track rideable and recognisably Zambian.

**Phase 3: Garage and progression (three to four weeks).** Data assets from
the catalogue, a modular bike with a reduced first-release parts list, paint
zones, tune bench, career save and unlocks feeding the physics stats.

**Phase 4: Two players and live racing (three to five weeks).** Split screen;
then the WebSocket client against `server.js` (or EOS), with the same
no-text, code-only, memory-only rules.

**Phase 5: The Great Zambia Tour (two to three weeks).** Legs, wear,
mechanicals, spares, workshop, kwacha, support van, seeded luck, tour UI.

**Phase 6: Ghosts, leaderboard, parity (about two weeks).** Ghost recording
and playback, Ghost Code compatibility, server re-simulation parity or a
separate board.

**Phase 7: Packaging and platforms (ongoing).** Windows and macOS builds,
scalability presets, reduced-motion and accessibility settings, a tablet
feasibility spike, playtests.

A "minimum lovable" cut is Phases 0 to 2 plus a fixed bike: a beautiful
single-player Zambian downhill game in Unreal, with the garage, tour and
multiplayer following on the web version's proven design.

## Decisions needed before Phase 0

1. **Engine and machine.** Confirm it is 5.8 (not 5.7) and which OS. Windows
   is the smoothest Unreal development platform; macOS works and is required
   for iPad later.
2. **Platforms.** Desktop only for the first release, with the browser game
   remaining the tablet version? Or is tablet a first-class goal (which
   changes the art budget and the performance targets from day one)?
3. **Physics.** Arcade port of the existing core (recommended: same feel,
   deterministic, cross-play possible) versus Chaos-based two-wheel realism
   (Fab sells a "Bicycle Riding System" on Chaos, but two-wheel balance is a
   known pain and it forfeits the honest ghosts).
4. **Art direction and budget.** Stylised or realistic? Roughly what can be
   spent on Fab for animals, rider, bikes and foliage? Megascans are free.
5. **Repository and storage.** A separate `zambia-rush-unreal` repository
   with Git LFS is the usual answer; GitHub's free LFS quota is about a
   gigabyte, so budget for a data pack or use a host with free LFS.
6. **Multiplayer transport.** Reuse the `server.js` protocol (recommended,
   preserves the safety design) or Epic Online Services.
7. **Scope cut.** Full port or the minimum lovable cut first?

## Sources

- [Unreal MCP in Unreal Editor (UE 5.8 docs)](https://dev.epicgames.com/documentation/unreal-engine/unreal-mcp-in-unreal-editor)
- [ModelContextProtocol plugin index (UE 5.8 docs)](https://dev.epicgames.com/documentation/unreal-engine/API/PluginIndex/ModelContextProtocol)
- [Unreal Engine 5.8 release notes](https://dev.epicgames.com/documentation/unreal-engine/unreal-engine-5-8-release-notes)
- [Unreal Engine 5.8 is now available (Epic news)](https://www.unrealengine.com/news/unreal-engine-5-8-is-now-available)
- [EpicGames/unreal-engine-skills-for-claude-code-plugin](https://github.com/EpicGames/unreal-engine-skills-for-claude-code-plugin), including its `references/setup.md`, `references/operations.md` and `create-toolset` skill
- [Official Claude Code plugin marketplace entry](https://github.com/anthropics/claude-plugins-official)
- [Claude Code MCP documentation](https://code.claude.com/docs/en/mcp)
- [Using the UE5 MCP server with Claude Code, Codex CLI and Cursor (Epic community tutorial)](https://dev.epicgames.com/community/learning/tutorials/DEKE/using-the-unreal-engine-5-mcp-server-with-claude-code-codex-cli-and-cursor)
- [How to register Python functions as AI-callable tools through Unreal MCP (Epic forums)](https://forums.unrealengine.com/t/how-to-register-python-functions-as-ai-callable-tools-through-unreal-mcp-ue-5-8/2741072)
- [Extending Unreal Engine MCP: toolsets, AI-callable methods and skills](https://buckley-builds.com/blog/extending-unreal-engine-mcp/)
- [Epic's official MCP plugin vs third-party servers (StraySpark)](https://www.strayspark.studio/blog/epic-official-mcp-plugin-ue5-8-vs-third-party)
- [Unreal Engine MCP hands-on (Puget Systems)](https://www.pugetsystems.com/blog/2026/07/09/unreal-engine-mcp-hands-on-testing-ai-inside-the-editor/)
- [Let's see how MCP works in Unreal 5.8 (Sponge Hammer)](https://www.spongehammer.com/unreal-engine-5-8-mcp-ai-workflow/)
- [Epic Games details how it's embracing generative AI in Unreal Engine (Engadget)](https://www.engadget.com/2196807/epic-games-details-how-its-embracing-gen-ai-in-unreal-engine/)
- [State of Unreal 2026 coverage (Biunivoca)](https://www.biunivoca.com/en/blog/state-of-unreal-2026-the-future-of-unreal-engine-6-ue-5-8-and-the-fortnite-ecosystem)
- [VibeUE](https://github.com/kevinpbuckley/VibeUE), [ClaudeUnreal](https://echoulen.github.io/claude-unreal/), [ZiggyMar/unreal-mcp](https://github.com/ZiggyMar/unreal-mcp), [sam-david/unreal-mcp](https://github.com/sam-david/unreal-mcp), [remiphilippe/mcp-unreal](https://github.com/remiphilippe/mcp-unreal), [Natfii/UnrealClaude](https://github.com/Natfii/UnrealClaude), [ibrews/ue5-mcp](https://github.com/ibrews/ue5-mcp), [immigration2000/unreal-mcp-kit](https://github.com/immigration2000/unreal-mcp-kit)
- [Motorbike physics with Chaos Vehicles (Epic community tutorial)](https://dev.epicgames.com/community/learning/tutorials/LnDB/unreal-engine-motorbike-motorcycle-physics-with-chaos-vehicles-ue5), [Bicycle Riding System on Fab](https://www.fab.com/listings/0662a52b-891a-4962-bb27-2ef8ebdca9e5)
- [WebGPU for Unreal Engine 5 (Epic forums)](https://forums.unrealengine.com/t/webgpu-for-unreal-engine-5-5-6-and-5-7-support/2693960)
- [Unreal Engine 5.8 preview features (Toolfarm)](https://www.toolfarm.com/news/unreal-engine-5-8-preview/), [UE 5.8 performance highlights (Tom Looman)](https://tomlooman.com/unreal-engine-5-8-performance-highlights/)
