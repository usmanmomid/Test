// sim.js — headless balance harness  (PLAN P39, runs in plain Node)
//
//   node sim.js               → table for all difficulties
//   node sim.js Normal        → one difficulty
//   node sim.js Normal anchors→ print derived HP anchor points
//
// Purpose: estimate expected player board-DPS per wave, then DERIVE the enemy
// HP curve from a time-to-kill target instead of hand-picking a growth rate.
// Every assumption is a named, tunable input — the value is in SEEING the
// shape (where walls/valleys are) and being able to tweak one number.
//
// This is a DESIGN TOOL, not the runtime. Once the curve is validated here we
// transcribe the anchors into App.js's BALANCE block (P5). P34 later makes the
// app import a shared module so there's literally one source.

'use strict';

// ───────────────────────── TUNABLE ASSUMPTIONS ──────────────────────────────
// These are the model's guesses. They are MEASURABLE (unlike "1.13 feels
// right") — tweak them and re-run to see the difficulty shape move.
const A = {
  combatSecondsPerWave: 30,   // seconds enemies spend in-range and killable
  targetClearFraction: 0.65,  // a wave should take ~65% of that to clear (35% headroom)
  wallFraction:        0.95,  // >95% of combat time to clear → WALL (likely leak)
  trivialFraction:     0.30,  // <30% → TRIVIAL (boring)
  exposureFactor:      0.45,  // fraction of placed towers that hit an avg enemy (maze quality)
  towersPerWave:       0.85,  // net firing towers gained per wave (keep − merge/rock consumption)
  effectiveDpsMult:    1.45,  // splash/multi/poison/aura uplift over raw single-target
  mergeUpliftPerWave:  0.015, // board purity creeps above fresh-roll as duplicates merge (capped)
  mergeUpliftCap:      1.6,
};

// ───────────────────────── DATA (mirrors App.js) ────────────────────────────
// Roll odds per hero level [P1..P5]; P6 is merge-only (no column).
const ROLL_ODDS = [
  [1.00, 0.00, 0.00, 0.00, 0.00],
  [0.70, 0.30, 0.00, 0.00, 0.00],
  [0.50, 0.30, 0.20, 0.00, 0.00],
  [0.30, 0.30, 0.30, 0.10, 0.00],
  [0.10, 0.25, 0.30, 0.25, 0.10],
  [0.05, 0.15, 0.30, 0.35, 0.15],
  [0.00, 0.10, 0.25, 0.40, 0.25],
  [0.00, 0.05, 0.15, 0.40, 0.40],
];
const heroLevel = (w) => Math.min(8, Math.floor((w - 1) / 6) + 1);

// Average RAW single-target DPS per purity, across the 8 gem families.
// Derived from GEM_STATS (damage / cooldown), so it tracks the real gem table.
// P1..P6. (P6 only reachable via merge, modelled in the uplift, not rolled.)
const GEM_DPS_BY_PURITY = [3.4, 6.8, 12, 27, 54, 400];

// Difficulty HP multipliers (doc §60 values per lock E1/B4).
const DIFFICULTY = {
  Easy:      { hp: 0.30, count: 0.50 },
  Normal:    { hp: 0.90, count: 0.95 },
  Hard:      { hp: 1.03, count: 1.00 },
  Nightmare: { hp: 1.05, count: 1.00 },
};

// Wave enemy count (doc §51.1 target: T1 15 flat → cap 30).
function waveCount(w) {
  if (w <= 9)  return 15;
  if (w <= 19) return 20 + Math.floor((w - 10) * 0.5);   // 20→24
  if (w <= 29) return 22 + Math.floor((w - 20) * 0.6);   // 22→28
  if (w <= 39) return 25 + Math.floor((w - 30) * 0.5);   // 25→29
  return 30;                                             // cap
}
const isBossWave = (w) => w % 10 === 0;

// CURRENT live curve in App.js (regular 1.15^(w-1) × base 30), for comparison.
function currentRegularHP(w) { return 30 * Math.pow(1.15, w - 1); }

// FITTED FORMULA — Roblox-portable. Decelerating piecewise growth fitted to the
// harness-derived per-enemy anchors. This is the candidate to ship in App.js
// AND hand to the Roblox game. BaseHP per regular enemy = 3.
//   Growth: 1.28 (W≤10) · 1.16 (11-25) · 1.07 (26-40) · 1.045 (41-50) · 1.04 (51+ endless)
function fittedGrowth(i) {
  if (i <= 10) return 1.28;
  if (i <= 25) return 1.16;
  if (i <= 40) return 1.07;
  if (i <= 50) return 1.045;
  return 1.04;
}
function fittedRegularHP(w) {
  let hp = 3;
  for (let i = 2; i <= w; i++) hp *= fittedGrowth(i);
  return hp;
}

