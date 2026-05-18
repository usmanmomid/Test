# Gem Match 💎

A match-3 puzzle game built with React Native + Expo. Swap adjacent gems to make rows or columns of 3+ matching gems. Chains and combos score extra. You get 20 moves per round.

## Play on your phone — fastest path (Expo Snack)

You don't need to install anything. From your phone:

1. Open https://snack.expo.dev in your browser
2. In the left file panel, replace the contents of `App.js` with the contents of [`App.js`](./App.js) in this repo
3. Tap "My Device" → install **Expo Go** from the App Store / Play Store
4. Scan the QR code with Expo Go and play

## Play locally (laptop + phone)

Requires Node.js 18+ on your computer and the **Expo Go** app on your phone.

```bash
npm install
npx expo start
```

Scan the QR code from your terminal with Expo Go (Android) or the Camera app (iOS).

## How to play

- **Tap** a gem to select it (highlighted in gold)
- **Tap an adjacent gem** to swap them
- Make a row or column of **3+ matching gems** to clear them and score points
- Cascading matches multiply your combo
- Game ends after **20 moves** — beat your high score!

## Tech

- React Native 0.74 via Expo SDK 51
- Pure JS — no native modules, runs in Expo Go
- Single-file game logic in `App.js`
