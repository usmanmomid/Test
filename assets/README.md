# Crystal Maze Defence - Asset Pipeline

This folder contains the mobile game's art. `App.js` stays Snack-safe because
the active sprite path references GitHub raw URLs in `ASSET_MAP`, not local
`require()` calls. Each sprite renderer falls back to SVG if the remote image
cannot load.

If sprite switches are enabled inside Expo Snack, those raw URLs must be public.
Private GitHub repos return 404 to the Expo app, even if the user can see the
files while logged in.

For the eventual App Store build, these remote sources should be replaced with
bundled Expo assets. The optimized PNGs in `assets/runtime/` are the intended
runtime files.

## Current Rules

- Do not rename files without updating `ASSET_MAP` in `App.js`.
- Keep transparent-background PNGs for board sprites.
- Source art can be large, but board sprites should use the downscaled files in
  `assets/runtime/`.
- `USE_SPRITES` is enabled for towers, bosses, and decor. If a remote file fails
  to load, the renderer falls back to the SVG version instead of blanking.

## Folder Map

### `runtime/towers/`

Runtime tower art is currently mapped to:

| Recipe slot | Runtime file |
|---|---|
| 1 | `assets/runtime/towers/special_01.png` |
| 2 | `assets/runtime/towers/special_02.png` |
| 3 | `assets/runtime/towers/special_03.png` |
| 4 | `assets/runtime/towers/special_04.png` |
| 5 | `assets/runtime/towers/special_05.png` |
| 6 | `assets/runtime/towers/special_06.png` |
| 7 | `assets/runtime/towers/special_07.png` |
| 8 | `assets/runtime/towers/special_08.png` |
| 9 | `assets/runtime/towers/special_09.png` |
| 10 | `assets/runtime/towers/special_10.png` |
| 11 | `assets/runtime/towers/special_11.png` |
| 12 | `assets/runtime/towers/special_12.png` |
| 13 | `assets/runtime/towers/special_13.png` |
| 14 | `assets/runtime/towers/special_14.png` |
| 15 | `assets/runtime/towers/special_15.png` |
| 16 | `assets/runtime/towers/special_16.png` |
| 17 | `assets/runtime/towers/special_17.png` |
| 18 | `assets/runtime/towers/special_18.png` |

The `assets/towers/` files are kept as uploaded source art/reference sheets.

### `runtime/bosses/`

| Roster slot | Current file |
|---|---|
| 1 | `assets/runtime/bosses/boss_01_pirate_king.png` |
| 2 | `assets/runtime/bosses/boss_02_void_monarch.png` |
| 3 | `assets/runtime/bosses/boss_03_hellforge_brute.png` |
| 4 | `assets/runtime/bosses/boss_04_frost_lich.png` |
| 5 | `assets/runtime/bosses/boss_05_storm_crawler.png` |
| 6 | `assets/runtime/bosses/boss_06_ogre_king.png` |
| 7 | `assets/runtime/bosses/boss_07_roots.png` |
| 8 | `assets/runtime/bosses/boss_08_ashfang.png` |
| 9 | `assets/runtime/bosses/boss_09_kraken.png` |
| 10 | `assets/runtime/bosses/boss_10_scorpion_king.png` |
| 11 | `assets/runtime/bosses/boss_11_maze_bull.png` |
| 12 | `assets/runtime/bosses/boss_12_medusa.png` |

`BOSS_ROSTER` still uses internal ids from the prototype. Update both
`BOSS_ROSTER` and `ASSET_MAP.bosses` together when the final boss names are
locked.

### `runtime/decor/`

| Use | Current file |
|---|---|
| Spawn portal | `assets/runtime/decor/spawn_portal.png` |
| Enemy goal / monument | `assets/runtime/decor/central_crystal.png` |
| Board reference/background | `assets/runtime/decor/maze_background.png` |
| Recipe Master NPC | `assets/runtime/decor/recipe_master.png` |

### `gems/`

Reserved for optional individual gem sprites. The current SVG gem renderer is
still active.

### `biomes/`

Reserved for painted biome backgrounds.
