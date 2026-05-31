# Crystal Maze Defence - Asset Pipeline

This folder contains the mobile game's art. `App.js` is currently Snack-safe:
assets are referenced through GitHub raw URLs in `ASSET_MAP`, not local
`require()` calls. That lets the user copy only `App.js` into Expo Snack and
still load images after the branch has been pushed.

For the eventual App Store build, these remote sources should be replaced with
bundled Expo assets and optimized runtime PNGs.

## Current Rules

- Do not rename files without updating `ASSET_MAP` in `App.js`.
- Keep transparent-background PNGs for board sprites.
- Source art can be large, but runtime board sprites should later be compressed
  and downscaled to 256x256 or 512x512 for mobile performance.
- `USE_SPRITES` in `App.js` remains off by default until we validate the new art
  on a real phone.

## Folder Map

### `towers/`

Runtime tower art is currently mapped to:

| Recipe slot | Runtime file |
|---|---|
| 1 | `Special_Tower_01_mesh_full_transparent.png` |
| 2 | `Special_Tower_02_mesh_full_transparent.png` |
| 3 | `Special_Tower_03_mesh_full_transparent.png` |
| 4 | `Special_Tower_04_mesh_full_transparent.png` |
| 5 | `Special_Tower_05_mesh_full_transparent.png` |
| 6 | `Special_Tower_06_mesh_full_transparent.png` |
| 7 | `Special_Tower_07_mesh_full_transparent.png` |
| 8 | `Special_Tower_08_mesh_full_transparent.png` |
| 9 | `Special_Tower_09_mesh_full_transparent.png` |
| 10 | `Special_Tower_10_mesh_full_transparent.png` |
| 11 | `Special_Tower_11_mesh_full_transparent.png` |
| 12 | `Special_Tower_12_mesh_full_transparent.png` |
| 13 | `Special_Tower_13_mesh_full_transparent.png` |
| 14 | `Special_Tower_14_mesh_full_transparent.png` |
| 15 | `Special_Tower_15_mesh_full_transparent.png` |
| 16 | `Special_Tower_16_mesh_full_transparent.png` |
| 17 | `Special_Tower_17_mesh_full_transparent.png` |
| 18 | `Special_Tower_18_mesh_full_transparent.png` |

The `Special Tower N.png` files and
`GemsCrystals All families P1-P6 except Opal.png` are kept as uploaded source
art/reference sheets.

### `bosses/`

| Roster slot | Current file |
|---|---|
| 1 | `1. Pirate King.png` |
| 2 | `2. Void Monarch.png` |
| 3 | `3. Hellforge Brute.png` |
| 4 | `4. Frost Lich.png` |
| 5 | `5. Storm Crawler.png` |
| 6 | `6. Ogre King.png` |
| 7 | `7. Roots.png` |
| 8 | `8. Ashfang.png` |
| 9 | `9. Kraken.png` |
| 10 | `10. Scorpion King.png` |
| 11 | `11. Maze Bull.png` |
| 12 | `12. Medusa.png` |

`BOSS_ROSTER` still uses internal ids from the prototype. Update both
`BOSS_ROSTER` and `ASSET_MAP.bosses` together when the final boss names are
locked.

### `decor/`

| Use | Current file |
|---|---|
| Spawn portal | `Hells Gate (Spawn Portal).png` |
| Enemy goal / monument | `Central Crystal (Goal of enemies).png` |
| Board reference/background | `Maze.png` |
| Recipe Master NPC | `RecipeMaster.png` |

### `gems/`

Reserved for optional individual gem sprites. The current SVG gem renderer is
still active.

### `biomes/`

Reserved for painted biome backgrounds.
