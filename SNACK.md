# Expo Snack Setup

If you paste only `App.js` into Expo Snack, also add this dependency in
Snack's Dependencies / package.json panel:

```json
{
  "dependencies": {
    "react-native-svg": "15.2.0",
    "@react-native-async-storage/async-storage": "1.23.1"
  }
}
```

Do not add SVG as `react-native-svg.js`; the package name is `react-native-svg`.

The repo already has this dependency in `package.json`, so local Expo builds do
not need this extra step.
