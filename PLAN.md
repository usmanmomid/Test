# Crystal Maze Defence (Mobile) — Implementation Plan

Roadmap to bring the mobile (React Native / Expo) build in line with
`FINAL_VERIFIED` design, balanced + polished + extensible + stable.

## Operating principles (locked)

1. **Code is the single source of truth.** All live numbers live in ONE
   `BALANCE` constants block at the top of `App.js`. The doc/commits point at
   it; they never restate numbers in prose.
2. **Scope order is CORE → EXPANSION → DEFERRED.** Do not start a later block
   until the earlier block is user-verified PASS.
3. **One phase = one commit = one "done when".** No phase is "done" until its
   acceptance line is met and (for anything visible/feel-based) user-confirmed.
4. **Mobile ≠ Roblox.** Server-authority, DataStore, ProximityPrompts, 12
   arenas and multiplayer are Roblox-only. We share DESIGN + BALANCE, not
   infrastructure. Roblox-only systems are marked `[RBX-ONLY — skip]`.
5. **Targeted fixes, never sledgehammers.** Balance bugs get a specific enemy /
   value nerf, not a master-curve swing. (Per BALANCE_AUDIT discipline.)

Tags: **[CORE]** ship-critical · **[EXP]** depth · **[DEF]** post-core.

---

## BLOCK 0 — Source of Truth & The Three Locks  [CORE]

**P1 — BALANCE constants block.**
Goal: one commented block at top of `App.js` listing every live number (HP
curve, growth, difficulty mults, roll odds, recipe cost, boss design, economy).
Done when: no balance number appears anywhere else in prose/comments; the block
is the only authoritative table.

**P2 — Lock A: recipe gold costs (100 / 250 / 600 / 1500 / 3500).**
Goal: Combine deducts gold by tier; rejects if insufficient.
Done when: forging a P2–P6 special debits the tier cost, button greys out when
unaffordable, cost shown in the inspect/recipe UI.

**P3 — Lock B: roll odds final (L1–L8, P6 merge/recipe-only).**
Goal: natural rolls cap at P5; P6 only via merge ladder or recipe.
Done when: `rollPurity` uses the locked L1–L8 table; no natural P6; luck panel
shows the live per-level odds.

**P4 — Lock C: boss-only waves + HP absorb.**
Goal: W10/20/30/40/50 spawn only the boss(es); boss HP raised to absorb the
removed minion HP.
Done when: no minion adds on boss waves; boss HP bumped; wave clears on boss
death.

---

## BLOCK A — CORE Balance Alignment  [CORE]

**P5 — HP system = doc formula.**
Single `computeEnemyHP(wave, opts)` entry: `BaseHP(40) × ∏Growth(i)
(1.13≤50 / 1.07≤100 / 1.06≤200 / 1.04 else) × difficulty × local × ramp`.
Done when: all enemy HP flows through one function; reference W10≈120 matches.

**P6 — Chaos band ±5%.**
Deterministic per-wave (seed = wave) HP jitter 0.95–1.05 (Early).
Done when: same wave always rolls same band; not per-enemy.

**P7 — Onboarding ramp W1–11.**
HP+speed ramp W1 0.15/0.45 → W11 1.0/1.0 per §62.
Done when: early waves no longer drain lives; W12+ unscaled.

**P8 — Difficulty tiers = doc values + rename.**
Easy 0.30/0.50, Normal 0.90/0.95, Hard 1.03/1.00, Nightmare 1.05/1.00;
StartingLives 50; reward mults 1.25/1.00/1.10/1.25; spawn-delay mults.
Done when: 4 tiers match §60 exactly; lobby shows them.

**P9 — Economy = W^1.15 formula + killstreak + anti-farm.**
`GoldPerKill = max(1, floor(W^1.15))`; killstreak ladder {1,1.10,1.18,1.25};
kill counts only if enemy travelled ≥25% path OR alive ≥1.5s; goldBucket for
fractional carry.
Done when: W10=14, W30=49, W50=89; streak caps at 1.25.

