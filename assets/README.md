# Crystal Maze Defence — Asset Pipeline

This folder is where game art lives. Each file referenced from `App.js` via
`require('./assets/...')` is bundled by Expo at build time and rendered with
React Native's `<Image>` component.

Placeholders are 64×64 PNGs with a coloured ring and a 2-letter label, so the
game still runs (and the sprite slot is visible) before real art arrives.
Replace any placeholder with a real PNG **using the exact same filename** and
the change appears in the next build — no code edits needed.

## Naming convention

- Lower-case, underscores, no spaces.
- 2-digit index prefix matches the canonical roster index.
- Aim for transparent-background PNG, square aspect, 256×256+ for sprites that
  show large in inspect modals; 128×128 is enough for in-board rendering.

## Folder map

### `towers/` (18 specials — per canonical rename list)

| File | Display | Tier |
|---|---|---|
| `01_moonsteel_prism.png`    | Moonsteel Prism      | P2 |
| `02_verdant_arcstone.png`   | Verdant Arcstone     | P2 |
| `03_ember_obelisk.png`      | Ember Obelisk        | P2 |
| `04_roseglass.png`          | Roseglass            | P3 |
| `05_jade_oracle.png`        | Jade Oracle          | P3 |
| `06_stormsplit.png`         | Stormsplit           | P3 |
| `07_goldhex.png`            | Goldhex              | P3 |
| `08_silver_warden.png`      | Silver Warden        | P4 |
| `09_seraph.png`             | Seraph               | P4 |
| `10_obsidian_breaker.png`   | Obsidian Breaker     | P4 |
| `11_skylar.png`             | Skylar               | P4 |
| `12_monarch.png`            | Monarch              | P5 |
| `13_thunderheart.png`       | Thunderheart         | P5 |
| `14_coral_resonance.png`    | Coral Resonance      | P5 |
| `15_eye_of_the_frozen_sun.png` | Eye of the Frozen Sun | P5 |
| `16_sovereign_diamond.png`  | Sovereign Diamond    | P6 |
| `17_core_of_the_world.png`  | Core of the World    | P6 |
| `18_luna.png`               | Luna                 | P6 |

### `bosses/` (12 received — endless-cycle padded to 20)

| File | Roster id |
|---|---|
| `01_wraith_captain.png`    | wraith_captain |
| `02_eye_magus.png`         | eye_magus |
| `03_lava_lord.png`         | lava_lord |
| `04_ice_lich.png`          | ice_lich |
| `05_crystal_dragon.png`    | crystal_dragon |
| `06_lava_scorpion.png`     | lava_scorpion |
| `07_plague_ogre.png`       | plague_ogre |
| `08_forest_treant.png`     | forest_treant |
| `09_lava_cerberus.png`     | lava_cerberus |
| `10_eldritch_horror.png`   | eldritch_horror |
| `11_demon_warlord.png`     | demon_warlord |
| `12_crystal_serpent.png`   | crystal_serpent |

### `decor/`

| File | Use |
|---|---|
| `spawn_portal.png`       | The start-of-path portal (Hells Gate aesthetic) |
| `castle_keep.png`        | The end-of-path castle / goal |
| `crystal_monument.png`   | Lobby central piece |
| `recipe_master.png`      | Recipe Master NPC portrait |

### `gems/` (optional — current SVG works well)

If you want photo-real gem sprites instead of the SVG renderer, drop files like
`sapphire_p1.png` … `topaz_p6.png` (48 total). Code path is wired but disabled
by default.

### `biomes/`

| File | Use |
|---|---|
| `default.png` | Single board background reused across biomes (per user instruction "räcker med samma temporärt") |

When more biome backgrounds arrive: `enchanted_grove.png`, `lava.png`,
`ice_spire.png`, `topaz_highlands.png`, `ruby_crag.png`, `aquamarine_bay.png`.

## How drop-in works

`App.js` has an `ASSET_MAP` constant near the top that calls `require()` for
each expected path. The rendering helpers (`SpriteOrSvg`) try to render the
asset; if the placeholder is still in place, you'll see the coloured ring.
Replace the file, rebuild, the real art shows up.

No code changes required when swapping a placeholder for a real PNG with the
same filename.
