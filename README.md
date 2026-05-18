# Crystal Maze Defence

Open-grid tower defense. Place crystal towers to **shape the maze itself** — enemies always take the shortest path, so your placements determine where they walk. Survive 10 waves.

## Play it (fastest path, from your phone)

You don't need a Mac or PC. Two options:

### Option A — Expo Snack (no install)
1. Open https://snack.expo.dev in your phone's browser.
2. Install **Expo Go** from the App Store.
3. In Snack, replace `App.js` with the contents of [`App.js`](./App.js) from this repo.
4. Snack will give you a QR code — open it with the Camera app, tap to launch in Expo Go.

### Option B — local dev (laptop + phone)
Requires Node 18+ on a computer.

```bash
npm install
npx expo start
```

Scan the QR with Expo Go (Android) or Camera (iOS).

## How to play

| Action | What it does |
| --- | --- |
| Tap an empty cell | Place selected crystal tower (if you can afford it) |
| Tap a tower | Sell it for 60% refund |
| Tap a tower button (bottom) | Switch selected tower type |
| `NEXT WAVE` | Spawn the next wave |
| `1x / 2x / 3x` | Toggle game speed |

**Crystals:**
- 💎 **Ruby** — solid damage, reliable
- 💎 **Sapphire** — slows enemies on hit
- 💎 **Emerald** — poison damage over time
- 💎 **Topaz** — splash damage (expensive)

**The trick:** towers are walls. You can't fully block the path (the game won't let you), but you can force enemies to weave through a long S-curve, giving your crystals more time to fire. Build chokepoints.

## Shipping to the App Store

This project is wired up for [EAS Build](https://docs.expo.dev/build/introduction/), which builds iOS apps in Expo's cloud — **you don't need a Mac**.

### Prerequisites (one-time)
1. Apple Developer Program account ($99/yr) — https://developer.apple.com/programs/
2. Free Expo account — https://expo.dev
3. App Store Connect listing — https://appstoreconnect.apple.com (create the app with bundle id `com.example.crystalmazedefence`, or change it in `app.json` first)

### Build & submit
```bash
npm install -g eas-cli
eas login
eas init                                # links the project; updates app.json extra.eas.projectId
eas build --platform ios --profile production
eas submit --platform ios --latest
```

You'll be prompted for Apple credentials on first build. EAS handles certs/provisioning automatically.

### Before submitting, replace the placeholders in:
- `app.json` → `ios.bundleIdentifier` (must be globally unique on Apple's side)
- `eas.json` → `submit.production.ios` Apple credentials
- Real **icon** and **splash** assets (Apple requires 1024×1024 icon; current config uses Expo defaults — replace with art before shipping)
- App Store listing: screenshots (6.7", 6.5", 5.5" required), description, keywords, privacy policy URL, age rating

### App Review notes
Apple commonly rejects games that feel "thin." Before submitting:
- Add more waves / enemy types if you want a longer experience
- Add sound effects (`expo-av`) and haptics (`expo-haptics`)
- Add persistent high scores (`@react-native-async-storage/async-storage`)
- Make sure the game runs without network access (already true)

## Tech

- React Native 0.74 / Expo SDK 51
- Pure JS — no native modules, runs in Expo Go
- BFS pathfinder in `App.js` re-runs on every tower placement
- 30+fps game loop via `requestAnimationFrame`
- Single file (`App.js`) — easy to fork into Expo Snack