// ───────────────────────── PLAYER DPS MODEL ─────────────────────────────────
function expectedGemDPS(w) {
  const odds = ROLL_ODDS[heroLevel(w) - 1];
  let dps = 0;
  for (let i = 0; i < 5; i++) dps += odds[i] * GEM_DPS_BY_PURITY[i];
  const uplift = Math.min(A.mergeUpliftCap, 1 + w * A.mergeUpliftPerWave);
  return dps * uplift;
}
function boardDPS(w) {
  const towers = Math.max(1, w * A.towersPerWave);
  return towers * expectedGemDPS(w) * A.exposureFactor * A.effectiveDpsMult;
}

// ───────────────────────── DERIVED HP CURVE ─────────────────────────────────
// The whole point: HP falls out of the DPS target, it is not a chosen growth.
// targetWaveHP(W) = boardDPS(W) × combatSeconds × targetClearFraction.
function derivedWaveHP(w, diff) {
  const base = boardDPS(w) * A.combatSecondsPerWave * A.targetClearFraction;
  return base * DIFFICULTY[diff].hp / 0.90;  // normalise so Normal(0.90)=1.0 baseline
}

// Current total wave HP (regular curve × count, boss approximated ×6).
function currentWaveHP(w, diff) {
  const d = DIFFICULTY[diff];
  const count = Math.max(1, Math.round(waveCount(w) * d.count));
  if (isBossWave(w)) return currentRegularHP(w) * 6 * d.hp;   // rough boss-only
  return currentRegularHP(w) * count * d.hp;
}

// ───────────────────────── REPORT ───────────────────────────────────────────
function verdict(clearTime) {
  const f = clearTime / A.combatSecondsPerWave;
  if (f > A.wallFraction)    return 'WALL';
  if (f < A.trivialFraction) return 'trivial';
  return 'ok';
}
// Fitted total wave HP (fitted regular × count, boss-only ≈ 5× regular × bossCount).
function fittedWaveHP(w, diff) {
  const d = DIFFICULTY[diff];
  if (isBossWave(w)) {
    const bossCount = w >= 50 ? 6 : w >= 30 ? 3 : w >= 20 ? 2 : 1;
    return fittedRegularHP(w) * 5 * bossCount * d.hp;
  }
  const count = Math.max(1, Math.round(waveCount(w) * d.count));
  return fittedRegularHP(w) * count * d.hp;
}
function runDifficulty(diff) {
  console.log(`\n=== ${diff} ===  (clr = clear-time of CURRENT curve; verdict on CURRENT)`);
  console.log('  W  HL  boardDPS    curHP   derived   fitted   curClr  verdict');
  for (let w = 1; w <= 50; w++) {
    const dps = boardDPS(w);
    const cur = currentWaveHP(w, diff);
    const der = derivedWaveHP(w, diff);
    const fit = fittedWaveHP(w, diff);
    const curClr = cur / dps;              // seconds to clear the CURRENT wave
    const tag = isBossWave(w) ? 'B' : ' ';
    console.log(
      `${tag}${String(w).padStart(2)} ${String(heroLevel(w)).padStart(2)}  ` +
      `${dps.toFixed(0).padStart(8)}  ` +
      `${cur.toFixed(0).padStart(7)}  ` +
      `${der.toFixed(0).padStart(7)}  ` +
      `${fit.toFixed(0).padStart(7)}  ` +
      `${curClr.toFixed(1).padStart(5)}  ${verdict(curClr)}`
    );
  }
}
function printAnchors(diff) {
  const anchors = [1, 10, 25, 40, 50];
  console.log(`\n=== ${diff} derived HP anchors (per-enemy regular + total wave) ===`);
  for (const w of anchors) {
    const total = derivedWaveHP(w, diff);
    const per = total / Math.max(1, Math.round(waveCount(w) * DIFFICULTY[diff].count));
    const growth = w > 1 ? Math.pow(per / (derivedWaveHP(1, diff) / waveCount(1)), 1 / (w - 1)) : 1;
    console.log(`  W${String(w).padStart(2)}  total≈${total.toFixed(0).padStart(8)}  perEnemy≈${per.toFixed(0).padStart(6)}  impliedGrowth≈${growth.toFixed(3)}`);
  }
}

// ───────────────────────── CLI ──────────────────────────────────────────────
const arg = process.argv[2];
const wantAnchors = process.argv.includes('anchors');
if (arg && DIFFICULTY[arg]) {
  runDifficulty(arg);
  if (wantAnchors) printAnchors(arg);
} else {
  for (const d of Object.keys(DIFFICULTY)) runDifficulty(d);
  printAnchors('Normal');
}