**P10 — Boss/champion gold (no lump bounty).**
Boss kill = 5×GoldPerKill(W); champion = 2×GoldPerKill(W).
Done when: BOSS_GOLD_BONUS lump removed; boss reward computed from formula.

**P11 — HeroLevel formula + roll binding.**
`HL = floor((W-1)/6)+1` drives the roll table.
Done when: W5=HL2, W30=HL5, W31=HL6; roll odds follow HL not a custom table.

**P12 — Wave composition 70/20/10 + counts 15–30.**
Each wave = 70% primary + 20% secondary + 10% filler, bound to HL; counts per
§51.1 (T1=15 flat → T5 cap 30).
Done when: generator produces composition; active-enemy cap respected.

---

## BLOCK B — CORE Content Completion  [CORE]

**P13 — 18 special stats = doc §36 exact + canonical names.**
Rename (Wildroot→Verdant Arcstone etc.); set DMG/RNG/Rate/effects to §36.
Done when: all 18 match the §36 table (range in tiles = studs/4).

**P14 — Merge rules: Keep / Merge1(2) / Merge2(4) / Merge1Chain.**
Add chain merge (2×P + 1×P+1 → P+2); prioritise min-board-consumed option.
Done when: all four actions valid; UI hides the strictly-worse merge.

**P15 — Enemy ability framework.**
Ability flags per enemy + a dispatcher that applies behaviours each tick.
Done when: an enemy can carry N abilities; framework has zero hard-coded types.

**P16 — Ground/air abilities (§18).**
Hidden, Evasion, High armor, Reactive armor, Disarm aura, Blink, Rush, Recharge.
Done when: each behaves per the ability table; counters work (reveal, slow, etc).

**P17 — Damage types + resist cap.**
Physical / Magic / Poison / Burn; 70% resist cap; Magic-immune / Physical-immune.
Done when: each tower tagged a type; immune enemies take 0 from that type;
resist caps at 70%.

**P18 — Enemy roster naming + per-wave identity.**
50 waves use doc names (Glimmer Mites … Worldheart Hatchling) + compositions.
Done when: each wave's enemy name + lesson matches §17.

---

## BLOCK C — EXPANSION Depth  [EXP]

**P19 — P5 synergy.** Isolated (no same-family P5 ≤ ~3 tiles) ×0.75; clustered
×1.20. Done when: damage scales with clustering.

**P20 — P6 rule-breaks (8 family-specific).** Diamond crit-ignores-armor, Topaz
+2 targets, Sapphire slow→95%, Emerald poison-spread-on-kill, Ruby 5-hop chain,
Amethyst armor×2, Aquamarine 2×AS in mutation, Opal global reveal.
Done when: each P6 carries its rule-break, frozen at placement.

**P21 — Gold utilities I.** Hammer (remove rock + revalidate path), Downgrade,
Aim Lens. Done when: each spends gold, validates, applies.

**P22 — Gold utilities II.** Gem Prayer, Purity Prayer, Haste Focus, Crit Focus,
Adjacent/Field Swap. Done when: each spends gold per §15.1 thresholds.

**P23 — MVP / tower mastery.** Track damage per tower; best-of-wave +10%;
high-MVP unlocks a local aura. Done when: HUD shows MVP; bonus applies.

**P24 — Boss signature mechanics (5 bosses, 1 each).** HoundSprint / JudgmentSlam
/ SkyCourtAdds / InvisibilityPulse / PhaseShields. Done when: each boss runs its
one signature; no other boss mechanics.

---

## BLOCK D — Visual & Audio Polish  [EXP] (most already shipped)

**P25 — Art consistency pass.** Gems P1–P6, 18 specials, all enemy tiers, board
landmarks share one palette + rim-light + drop-shadow language. Done when: no
visual outlier; high-tier reads clearly bigger/fancier.

