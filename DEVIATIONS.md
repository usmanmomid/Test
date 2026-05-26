# Deviation Register — Mobile build vs FINAL_VERIFIED docs

Where the mobile implementation will intentionally differ from the documents,
and why. Locked before Phase 1 so nothing is guessed later. Grouped by type.

Docs referenced: `FINAL_VERIFIED` (V3 + V4 §A + V5 §59-64), `BALANCE_AUDIT_2026_05_22/24`, `PHASE_25_TUTORIAL_SPEC`.

---

## A. Resolved contradictions (docs conflict — I pick one side)

**A1. Recipe gold cost.**
- Docs conflict: §8 = 0 gold · §37 = 500/1000/2000/4000/8000 · (your V1 patch = 0 or low).
- **Decision: 100 / 250 / 600 / 1500 / 3500.**
- Why: mobile has NO gold utilities built, so recipes are the only gold sink —
  0 makes gold meaningless. But 8000 double-gates on top of ingredient RNG.
  The lowered curve gives gold a real decision without feeling unfair.
  Revisit toward 0 if/when gold utilities ship (P21–P22).

**A2. Natural P6 rolls.**
- Docs conflict: §A16 (V4) = P6 natural 5% at HL6+ · §10 + §115 Luck panel = no
  natural P6 (plateau, merge-only).
- **Decision: NO natural P6. P6 = merge ladder or recipe only.**
- Why: a 5% natural P6 is swingy RNG (one player free-wins at W31, another never
  sees it). For an older/strategic audience, P6 should be earned by planning.
  Matches the pity philosophy: kill bad RNG, don't create swingy good RNG.

**A3. HeroLevel → roll-table size.**
- Docs conflict: §A16 = 6-row table (HL1–HL6+) on `floor((W-1)/6)+1` · §10/§115 =
  5-row plateau · my current build = custom 8-row.
- **Decision: adopt the doc's `HL = floor((W-1)/6)+1` formula, but use an
  8-step odds table that caps natural rolls at P5** (P6 stays merge-only per A2).
- Why: the doc's HL formula is the cleaner cadence; the 8-step odds keep late
  game progressing (P5-heavy) without the V3 plateau-at-HL5 staleness.

---

## B. Intentional design deviations (I improve on / disagree with the doc)

**B1. HP model — keep per-type base, OR adopt single-base-40 + abilities.**
- Doc (V4 §A3): ONE BaseHP=40 for all regular enemies; "types" come from
  abilities/modifiers, not different base HP.
- My current build: different base HP per type (grunt 30, tank 100, …).
- **Decision: adopt the doc's single-base-40 + growth model.** Tank-ness,
  swarm-ness etc. become ability/modifier flags, not bespoke HP.
- Why: far more extensible (P34 config-driven) and it's the canonical V4 model.
  This is a structural rewrite of `ENEMIES`, flagged so it's not a surprise.

**B2. Champion waves, not "trial waves".**
- Doc: champion waves at W5/15/25/35/45 with `ChampionHPMult 1.4` + champion
  gold 2×.
- My current build: I invented "trial waves" (SPEED/AERIAL/SWARM/…) at those
  positions — a different concept.
- **Decision: replace my trial-wave concept with the doc's champion-wave
  concept** (champion enemy + 1.4 HP + 2× gold), keep a themed flavour label
  in the banner for readability.
