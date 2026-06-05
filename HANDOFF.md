# HANDOFF — Crystal Maze Defence (mobile)

**Repo:** `usmanmomid/Test` (private)
**Branch:** `claude/mobile-game-development-PjMjg`
**HEAD (latest as of handoff):** `6ce299b`
**Tech stack:** React Native + Expo (SDK 51) · single `App.js` (~8,500 lines) · `react-native-svg` for SVG · `@react-native-async-storage/async-storage` for persistence · `expo-av` for audio (graceful no-op if missing) · `expo-haptics` for vibration (graceful no-op if missing) · `@shopify/react-native-skia` declared but NOT yet used (Skia migration G1 still pending).
**Game:** Tower-defence with 5-placement candidate rolls, merge/combine into specials, maze pathing through 5 checkpoints to a castle. Mobile port of the Roblox Crystal Maze Defence design doc.

---

## 1. How to access everything

### GitHub (source of truth)

- Web: https://github.com/usmanmomid/Test/tree/claude/mobile-game-development-PjMjg
- Clone: `git clone -b claude/mobile-game-development-PjMjg https://github.com/usmanmomid/Test`
- Browse history: `git log --oneline` from the working tree. The numbered commits in §3 below correspond 1:1 to the live history.

### Files that matter

```
App.js                     ← the whole game (UI + state + sim + render)
package.json               ← deps; expo-av, expo-haptics, async-storage, svg, skia
PLAN.md                    ← 42-phase roadmap from before refactor (stale-ish)
DEVIATIONS.md              ← intentional deviations from the doc (stale-ish)
SNACK.md                   ← Snack dependency setup
sim.js                     ← aggregate balance harness (Node)
spatial_sim.js             ← spiral-maze TD sim, W1-500 (Node)
assets/
  README.md                ← Asset pipeline rules and filename → tower/boss map
  audio/                   ← 10 synth WAV SFX (~206 KB total)
  runtime/towers/          ← 18 optimized tower PNGs (special_01..18.png)
  runtime/bosses/          ← 12 optimized boss PNGs (boss_01..12.png)
  runtime/decor/           ← 4 decor PNGs (spawn portal, castle, monument, recipe master)
  towers/                  ← user-uploaded source art (reference sheets)
  bosses/                  ← user-uploaded source art
  decor/                   ← user-uploaded source art (incl. Hells Gate, Maze, Central Crystal, RecipeMaster)
  gems/                    ← empty (SVG gem renderer still in use)
  biomes/                  ← empty (single board reused)
```

### How to RUN the game

The repo is **private**, which creates an asset-loading constraint. Three working paths:

| Method | Sprites work? | Audio works? | Setup time |
|---|---|---|---|
| **Local Expo CLI on a computer + Expo Go on phone** | ✅ Yes (bundled via require) | ✅ Yes | ~10 min |
| **Snack via gitUrl import** (`snack.expo.dev/?gitUrl=...`) | ✅ If repo is public, else no | Same | Browser only, but flaky |
| **Snack copy-paste of App.js** | ❌ require() returns null | ❌ Silent | Easiest but ugly |

Path A (recommended):
```
git clone https://github.com/usmanmomid/Test
cd Test
git checkout claude/mobile-game-development-PjMjg
npm install
npx expo start
# scan QR with Expo Go on phone
```

If the repo is made **public** (one toggle in GitHub settings), Snack paste-mode would also load sprites from `https://github.com/.../raw/.../assets/runtime/...` if `ASSET_MAP` is reverted to URL-based (see §6 known-issue).

---

## 2. What works RIGHT NOW (verified by user playtest on phone)

