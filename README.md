# Crystal Maze Defence

A mobile tower defense inspired by [**Gem TD**](https://www.dota2.com/) (the Dota 2 / Warcraft 3 classic). You don't choose your towers — you place **stones**, and the RNG decides what gems they become.

## The loop

1. **Place stones** (25g each). Stones don't attack — they're walls that shape the maze.
2. **Start the wave.** Enemies always take the shortest path around your towers (BFS recomputed on every placement). If a placement would fully wall them off, the game rejects it.
3. **When the wave ends, every stone rolls** into a random gem at Chipped (I).
4. **Combine 5 same-type same-tier** → 1 gem at the next tier:
   `Chipped (I) → Flawed (II) → Normal (III) → Flawless (IV) → Perfect (V)`
5. **Ultimate recipe:** 5 different-type Perfect (V) gems → 1 **Ultimate Crystal (★)**: every ability stacked, massive damage, max range.
6. Survive **20 waves**.

Tap a tower to inspect, sell, combine, or upgrade to Ultimate.

## Controls

| Gesture | Effect |
| --- | --- |
| Tap empty cell | Place a stone |
| Tap a tower | Inspect / sell / combine |
| Drag with one finger | Pan the board |
| Pinch with two fingers | Zoom in/out |
| ⤢ button | Recenter and reset zoom |

## The gems

| Gem | Color | Specialty |
| --- | --- | --- |
| Diamond | White | High single-target damage |
| Ruby | Red | Burn DoT |
| Emerald | Green | Splash damage |
| Sapphire | Blue | Slow 50% |
| Topaz | Yellow | Chain lightning (3 jumps) |
| Amethyst | Purple | Fires at 2 enemies |
| Aquamarine | Teal | Long-range sniper |
| Opal | Pink | Frenzy — very fast attack |

Each tier multiplies damage (1× → 1.8× → 3.2× → 5.8× → 10.5× → 28×) and extends range.

## Play it from your phone — fastest

You don't need a PC. Two options:

### Option A — Expo Snack (no install)
1. Install **Expo Go** from the App Store / Play Store.
2. Open https://snack.expo.dev in your phone's browser.
3. Replace Snack's `App.js` with [the App.js from this repo](./App.js).
4. Snack will show a QR — tap it to launch in Expo Go.

### Option B — local dev (laptop + phone)
Node 18+ on a computer, Expo Go on your phone.

```bash
npm install
npx expo start
```

Scan the QR with Expo Go (Android) or Camera (iOS).

## Shipping to the App Store

This project is wired up for [EAS Build](https://docs.expo.dev/build/introduction/), which builds iOS apps in Expo's cloud — **you don't need a Mac**.

### One-time prerequisites
1. Apple Developer Program account ($99/yr) — https://developer.apple.com/programs/
2. Free Expo account — https://expo.dev
3. App Store Connect listing with bundle id `com.example.crystalmazedefence` (or change it in `app.json` first — must be globally unique)

### Build & submit
```bash
npm install -g eas-cli
eas login
eas init    # links the project; fills extra.eas.projectId in app.json
eas build --platform ios --profile production
eas submit --platform ios --latest
```

### Replace before shipping
- `app.json` → `ios.bundleIdentifier` (pick something unique to you)
- `eas.json` → `submit.production.ios` Apple credentials
- Real **icon** (1024×1024) and **splash** assets — currently using Expo defaults

### Apple Review notes
Apple commonly rejects games that feel like demos. Before submitting:
- Polish sounds (`expo-av`) and haptics (`expo-haptics`)
- Persistent high scores (`@react-native-async-storage/async-storage`)
- More waves / a campaign mode
- Settings menu, mute toggle, tutorial overlay
- Privacy policy URL (mandatory)

## Differences from the original Gem TD

This is **inspired by** Gem TD, not a clone. Differences:
- Phone-shaped portrait grid (14×22) with pan + pinch zoom for navigation
- Simplified wave compositions, 20 waves total
- All names, stats, balance, and art are our own

## Tech

- React Native 0.74 / Expo SDK 51
- Pure JS — no extra native modules, runs in Expo Go
- BFS pathfinder re-runs on every placement
- Game loop via `requestAnimationFrame` at 60fps with `dt`-scaled physics
- Pan + pinch zoom via built-in `PanResponder` (no `react-native-gesture-handler` dependency)
- Single-file (`App.js`) — easy to fork into Expo Snack