- Why: stay aligned with canonical design; champions teach a counter before the
  next boss (the doc's stated purpose).

**B3. Boss-only waves + signature mechanic.**
- Doc §51.2 (locked) = boss-only, +10% HP. §A13 = 1 signature mechanic per boss.
- My current build: boss + minions, no boss mechanics.
- **Decision: follow the doc — boss-only, HP absorbs minions, + one signature
  per boss.** (This MATCHES the doc; listed because it changes my current build.)

**B4. Difficulty values aligned to doc, softer than my current.**
- Doc §60: Easy 0.30/0.50, Normal 0.90/0.95, Hard 1.03/1.00, Nightmare 1.05/1.00,
  lives 50.
- My current: harsher CoolKid/Principal (1.25–1.70 HP), lives 12–30.
- **Decision: adopt doc values + lives 50.** (Aligns to doc; changes my build.)

---

## C. Additions NOT in the docs (my own, for stability/fairness)

**C1. Automatic pity system.**
- Doc: pity is PLAYER-PAID (Gem Prayer / Purity Prayer gold utilities), no
  automatic protection.
- My addition: automatic family + tier pity (already in current build).
- **Decision: keep automatic pity as a SAFETY NET, but make it gentle** so the
  paid Prayers (P22) still have value. Pity prevents hopeless runs; Prayers let
  you actively bias luck. Two layers, not one replacing the other.
- Why: a 10+ newcomer shouldn't lose to a 0-P4 streak they can't pay to fix yet.

**C2. Headless self-test harness (PLAN P39).**
- Doc: relies on manual F5 runs + user-pasted logs as the empirical source.
- My addition: a scriptable W1–50 × difficulty simulator that prints
  clear/leak/HP-vs-DPS.
- Why: this is the practical fix for the doc's source-of-truth problem —
  balance changes become checkable without a manual F5 every time.

**C3. Single BALANCE constants block as the only numeric source.**
- Doc: numbers are restated across V3/V4/V5/audits → drift (the doc admits a
  bug from this in §114).
- My addition: ONE commented block; nothing numeric in prose anywhere else.
- Why: code-is-truth. Eliminates the multi-source drift at the root.

---

## D. Platform-forced deviations (mobile ≠ Roblox — unavoidable)

**D1. No server authority.** Roblox is server-authoritative; the RN client runs
the sim locally. Same rules, single-device trust model.

**D2. No DataStore.** Persistence uses device local storage (best wave per
difficulty, settings, tutorial-done). Same data shape, different backend.

**D3. Tutorial input model.** Doc uses ProximityPrompt + a lobby Guide NPC. Mobile
uses a touch overlay + highlighted cells/arrows + dialog panel. Same pedagogy
(25A→B→C, skippable/replayable), different affordance.

**D4. No multiplayer race.** Roblox-only (12 arenas, shared wave timing). Mobile
is solo. Data model kept compatible but the client is not built (PLAN P42).

**D5. Range units.** Doc uses studs (cell = 4 studs); mobile uses tiles directly
(studs ÷ 4). All §11/§36 ranges convert on import.

---

## E. OPEN — needs your lock before the relevant phase

**E1. Difficulty names.** Doc = Easy / Normal / Hard / Nightmare. You earlier
chose the playful set Newcomer / ThatKid / CoolKid / Principal. **Which wins?**
(Values align to doc either way per B4 — this is names only.)

**E2. Damage-type depth on mobile.** Full Physical/Magic/Poison/Burn + 70% resist
+ immunities (§A17) is a big system. **Full model, or a simplified
physical/magic split** for the first mobile pass? (Affects P17 scope.)

**E3. Endless / mutations / milestones.** Doc has them live (Roblox). My scope
advice = DEFER on mobile until core is proven (PLAN Block G). **Confirm defer**,
or do you want them in the core build?

---

## Summary of what actually changes vs my CURRENT mobile build

| System | Current build | After this register |
|---|---|---|
| Recipe cost | 0 | 100/250/600/1500/3500 (A1) |
| Natural P6 | none | none — confirmed (A2) |
| Roll table | custom 8-step | doc HL formula + 8-step, P5 cap (A3) |
| Enemy HP | per-type bases | single base 40 + growth + abilities (B1) |
| W5/15/25/35/45 | my "trial" waves | champion waves 1.4×/2× gold (B2) |
| Boss waves | boss + minions | boss-only + signature (B3) |
| Difficulty | harsh, playful names | doc values, names = OPEN (B4/E1) |
| Pity | automatic | automatic safety net + paid Prayers (C1) |
| Economy | table | W^1.15 + killstreak + anti-farm (PLAN P9) |
| Source of truth | commit msgs drift | one BALANCE block (C3) |
| Testing | manual | + headless harness (C2) |