- Game boots, lobby renders, can pick mode (Quick/Standard/Endless) + difficulty (Easy/Normal/Hard/Nightmare) + start solo.
- 5-placement → choose action loop runs (Keep / Merge +1 / Merge +2 / Chain merge / Combine).
- Combat phase runs: enemies BFS along path through CP1..CP5 → goal, towers fire, gold accrues.
- Auto-open inspect modal on first candidate when phase enters `choosing`. 5-candidate strip lets player switch which one's actions are visible.
- Mid-wave merge/combine works (BoardActionTray + executeBoardAction + findBoardActions, 0.75 s cooldown).
- Modes change `s.totalWaves` (50/100/9999) and `s.rewardMult` (×1 / ×1.2 / ×1.5).
- Difficulty applies HP/count/spawn-delay/gold multipliers per doc §60 V5.
- Endless boss-cycle rotates 12 named bosses on W60+ boss waves (8 placeholders fill 13-20).
- Path-pulse red glow runs in enemy travel direction.
- 13 gold-utility skills in the skill bar (GoldFlash, Heal, Freeze, DamageBoost, GoldBlessing, WaveSkip, GoldRain, HealOverTime, SpeedShield, CritBoost, TowerEcho, Timelapse, CandyLure) — all wire to gold / state / cooldown.
- 8 mutations (W75+ gate) — ArmorBloom, SpeedSurge, RegenWaves, ResistShifts, SplitEvolution, ShieldRotations, FogOfWarLanes, EliteSpawns.
- 5 boss signatures (HoundSprint / JudgmentSlam / SkyCourtAdds / InvisibilityPulse / PhaseShields).
- Milestones every W25 from W100 (cumulative +5% speed / armor alternating).
- 6 P6 rule-breaks fully active (Diamond no-armor, Topaz +2 multi, Amethyst armorBreak×2, Sapphire 95% slow, Ruby 5-hop chain, Emerald poison spread on kill). Aquamarine ×2 AS in mutation. Opal global fog-reveal.
- P5 synergy: −25% isolated / +20% clustered within 3 tiles.
- Resistance cap 0.70, damage types Physical/Magic/Poison/Burn per family + per-recipe inference.
- ShieldRotations mutation OR boss PhaseShields → temporary full immunity to one type.
- AsyncStorage persistence: best score / best wave / wins / per-difficulty bestWave / tutorial done flag / quests / XP / login streak / achievements / MVP wins per family.
- Daily quests (3, +500g each, reset 24h).
- Weekly quests (3, +2500g each, reset 7d).
- Account XP and level (1-50 quadratic curve, shown in lobby + Profile modal).
- 7-day login streak ladder, +250..2000g/day banked into next match start.
- 14 achievements, gold-banked on unlock, viewable in Profile modal.
- MVP tower tracking per family (sessionStats.gemDamage → mvpGem at game end).
- Settings modal with sound on/off toggle.
- Screen-shake on boss spawn (0.6 s).
- Haptic vibration on key events (boss spawn → heavy, life lost → warning, victory → success, defeat → error, utility cast → medium, recipe forge → success).
- 10 synth WAV SFX play via expo-av (shot, hit, kill, boss_spawn, wave_clear, life_lost, recipe_forge, utility_cast, victory, defeat). MUTE button in HUD.
- Speed toggle 1×/2×/3× with dt-multiplication.
- Mode selector in lobby.
- Tower targeting modes (First / Last / Close / Strong / Weak / Most / Least / Manual).
- 2.5D isometric board tilt (Codex's pass).
- 12 user-delivered boss PNGs bundled (1-12). User has 8 more to come for the full 20-slot endless cycle.
- 18 user-delivered special tower PNGs bundled.
- 4 decor PNGs bundled (spawn portal Hells-Gate, castle/central-crystal, recipe master, maze background).

---

## 3. Commit log this session (newest first, with one-line intent)

```
6ce299b Candidate-chip layout — 5 chips fit on one row (was 4+1)
bbf8f5a Hotfix — darken() and RockView accent crash-proof against undefined
7113cba Hotfix — wrap all asset require()s in try/catch so Snack paste doesn't crash
9d8638c Visual upgrade — bundle PNG sprites via require(), USE_SPRITES = true
21f106d Retention pass — haptics + XP/level + login streak + weekly quests + achievements + MVP + Profile
556b820 Phase C — daily quests + progression hooks (doc §46)
028a8c3 Phase A — UX polish: screen-shake on boss + SettingsModal + cog wired
c5fb624 SFX integration — 10 synthesized WAV files + expo-av playback
1d37d82 Fix RockView crash + lobby scroll + auto-open inspect with 5-candidate strip
2d9b3be Audio stub infrastructure + MUTE button — ready for expo-av swap
ab41b2b Hotfix — disable USE_SPRITES so Connecting doesn't hang on private-repo 404s
[5fa8c63..bf8db9a — Codex's parity pass: combat readability, wave parity, 2.5D, art assets, Snack copy-paste safety, lobby mode crash fix]
90b0094 G1 foundation — asset pipeline + sprite fallback + 34 placeholder PNGs
cc3b5a4 Tower display-name pass — 18 specials aligned to latest canonical list
d785074 Path-pulse red recolor + DialogBalloon component
8c2bf26 Opal iridescent SVG + 20-slot endless boss-cycle (12 named + 8 placeholders)
632688a Phase F — 5 boss signatures + per-recipe damage types (Option B closed)
cb6c55c Phase E — 13 gold utilities + skill bar UI
099fe8d Phase D — endless layer: modes + milestones + 8 mutations
aa70cbd Phase C — P5 synergy + 6 P6 rule-breaks live (Aqua/Opal queued for D)
1eb5919 Phase B — resistance cap 0.70 + damage-type system + champion enemy
2b9fbba Phase A — reset balance to doc V5 (F5-playtested canonical)
9c47853 P8 + P9 — difficulty count/spawn-delay + economy formula & killstreak
a2a2e13 P4+P5 — boss-only waves + DPS-derived HP curve (single HP source)
[51c5727..deabc2b — spatial sim, balance harness, roll odds final]
02cad76 P2 — recipe gold cost (Lock A)
d3615d5 P1 — BALANCE single-source-of-truth block + lock E1/E2/E3
1ea270d Add DEVIATIONS.md
02a0a01 Add PLAN.md — 42-phase roadmap to align mobile with FINAL_VERIFIED
[68c8d1c..cb048fa — earlier visual + balance passes]
```

---

## 4. Canonical sources of truth (DO NOT re-derive)

These are LIVE in App.js. The numbers come from `CrystalMazeDefence_Research_Document_FINAL_VERIFIED` (V5 layer, locked 2026-05-23, F5-playtested in Roblox).

| System | App.js identifier | Doc reference |
|---|---|---|
| HP curve | `BASE_HP = 40`, `hpGrowth(i)` = 1.13/1.07/1.06/1.04 @ {50,100,200} | §59 V5 |
| Difficulty | `DIFFICULTIES.easy/normal/hard/nightmare`, HP 0.30/0.90/1.03/1.05 | §60 V5 |
| Boss HP mult | `bossHPMult(wave)` = 1.6 / 2.0 / 2.5 wave-aware | §61 |
| Onboarding ramp | `ONBOARDING_RAMP` W1-11 HP+Speed verbatim | §62 |
| Lives | `lives: 50` flat | §63 |
| Chaos band | ±5% deterministic per wave | §A3 |
| Champion mult | 1.4× HP, 2× gold | §A3 |
| Roll odds | `ROLL_ODDS[6]` 6-tier with 5% P6 at HL6+ | §10 |
| Hero level | `levelForWave(w)` = min(6, floor((w-1)/6)+1) | §54.5 / §A16 |
| Recipe gold cost | `RECIPE_GOLD_COST` 250/500/1200/3000/12000 | §67 V5 |
| Economy | `killGold(W) = max(1, floor(W^1.15))` | §54.1 |
| Boss kill | 5× per-kill in `killGoldFor` (no lump bonus) | §54.2 |
| Killstreak | ladder {1, 1.10, 1.18, 1.25} at thresholds 0/15/30/50 | §54.3 |
| Anti-farm | path ≥ 25% OR alive ≥ 1.5s for streak | §54.3 |
| Resistance cap | 0.70 max in `damageMultByType` | §53.4 |
| P5 synergy | iso 0.75 / clustered 1.20 within 3 tiles | §A7 |
| P6 rule-breaks | per family in `fireAt` branches | §A8 |
| Mutations | 8-pool, W75 gate, mulberry32 seed | §A6 / §56 |
| Milestones | every W25 from W100, alt ±5% speed/armor | §57 / §A9 |
| Boss signatures | 5 mapped per variant in `BOSS_SIGNATURES` | §A13 |
| Game modes | Quick 50 / Standard 100 / Endless 9999 | §60.6 V4 |

---

## 5. Pending work / not yet shipped

### Cosmetic monetization (doc §45 / §91 — Phase 9)
- 18+ premium cosmetics: trails, hats, particle FX, tower skins, titles, emotes, pets, auras.
- `MonetizationConfig.Enabled = false` default. CosmeticAuditService rule: no gameplay stats on any cosmetic.
- Mobile: nothing yet. No shop UI, no in-app purchase wiring.

### Leaderboards (doc §46 / §89)
- Roblox had OrderedDataStore for global + per-mode rankings.
- Mobile single-player: no global leaderboard. Could add local "best this week" view in Profile.

### Phase 25 Tutorial (full spec)
- Codex added a "small first-run tutorial". The doc §25 spec calls for a stationary Guide NPC in lobby + ProximityPrompt + 5-step walkthrough W1-W5.
- Current mobile tutorial is minimal. Full spec not implemented.

### Volume slider + vibration toggle in SettingsModal
- Only mute/unmute toggle exists. No granular volume. No vibration toggle (currently always on if expo-haptics is available).

### True Skia rendering (G1 proper)
- `@shopify/react-native-skia` declared in package.json, not yet used.
- Current rendering: RN View + react-native-svg + Image. Hits performance ceiling at ~200 enemies + heavy FX.
- G1 would migrate board / enemies / projectiles / FX to a single `<Canvas>` from Skia. Hud, lobby, modals stay in RN.

### Sprite art replacing SVG (G2)
- 18 special tower PNGs delivered. 12/20 boss PNGs delivered (8 more user is generating).
- Currently `USE_SPRITES = true` for towers/bosses/decor — uses `require()`-bundled art.
- BLOCKED in Snack paste mode because `assets/` folder isn't in the pasted snack. Workaround: local Expo or public-repo Snack import.

### Painted board / biomes (G3)
- Current: single tiled board background. Per `assets/decor/Maze.png`. Doc spec wants 6 biomes (Enchanted Grove, Lava, Ice Spire, Topaz Highlands, Ruby Crag, Aquamarine Bay).
- Per user instruction earlier: "räcker med samma temporärt" — single biome accepted for now.

### Particle FX (G4)
- Current: small projectile + impact spark + death burst via SVG/View FX.
- Doc-canonical FX (HoundSprint dust, JudgmentSlam ground crack, etc.) not visualised — they're MECHANICALLY active but visually generic.

### Audio assets quality (G6)
- 10 synth WAV SFX are procedurally generated retro-arcade tones. Not studio-polished.
- Music: NOT IMPLEMENTED. Doc §40 spec wants lobby / build / combat / boss / victory tracks.

### App Store / EAS build prep
- `eas.json` exists from initial scaffold. Has not been used to build for distribution.
- Not yet registered with Expo for OTA updates.

### MVP starting reward
- Doc §44 says "+5% damage per stack" with 10-MVP aura. Mobile tracks MVP wins per family but doesn't yet apply the in-run damage bonus to the highest-damage tower (only per-run tracker exists).

### Roblox sync
- Roblox project folder NOT modified by any of this work. Mobile is a separate React Native build that follows the same design doc.

---

## 6. Known issues

### Asset loading in Snack paste mode
- `_r(path)` helper returns `null` if `require()` fails (Snack paste mode = no `assets/` folder).
- Game runs but falls back to SVG art and silent audio.
- Fix: use local Expo CLI OR make repo public + revert ASSET_MAP to URL-based.

### gitUrl import to Snack
- User reported it doesn't work. Likely because the repo is private; Snack's gitUrl import can't authenticate.

### Boss roster 13-20 are placeholders
- `BOSS_ROSTER` pads to 20 by reusing entries 0-7 in a spaced pattern. When user provides the 8 missing bosses, update both `BOSS_ROSTER` slots 12-19 AND the `ASSET_MAP.bosses` entries to point at the new PNGs.

### Spatial sim says doc V5 walls at W15 Normal
- `spatial_sim.js` predicts 50 lives gone by W15 on Normal with the doc curve. The doc was F5-validated in Roblox.
- My sim's tower-growth model is the unvalidated piece. Recommendation: trust user playtest over either.
- User has tested W1-W3 and reports the game is fine so far.

### PLAN.md and DEVIATIONS.md are stale
- Last updated during the early balance pass. Not maintained through Phases A-F or Codex's parity work or the retention pass.
- Treat App.js + this HANDOFF.md as the authoritative source.

---

## 7. Critical files to know in App.js

Approximate line ranges (will drift as code grows; grep `^function` to find current locations):

```
1–20         imports
60–250       BALANCE block (constants, locks)
~260–390     daily/weekly quests + login streak + achievements + XP/level
~395–500     HP system (BASE_HP, growth, ENEMY_HP_COEF, bossHPMult, ramp, chaos, computeEnemyHP)
~500–600     mutations + milestones + BOSS_ROSTER
~600–700     UTILITIES (13 gold-utility skills) + castUtility
~700–810     audio (SOUND_EFFECTS, _loadAudio, playSound)
~810–900     haptics (buzz, mute)
~900–1000    GEM_STATS (8×6 stats per family)
~1000–1100   SPECIAL_RECIPES (18 specials, canonical names, ingredients incl. nested)
~1100–1200   ASSET_MAP + USE_SPRITES + remoteAsset helper
~1200–1300   ENEMIES + buildWaves + getWave (lazy endless wave gen)
~1400–1600   App-level state (stats, screen routing, recordResult, Game prop wiring)
~1600–2200   Game component (state init, game loop, board UI)
~2200–2400   action handlers (resolveKeep/Merge/Combine, board-action helpers)
~2400–2600   choose-action modal wiring + auto-open
~2600–4000   render passes for board, candidates, towers, enemies, FX
~4000–4700   SVG renderers for gems, specials, rocks, decor
~4700–5400   SVG renderers for enemies, bosses (per-variant)
~5400–6500   misc UI (recipe book, settings, profile, dialog balloons)
~6500–8000   targeting modes, sprite-or-svg fallback logic
~8000–8500   ProfileModal + SettingsModal + CandidateInspect (with 5-chip strip)
```

---

## 8. What I'd start with if I were Codex picking this up

1. **Make the repo public for 5 minutes**, verify the gitUrl-imported Snack shows real PNG sprites loading from `assets/runtime/`. That confirms the pipeline works end-to-end. If happy, decide whether to keep it public or move assets to a separate public repo.
2. **Real audio**: replace 10 synth WAVs with sourced CC0 SFX (Kenney, Freesound) for better game feel.
3. **MVP in-run bonus**: track sessionStats.gemDamage → identify current top-damage tower mid-run → apply +5% damage to that family's towers (doc §44 §19). Visible crown icon on the tower with highest damage this run.
4. **Volume slider + vibration toggle in SettingsModal**.
5. **Skia migration (G1)**: replace the board rendering with `@shopify/react-native-skia` Canvas. Hud/modals stay RN. Unlocks 60FPS with 200+ enemies + particle FX.
6. **Replace placeholder boss roster entries 13-20** with the user's remaining 8 boss PNGs when delivered.

---

## 9. Conventions to keep

- ONE source of truth per balance value (no re-stating in comments — point at the named constant).
- Doc V5 wins on any disagreement. DEVIATIONS.md is intended to log conscious choices to differ, but is currently stale.
- SVG renderers are the fallback ground truth. Sprites are the polish layer on top.
- Mobile is single-player only. Server-auth code in the doc (RemoteEvents, OrderedDataStore, ProfileService) does NOT port.
- No emojis in code or commits unless the user explicitly requests them.
- Each game-state mutation goes through the existing `s.*` ref pattern + `force()` re-render. Don't introduce new useState for game-loop values.

End of handoff.