**P26 — Board theme system.** Lava / Stone / Ice themes + theme-aware rocks +
visible-against-background check. Done when: theme switch changes floor + rocks
coherently.

**P27 — Combat FX polish.** Per-damage-type projectile/impact colours, death
bursts, boss telegraphs. Done when: damage type is readable from the projectile.

**P28 — UI final pass.** HUD, modals, recipe book, luck panel (live odds),
results screen — all on the KR wood/gold language. Done when: every panel
matches; luck panel shows the active HL odds.

**P29 — Audio.** Music (lobby/combat/boss) + SFX (place/merge/combine/attack/
death/leak/boss/win/lose). Done when: every key action has audio; mixable.

---

## BLOCK E — Onboarding / Tutorial (Phase 25)  [EXP]

**P30 — Tutorial infra.** Step table, HUD dialog overlay, cell highlights,
arrows, skip + replay, step-gated on real gameplay events. Done when: a step
only advances when the actual action happens.

**P31 — 25A minimal guided.** Place 5 → keep one → rocks form → path preview →
first wave → "you survived". Done when: new player finishes + enters a real
Easy match understanding place + keep + start.

**P32 — 25B maze-building lesson.** Rocks = strategy; longer path = more shots;
blocking placement rejected with clear feedback. Done when: player sees a
rejection + a corridor bend.

**P33 — 25C merge/combine lesson.** Merge 2 same → +1; recipe book intro; hand
off to a How-To reference. Done when: player completes one merge + opens recipe
book.

---

## BLOCK F — Stability & Extensibility  [CORE for stability]

**P34 — Config-driven everything.** Enemies, waves, gems, specials, abilities,
difficulties, utilities all live as data tables — adding content = editing a
table, not code. Done when: a new enemy/wave/special needs no new functions.

**P35 — State/render separation.** No balance math in render; game state in one
ref; render reads only. Done when: render is pure; sim is testable in isolation.

**P36 — Performance pass.** Cap active enemies, memoise static SVG, frame-budget
the loop, throttle off-screen work. Done when: 60fps with a full late wave on a
mid phone.

**P37 — Local persistence.** Best wave per difficulty, settings, tutorial-done
flag in device storage. Done when: progress survives app restart.

**P38 — Edge-case hardening.** Path-lock on full maze, leak handling, restart,
background/resume, no soft-locks. Done when: a fuzz pass finds no dead states.

**P39 — Self-test harness.** Headless sim of W1–50 per difficulty that reports
clear/leak/HP-vs-DPS — so balance changes are checkable without manual F5.
Done when: `npm run simulate` prints a per-wave pass/fail table.

---

## BLOCK G — DEFERRED (post-core)  [DEF]

**P40 — Game modes.** Quick 50 / Standard 100 / Endless 9999 + reward mults.
Done when: mode select changes wave count + rewards.

**P41 — Endless layer.** Mutations (W75+ pool of 8) + milestones (every W25 from
W100). Done when: gated correctly; deterministic per wave.

**P42 — Multiplayer race.** `[RBX-ONLY — skip on mobile]`. Recorded so the data
model stays compatible; not built in the RN client.

---

## Verification gates

- **Gate 1 (end of Block 0+A):** Solo Normal W1–50 beatable with a decent build;
  Easy reaches W30+ casually; Nightmare edge-of-beatable. User F5 PASS required.
- **Gate 2 (end of Block B):** No-Diamond run and no-P6 run both reach late game;
  enemy abilities all have working counters.
- **Gate 3 (end of Block C):** P5/P6 feel rewarding not mandatory; gold has a
  real spend decision.
- **Gate 4 (end of D+E):** New player completes tutorial + clears Easy W10 first
  session; no visual outliers.
- **Gate 5 (end of F):** Self-test green W1–50 × 4 difficulties; 60fps; no
  soft-locks. → launch-ready core.

Block G only starts after Gate 5.
