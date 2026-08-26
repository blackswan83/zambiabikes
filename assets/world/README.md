# Drop world assets here 🌍

This folder is the **drop zone** for real photo-scanned textures, sky images
and 3D models that make Zambia Rush look less hand-drawn and more like a
photograph of Zambia.

Right now the game generates *everything* on the fly — every texture is
painted onto a canvas in JavaScript at load time, and every tree, rock and
animal is built from primitive shapes. That's why it ships with zero image
files and loads instantly. It's also the ceiling: procedural code can fake
"dirt-ish brown", but it can't fake a photograph of real Zambian laterite.

Put files in the exact paths below and the game will pick them up
automatically. Anything missing simply falls back to the procedural version,
so a half-filled folder is fine — add one texture set at a time and watch
the mountain improve.

## Rules that matter

- **Licence: CC0 / public domain only.** This is a kids' club site; we can't
  ship anything with attribution or commercial restrictions. Good sources are
  listed at the bottom.
- **Keep files small.** Everything here is downloaded by a child on a school
  laptop, possibly on mobile data. Target **under 1.5 MB per texture** and
  **under 25 MB for the whole folder**. GitHub also refuses single files
  over 100 MB.
- **2048 × 2048 is plenty** for textures — 4K files are four times the
  download for a difference nobody sees at riding speed. Downsize before
  uploading.
- **JPG for colour, PNG only if you need transparency.** WebP works too.
- Lowercase filenames, hyphens not spaces, exactly as spelled below.

## What to put where

### `hdri/` — the sky and the light

One equirectangular sky image per lighting mood. These do double duty: they
become the sky *and* the light source that colours everything on the ground,
which is the single biggest realism upgrade available.

| File | Used by | Look for |
| --- | --- | --- |
| `sky-morning.hdr` | Miombo Meander | soft morning, high sun, light cloud |
| `sky-sunset.hdr` | Baobab Ridge | low golden sun, warm sky |
| `sky-noon.hdr` | Lower Zambezi, Mosi Falls | bright midday, blue sky |

`.hdr` is preferred (real brightness range). A `.jpg` equirectangular photo
works as a fallback — name it `sky-morning.jpg` etc. **Use the 2K version**,
not 4K or 8K.

### `textures/` — the ground and the bark

Each material wants up to three images. Only `-albedo` is required; the other
two add the bumps and the shine, and are worth having.

```
textures/dirt/dirt-albedo.jpg     ← the colour photo (required)
textures/dirt/dirt-normal.jpg     ← the bumpiness map (purple-blue looking)
textures/dirt/dirt-rough.jpg      ← the shininess map (greyscale)
```

Same pattern for each of these folders — search the source sites for the
words in the right-hand column:

| Folder | Prefix | Search for |
| --- | --- | --- |
| `textures/dirt/` | `dirt-` | dry dirt road, laterite, red soil |
| `textures/grass/` | `grass-` | dry savanna grass, wild grass |
| `textures/rock/` | `rock-` | granite, weathered rock |
| `textures/sand/` | `sand-` | river sand, beach sand |
| `textures/bark/` | `bark-` | baobab bark, acacia bark |

### `models/` — trees, rocks, animals

**glTF only** — a single `.glb` file per model (that format packs the mesh
and its textures into one file). `.fbx`, `.obj`, `.blend` and `.max` won't
load in a browser; if that's what you have, open it in Blender (free) and
export as `.glb`.

| File | Replaces |
| --- | --- |
| `models/baobab.glb` | the procedural baobab |
| `models/miombo-tree.glb` | the general forest tree |
| `models/palm.glb` | the riverside palms |
| `models/rock-01.glb`, `rock-02.glb` | scattered boulders |
| `models/reeds.glb` | the papyrus clumps |

Keep each model **under 20 000 triangles** — the game draws hundreds of trees
at once, so a beautiful 500 000-triangle scan will freeze a Chromebook.
Low-poly game-ready models are the right thing here, not film assets.

## Where to find CC0 assets

- **[polyhaven.com](https://polyhaven.com)** — HDRI skies, PBR textures and
  models. Everything is CC0. This is the best single stop; grab the 2K
  downloads.
- **[ambientcg.com](https://ambientcg.com)** — huge CC0 PBR texture library,
  excellent ground and bark materials.
- **[quaternius.com](https://quaternius.com)** — CC0 low-poly nature models
  (trees, rocks, animals) that suit the game's style and are already
  game-weight.
- **[kenney.nl/assets](https://kenney.nl/assets)** — CC0 low-poly kits.

## After you add files

Tell Claude what you dropped in. The loaders aren't wired up yet — that work
happens once there are real files to test against, because loading code that
has never seen a real asset is code nobody has verified.
