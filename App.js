import React, { useState, useEffect, useRef, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Svg, {
  Path, Circle, Ellipse, Rect, G, LinearGradient, RadialGradient,
  Stop, Defs, Polygon, Line, Pattern,
} from 'react-native-svg';
import {
  StyleSheet,
  Text,
  View,
  Image,
  TouchableOpacity,
  Dimensions,
  SafeAreaView,
  Modal,
  Pressable,
  PanResponder,
  StatusBar,
  ScrollView,
} from 'react-native';

// ─────────────────────────────────────────────────────────────────────────────
// Crystal Maze Defence — mobile version of the Roblox CMD core loop.
//
// Per the design doc:
//   • Each wave's BUILD phase gives the player EXACTLY 5 placements.
//   • Each placement: server rolls a random gem family + purity onto the cell.
//   • After 5 placements: the CHOOSE ACTION step. The player picks ONE of:
//       - Keep        →  1 surviving tower, other 4 candidates become rocks.
//       - Merge +1    →  2 same family + same purity → 1 gem at next purity.
//       - Merge +2    →  4 same family + same purity → 1 gem two purities up.
//       - Combine     →  Exact recipe ingredients → named special tower.
//     The chosen anchor's cell holds the result. Everything else used in the
//     action (and all unused candidates from this round) becomes a rock.
//   • Rocks are walls but never attack. Towers attack. Stones shape the maze.
//   • Gems cost 0 gold. Starting gold = 0. Gold is utility currency only.
//   • Roll odds depend on PLAYER LEVEL (not wave). Level grows with waves.
//   • Board: 41×41 with 5 checkpoints — enemies BFS Start → CP1..CP5 → Castle.
//   • 50 waves total. Bosses on 10, 20, 30, 40, 50.
// ─────────────────────────────────────────────────────────────────────────────

// ═════════════════════════════════════════════════════════════════════════════
// BALANCE — SINGLE SOURCE OF TRUTH  (PLAN.md P1)
// -----------------------------------------------------------------------------
// Every live balance number is defined ONCE, in the constant it names below.
// Do NOT restate any balance number anywhere else (prose, commit msg, doc).
// To read the whole balance picture, read the constants this block points to.
//
// LOCKED DESIGN DECISIONS (see DEVIATIONS.md):
//   • Recipe gold cost ........ doc §67 V5: 250/500/1200/3000/12000 (RECIPE_GOLD_COST)
//   • Roll odds (HL→purity) ... doc §10 6-tier table, 5% natural P6 from HL6+
//   • Hero level cadence ...... HL = min(6, floor((W-1)/6)+1)    (levelForWave)
//   • Boss waves .............. boss-only, no minion adds (doc §51.2) (buildWaves)
//   • Difficulty .............. doc §60 V5: HP 0.30/0.90/1.03/1.05 (DIFFICULTIES)
//   • Enemy HP ................ doc §59 V5: BASE_HP 40 × 1.13/1.07/1.06/1.04
//                               × coef × ramp × chaos × difficulty × bossMult
//   • Boss HP ................. wave-aware 1.6/2.0/2.5 (doc §61) (bossHPMult)
//   • Onboarding ramp ......... W1-11 HP+speed (doc §62)         (ONBOARDING_RAMP)
//   • Kill gold ............... max(1, floor(W^1.15)) (doc §54.1) (killGold)
//   • Boss gold ............... 5× per-kill, NO lump (doc §54.2) (killGoldFor)
//   • Killstreak .............. ladder {1, 1.10, 1.18, 1.25} (doc §54.3) (streakMult)
//   • Anti-farm ............... streak gated by ≥25% path OR ≥1.5s alive (doc §54.3)
//   • Damage types ............ doc: per-family Physical/Magic/Poison/Burn (FAMILY_DAMAGE_TYPE)
//   • Resistance cap .......... 0.70 max reduction, no immunities (doc §53.4) (damageMultByType)
//   • Champion enemy .......... 1.4× HP, 2× gold (doc §A3) (ENEMIES.champion)
//   • P5 synergy .............. iso ×0.75, clustered ×1.20 within 3 tiles (doc §A7)
//   • P6 rule-breaks .......... Diamond no-armor · Topaz +2 mål · Amethyst armor×2 ·
//                               Sapphire slow→95% · Ruby 5-hop chain · Emerald
//                               poison-spread · Aquamarine 2×AS-in-mutation · Opal
//                               global-reveal-thru-fog (all 8 live)
//   • Game modes .............. Quick 50 / Standard 100 / Endless 9999 (doc §60.6)
//   • Mutations ............... 8-pool, W75 gate (1 mut), W150 (2 muts) (doc §A6/§56)
//   • Milestones .............. W100+, ±5% speed/armor per W25 alternating (doc §57)
//   • Wave generation ......... W1-50 curated table, W51+ procedural 70/20/10 (doc §A2)
//   • Gold utilities .......... 13 active skills, gold sinks (doc) (UTILITIES)
//   • Boss signatures ......... 5 core + 12 endless-roster bosses (BOSS_SIGNATURES)
//   • Endless boss cycle ...... 20-slot roster, W60+ cycles deterministically (BOSS_ROSTER)
//   • Recipe damage types ..... inferred from stats (poison/slow/raw) (towerDamageType)
//   • Opal SVG rendering ...... iridescent rainbow body gradient (GemSvg isOpal)
//
// CONFIG INDEX (the numbers live in these — edit here, nowhere else):
//   Board ............ COLS, ROWS, TILE, SPAWN, CHECKPOINTS, GOAL
//   Match ............ STARTING_GOLD, MAX_PLACEMENTS, NUM_WAVES
//   Difficulty ....... DIFFICULTIES (hp/speed/boss/gold mult + lives)
//   Roll odds ........ ROLL_ODDS  (per hero level)   · rollPurity / rollWithPity
//   Hero level ....... levelForWave(wave)
//   Economy .......... killGold (W^1.15), killGoldFor (5× boss), streakMult
//   Gem stats ........ GEM_STATS  (8 families × 6 purities)
//   Specials ......... SPECIAL_RECIPES (18) · RECIPE_GOLD_COST (per tier)
//   Enemies .......... ENEMIES (speed/armor/flying — NO hp; hp via computeEnemyHP)
//   Waves ............ buildWaves() (composition only; HP at spawn)
//
// CURVE STATUS: P5 LANDED — enemy HP migrated to the DPS-derived decelerating
// curve (validated in spatial_sim.js, endless to W500). Economy still on the
// table curve (P9 migrates to W^1.15 + killstreak). Damage types pending (P17).
// ═════════════════════════════════════════════════════════════════════════════

// ─── Board ───────────────────────────────────────────────────────────────────
const COLS = 41;
const ROWS = 41;
const TILE = 22;
const BOARD_W = COLS * TILE;
const BOARD_H = ROWS * TILE;

const SCREEN = Dimensions.get('window');
const SCREEN_W = SCREEN.width;
const SCREEN_H = SCREEN.height;

const VIEWPORT_H = Math.max(360, SCREEN_H - 240);
const VIEWPORT_W = SCREEN_W;

const FIT_SCALE = Math.min(VIEWPORT_W / BOARD_W, VIEWPORT_H / BOARD_H);
const MIN_SCALE = Math.max(0.25, FIT_SCALE * 0.7);
const MAX_SCALE = 3.5;
const INITIAL_SCALE = FIT_SCALE;

// Doc coords are 1-indexed; convert to 0-indexed (row=r-1, col=c-1).
const SPAWN     = { r: 20, c: 0 };   // Start  col 1, row 21
const CHECKPOINTS = [
  { r: 7,  c: 7  },                  // CP1    col 8,  row 8
  { r: 7,  c: 32 },                  // CP2    col 33, row 8
  { r: 32, c: 32 },                  // CP3    col 33, row 33
  { r: 32, c: 7  },                  // CP4    col 8,  row 33
  { r: 20, c: 20 },                  // CP5    col 21, row 21
];
const GOAL = { r: 20, c: 40 };       // Castle col 41, row 21

// Reserved cells can never be blocked.
const RESERVED = [SPAWN, GOAL, ...CHECKPOINTS];
function isReserved(r, c) {
  return RESERVED.some((p) => p.r === r && p.c === c);
}

// ─── Game constants ──────────────────────────────────────────────────────────
const STARTING_GOLD = 0;
const MAX_PLACEMENTS = 5;
const STONE_REFUND = 0;     // rocks can't be sold under standard rules
const TUTORIAL_STEPS = [
  { title: 'BUILD', body: 'Place 5 rolled gems. Every unused roll becomes stone and changes the maze.' },
  { title: 'CHOOSE', body: 'Pick one result: keep, merge, chain-merge, or forge a recipe.' },
  { title: 'COMBAT', body: 'Enemies follow the path. Tap towers for targeting; gold skills sit above the board.' },
];

// Game modes — doc §60.6 V4 (Marathon dropped). 3 mode set, default Standard.
// Endless is bounded by board saturation + milestones, not a wave count.
const MODES = {
  quick:    { id: 'quick',    name: 'QUICK',    waves: 50,   rewardMult: 1.00, desc: 'Fast match · standard rewards' },
  standard: { id: 'standard', name: 'STANDARD', waves: 100,  rewardMult: 1.20, desc: 'Full-length · +20% rewards' },
  endless:  { id: 'endless',  name: 'ENDLESS',  waves: 9999, rewardMult: 1.50, desc: 'Forever · milestones from W100' },
};
const MODE_ORDER = ['quick', 'standard', 'endless'];
const DEFAULT_MODE = 'standard';
const NUM_WAVES = 50;

// ─── Difficulty ─────────────────────────────────────────────────────────────
// Each difficulty multiplies enemy HP / speed / boss HP / gold and overrides
// starting lives. Player-side stats and gem damage are NOT modified — the
// challenge curve comes purely from the enemy side and economy.
// Difficulty (P5/P8 + lock E1/B4) — doc V5 §60 canonical values (2026-05-23,
// F5-playtested in Roblox; tower stats are byte-identical across mobile/Roblox
// per gem-stat verification, so the doc curve ports directly). Lives 50 flat
// (doc §63). goldMul = doc §60 RewardMult. speedMul kept at 1.0 across all —
// doc has no difficulty SpeedMult; difficulty speed differences come from
// mutations/milestones instead.
const DIFFICULTIES = {
  easy:      {
    id: 'easy',      name: 'EASY',      short: 'Newcomer-friendly',
    tagline: 'Learn the maze. Kind waves, forgiving lives.',
    hpMul: 0.30, speedMul: 1.00, goldMul: 1.25, countMul: 0.50, spawnDelayMul: 1.20,
    lives: 50, color: '#5cf28a',
  },
  normal:    {
    id: 'normal',    name: 'NORMAL',    short: 'As designed',
    tagline: 'The intended challenge. Balanced for most players.',
    hpMul: 0.90, speedMul: 1.00, goldMul: 1.00, countMul: 0.95, spawnDelayMul: 1.05,
    lives: 50, color: '#4cc9ff',
  },
  hard:      {
    id: 'hard',      name: 'HARD',      short: 'Tighter timing',
    tagline: 'Less slack. A real maze is required.',
    hpMul: 1.03, speedMul: 1.00, goldMul: 1.10, countMul: 1.00, spawnDelayMul: 0.95,
    lives: 50, color: '#ffd166',
  },
  nightmare: {
    id: 'nightmare', name: 'NIGHTMARE', short: 'Edge of beatable',
    tagline: 'No mercy. Every placement matters.',
    hpMul: 1.05, speedMul: 1.00, goldMul: 1.25, countMul: 1.00, spawnDelayMul: 1.00,
    lives: 50, color: '#ff4d6d',
  },
};
const DIFFICULTY_ORDER = ['easy', 'normal', 'hard', 'nightmare'];
const DEFAULT_DIFFICULTY = 'normal';
const emptyPerDiff = () => ({
  easy: { bestWave: 0 },
  normal: { bestWave: 0 },
  hard: { bestWave: 0 },
  nightmare: { bestWave: 0 },
});
const STORAGE_KEY = 'crystal-maze-defence:v1';
const defaultStats = () => ({
  bestScore: 0,
  bestWave: 0,
  gamesPlayed: 0,
  wins: 0,
  tutorialDone: false,
  perDiff: emptyPerDiff(),
});
function normalizeStats(raw) {
  const base = defaultStats();
  if (!raw || typeof raw !== 'object') return base;
  return {
    ...base,
    ...raw,
    perDiff: { ...base.perDiff, ...(raw.perDiff || {}) },
  };
}

// ─── Enemy HP system — doc V5 §A3/§59 CANONICAL (LIVE 2026-05-23) ────────────
// HP(W) = BaseHP × ∏ Growth(i) × ChaosBand × Difficulty × Ramp × LocalMult.
// Curve was F5-playtested in Roblox after V4 (1.18) walled at W50. Gem tower
// stats are byte-identical across mobile/Roblox (verified 8/8 families), so
// the same HP curve applies. Type coefficients preserve mobile enemy identity
// (tank chunkier, swarm tinier) atop the one curve.
const BASE_HP = 40;                                    // doc §59 V5
function hpGrowth(i) {                                 // doc §59 V5 piecewise
  if (i <= 50)  return 1.13;
  if (i <= 100) return 1.07;
  if (i <= 200) return 1.06;
  return 1.04;                                         // endless soft-cap
}
const _regHpCache = [0, BASE_HP];
function regularHP(wave) {
  for (let i = _regHpCache.length; i <= wave; i++) _regHpCache[i] = _regHpCache[i - 1] * hpGrowth(i);
  return _regHpCache[Math.max(1, wave)] || BASE_HP;
}
// Type coefficients ≈ doc enemy modifiers (Vitality 1.4 for tank, Flying 1.2).
// boss/mega use 1.0 because bossHPMult(wave) supplies their multiplier.
const ENEMY_HP_COEF = { grunt: 1.0, runner: 0.6, swarm: 0.4, flyer: 1.2, tank: 1.4, champion: 1.4, boss: 1.0, mega: 1.5 };
// Boss HP wave-aware multiplier — doc §61 V5 (replaces flat 2.5 that walled at W10).
function bossHPMult(wave) {
  if (wave <= 10) return 1.6;
  if (wave <  20) return 2.0;
  return 2.5;
}
const CHAMPION_HP_MULT = 1.4;                          // doc §A3 (champion type pending)
// Onboarding ramp W1-11 — doc §62 verbatim.
const ONBOARDING_RAMP = {
  1: [0.15, 0.45], 2: [0.30, 0.60], 3: [0.45, 0.72], 4: [0.60, 0.82],
  5: [0.72, 0.90], 6: [0.82, 0.94], 7: [0.89, 0.97], 8: [0.94, 0.99],
  9: [0.97, 1.00], 10: [0.99, 1.00], 11: [1.00, 1.00],
};
const rampHP = (w) => (ONBOARDING_RAMP[w] || [1, 1])[0];
const rampSpeed = (w) => (ONBOARDING_RAMP[w] || [1, 1])[1];
// Chaos band — doc §A3 deterministic per-wave ±5% (early; widens later but
// kept at ±5% for mobile until endless mutations land).
function chaosBand(wave) {
  let x = Math.sin(wave * 12.9898) * 43758.5453;
  x -= Math.floor(x);
  return 0.95 + x * 0.10;
}
function computeEnemyHP(type, wave, diff) {
  const coef = ENEMY_HP_COEF[type] || 1.0;
  const isBoss = type === 'boss' || type === 'mega';
  const localMult = isBoss ? bossHPMult(wave) : 1;     // champion 1.4 wires when type exists
  return Math.max(1, Math.floor(
    regularHP(wave) * coef * chaosBand(wave) * rampHP(wave) * diff.hpMul * localMult
  ));
}

// ─── Damage types + resistance cap — doc §53.4 / §A17 (Phase B) ─────────────
// Per-family damage type (mapped from gem identity in doc §11). Specials
// default to physical until §A8 per-recipe types land (Phase F).
const FAMILY_DAMAGE_TYPE = {
  sapphire:   'magic',    // slow / control
  diamond:    'physical', // raw boss-killer
  opal:       'physical', // aura support
  emerald:    'poison',   // DoT
  amethyst:   'physical', // armor break + raw
  aquamarine: 'magic',    // fast magic
  ruby:       'physical', // splash
  topaz:      'physical', // multi-hit
};
const RESISTANCE_CAP = 0.70;   // doc §53.4: max damage reduction; no immunities.
// Enemy resist fields (physicalResist / magicResist / poisonResist / burnResist)
// default to 0; specific enemy types or mutations set higher values up to the cap.
function damageMultByType(enemy, dmgType) {
  // ShieldRotations mutation OR boss PhaseShields signature: full immunity to
  // one type at a time (doc §A.1b / §A13.PhaseShields).
  if (enemy._shieldBlockType === dmgType) return 0;
  if (enemy._bossShieldType === dmgType) return 0;
  const r = dmgType === 'physical' ? (enemy.physicalResist || 0)
          : dmgType === 'magic'    ? (enemy.magicResist    || 0)
          : dmgType === 'poison'   ? (enemy.poisonResist   || 0)
          : dmgType === 'burn'     ? (enemy.burnResist     || 0)
          : 0;
  return 1 - Math.min(RESISTANCE_CAP, r);
}
function towerDamageType(tower) {
  if (tower.kind === 'gem') return FAMILY_DAMAGE_TYPE[tower.gemType] || 'physical';
  if (tower.kind === 'special') {
    const r = SPECIAL_BY_ID[tower.specialId];
    if (r?.stats?.damageType) return r.stats.damageType;   // explicit recipe override
    if (r?.stats?.poison)     return 'poison';             // DoT-led identity
    if (r?.stats?.slow)       return 'magic';              // control-led identity
    return 'physical';                                     // raw single-target default
  }
  return 'physical';
}

// ─── P5 synergy + P6 rule-breaks — doc §55 / §A7 / §A8 (Phase C) ─────────────
// P5: isolated (no same-family P5 within 3 tiles ≈ 12 studs) → dmg ×0.75;
// clustered → ×1.20. Punishes "spam one P5 of every family"; rewards focused
// merging into one family's P5 trio. Applied to FINAL outgoing damage.
const P5_SYNERGY_RANGE = 3;
const P5_SYNERGY_ISO   = 0.75;
const P5_SYNERGY_CLUS  = 1.20;
function p5SynergyMult(tower, s) {
  if (tower.kind !== 'gem' || tower.tier !== 5) return 1;
  const r2 = P5_SYNERGY_RANGE * P5_SYNERGY_RANGE;
  for (const t of s.towers) {
    if (t === tower || t.kind !== 'gem' || t.tier !== 5) continue;
    if (t.gemType !== tower.gemType) continue;
    const dr = t.r - tower.r, dc = t.c - tower.c;
    if (dr * dr + dc * dc <= r2) return P5_SYNERGY_CLUS;
  }
  return P5_SYNERGY_ISO;
}
const isP6 = (t) => t.kind === 'gem' && t.tier === 6;
// Returns the rule-break family ('diamond'/'topaz'/'amethyst'/'sapphire'/
// 'emerald'/'ruby'/'aquamarine'/'opal') or null. Each gem family gets ONE
// signature rule-break at P6 (doc §A8). Aquamarine and Opal are no-ops until
// mutations land (Phase D).
const p6Family = (t) => (isP6(t) ? t.gemType : null);

// ─── Endless layer — modes, milestones, mutations (Phase D / doc §A6/§A9) ────
// Milestones: every W25 from W100 add cumulative ±5% speed/armor in alternating
// pattern (W100 +5% armor, W125 +5% speed, W150 +5% armor, ...). Applied at
// enemy spawn (doc §57).
function milestoneMults(wave) {
  if (wave < 100) return { speed: 1, armor: 1 };
  const steps = Math.floor((wave - 100) / 25) + 1;
  let speed = 1, armor = 1;
  for (let i = 1; i <= steps; i++) {
    if (i % 2 === 1) armor *= 1.05;
    else speed *= 1.05;
  }
  return { speed, armor };
}

// Mutations: 8-strong pool, activate W75 (doc §A6 / §56). One per wave W75-149,
// two W150+. Deterministic per (matchSeed, wave) so multi-player sees the same.
const MUTATION_POOL = [
  'ArmorBloom', 'SpeedSurge', 'RegenWaves', 'ResistShifts',           // §A.1a stat
  'SplitEvolution', 'ShieldRotations', 'FogOfWarLanes', 'EliteSpawns', // §A.1b harder
];
// Deterministic PRNG seeded by (matchSeed, wave).
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function mutationsForWave(matchSeed, wave) {
  if (wave < 75) return [];
  const n = wave >= 150 ? 2 : 1;
  const rng = mulberry32((matchSeed >>> 0) ^ (wave * 2654435761 >>> 0));
  const picked = [];
  const pool = MUTATION_POOL.slice();
  while (picked.length < n && pool.length) {
    const idx = Math.floor(rng() * pool.length);
    picked.push(pool.splice(idx, 1)[0]);
  }
  return picked;
}
// Tunables (doc §56.4 verbatim).
const MUT_ARMOR_BLOOM_PER     = 5;     // +5 armor every 10s, cap 12 stacks
const MUT_ARMOR_BLOOM_PERIOD  = 10;
const MUT_ARMOR_BLOOM_MAX     = 12;
const MUT_SPEED_SURGE_PERIOD  = 6;     // sine cycle seconds
const MUT_REGEN_IDLE          = 3;     // seconds since last damage before regen
const MUT_REGEN_FRACTION      = 0.02;  // 2% hpMax/s
const MUT_RESIST_FLIP_PERIOD  = 8;     // seconds between Magic↔Physical
const MUT_RESIST_VALUE        = 0.70;  // capped at the cap anyway
const MUT_SPLIT_CHANCE        = 0.06;  // 6% per hit, max 1 split per enemy
const MUT_SHIELD_PERIOD       = 8;     // seconds per immune-type rotation
const MUT_ELITE_FRACTION      = 0.20;  // 20% promoted at spawn
const MUT_ELITE_HP            = 1.50;
const MUT_ELITE_SPEED         = 1.20;
const MUT_ELITE_ARMOR         = 5;

// ─── Boss signatures (Phase F / doc §57.3 / §A13) ───────────────────────────
// One signature per boss variant. Replaces the V3 multi-mechanic boss model.
// Mapped to mobile's bossVariant identities.
const CORE_BOSS_SIGNATURES = {
  demon:     'HoundSprint',       // W10 — Iron Prism Hound
  void:      'JudgmentSlam',      // W20 — Forgeback Behemoth
  blood:     'SkyCourtAdds',      // W30 — Astra Carpet Tyrant
  destroyer: 'InvisibilityPulse', // W40 — Stormglass Ghost
  ender:     'PhaseShields',      // W50 — Worldheart Hatchling
};

// Endless boss roster — 20 total, cycled on boss waves W60+. User-delivered
// art for the first 12; slots 13-20 are placeholders that reuse earlier roster
// entries until art lands. Boss-wave index n at W=10n picks roster[(n-6) % 20].
// Each entry has: id (variant key for signature lookup), name (banner), color
// (future tint), signature (one of 5 mechanics), skin (current SVG renderer
// fallback among demon/void/blood/destroyer/ender until per-roster art ships).
const BOSS_ROSTER = [
  { id: 'wraith_captain',  name: 'Wraith Captain',  color: '#b08bff', signature: 'InvisibilityPulse', skin: 'void' },
  { id: 'eye_magus',       name: 'Eye Magus',       color: '#a86bff', signature: 'JudgmentSlam',      skin: 'void' },
  { id: 'lava_lord',       name: 'Lava Lord',       color: '#ff8a4d', signature: 'HoundSprint',       skin: 'destroyer' },
  { id: 'ice_lich',        name: 'Ice Lich King',   color: '#88ddff', signature: 'PhaseShields',      skin: 'ender' },
  { id: 'crystal_dragon',  name: 'Crystal Dragon',  color: '#d9b3ff', signature: 'InvisibilityPulse', skin: 'demon' },
  { id: 'lava_scorpion',   name: 'Lava Scorpion',   color: '#ff6b3d', signature: 'HoundSprint',       skin: 'destroyer' },
  { id: 'plague_ogre',     name: 'Plague Ogre',     color: '#a8c93a', signature: 'SkyCourtAdds',      skin: 'blood' },
  { id: 'forest_treant',   name: 'Forest Treant',   color: '#5cf28a', signature: 'SkyCourtAdds',      skin: 'blood' },
  { id: 'lava_cerberus',   name: 'Lava Cerberus',   color: '#ff4d2d', signature: 'HoundSprint',       skin: 'destroyer' },
  { id: 'eldritch_horror', name: 'Eldritch Horror', color: '#5ce8c0', signature: 'InvisibilityPulse', skin: 'void' },
  { id: 'demon_warlord',   name: 'Demon Warlord',   color: '#ff2244', signature: 'JudgmentSlam',      skin: 'blood' },
  { id: 'crystal_serpent', name: 'Crystal Serpent', color: '#9b66ff', signature: 'PhaseShields',      skin: 'ender' },
];
// Pad to 20 by reusing entries until art lands (deterministic order: indices
// 0,5,10,1,6,11,2,7 picked to space the visual repeat as far as possible).
while (BOSS_ROSTER.length < 20) {
  const pickOrder = [0, 5, 10, 1, 6, 11, 2, 7];
  BOSS_ROSTER.push({ ...BOSS_ROSTER[pickOrder[BOSS_ROSTER.length - 12]], _placeholder: true });
}
function endlessBossEntry(wave) {
  if (wave < 60 || wave % 10 !== 0) return null;
  return BOSS_ROSTER[(Math.floor(wave / 10) - 6) % BOSS_ROSTER.length];
}
// Combined lookup — core variants by skin name, endless by roster id.
const BOSS_SIGNATURES = {
  ...CORE_BOSS_SIGNATURES,
  ...Object.fromEntries(BOSS_ROSTER.map((b) => [b.id, b.signature])),
};

// Apply EliteSpawns + ResistShifts initial state etc. at spawn (called from
// the spawn-from-queue block). Mutates the enemy in place.
function applyMutationsOnSpawn(enemy, mutations, rng) {
  if (mutations.includes('EliteSpawns') && (enemy.type !== 'boss' && enemy.type !== 'mega') && rng() < MUT_ELITE_FRACTION) {
    enemy.hp = Math.floor(enemy.hp * MUT_ELITE_HP);
    enemy.maxHp = enemy.hp;
    enemy._eliteSpeed = MUT_ELITE_SPEED;
    enemy.armor = (enemy.armor || 0) + MUT_ELITE_ARMOR;
    enemy._elite = true;
  }
  if (mutations.includes('ResistShifts')) {
    enemy._resistFlipT = 0;       // sim time of last flip
    enemy._resistState = 'magic'; // start with magic resist
    enemy.magicResist = MUT_RESIST_VALUE;
  }
  if (mutations.includes('ShieldRotations')) {
    enemy._shieldT = 0;
    enemy._shieldTypes = ['physical', 'magic', 'poison', 'burn'];
    enemy._shieldIdx = 0;
    enemy._shieldBlockType = enemy._shieldTypes[0];
  }
  if (mutations.includes('ArmorBloom')) {
    enemy._bloomStacks = 0;
    enemy._bloomNextT = MUT_ARMOR_BLOOM_PERIOD;
  }
}

// ─── Purities (canonical names) ─────────────────────────────────────────────
const TIERS = [
  { id: 1, name: 'Cracked',   short: 'P1' },
  { id: 2, name: 'Cut',       short: 'P2' },
  { id: 3, name: 'Polished',  short: 'P3' },
  { id: 4, name: 'Radiant',   short: 'P4' },
  { id: 5, name: 'Perfect',   short: 'P5' },
  { id: 6, name: 'Ascendant', short: 'P6' },
];
const tier = (n) => TIERS[n - 1];

// Sell value (gold) per purity. Doc keeps gems no-sell-for-gold in standard,
// but a small token refund makes mistakes recoverable on mobile.
const sellValue = (t) => Math.floor(5 * Math.pow(2.5, t - 1));

// ─── Roll odds by player level (extended L1–L8) ─────────────────────────────
// Each row is [P1, P2, P3, P4, P5]. P6 only via merge/recipe.
// Levels 6–8 added so late game keeps progressing — at L7+ (W25+) P1 is
// completely gone, and P5 becomes the dominant roll.
const ROLL_ODDS = [
  /* HL1   */ [1.00, 0.00, 0.00, 0.00, 0.00, 0.00],
  /* HL2   */ [0.60, 0.40, 0.00, 0.00, 0.00, 0.00],
  /* HL3   */ [0.30, 0.50, 0.20, 0.00, 0.00, 0.00],
  /* HL4   */ [0.15, 0.35, 0.35, 0.15, 0.00, 0.00],
  /* HL5   */ [0.10, 0.25, 0.30, 0.25, 0.10, 0.00],
  /* HL6+  */ [0.08, 0.20, 0.30, 0.25, 0.12, 0.05],   // doc §10: 5% natural P6 from HL6
];
function rollPurity(level) {
  const row = ROLL_ODDS[Math.min(level, 6) - 1];
  const r = Math.random();
  let cum = 0;
  for (let i = 0; i < row.length; i++) {
    cum += row[i];
    if (r < cum) return i + 1;
  }
  return 1;
}

// ─── Smart pity (V1 balance patch) ──────────────────────────────────────────
// Bad-run protection so a streak of P1/P2 doesn't soft-lock the player.
// After wave 25 with 15+ placements without P4+, force minimum P4 next roll.
// After wave 35 with 20+ placements without P5,  force minimum P5 next roll.
// Family pity: each placement increments a per-family dry-streak counter.
//   When a family hits 20 dry placements its weight doubles each subsequent
//   placement until it appears.
function rollWithPity(s) {
  if (!s.pity) {
    s.pity = {
      familyLastSeen: Object.fromEntries(GEM_IDS.map((g) => [g, 0])),
      placements: 0,
      highTierStreak: 0,
    };
  }
  s.pity.placements += 1;
  // ── Family pity weights ──
  const weights = {};
  let totalWeight = 0;
  for (const fam of GEM_IDS) {
    const dryStreak = s.pity.placements - s.pity.familyLastSeen[fam];
    let w = 1;
    if (dryStreak > 20) w = 1 + (dryStreak - 20) * 0.4;
    weights[fam] = w;
    totalWeight += w;
  }
  let r = Math.random() * totalWeight;
  let gemType = GEM_IDS[0];
  for (const fam of GEM_IDS) {
    r -= weights[fam];
    if (r < 0) { gemType = fam; break; }
  }
  s.pity.familyLastSeen[gemType] = s.pity.placements;
  // ── Tier pity ──
  let tier = rollPurity(s.playerLevel);
  if (s.wave >= 25 && s.pity.highTierStreak >= 15) tier = Math.max(tier, 4);
  if (s.wave >= 35 && s.pity.highTierStreak >= 20) tier = Math.max(tier, 5);
  if (tier >= 4) s.pity.highTierStreak = 0;
  else s.pity.highTierStreak += 1;
  return { tier, gemType };
}
// Hero level = doc §54.5 / §A16: HL = floor((W-1)/6)+1, capped at 6 (the
// ROLL_ODDS table ends at HL6+). HL6+ unlocks 5% natural P6 (doc §10).
//   HL1 W1-6 · HL2 W7-12 · HL3 W13-18 · HL4 W19-24 · HL5 W25-30 · HL6+ W31+
function levelForWave(wave) {
  return Math.min(6, Math.floor((wave - 1) / 6) + 1);
}

// ─── Economy — doc §54 (V4 §A5) CANONICAL ────────────────────────────────────
// Per-kill gold is a smooth formula across the whole game (no W50 table cliff).
//   GoldPerKill(W) = max(1, floor(W^1.15))   [doc §54.1 V3 FINAL: W^1.15]
//   Boss kill     = 5 × GoldPerKill          [doc §54.2 — NO separate lump]
//   Champion kill = 2 × GoldPerKill          [doc §54.2; champion type pending]
function killGold(wave) {
  return Math.max(1, Math.floor(Math.pow(wave, 1.15)));
}
function killGoldFor(type, wave) {
  const base = killGold(wave);
  if (type === 'boss' || type === 'mega') return base * 5;
  if (type === 'champion') return base * 2;             // doc §54.2
  return base;
}
// Killstreak ladder — doc §54.3: {1.00, 1.10, 1.18, 1.25}, cap 1.25×. Streak
// index resets on leak OR on wave clear. Anti-farm (doc): a kill counts toward
// the streak only if the enemy traveled ≥25% of its path OR was alive ≥1.5s.
// Gold is still paid for the kill — only the streak multiplier is gated.
const KILLSTREAK_LADDER     = [1.00, 1.10, 1.18, 1.25];
const KILLSTREAK_THRESHOLDS = [0,    15,   30,   50  ];   // kills required per rung
function streakMult(streak) {
  let m = KILLSTREAK_LADDER[0];
  for (let i = 0; i < KILLSTREAK_THRESHOLDS.length; i++) {
    if (streak >= KILLSTREAK_THRESHOLDS[i]) m = KILLSTREAK_LADDER[i];
  }
  return m;
}
const STREAK_MIN_PATH_FRACTION = 0.25;   // doc §54.3 KillValidation
const STREAK_MIN_ALIVE_SECONDS = 1.5;

// ─── Gold utilities — doc Section "Skill ... Cost ... Cooldown ... Effect" ──
// 13 active skills, real gold sinks (the main reason recipe P6 is 12kg — the
// player needs alternative gold spends or saves into a wall). Effects fall
// into 3 shapes: instant (Heal/GoldFlash/WaveSkip/HealOverTime), time-bounded
// (Freeze/DamageBoost/GoldBlessing/SpeedShield/CritBoost/TowerEcho/GoldRain),
// next-event (Timelapse/CandyLure).
// ─── Audio (stub infrastructure — ready for expo-av swap) ───────────────────
// All trigger points across the game call playSound(id). Currently a no-op so
// no dependency is required (keeps Snack stable). To enable real audio:
//   1. Add `expo-av` to package.json (Snack: add via Dependencies panel).
//   2. Replace the playSound stub below with:
//        const _sounds = {};
//        async function _load(id, src) {
//          const { sound } = await Audio.Sound.createAsync(src);
//          _sounds[id] = sound;
//        }
//        // call _load() for each id at app start
//        function playSound(id) {
//          if (s_audioMuted || !_sounds[id]) return;
//          _sounds[id].replayAsync();
//        }
//   3. Drop SFX files into assets/audio/ matching the SOUND_EFFECTS keys.
// No other code needs to change — every game event is already wired below.
const SOUND_EFFECTS = {
  shot:         'shot.mp3',           // tower fires (rate-limited)
  hit:          'hit.mp3',            // enemy takes damage
  kill:         'kill.mp3',           // enemy dies
  boss_spawn:   'boss_spawn.mp3',     // boss wave banner
  wave_clear:   'wave_clear.mp3',     // wave completed
  life_lost:    'life_lost.mp3',      // enemy leaks
  recipe_forge: 'recipe_forge.mp3',   // special tower crafted
  utility_cast: 'utility_cast.mp3',   // gold-utility skill cast
  victory:      'victory.mp3',        // mode complete
  defeat:       'defeat.mp3',         // 0 lives game over
};
// AsyncStorage-persisted mute (loaded at game init; default unmuted).
let _audioMuted = false;
const setAudioMuted = (v) => { _audioMuted = !!v; };
const isAudioMuted = () => _audioMuted;
// Throttle high-frequency events so shot.mp3 doesn't fire 60×/sec.
const _audioLastT = {};
function playSound(id, throttleSec = 0) {
  if (_audioMuted) return;
  if (throttleSec > 0) {
    const now = Date.now() / 1000;
    if (now - (_audioLastT[id] || 0) < throttleSec) return;
    _audioLastT[id] = now;
  }
  // Stub: no playback until expo-av is wired (see header). Intentionally silent
  // to keep the game runnable without the dependency. Replace this body with
  // the load/replayAsync calls when expo-av is in package.json.
}

const UTILITIES = [
  { id: 'GoldFlash',    name: 'Gold Flash',    cost: 200,  cd: 60,   color: '#ffd166', desc: '+500 gold instantly' },
  { id: 'Heal',         name: 'Heal',          cost: 300,  cd: 90,   color: '#ff8fab', desc: '+10 lives' },
  { id: 'Freeze',       name: 'Freeze',        cost: 600,  cd: 120,  color: '#88ddff', desc: 'Full freeze 4s' },
  { id: 'DamageBoost',  name: 'Damage Boost',  cost: 500,  cd: 90,   color: '#ff6b6b', desc: '×2 DPS for 10s' },
  { id: 'GoldBlessing', name: 'Gold Blessing', cost: 400,  cd: 90,   color: '#ffd166', desc: 'Kill gold +50% 15s' },
  { id: 'WaveSkip',     name: 'Wave Skip',     cost: 1500, cd: 300,  color: '#b08bff', desc: 'Skip next wave (rewards paid)' },
  { id: 'GoldRain',     name: 'Gold Rain',     cost: 500,  cd: 120,  color: '#ffd166', desc: '+50g/s for 15s' },
  { id: 'HealOverTime', name: 'Mend',          cost: 500,  cd: 120,  color: '#ff8fab', desc: '+1 life/wave for 5 waves' },
  { id: 'SpeedShield',  name: 'Speed Shield',  cost: 400,  cd: 75,   color: '#88ddff', desc: 'Pause enemy speed 8s' },
  { id: 'CritBoost',    name: 'Crit Boost',    cost: 700,  cd: 120,  color: '#ff6b6b', desc: 'Crit on every shot 8s' },
  { id: 'TowerEcho',    name: 'Tower Echo',    cost: 600,  cd: 100,  color: '#5cf28a', desc: 'Towers double-fire 6s' },
  { id: 'Timelapse',    name: 'Timelapse',     cost: 800,  cd: 150,  color: '#b08bff', desc: 'Spawn delay -50% next wave' },
  { id: 'CandyLure',    name: 'Candy Lure',    cost: 600,  cd: 90,   color: '#ff8fab', desc: 'Slow first 3 enemies 50% 5s' },
];
function emptyCooldowns() { const o = {}; for (const u of UTILITIES) o[u.id] = 0; return o; }
const UTIL_BY_ID = Object.fromEntries(UTILITIES.map((u) => [u.id, u]));

function castUtility(s, id) {
  const u = UTIL_BY_ID[id];
  if (!u || (s.skillCooldowns[id] || 0) > 0 || s.gold < u.cost) return false;
  s.gold -= u.cost;
  s.skillCooldowns[id] = u.cd;
  playSound('utility_cast');
  switch (id) {
    case 'GoldFlash':    s.gold += 500; break;
    case 'Heal':         s.lives += 10; break;
    case 'Freeze':       s.effectEnds.Freeze       = s.time + 4; break;
    case 'DamageBoost':  s.effectEnds.DamageBoost  = s.time + 10; break;
    case 'GoldBlessing': s.effectEnds.GoldBlessing = s.time + 15; break;
    case 'GoldRain':     s.effectEnds.GoldRain     = s.time + 15; s.goldRainAcc = 0; break;
    case 'SpeedShield':  s.effectEnds.SpeedShield  = s.time + 8; break;
    case 'CritBoost':    s.effectEnds.CritBoost    = s.time + 8; break;
    case 'TowerEcho':    s.effectEnds.TowerEcho    = s.time + 6; break;
    case 'WaveSkip':     s.pendingWaveSkip = true; break;
    case 'HealOverTime': s.healOverTimeWaves = 5; break;
    case 'Timelapse':    s.timelapseNext = true; break;
    case 'CandyLure':    s.candyLureRemaining = 3; s.effectEnds.CandyLure = s.time + 5; break;
  }
  return true;
}
const effectActive = (s, key) => (s.effectEnds[key] || 0) > s.time;

// ─── Gems (8 families) ──────────────────────────────────────────────────────
// `letter` is the on-board label prefix: first letter of the gem name, except
// Aquamarine which is Q to avoid clashing with Amethyst.
const GEMS = {
  sapphire:   { id: 'sapphire',   letter: 'S', name: 'Sapphire',   color: '#4cc9ff', ability: 'Slow / control' },
  diamond:    { id: 'diamond',    letter: 'D', name: 'Diamond',    color: '#e6f1ff', ability: 'High raw damage' },
  opal:       { id: 'opal',       letter: 'O', name: 'Opal',       color: '#ffd4f0', ability: 'Aura / reveal' },
  emerald:    { id: 'emerald',    letter: 'E', name: 'Emerald',    color: '#5cf28a', ability: 'Poison DoT' },
  amethyst:   { id: 'amethyst',   letter: 'A', name: 'Amethyst',   color: '#b08bff', ability: 'Armor break' },
  aquamarine: { id: 'aquamarine', letter: 'Q', name: 'Aquamarine', color: '#7be5d1', ability: 'Fast attack' },
  ruby:       { id: 'ruby',       letter: 'R', name: 'Ruby',       color: '#ff4d6d', ability: 'Splash' },
  topaz:      { id: 'topaz',      letter: 'T', name: 'Topaz',      color: '#ffd166', ability: 'Split shot' },
};
function gemLabel(gemType, t) {
  return `${GEMS[gemType].letter}${t}`;
}
const GEM_IDS = Object.keys(GEMS);
const rollGemType = () => GEM_IDS[Math.floor(Math.random() * GEM_IDS.length)];

// ─── Exact gem stats per purity (design doc §11) ────────────────────────────
// Ranges are converted from studs to tiles by dividing by 4 (cell = 4 studs).
const GEM_STATS = {
  sapphire: [
    { damage: 2,  range: 10,   cooldown: 1.00, slow: 0.15 },
    { damage: 4,  range: 10,   cooldown: 1.00, slow: 0.22 },
    { damage: 6,  range: 10,   cooldown: 1.00, slow: 0.30 },
    { damage: 8,  range: 10,   cooldown: 1.00, slow: 0.38 },
    { damage: 10, range: 10,   cooldown: 1.00, slow: 0.45 },
    { damage: 36, range: 10.5, cooldown: 0.60, slow: 0.65, slowSplash: true },
  ],
  diamond: [
    { damage: 5,   range: 8,   cooldown: 1.00 },
    { damage: 10,  range: 8,   cooldown: 1.00 },
    { damage: 20,  range: 8,   cooldown: 1.00 },
    { damage: 40,  range: 8,   cooldown: 1.00 },
    { damage: 80,  range: 8,   cooldown: 1.00 },
    { damage: 460, range: 8.5, cooldown: 0.70 },
  ],
  opal: [
    { damage: 1, range: 8, cooldown: 1.00, aura: 0.05 },
    { damage: 2, range: 8, cooldown: 1.00, aura: 0.08 },
    { damage: 3, range: 8, cooldown: 1.00, aura: 0.12 },
    { damage: 4, range: 8, cooldown: 1.00, aura: 0.16 },
    { damage: 5, range: 8, cooldown: 1.00, aura: 0.20 },
    { damage: 6, range: 8, cooldown: 1.00, aura: 0.25 },
  ],
  emerald: [
    { damage: 2,  range: 8, cooldown: 1.00, poison: { dps: 4,    duration: 3 } },
    { damage: 4,  range: 8, cooldown: 1.00, poison: { dps: 8,    duration: 3 } },
    { damage: 8,  range: 8, cooldown: 1.00, poison: { dps: 16,   duration: 4 } },
    { damage: 16, range: 8, cooldown: 1.00, poison: { dps: 32,   duration: 4 } },
    { damage: 32, range: 8, cooldown: 1.00, poison: { dps: 64,   duration: 5 } },
    { damage: 60, range: 8, cooldown: 1.00, poison: { dps: 220, duration: 5 } },
  ],
  amethyst: [
    { damage: 2,  range: 8, cooldown: 0.60, armorBreak: 2  },
    { damage: 4,  range: 8, cooldown: 0.60, armorBreak: 4  },
    { damage: 6,  range: 8, cooldown: 0.60, armorBreak: 8  },
    { damage: 8,  range: 8, cooldown: 0.60, armorBreak: 16 },
    { damage: 10, range: 8, cooldown: 0.60, armorBreak: 32 },
    { damage: 70, range: 8, cooldown: 0.60, armorBreak: 64 },
  ],
  aquamarine: [
    { damage: 2,  range: 7.5, cooldown: 0.65 },
    { damage: 4,  range: 7.5, cooldown: 0.60 },
    { damage: 8,  range: 7.5, cooldown: 0.55 },
    { damage: 16, range: 7.5, cooldown: 0.50 },
    { damage: 24, range: 7.5, cooldown: 0.45 },
    { damage: 80, range: 8.5, cooldown: 0.30 },
  ],
  ruby: [
    { damage: 4,   range: 8,   cooldown: 1.00, splash: 1.2 },
    { damage: 8,   range: 8,   cooldown: 1.00, splash: 1.3 },
    { damage: 12,  range: 8,   cooldown: 1.00, splash: 1.4 },
    { damage: 24,  range: 8,   cooldown: 1.00, splash: 1.5 },
    { damage: 48,  range: 8,   cooldown: 1.00, splash: 1.6 },
    { damage: 150, range: 8.5, cooldown: 1.00, splash: 2.0 },
  ],
  topaz: [
    { damage: 3,   range: 9,    cooldown: 1.30, multi: 3 },
    { damage: 6,   range: 8.5,  cooldown: 1.30, multi: 3 },
    { damage: 9,   range: 8.5,  cooldown: 1.30, multi: 3 },
    { damage: 18,  range: 8.5,  cooldown: 1.30, multi: 3 },
    { damage: 36,  range: 8.5,  cooldown: 1.30, multi: 3 },
    { damage: 200, range: 15,   cooldown: 0.60, multi: 3 },
  ],
};

function gemStats(gemId, t) {
  const stats = GEM_STATS[gemId][t - 1];
  return { ...stats, color: GEMS[gemId].color, name: GEMS[gemId].name };
}

// ─── Special tower recipes (canonical 18 from the rename doc) ────────────────
const SPECIAL_RECIPES = [
  { id: 'MoonsteelPrism', name: 'Moonsteel Prism', tier: 'P2',
    color: '#d8e1f2', accent: '#7eb6ff',
    description: 'Single-target · armor break · light slow',
    ingredients: [
      { gemType: 'sapphire', tier: 2 }, { gemType: 'diamond', tier: 2 }, { gemType: 'topaz', tier: 2 },
    ],
    stats: { damage: 80, range: 8.5, cooldown: 0.7, armorBreak: 8, slow: { factor: 0.5, duration: 1.2 } },
  },
  { id: 'VerdantArcstone', name: 'Verdant Arcstone', tier: 'P2',
    color: '#5cf28a', accent: '#88f088',
    description: 'Poison surge · support · reveal',
    ingredients: [
      { gemType: 'emerald', tier: 2 }, { gemType: 'opal', tier: 2 }, { gemType: 'aquamarine', tier: 2 },
    ],
    stats: { damage: 20, range: 8.5, cooldown: 0.55, poison: { dps: 35, duration: 4 } },
  },
  { id: 'EmberstarObelisk', name: 'Ember Obelisk', tier: 'P2',
    color: '#ff8a4d', accent: '#ffd166',
    description: 'Burning splash · area denial',
    ingredients: [
      { gemType: 'ruby', tier: 2 }, { gemType: 'amethyst', tier: 2 }, { gemType: 'aquamarine', tier: 2 },
    ],
    stats: { damage: 45, range: 8, cooldown: 0.5, splash: 1.8, poison: { dps: 18, duration: 3 } },
  },
  { id: 'RoseglassFocus', name: 'Roseglass', tier: 'P3',
    color: '#ff8aff', accent: '#ffd6ff',
    description: 'Boss killer · single-target focus',
    ingredients: [
      { gemType: 'diamond', tier: 3 }, { gemType: 'diamond', tier: 2 }, { gemType: 'topaz', tier: 2 },
    ],
    stats: { damage: 180, range: 9, cooldown: 0.9, armorBreak: 12 },
  },
  { id: 'JadeVeilLens', name: 'Jade Oracle', tier: 'P3',
    color: '#5cf28a', accent: '#88f088',
    description: 'Poison · slow · control',
    ingredients: [
      { gemType: 'emerald', tier: 3 }, { gemType: 'opal', tier: 2 }, { gemType: 'sapphire', tier: 2 },
    ],
    stats: { damage: 40, range: 9, cooldown: 0.65, slow: { factor: 0.45, duration: 1.6 } },
  },
  { id: 'StormsplitReactor', name: 'Stormsplit', tier: 'P3',
    color: '#ffd166', accent: '#fff7a8',
    description: 'Rapid chain lightning · swarm shredder',
    ingredients: [
      { gemType: 'topaz', tier: 3 }, { gemType: 'aquamarine', tier: 2 }, { gemType: 'sapphire', tier: 2 },
    ],
    stats: { damage: 35, range: 9, cooldown: 0.3, chain: 5 },
  },
  { id: 'GildedHexcore', name: 'Goldhex', tier: 'P3',
    color: '#ffd166', accent: '#b08bff',
    description: 'Armor shred · Greed Aura (2× gold)',
    ingredients: [
      { gemType: 'amethyst', tier: 3 }, { gemType: 'amethyst', tier: 2 }, { gemType: 'diamond', tier: 2 },
    ],
    stats: { damage: 90, range: 8.5, cooldown: 0.7, armorBreak: 16, goldAura: true },
  },
  { id: 'MoonsteelWarden', name: 'Silver Warden', tier: 'P4',
    color: '#c0d8ff', accent: '#fff',
    description: 'Slow / cleave · armored frontline',
    ingredients: [
      { specialId: 'MoonsteelPrism' }, { gemType: 'aquamarine', tier: 3 }, { gemType: 'ruby', tier: 3 },
    ],
    stats: { damage: 220, range: 9, cooldown: 0.6, armorBreak: 16, splash: 1.4, slow: { factor: 0.5, duration: 1.5 } },
  },
  { id: 'VerdantCascade', name: 'Seraph', tier: 'P4',
    color: '#88f088', accent: '#fff',
    description: 'Poison surge · attack speed aura',
    ingredients: [
      { specialId: 'VerdantArcstone' }, { gemType: 'emerald', tier: 3 }, { gemType: 'topaz', tier: 3 },
    ],
    stats: { damage: 60, range: 9, cooldown: 0.3, poison: { dps: 90, duration: 4 } },
  },
  { id: 'ObsidianBreaker', name: 'Obsidian Breaker', tier: 'P4',
    color: '#2a335f', accent: '#ff4d6d',
    description: 'Corruption · armor shred · % damage',
    ingredients: [
      { specialId: 'GildedHexcore' }, { gemType: 'emerald', tier: 3 }, { gemType: 'amethyst', tier: 3 },
    ],
    stats: { damage: 240, range: 9, cooldown: 0.65, armorBreak: 32, goldAura: true },
  },
  { id: 'SkyquartzSentinel', name: 'Skylar', tier: 'P4',
    color: '#cfd5e6', accent: '#7be5d1',
    description: 'Piercing shots · long range',
    ingredients: [
      { gemType: 'diamond', tier: 4 }, { gemType: 'amethyst', tier: 3 }, { gemType: 'sapphire', tier: 3 },
    ],
    stats: { damage: 480, range: 11, cooldown: 0.85, armorBreak: 16, chain: 3 },
  },
  { id: 'RoyalRoseglass', name: 'Monarch', tier: 'P5',
    color: '#ffafff', accent: '#fff',
    description: 'Divine light · purifies · true damage',
    ingredients: [
      { specialId: 'RoseglassFocus' }, { specialId: 'MoonsteelWarden' }, { gemType: 'diamond', tier: 4 },
    ],
    stats: { damage: 900, range: 10, cooldown: 0.85, armorBreak: 24, splash: 1.5 },
  },
  { id: 'CrimsonThunderheart', name: 'Thunderheart', tier: 'P5',
    color: '#ff4d6d', accent: '#ffd166',
    description: 'Massive area damage · burning storm',
    ingredients: [
      { specialId: 'EmberstarObelisk' }, { gemType: 'ruby', tier: 4 }, { gemType: 'aquamarine', tier: 4 },
    ],
    stats: { damage: 220, range: 9, cooldown: 0.5, splash: 2.2, chain: 4, poison: { dps: 70, duration: 4 } },
  },
  { id: 'CoralResonance', name: 'Coral Resonance', tier: 'P5',
    color: '#7be5d1', accent: '#5cf28a',
    description: 'Harmony · multi-target · slow',
    ingredients: [
      { specialId: 'JadeVeilLens' }, { gemType: 'opal', tier: 4 }, { gemType: 'aquamarine', tier: 4 },
    ],
    stats: { damage: 180, range: 9.5, cooldown: 0.3, multi: 3, slow: { factor: 0.35, duration: 1.8 } },
  },
  { id: 'FrostsunEye', name: 'Eye of the Frozen Sun', tier: 'P5',
    color: '#a8e0ff', accent: '#ffd166',
    description: 'Protector · chain · slow · versatile',
    ingredients: [
      { specialId: 'StormsplitReactor' }, { gemType: 'sapphire', tier: 4 }, { gemType: 'ruby', tier: 4 },
    ],
    stats: { damage: 240, range: 10, cooldown: 0.4, chain: 6, slow: { factor: 0.5, duration: 2 } },
  },
  { id: 'SovereignDiamondLens', name: 'Sovereign Diamond', tier: 'P6',
    color: '#fff', accent: '#ffd166',
    description: 'MYTHIC · timeless guardian · time control',
    ingredients: [
      { specialId: 'RoyalRoseglass' }, { gemType: 'diamond', tier: 6 }, { gemType: 'amethyst', tier: 5 },
    ],
    stats: { damage: 2400, range: 10.5, cooldown: 0.7, armorBreak: 48, splash: 1.8, slow: { factor: 0.3, duration: 2 } },
  },
  { id: 'PrismaticWorldcore', name: 'Core of the World', tier: 'P6',
    color: '#b08bff', accent: '#7be5d1',
    description: 'MYTHIC · global · void explosions',
    ingredients: [
      { specialId: 'CoralResonance' }, { gemType: 'opal', tier: 6 }, { gemType: 'aquamarine', tier: 5 }, { gemType: 'topaz', tier: 5 },
    ],
    stats: { damage: 800, range: 11, cooldown: 0.3, multi: 5, splash: 2.0 },
  },
  { id: 'AbyssbreakerMonolith', name: 'Luna', tier: 'P6',
    color: '#1a0033', accent: '#b08bff',
    description: 'MYTHIC · divine execution · judgement beam',
    ingredients: [
      { specialId: 'CrimsonThunderheart' }, { specialId: 'ObsidianBreaker' }, { gemType: 'ruby', tier: 6 },
    ],
    stats: { damage: 1800, range: 11.5, cooldown: 0.55, armorBreak: 32, splash: 2.4, poison: { dps: 600, duration: 5 } },
  },
];
const SPECIAL_BY_ID = Object.fromEntries(SPECIAL_RECIPES.map((r) => [r.id, r]));

// ─── Asset pipeline (G1 foundation) ─────────────────────────────────────────
// Snack-safe: these are optional remote Image sources, not local require()s.
// That means App.js can be copied into Expo Snack without uploading the assets
// folder. If sprite switches are enabled in Snack, the GitHub raw asset URLs
// must be public; private repos return 404 to Expo, and RemoteSprite falls back
// to SVG. For App Store offline builds, this can later move back to bundled
// require() assets.
const RAW_ASSET_BASE =
  'https://github.com/usmanmomid/Test/raw/refs/heads/claude/mobile-game-development-PjMjg/';
const remoteAsset = (path) => ({ uri: encodeURI(RAW_ASSET_BASE + path) });
const ASSET_MAP = {
  towers: {
    MoonsteelPrism:        remoteAsset('assets/runtime/towers/special_01.png'),
    VerdantArcstone:       remoteAsset('assets/runtime/towers/special_02.png'),
    EmberstarObelisk:      remoteAsset('assets/runtime/towers/special_03.png'),
    RoseglassFocus:        remoteAsset('assets/runtime/towers/special_04.png'),
    JadeVeilLens:          remoteAsset('assets/runtime/towers/special_05.png'),
    StormsplitReactor:     remoteAsset('assets/runtime/towers/special_06.png'),
    GildedHexcore:         remoteAsset('assets/runtime/towers/special_07.png'),
    MoonsteelWarden:       remoteAsset('assets/runtime/towers/special_08.png'),
    VerdantCascade:        remoteAsset('assets/runtime/towers/special_09.png'),
    ObsidianBreaker:       remoteAsset('assets/runtime/towers/special_10.png'),
    SkyquartzSentinel:     remoteAsset('assets/runtime/towers/special_11.png'),
    RoyalRoseglass:        remoteAsset('assets/runtime/towers/special_12.png'),
    CrimsonThunderheart:   remoteAsset('assets/runtime/towers/special_13.png'),
    CoralResonance:        remoteAsset('assets/runtime/towers/special_14.png'),
    FrostsunEye:           remoteAsset('assets/runtime/towers/special_15.png'),
    SovereignDiamondLens:  remoteAsset('assets/runtime/towers/special_16.png'),
    PrismaticWorldcore:    remoteAsset('assets/runtime/towers/special_17.png'),
    AbyssbreakerMonolith:  remoteAsset('assets/runtime/towers/special_18.png'),
  },
  bosses: {
    demon:            remoteAsset('assets/runtime/bosses/boss_01_pirate_king.png'),
    void:             remoteAsset('assets/runtime/bosses/boss_02_void_monarch.png'),
    destroyer:        remoteAsset('assets/runtime/bosses/boss_03_hellforge_brute.png'),
    ender:            remoteAsset('assets/runtime/bosses/boss_04_frost_lich.png'),
    blood:            remoteAsset('assets/runtime/bosses/boss_12_medusa.png'),
    colossus:         remoteAsset('assets/runtime/bosses/boss_11_maze_bull.png'),
    'ender-mega':     remoteAsset('assets/runtime/bosses/boss_11_maze_bull.png'),
    wraith_captain:   remoteAsset('assets/runtime/bosses/boss_01_pirate_king.png'),
    eye_magus:        remoteAsset('assets/runtime/bosses/boss_02_void_monarch.png'),
    lava_lord:        remoteAsset('assets/runtime/bosses/boss_03_hellforge_brute.png'),
    ice_lich:         remoteAsset('assets/runtime/bosses/boss_04_frost_lich.png'),
    crystal_dragon:   remoteAsset('assets/runtime/bosses/boss_05_storm_crawler.png'),
    lava_scorpion:    remoteAsset('assets/runtime/bosses/boss_06_ogre_king.png'),
    plague_ogre:      remoteAsset('assets/runtime/bosses/boss_07_roots.png'),
    forest_treant:    remoteAsset('assets/runtime/bosses/boss_08_ashfang.png'),
    lava_cerberus:    remoteAsset('assets/runtime/bosses/boss_09_kraken.png'),
    eldritch_horror:  remoteAsset('assets/runtime/bosses/boss_10_scorpion_king.png'),
    demon_warlord:    remoteAsset('assets/runtime/bosses/boss_11_maze_bull.png'),
    crystal_serpent:  remoteAsset('assets/runtime/bosses/boss_12_medusa.png'),
  },
  decor: {
    spawn_portal:     remoteAsset('assets/runtime/decor/spawn_portal.png'),
    castle_keep:      remoteAsset('assets/runtime/decor/central_crystal.png'),
    crystal_monument: remoteAsset('assets/runtime/decor/central_crystal.png'),
    recipe_master:    remoteAsset('assets/runtime/decor/recipe_master.png'),
    maze_background:  remoteAsset('assets/runtime/decor/maze_background.png'),
  },
};
// Master switch — flip to true when sprite-art quality > current SVG quality.
// Placeholder mode keeps SVG on so you don't see ring-icons until real PNGs
// land. Per-category overrides below.
const USE_SPRITES = {
  towers: false,   // FALSE while repo is private — raw URLs return 404 on Snack/Expo Go
  bosses: false,   // and the failed requests freeze Connecting. Flip back to true
  decor:  false,   // once the repo is public OR sprites are bundled via require().
};

function RemoteSprite({ source, style, children, onLoad, resizeMode = 'contain' }) {
  const [failed, setFailed] = useState(false);
  if (!source || failed) return children || null;
  return (
    <Image
      source={source}
      style={style}
      resizeMode={resizeMode}
      onLoad={onLoad}
      onError={() => setFailed(true)}
    />
  );
}

// Recipe gold cost per tier — doc §67 V5 lock (LIVE 2026-05-22, unchanged V5).
// P6 12k forces a real economy choice; with the W^1.15 gold formula a single
// P6 = ~all gold earned through W25.
const RECIPE_GOLD_COST = { P2: 250, P3: 500, P4: 1200, P5: 3000, P6: 12000 };
const recipeGoldCost = (recipe) => RECIPE_GOLD_COST[recipe.tier] || 0;

function matchesIngredient(tower, ing) {
  if (ing.specialId) return tower.kind === 'special' && tower.specialId === ing.specialId;
  return tower.kind === 'gem' && tower.gemType === ing.gemType && tower.tier === ing.tier;
}

function findRecipeMatch(anchor, allTowers, recipe) {
  if (anchor.kind !== 'gem' && anchor.kind !== 'special') return null;
  const remaining = recipe.ingredients.slice();
  const anchorIdx = remaining.findIndex((ing) => matchesIngredient(anchor, ing));
  if (anchorIdx === -1) return null;
  remaining.splice(anchorIdx, 1);
  const usedIds = new Set([anchor.id]);
  const matched = [];
  for (const ing of remaining) {
    const m = allTowers.find((t) => !usedIds.has(t.id) && matchesIngredient(t, ing));
    if (!m) return null;
    usedIds.add(m.id);
    matched.push(m);
  }
  return matched;
}

function findChainMergeMatch(anchor, allTowers) {
  if (!anchor || anchor.kind !== 'gem' || anchor.tier + 2 > 6) return null;
  const used = new Set([anchor.id]);
  const same = allTowers.find((t) =>
    !used.has(t.id) &&
    t.kind === 'gem' &&
    t.gemType === anchor.gemType &&
    t.tier === anchor.tier
  );
  if (!same) return null;
  used.add(same.id);
  const next = allTowers.find((t) =>
    !used.has(t.id) &&
    t.kind === 'gem' &&
    t.gemType === anchor.gemType &&
    t.tier === anchor.tier + 1
  );
  if (!next) return null;
  return [same, next];
}

const TARGET_MODES = [
  { id: 'First', name: 'First' },
  { id: 'Last', name: 'Last' },
  { id: 'Close', name: 'Close' },
  { id: 'Strong', name: 'Strong' },
  { id: 'Weak', name: 'Weak' },
  { id: 'Most', name: 'Most' },
  { id: 'Least', name: 'Least' },
  { id: 'ManualTarget', name: 'Manual' },
];
const TARGET_MODE_IDS = new Set(TARGET_MODES.map((m) => m.id));
const DEFAULT_TARGET_MODE = 'First';

function targetModeLabel(mode) {
  return TARGET_MODES.find((m) => m.id === mode)?.name || TARGET_MODES[0].name;
}

function sortTargetsForTower(tower, inRange, stats) {
  const mode = TARGET_MODE_IDS.has(tower.targetMode) ? tower.targetMode : DEFAULT_TARGET_MODE;
  const pathFrac = (e) => e.subPath && e.subPath.length ? e.pathIdx / e.subPath.length : 0;
  const clustered = (enemy) => {
    const radius = Math.max(1.8, stats?.splash || 0);
    let n = 0;
    for (const { e } of inRange) {
      if (e.hp > 0 && Math.hypot(e.r - enemy.r, e.c - enemy.c) <= radius) n += 1;
    }
    return n;
  };
  if (mode === 'ManualTarget') {
    const locked = inRange.find((x) => x.e.id === tower.manualTargetId);
    if (locked) return [locked, ...inRange.filter((x) => x !== locked)];
  }
  const sorted = [...inRange];
  sorted.sort((a, b) => {
    if (mode === 'Last') return pathFrac(a.e) - pathFrac(b.e);
    if (mode === 'Close') return a.d - b.d;
    if (mode === 'Strong') return b.e.hp - a.e.hp;
    if (mode === 'Weak') return a.e.hp - b.e.hp;
    if (mode === 'Most') return clustered(b.e) - clustered(a.e) || b.e.hp - a.e.hp;
    if (mode === 'Least') return clustered(a.e) - clustered(b.e) || a.e.hp - b.e.hp;
    return pathFrac(b.e) - pathFrac(a.e); // First: closest to castle/exit.
  });
  return sorted;
}

function recipeCodeLabel(recipe) {
  return recipe.ingredients.map(ingredientLabel).join(' + ');
}

function findBoardActions(towers, gold = 0) {
  const board = towers.filter((t) => t.kind === 'gem' || t.kind === 'special');
  const actions = [];
  for (const gemType of GEM_IDS) {
    for (let purity = 1; purity <= 6; purity++) {
      const group = board.filter((t) => t.kind === 'gem' && t.gemType === gemType && t.tier === purity);
      if (group.length >= 2 && purity + 1 <= 6) {
        actions.push({
          signature: `M:+1:${gemType}:${purity}`,
          kind: 'merge',
          plus: 1,
          ids: group.slice(0, 2).map((t) => t.id),
          anchorId: group[0].id,
          result: { kind: 'gem', gemType, tier: purity + 1 },
          label: `${gemLabel(gemType, purity)} + ${gemLabel(gemType, purity)} = ${gemLabel(gemType, purity + 1)}`,
          affordable: true,
          cost: 0,
        });
      }
      if (group.length >= 4 && purity + 2 <= 6) {
        actions.push({
          signature: `M:+2:${gemType}:${purity}`,
          kind: 'merge',
          plus: 2,
          ids: group.slice(0, 4).map((t) => t.id),
          anchorId: group[0].id,
          result: { kind: 'gem', gemType, tier: purity + 2 },
          label: `${gemLabel(gemType, purity)} + ${gemLabel(gemType, purity)} + ${gemLabel(gemType, purity)} + ${gemLabel(gemType, purity)} = ${gemLabel(gemType, purity + 2)}`,
          affordable: true,
          cost: 0,
        });
      }
      if (group.length >= 2 && purity + 2 <= 6) {
        const next = board.find((t) => t.kind === 'gem' && t.gemType === gemType && t.tier === purity + 1);
        if (next) {
          actions.push({
            signature: `M:chain:${gemType}:${purity}`,
            kind: 'chain',
            ids: [next.id, group[0].id, group[1].id],
            anchorId: next.id,
            result: { kind: 'gem', gemType, tier: purity + 2 },
            label: `${gemLabel(gemType, purity)} + ${gemLabel(gemType, purity)} + ${gemLabel(gemType, purity + 1)} = ${gemLabel(gemType, purity + 2)}`,
            affordable: true,
            cost: 0,
          });
        }
      }
    }
  }
  for (const recipe of SPECIAL_RECIPES) {
    for (const anchor of board) {
      const others = findRecipeMatch(anchor, board, recipe);
      if (!others) continue;
      const cost = recipeGoldCost(recipe);
      actions.push({
        signature: `R:${recipe.id}`,
        kind: 'recipe',
        ids: [anchor.id, ...others.map((t) => t.id)],
        anchorId: anchor.id,
        result: { kind: 'special', specialId: recipe.id },
        label: `${recipeCodeLabel(recipe)} = ${recipe.name}`,
        affordable: gold >= cost,
        cost,
      });
      break;
    }
  }
  return actions.slice(0, 8);
}

function ingredientLabel(ing) {
  if (ing.specialId) return SPECIAL_BY_ID[ing.specialId]?.name || ing.specialId;
  return `${GEMS[ing.gemType].name} ${tier(ing.tier).short}`;
}

// ─── Enemies ─────────────────────────────────────────────────────────────────
// HP is NOT stored here — it comes from computeEnemyHP(type, wave, diff) via the
// single curve (BASE_HP × growth × coef × ramp × chaos × difficulty). This table
// holds only the non-HP identity: speed (tiles/s), gold, colour, size, armor,
// flying. (P5 — removes the stale per-type hp numbers to kill drift.)
const ENEMIES = {
  grunt:    { speed: 1.4, gold: 1, color: '#c4b9ff', size: 0.55, armor: 0, flying: false },
  runner:   { speed: 2.8, gold: 1, color: '#ffd166', size: 0.45, armor: 0, flying: false },
  tank:     { speed: 0.8, gold: 2, color: '#7d8aa8', size: 0.7,  armor: 4, flying: false },
  swarm:    { speed: 2.2, gold: 1, color: '#ff8fab', size: 0.4,  armor: 0, flying: false },
  flyer:    { speed: 2.0, gold: 1, color: '#88f088', size: 0.5,  armor: 1, flying: true  },
  // Champion — doc §A3 / EliteSpawns: gold-tinted elite mob, 1.4× HP & 2× gold.
  // Spawns via mutation EliteSpawns (Phase D) or hand-placed in late waves.
  champion: { speed: 1.2, gold: 4, color: '#ffd166', size: 0.65, armor: 2, flying: false },
  boss:     { speed: 1.0, gold: 6, color: '#ff4d6d', size: 0.9,  armor: 5, flying: false },
  mega:     { speed: 1.0, gold: 30, color: '#ff2244', size: 1.1, armor: 9, flying: false },
};

const WAVE_ABILITY_LABELS = {
  vitality: 'Vitality',
  hidden: 'Hidden',
  evasion: 'Evasion',
  magicResist: 'Magic Resist',
  physicalResist: 'Physical Resist',
  highArmor: 'High Armor',
  reactiveArmor: 'Reactive Armor',
  disarmAura: 'Disarm Aura',
  blink: 'Blink',
  rush: 'Rush',
  recharge: 'Recharge',
  krakenShell: 'Kraken Shell',
  shield: 'Refraction',
  flying: 'Flying',
};

const sp = (type, count, gap, mods = [], opts = {}) => ({ type, count, gap, mods, ...opts });
const spawnType = (entry) => Array.isArray(entry) ? entry[0] : entry.type;
const spawnCount = (entry) => Array.isArray(entry) ? entry[1] : entry.count;
const spawnGap = (entry) => Array.isArray(entry) ? entry[2] : entry.gap;
const spawnMods = (entry) => Array.isArray(entry) ? [] : (entry.mods || []);
const isBossSpawn = (entry) => {
  const type = spawnType(entry);
  return type === 'boss' || type === 'mega';
};

const WAVE_ROSTER = [
  { name: 'Glimmer Mites', lesson: 'Basic movement lesson', spawns: [sp('grunt', 20, 0.55)] },
  { name: 'Shard Sprinters', lesson: 'Speed pressure', spawns: [sp('runner', 22, 0.42, ['rush'])] },
  { name: 'Stoneback Yaks', lesson: 'Armor lesson', spawns: [sp('tank', 24, 0.62, ['highArmor'], { armor: 3 })] },
  { name: 'Clockwork Runners', lesson: 'Fast path punishment', spawns: [sp('runner', 24, 0.34, ['rush'], { armor: 1 })] },
  { name: 'Skyglass Wisps', lesson: 'First flying route check', spawns: [sp('flyer', 22, 0.48, ['flying'])], trial: 'AERIAL' },
  { name: 'Moss Stumps', lesson: 'Early DPS check', spawns: [sp('tank', 24, 0.68, ['vitality'], { armor: 2 })] },
  { name: 'Emerald Lizards', lesson: 'Sustain and poison value', spawns: [sp('grunt', 24, 0.52, ['recharge'], { armor: 1 })] },
  { name: 'Veil Spiders', lesson: 'Reveal/support lesson', spawns: [sp('swarm', 26, 0.36, ['hidden'])] },
  { name: 'Duskmask Foxes', lesson: 'Anti-evasion preparation', spawns: [sp('runner', 26, 0.43, ['evasion'])] },
  { name: 'Iron Prism Hound', lesson: 'First boss', spawns: [sp('boss', 1, 0.5, [], { bossVariant: 'demon', bossName: 'IRON PRISM HOUND' })] },
  { name: 'Cloud Sheep', lesson: 'Armor escalation', spawns: [sp('tank', 28, 0.62, ['highArmor'], { armor: 4 })] },
  { name: 'Laughing Alpacas', lesson: 'Tower-disarm pressure', spawns: [sp('grunt', 28, 0.5, ['disarmAura'], { armor: 1 })] },
  { name: 'Rose Boars', lesson: 'Midgame HP baseline', spawns: [sp('tank', 30, 0.54, ['vitality'], { armor: 2 })] },
  { name: 'Bulwark Dogs', lesson: 'Shield-breaking lesson', spawns: [sp('tank', 30, 0.54, ['shield', 'highArmor'], { armor: 4 })] },
  { name: 'Bamboo Gliders', lesson: 'Flying mixed HP', spawns: [sp('flyer', 30, 0.46, ['flying', 'vitality'], { armor: 1 })], trial: 'AERIAL' },
  { name: 'Young Rift Demons', lesson: 'Damage-type lesson', spawns: [sp('runner', 32, 0.42, ['magicResist'], { armor: 2 })] },
  { name: 'Belted Storm Chickens', lesson: 'Observed midgame gold point', spawns: [sp('runner', 32, 0.43, ['evasion'], { armor: 1 })] },
  { name: 'Night Boars', lesson: 'Reveal plus control', spawns: [sp('grunt', 32, 0.48, ['hidden', 'disarmAura'], { armor: 2 })] },
  { name: 'Rabbit-Donkey Rush', lesson: 'Burst speed turns', spawns: [sp('runner', 34, 0.32, ['rush'], { armor: 2 })] },
  { name: 'Forgeback Behemoth', lesson: 'Second boss', spawns: [sp('boss', 1, 0.5, [], { bossVariant: 'void', bossName: 'FORGEBACK BEHEMOTH' })] },
  { name: 'Crabs and Rippers', lesson: 'Sustained HP wave', spawns: [sp('tank', 34, 0.58, ['vitality'], { armor: 4 })] },
  { name: 'Lockjaw Beetles', lesson: 'High armor counter', spawns: [sp('tank', 34, 0.58, ['highArmor'], { armor: 20 })] },
  { name: 'Crystal Jaw Twins', lesson: 'Magic damage check', spawns: [sp('tank', 36, 0.5, ['physicalResist', 'shield'], { armor: 2 })] },
  { name: 'Reactive Donkeys', lesson: 'Punishes weak rapid hits', spawns: [sp('runner', 36, 0.45, ['reactiveArmor'], { armor: 5 })] },
  { name: 'Corsair Drifters', lesson: 'Anti-air armor test', spawns: [sp('flyer', 36, 0.44, ['flying', 'highArmor'], { armor: 18 })], trial: 'AERIAL' },
  { name: 'Skateflame Birds', lesson: 'Physical damage check', spawns: [sp('runner', 38, 0.38, ['magicResist'], { armor: 2 })] },
  { name: 'Goldfish Phantoms', lesson: 'Flying special stack', spawns: [sp('flyer', 38, 0.42, ['flying', 'hidden', 'evasion'], { armor: 1 })] },
  { name: 'Dragonfly Machinists', lesson: 'Anti-air reactive armor', spawns: [sp('flyer', 38, 0.43, ['flying', 'reactiveArmor'], { armor: 8 })] },
  { name: 'Violet Fox Fleet', lesson: 'Late mixed defense', spawns: [sp('flyer', 40, 0.38, ['flying', 'evasion', 'shield'], { armor: 2 })] },
  { name: 'Astra Carpet Tyrant', lesson: 'Third boss; flying', spawns: [sp('boss', 1, 0.5, ['flying'], { bossVariant: 'blood', bossName: 'ASTRA CARPET TYRANT' })] },
  { name: 'Bookwyrm Guards', lesson: 'Rotating immunity', spawns: [sp('tank', 40, 0.5, ['physicalResist', 'shield'], { armor: 4 })] },
  { name: 'Recharge Sharks', lesson: 'Regeneration/recharge', spawns: [sp('tank', 40, 0.5, ['recharge'], { armor: 4 })] },
  { name: 'Ribbon Zombies', lesson: 'Blink and magic check', spawns: [sp('runner', 42, 0.4, ['physicalResist', 'blink'], { armor: 2 })] },
  { name: 'Bloodwing Younglings', lesson: 'Flying evasion pressure', spawns: [sp('flyer', 42, 0.38, ['flying', 'evasion', 'disarmAura'], { armor: 2 })] },
  { name: 'Twin Moon Foxes', lesson: 'Damage-type air check', spawns: [sp('flyer', 42, 0.38, ['flying', 'magicResist', 'physicalResist'], { armor: 3 })], trial: 'AERIAL' },
  { name: 'Jade Jumo', lesson: 'Late immunity control', spawns: [sp('tank', 44, 0.48, ['magicResist'], { armor: 3 })] },
  { name: 'Blink Bears', lesson: 'Path-targeting stress', spawns: [sp('tank', 44, 0.45, ['blink'], { armor: 4 })] },
  { name: 'Nova Sprites', lesson: 'Reveal and sustain', spawns: [sp('grunt', 44, 0.42, ['hidden', 'vitality'], { armor: 3 })] },
  { name: 'Kraken Newts', lesson: 'Status cleanse counter', spawns: [sp('flyer', 46, 0.36, ['flying', 'krakenShell'], { armor: 5 })] },
  { name: 'Stormglass Ghost', lesson: 'Fourth boss; cleanse', spawns: [sp('boss', 1, 0.5, ['flying', 'krakenShell'], { bossVariant: 'destroyer', bossName: 'STORMGLASS GHOST' })] },
  { name: 'Azure Dragons', lesson: 'Shield late wave', spawns: [sp('tank', 46, 0.42, ['shield'], { armor: 6 })] },
  { name: 'Kupu Fliers', lesson: 'Air rush immunity', spawns: [sp('flyer', 46, 0.34, ['flying', 'magicResist', 'rush'], { armor: 3 })] },
  { name: 'Furry Reef Fish', lesson: 'Stacked late mechanics', spawns: [sp('swarm', 48, 0.28, ['hidden', 'evasion', 'recharge'], { armor: 4 })] },
  { name: 'Shroom Golems', lesson: 'Late blink immunity', spawns: [sp('tank', 48, 0.42, ['magicResist', 'blink'], { armor: 6 })] },
  { name: 'Chirpy Icebirds', lesson: 'Anti-air disarm', spawns: [sp('flyer', 48, 0.34, ['flying', 'disarmAura'], { armor: 3 })], trial: 'AERIAL' },
  { name: 'Boulder Boofs', lesson: 'Magic-only pressure', spawns: [sp('tank', 50, 0.4, ['physicalResist'], { armor: 8 })] },
  { name: 'Crummy Riftlings', lesson: 'Final mixed rush', spawns: [sp('runner', 50, 0.3, ['magicResist', 'evasion', 'rush'], { armor: 5 })] },
  { name: 'Wabbit Phantoms', lesson: 'Final air control', spawns: [sp('flyer', 50, 0.32, ['flying', 'magicResist', 'disarmAura', 'evasion'], { armor: 4 })] },
  { name: 'Drodo Shellbacks', lesson: 'Pre-final cleanse', spawns: [sp('tank', 52, 0.38, ['krakenShell', 'recharge', 'highArmor'], { armor: 8 })] },
  { name: 'Worldheart Hatchling', lesson: 'Final boss', spawns: [sp('mega', 1, 0.5, ['flying', 'krakenShell', 'shield'], { bossVariant: 'ender-mega', bossName: 'WORLDHEART HATCHLING' })] },
];

// ─── Wave generator (50 waves) ───────────────────────────────────────────────
// W1-W50 uses the named FINAL_VERIFIED roster. V4/V5 still own HP, difficulty,
// boss-only waves, and resistance rules; the roster supplies count, pacing, and
// ability flags.
function buildWaves() {
  return WAVE_ROSTER.slice(0, NUM_WAVES).map((w) => ({ ...w, spawns: w.spawns.map((x) => ({ ...x, mods: [...(x.mods || [])] })) }));
}
const WAVES = buildWaves();

// Lazy wave lookup — W1-50 are the curated table, W51+ generate procedurally
// for Endless mode (doc §A2 70/20/10 composition, count capped at 30 by §44).
// Boss waves every 10, trial waves on the 5-offset, regular otherwise.
function getWave(w) {
  if (w >= 1 && w <= 50 && WAVES[w - 1]) return WAVES[w - 1];
  if (w % 10 === 0) {
    const bossCount = Math.min(8, 2 + Math.floor((w - 50) / 30));
    const megaCount = Math.min(4, 1 + Math.floor((w - 50) / 50));
    return { name: 'Endless Rift Lords', spawns: [sp('mega', megaCount, 3.0), sp('boss', bossCount, 1.5)], trial: null };
  }
  if (w % 10 === 5) {
    const trials = ['SPEED', 'AERIAL', 'SWARM', 'ARMORED', 'ENDURANCE'];
    const trial = trials[Math.floor((w - 5) / 10) % trials.length];
    if (trial === 'SPEED')   return { name: 'Endless Rush Trial', spawns: [sp('runner', 28, 0.2, ['rush']), sp('grunt', 14, 0.4)], trial };
    if (trial === 'AERIAL')  return { name: 'Endless Aerial Trial', spawns: [sp('flyer', 22, 0.4, ['flying']), sp('runner', 10, 0.5)], trial };
    if (trial === 'SWARM')   return { name: 'Endless Swarm Trial', spawns: [sp('swarm', 30, 0.15), sp('grunt', 14, 0.4)], trial };
    if (trial === 'ARMORED') return { name: 'Endless Armor Trial', spawns: [sp('tank', 10, 1.1, ['highArmor']), sp('grunt', 18, 0.5)], trial };
    return { name: 'Endless Endurance Trial', spawns: [sp('tank', 8, 1.0, ['recharge']), sp('flyer', 12, 0.5, ['flying']), sp('swarm', 20, 0.18), sp('grunt', 20, 0.4)], trial };
  }
  // 70/20/10 endless composition: basic / specialist / elite (champion).
  const count = Math.min(30, 22 + Math.floor((w - 50) * 0.3));
  const basic = Math.round(count * 0.70);
  const specialist = Math.round(count * 0.20);
  const elite = Math.max(1, count - basic - specialist);
  return {
    name: 'Endless Crystal Horde',
    spawns: [
      sp('grunt', basic, 0.45),
      sp(w % 4 === 0 ? 'flyer' : w % 3 === 0 ? 'tank' : w % 2 === 0 ? 'runner' : 'swarm', specialist, 0.35, w % 4 === 0 ? ['flying'] : []),
      sp('champion', elite, 0.7, ['vitality']),
    ],
    trial: null,
  };
}

function applySpawnAbilities(enemy, entry, s) {
  const mods = spawnMods(entry);
  enemy.mods = mods;
  enemy.waveName = entry.name || null;
  if (entry.armor != null) enemy.armor = Math.max(enemy.armor || 0, entry.armor);
  if (entry.bossVariant) enemy.bossVariant = entry.bossVariant;
  if (entry.bossName) enemy.bossName = entry.bossName;
  if (mods.includes('flying')) enemy.flying = true;
  if (mods.includes('vitality')) {
    enemy.hp = Math.floor(enemy.hp * 1.4);
    enemy.maxHp = enemy.hp;
  }
  if (mods.includes('highArmor')) enemy.armor = Math.max(enemy.armor || 0, entry.armor ?? 12);
  if (mods.includes('magicResist')) enemy.magicResist = RESISTANCE_CAP;
  if (mods.includes('physicalResist')) enemy.physicalResist = RESISTANCE_CAP;
  if (mods.includes('poisonResist')) enemy.poisonResist = RESISTANCE_CAP;
  if (mods.includes('hidden')) enemy.hidden = true;
  if (mods.includes('evasion')) enemy.evasion = 0.35;
  if (mods.includes('reactiveArmor')) { enemy.reactiveArmor = true; enemy._reactiveHits = 0; }
  if (mods.includes('disarmAura')) enemy.disarmAura = true;
  if (mods.includes('blink')) { enemy.blink = true; enemy._blinkNext = s.time + 3.5; }
  if (mods.includes('rush')) enemy.rush = true;
  if (mods.includes('recharge')) enemy.recharge = true;
  if (mods.includes('krakenShell')) { enemy.krakenShell = true; enemy._shellNext = s.time + 4.5; }
  if (mods.includes('shield')) enemy.shieldHp = Math.max(enemy.shieldHp || 0, Math.floor(enemy.maxHp * 0.22));
}

function waveAbilityText(waveSpec) {
  const labels = new Set();
  for (const entry of waveSpec.spawns || []) {
    for (const m of spawnMods(entry)) {
      if (WAVE_ABILITY_LABELS[m]) labels.add(WAVE_ABILITY_LABELS[m]);
    }
  }
  return [...labels].slice(0, 3).join(' · ');
}

const ENEMY_BADGE_META = {
  flying: { label: 'AIR', color: '#a8e0ff' },
  hidden: { label: 'HID', color: '#cfd5e6' },
  evasion: { label: 'EVA', color: '#ffd166' },
  shield: { label: 'SHD', color: '#7be5d1' },
  disarmAura: { label: 'DIS', color: '#ff8fab' },
  reactiveArmor: { label: 'ARM', color: '#b08bff' },
  recharge: { label: 'REG', color: '#5cf28a' },
  krakenShell: { label: 'CLR', color: '#4cc9ff' },
  blink: { label: 'BLK', color: '#ff9f43' },
  rush: { label: 'RSH', color: '#ff4d6d' },
  magicResist: { label: 'MR', color: '#b08bff' },
  physicalResist: { label: 'PR', color: '#cfd5e6' },
};

function enemyBadges(e, def) {
  const raw = [];
  if (e.flying || def.flying) raw.push('flying');
  if (e.hidden) raw.push('hidden');
  if (e.evasion) raw.push('evasion');
  if (e.shieldHp > 0) raw.push('shield');
  if (e.disarmAura) raw.push('disarmAura');
  if (e.reactiveArmor) raw.push('reactiveArmor');
  if (e.recharge) raw.push('recharge');
  if (e.krakenShell) raw.push('krakenShell');
  if (e.blink) raw.push('blink');
  if (e.rush) raw.push('rush');
  if (e.magicResist) raw.push('magicResist');
  if (e.physicalResist) raw.push('physicalResist');
  return raw.map((key) => ENEMY_BADGE_META[key]).filter(Boolean).slice(0, 4);
}

// ─── BFS (4-directional, no diagonals) ──────────────────────────────────────
function bfs(grid, start, goal) {
  const visited = Array.from({ length: ROWS }, () => Array(COLS).fill(null));
  const queue = [start];
  visited[start.r][start.c] = { r: -1, c: -1 };
  while (queue.length) {
    const cur = queue.shift();
    if (cur.r === goal.r && cur.c === goal.c) {
      const path = [];
      let p = cur;
      while (p.r !== -1) {
        path.push({ r: p.r, c: p.c });
        p = visited[p.r][p.c];
      }
      path.reverse();
      return path;
    }
    const neighbors = [
      { r: cur.r - 1, c: cur.c },
      { r: cur.r + 1, c: cur.c },
      { r: cur.r, c: cur.c - 1 },
      { r: cur.r, c: cur.c + 1 },
    ];
    for (const n of neighbors) {
      if (n.r < 0 || n.r >= ROWS || n.c < 0 || n.c >= COLS) continue;
      if (grid[n.r][n.c]) continue;
      if (visited[n.r][n.c]) continue;
      visited[n.r][n.c] = cur;
      queue.push(n);
    }
  }
  return null;
}
// Path through all checkpoints in order.
function bfsCheckpoints(grid, start) {
  const points = [start, ...CHECKPOINTS, GOAL];
  let full = [points[0]];
  for (let i = 0; i < points.length - 1; i++) {
    const seg = bfs(grid, points[i], points[i + 1]);
    if (!seg) return null;
    for (let j = 1; j < seg.length; j++) full.push(seg[j]);
  }
  return full;
}

const emptyGrid = () => Array.from({ length: ROWS }, () => Array(COLS).fill(false));

// ─── App shell ───────────────────────────────────────────────────────────────
export default function App() {
  const [screen, setScreen] = useState('lobby');
  const [lastResult, setLastResult] = useState({ won: false, score: 0, waveReached: 0, difficulty: DEFAULT_DIFFICULTY, mode: DEFAULT_MODE });
  const [difficulty, setDifficulty] = useState(DEFAULT_DIFFICULTY);
  const [mode, setMode] = useState(DEFAULT_MODE);
  const [stats, setStats] = useState(defaultStats);
  const statsHydrated = useRef(false);

  useEffect(() => {
    let alive = true;
    AsyncStorage.getItem(STORAGE_KEY)
      .then((raw) => {
        if (!alive || !raw) return;
        setStats(normalizeStats(JSON.parse(raw)));
      })
      .catch(() => {})
      .finally(() => { statsHydrated.current = true; });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!statsHydrated.current) return;
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeStats(stats))).catch(() => {});
  }, [stats]);

  const recordResult = (won, score, waveReached) => {
    setLastResult({ won, score, waveReached, difficulty, mode });
    setStats((prev) => {
      const prevDiff = prev.perDiff || emptyPerDiff();
      const prevForDiff = prevDiff[difficulty] || { bestWave: 0 };
      return {
        bestScore: Math.max(prev.bestScore, score),
        bestWave: Math.max(prev.bestWave, waveReached),
        gamesPlayed: prev.gamesPlayed + 1,
        wins: prev.wins + (won ? 1 : 0),
        tutorialDone: true,
        perDiff: { ...prevDiff, [difficulty]: { bestWave: Math.max(prevForDiff.bestWave, waveReached) } },
      };
    });
    setScreen(won ? 'win' : 'lose');
  };

  const markTutorialDone = () => {
    setStats((prev) => ({ ...normalizeStats(prev), tutorialDone: true }));
  };

  const startSolo = (diffId) => {
    setDifficulty(diffId);
    setScreen('game');
  };

  if (screen === 'lobby') return <LobbyScreen stats={stats} mode={mode} onModeChange={setMode} onStartSolo={startSolo} />;
  if (screen === 'win' || screen === 'lose') return (
    <EndScreen
      won={screen === 'win'}
      score={lastResult.score}
      waveReached={lastResult.waveReached}
      difficulty={lastResult.difficulty}
      mode={lastResult.mode}
      stats={stats}
      onPlayAgain={() => setScreen('game')}
      onLobby={() => setScreen('lobby')}
    />
  );
  return (
    <Game
      onEnd={recordResult}
      difficulty={difficulty}
      mode={mode}
      showTutorial={!stats.tutorialDone && stats.gamesPlayed === 0}
      onTutorialDone={markTutorialDone}
    />
  );
}

// ─── Lobby ───────────────────────────────────────────────────────────────────
// Lobby background: drifting motes + slowly tumbling crystals.
const LOBBY_DUST = (() => {
  let seed = 12345;
  const rand = () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return Array.from({ length: 24 }, (_, i) => ({
    x0: rand(),
    y0: rand(),
    drift: 0.2 + rand() * 0.5,
    phase: rand() * Math.PI * 2,
    size: 1 + rand() * 2.5,
    color: i % 3 === 0 ? '#fff7a8' : i % 3 === 1 ? '#a8d0ff' : '#ffb0e0',
  }));
})();

function LobbyBackground({ width, height }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let raf;
    const loop = () => { setTick((t) => (t + 1) % 1e9); raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  const t = tick / 60;
  return (
    <View pointerEvents="none" style={{
      position: 'absolute', left: 0, top: 0, width, height, overflow: 'hidden',
    }}>
      {/* large soft crystal silhouettes drifting behind everything */}
      {[
        { x: width * 0.15, y: height * 0.18, size: 90, color: '#4cc9ff', rate: 0.35 },
        { x: width * 0.78, y: height * 0.42, size: 110, color: '#ff4d6d', rate: -0.25 },
        { x: width * 0.5,  y: height * 0.8,  size: 130, color: '#5cf28a', rate: 0.18 },
        { x: width * 0.85, y: height * 0.12, size: 60,  color: '#b08bff', rate: -0.5 },
      ].map((c, i) => (
        <View key={i} style={{
          position: 'absolute',
          left: c.x - c.size / 2,
          top: c.y - c.size / 2 + Math.sin(t * 0.5 + i) * 8,
          width: c.size, height: c.size, borderRadius: 8,
          backgroundColor: c.color,
          opacity: 0.07,
          transform: [{ rotate: `${(t * c.rate * 20 + i * 30) % 360}deg` }, { scale: 0.95 + 0.05 * Math.sin(t + i) }],
        }} />
      ))}
      {/* drifting motes */}
      {LOBBY_DUST.map((d, i) => {
        const y = ((d.y0 * height) - t * d.drift * 14) % height;
        const adjY = y < 0 ? y + height : y;
        const x = d.x0 * width + 12 * Math.sin(t * 0.6 + d.phase);
        const opacity = 0.4 + 0.4 * Math.sin(t * 1.2 + d.phase);
        return (
          <View key={`ld${i}`} style={{
            position: 'absolute',
            left: x, top: adjY,
            width: d.size, height: d.size, borderRadius: d.size,
            backgroundColor: d.color,
            opacity: opacity * 0.5,
          }} />
        );
      })}
    </View>
  );
}

function LobbyScreen({ stats, mode, onModeChange, onStartSolo }) {
  const [recipeBookOpen, setRecipeBookOpen] = useState(false);
  return (
    <SafeAreaView style={styles.lobbyRoot}>
      <StatusBar barStyle="light-content" />
      <LobbyBackground width={VIEWPORT_W} height={VIEWPORT_H + 200} />
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: 16 }}
        showsVerticalScrollIndicator={false}
      >
      <View style={styles.titleBannerWrap}>
        {/* Hanging chains on each side */}
        <View style={[styles.titleChain, { left: '22%' }]} />
        <View style={[styles.titleChain, { right: '22%' }]} />
        {/* Banner itself */}
        <View style={styles.titleBanner}>
          {/* gold trim corner studs */}
          <View style={[styles.cornerStud, { top: 4, left: 4 }]} />
          <View style={[styles.cornerStud, { top: 4, right: 4 }]} />
          <View style={[styles.cornerStud, { bottom: 4, left: 4 }]} />
          <View style={[styles.cornerStud, { bottom: 4, right: 4 }]} />
          {/* inner gold border */}
          <View style={styles.titleBannerInner}>
            <View style={styles.lobbyCrystalRow}>
              <Text style={[styles.lobbyCrystal, { color: '#ff4d6d' }]}>◆</Text>
              <Text style={[styles.lobbyCrystal, { color: '#4cc9ff' }]}>◆</Text>
              <Text style={[styles.lobbyCrystal, { color: '#5cf28a' }]}>◆</Text>
            </View>
            <Text style={styles.lobbyTitle}>Crystal Maze</Text>
            <Text style={styles.lobbySubtitle}>D E F E N C E</Text>
          </View>
        </View>
      </View>

      <View style={styles.statsCard}>
        {/* gold corner studs */}
        <View style={[styles.cornerStud, { top: 6, left: 6 }]} />
        <View style={[styles.cornerStud, { top: 6, right: 6 }]} />
        <View style={[styles.cornerStud, { bottom: 6, left: 6 }]} />
        <View style={[styles.cornerStud, { bottom: 6, right: 6 }]} />
        <Text style={styles.statsCardLabel}>· YOUR STATS ·</Text>
        <View style={styles.statsRow}>
          <StatTile label="BEST SCORE" value={stats.bestScore} color="#ffd166" />
          <StatTile label="HIGHEST WAVE" value={stats.bestWave} color="#4cc9ff" />
        </View>
        <View style={styles.statsRow}>
          <StatTile label="GAMES" value={stats.gamesPlayed} color="#fff" />
          <StatTile label="WINS" value={stats.wins} color="#5cf28a" />
        </View>
        {stats.gamesPlayed === 0 && (
          <Text style={styles.statsHint}>No games yet. Pick a difficulty to start.</Text>
        )}
      </View>

      <View style={{ marginBottom: 10 }}>
        <Text style={styles.soloHeader}>MODE</Text>
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 6 }}>
          {MODE_ORDER.map((mid) => {
            const m = MODES[mid];
            const selected = mode === mid;
            return (
              <TouchableOpacity
                key={mid}
                onPress={() => onModeChange(mid)}
                style={{
                  flex: 1, paddingVertical: 8, paddingHorizontal: 6,
                  borderRadius: 8, borderWidth: 2,
                  borderColor: selected ? '#ffd166' : '#2a335f',
                  backgroundColor: selected ? '#1d2240' : '#101630',
                }}
                activeOpacity={0.8}
              >
                <Text style={{ color: selected ? '#ffd166' : '#9aa3c7', fontSize: 12, fontWeight: '800', textAlign: 'center' }}>{m.name}</Text>
                <Text style={{ color: '#7a83a8', fontSize: 9, textAlign: 'center', marginTop: 2 }}>{m.waves === 9999 ? '∞' : m.waves}w · ×{m.rewardMult}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>

      <View style={styles.modeList}>
        <Text style={styles.soloHeader}>SOLO · pick a difficulty</Text>
        {DIFFICULTY_ORDER.map((id) => {
          const d = DIFFICULTIES[id];
          const bestWave = stats.perDiff?.[id]?.bestWave || 0;
          return (
            <TouchableOpacity
              key={id}
              onPress={() => onStartSolo(id)}
              activeOpacity={0.85}
              style={[styles.diffBtn, { borderColor: d.color }]}
            >
              {/* difficulty-coloured corner gems */}
              <View style={[styles.diffCornerGem, { top: 4, left: 4, backgroundColor: d.color }]} />
              <View style={[styles.diffCornerGem, { top: 4, right: 4, backgroundColor: d.color }]} />
              <View style={[styles.diffCornerGem, { bottom: 4, left: 4, backgroundColor: d.color }]} />
              <View style={[styles.diffCornerGem, { bottom: 4, right: 4, backgroundColor: d.color }]} />
              {/* coloured ribbon on the left */}
              <View style={[styles.diffRibbon, { backgroundColor: d.color }]} />
              <View style={{ flex: 1 }}>
                <View style={{ flexDirection: 'row', alignItems: 'baseline' }}>
                  <Text style={[styles.diffName, { color: d.color }]}>{d.name}</Text>
                  <Text style={styles.diffShort}>  · {d.short}</Text>
                </View>
                <Text style={styles.diffTagline}>{d.tagline}</Text>
                <Text style={styles.diffStats}>
                  HP ×{d.hpMul} · CNT ×{d.countMul} · GOLD ×{d.goldMul} · {d.lives} lives
                  {bestWave > 0 ? `   ·   best W${bestWave}` : ''}
                </Text>
              </View>
              <Text style={[styles.modeBtnArrow, { color: d.color }]}>▶</Text>
            </TouchableOpacity>
          );
        })}
        <View style={styles.modeBtnLocked}>
          <View style={{ flex: 1 }}>
            <Text style={styles.modeBtnTitleLocked}>QUICK MATCH</Text>
            <Text style={styles.modeBtnSubLocked}>1v1 race · coming soon</Text>
          </View>
          <Text style={styles.modeBtnLock}>🔒</Text>
        </View>
        <View style={styles.modeBtnLocked}>
          <View style={{ flex: 1 }}>
            <Text style={styles.modeBtnTitleLocked}>CO-OP (2–4)</Text>
            <Text style={styles.modeBtnSubLocked}>Defend with friends · coming soon</Text>
          </View>
          <Text style={styles.modeBtnLock}>🔒</Text>
        </View>
      </View>

      </ScrollView>

      <View style={styles.lobbyFooter}>
        <TouchableOpacity style={styles.footerBtn} activeOpacity={0.7}>
          <Text style={styles.footerIcon}>⚙</Text>
          <Text style={styles.footerLabel}>SETTINGS</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.footerBtn} activeOpacity={0.7} onPress={() => setRecipeBookOpen(true)}>
          <Text style={styles.footerIcon}>📖</Text>
          <Text style={styles.footerLabel}>RECIPES</Text>
        </TouchableOpacity>
        <View style={styles.footerBtn}>
          <Text style={styles.footerVersion}>v0.5</Text>
        </View>
      </View>

      <RecipeBookModal visible={recipeBookOpen} onClose={() => setRecipeBookOpen(false)} />
    </SafeAreaView>
  );
}

function StatTile({ label, value, color }) {
  return (
    <View style={styles.statTile}>
      <View style={styles.statTileMedallion}>
        <View style={styles.statTileMedallionInner} />
        <Text style={[styles.statTileValue, { color }]} numberOfLines={1}>{value}</Text>
      </View>
      <Text style={styles.statTileLabel}>{label}</Text>
    </View>
  );
}

function RecipeBookModal({ visible, onClose }) {
  const tiers = ['P2', 'P3', 'P4', 'P5', 'P6'];
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.modalBackdrop} onPress={onClose}>
        <Pressable style={styles.recipeBookCard} onPress={() => {}}>
          <View style={styles.recipeBookHeader}>
            <Text style={styles.recipeBookTitle}>📖 Recipe Book</Text>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 12, right: 12, bottom: 12, left: 12 }}>
              <Text style={styles.modalCloseXText}>✕</Text>
            </TouchableOpacity>
          </View>
          <ScrollView style={styles.recipeBookList}>
            <Text style={[styles.recipeRowDesc, { padding: 6, marginBottom: 8 }]}>
              Each build phase gives 5 free placements. Pick one to KEEP, MERGE
              (2 same → +1 purity, 4 same → +2), or COMBINE into a special tower.
              Higher specials need lower specials as ingredients.
            </Text>
            {tiers.map((p) => {
              const recipes = SPECIAL_RECIPES.filter((r) => r.tier === p);
              if (recipes.length === 0) return null;
              const label = p === 'P6' ? `${p} · MYTHIC` : p;
              return (
                <View key={p}>
                  <Text style={styles.recipeBookSection}>{label}</Text>
                  {recipes.map((r) => (
                    <View key={r.id} style={[styles.recipeRow, { borderColor: r.accent }]}>
                      <View style={[styles.craftIcon, { backgroundColor: r.color, borderColor: r.accent }]}>
                        <Text style={styles.specialIconStar}>{p === 'P6' ? '✦' : '★'}</Text>
                      </View>
                      <View style={styles.recipeRowText}>
                        <Text style={styles.recipeRowName}>{r.name}</Text>
                        <Text style={styles.recipeRowDesc}>{r.description}</Text>
                        <Text style={styles.recipeRowIngredients}>
                          {r.ingredients.map(ingredientLabel).join(' + ')}
                        </Text>
                      </View>
                    </View>
                  ))}
                </View>
              );
            })}
            <View style={{ height: 20 }} />
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function EndScreen({ won, score, waveReached, difficulty, mode, stats, onPlayAgain, onLobby }) {
  const newBest = score > 0 && score === stats.bestScore;
  const diff = DIFFICULTIES[difficulty] || DIFFICULTIES[DEFAULT_DIFFICULTY];
  const modeCfg = MODES[mode] || MODES[DEFAULT_MODE];
  const totalWaves = modeCfg.waves === 9999 ? '∞' : modeCfg.waves;
  return (
    <SafeAreaView style={styles.lobbyRoot}>
      <StatusBar barStyle="light-content" />
      <View style={styles.titleBannerWrap}>
        <View style={[styles.titleChain, { left: '22%' }]} />
        <View style={[styles.titleChain, { right: '22%' }]} />
        <View style={[styles.titleBanner, { borderTopColor: won ? '#3a8848' : '#7a1d2e', borderBottomColor: won ? '#3a8848' : '#7a1d2e' }]}>
          <View style={[styles.cornerStud, { top: 4, left: 4 }]} />
          <View style={[styles.cornerStud, { top: 4, right: 4 }]} />
          <View style={[styles.cornerStud, { bottom: 4, left: 4 }]} />
          <View style={[styles.cornerStud, { bottom: 4, right: 4 }]} />
          <View style={[styles.titleBannerInner, { borderColor: won ? '#5cf28a' : '#ff4d6d' }]}>
            <Text style={[styles.lobbyCrystal, won ? { color: '#5cf28a' } : { color: '#ff4d6d' }]}>
              {won ? '★' : '✦'}
            </Text>
            <Text style={[styles.lobbyTitle, { color: won ? '#5cf28a' : '#ff4d6d' }]}>{won ? 'VICTORY' : 'DEFEATED'}</Text>
            <Text style={styles.lobbySubtitle}>
              {won ? 'THE CRYSTALS SHINE ON' : `FELL ON WAVE ${waveReached}`}
            </Text>
            <View style={[styles.diffPill, { borderColor: diff.color, marginTop: 8 }]}>
              <View style={[styles.diffPillDot, { backgroundColor: diff.color }]} />
              <Text style={[styles.diffPillText, { color: diff.color }]}>{diff.name}</Text>
            </View>
          </View>
        </View>
      </View>
      <View style={styles.statsCard}>
        <View style={[styles.cornerStud, { top: 6, left: 6 }]} />
        <View style={[styles.cornerStud, { top: 6, right: 6 }]} />
        <View style={[styles.cornerStud, { bottom: 6, left: 6 }]} />
        <View style={[styles.cornerStud, { bottom: 6, right: 6 }]} />
        <Text style={styles.statsCardLabel}>· THIS RUN ·</Text>
        <View style={styles.statsRow}>
          <StatTile label="SCORE" value={score} color="#ffd166" />
          <StatTile label="WAVE REACHED" value={`${waveReached}/${totalWaves}`} color="#4cc9ff" />
        </View>
        {newBest && <Text style={styles.newBestText}>★ NEW BEST SCORE ★</Text>}
      </View>
      <View style={styles.modeList}>
        <TouchableOpacity style={styles.modeBtnPrimary} onPress={onPlayAgain} activeOpacity={0.85}>
          <View style={{ flex: 1 }}>
            <Text style={styles.modeBtnTitlePrimary}>PLAY AGAIN</Text>
            <Text style={styles.modeBtnSubPrimary}>Another run · {diff.name}</Text>
          </View>
          <Text style={styles.modeBtnArrow}>▶</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.modeBtnSecondary} onPress={onLobby} activeOpacity={0.85}>
          <Text style={styles.modeBtnTitleSecondary}>BACK TO LOBBY</Text>
        </TouchableOpacity>
      </View>
      <View style={{ height: 24 }} />
    </SafeAreaView>
  );
}

// ─── Game ────────────────────────────────────────────────────────────────────
function Game({ onEnd, difficulty, mode = DEFAULT_MODE, showTutorial = false, onTutorialDone }) {
  const diff = DIFFICULTIES[difficulty] || DIFFICULTIES[DEFAULT_DIFFICULTY];
  const modeCfg = MODES[mode] || MODES[DEFAULT_MODE];
  const stateRef = useRef(null);
  if (!stateRef.current) {
    stateRef.current = {
      grid: emptyGrid(),           // true = blocked (tower/special/rock)
      towers: [],                  // committed towers (kind: 'gem' | 'special' | 'rock')
      candidates: [],              // 5 placements this round before Choose Action
      enemies: [],
      projectiles: [],
      fx: [],
      path: bfsCheckpoints(emptyGrid(), SPAWN),
      wave: 0,
      playerLevel: 1,
      phase: 'placing',            // 'placing' | 'choosing' | 'attacking'
      placementsThisRound: 0,
      spawnQueue: [],
      time: 0,
      nextEnemyId: 1,
      nextProjectileId: 1,
      nextTowerId: 1,
      nextFxId: 1,
      gold: STARTING_GOLD,
      killStreak: 0,
      lives: diff.lives,
      // Endless layer (Phase D): mode/totalWaves/rewardMult from props.
      // matchSeed feeds mutationsForWave so a given match has consistent picks.
      mode: modeCfg.id,
      totalWaves: modeCfg.waves,
      rewardMult: modeCfg.rewardMult,
      matchSeed: (Math.random() * 0xFFFFFFFF) >>> 0,
      activeMutations: [],          // mutationsForWave(matchSeed, wave) cached per wave
      fogZones: [],                 // [{start,end}] path-fraction ranges (FogOfWarLanes)
      // Gold utilities (Phase E)
      skillCooldowns: emptyCooldowns(),
      effectEnds: {},                // { DamageBoost: time, Freeze: time, ... }
      healOverTimeWaves: 0,
      timelapseNext: false,
      candyLureRemaining: 0,
      goldRainAcc: 0,
      pendingWaveSkip: false,
      score: 0,
      speed: 1,
      difficulty: diff,
      pity: null,                  // rollWithPity lazily seeds this
      inspect: null,               // candidate id being inspected
      selectedTower: null,          // committed tower id for targeting controls
      manualTargetTowerId: null,    // tower waiting for the next enemy tap
      boardActionReadyAt: 0,        // 0.75s board-only action anti-spam
      tutorialStep: showTutorial ? 0 : -1,
      flash: null,
      pan: { x: 0, y: 0 },
      scale: INITIAL_SCALE,
      tiltAngle: 0,    // 0 = top-down, 50 = isometric pseudo-3D
    };
  }
  const [, setTick] = useState(0);
  const force = useCallback(() => setTick((t) => (t + 1) % 1e9), []);

  const gestureRef = useRef({ mode: null, startTx: 0, startTy: 0, startDist: 0, startScale: 1 });
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: (e) => e.nativeEvent.touches && e.nativeEvent.touches.length >= 2,
      onMoveShouldSetPanResponder: (e, gesture) => {
        const touches = e.nativeEvent.touches;
        if (touches.length === 2) return true;
        return Math.abs(gesture.dx) > 10 || Math.abs(gesture.dy) > 10;
      },
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (e) => {
        const g = gestureRef.current;
        const touches = e.nativeEvent.touches;
        if (touches.length === 2) {
          g.mode = 'pinch';
          g.startDist = Math.hypot(touches[0].pageX - touches[1].pageX, touches[0].pageY - touches[1].pageY) || 1;
          g.startScale = stateRef.current.scale;
        } else {
          g.mode = 'pan';
          g.startTx = stateRef.current.pan.x;
          g.startTy = stateRef.current.pan.y;
        }
      },
      onPanResponderMove: (e, gesture) => {
        const g = gestureRef.current;
        const s = stateRef.current;
        const touches = e.nativeEvent.touches;
        if (touches.length === 2) {
          if (g.mode !== 'pinch') {
            g.mode = 'pinch';
            g.startDist = Math.hypot(touches[0].pageX - touches[1].pageX, touches[0].pageY - touches[1].pageY) || 1;
            g.startScale = s.scale;
          }
          const dist = Math.hypot(touches[0].pageX - touches[1].pageX, touches[0].pageY - touches[1].pageY);
          s.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, g.startScale * (dist / g.startDist)));
        } else if (g.mode === 'pan') {
          s.pan.x = g.startTx + gesture.dx;
          s.pan.y = g.startTy + gesture.dy;
        }
      },
      onPanResponderRelease: () => { gestureRef.current.mode = null; },
      onPanResponderTerminate: () => { gestureRef.current.mode = null; },
    })
  ).current;

  useEffect(() => {
    let raf;
    let lastTs = Date.now();
    const loop = () => {
      const now = Date.now();
      const dt = Math.min(0.05, (now - lastTs) / 1000) * stateRef.current.speed;
      lastTs = now;
      step(dt, stateRef.current, onEnd);
      force();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [force, onEnd]);

  const s = stateRef.current;
  const flash = (text) => { s.flash = { text, until: s.time + 1.6 }; };

  // ── Build-phase actions ────────────────────────────────────────────────
  const tryPlaceCandidate = (r, c) => {
    if (s.phase !== 'placing') return;
    if (s.placementsThisRound >= MAX_PLACEMENTS) return;
    if (s.grid[r][c]) return;
    if (isReserved(r, c)) return;
    // Validate path still works with this placement
    s.grid[r][c] = true;
    const newPath = bfsCheckpoints(s.grid, SPAWN);
    if (!newPath) {
      s.grid[r][c] = false;
      flash('Would block the route');
      return;
    }
    // Roll gem (with pity protection — see rollWithPity)
    const { tier: purity, gemType } = rollWithPity(s);
    s.candidates.push({
      id: s.nextTowerId++,
      r, c,
      kind: 'gem',
      gemType, tier: purity,
      cooldown: 0,
      isCandidate: true,
    });
    s.placementsThisRound += 1;
    s.path = newPath;
    if (s.placementsThisRound >= MAX_PLACEMENTS) {
      s.phase = 'choosing';
    }
    force();
  };

  // Convert remaining candidates (everything except `keepIds`) into rocks.
  const candidatesToRocks = (keepIds) => {
    for (const c of s.candidates) {
      if (keepIds.has(c.id)) continue;
      s.towers.push({ id: c.id, r: c.r, c: c.c, kind: 'rock' });
    }
  };

  // Free a board cell (used when consuming a previously-committed tower).
  const freeCell = (tower) => {
    s.grid[tower.r][tower.c] = false;
  };

  // ── Keep ────────────────────────────────────────────────────────────────
  const resolveKeep = (candidateId) => {
    const anchor = s.candidates.find((c) => c.id === candidateId);
    if (!anchor) return;
    delete anchor.isCandidate;
    anchor.targetMode = anchor.targetMode || DEFAULT_TARGET_MODE;
    s.towers.push(anchor);
    candidatesToRocks(new Set([anchor.id]));
    finishChooseAction();
  };

  // ── Merge ──────────────────────────────────────────────────────────────
  // Returns matches in priority order: candidates first (they'd become rocks
  // anyway), then previously-committed gems. Keeps the player's older work.
  const findMatchingFor = (anchor) => {
    const sameKind = (t) =>
      t.id !== anchor.id &&
      t.kind === 'gem' &&
      t.gemType === anchor.gemType &&
      t.tier === anchor.tier;
    return [
      ...s.candidates.filter(sameKind),
      ...s.towers.filter(sameKind),
    ];
  };

  const resolveMerge = (candidateId, plusLevel) => {
    // plusLevel = 1 → need 2 same total (anchor + 1 other)
    // plusLevel = 2 → need 4 same total (anchor + 3 others)
    const anchor = s.candidates.find((c) => c.id === candidateId);
    if (!anchor) return;
    if (anchor.tier + plusLevel > 6) {
      flash('Already max purity');
      return;
    }
    const needed = plusLevel === 1 ? 1 : 3;
    const matches = findMatchingFor(anchor);
    if (matches.length < needed) {
      flash(`Need ${needed + 1} same ${GEMS[anchor.gemType].name} ${tier(anchor.tier).short}`);
      return;
    }
    const consumed = matches.slice(0, needed);
    // Remove consumed from candidates and from committed towers, freeing cells
    const consumedIds = new Set(consumed.map((t) => t.id));
    for (const t of consumed) {
      if (s.towers.includes(t)) {
        freeCell(t);
        // Replace this committed slot with a rock so the maze stays continuous
        s.towers.push({ id: t.id + 1e8, r: t.r, c: t.c, kind: 'rock' });
        s.towers = s.towers.filter((x) => x.id !== t.id);
        s.grid[t.r][t.c] = true;
      } else {
        // It's a candidate; do nothing here, candidatesToRocks handles it.
      }
    }
    // Upgrade anchor
    delete anchor.isCandidate;
    anchor.tier += plusLevel;
    anchor.targetMode = anchor.targetMode || DEFAULT_TARGET_MODE;
    s.towers.push(anchor);
    // All other candidates not consumed and not anchor → rocks
    const keep = new Set([anchor.id]);
    // candidates used in merge also disappear (they were "consumed"), turning to rocks
    // But mentally they're "merged into the anchor". Convert to rocks too.
    candidatesToRocks(keep);
    finishChooseAction();
  };

  const resolveChainMerge = (candidateId) => {
    const anchor = s.candidates.find((c) => c.id === candidateId);
    if (!anchor) return;
    const pool = [...s.candidates, ...s.towers];
    const consumed = findChainMergeMatch(anchor, pool);
    if (!consumed) {
      flash(`Need ${gemLabel(anchor.gemType, anchor.tier)} + ${gemLabel(anchor.gemType, anchor.tier + 1)}`);
      return;
    }
    for (const t of consumed) {
      if (s.towers.includes(t)) {
        freeCell(t);
        s.towers.push({ id: t.id + 3e8, r: t.r, c: t.c, kind: 'rock' });
        s.towers = s.towers.filter((x) => x.id !== t.id);
        s.grid[t.r][t.c] = true;
      }
    }
    delete anchor.isCandidate;
    anchor.tier += 2;
    anchor.targetMode = anchor.targetMode || DEFAULT_TARGET_MODE;
    s.towers.push(anchor);
    candidatesToRocks(new Set([anchor.id]));
    finishChooseAction();
  };

  // ── Combine ────────────────────────────────────────────────────────────
  const resolveCombine = (candidateId, recipeId) => {
    const anchor = s.candidates.find((c) => c.id === candidateId);
    const recipe = SPECIAL_BY_ID[recipeId];
    if (!anchor || !recipe) return;
    const pool = [...s.candidates, ...s.towers];
    const others = findRecipeMatch(anchor, pool, recipe);
    if (!others) { flash('Missing ingredients'); return; }
    // Gold gate (PLAN P2): recipe tier cost must be affordable.
    const cost = recipeGoldCost(recipe);
    if (s.gold < cost) { flash(`Need ${cost}g to forge ${recipe.name}`); return; }
    s.gold -= cost;
    // Consume committed-tower ingredients: free cells, mark as rocks
    for (const t of others) {
      if (s.towers.includes(t)) {
        freeCell(t);
        s.towers.push({ id: t.id + 2e8, r: t.r, c: t.c, kind: 'rock' });
        s.towers = s.towers.filter((x) => x.id !== t.id);
        s.grid[t.r][t.c] = true;
      }
    }
    // Transform anchor into special
    delete anchor.isCandidate;
    delete anchor.gemType;
    delete anchor.tier;
    anchor.kind = 'special';
    anchor.specialId = recipe.id;
    anchor.cooldown = 0;
    anchor.targetMode = anchor.targetMode || DEFAULT_TARGET_MODE;
    s.towers.push(anchor);
    candidatesToRocks(new Set([anchor.id]));
    finishChooseAction();
    playSound('recipe_forge');
    flash(`${recipe.name}!`);
  };

  const finishChooseAction = () => {
    s.candidates = [];
    s.placementsThisRound = 0;
    s.phase = 'attacking';
    s.path = bfsCheckpoints(s.grid, SPAWN);
    for (const e of s.enemies) {
      e.subPath = bfsCheckpoints(s.grid, { r: Math.floor(e.r), c: Math.floor(e.c) });
      e.pathIdx = 0;
    }
    // Begin the wave's spawn queue
    s.wave += 1;
    s.playerLevel = levelForWave(s.wave);
    // Phase E: WaveSkip pays expected rewards and immediately ends the wave.
    if (s.pendingWaveSkip) {
      s.pendingWaveSkip = false;
      const skipped = getWave(s.wave);
      const totalSpawns = skipped.spawns.reduce((n, entry) => n + spawnCount(entry), 0);
      const reward = totalSpawns * killGold(s.wave) * (s.rewardMult || 1);
      s.gold += Math.round(reward);
      s.flash = { text: `Wave ${s.wave} skipped · +${Math.round(reward)}g`, until: s.time + 2.0 };
      s.phase = 'placing';
      s.spawnQueue = [];
      return;
    }
    // Endless: compute this wave's active mutations (doc §A6 W75 gate, 1 → 2 at W150).
    s.activeMutations = mutationsForWave(s.matchSeed, s.wave);
    // FogOfWarLanes: 2 path-zones of 15% each, deterministic per (matchSeed, wave).
    if (s.activeMutations.includes('FogOfWarLanes')) {
      const rng = mulberry32((s.matchSeed >>> 0) ^ (s.wave * 0xA3D7) >>> 0);
      const a = 0.15 + rng() * 0.30;
      const b = 0.55 + rng() * 0.30;
      s.fogZones = [{ start: a, end: a + 0.15 }, { start: b, end: b + 0.15 }];
    } else {
      s.fogZones = [];
    }
    const w = getWave(s.wave);
    const diff = s.difficulty || DIFFICULTIES[DEFAULT_DIFFICULTY];
    const queue = [];
    let t = s.time + 0.8;
    // Phase E: Timelapse cuts spawn gaps in half for this wave (consumed).
    const timelapseMult = s.timelapseNext ? 0.5 : 1;
    s.timelapseNext = false;
    for (const entry of w.spawns) {
      const type = spawnType(entry);
      const count = spawnCount(entry);
      const gap = spawnGap(entry);
      const isBig = isBossSpawn(entry);
      const n = isBig ? count : Math.max(1, Math.round(count * diff.countMul));
      const g = gap * diff.spawnDelayMul * timelapseMult;
      for (let i = 0; i < n; i++) {
        t += g;
        queue.push({ ...entry, type, atTime: t });
      }
    }
    s.spawnQueue = queue;
    s.inspect = null;
    // Wave-start banner: stored separately from `flash` so it can render big.
    const totalEnemies = queue.length;
    const isBossWave = s.wave % 10 === 0;
    const bossNames = { 10: 'IRON PRISM HOUND', 20: 'FORGEBACK BEHEMOTH', 30: 'ASTRA CARPET TYRANT', 40: 'STORMGLASS GHOST', 50: 'WORLDHEART HATCHLING' };
    // Endless (W60+): use the cycled roster entry's display name.
    const endlessBoss = endlessBossEntry(s.wave);
    if (endlessBoss) bossNames[s.wave] = endlessBoss.name.toUpperCase();
    const mythic = s.wave >= 41 && !isBossWave;
    const apex = s.wave >= 31 && s.wave <= 40 && !isBossWave;
    const champion = s.wave >= 21 && s.wave <= 30 && !isBossWave;
    const elite = s.wave >= 11 && s.wave <= 20 && !isBossWave;
    const trial = w.trial || null;
    s.waveBanner = {
      wave: s.wave,
      total: totalEnemies,
      boss: isBossWave,
      bossName: bossNames[s.wave] || null,
      waveName: w.name || null,
      lesson: w.lesson || waveAbilityText(w) || null,
      trial,
      elite,
      champion,
      apex,
      mythic,
      finalWave: s.wave === 50,
      start: s.time,
      until: s.time + (s.wave === 50 ? 3.0 : 2.4),
    };
    if (isBossWave) playSound('boss_spawn');
    force();
  };

  const executeBoardAction = (action) => {
    if (!action) return;
    if (s.time < (s.boardActionReadyAt || 0)) {
      flash('Board action cooling down');
      return;
    }
    if (action.cost && s.gold < action.cost) {
      flash(`Need ${action.cost}g`);
      return;
    }
    const ids = new Set(action.ids || []);
    const consumed = [...ids].map((id) => s.towers.find((t) => t.id === id));
    if (consumed.some((t) => !t)) {
      flash('Board action expired');
      return;
    }
    const anchor = s.towers.find((t) => t.id === action.anchorId) || consumed[0];
    if (!anchor) return;
    const result = {
      id: anchor.id,
      r: anchor.r,
      c: anchor.c,
      cooldown: 0,
      targetMode: anchor.targetMode || DEFAULT_TARGET_MODE,
    };
    if (action.result.kind === 'gem') {
      result.kind = 'gem';
      result.gemType = action.result.gemType;
      result.tier = action.result.tier;
    } else {
      result.kind = 'special';
      result.specialId = action.result.specialId;
    }
    if (action.cost) s.gold -= action.cost;
    s.towers = s.towers.filter((t) => !ids.has(t.id));
    for (const t of consumed) {
      if (t.id === anchor.id) continue;
      s.towers.push({ id: t.id, r: t.r, c: t.c, kind: 'rock' });
      s.grid[t.r][t.c] = true;
    }
    s.grid[anchor.r][anchor.c] = true;
    s.towers.push(result);
    s.selectedTower = null;
    s.boardActionReadyAt = s.time + 0.75;
    s.path = bfsCheckpoints(s.grid, SPAWN) || s.path;
    for (const e of s.enemies) {
      const def = ENEMIES[e.type];
      if (e.hp <= 0 || e.flying || def.flying) continue;
      e.subPath = bfsCheckpoints(s.grid, { r: Math.floor(e.r), c: Math.floor(e.c) }) || e.subPath;
      e.pathIdx = 0;
    }
    flash(action.kind === 'recipe' ? `${SPECIAL_BY_ID[action.result.specialId]?.name || 'Recipe'} forged` : 'Board merge');
    force();
  };

  const setTowerMode = (towerId, mode) => {
    if (!TARGET_MODE_IDS.has(mode)) return;
    const tower = s.towers.find((t) => t.id === towerId && (t.kind === 'gem' || t.kind === 'special'));
    if (!tower) return;
    tower.targetMode = mode;
    if (mode === 'ManualTarget') {
      s.manualTargetTowerId = tower.id;
      s.selectedTower = null;
      flash('Tap an enemy to lock target');
    } else {
      tower.manualTargetId = null;
      if (s.manualTargetTowerId === tower.id) s.manualTargetTowerId = null;
      flash(`${targetModeLabel(mode)} targeting`);
    }
    force();
  };

  const findEnemyAtBoardPoint = (x, y) => {
    let best = null;
    let bestD = Infinity;
    for (const e of s.enemies) {
      if (e.hp <= 0) continue;
      const px = e.c * TILE + TILE / 2;
      const py = e.r * TILE + TILE / 2;
      const d = Math.hypot(px - x, py - y);
      if (d < bestD && d <= TILE * 0.95) {
        best = e;
        bestD = d;
      }
    }
    return best;
  };

  // ── Tap handlers ───────────────────────────────────────────────────────
  const onBoardPress = (e) => {
    const { locationX, locationY } = e.nativeEvent;
    const c = Math.floor(locationX / TILE);
    const r = Math.floor(locationY / TILE);
    if (r < 0 || r >= ROWS || c < 0 || c >= COLS) return;
    if (s.manualTargetTowerId) {
      const enemy = findEnemyAtBoardPoint(locationX, locationY);
      const tower = s.towers.find((t) => t.id === s.manualTargetTowerId);
      if (enemy && tower) {
        tower.targetMode = 'ManualTarget';
        tower.manualTargetId = enemy.id;
        s.manualTargetTowerId = null;
        flash(`Manual target #${enemy.id}`);
      } else {
        flash('Tap an enemy');
      }
      force();
      return;
    }
    const candidate = s.candidates.find((t) => t.r === r && t.c === c);
    if (candidate) {
      s.inspect = candidate.id;
      s.selectedTower = null;
      force();
      return;
    }
    const tower = s.towers.find((t) => t.r === r && t.c === c && (t.kind === 'gem' || t.kind === 'special'));
    if (tower) {
      s.selectedTower = tower.id;
      s.inspect = null;
      force();
      return;
    }
    if (s.phase === 'placing') {
      tryPlaceCandidate(r, c);
    }
    // Tapping committed towers/rocks during attacking phase: do nothing for now
  };

  const toggleSpeed = () => { s.speed = s.speed === 1 ? 2 : s.speed === 2 ? 3 : 1; force(); };
  const recenter = () => { s.pan.x = 0; s.pan.y = 0; s.scale = INITIAL_SCALE; s.tiltAngle = 0; force(); };
  const toggleTilt = () => {
    // Cycle 0 → 30 → 50 (pseudo-3D iso) → back to 0
    s.tiltAngle = s.tiltAngle === 0 ? 30 : s.tiltAngle === 30 ? 50 : 0;
    force();
  };
  const nextTutorial = () => {
    const done = s.tutorialStep >= TUTORIAL_STEPS.length - 1;
    s.tutorialStep = done ? -1 : s.tutorialStep + 1;
    if (done) onTutorialDone?.();
    force();
  };
  const skipTutorial = () => {
    s.tutorialStep = -1;
    onTutorialDone?.();
    force();
  };

  // ── Derived ─────────────────────────────────────────────────────────────
  // Auto-open the inspect modal on the first candidate as soon as the player
  // finishes 5 placements and we enter the 'choosing' phase. Saves a tap and
  // makes Keep/Merge/Combine actions immediately reachable.
  if (s.phase === 'choosing' && !s.inspect && s.candidates.length > 0) {
    s.inspect = s.candidates[0].id;
  }
  const inspectCandidate = s.inspect ? s.candidates.find((c) => c.id === s.inspect) : null;
  const selectedTower = s.selectedTower ? s.towers.find((t) => t.id === s.selectedTower && (t.kind === 'gem' || t.kind === 'special')) : null;
  const boardActions = findBoardActions(s.towers, s.gold);
  const tutorial = s.tutorialStep >= 0 ? TUTORIAL_STEPS[Math.min(s.tutorialStep, TUTORIAL_STEPS.length - 1)] : null;
  const activeStatuses = [
    ...UTILITIES
      .filter((u) => effectActive(s, u.id))
      .map((u) => ({ id: u.id, label: u.name, color: u.color, time: Math.ceil((s.effectEnds[u.id] || s.time) - s.time) })),
    ...(s.healOverTimeWaves > 0 ? [{ id: 'MendTicks', label: `Mend ${s.healOverTimeWaves}`, color: '#ff8fab' }] : []),
    ...(s.timelapseNext ? [{ id: 'TimelapseNext', label: 'Timelapse ready', color: '#b08bff' }] : []),
    ...(s.pendingWaveSkip ? [{ id: 'WaveSkipNext', label: 'Wave skip ready', color: '#b08bff' }] : []),
    ...(s.activeMutations || []).map((m) => ({ id: `mut-${m}`, label: m.replace(/([A-Z])/g, ' $1').trim(), color: '#ff9f43' })),
  ].slice(0, 8);
  const flashing = s.flash && s.flash.until > s.time ? s.flash.text : null;

  const boardLeft = (VIEWPORT_W - BOARD_W) / 2 + s.pan.x;
  const boardTop = (VIEWPORT_H - BOARD_H) / 2 + s.pan.y;
  const boardActors = [
    ...s.towers.map((t) => ({
      key: `tw${t.id}`,
      depth: t.r * 100 + t.c,
      node: <TowerView t={t} time={s.time} selected={s.selectedTower === t.id || s.manualTargetTowerId === t.id} />,
    })),
    ...s.candidates.map((t) => ({
      key: `c${t.id}`,
      depth: t.r * 100 + t.c + 0.25,
      node: <CandidateView t={t} time={s.time} />,
    })),
    ...s.enemies.map((e) => ({
      key: `e${e.id}`,
      depth: e.r * 100 + e.c + 0.5,
      node: <EnemyView e={e} time={s.time} />,
    })),
  ].sort((a, b) => a.depth - b.depth);

  let bottomMessage = '';
  if (s.phase === 'placing') {
    bottomMessage = `Place gem ${s.placementsThisRound + 1}/${MAX_PLACEMENTS} · level ${s.playerLevel}`;
  } else if (s.phase === 'choosing') {
    bottomMessage = 'Tap a placed gem to choose Keep / Merge / Combine';
  } else if (s.phase === 'attacking') {
    bottomMessage = `Wave ${s.wave}/${s.totalWaves === 9999 ? '∞' : s.totalWaves} in progress · pinch · drag`;
  }
  if (s.manualTargetTowerId) bottomMessage = 'Manual targeting · tap an enemy';

  return (
    <SafeAreaView style={styles.gameRoot}>
      <StatusBar barStyle="light-content" />
      <View style={styles.hud}>
        <HudStat label="LIVES" value={s.lives} color="#ff4d6d" />
        <HudStat label="GOLD" value={s.gold} color="#ffd166" />
        <HudStat label="WAVE" value={`${s.wave}/${s.totalWaves === 9999 ? '∞' : s.totalWaves}`} color="#4cc9ff" />
        <HudStat label="LVL" value={s.playerLevel} color="#b08bff" />
      </View>
      <View style={styles.diffStrip}>
        <View style={[styles.diffPill, { borderColor: diff.color }]}>
          <View style={[styles.diffPillDot, { backgroundColor: diff.color }]} />
          <Text style={[styles.diffPillText, { color: diff.color }]}>{diff.name}</Text>
        </View>
        {streakMult(s.killStreak) > 1 && (
          <View style={[styles.diffPill, { borderColor: '#ff9f43', marginLeft: 8 }]}>
            <Text style={[styles.diffPillText, { color: '#ff9f43' }]}>
              STREAK {s.killStreak} · +{Math.round((streakMult(s.killStreak) - 1) * 100)}% gold
            </Text>
          </View>
        )}
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ maxHeight: 50, marginBottom: 4 }} contentContainerStyle={{ paddingHorizontal: 8, gap: 6 }}>
        {UTILITIES.map((u) => {
          const cd = s.skillCooldowns?.[u.id] || 0;
          const canCast = cd <= 0 && s.gold >= u.cost;
          return (
            <TouchableOpacity
              key={u.id}
              onPress={() => { if (castUtility(s, u.id)) flash(`${u.name}`); }}
              disabled={!canCast}
              style={{
                paddingHorizontal: 8, paddingVertical: 4,
                borderRadius: 6, borderWidth: 1.5,
                borderColor: canCast ? u.color : '#2a335f',
                backgroundColor: canCast ? '#101630' : '#0a0e1f',
                opacity: canCast ? 1 : 0.5,
                minWidth: 70, alignItems: 'center',
              }}
              activeOpacity={0.7}
            >
              <Text style={{ color: u.color, fontSize: 10, fontWeight: '800' }}>{u.name.toUpperCase()}</Text>
              <Text style={{ color: cd > 0 ? '#ff9f43' : '#9aa3c7', fontSize: 9 }}>
                {cd > 0 ? `${Math.ceil(cd)}s` : `${u.cost}g`}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
      <ActiveStatusStrip items={activeStatuses} />

      <View
        style={{ width: VIEWPORT_W, height: VIEWPORT_H, backgroundColor: '#06081a', overflow: 'hidden' }}
        {...panResponder.panHandlers}
      >
        <View
          pointerEvents="box-none"
          style={{
            position: 'absolute',
            left: boardLeft, top: boardTop,
            width: BOARD_W, height: BOARD_H,
            transform: [
              { perspective: 1200 },
              { rotateX: `${s.tiltAngle}deg` },
              { scale: s.scale },
            ],
          }}
        >
          {/* dungeon chrome: gradient, tile grid, stone frame, torches, crystals */}
          <BoardChrome />

          {/* drifting dust motes (animated) */}
          <DustLayer time={s.time} />

          {/* animated path with flowing wave */}
          <PathLayer path={s.path} time={s.time} />

          {/* spawn portal, checkpoint torches, castle keep */}
          <SpawnPortal pt={SPAWN} time={s.time} />
          {CHECKPOINTS.map((cp, i) => (
            <CheckpointTorch key={`cp${i}`} pt={cp} time={s.time} i={i} />
          ))}
          <CastleKeep pt={GOAL} time={s.time} />

          {/* tap layer */}
          <Pressable onPress={onBoardPress} style={{ position: 'absolute', left: 0, top: 0, width: BOARD_W, height: BOARD_H }} />

          {/* y-sorted actors — cheap 2.5D depth without a new renderer */}
          {boardActors.map((a) => <React.Fragment key={a.key}>{a.node}</React.Fragment>)}

          {/* projectiles */}
          {s.projectiles.map((p) => <ProjectileView key={`pr${p.id}`} p={p} />)}

          {/* visual effects (muzzle, impact, death) */}
          <FxLayer fx={s.fx} time={s.time} />

          {/* animated torches on top of everything (so they cast over walls) */}
          <TorchLayer time={s.time} />
        </View>

        <TouchableOpacity onPress={recenter} style={styles.recenterBtn}>
          <Text style={styles.recenterText}>⤢</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={toggleTilt} style={styles.tiltBtn}>
          <Text style={styles.tiltBtnText}>
            {s.tiltAngle === 0 ? '2D' : s.tiltAngle === 30 ? '2.5D' : '3D'}
          </Text>
        </TouchableOpacity>

        <WaveBanner banner={s.waveBanner} time={s.time} />
        <BoardActionTray
          actions={boardActions}
          cooldown={Math.max(0, (s.boardActionReadyAt || 0) - s.time)}
          onAction={executeBoardAction}
        />

        {flashing && (
          <View pointerEvents="none" style={styles.flashWrap}>
            <Text style={styles.flashText}>{flashing}</Text>
          </View>
        )}
        <TutorialCard tutorial={tutorial} onNext={nextTutorial} onSkip={skipTutorial} />
      </View>

      <View style={styles.bottomBar}>
        <View style={styles.phaseBadge}>
          <Text style={styles.phaseBadgeText}>{s.phase.toUpperCase()}</Text>
        </View>
        <Text style={styles.bottomMessage}>{bottomMessage}</Text>
        <View style={styles.bottomRow}>
          <TouchableOpacity style={styles.speedBtn} onPress={toggleSpeed}>
            <Text style={styles.speedBtnText}>{s.speed}×</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.speedBtn, { marginLeft: 6, backgroundColor: isAudioMuted() ? '#2a335f' : '#101630' }]}
            onPress={() => { setAudioMuted(!isAudioMuted()); force(); }}
          >
            <Text style={styles.speedBtnText}>{isAudioMuted() ? 'MUTE' : 'SND'}</Text>
          </TouchableOpacity>
        </View>
      </View>

      <Modal
        visible={!!inspectCandidate}
        transparent
        animationType="fade"
        onRequestClose={() => { s.inspect = null; force(); }}
      >
        <Pressable style={styles.modalBackdrop} onPress={() => { s.inspect = null; force(); }}>
          <Pressable style={styles.modalCard} onPress={() => {}}>
            {/* gold corner studs */}
            <View style={[styles.cornerStud, { top: 8, left: 8 }]} />
            <View style={[styles.cornerStud, { top: 8, right: 8 }]} />
            <View style={[styles.cornerStud, { bottom: 8, left: 8 }]} />
            <View style={[styles.cornerStud, { bottom: 8, right: 8 }]} />
            <TouchableOpacity
              style={styles.modalCloseX}
              onPress={() => { s.inspect = null; force(); }}
              hitSlop={{ top: 12, right: 12, bottom: 12, left: 12 }}
            >
              <Text style={styles.modalCloseXText}>✕</Text>
            </TouchableOpacity>
            {inspectCandidate && (
              <CandidateInspect
                candidate={inspectCandidate}
                candidates={s.candidates}
                onSelectCandidate={(id) => { s.inspect = id; force(); }}
                allTowers={[...s.candidates, ...s.towers]}
                gold={s.gold}
                onKeep={() => resolveKeep(inspectCandidate.id)}
                onMerge={(plus) => resolveMerge(inspectCandidate.id, plus)}
                onChainMerge={() => resolveChainMerge(inspectCandidate.id)}
                onCombine={(rid) => resolveCombine(inspectCandidate.id, rid)}
              />
            )}
          </Pressable>
        </Pressable>
      </Modal>

      <Modal
        visible={!!selectedTower}
        transparent
        animationType="fade"
        onRequestClose={() => { s.selectedTower = null; force(); }}
      >
        <Pressable style={styles.modalBackdrop} onPress={() => { s.selectedTower = null; force(); }}>
          <Pressable style={styles.modalCard} onPress={() => {}}>
            <View style={[styles.cornerStud, { top: 8, left: 8 }]} />
            <View style={[styles.cornerStud, { top: 8, right: 8 }]} />
            <View style={[styles.cornerStud, { bottom: 8, left: 8 }]} />
            <View style={[styles.cornerStud, { bottom: 8, right: 8 }]} />
            <TouchableOpacity
              style={styles.modalCloseX}
              onPress={() => { s.selectedTower = null; force(); }}
              hitSlop={{ top: 12, right: 12, bottom: 12, left: 12 }}
            >
              <Text style={styles.modalCloseXText}>✕</Text>
            </TouchableOpacity>
            {selectedTower && (
              <TowerInspect
                tower={selectedTower}
                onMode={(modeId) => setTowerMode(selectedTower.id, modeId)}
              />
            )}
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

// ─── Tower / candidate / enemy / projectile render ───────────────────────────
// ─── Board chrome (gradient, tile grid, stone frame, torches, crystals) ────
// Pure decoration. Memoized so the 60fps loop doesn't re-render this.
const WALL_THICKNESS = TILE * 1.2;
const CRYSTAL_MARGIN = TILE * 2.6;

const GRADIENT_STRIPS = 14;
const STRIP_W = BOARD_W / GRADIENT_STRIPS;
function lerp(a, b, t) { return Math.round(a + (b - a) * t); }
function gradColor(t) {
  // dark blue → deep purple
  const r = lerp(0x1a, 0x4a, t);
  const g = lerp(0x26, 0x24, t);
  const b = lerp(0x55, 0x62, t);
  return `rgb(${r},${g},${b})`;
}

// Decorative crystal — small rotated diamond with glow.
function DecoCrystal({ left, top, size, color, rot }) {
  return (
    <View pointerEvents="none" style={{
      position: 'absolute', left, top, width: size, height: size,
      alignItems: 'center', justifyContent: 'center',
    }}>
      <View style={{
        width: size * 1.6, height: size * 1.6, borderRadius: size,
        backgroundColor: color, opacity: 0.18,
      }} />
      <View style={{
        position: 'absolute',
        width: size, height: size,
        backgroundColor: color,
        borderRadius: 3,
        transform: [{ rotate: `${rot}deg` }, { scaleY: 1.4 }],
        shadowColor: color, shadowOpacity: 0.9,
        shadowRadius: 8, shadowOffset: { width: 0, height: 0 },
      }} />
    </View>
  );
}

// Deterministic crystal placements outside the board frame.
const CRYSTAL_SPECS = (() => {
  const specs = [];
  const sides = [
    { x0: -CRYSTAL_MARGIN, x1: -WALL_THICKNESS * 1.2, y0: 0, y1: BOARD_H, color: '#4cc9ff' },           // left  blue
    { x0: BOARD_W + WALL_THICKNESS * 1.2, x1: BOARD_W + CRYSTAL_MARGIN, y0: 0, y1: BOARD_H, color: '#b08bff' }, // right purple
    { x0: 0, x1: BOARD_W, y0: -CRYSTAL_MARGIN, y1: -WALL_THICKNESS * 1.2, color: '#7a5cff', mixed: true },     // top
    { x0: 0, x1: BOARD_W, y0: BOARD_H + WALL_THICKNESS * 1.2, y1: BOARD_H + CRYSTAL_MARGIN, color: '#b08bff', mixed: true }, // bottom
  ];
  // Pseudo-random but deterministic (Mulberry32)
  let seed = 1234567;
  const rand = () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  sides.forEach((side, idx) => {
    const n = idx < 2 ? 14 : 10;
    for (let i = 0; i < n; i++) {
      const x = side.x0 + rand() * (side.x1 - side.x0);
      const y = side.y0 + rand() * (side.y1 - side.y0);
      const size = TILE * (0.5 + rand() * 0.6);
      const rot = rand() * 60 - 30;
      let color = side.color;
      if (side.mixed) {
        const tFrac = (x - 0) / BOARD_W;
        const r = lerp(0x4c, 0xb0, tFrac);
        const g = lerp(0xc9, 0x8b, tFrac);
        const b = lerp(0xff, 0xff, tFrac);
        color = `rgb(${r},${g},${b})`;
      }
      specs.push({ left: x, top: y, size, color, rot });
    }
  });
  return specs;
})();

const TORCH_SPECS = [
  // 4 corners
  { left: -WALL_THICKNESS / 2 - 6, top: -WALL_THICKNESS / 2 - 6 },
  { left: BOARD_W + WALL_THICKNESS / 2 - 6, top: -WALL_THICKNESS / 2 - 6 },
  { left: -WALL_THICKNESS / 2 - 6, top: BOARD_H + WALL_THICKNESS / 2 - 6 },
  { left: BOARD_W + WALL_THICKNESS / 2 - 6, top: BOARD_H + WALL_THICKNESS / 2 - 6 },
  // 4 mid-edges
  { left: BOARD_W / 2 - 6, top: -WALL_THICKNESS / 2 - 6 },
  { left: BOARD_W / 2 - 6, top: BOARD_H + WALL_THICKNESS / 2 - 6 },
  { left: -WALL_THICKNESS / 2 - 6, top: BOARD_H / 2 - 6 },
  { left: BOARD_W + WALL_THICKNESS / 2 - 6, top: BOARD_H / 2 - 6 },
  // 4 quarter points on top/bottom
  { left: BOARD_W * 0.25 - 6, top: -WALL_THICKNESS / 2 - 6 },
  { left: BOARD_W * 0.75 - 6, top: -WALL_THICKNESS / 2 - 6 },
  { left: BOARD_W * 0.25 - 6, top: BOARD_H + WALL_THICKNESS / 2 - 6 },
  { left: BOARD_W * 0.75 - 6, top: BOARD_H + WALL_THICKNESS / 2 - 6 },
];

// Pseudo-random deterministic noise positions for floor detail (cracks, moss).
const FLOOR_DETAILS = (() => {
  let seed = 73219;
  const rand = () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return Array.from({ length: 60 }, () => ({
    x: rand() * BOARD_W,
    y: rand() * BOARD_H,
    kind: rand() < 0.55 ? 'crack' : rand() < 0.8 ? 'speckle' : 'moss',
    rot: rand() * 90 - 45,
    scale: 0.5 + rand() * 0.9,
    variant: Math.floor(rand() * 3),
  }));
})();

// Stone slab floor: one SVG covering the whole board with a tiled pattern
// plus scattered cracks, speckles, and mossy patches for variation.
function StoneFloor() {
  return (
    <View pointerEvents="none" style={{ position: 'absolute', left: 0, top: 0, width: BOARD_W, height: BOARD_H }}>
      <Svg width={BOARD_W} height={BOARD_H}>
        <Defs>
          <Pattern id="slab" x="0" y="0" width={TILE} height={TILE} patternUnits="userSpaceOnUse">
            {/* slab base — gradient from cool blue-grey top to deeper bottom */}
            <Rect x="0" y="0" width={TILE} height={TILE} fill="#2a2540" />
            <Rect x="1" y="1" width={TILE - 2} height={TILE - 2} fill="#332e4a" />
            {/* top-left highlight bevel */}
            <Path d={`M 1 1 L ${TILE - 1} 1 L ${TILE - 3} 3 L 3 3 L 3 ${TILE - 3} L 1 ${TILE - 1} Z`}
                  fill="#4a4366" opacity="0.7" />
            {/* bottom-right shadow bevel */}
            <Path d={`M 1 ${TILE - 1} L ${TILE - 1} ${TILE - 1} L ${TILE - 1} 1 L ${TILE - 3} 3 L ${TILE - 3} ${TILE - 3} L 3 ${TILE - 3} Z`}
                  fill="#1a1530" opacity="0.75" />
            {/* dim center */}
            <Rect x="4" y="4" width={TILE - 8} height={TILE - 8} fill="#2c2745" opacity="0.55" />
            {/* tiny corner dots */}
            <Circle cx="3" cy="3" r="0.6" fill="#1a1530" />
            <Circle cx={TILE - 3} cy={TILE - 3} r="0.6" fill="#1a1530" />
          </Pattern>
          <RadialGradient id="floorVignette" cx="0.5" cy="0.5" r="0.7">
            <Stop offset="0" stopColor="#000" stopOpacity="0" />
            <Stop offset="1" stopColor="#000" stopOpacity="0.55" />
          </RadialGradient>
        </Defs>
        <Rect x="0" y="0" width={BOARD_W} height={BOARD_H} fill="url(#slab)" />
        {/* scattered floor details */}
        {FLOOR_DETAILS.map((d, i) => {
          if (d.kind === 'crack') {
            const len = 6 * d.scale;
            return (
              <Path
                key={i}
                d={`M ${d.x} ${d.y} L ${d.x + len * Math.cos(d.rot)} ${d.y + len * Math.sin(d.rot)}`}
                stroke="#0a0510"
                strokeWidth={0.6}
                opacity="0.65"
              />
            );
          }
          if (d.kind === 'speckle') {
            return (
              <Circle key={i} cx={d.x} cy={d.y} r={0.8 * d.scale} fill="#1a1530" opacity="0.6" />
            );
          }
          // moss
          return (
            <Circle key={i} cx={d.x} cy={d.y} r={1.5 * d.scale} fill="#3a5a3a" opacity="0.45" />
          );
        })}
        {/* vignette — darker at edges */}
        <Rect x="0" y="0" width={BOARD_W} height={BOARD_H} fill="url(#floorVignette)" />
      </Svg>
    </View>
  );
}

// Brick wall frame around the perimeter — running-bond pattern with mortar gaps.
const BRICK_W = 36;
const BRICK_H = WALL_THICKNESS;
function BrickWalls() {
  const outerW = BOARD_W + WALL_THICKNESS * 2;
  const outerH = BOARD_H + WALL_THICKNESS * 2;
  return (
    <View pointerEvents="none" style={{
      position: 'absolute',
      left: -WALL_THICKNESS, top: -WALL_THICKNESS,
      width: outerW, height: outerH,
    }}>
      <Svg width={outerW} height={outerH}>
        <Defs>
          <Pattern id="brickH" x="0" y="0" width={BRICK_W * 2} height={BRICK_H} patternUnits="userSpaceOnUse">
            <Rect x="0" y="0" width={BRICK_W * 2} height={BRICK_H} fill="#16121f" />
            {/* row brick (top row of pattern) */}
            <Rect x="1" y="1" width={BRICK_W - 2} height={BRICK_H - 2} fill="#3a3050" />
            <Rect x={BRICK_W + 1} y="1" width={BRICK_W - 2} height={BRICK_H - 2} fill="#352b48" />
            {/* highlights */}
            <Path d={`M 1 1 L ${BRICK_W - 1} 1 L ${BRICK_W - 1} 2 L 1 2 Z`} fill="#5a4d76" opacity="0.65" />
            <Path d={`M ${BRICK_W + 1} 1 L ${BRICK_W * 2 - 1} 1 L ${BRICK_W * 2 - 1} 2 L ${BRICK_W + 1} 2 Z`} fill="#5a4d76" opacity="0.65" />
            {/* shadows */}
            <Path d={`M 1 ${BRICK_H - 2} L ${BRICK_W - 1} ${BRICK_H - 2} L ${BRICK_W - 1} ${BRICK_H - 1} L 1 ${BRICK_H - 1} Z`} fill="#0a0510" opacity="0.6" />
            <Path d={`M ${BRICK_W + 1} ${BRICK_H - 2} L ${BRICK_W * 2 - 1} ${BRICK_H - 2} L ${BRICK_W * 2 - 1} ${BRICK_H - 1} L ${BRICK_W + 1} ${BRICK_H - 1} Z`} fill="#0a0510" opacity="0.6" />
            {/* speckles */}
            <Circle cx={BRICK_W * 0.3} cy={BRICK_H * 0.5} r="0.6" fill="#0a0510" opacity="0.7" />
            <Circle cx={BRICK_W * 0.7} cy={BRICK_H * 0.4} r="0.5" fill="#0a0510" opacity="0.7" />
            <Circle cx={BRICK_W * 1.3} cy={BRICK_H * 0.6} r="0.6" fill="#0a0510" opacity="0.7" />
            <Circle cx={BRICK_W * 1.7} cy={BRICK_H * 0.5} r="0.5" fill="#0a0510" opacity="0.7" />
          </Pattern>
          <Pattern id="brickHoffset" x={BRICK_W} y="0" width={BRICK_W * 2} height={BRICK_H} patternUnits="userSpaceOnUse">
            <Rect x="0" y="0" width={BRICK_W * 2} height={BRICK_H} fill="#16121f" />
            <Rect x="1" y="1" width={BRICK_W - 2} height={BRICK_H - 2} fill="#3a3050" />
            <Rect x={BRICK_W + 1} y="1" width={BRICK_W - 2} height={BRICK_H - 2} fill="#352b48" />
            <Path d={`M 1 1 L ${BRICK_W - 1} 1 L ${BRICK_W - 1} 2 L 1 2 Z`} fill="#5a4d76" opacity="0.65" />
            <Path d={`M ${BRICK_W + 1} 1 L ${BRICK_W * 2 - 1} 1 L ${BRICK_W * 2 - 1} 2 L ${BRICK_W + 1} 2 Z`} fill="#5a4d76" opacity="0.65" />
            <Path d={`M 1 ${BRICK_H - 2} L ${BRICK_W - 1} ${BRICK_H - 2} L ${BRICK_W - 1} ${BRICK_H - 1} L 1 ${BRICK_H - 1} Z`} fill="#0a0510" opacity="0.6" />
            <Path d={`M ${BRICK_W + 1} ${BRICK_H - 2} L ${BRICK_W * 2 - 1} ${BRICK_H - 2} L ${BRICK_W * 2 - 1} ${BRICK_H - 1} L ${BRICK_W + 1} ${BRICK_H - 1} Z`} fill="#0a0510" opacity="0.6" />
          </Pattern>
          <Pattern id="brickV" x="0" y="0" width={BRICK_H} height={BRICK_W * 2} patternUnits="userSpaceOnUse">
            <Rect x="0" y="0" width={BRICK_H} height={BRICK_W * 2} fill="#16121f" />
            <Rect x="1" y="1" width={BRICK_H - 2} height={BRICK_W - 2} fill="#3a3050" />
            <Rect x="1" y={BRICK_W + 1} width={BRICK_H - 2} height={BRICK_W - 2} fill="#352b48" />
            <Path d={`M 1 1 L 2 1 L 2 ${BRICK_W - 1} L 1 ${BRICK_W - 1} Z`} fill="#5a4d76" opacity="0.65" />
            <Path d={`M 1 ${BRICK_W + 1} L 2 ${BRICK_W + 1} L 2 ${BRICK_W * 2 - 1} L 1 ${BRICK_W * 2 - 1} Z`} fill="#5a4d76" opacity="0.65" />
          </Pattern>
        </Defs>
        {/* top wall */}
        <Rect x="0" y="0" width={outerW} height={WALL_THICKNESS} fill="url(#brickH)" />
        {/* bottom wall — offset row pattern */}
        <Rect x="0" y={outerH - WALL_THICKNESS} width={outerW} height={WALL_THICKNESS} fill="url(#brickHoffset)" />
        {/* left wall */}
        <Rect x="0" y="0" width={WALL_THICKNESS} height={outerH} fill="url(#brickV)" />
        {/* right wall */}
        <Rect x={outerW - WALL_THICKNESS} y="0" width={WALL_THICKNESS} height={outerH} fill="url(#brickV)" />
        {/* outer dark edge */}
        <Rect x="0" y="0" width={outerW} height={outerH}
              fill="none" stroke="#0a0510" strokeWidth="2" />
        {/* inner dark edge against the play area */}
        <Rect x={WALL_THICKNESS - 1} y={WALL_THICKNESS - 1}
              width={BOARD_W + 2} height={BOARD_H + 2}
              fill="none" stroke="#0a0510" strokeWidth="1.5" />
        {/* corner cap stones */}
        <Rect x="0" y="0" width={WALL_THICKNESS} height={WALL_THICKNESS} fill="#1f1832" stroke="#0a0510" strokeWidth="1" />
        <Rect x={outerW - WALL_THICKNESS} y="0" width={WALL_THICKNESS} height={WALL_THICKNESS} fill="#1f1832" stroke="#0a0510" strokeWidth="1" />
        <Rect x="0" y={outerH - WALL_THICKNESS} width={WALL_THICKNESS} height={WALL_THICKNESS} fill="#1f1832" stroke="#0a0510" strokeWidth="1" />
        <Rect x={outerW - WALL_THICKNESS} y={outerH - WALL_THICKNESS} width={WALL_THICKNESS} height={WALL_THICKNESS} fill="#1f1832" stroke="#0a0510" strokeWidth="1" />
        {/* corner gems */}
        <Polygon points={`${WALL_THICKNESS/2},${WALL_THICKNESS/2 - 5} ${WALL_THICKNESS/2 + 5},${WALL_THICKNESS/2} ${WALL_THICKNESS/2},${WALL_THICKNESS/2 + 5} ${WALL_THICKNESS/2 - 5},${WALL_THICKNESS/2}`}
                 fill="#4cc9ff" stroke="#0a0510" strokeWidth="0.8" />
        <Polygon points={`${outerW - WALL_THICKNESS/2},${WALL_THICKNESS/2 - 5} ${outerW - WALL_THICKNESS/2 + 5},${WALL_THICKNESS/2} ${outerW - WALL_THICKNESS/2},${WALL_THICKNESS/2 + 5} ${outerW - WALL_THICKNESS/2 - 5},${WALL_THICKNESS/2}`}
                 fill="#ff4d6d" stroke="#0a0510" strokeWidth="0.8" />
        <Polygon points={`${WALL_THICKNESS/2},${outerH - WALL_THICKNESS/2 - 5} ${WALL_THICKNESS/2 + 5},${outerH - WALL_THICKNESS/2} ${WALL_THICKNESS/2},${outerH - WALL_THICKNESS/2 + 5} ${WALL_THICKNESS/2 - 5},${outerH - WALL_THICKNESS/2}`}
                 fill="#5cf28a" stroke="#0a0510" strokeWidth="0.8" />
        <Polygon points={`${outerW - WALL_THICKNESS/2},${outerH - WALL_THICKNESS/2 - 5} ${outerW - WALL_THICKNESS/2 + 5},${outerH - WALL_THICKNESS/2} ${outerW - WALL_THICKNESS/2},${outerH - WALL_THICKNESS/2 + 5} ${outerW - WALL_THICKNESS/2 - 5},${outerH - WALL_THICKNESS/2}`}
                 fill="#ffd166" stroke="#0a0510" strokeWidth="0.8" />
      </Svg>
    </View>
  );
}

const BoardChrome = React.memo(function BoardChrome() {
  return (
    <>
      {/* SVG-based stone floor (slabs, cracks, moss, vignette) */}
      <StoneFloor />

      {USE_SPRITES.decor && ASSET_MAP.decor.maze_background && (
        <RemoteSprite
          source={ASSET_MAP.decor.maze_background}
          resizeMode="cover"
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            width: BOARD_W,
            height: BOARD_H,
            opacity: 0.26,
          }}
        />
      )}

      {/* Decorative crystals outside the play area */}
      {CRYSTAL_SPECS.map((c, i) => <DecoCrystal key={`dc${i}`} {...c} />)}

      {/* SVG-based brick wall frame with corner gems */}
      <BrickWalls />
    </>
  );
});

// Animated torches — flickers via the game-loop time. Each torch has a
// random phase so they don't all sync up.
function TorchLayer({ time }) {
  return (
    <>
      {TORCH_SPECS.map((pos, i) => {
        const phase = (i * 1.3) % (Math.PI * 2);
        const flicker = 0.7 + 0.3 * Math.sin(time * 6 + phase) * Math.sin(time * 11 + phase * 1.7);
        const scale = 0.92 + 0.12 * Math.sin(time * 8 + phase);
        return (
          <View key={`to${i}`} pointerEvents="none" style={{
            position: 'absolute',
            left: pos.left, top: pos.top,
            width: 12, height: 12, borderRadius: 6,
            backgroundColor: '#ffb24a',
            borderWidth: 1, borderColor: '#ffd166',
            transform: [{ scale }],
            shadowColor: '#ffaa44',
            shadowOpacity: flicker,
            shadowRadius: 12 + flicker * 10,
            shadowOffset: { width: 0, height: 0 },
            elevation: 8,
          }}>
            <View style={{
              position: 'absolute',
              left: 3, top: 3, width: 6, height: 6, borderRadius: 3,
              backgroundColor: '#fff7a8',
              opacity: 0.7 + flicker * 0.3,
            }} />
            {/* warm pool of light on the floor */}
            <View style={{
              position: 'absolute',
              left: -28, top: -28, width: 68, height: 68, borderRadius: 34,
              backgroundColor: '#ffaa44',
              opacity: 0.05 + flicker * 0.08,
            }} />
          </View>
        );
      })}
    </>
  );
}

// Background drifting dust motes — pure decoration, drift slowly.
const DUST_COUNT = 28;
const DUST_SPECS = (() => {
  let seed = 9876543;
  const rand = () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return Array.from({ length: DUST_COUNT }, (_, i) => ({
    x0: rand() * BOARD_W,
    y0: rand() * BOARD_H,
    drift: 0.3 + rand() * 0.8,
    phase: rand() * Math.PI * 2,
    size: 1 + rand() * 2.2,
    color: i % 3 === 0 ? '#fff7a8' : i % 3 === 1 ? '#a8d0ff' : '#ffb0e0',
  }));
})();

function DustLayer({ time }) {
  return (
    <>
      {DUST_SPECS.map((d, i) => {
        const y = (d.y0 - time * d.drift * 10) % BOARD_H;
        const adjustedY = y < 0 ? y + BOARD_H : y;
        const x = d.x0 + 6 * Math.sin(time * 0.7 + d.phase);
        const opacity = 0.4 + 0.4 * Math.sin(time * 1.5 + d.phase);
        return (
          <View key={`du${i}`} pointerEvents="none" style={{
            position: 'absolute',
            left: x, top: adjustedY,
            width: d.size, height: d.size, borderRadius: d.size,
            backgroundColor: d.color,
            opacity: opacity * 0.6,
          }} />
        );
      })}
    </>
  );
}

// Path flow — bright wave travels Start → Castle along the route.
// Cobblestone path tiles with neighbour-aware rendering. Each path cell
// gets a worn-stone look and the animated cyan wave still travels along it.
function PathLayer({ path, time }) {
  if (!path) return null;
  // Build a set of path coords for neighbour checks.
  const pathSet = new Set(path.map((p) => `${p.r},${p.c}`));
  const has = (r, c) => pathSet.has(`${r},${c}`);
  const len = path.length;
  const head = (time * 18) % (len + 20);
  return (
    <>
      {/* static cobblestone underlay */}
      {path.map((p, i) => {
        const cx = p.c * TILE + TILE / 2;
        const cy = p.r * TILE + TILE / 2;
        const left = p.c * TILE;
        const top = p.r * TILE;
        // Stable per-tile seed so each cobble has its own subtle look.
        const seed = (p.r * 73 + p.c * 31) & 0xff;
        const tint = 0.85 + ((seed * 7) % 30) / 100;
        const r1 = 8 + ((seed * 3) % 4); // primary cobble radius
        const r2 = 6 + ((seed * 5) % 3);
        // neighbour flags so we can blunt corners that face other path cells
        const n = has(p.r - 1, p.c);
        const s = has(p.r + 1, p.c);
        const w = has(p.r, p.c - 1);
        const e = has(p.r, p.c + 1);
        const base = `rgb(${Math.floor(60 * tint)}, ${Math.floor(80 * tint)}, ${Math.floor(120 * tint)})`;
        const baseHi = `rgb(${Math.floor(100 * tint)}, ${Math.floor(130 * tint)}, ${Math.floor(180 * tint)})`;
        return (
          <View key={`pb${i}`} pointerEvents="none" style={{
            position: 'absolute', left, top, width: TILE, height: TILE,
          }}>
            <Svg width={TILE} height={TILE}>
              {/* the path "bed" — bracketed by neighbours so corners merge */}
              <Rect
                x={w ? 0 : 2}
                y={n ? 0 : 2}
                width={TILE - (w ? 0 : 2) - (e ? 0 : 2)}
                height={TILE - (n ? 0 : 2) - (s ? 0 : 2)}
                rx={n || s || w || e ? 0 : 3}
                fill="#1a1530"
                stroke="#0a0510"
                strokeWidth="0.6"
              />
              {/* two main cobble stones */}
              <Circle cx={TILE / 2 - 4 + (seed % 3)} cy={TILE / 2 - 4 + ((seed >> 2) % 3)} r={r1 * 0.55} fill={base} stroke="#0a0510" strokeWidth="0.4" />
              <Circle cx={TILE / 2 + 3 + ((seed >> 3) % 3)} cy={TILE / 2 + 3 + ((seed >> 4) % 3)} r={r2 * 0.55} fill={baseHi} opacity="0.95" />
              {/* highlight pip */}
              <Circle cx={TILE / 2 - 4} cy={TILE / 2 - 4} r="1" fill="#fff" opacity="0.35" />
            </Svg>
          </View>
        );
      })}
      {/* animated red pulse — thin centered strip per path-tile,
          pulses in the direction enemies travel (Start → CP1..5 → Goal). */}
      {path.map((p, i) => {
        const dist = head - i;
        let brightness = 0;
        if (dist >= 0 && dist < 10) brightness = 1 - dist / 10;
        if (brightness <= 0.05) return null;
        return (
          <View key={`pw${i}`} pointerEvents="none" style={{
            position: 'absolute',
            left: p.c * TILE + TILE * 0.28,
            top: p.r * TILE + TILE * 0.28,
            width: TILE * 0.44,
            height: TILE * 0.44,
            borderRadius: TILE * 0.22,
            backgroundColor: '#ff4d6d',
            opacity: brightness * 0.55,
            shadowColor: '#ff4d6d',
            shadowOpacity: brightness * 0.9,
            shadowRadius: 6,
          }} />
        );
      })}
    </>
  );
}

// Tutorial / hint speech-balloon. Rounded rect with a small tail pointing
// toward the subject. Usage: <DialogBalloon text="Pinch to zoom" x={120} y={80} tail="down" />
function DialogBalloon({ text, x, y, tail = 'down', accent = '#ffd166', maxWidth = 220 }) {
  const tailSize = 10;
  return (
    <View pointerEvents="none" style={{
      position: 'absolute', left: x, top: y, maxWidth, alignItems: 'center',
    }}>
      <View style={{
        backgroundColor: '#0f1428ee',
        borderRadius: 10,
        paddingHorizontal: 12, paddingVertical: 8,
        borderWidth: 1.5, borderColor: accent,
        shadowColor: accent, shadowOpacity: 0.6, shadowRadius: 8,
      }}>
        <Text style={{ color: '#fff', fontSize: 13, fontWeight: '600', textAlign: 'center' }}>{text}</Text>
      </View>
      {tail === 'down' && (
        <View style={{
          width: 0, height: 0, marginTop: -1,
          borderLeftWidth: tailSize, borderRightWidth: tailSize, borderTopWidth: tailSize,
          borderLeftColor: 'transparent', borderRightColor: 'transparent',
          borderTopColor: accent,
        }} />
      )}
      {tail === 'up' && (
        <View style={{
          width: 0, height: 0, marginBottom: -1, position: 'absolute', top: -tailSize, alignSelf: 'center',
          borderLeftWidth: tailSize, borderRightWidth: tailSize, borderBottomWidth: tailSize,
          borderLeftColor: 'transparent', borderRightColor: 'transparent',
          borderBottomColor: accent,
        }} />
      )}
    </View>
  );
}

function Marker({ pt, label, color }) {
  return (
    <View pointerEvents="none" style={[styles.marker, { left: pt.c * TILE, top: pt.r * TILE, backgroundColor: color }]}>
      <Text style={styles.markerText}>{label}</Text>
    </View>
  );
}

// ───── Spawn portal — arched cave entrance with red glow ────────────────────
function SpawnPortal({ pt, time }) {
  const size = TILE * 3.25;
  const left = pt.c * TILE - TILE * 2.1;
  const top = pt.r * TILE - TILE * 1.08;
  if (USE_SPRITES.decor && ASSET_MAP.decor.spawn_portal) {
    return (
      <RemoteSprite
        source={ASSET_MAP.decor.spawn_portal}
        style={{
          position: 'absolute',
          left,
          top,
          width: size,
          height: size,
          shadowColor: '#ff4d6d',
          shadowOpacity: 0.55,
          shadowRadius: 14,
          shadowOffset: { width: 0, height: 2 },
        }}
      >
        <SpawnPortalFallback pt={pt} time={time} />
      </RemoteSprite>
    );
  }
  return <SpawnPortalFallback pt={pt} time={time} />;
}

function SpawnPortalFallback({ pt, time }) {
  const flicker = 0.75 + 0.25 * Math.sin(time * 5);
  const flicker2 = 0.7 + 0.3 * Math.sin(time * 7 + 1.2);
  const flicker3 = 0.7 + 0.3 * Math.sin(time * 9 + 0.5);
  // Three smoke wisps with offset rise positions
  const smoke1 = (time * 6) % 30;
  const smoke2 = (time * 6 + 10) % 30;
  const smoke3 = (time * 6 + 20) % 30;
  // Two ember sparks
  const ember1 = (time * 9) % 28;
  const ember2 = (time * 9 + 14) % 28;
  const size = TILE * 3;
  // center the 3-tile portal on the spawn cell, extending into the wall to the left
  const left = pt.c * TILE - TILE * 2;
  const top = pt.r * TILE - TILE;
  return (
    <View pointerEvents="none" style={{ position: 'absolute', left, top, width: size, height: size }}>
      <Svg width={size} height={size} viewBox="0 0 66 66">
        <Defs>
          {/* corrupted stone — same warm beige as castle, slightly darker / red-tinted */}
          <LinearGradient id="pStone" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor="#d8c098" />
            <Stop offset="0.15" stopColor="#a08868" />
            <Stop offset="0.6" stopColor="#604838" />
            <Stop offset="1" stopColor="#3a1a14" />
          </LinearGradient>
          {/* shadow-side stone */}
          <LinearGradient id="pStoneDark" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor="#8a7050" />
            <Stop offset="1" stopColor="#3a1a14" />
          </LinearGradient>
          {/* deep portal cave — 4-stop gradient red→black */}
          <RadialGradient id="pDepth" cx="0.5" cy="0.6" r="0.55">
            <Stop offset="0" stopColor="#ff4d6d" stopOpacity="0.85" />
            <Stop offset="0.35" stopColor="#7a1d2e" stopOpacity="0.95" />
            <Stop offset="0.85" stopColor="#1a0006" stopOpacity="1" />
            <Stop offset="1" stopColor="#000" stopOpacity="1" />
          </RadialGradient>
          {/* outer red glow */}
          <RadialGradient id="pGlow" cx="0.5" cy="0.5" r="0.65">
            <Stop offset="0" stopColor="#ff4d6d" stopOpacity={0.6 * flicker} />
            <Stop offset="1" stopColor="#ff4d6d" stopOpacity="0" />
          </RadialGradient>
          {/* keystone glowing gem */}
          <RadialGradient id="pGem" cx="0.5" cy="0.5" r="0.5">
            <Stop offset="0" stopColor="#fff" />
            <Stop offset="0.3" stopColor="#fff7a8" />
            <Stop offset="0.6" stopColor="#ff4d6d" />
            <Stop offset="1" stopColor="#7a0e1e" />
          </RadialGradient>
          {/* drop shadow */}
          <RadialGradient id="pDrop" cx="0.5" cy="0.5" r="0.5">
            <Stop offset="0" stopColor="#000" stopOpacity="0.85" />
            <Stop offset="1" stopColor="#000" stopOpacity="0" />
          </RadialGradient>
        </Defs>

        {/* outer red glow wash */}
        <Rect x="0" y="0" width="66" height="66" fill="url(#pGlow)" />

        {/* drop shadow at base */}
        <Ellipse cx="33" cy="63" rx="32" ry="4" fill="url(#pDrop)" />

        {/* === FLOOR COBBLES AT BASE === */}
        <Ellipse cx="10" cy="61" rx="3.5" ry="1.5" fill="#604838" stroke="#1a0c08" strokeWidth="0.5" />
        <Path d="M 7 60 L 13 60" stroke="#a08858" strokeWidth="0.4" opacity="0.7" />
        <Ellipse cx="17" cy="61" rx="3" ry="1.5" fill="#8a6848" stroke="#1a0c08" strokeWidth="0.5" />
        <Path d="M 14 60 L 20 60" stroke="#c4a878" strokeWidth="0.4" opacity="0.7" />
        <Ellipse cx="33" cy="62" rx="4" ry="1.5" fill="#604838" stroke="#1a0c08" strokeWidth="0.5" />
        <Ellipse cx="49" cy="61" rx="3" ry="1.5" fill="#8a6848" stroke="#1a0c08" strokeWidth="0.5" />
        <Ellipse cx="56" cy="61" rx="3.5" ry="1.5" fill="#604838" stroke="#1a0c08" strokeWidth="0.5" />

        {/* === LEFT FLANKING COLUMN === */}
        {/* column shaft */}
        <Rect x="1" y="22" width="6" height="36" fill="url(#pStone)" stroke="#1a0c08" strokeWidth="1.2" />
        {/* block course lines */}
        <Path d="M 1 28 L 7 28" stroke="#1a0c08" strokeWidth="0.4" opacity="0.65" />
        <Path d="M 1 34 L 7 34" stroke="#1a0c08" strokeWidth="0.4" opacity="0.65" />
        <Path d="M 1 40 L 7 40" stroke="#1a0c08" strokeWidth="0.4" opacity="0.65" />
        <Path d="M 1 46 L 7 46" stroke="#1a0c08" strokeWidth="0.4" opacity="0.65" />
        <Path d="M 1 52 L 7 52" stroke="#1a0c08" strokeWidth="0.4" opacity="0.65" />
        {/* rim light */}
        <Path d="M 2 23 L 2 57" stroke="#e8c898" strokeWidth="0.6" opacity="0.7" />
        {/* capital (top) */}
        <Path d="M -1 22 L 9 22 L 8 19 L 0 19 Z" fill="url(#pStone)" stroke="#1a0c08" strokeWidth="1" />
        <Path d="M 0 19 L 8 19" stroke="#e8c898" strokeWidth="0.4" opacity="0.75" />
        {/* upper capital block */}
        <Rect x="0" y="16" width="8" height="3" fill="url(#pStone)" stroke="#1a0c08" strokeWidth="0.8" />
        {/* red gem set in capital */}
        <Polygon points="4,16 6,18 4,20 2,18" fill="#ff4d6d" stroke="#7a1d2e" strokeWidth="0.4" />
        <Circle cx="4" cy="18" r="0.6" fill="#fff" opacity={0.85 * flicker3} />
        {/* column base */}
        <Rect x="-1" y="58" width="9" height="2" fill="url(#pStoneDark)" stroke="#1a0c08" strokeWidth="0.8" />
        {/* weathering crack */}
        <Path d="M 4 28 L 5 38 L 3 48" stroke="#3a1a14" strokeWidth="0.4" fill="none" opacity="0.7" />
        {/* iron ring with chain (decorative) */}
        <Circle cx="6" cy="36" r="0.9" fill="none" stroke="#1a1820" strokeWidth="0.6" />
        <Path d="M 6 37 L 7 39 L 6 41" stroke="#1a1820" strokeWidth="0.4" fill="none" />

        {/* === RIGHT FLANKING COLUMN === */}
        <Rect x="59" y="22" width="6" height="36" fill="url(#pStone)" stroke="#1a0c08" strokeWidth="1.2" />
        <Path d="M 59 28 L 65 28" stroke="#1a0c08" strokeWidth="0.4" opacity="0.65" />
        <Path d="M 59 34 L 65 34" stroke="#1a0c08" strokeWidth="0.4" opacity="0.65" />
        <Path d="M 59 40 L 65 40" stroke="#1a0c08" strokeWidth="0.4" opacity="0.65" />
        <Path d="M 59 46 L 65 46" stroke="#1a0c08" strokeWidth="0.4" opacity="0.65" />
        <Path d="M 59 52 L 65 52" stroke="#1a0c08" strokeWidth="0.4" opacity="0.65" />
        <Path d="M 60 23 L 60 57" stroke="#e8c898" strokeWidth="0.6" opacity="0.7" />
        <Path d="M 57 22 L 67 22 L 66 19 L 58 19 Z" fill="url(#pStone)" stroke="#1a0c08" strokeWidth="1" />
        <Path d="M 58 19 L 66 19" stroke="#e8c898" strokeWidth="0.4" opacity="0.75" />
        <Rect x="58" y="16" width="8" height="3" fill="url(#pStone)" stroke="#1a0c08" strokeWidth="0.8" />
        <Polygon points="62,16 64,18 62,20 60,18" fill="#ff4d6d" stroke="#7a1d2e" strokeWidth="0.4" />
        <Circle cx="62" cy="18" r="0.6" fill="#fff" opacity={0.85 * flicker3} />
        <Rect x="57" y="58" width="9" height="2" fill="url(#pStoneDark)" stroke="#1a0c08" strokeWidth="0.8" />
        <Path d="M 62 32 L 61 42 L 63 52" stroke="#3a1a14" strokeWidth="0.4" fill="none" opacity="0.7" />
        <Circle cx="60" cy="40" r="0.9" fill="none" stroke="#1a1820" strokeWidth="0.6" />
        <Path d="M 60 41 L 59 43 L 60 45" stroke="#1a1820" strokeWidth="0.4" fill="none" />

        {/* === MAIN ARCH OUTER SHAPE === */}
        <Path d="M 8 60 L 8 30 Q 8 10 33 10 Q 58 10 58 30 L 58 60 Z" fill="url(#pStone)" stroke="#1a0c08" strokeWidth="1.8" />
        {/* arch outer rim light */}
        <Path d="M 8 30 Q 8 10 33 10 Q 58 10 58 30" stroke="#e8c898" strokeWidth="1" fill="none" opacity="0.7" />

        {/* === VOUSSOIRS (5 wedge stones per side, alternating colors) === */}
        {/* left side wedges */}
        <Path d="M 8 30 L 12 28 L 13 33 L 9 35 Z" fill="#a08868" stroke="#1a0c08" strokeWidth="0.5" />
        <Path d="M 9 25 L 13 22 L 14 27 L 10 30 Z" fill="#8a7050" stroke="#1a0c08" strokeWidth="0.5" />
        <Path d="M 11 20 L 16 17 L 18 22 L 13 24 Z" fill="#a08868" stroke="#1a0c08" strokeWidth="0.5" />
        <Path d="M 15 15 L 21 13 L 22 18 L 17 20 Z" fill="#8a7050" stroke="#1a0c08" strokeWidth="0.5" />
        <Path d="M 21 12 L 27 11 L 28 15 L 22 17 Z" fill="#a08868" stroke="#1a0c08" strokeWidth="0.5" />
        {/* rim light highlights on left wedges (top edges) */}
        <Path d="M 9 25 L 13 22" stroke="#e8c898" strokeWidth="0.3" opacity="0.65" />
        <Path d="M 15 15 L 21 13" stroke="#e8c898" strokeWidth="0.3" opacity="0.65" />

        {/* right side wedges (mirror) */}
        <Path d="M 58 30 L 54 28 L 53 33 L 57 35 Z" fill="#a08868" stroke="#1a0c08" strokeWidth="0.5" />
        <Path d="M 57 25 L 53 22 L 52 27 L 56 30 Z" fill="#8a7050" stroke="#1a0c08" strokeWidth="0.5" />
        <Path d="M 55 20 L 50 17 L 48 22 L 53 24 Z" fill="#a08868" stroke="#1a0c08" strokeWidth="0.5" />
        <Path d="M 51 15 L 45 13 L 44 18 L 49 20 Z" fill="#8a7050" stroke="#1a0c08" strokeWidth="0.5" />
        <Path d="M 45 12 L 39 11 L 38 15 L 44 17 Z" fill="#a08868" stroke="#1a0c08" strokeWidth="0.5" />
        <Path d="M 57 25 L 53 22" stroke="#e8c898" strokeWidth="0.3" opacity="0.65" />
        <Path d="M 51 15 L 45 13" stroke="#e8c898" strokeWidth="0.3" opacity="0.65" />

        {/* === KEYSTONE (prominent, glowing gem) === */}
        <Path d="M 28 10 L 38 10 L 40 17 L 26 17 Z" fill="#a08868" stroke="#1a0c08" strokeWidth="1.2" />
        <Path d="M 28 10 L 38 10" stroke="#fff7a8" strokeWidth="0.6" opacity="0.8" />
        {/* outer glow around keystone gem */}
        <Circle cx="33" cy="14" r="6" fill="#ff4d6d" opacity={0.28 * flicker} />
        {/* keystone gem itself */}
        <Polygon points="33,11.5 36,14 33,17 30,14" fill="url(#pGem)" stroke="#1a0c08" strokeWidth="0.6" />
        <Circle cx="32" cy="13.5" r="0.7" fill="#fff" opacity="0.95" />

        {/* === PORTAL OPENING (deep cave) === */}
        <Path d="M 14 58 L 14 30 Q 14 16 33 16 Q 52 16 52 30 L 52 58 Z" fill="url(#pDepth)" stroke="#1a0c08" strokeWidth="1.2" />

        {/* === RECEDING INNER ARCH LINES (3 levels of depth illusion) === */}
        <Path d="M 20 56 L 20 34 Q 20 22 33 22 Q 46 22 46 34 L 46 56 Z"
              fill="none" stroke="#7a1d2e" strokeWidth="0.6" opacity="0.55" />
        <Path d="M 24 54 L 24 36 Q 24 26 33 26 Q 42 26 42 36 L 42 54 Z"
              fill="none" stroke="#7a1d2e" strokeWidth="0.4" opacity="0.42" />
        <Path d="M 28 52 L 28 40 Q 28 32 33 32 Q 38 32 38 40 L 38 52 Z"
              fill="none" stroke="#5a0d1e" strokeWidth="0.3" opacity="0.3" />

        {/* === RED RUNES INSIDE === */}
        {/* triangle rune (lower-left) */}
        <Path d="M 22 48 L 26 44 L 30 48 Z" fill="none" stroke="#ff4d6d" strokeWidth="0.7" opacity={0.6 * flicker2} />
        <Circle cx="26" cy="47" r="0.6" fill="#ff4d6d" opacity={flicker2} />
        {/* cross rune (upper-right) */}
        <Path d="M 38 36 L 42 36 M 40 34 L 40 38" stroke="#ff4d6d" strokeWidth="0.7" fill="none" opacity={0.55 * flicker2} />
        <Circle cx="40" cy="36" r="0.5" fill="#ff4d6d" opacity={flicker2} />
        {/* glowing eye (lower-right) */}
        <Ellipse cx="44" cy="50" rx="2" ry="1.2" fill="#0a0006" stroke="#ff4d6d" strokeWidth="0.4" opacity={flicker} />
        <Circle cx="44" cy="50" r="0.8" fill="#ff4d6d" opacity={flicker} />
        <Circle cx="44" cy="50" r="0.3" fill="#fff" opacity={flicker} />

        {/* === BLOOD DRIPS FROM ARCH TOP === */}
        <Path d="M 22 18 Q 21 24 22 28" stroke="#7a0e1e" strokeWidth="0.6" fill="none" opacity="0.85" />
        <Circle cx="22" cy="28" r="0.7" fill="#7a0e1e" opacity="0.9" />
        <Path d="M 44 18 Q 45 22 44 26" stroke="#7a0e1e" strokeWidth="0.5" fill="none" opacity="0.75" />
        <Circle cx="44" cy="26" r="0.5" fill="#7a0e1e" opacity="0.85" />

        {/* === SMOKE WISPS (animated, rising from opening) === */}
        <Circle cx={33 + Math.sin(time * 2) * 1.5} cy={22 - smoke1 * 0.5} r={2.5 + smoke1 * 0.05}
                fill="#5a1818" opacity={Math.max(0, 0.45 - smoke1 * 0.018)} />
        <Circle cx={33 + Math.sin(time * 2 + 1.5) * 1.5} cy={22 - smoke2 * 0.5} r={2 + smoke2 * 0.05}
                fill="#7a1d2e" opacity={Math.max(0, 0.4 - smoke2 * 0.016)} />
        <Circle cx={33 + Math.sin(time * 2 + 3) * 1.5} cy={22 - smoke3 * 0.5} r={3 + smoke3 * 0.04}
                fill="#3a0a14" opacity={Math.max(0, 0.5 - smoke3 * 0.02)} />

        {/* === EMBER SPARKS rising with smoke === */}
        <Circle cx={31 + Math.sin(time * 4) * 2} cy={24 - ember1 * 0.55} r="0.5"
                fill="#ffd166" opacity={Math.max(0, 1 - ember1 * 0.04)} />
        <Circle cx={35 + Math.sin(time * 4 + 2) * 2} cy={24 - ember2 * 0.55} r="0.4"
                fill="#ff6f1f" opacity={Math.max(0, 0.9 - ember2 * 0.04)} />

        {/* === THRESHOLD STONES === */}
        <Rect x="6" y="56" width="54" height="3" fill="#604838" stroke="#1a0c08" strokeWidth="0.7" />
        <Path d="M 6 56 L 60 56" stroke="#e8c898" strokeWidth="0.4" opacity="0.6" />
        {/* threshold seam lines */}
        <Path d="M 14 56 L 14 59" stroke="#1a0c08" strokeWidth="0.5" opacity="0.7" />
        <Path d="M 22 56 L 22 59" stroke="#1a0c08" strokeWidth="0.5" opacity="0.7" />
        <Path d="M 33 56 L 33 59" stroke="#1a0c08" strokeWidth="0.5" opacity="0.7" />
        <Path d="M 44 56 L 44 59" stroke="#1a0c08" strokeWidth="0.5" opacity="0.7" />
        <Path d="M 52 56 L 52 59" stroke="#1a0c08" strokeWidth="0.5" opacity="0.7" />
        {/* lower threshold step */}
        <Rect x="4" y="59" width="58" height="2" fill="#3a2818" stroke="#1a0c08" strokeWidth="0.6" />

        {/* === SKULLS AT BASE === */}
        {/* left skull */}
        <Ellipse cx="14" cy="55" rx="2.5" ry="2" fill="#e8e0c8" stroke="#1a0c08" strokeWidth="0.6" />
        <Circle cx="13" cy="54.8" r="0.6" fill="#1a0c08" />
        <Circle cx="15" cy="54.8" r="0.6" fill="#1a0c08" />
        <Path d="M 12.5 56.5 L 15.5 56.5" stroke="#1a0c08" strokeWidth="0.3" />
        <Path d="M 13 56 L 14 56.6 L 15 56" stroke="#1a0c08" strokeWidth="0.3" />
        {/* right skull */}
        <Ellipse cx="52" cy="55" rx="2.5" ry="2" fill="#e8e0c8" stroke="#1a0c08" strokeWidth="0.6" />
        <Circle cx="51" cy="54.8" r="0.6" fill="#1a0c08" />
        <Circle cx="53" cy="54.8" r="0.6" fill="#1a0c08" />
        <Path d="M 50.5 56.5 L 53.5 56.5" stroke="#1a0c08" strokeWidth="0.3" />
        <Path d="M 51 56 L 52 56.6 L 53 56" stroke="#1a0c08" strokeWidth="0.3" />
        {/* center smaller skull */}
        <Ellipse cx="33" cy="55.5" rx="2" ry="1.5" fill="#e8e0c8" stroke="#1a0c08" strokeWidth="0.5" />
        <Circle cx="32.3" cy="55.4" r="0.4" fill="#1a0c08" />
        <Circle cx="33.7" cy="55.4" r="0.4" fill="#1a0c08" />
        <Path d="M 31.8 56.6 L 34.2 56.6" stroke="#1a0c08" strokeWidth="0.25" />

        {/* === SCATTERED BONES === */}
        <Rect x="22" y="57.8" width="4" height="0.6" rx="0.3" fill="#e8e0c8" stroke="#1a0c08" strokeWidth="0.3" />
        <Ellipse cx="22" cy="58.1" rx="0.6" ry="0.4" fill="#e8e0c8" stroke="#1a0c08" strokeWidth="0.3" />
        <Ellipse cx="26" cy="58.1" rx="0.6" ry="0.4" fill="#e8e0c8" stroke="#1a0c08" strokeWidth="0.3" />
        <Rect x="40" y="57.8" width="4" height="0.6" rx="0.3" fill="#e8e0c8" stroke="#1a0c08" strokeWidth="0.3" />
        <Ellipse cx="40" cy="58.1" rx="0.6" ry="0.4" fill="#e8e0c8" stroke="#1a0c08" strokeWidth="0.3" />
        <Ellipse cx="44" cy="58.1" rx="0.6" ry="0.4" fill="#e8e0c8" stroke="#1a0c08" strokeWidth="0.3" />

        {/* === CRACKS RADIATING FROM ARCH BASE === */}
        <Path d="M 9 60 L 4 64" stroke="#3a1818" strokeWidth="0.6" opacity="0.75" />
        <Path d="M 6 57 L 0 60" stroke="#3a1818" strokeWidth="0.5" opacity="0.7" />
        <Path d="M 57 60 L 62 64" stroke="#3a1818" strokeWidth="0.6" opacity="0.75" />
        <Path d="M 60 57 L 66 60" stroke="#3a1818" strokeWidth="0.5" opacity="0.7" />
        {/* small cracks on the arch face */}
        <Path d="M 16 28 L 18 32 L 15 34" stroke="#3a1818" strokeWidth="0.3" fill="none" opacity="0.6" />
        <Path d="M 48 28 L 46 32 L 49 34" stroke="#3a1818" strokeWidth="0.3" fill="none" opacity="0.6" />
      </Svg>
    </View>
  );
}

// ───── Castle keep — fortress with towers, battlements, banner ─────────────
function CastleKeep({ pt, time }) {
  const size = TILE * 3.2;
  const left = pt.c * TILE - TILE * 2.1;
  const top = pt.r * TILE - TILE * 1.08;
  if (USE_SPRITES.decor && ASSET_MAP.decor.castle_keep) {
    return (
      <RemoteSprite
        source={ASSET_MAP.decor.castle_keep}
        style={{
          position: 'absolute',
          left,
          top,
          width: size,
          height: size,
          shadowColor: '#7be5d1',
          shadowOpacity: 0.5,
          shadowRadius: 14,
          shadowOffset: { width: 0, height: 3 },
        }}
      >
        <CastleKeepFallback pt={pt} time={time} />
      </RemoteSprite>
    );
  }
  return <CastleKeepFallback pt={pt} time={time} />;
}

function CastleKeepFallback({ pt, time }) {
  // Three independent flag-wave phases so they don't sync up.
  const wave1 = Math.sin(time * 3) * 1.5;
  const wave2 = Math.sin(time * 2.6 + 0.8) * 1.2;
  const wave3 = Math.sin(time * 3.4 + 2.0) * 1.0;
  const size = TILE * 3;
  // center on the goal cell, extending into the right wall
  const left = pt.c * TILE - TILE * 2;
  const top = pt.r * TILE - TILE;
  return (
    <View pointerEvents="none" style={{ position: 'absolute', left, top, width: size, height: size }}>
      <Svg width={size} height={size} viewBox="0 0 66 66">
        <Defs>
          {/* warm beige fortress stone — Kingdom Rush palette */}
          <LinearGradient id="cStone" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor="#f0d8a8" />
            <Stop offset="0.12" stopColor="#c4a878" />
            <Stop offset="0.6" stopColor="#8a6848" />
            <Stop offset="1" stopColor="#3a2818" />
          </LinearGradient>
          {/* slightly darker stone for shadow side */}
          <LinearGradient id="cStoneDark" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor="#a08858" />
            <Stop offset="1" stopColor="#3a2818" />
          </LinearGradient>
          {/* emerald shingled roof */}
          <LinearGradient id="cRoof" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor="#b8f8c8" />
            <Stop offset="0.2" stopColor="#5cf28a" />
            <Stop offset="0.7" stopColor="#1a6a30" />
            <Stop offset="1" stopColor="#0a3818" />
          </LinearGradient>
          {/* dark wood gate */}
          <LinearGradient id="cWood" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor="#8a5028" />
            <Stop offset="0.4" stopColor="#5a3018" />
            <Stop offset="1" stopColor="#2a1008" />
          </LinearGradient>
          {/* window glow */}
          <RadialGradient id="cWin" cx="0.5" cy="0.5" r="0.5">
            <Stop offset="0" stopColor="#fff7a8" />
            <Stop offset="0.6" stopColor="#ffd166" />
            <Stop offset="1" stopColor="#7a5018" />
          </RadialGradient>
          {/* drop shadow */}
          <RadialGradient id="cDrop" cx="0.5" cy="0.5" r="0.5">
            <Stop offset="0" stopColor="#000" stopOpacity="0.75" />
            <Stop offset="1" stopColor="#000" stopOpacity="0" />
          </RadialGradient>
        </Defs>

        {/* big drop shadow on ground */}
        <Ellipse cx="33" cy="63" rx="34" ry="4.5" fill="url(#cDrop)" />

        {/* === FOUNDATION: stepped stone base === */}
        <Path d="M 0 61 L 66 61 L 64 65 L 2 65 Z" fill="url(#cStoneDark)" stroke="#1a0c08" strokeWidth="1.2" />
        <Path d="M 2 59 L 64 59 L 62 61 L 4 61 Z" fill="#a08858" stroke="#1a0c08" strokeWidth="1" />
        {/* foundation rim light */}
        <Path d="M 2 59 L 64 59" stroke="#e8c898" strokeWidth="0.5" opacity="0.75" />
        {/* grass tufts at base */}
        <Path d="M 8 59 L 7.5 57 M 8 59 L 8 56.5 M 8 59 L 8.5 57" stroke="#5cf28a" strokeWidth="0.7" />
        <Path d="M 14 59 L 13.5 57.5 M 14 59 L 14.5 57.5" stroke="#5cf28a" strokeWidth="0.6" />
        <Path d="M 52 59 L 51.5 57 M 52 59 L 52 56.5 M 52 59 L 52.5 57" stroke="#5cf28a" strokeWidth="0.7" />
        <Path d="M 58 59 L 57.5 57.5 M 58 59 L 58.5 57.5" stroke="#5cf28a" strokeWidth="0.6" />

        {/* === LEFT TOWER === */}
        {/* tower body */}
        <Rect x="4" y="22" width="18" height="37" fill="url(#cStone)" stroke="#1a0c08" strokeWidth="1.5" />
        {/* stone block horizontal courses */}
        <Path d="M 4 28 L 22 28" stroke="#1a0c08" strokeWidth="0.5" opacity="0.55" />
        <Path d="M 4 34 L 22 34" stroke="#1a0c08" strokeWidth="0.5" opacity="0.55" />
        <Path d="M 4 40 L 22 40" stroke="#1a0c08" strokeWidth="0.5" opacity="0.55" />
        <Path d="M 4 46 L 22 46" stroke="#1a0c08" strokeWidth="0.5" opacity="0.55" />
        <Path d="M 4 52 L 22 52" stroke="#1a0c08" strokeWidth="0.5" opacity="0.55" />
        {/* alternating vertical joints (running bond) */}
        <Path d="M 10 22 L 10 28 M 16 22 L 16 28" stroke="#1a0c08" strokeWidth="0.4" opacity="0.45" />
        <Path d="M 7 28 L 7 34 M 13 28 L 13 34 M 19 28 L 19 34" stroke="#1a0c08" strokeWidth="0.4" opacity="0.45" />
        <Path d="M 10 34 L 10 40 M 16 34 L 16 40" stroke="#1a0c08" strokeWidth="0.4" opacity="0.45" />
        <Path d="M 7 40 L 7 46 M 13 40 L 13 46 M 19 40 L 19 46" stroke="#1a0c08" strokeWidth="0.4" opacity="0.45" />
        <Path d="M 10 46 L 10 52 M 16 46 L 16 52" stroke="#1a0c08" strokeWidth="0.4" opacity="0.45" />
        <Path d="M 7 52 L 7 59 M 13 52 L 13 59 M 19 52 L 19 59" stroke="#1a0c08" strokeWidth="0.4" opacity="0.45" />
        {/* rim light on left edge */}
        <Path d="M 5 23 L 5 58" stroke="#f8e8c0" strokeWidth="0.9" opacity="0.7" />
        {/* battlement cap strip */}
        <Path d="M 3 22 L 23 22 L 22 24 L 4 24 Z" fill="#8a6848" stroke="#1a0c08" strokeWidth="0.8" />
        <Path d="M 3 22 L 23 22" stroke="#e8c898" strokeWidth="0.4" opacity="0.7" />
        {/* battlement merlons (with cap stones) */}
        <Rect x="3" y="17" width="4" height="6" fill="url(#cStone)" stroke="#1a0c08" strokeWidth="0.8" />
        <Path d="M 2 17 L 8 17" stroke="#1a0c08" strokeWidth="0.6" />
        <Rect x="9" y="17" width="4" height="6" fill="url(#cStone)" stroke="#1a0c08" strokeWidth="0.8" />
        <Path d="M 8 17 L 14 17" stroke="#1a0c08" strokeWidth="0.6" />
        <Rect x="15" y="17" width="4" height="6" fill="url(#cStone)" stroke="#1a0c08" strokeWidth="0.8" />
        <Path d="M 14 17 L 20 17" stroke="#1a0c08" strokeWidth="0.6" />
        {/* tower roof — peaked with shingles */}
        <Polygon points="2,17 24,17 13,1" fill="url(#cRoof)" stroke="#0a3818" strokeWidth="1.5" />
        {/* shingle rows (zigzag) */}
        <Path d="M 4 14 L 7 12.5 L 10 14 L 13 12.5 L 16 14 L 19 12.5 L 22 14" stroke="#0a3818" strokeWidth="0.5" fill="none" opacity="0.65" />
        <Path d="M 6 10 L 9 8.5 L 12 10 L 15 8.5 L 18 10 L 20 8.5" stroke="#0a3818" strokeWidth="0.5" fill="none" opacity="0.55" />
        <Path d="M 8 6 L 11 5 L 14 6 L 16 5" stroke="#0a3818" strokeWidth="0.4" fill="none" opacity="0.5" />
        {/* roof apex rim light */}
        <Path d="M 2 17 L 13 1" stroke="#fff" strokeWidth="1.2" opacity="0.6" />
        <Path d="M 13 1 L 24 17" stroke="#0a3818" strokeWidth="0.8" opacity="0.7" />
        {/* roof finial */}
        <Circle cx="13" cy="1" r="0.8" fill="#ffd166" stroke="#3a2806" strokeWidth="0.3" />
        {/* tower flag (left) */}
        <Rect x="12.5" y="-5" width="1" height="6" fill="#3a2806" />
        <Path
          d={`M 13 -4 L ${17 + wave2} -2 L ${16 + wave2} 0 L 13 -1 Z`}
          fill="#ff4d6d" stroke="#7a1d2e" strokeWidth="0.4"
        />
        {/* upper window with arch + glow */}
        <Path d="M 8 33 L 8 39 Q 8 41 10 41 Q 12 41 12 39 L 12 33 Z" fill="url(#cWin)" stroke="#1a0c08" strokeWidth="0.6" />
        <Circle cx="10" cy="38" r="3.5" fill="#ffd166" opacity="0.22" />
        <Path d="M 14 33 L 14 39 Q 14 41 16 41 Q 18 41 18 39 L 18 33 Z" fill="url(#cWin)" stroke="#1a0c08" strokeWidth="0.6" />
        <Circle cx="16" cy="38" r="3.5" fill="#ffd166" opacity="0.22" />
        {/* lower window */}
        <Path d="M 11 47 L 11 52 Q 11 54 13 54 Q 15 54 15 52 L 15 47 Z" fill="url(#cWin)" stroke="#1a0c08" strokeWidth="0.5" opacity="0.85" />
        <Circle cx="13" cy="51" r="2.5" fill="#ffd166" opacity="0.18" />

        {/* === CENTRAL KEEP === */}
        {/* keep body */}
        <Rect x="23" y="24" width="20" height="35" fill="url(#cStone)" stroke="#1a0c08" strokeWidth="1.5" />
        {/* horizontal courses */}
        <Path d="M 23 30 L 43 30" stroke="#1a0c08" strokeWidth="0.5" opacity="0.55" />
        <Path d="M 23 36 L 43 36" stroke="#1a0c08" strokeWidth="0.5" opacity="0.55" />
        <Path d="M 23 42 L 43 42" stroke="#1a0c08" strokeWidth="0.5" opacity="0.55" />
        <Path d="M 23 48 L 43 48" stroke="#1a0c08" strokeWidth="0.5" opacity="0.55" />
        <Path d="M 23 54 L 43 54" stroke="#1a0c08" strokeWidth="0.5" opacity="0.55" />
        {/* alternating vertical joints */}
        <Path d="M 28 24 L 28 30 M 35 24 L 35 30" stroke="#1a0c08" strokeWidth="0.4" opacity="0.45" />
        <Path d="M 25 30 L 25 36 M 31 30 L 31 36 M 38 30 L 38 36" stroke="#1a0c08" strokeWidth="0.4" opacity="0.45" />
        <Path d="M 28 36 L 28 42 M 35 36 L 35 42" stroke="#1a0c08" strokeWidth="0.4" opacity="0.45" />
        <Path d="M 25 42 L 25 48 M 31 42 L 31 48 M 38 42 L 38 48" stroke="#1a0c08" strokeWidth="0.4" opacity="0.45" />
        <Path d="M 28 48 L 28 54 M 35 48 L 35 54" stroke="#1a0c08" strokeWidth="0.4" opacity="0.45" />
        {/* keep rim light */}
        <Path d="M 24 25 L 24 58" stroke="#f8e8c0" strokeWidth="0.8" opacity="0.65" />
        {/* battlement strip */}
        <Path d="M 22 24 L 44 24 L 43 26 L 23 26 Z" fill="#8a6848" stroke="#1a0c08" strokeWidth="0.8" />
        <Path d="M 22 24 L 44 24" stroke="#e8c898" strokeWidth="0.4" opacity="0.7" />
        {/* keep merlons */}
        <Rect x="22" y="19" width="4" height="5" fill="url(#cStone)" stroke="#1a0c08" strokeWidth="0.8" />
        <Path d="M 21 19 L 27 19" stroke="#1a0c08" strokeWidth="0.6" />
        <Rect x="28" y="19" width="4" height="5" fill="url(#cStone)" stroke="#1a0c08" strokeWidth="0.8" />
        <Path d="M 27 19 L 33 19" stroke="#1a0c08" strokeWidth="0.6" />
        <Rect x="34" y="19" width="4" height="5" fill="url(#cStone)" stroke="#1a0c08" strokeWidth="0.8" />
        <Path d="M 33 19 L 39 19" stroke="#1a0c08" strokeWidth="0.6" />
        <Rect x="40" y="19" width="4" height="5" fill="url(#cStone)" stroke="#1a0c08" strokeWidth="0.8" />
        <Path d="M 39 19 L 45 19" stroke="#1a0c08" strokeWidth="0.6" />
        {/* keep roof — taller peak */}
        <Polygon points="22,19 44,19 33,3" fill="url(#cRoof)" stroke="#0a3818" strokeWidth="1.5" />
        {/* shingle rows */}
        <Path d="M 24 16 L 28 14.5 L 32 16 L 36 14.5 L 40 16" stroke="#0a3818" strokeWidth="0.5" fill="none" opacity="0.65" />
        <Path d="M 26 12 L 30 10.5 L 33 12 L 36 10.5 L 39 12" stroke="#0a3818" strokeWidth="0.5" fill="none" opacity="0.55" />
        <Path d="M 28 8 L 31 6.5 L 33 8 L 35 6.5 L 37 8" stroke="#0a3818" strokeWidth="0.4" fill="none" opacity="0.5" />
        {/* roof rim light */}
        <Path d="M 22 19 L 33 3" stroke="#fff" strokeWidth="1.2" opacity="0.6" />
        <Path d="M 33 3 L 44 19" stroke="#0a3818" strokeWidth="0.8" opacity="0.7" />
        {/* roof finial */}
        <Circle cx="33" cy="3" r="1" fill="#ffd166" stroke="#3a2806" strokeWidth="0.3" />
        {/* main flag (biggest, waving) */}
        <Rect x="32.5" y="-6" width="1.2" height="9" fill="#3a2806" />
        {/* flag triangle pennant */}
        <Path
          d={`M 33 -4 L ${44 + wave1} 0 L ${42 + wave1} 8 L 33 6 Z`}
          fill="#5cf28a"
          stroke="#0a3818"
          strokeWidth="0.6"
        />
        <Path
          d={`M 33 -2 L ${40 + wave1 * 0.7} 1 L ${39 + wave1 * 0.7} 4 L 33 2 Z`}
          fill="#fff" opacity="0.3"
        />
        {/* heraldry star */}
        <Polygon
          points={`${37 + wave1 * 0.5},-2 ${38 + wave1 * 0.5},1 ${41 + wave1 * 0.5},1 ${38.5 + wave1 * 0.5},3 ${39.5 + wave1 * 0.5},6 ${37 + wave1 * 0.5},4 ${34.5 + wave1 * 0.5},6 ${35.5 + wave1 * 0.5},3 ${33 + wave1 * 0.5},1 ${36 + wave1 * 0.5},1`}
          fill="#ffd166"
          stroke="#3a2806"
          strokeWidth="0.3"
        />
        {/* gate */}
        <Path d="M 28 59 L 28 46 Q 28 40 33 40 Q 38 40 38 46 L 38 59 Z" fill="url(#cWood)" stroke="#1a0c08" strokeWidth="1.4" />
        {/* gate arch rim light */}
        <Path d="M 28 46 Q 28 40 33 40 Q 38 40 38 46" stroke="#a06838" strokeWidth="0.6" fill="none" opacity="0.65" />
        {/* gate wood planks */}
        <Path d="M 30 42 L 30 59" stroke="#1a0c08" strokeWidth="0.45" opacity="0.7" />
        <Path d="M 33 40.5 L 33 59" stroke="#1a0c08" strokeWidth="0.45" opacity="0.7" />
        <Path d="M 36 42 L 36 59" stroke="#1a0c08" strokeWidth="0.45" opacity="0.7" />
        {/* iron bands on gate */}
        <Path d="M 28 50 L 38 50" stroke="#1a2028" strokeWidth="1" />
        <Path d="M 28 54 L 38 54" stroke="#1a2028" strokeWidth="1" />
        {/* iron studs */}
        <Circle cx="30" cy="50" r="0.5" fill="#5a6470" />
        <Circle cx="33" cy="50" r="0.5" fill="#5a6470" />
        <Circle cx="36" cy="50" r="0.5" fill="#5a6470" />
        <Circle cx="30" cy="54" r="0.5" fill="#5a6470" />
        <Circle cx="33" cy="54" r="0.5" fill="#5a6470" />
        <Circle cx="36" cy="54" r="0.5" fill="#5a6470" />
        {/* door ring */}
        <Circle cx="36" cy="48" r="1.1" fill="none" stroke="#3a3848" strokeWidth="0.5" />
        <Circle cx="36" cy="48" r="0.4" fill="#5a6470" />
        {/* keep windows above gate */}
        <Path d="M 27 31 L 27 35 Q 27 37 29 37 Q 31 37 31 35 L 31 31 Z" fill="url(#cWin)" stroke="#1a0c08" strokeWidth="0.5" />
        <Circle cx="29" cy="34" r="2.5" fill="#ffd166" opacity="0.25" />
        <Path d="M 35 31 L 35 35 Q 35 37 37 37 Q 39 37 39 35 L 39 31 Z" fill="url(#cWin)" stroke="#1a0c08" strokeWidth="0.5" />
        <Circle cx="37" cy="34" r="2.5" fill="#ffd166" opacity="0.25" />

        {/* === RIGHT TOWER === */}
        <Rect x="44" y="22" width="18" height="37" fill="url(#cStone)" stroke="#1a0c08" strokeWidth="1.5" />
        {/* horizontal courses */}
        <Path d="M 44 28 L 62 28" stroke="#1a0c08" strokeWidth="0.5" opacity="0.55" />
        <Path d="M 44 34 L 62 34" stroke="#1a0c08" strokeWidth="0.5" opacity="0.55" />
        <Path d="M 44 40 L 62 40" stroke="#1a0c08" strokeWidth="0.5" opacity="0.55" />
        <Path d="M 44 46 L 62 46" stroke="#1a0c08" strokeWidth="0.5" opacity="0.55" />
        <Path d="M 44 52 L 62 52" stroke="#1a0c08" strokeWidth="0.5" opacity="0.55" />
        {/* alternating vertical joints */}
        <Path d="M 50 22 L 50 28 M 56 22 L 56 28" stroke="#1a0c08" strokeWidth="0.4" opacity="0.45" />
        <Path d="M 47 28 L 47 34 M 53 28 L 53 34 M 59 28 L 59 34" stroke="#1a0c08" strokeWidth="0.4" opacity="0.45" />
        <Path d="M 50 34 L 50 40 M 56 34 L 56 40" stroke="#1a0c08" strokeWidth="0.4" opacity="0.45" />
        <Path d="M 47 40 L 47 46 M 53 40 L 53 46 M 59 40 L 59 46" stroke="#1a0c08" strokeWidth="0.4" opacity="0.45" />
        <Path d="M 50 46 L 50 52 M 56 46 L 56 52" stroke="#1a0c08" strokeWidth="0.4" opacity="0.45" />
        <Path d="M 47 52 L 47 59 M 53 52 L 53 59 M 59 52 L 59 59" stroke="#1a0c08" strokeWidth="0.4" opacity="0.45" />
        {/* rim light on left edge of right tower (toward keep) */}
        <Path d="M 45 23 L 45 58" stroke="#f8e8c0" strokeWidth="0.9" opacity="0.7" />
        {/* battlement strip */}
        <Path d="M 43 22 L 63 22 L 62 24 L 44 24 Z" fill="#8a6848" stroke="#1a0c08" strokeWidth="0.8" />
        <Path d="M 43 22 L 63 22" stroke="#e8c898" strokeWidth="0.4" opacity="0.7" />
        {/* merlons */}
        <Rect x="43" y="17" width="4" height="6" fill="url(#cStone)" stroke="#1a0c08" strokeWidth="0.8" />
        <Path d="M 42 17 L 48 17" stroke="#1a0c08" strokeWidth="0.6" />
        <Rect x="49" y="17" width="4" height="6" fill="url(#cStone)" stroke="#1a0c08" strokeWidth="0.8" />
        <Path d="M 48 17 L 54 17" stroke="#1a0c08" strokeWidth="0.6" />
        <Rect x="55" y="17" width="4" height="6" fill="url(#cStone)" stroke="#1a0c08" strokeWidth="0.8" />
        <Path d="M 54 17 L 60 17" stroke="#1a0c08" strokeWidth="0.6" />
        {/* roof */}
        <Polygon points="42,17 64,17 53,1" fill="url(#cRoof)" stroke="#0a3818" strokeWidth="1.5" />
        <Path d="M 44 14 L 47 12.5 L 50 14 L 53 12.5 L 56 14 L 59 12.5 L 62 14" stroke="#0a3818" strokeWidth="0.5" fill="none" opacity="0.65" />
        <Path d="M 46 10 L 49 8.5 L 52 10 L 55 8.5 L 58 10 L 60 8.5" stroke="#0a3818" strokeWidth="0.5" fill="none" opacity="0.55" />
        <Path d="M 48 6 L 51 5 L 54 6 L 56 5" stroke="#0a3818" strokeWidth="0.4" fill="none" opacity="0.5" />
        <Path d="M 42 17 L 53 1" stroke="#fff" strokeWidth="1.2" opacity="0.6" />
        <Path d="M 53 1 L 64 17" stroke="#0a3818" strokeWidth="0.8" opacity="0.7" />
        {/* roof finial */}
        <Circle cx="53" cy="1" r="0.8" fill="#ffd166" stroke="#3a2806" strokeWidth="0.3" />
        {/* tower flag (right) */}
        <Rect x="52.5" y="-5" width="1" height="6" fill="#3a2806" />
        <Path
          d={`M 53 -4 L ${57 + wave3} -2 L ${56 + wave3} 0 L 53 -1 Z`}
          fill="#4cc9ff" stroke="#0a4070" strokeWidth="0.4"
        />
        {/* upper windows */}
        <Path d="M 48 33 L 48 39 Q 48 41 50 41 Q 52 41 52 39 L 52 33 Z" fill="url(#cWin)" stroke="#1a0c08" strokeWidth="0.6" />
        <Circle cx="50" cy="38" r="3.5" fill="#ffd166" opacity="0.22" />
        <Path d="M 54 33 L 54 39 Q 54 41 56 41 Q 58 41 58 39 L 58 33 Z" fill="url(#cWin)" stroke="#1a0c08" strokeWidth="0.6" />
        <Circle cx="56" cy="38" r="3.5" fill="#ffd166" opacity="0.22" />
        {/* lower window */}
        <Path d="M 51 47 L 51 52 Q 51 54 53 54 Q 55 54 55 52 L 55 47 Z" fill="url(#cWin)" stroke="#1a0c08" strokeWidth="0.5" opacity="0.85" />
        <Circle cx="53" cy="51" r="2.5" fill="#ffd166" opacity="0.18" />
      </Svg>
    </View>
  );
}

// ───── Checkpoint torch post — stone pedestal with flickering flame ────────
function CheckpointTorch({ pt, time, i }) {
  const phase = (i || 0) * 1.7;
  // Three independent flicker drivers
  const flicker = 0.75 + 0.25 * Math.sin(time * 7 + phase) * Math.sin(time * 13 + phase * 1.3);
  const flicker2 = 0.85 + 0.15 * Math.sin(time * 9 + phase + 0.7);
  // Three rising embers with offset phases
  const emberY = (time * 5 + phase) % 12;
  const emberY2 = (time * 5 + phase + 4) % 12;
  const emberY3 = (time * 5 + phase + 8) % 12;
  // Subtle smoke wisp
  const smokeY = (time * 4 + phase) % 15;
  const size = TILE * 1.6;
  const left = pt.c * TILE - TILE * 0.3;
  const top = pt.r * TILE - TILE * 0.6;
  return (
    <View pointerEvents="none" style={{ position: 'absolute', left, top, width: size, height: size }}>
      <Svg width={size} height={size} viewBox="0 0 35 35">
        <Defs>
          {/* warm stone — same palette as castle/portal */}
          <LinearGradient id={`tStone${i}`} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor="#d8c098" />
            <Stop offset="0.15" stopColor="#a08868" />
            <Stop offset="0.6" stopColor="#604838" />
            <Stop offset="1" stopColor="#3a1a14" />
          </LinearGradient>
          {/* darker stone for inset panel */}
          <LinearGradient id={`tStoneDark${i}`} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor="#5a4030" />
            <Stop offset="1" stopColor="#1a0c08" />
          </LinearGradient>
          {/* iron bowl */}
          <LinearGradient id={`tIron${i}`} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor="#5a6470" />
            <Stop offset="0.5" stopColor="#2a3040" />
            <Stop offset="1" stopColor="#0a0e18" />
          </LinearGradient>
          {/* warm light pool */}
          <RadialGradient id={`tLight${i}`} cx="0.5" cy="0.4" r="0.65">
            <Stop offset="0" stopColor="#ffd166" stopOpacity={flicker * 0.85} />
            <Stop offset="0.5" stopColor="#ff8a4d" stopOpacity={flicker * 0.45} />
            <Stop offset="1" stopColor="#ff6f1f" stopOpacity="0" />
          </RadialGradient>
          {/* ground shadow */}
          <RadialGradient id={`tShadow${i}`} cx="0.5" cy="0.5" r="0.5">
            <Stop offset="0" stopColor="#000" stopOpacity="0.9" />
            <Stop offset="1" stopColor="#000" stopOpacity="0" />
          </RadialGradient>
        </Defs>

        {/* warm light pool */}
        <Rect x="0" y="0" width="35" height="35" fill={`url(#tLight${i})`} />

        {/* heavy ground shadow */}
        <Ellipse cx="17.5" cy="32.8" rx="11" ry="2" fill={`url(#tShadow${i})`} />

        {/* === PEDESTAL BASE STEP (widest, capped) === */}
        <Path d="M 8 32 L 27 32 L 25 28 L 10 28 Z" fill={`url(#tStone${i})`} stroke="#1a0c08" strokeWidth="0.9" />
        <Path d="M 10 28 L 25 28" stroke="#e8c898" strokeWidth="0.5" opacity="0.75" />
        {/* decorative carved row */}
        <Path d="M 12 30 L 13 29 L 14 30 L 15 29 L 16 30 L 17 29 L 18 30 L 19 29 L 20 30 L 21 29 L 22 30 L 23 29"
              stroke="#1a0c08" strokeWidth="0.35" fill="none" opacity="0.7" />

        {/* === PEDESTAL MIDDLE (carved face panel) === */}
        <Rect x="11" y="20" width="13" height="8" fill={`url(#tStone${i})`} stroke="#1a0c08" strokeWidth="0.9" />
        {/* mid rim light on left edge */}
        <Path d="M 11.5 20.5 L 11.5 27.5" stroke="#e8c898" strokeWidth="0.5" opacity="0.7" />
        {/* recessed carved panel */}
        <Rect x="13" y="22" width="9" height="4.5" fill={`url(#tStoneDark${i})`} stroke="#1a0c08" strokeWidth="0.4" />
        {/* gold rune (+) */}
        <Path d="M 15 24 L 20 24 M 17.5 22.5 L 17.5 26" stroke="#ffd166" strokeWidth="0.65" fill="none"
              opacity={0.95 * flicker2} />
        <Circle cx="17.5" cy="24.2" r="1.8" fill="#ffd166" opacity={0.2 * flicker2} />
        {/* iron band between mid and top */}
        <Path d="M 11 20 L 24 20" stroke={`url(#tIron${i})`} strokeWidth="1.2" />
        <Circle cx="12.5" cy="20" r="0.5" fill="#7a8090" />
        <Circle cx="22.5" cy="20" r="0.5" fill="#7a8090" />

        {/* === PEDESTAL UPPER CAP === */}
        <Path d="M 9 20 L 26 20 L 24 17 L 11 17 Z" fill={`url(#tStone${i})`} stroke="#1a0c08" strokeWidth="0.9" />
        <Path d="M 11 17 L 24 17" stroke="#e8c898" strokeWidth="0.5" opacity="0.78" />

        {/* === BRAZIER BOWL === */}
        {/* bowl shadow on cap */}
        <Ellipse cx="17.5" cy="16.5" rx="7" ry="1.3" fill="#1a0c08" opacity="0.6" />
        {/* main bowl body */}
        <Path d="M 9 16 Q 9 11.5 17.5 11.5 Q 26 11.5 26 16 L 24 18.5 L 11 18.5 Z"
              fill={`url(#tIron${i})`} stroke="#0a0510" strokeWidth="0.9" />
        {/* horizontal iron band on bowl */}
        <Path d="M 9 15 Q 17.5 16 26 15" stroke="#0a0510" strokeWidth="0.7" fill="none" />
        {/* rivets on band */}
        <Circle cx="11" cy="15.5" r="0.4" fill="#7a8090" />
        <Circle cx="17.5" cy="16" r="0.4" fill="#7a8090" />
        <Circle cx="24" cy="15.5" r="0.4" fill="#7a8090" />
        {/* bowl top rim */}
        <Ellipse cx="17.5" cy="11.5" rx="8.5" ry="1.5" fill="#3a3848" stroke="#0a0510" strokeWidth="0.6" />
        {/* rim light on bowl top */}
        <Ellipse cx="17.5" cy="11" rx="7.5" ry="0.8" fill="none" stroke="#a8b4d0" strokeWidth="0.4" opacity="0.7" />
        {/* iron mounting brackets on bowl sides */}
        <Path d="M 9 13 L 7 14 L 8 16" stroke={`url(#tIron${i})`} strokeWidth="0.8" fill="none" />
        <Path d="M 26 13 L 28 14 L 27 16" stroke={`url(#tIron${i})`} strokeWidth="0.8" fill="none" />

        {/* === COALS / EMBERS INSIDE BOWL === */}
        <Circle cx="13" cy="12" r="1.3" fill="#ff6f1f" opacity={0.85 * flicker} />
        <Circle cx="17.5" cy="11.8" r="1.6" fill="#ffd166" opacity={0.95 * flicker} />
        <Circle cx="22" cy="12" r="1.3" fill="#ff6f1f" opacity={0.8 * flicker} />
        <Circle cx="14.5" cy="11" r="0.5" fill="#fff" opacity={flicker} />
        <Circle cx="20.5" cy="11" r="0.5" fill="#fff" opacity={flicker * 0.85} />

        {/* === MULTI-LAYER FLAME === */}
        {/* layer 1: outer haze (darkest red, biggest) */}
        <Path
          d={`M 17.5 ${3 - flicker * 1.5} Q ${12.5 - flicker * 0.5} 6 11.5 11 Q 10.5 4 17.5 ${-2 - flicker * 2} Q ${24.5 + flicker * 0.5} 4 23.5 11 Q ${22.5 + flicker * 0.5} 6 17.5 ${3 - flicker * 1.5} Z`}
          fill="#7a1d00"
          opacity="0.55"
        />
        {/* layer 2: orange */}
        <Path
          d={`M 17.5 ${4 - flicker * 1.3} Q ${13.5 - flicker * 0.4} 6 13 10 Q 12 4.5 17.5 ${-0.5 - flicker * 1.8} Q ${22.5 + flicker * 0.4} 4.5 22 10 Q ${21.5 + flicker * 0.4} 6 17.5 ${4 - flicker * 1.3} Z`}
          fill="#ff6f1f"
          opacity="0.92"
        />
        {/* layer 3: gold */}
        <Path
          d={`M 17.5 ${5 - flicker * 1.1} Q 14.5 6 14 9 Q 13 5 17.5 ${0.5 - flicker * 1.6} Q 21 5 21 9 Q 20.5 6 17.5 ${5 - flicker * 1.1} Z`}
          fill="#ffd166"
        />
        {/* layer 4: inner yellow */}
        <Path
          d={`M 17.5 ${5 - flicker * 0.9} Q 15.5 6 15.5 8 Q 14.5 4 17.5 ${1 - flicker * 1.4} Q 20.5 4 19.5 8 Q 19.5 6 17.5 ${5 - flicker * 0.9} Z`}
          fill="#fff7a8"
        />
        {/* layer 5: white core */}
        <Path
          d={`M 17.5 ${5 - flicker * 0.5} Q 16.5 5.5 16.5 7 Q 16 4 17.5 ${2.5 - flicker * 1.1} Q 19 4 18.5 7 Q 18.5 5.5 17.5 ${5 - flicker * 0.5} Z`}
          fill="#fff"
          opacity="0.92"
        />

        {/* === FLOATING EMBERS (animated, rising) === */}
        <Circle cx={17.5 + Math.sin(time * 3 + phase) * 1.2} cy={4 - emberY}
                r="0.5" fill="#ff6f1f" opacity={Math.max(0, 1 - emberY * 0.09)} />
        <Circle cx={17.5 + Math.sin(time * 3 + phase + 2) * 1.4} cy={4 - emberY2}
                r="0.4" fill="#ffd166" opacity={Math.max(0, 1 - emberY2 * 0.09)} />
        <Circle cx={17.5 + Math.sin(time * 3 + phase + 4) * 1.6} cy={4 - emberY3}
                r="0.3" fill="#ff6f1f" opacity={Math.max(0, 0.9 - emberY3 * 0.09)} />

        {/* === SMOKE WISP (subtle, above flame) === */}
        <Circle cx={17.5 + Math.sin(time * 1.5 + phase) * 1.5} cy={-3 - smokeY * 0.4}
                r={1.5 + smokeY * 0.1} fill="#3a2a1a"
                opacity={Math.max(0, 0.3 - smokeY * 0.018)} />
      </Svg>
    </View>
  );
}

// Pseudo-3D rock — deterministic random variant by id so the same rock
// keeps the same shape across renders.
function RockView({ t }) {
  const seed = (t.id * 2654435761) >>> 0;
  const variant = seed % 8;                 // 8 shapes
  const palette = (seed >> 4) % 3;          // 3 palettes
  const detail = (seed >> 8) % 4;           // 4 detail overlays
  const rot = (((seed >> 12) & 0x3F) - 32) * 0.4;  // ±12.8° rotation (gentle)
  const px = TILE;
  const id = useRef(nextGid()).current;

  // Palettes: warm beige / cool gray / dark obsidian
  const palettes = [
    { hi: '#d8c098', main: '#a08868', dark: '#604838', deep: '#2a1810' },
    { hi: '#b8c0d0', main: '#7a8090', dark: '#3a4050', deep: '#1a2030' },
    { hi: '#5a5a72', main: '#3a3a4e', dark: '#1a1a28', deep: '#000' },
  ];
  // Bullet-proof — if seed math overflows / t.id is NaN, fall back to palette 0
  // instead of crashing the SVG renderer (was "Cannot read property 'hi' of undefined").
  const pal = palettes[palette] || palettes[0];
  // Embedded-crystal accent colors (cycled by detail bit)
  const accentColors = ['#4cc9ff', '#ff4d6d', '#5cf28a', '#ffd166'];
  const accent = accentColors[(seed >> 16) % 4];
  // Moss / lichen colors
  const moss = '#3a6a3a';

  return (
    <View pointerEvents="none" style={{
      position: 'absolute', left: t.c * TILE, top: t.r * TILE,
      width: px, height: px,
      alignItems: 'center', justifyContent: 'center',
    }}>
      <Svg width={px} height={px} viewBox="0 0 100 100" style={{ transform: [{ rotate: `${rot}deg` }] }}>
        <Defs>
          <LinearGradient id={`${id}b`} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={pal.hi} />
            <Stop offset="0.2" stopColor={pal.main} />
            <Stop offset="0.7" stopColor={pal.dark} />
            <Stop offset="1" stopColor={pal.deep} />
          </LinearGradient>
          <RadialGradient id={`${id}drop`} cx="0.5" cy="0.5" r="0.5">
            <Stop offset="0" stopColor="#000" stopOpacity="0.7" />
            <Stop offset="1" stopColor="#000" stopOpacity="0" />
          </RadialGradient>
          <LinearGradient id={`${id}xtal`} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor="rgba(255,255,255,0.5)" />
            <Stop offset="0.2" stopColor={accent} />
            <Stop offset="1" stopColor={darken(accent, 0.5)} />
          </LinearGradient>
        </Defs>

        {/* ground shadow under every rock */}
        <Ellipse cx="50" cy="86" rx="34" ry="5" fill={`url(#${id}drop)`} />

        {variant === 0 && (
          // SMOOTH BOULDER — potato shape
          <>
            <Path
              d="M 22 60 Q 12 40 22 24 Q 38 14 50 16 Q 68 14 78 22 Q 90 38 82 56 Q 72 78 52 80 Q 32 80 22 60 Z"
              fill={`url(#${id}b)`} stroke={pal.deep} strokeWidth="2.5"
            />
            {/* top rim light */}
            <Path d="M 22 24 Q 38 14 50 16 Q 68 14 78 22"
                  stroke={pal.hi} strokeWidth="1.5" fill="none" opacity="0.65" />
            {/* subtle inner shading curve */}
            <Path d="M 26 56 Q 38 50 50 56 Q 62 52 70 58" stroke={pal.deep} strokeWidth="0.6" fill="none" opacity="0.5" />
          </>
        )}

        {variant === 1 && (
          // CRYSTAL CLUSTER — 3 shards
          <>
            {/* main center shard */}
            <Polygon points="50,12 64,40 60,76 40,76 36,40" fill={`url(#${id}b)`} stroke={pal.deep} strokeWidth="2.2" />
            <Polygon points="50,12 40,40 50,50" fill={pal.hi} opacity="0.5" />
            {/* left smaller shard */}
            <Polygon points="22,38 32,22 38,50 30,74 16,72" fill={`url(#${id}b)`} stroke={pal.deep} strokeWidth="2" opacity="0.95" />
            <Polygon points="22,38 32,22 28,50" fill={pal.hi} opacity="0.45" />
            {/* right smaller shard */}
            <Polygon points="78,38 68,22 62,50 70,74 84,72" fill={`url(#${id}b)`} stroke={pal.deep} strokeWidth="2" opacity="0.95" />
            <Polygon points="78,38 68,22 72,50" fill={pal.hi} opacity="0.45" />
            {/* top rim light on main shard */}
            <Path d="M 50 12 L 64 40" stroke={pal.hi} strokeWidth="1.2" fill="none" opacity="0.7" />
            {/* small shine pip */}
            <Circle cx="44" cy="30" r="2" fill="#fff" opacity="0.6" />
          </>
        )}

        {variant === 2 && (
          // CRACKED BLOCK — square with chipped corner + crack
          <>
            <Path
              d="M 18 22 L 76 18 L 82 32 L 84 70 L 76 80 L 28 78 L 18 68 L 16 32 Z"
              fill={`url(#${id}b)`} stroke={pal.deep} strokeWidth="2.5"
            />
            {/* top rim light */}
            <Path d="M 18 22 L 76 18 L 82 32" stroke={pal.hi} strokeWidth="1.5" fill="none" opacity="0.65" />
            {/* chipped corner — show a darker face */}
            <Polygon points="76,18 82,32 76,30" fill={pal.deep} />
            {/* visible crack across body */}
            <Path d="M 32 30 L 42 50 L 38 70" stroke={pal.deep} strokeWidth="0.9" fill="none" opacity="0.85" />
            <Path d="M 56 22 L 60 44 L 70 66" stroke={pal.deep} strokeWidth="0.7" fill="none" opacity="0.75" />
            {/* small chip out of bottom */}
            <Polygon points="28,78 38,76 32,72" fill={pal.deep} />
          </>
        )}

        {variant === 3 && (
          // TWIN BOULDER — two rocks joined
          <>
            {/* larger left boulder */}
            <Path d="M 12 60 Q 6 36 18 22 Q 32 14 42 18 Q 52 26 48 52 Q 46 76 30 78 Q 14 78 12 60 Z"
                  fill={`url(#${id}b)`} stroke={pal.deep} strokeWidth="2.2" />
            <Path d="M 12 36 Q 22 14 42 18" stroke={pal.hi} strokeWidth="1.3" fill="none" opacity="0.6" />
            {/* smaller right boulder */}
            <Path d="M 50 64 Q 46 44 58 32 Q 72 24 84 36 Q 92 56 84 72 Q 70 80 56 78 Q 50 76 50 64 Z"
                  fill={`url(#${id}b)`} stroke={pal.deep} strokeWidth="2.2" />
            <Path d="M 54 44 Q 64 26 84 36" stroke={pal.hi} strokeWidth="1.2" fill="none" opacity="0.55" />
            {/* join shadow */}
            <Ellipse cx="48" cy="68" rx="6" ry="3" fill={pal.deep} opacity="0.65" />
          </>
        )}

        {variant === 4 && (
          // SPIKY ROCK — base with sharp upward spikes
          <>
            {/* base body (rounded) */}
            <Path d="M 18 60 Q 12 44 22 36 Q 38 28 50 30 Q 68 28 78 36 Q 88 44 82 60 Q 76 76 50 76 Q 24 76 18 60 Z"
                  fill={`url(#${id}b)`} stroke={pal.deep} strokeWidth="2.4" />
            {/* spikes */}
            <Polygon points="22,46 28,18 34,46" fill={`url(#${id}b)`} stroke={pal.deep} strokeWidth="2" />
            <Polygon points="38,40 46,10 54,44" fill={`url(#${id}b)`} stroke={pal.deep} strokeWidth="2" />
            <Polygon points="56,42 64,14 72,46" fill={`url(#${id}b)`} stroke={pal.deep} strokeWidth="2" />
            {/* spike rim lights */}
            <Path d="M 28 18 L 22 46" stroke={pal.hi} strokeWidth="0.9" opacity="0.7" />
            <Path d="M 46 10 L 38 40" stroke={pal.hi} strokeWidth="0.9" opacity="0.7" />
            <Path d="M 64 14 L 56 42" stroke={pal.hi} strokeWidth="0.9" opacity="0.7" />
            {/* base rim light */}
            <Path d="M 18 60 Q 12 44 22 36" stroke={pal.hi} strokeWidth="1.2" fill="none" opacity="0.55" />
          </>
        )}

        {variant === 5 && (
          // MUSHROOM ROCK — wider top, eroded base
          <>
            {/* base (narrower) */}
            <Path d="M 30 78 L 28 56 Q 28 52 32 52 L 68 52 Q 72 52 72 56 L 70 78 Z"
                  fill={`url(#${id}b)`} stroke={pal.deep} strokeWidth="2.2" />
            {/* top cap (wider) */}
            <Path d="M 14 38 Q 14 22 50 18 Q 86 22 86 38 Q 82 54 50 56 Q 18 54 14 38 Z"
                  fill={`url(#${id}b)`} stroke={pal.deep} strokeWidth="2.4" />
            {/* top cap rim light */}
            <Path d="M 14 38 Q 14 22 50 18 Q 86 22 86 38" stroke={pal.hi} strokeWidth="1.5" fill="none" opacity="0.7" />
            {/* erosion crack on base */}
            <Path d="M 40 56 L 42 76" stroke={pal.deep} strokeWidth="0.7" opacity="0.7" />
            <Path d="M 58 56 L 56 76" stroke={pal.deep} strokeWidth="0.7" opacity="0.7" />
          </>
        )}

        {variant === 6 && (
          // EMBEDDED CRYSTAL — boulder with a small colored crystal jutting out
          <>
            {/* boulder body */}
            <Path d="M 18 60 Q 12 40 24 24 Q 40 14 52 18 Q 72 14 80 26 Q 90 44 82 58 Q 70 78 50 78 Q 28 78 18 60 Z"
                  fill={`url(#${id}b)`} stroke={pal.deep} strokeWidth="2.4" />
            <Path d="M 24 24 Q 40 14 52 18 Q 72 14 80 26" stroke={pal.hi} strokeWidth="1.4" fill="none" opacity="0.65" />
            {/* embedded crystal — angled shard */}
            <Polygon points="56,26 70,4 64,38 50,42 46,32" fill={`url(#${id}xtal)`} stroke={pal.deep} strokeWidth="1.8" />
            <Polygon points="56,26 50,42 60,32" fill="#fff" opacity="0.35" />
            {/* crystal rim light */}
            <Path d="M 56 26 L 70 4" stroke="#fff" strokeWidth="0.8" opacity="0.7" />
            {/* small glow around crystal */}
            <Circle cx="60" cy="20" r="14" fill={accent} opacity="0.18" />
            {/* shine pip on crystal */}
            <Circle cx="60" cy="14" r="1.5" fill="#fff" opacity="0.85" />
          </>
        )}

        {variant === 7 && (
          // ROCK PILE — 3 smaller rocks stacked
          <>
            {/* bottom largest rock */}
            <Path d="M 14 76 Q 10 60 22 56 Q 38 54 50 58 Q 64 54 78 58 Q 90 62 88 76 Q 76 82 50 82 Q 24 82 14 76 Z"
                  fill={`url(#${id}b)`} stroke={pal.deep} strokeWidth="2.2" />
            <Path d="M 14 70 Q 18 56 38 54 Q 60 54 86 64" stroke={pal.hi} strokeWidth="1" fill="none" opacity="0.55" />
            {/* middle rock */}
            <Path d="M 26 54 Q 22 40 32 34 Q 48 30 58 36 Q 70 32 76 44 Q 78 56 56 56 Q 32 58 26 54 Z"
                  fill={`url(#${id}b)`} stroke={pal.deep} strokeWidth="2" />
            <Path d="M 26 46 Q 36 32 60 34" stroke={pal.hi} strokeWidth="0.9" fill="none" opacity="0.6" />
            {/* top rock */}
            <Path d="M 40 30 Q 38 18 50 14 Q 62 14 66 26 Q 64 36 52 34 Q 42 34 40 30 Z"
                  fill={`url(#${id}b)`} stroke={pal.deep} strokeWidth="1.8" />
            <Path d="M 40 24 Q 48 16 62 18" stroke={pal.hi} strokeWidth="0.9" fill="none" opacity="0.65" />
            {/* small pebbles at base */}
            <Ellipse cx="10" cy="80" rx="3" ry="1.5" fill={pal.dark} stroke={pal.deep} strokeWidth="0.6" />
            <Ellipse cx="90" cy="80" rx="3" ry="1.5" fill={pal.dark} stroke={pal.deep} strokeWidth="0.6" />
          </>
        )}

        {/* === DETAIL OVERLAYS === */}
        {detail === 1 && variant !== 6 && (
          // MOSS patches
          <>
            <Ellipse cx="36" cy="32" rx="10" ry="4" fill={moss} opacity="0.75" />
            <Ellipse cx="32" cy="34" rx="5" ry="2.5" fill="#5cf28a" opacity="0.55" />
            <Ellipse cx="64" cy="40" rx="6" ry="3" fill={moss} opacity="0.65" />
            {/* tiny grass tufts */}
            <Path d="M 30 28 L 30 24 M 33 28 L 33 24 M 36 28 L 36 24" stroke="#5cf28a" strokeWidth="0.6" />
          </>
        )}
        {detail === 2 && variant !== 2 && (
          // EXTRA CRACKS
          <>
            <Path d="M 30 28 L 38 50 L 32 70" stroke={pal.deep} strokeWidth="0.8" fill="none" opacity="0.8" />
            <Path d="M 58 32 L 64 56" stroke={pal.deep} strokeWidth="0.6" fill="none" opacity="0.7" />
          </>
        )}
        {detail === 3 && (
          // LICHEN / DIRT spots
          <>
            <Circle cx="34" cy="46" r="2" fill={pal.hi} opacity="0.5" />
            <Circle cx="62" cy="56" r="1.5" fill={pal.hi} opacity="0.45" />
            <Circle cx="46" cy="64" r="1.2" fill={pal.deep} opacity="0.6" />
            <Circle cx="68" cy="38" r="1" fill={pal.deep} opacity="0.55" />
          </>
        )}
      </Svg>
    </View>
  );
}

// ─── Gem rendering with clear P1–P6 progression ─────────────────────────────
// Each tier gets larger and more elaborate. The body silhouette changes shape
// up to P3, then accumulates more facets / rays / sparkles / halo layers /
// crown elements as tier rises. Renders into 100×100 viewBox; outer wrapper
// scales to actual size which grows with tier (P1 = 0.7×, P6 = 1.25×).

const GEM_TIER_SCALE = { 1: 0.78, 2: 0.86, 3: 0.96, 4: 1.06, 5: 1.18, 6: 1.32 };

function darken(hex, amt) {
  // Naive hex→darker (mix with black by amt 0..1).
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const dr = Math.max(0, Math.floor(r * (1 - amt)));
  const dg = Math.max(0, Math.floor(g * (1 - amt)));
  const db = Math.max(0, Math.floor(b * (1 - amt)));
  return `rgb(${dr},${dg},${db})`;
}

function GemSvg({ gemType, tier }) {
  const g = GEMS[gemType];
  const scale = GEM_TIER_SCALE[tier] || 1;
  const px = TILE * scale;
  const id = useRef(nextGid()).current;
  const light = g.color;
  const dark = darken(g.color, 0.55);
  const veryDark = darken(g.color, 0.75);
  const labelColor = tier >= 4 ? '#0b1020' : '#fff';
  // Opal renders with an iridescent rainbow body gradient (same geometry as
  // every other gem family). Stops shift through pearl-white → pink → blue
  // → green → yellow to give the "play of colour" Opal is known for.
  const isOpal = gemType === 'opal';

  return (
    <View pointerEvents="none" style={{
      width: px, height: px,
      alignItems: 'center', justifyContent: 'center',
    }}>
      <Svg width={px} height={px} viewBox="0 0 100 100">
        <Defs>
          {isOpal ? (
            <LinearGradient id={`${id}b`} x1="0" y1="0" x2="1" y2="1">
              <Stop offset="0"    stopColor="rgba(255,255,255,0.7)" />
              <Stop offset="0.15" stopColor="#ffd4f0" />
              <Stop offset="0.35" stopColor="#a8d4ff" />
              <Stop offset="0.55" stopColor="#a8f0c4" />
              <Stop offset="0.75" stopColor="#ffe89e" />
              <Stop offset="0.90" stopColor="#ffb3d6" />
              <Stop offset="1"    stopColor="#7a6890" />
            </LinearGradient>
          ) : (
            <LinearGradient id={`${id}b`} x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor="rgba(255,255,255,0.4)" />
              <Stop offset="0.18" stopColor={light} />
              <Stop offset="0.6" stopColor={light} />
              <Stop offset="1" stopColor={dark} />
            </LinearGradient>
          )}
          <RadialGradient id={`${id}halo`} cx="0.5" cy="0.5" r="0.5">
            <Stop offset="0" stopColor={light} stopOpacity={0.5} />
            <Stop offset="1" stopColor={light} stopOpacity="0" />
          </RadialGradient>
          <LinearGradient id={`${id}crown`} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor="#fff7a8" />
            <Stop offset="1" stopColor="#ffd166" />
          </LinearGradient>
          <RadialGradient id={`${id}shadow`} cx="0.5" cy="0.5" r="0.5">
            <Stop offset="0" stopColor="#000" stopOpacity="0.7" />
            <Stop offset="1" stopColor="#000" stopOpacity="0" />
          </RadialGradient>
        </Defs>

        {/* Kingdom-Rush drop shadow — bigger and darker for higher tiers */}
        <Ellipse cx="50" cy="93" rx={20 + tier * 4} ry={3 + tier * 0.4} fill={`url(#${id}shadow)`} />

        {/* TIER 5 & 6 outer halo */}
        {tier >= 4 && <Circle cx="50" cy="50" r="48" fill={`url(#${id}halo)`} />}

        {/* TIER 4+ radiating rays */}
        {tier >= 4 && [0, 45, 90, 135, 180, 225, 270, 315].map((deg, i) => (
          <Path
            key={i}
            d={`M 50 50 L ${50 + 44 * Math.cos((deg * Math.PI) / 180)} ${50 + 44 * Math.sin((deg * Math.PI) / 180)}`}
            stroke={light}
            strokeWidth={tier === 4 ? 1.2 : tier === 5 ? 1.8 : 2.4}
            opacity={tier === 4 ? 0.35 : tier === 5 ? 0.5 : 0.75}
          />
        ))}

        {/* TIER 5+ inner halo ring */}
        {tier >= 5 && (
          <Circle cx="50" cy="50" r="36" fill="none" stroke={light} strokeWidth="1.5" opacity="0.6"
                  strokeDasharray="3 3" />
        )}

        {/* GEM BODY — silhouette varies by tier */}
        {tier === 1 && (
          // P1 CRACKED — rough raw mineral with chips, dirt, moss patches
          <>
            {/* irregular 7-vertex outline */}
            <Polygon points="48,20 62,30 70,42 66,68 56,78 38,76 30,62 30,42 36,28"
                     fill={`url(#${id}b)`} stroke={veryDark} strokeWidth="2.2" />
            {/* internal facet lines (uneven, suggest amateur cut) */}
            <Path d="M 42 30 L 48 50 L 44 70" stroke={veryDark} strokeWidth="1" fill="none" opacity="0.7" />
            <Path d="M 30 42 L 48 50 L 70 42" stroke={veryDark} strokeWidth="0.7" fill="none" opacity="0.55" />
            <Path d="M 38 76 L 48 50 L 56 78" stroke={veryDark} strokeWidth="0.6" fill="none" opacity="0.5" />
            {/* main crack running through body */}
            <Path d="M 48 22 L 52 38 L 46 56 L 50 70" stroke="#0a0510" strokeWidth="0.9" fill="none" />
            <Path d="M 48 22 L 52 38 L 46 56 L 50 70" stroke="#fff" strokeWidth="0.3" fill="none" opacity="0.4" />
            {/* dirt smudges (dark spots) */}
            <Circle cx="40" cy="62" r="2.5" fill="#0a0510" opacity="0.35" />
            <Circle cx="58" cy="48" r="1.8" fill="#0a0510" opacity="0.3" />
            <Circle cx="36" cy="44" r="1.4" fill="#0a0510" opacity="0.4" />
            {/* moss patch on one side */}
            <Ellipse cx="62" cy="58" rx="5" ry="2.5" fill="#3a6a3a" opacity="0.7" />
            <Ellipse cx="62" cy="58" rx="3" ry="1.5" fill="#5cf28a" opacity="0.55" />
            {/* very faint shine pip — barely polished */}
            <Circle cx="40" cy="36" r="1.6" fill="#fff" opacity="0.35" />
            {/* tiny chip out of edge */}
            <Polygon points="62,30 66,28 64,34" fill={veryDark} />
          </>
        )}
        {tier === 2 && (
          // P2 CUT — clean 6-sided rhombus with proper facets, rim light
          <>
            {/* subtle color glow halo */}
            <Circle cx="50" cy="50" r="42" fill={light} opacity="0.08" />
            {/* main body */}
            <Polygon points="50,18 74,38 68,74 32,74 26,38" fill={`url(#${id}b)`}
                     stroke={veryDark} strokeWidth="2" />
            {/* 8 facet lines (was 4) */}
            <Path d="M 50 18 L 42 46 L 50 74" stroke={veryDark} strokeWidth="0.8" fill="none" opacity="0.7" />
            <Path d="M 50 18 L 58 46 L 50 74" stroke={veryDark} strokeWidth="0.8" fill="none" opacity="0.7" />
            <Path d="M 26 38 L 42 46 L 32 74" stroke={veryDark} strokeWidth="0.6" fill="none" opacity="0.6" />
            <Path d="M 74 38 L 58 46 L 68 74" stroke={veryDark} strokeWidth="0.6" fill="none" opacity="0.6" />
            <Path d="M 42 46 L 58 46" stroke={veryDark} strokeWidth="0.5" fill="none" opacity="0.55" />
            <Path d="M 32 74 L 50 50 L 68 74" stroke={veryDark} strokeWidth="0.4" fill="none" opacity="0.45" />
            {/* TWO bright facets (upper-left + upper-right) */}
            <Polygon points="50,18 42,46 50,40" fill="#fff" opacity="0.4" />
            <Polygon points="50,18 58,46 50,40" fill="#fff" opacity="0.22" />
            {/* rim light on upper edges */}
            <Path d="M 26 38 L 50 18 L 74 38" stroke="rgba(255,255,255,0.55)" strokeWidth="1" fill="none" />
            {/* tiny center shine pip */}
            <Circle cx="50" cy="42" r="1.2" fill="#fff" opacity="0.7" />
          </>
        )}
        {tier === 3 && (
          // P3 POLISHED — symmetric hexagon, 8 radial facets, shine, color glow
          <>
            {/* color glow halo */}
            <Circle cx="50" cy="50" r="46" fill={light} opacity="0.12" />
            {/* main body */}
            <Polygon points="50,14 78,32 78,68 50,86 22,68 22,32" fill={`url(#${id}b)`}
                     stroke={veryDark} strokeWidth="2" />
            {/* 8 radial facets (was 6) */}
            <Path d="M 50 14 L 50 50 M 78 32 L 50 50 M 78 68 L 50 50 M 50 86 L 50 50 M 22 68 L 50 50 M 22 32 L 50 50"
                  stroke={veryDark} strokeWidth="0.8" opacity="0.55" />
            <Path d="M 64 23 L 50 50 M 36 23 L 50 50" stroke={veryDark} strokeWidth="0.6" opacity="0.45" />
            {/* upper-left bright facet */}
            <Polygon points="50,14 22,32 50,50" fill="#fff" opacity="0.35" />
            {/* upper-right slightly bright facet */}
            <Polygon points="50,14 78,32 50,50" fill="#fff" opacity="0.18" />
            {/* rim light on top edges */}
            <Path d="M 22 32 L 50 14 L 78 32" stroke="rgba(255,255,255,0.6)" strokeWidth="1.2" fill="none" />
            {/* bigger shine spot upper-left */}
            <Circle cx="36" cy="28" r="5" fill="#fff" opacity="0.75" />
            <Circle cx="34" cy="26" r="2" fill="#fff" />
            {/* two smaller inner sparkle pips */}
            <Circle cx="60" cy="36" r="1.5" fill="#fff" opacity="0.7" />
            <Circle cx="44" cy="60" r="1.2" fill="#fff" opacity="0.55" />
            {/* center symmetry dot (cut mark) */}
            <Circle cx="50" cy="50" r="1" fill={veryDark} opacity="0.7" />
          </>
        )}
        {tier === 4 && (
          // P4 RADIANT — 12-pointed brilliant + inner inset gem + 6-point sparkle
          <>
            {/* main body */}
            <Polygon points="50,8 64,22 86,28 78,50 86,72 64,78 50,92 36,78 14,72 22,50 14,28 36,22"
                     fill={`url(#${id}b)`} stroke={veryDark} strokeWidth="2" />
            {/* internal facets */}
            <Path d="M 50 8 L 50 50 M 64 22 L 50 50 M 86 28 L 50 50 M 78 50 L 50 50 M 86 72 L 50 50 M 64 78 L 50 50 M 50 92 L 50 50 M 36 78 L 50 50 M 14 72 L 50 50 M 22 50 L 50 50 M 14 28 L 50 50 M 36 22 L 50 50"
                  stroke={veryDark} strokeWidth="0.7" opacity="0.55" />
            {/* upper bright wedge */}
            <Polygon points="50,8 36,22 50,50 64,22" fill="#fff" opacity="0.35" />
            {/* INNER INSET GEM — smaller hex inside the body */}
            <Polygon points="50,30 64,42 64,58 50,70 36,58 36,42"
                     fill="none" stroke="#fff" strokeWidth="0.9" opacity="0.7" />
            <Polygon points="50,30 64,42 50,50" fill="#fff" opacity="0.25" />
            {/* rim light on upper edges */}
            <Path d="M 14 28 L 36 22 L 50 8 L 64 22 L 86 28"
                  stroke="rgba(255,255,255,0.5)" strokeWidth="1" fill="none" />
            {/* 6-POINT STAR sparkle (was 4-point) */}
            <Path d="M 38 26 L 40 30 L 44 31 L 40 32 L 42 38 L 38 34 L 34 38 L 36 32 L 32 31 L 36 30 Z" fill="#fff" />
            {/* 3 shine pips (was 2) */}
            <Circle cx="36" cy="62" r="2.2" fill="#fff" opacity="0.7" />
            <Circle cx="68" cy="36" r="1.7" fill="#fff" opacity="0.75" />
            <Circle cx="64" cy="64" r="1.3" fill="#fff" opacity="0.6" />
          </>
        )}
        {tier === 5 && (
          // P5 PERFECT — gold-spike crown, hex inset gem, double sparkle, 4 motes
          <>
            {/* main body */}
            <Polygon points="50,8 64,20 86,28 78,50 86,72 64,80 50,92 36,80 14,72 22,50 14,28 36,20"
                     fill={`url(#${id}b)`} stroke={veryDark} strokeWidth="2.2" />
            {/* gold trim along upper body edges */}
            <Path d="M 14 28 L 36 20 L 50 8 L 64 20 L 86 28" stroke="#ffd166" strokeWidth="0.7" fill="none" opacity="0.7" />
            {/* internal facets */}
            <Path d="M 50 8 L 50 50 M 64 20 L 50 50 M 86 28 L 50 50 M 78 50 L 50 50 M 86 72 L 50 50 M 64 80 L 50 50 M 50 92 L 50 50 M 36 80 L 50 50 M 14 72 L 50 50 M 22 50 L 50 50 M 14 28 L 50 50 M 36 20 L 50 50"
                  stroke={veryDark} strokeWidth="0.6" opacity="0.55" />
            {/* upper bright wedge */}
            <Polygon points="50,8 36,20 50,50 64,20" fill="#fff" opacity="0.4" />
            {/* PROPER HEX INSET GEM with its own light facet */}
            <Polygon points="50,28 64,40 64,58 50,70 36,58 36,40"
                     fill="rgba(255,255,255,0.25)" stroke="#ffd166" strokeWidth="0.8" />
            <Polygon points="50,28 64,40 50,50" fill="#fff" opacity="0.3" />
            {/* center dot */}
            <Circle cx="50" cy="50" r="1.2" fill="#ffd166" />
            {/* rim light */}
            <Path d="M 14 28 L 36 20 L 50 8 L 64 20 L 86 28" stroke="rgba(255,255,255,0.55)" strokeWidth="1.1" fill="none" />
            {/* CROWN — 5 gold spikes (was 3 points) */}
            <Polygon points="38,8 40,-4 42,8" fill={`url(#${id}crown)`} stroke={veryDark} strokeWidth="0.6" />
            <Polygon points="44,5 46,-7 48,5" fill={`url(#${id}crown)`} stroke={veryDark} strokeWidth="0.6" />
            <Polygon points="48,3 50,-10 52,3" fill={`url(#${id}crown)`} stroke={veryDark} strokeWidth="0.6" />
            <Polygon points="52,5 54,-7 56,5" fill={`url(#${id}crown)`} stroke={veryDark} strokeWidth="0.6" />
            <Polygon points="58,8 60,-4 62,8" fill={`url(#${id}crown)`} stroke={veryDark} strokeWidth="0.6" />
            <Circle cx="50" cy="-6" r="1.2" fill="#fff" />
            {/* 8-point starburst sparkle */}
            <Path d="M 36 28 L 38 32 L 42 32 L 39 36 L 41 40 L 36 38 L 31 40 L 33 36 L 30 32 L 34 32 Z"
                  fill="#fff" />
            {/* cross sparkle (top-right) */}
            <Path d="M 68 30 L 70 32 L 72 30 L 70 32 L 72 34 L 70 32 Z" fill="#fff" />
            <Path d="M 70 28 L 70 36 M 66 32 L 74 32" stroke="#fff" strokeWidth="0.8" />
            {/* 4 floating motes (was 1) */}
            <Circle cx="84" cy="14" r="1.8" fill="#fff" opacity="0.9" />
            <Circle cx="14" cy="80" r="1.6" fill="#fff" opacity="0.85" />
            <Circle cx="86" cy="84" r="1.2" fill="#fff" opacity="0.7" />
            <Circle cx="16" cy="20" r="1.2" fill="#fff" opacity="0.7" />
          </>
        )}
        {tier === 6 && (
          // P6 ASCENDANT — divine, 3-layer halo, inner starburst, reality cracks
          <>
            {/* 3-LAYER HALO behind everything */}
            <Circle cx="50" cy="50" r="48" fill={light} opacity="0.18" />
            <Circle cx="50" cy="50" r="48" fill="none" stroke="#ffd166" strokeWidth="0.7"
                    opacity="0.75" strokeDasharray="2 4" />
            <Circle cx="50" cy="50" r="42" fill="none" stroke="#fff" strokeWidth="0.5"
                    opacity="0.4" strokeDasharray="1 3" />
            <Circle cx="50" cy="50" r="38" fill="none" stroke="#ffd166" strokeWidth="0.4" opacity="0.5" />
            {/* main body */}
            <Polygon points="50,10 66,22 88,30 80,50 88,70 66,78 50,90 34,78 12,70 20,50 12,30 34,22"
                     fill={`url(#${id}b)`} stroke="#0a0510" strokeWidth="2.4" />
            {/* gold trim border */}
            <Polygon points="50,10 66,22 88,30 80,50 88,70 66,78 50,90 34,78 12,70 20,50 12,30 34,22"
                     fill="none" stroke="#ffd166" strokeWidth="1" />
            {/* INNER HEX INSET GEM with its own facet + starburst */}
            <Polygon points="50,28 60,38 68,50 60,62 50,72 40,62 32,50 40,38" fill="#fff"
                     opacity="0.35" />
            <Polygon points="50,28 60,38 68,50 60,62 50,72 40,62 32,50 40,38" fill="none"
                     stroke="#ffd166" strokeWidth="1" />
            {/* inner gem mini-starburst */}
            <Path d="M 50 38 L 51 46 L 58 47 L 51 49 L 56 56 L 50 51 L 44 56 L 49 49 L 42 47 L 49 46 Z"
                  fill="#fff" opacity="0.85" />
            {/* internal facets */}
            <Path d="M 50 10 L 50 50 M 66 22 L 50 50 M 88 30 L 50 50 M 80 50 L 50 50 M 88 70 L 50 50 M 66 78 L 50 50 M 50 90 L 50 50 M 34 78 L 50 50 M 12 70 L 50 50 M 20 50 L 50 50 M 12 30 L 50 50 M 34 22 L 50 50"
                  stroke={veryDark} strokeWidth="0.5" opacity="0.65" />
            <Polygon points="50,10 34,22 50,50 66,22" fill="#fff" opacity="0.45" />
            {/* rim light on outer edge */}
            <Path d="M 12 30 L 34 22 L 50 10 L 66 22 L 88 30"
                  stroke="rgba(255,255,255,0.55)" strokeWidth="1" fill="none" />
            {/* CROWN of 5 gold mini-gems */}
            <Polygon points="34,2 38,-6 42,2 38,8" fill={`url(#${id}crown)`} stroke="#0a0510" strokeWidth="0.6" />
            <Polygon points="42,-2 46,-10 50,-2 46,6" fill={`url(#${id}crown)`} stroke="#0a0510" strokeWidth="0.6" />
            <Polygon points="48,-4 50,-14 52,-14 54,-4 50,6" fill={`url(#${id}crown)`} stroke="#0a0510" strokeWidth="0.6" />
            <Polygon points="50,-2 54,-10 58,-2 54,6" fill={`url(#${id}crown)`} stroke="#0a0510" strokeWidth="0.6" />
            <Polygon points="58,2 62,-6 66,2 62,8" fill={`url(#${id}crown)`} stroke="#0a0510" strokeWidth="0.6" />
            {/* connecting gold band */}
            <Path d="M 34 4 Q 50 -2 66 4" stroke="#ffd166" strokeWidth="1.4" fill="none" />
            <Path d="M 36 6 Q 50 0 64 6" stroke="#fff7a8" strokeWidth="0.5" fill="none" opacity="0.85" />
            <Circle cx="50" cy="-10" r="1.5" fill="#fff" />
            {/* REALITY-TEAR CRACKS radiating outward */}
            <Path d="M 50 -2 L 50 6" stroke="#fff" strokeWidth="0.6" opacity="0.7" />
            <Path d="M 10 50 L 18 50" stroke="#fff" strokeWidth="0.5" opacity="0.6" />
            <Path d="M 82 50 L 90 50" stroke="#fff" strokeWidth="0.5" opacity="0.6" />
            <Path d="M 22 22 L 28 28" stroke="#fff" strokeWidth="0.4" opacity="0.55" />
            <Path d="M 78 22 L 72 28" stroke="#fff" strokeWidth="0.4" opacity="0.55" />
            <Path d="M 50 90 L 50 96" stroke="#fff" strokeWidth="0.5" opacity="0.55" />
            {/* big 8-point starburst sparkle (upper-left) */}
            <Path d="M 30 26 L 32 30 L 38 30 L 34 34 L 36 40 L 30 36 L 24 40 L 26 34 L 22 30 L 28 30 Z"
                  fill="#fff" />
            {/* secondary cross sparkle (upper-right) */}
            <Path d="M 70 30 L 70 38 M 66 34 L 74 34" stroke="#fff" strokeWidth="0.9" />
            <Circle cx="70" cy="34" r="1" fill="#fff" />
            {/* shine pips */}
            <Circle cx="64" cy="62" r="2" fill="#fff" opacity="0.85" />
            <Circle cx="32" cy="60" r="1.7" fill="#fff" opacity="0.75" />
            <Circle cx="48" cy="40" r="1" fill="#fff" />
            {/* 8 FLOATING MOTES (was 4) */}
            <Circle cx="88" cy="14" r="2.2" fill="#fff7a8" opacity="0.95" />
            <Circle cx="14" cy="84" r="2.2" fill="#fff7a8" opacity="0.95" />
            <Circle cx="86" cy="84" r="1.7" fill="#fff7a8" opacity="0.85" />
            <Circle cx="14" cy="16" r="1.7" fill="#fff7a8" opacity="0.85" />
            <Circle cx="92" cy="50" r="1.4" fill="#fff" opacity="0.8" />
            <Circle cx="8" cy="50" r="1.4" fill="#fff" opacity="0.8" />
            <Circle cx="50" cy="92" r="1.2" fill="#fff" opacity="0.7" />
            <Circle cx="50" cy="-2" r="1.2" fill="#fff" opacity="0.85" />
          </>
        )}
      </Svg>
      {/* Tier label baked on top */}
      <Text style={{
        position: 'absolute',
        color: labelColor,
        fontSize: TILE * 0.34, fontWeight: '900',
        textShadowColor: tier >= 4 ? '#fff8' : '#000a',
        textShadowOffset: { width: 0, height: 0 }, textShadowRadius: 1,
      }}>
        {gemLabel(gemType, tier)}
      </Text>
    </View>
  );
}

// ─── Special tower rendering — distinct silhouettes per tier ────────────────
// P2 = small spirit guardian (shielded crystal in a robed shroud).
// P3 = sentinel statue with crown and outer sigil.
// P4 = winged angel guardian with halo and staff.
// P5 = greater champion with double-wings, two-handed weapon, crown.
// P6 = cosmic mythic with floating rings, star core, multiple radiating shapes.
// All use recipe.color (main robe/body) and recipe.accent (trim/wings).

const SPECIAL_TIER_SCALE = { 2: 1.05, 3: 1.18, 4: 1.35, 5: 1.55, 6: 1.85 };
const SPECIAL_SPRITE_TIER_SCALE = { 2: 1.75, 3: 1.95, 4: 2.2, 5: 2.45, 6: 2.75 };

function SpecialSvg({ recipe, time = 0, id: towerId = 0 }) {
  const tier = parseInt(recipe.tier.slice(1), 10);
  const px = TILE * (SPECIAL_SPRITE_TIER_SCALE[tier] || 2);
  if (USE_SPRITES.towers && ASSET_MAP.towers[recipe.id]) {
    return (
      <RemoteSprite
        source={ASSET_MAP.towers[recipe.id]}
        style={{
          width: px,
          height: px,
          shadowColor: recipe.accent,
          shadowOpacity: 0.5,
          shadowRadius: 8,
          shadowOffset: { width: 0, height: 3 },
        }}
      >
        <SpecialFallbackSvg recipe={recipe} time={time} id={towerId} />
      </RemoteSprite>
    );
  }
  return <SpecialFallbackSvg recipe={recipe} time={time} id={towerId} />;
}

function SpecialFallbackSvg({ recipe, time = 0, id: towerId = 0 }) {
  const tier = parseInt(recipe.tier.slice(1), 10);
  const scale = SPECIAL_TIER_SCALE[tier] || 1;
  const px = TILE * scale;
  const id = useRef(nextGid()).current;
  const main = recipe.color;
  const accent = recipe.accent;
  const dark = darken(main, 0.55);
  const darker = darken(main, 0.75);
  const lightMain = `rgba(255,255,255,0.35)`;
  // Idle animation drivers — per-tower phase so adjacent specials don't sync.
  const phase = (towerId * 0.91) % (Math.PI * 2);
  const bob = Math.sin(time * 1.6 + phase) * (tier >= 5 ? 1.6 : 1.2);
  const wingFlap = Math.sin(time * 2.4 + phase) * (tier === 6 ? 9 : tier === 5 ? 7 : 5);
  const haloPulse = 0.85 + 0.15 * Math.sin(time * 2 + phase);

  return (
    <View pointerEvents="none" style={{
      width: px, height: px,
      alignItems: 'center', justifyContent: 'center',
    }}>
      <Svg width={px} height={px} viewBox="0 0 100 100">
        <Defs>
          {/* main body gradient — multi-stop for painted volume */}
          <LinearGradient id={`${id}b`} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={lightMain} />
            <Stop offset="0.15" stopColor={main} />
            <Stop offset="0.55" stopColor={main} />
            <Stop offset="1" stopColor={dark} />
          </LinearGradient>
          {/* stone base gradient */}
          <LinearGradient id={`${id}stone`} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor="#8a98b8" />
            <Stop offset="0.5" stopColor="#5a6a8c" />
            <Stop offset="1" stopColor="#1a2034" />
          </LinearGradient>
          {/* stone top gradient (lit from above) */}
          <RadialGradient id={`${id}stonetop`} cx="0.5" cy="0.3" r="0.6">
            <Stop offset="0" stopColor="#a8b4d0" />
            <Stop offset="1" stopColor="#3a4060" />
          </RadialGradient>
          {/* aura behind the figure */}
          <RadialGradient id={`${id}aura`} cx="0.5" cy="0.5" r="0.5">
            <Stop offset="0" stopColor={accent} stopOpacity={0.6} />
            <Stop offset="1" stopColor={accent} stopOpacity="0" />
          </RadialGradient>
        </Defs>

        {/* heavy drop shadow under base */}
        <Ellipse cx="50" cy={tier >= 5 ? 99 : 97} rx={tier >= 5 ? 46 : 38} ry="5" fill="#000" opacity="0.7" />

        {/* Aura behind the figure (grows with tier) */}
        <Circle cx="50" cy={tier >= 4 ? 40 : 50} r={tier >= 6 ? 50 : tier >= 5 ? 46 : tier >= 4 ? 42 : 36} fill={`url(#${id}aura)`} />

        {tier === 2 && (
          // P2 SPIRIT GUARDIAN — small monk on a stone disc
          <>
            {/* base — circular stone disc */}
            <Ellipse cx="50" cy="84" rx="32" ry="9" fill="#0a0510" opacity="0.4" />
            <Path d="M 18 76 Q 18 88 50 90 Q 82 88 82 76 Z" fill={`url(#${id}stone)`}
                  stroke="#0a0510" strokeWidth="2" />
            <Ellipse cx="50" cy="76" rx="32" ry="6" fill={`url(#${id}stonetop)`}
                     stroke="#0a0510" strokeWidth="2" />
            {/* rim lighting on top edge of stone */}
            <Ellipse cx="50" cy="73" rx="28" ry="3.5" fill="none" stroke="#cfd5e6" strokeWidth="0.8" opacity="0.65" />
            {/* accent ring on stone */}
            <Ellipse cx="50" cy="76" rx="24" ry="4" fill="none" stroke={accent} strokeWidth="1" opacity="0.7" />

            {/* === IDLE-BOB GROUP === */}
            <G transform={`translate(0, ${bob})`}>
              {/* boots peeking out from under robe */}
              <Ellipse cx="42" cy="74" rx="4" ry="2.2" fill={darker} stroke="#0a0510" strokeWidth="0.8" />
              <Ellipse cx="42" cy="73.5" rx="3" ry="1" fill={dark} opacity="0.7" />
              <Ellipse cx="58" cy="74" rx="4" ry="2.2" fill={darker} stroke="#0a0510" strokeWidth="0.8" />
              <Ellipse cx="58" cy="73.5" rx="3" ry="1" fill={dark} opacity="0.7" />

              {/* robed body */}
              <Path d="M 50 26 C 60 26 66 32 66 40 L 68 74 L 32 74 L 34 40 C 34 32 40 26 50 26 Z"
                    fill={`url(#${id}b)`} stroke="#0a0510" strokeWidth="2.2" />
              {/* rim light on robe (left side) */}
              <Path d="M 34 40 C 34 32 40 26 50 26" stroke="#fff" strokeWidth="0.8" fill="none" opacity="0.5" />
              {/* vertical seam down robe */}
              <Path d="M 50 42 L 50 74" stroke={darker} strokeWidth="0.5" opacity="0.6" />

              {/* folded arms — sleeves crossing in front */}
              <Path d="M 33 50 Q 38 60 50 60 Q 62 60 67 50" stroke={`url(#${id}b)`} strokeWidth="5" fill="none" />
              <Path d="M 33 50 Q 38 60 50 60 Q 62 60 67 50" stroke="#0a0510" strokeWidth="0.6" fill="none" />
              <Path d="M 33 50 Q 38 58 50 58" stroke="#fff" strokeWidth="0.5" fill="none" opacity="0.4" />
              {/* hands meeting at center (sleeve cuffs visible) */}
              <Circle cx="50" cy="60" r="2.2" fill={dark} stroke="#0a0510" strokeWidth="0.6" />

              {/* belt with buckle */}
              <Path d="M 33 65 L 67 65" stroke="#0a0510" strokeWidth="2.6" />
              <Path d="M 33 65 L 67 65" stroke={darker} strokeWidth="2" />
              <Polygon points="46,62 54,62 54,68 46,68" fill={accent} stroke="#0a0510" strokeWidth="0.8" />
              <Polygon points="46,62 50,65 50,62" fill="#fff" opacity="0.5" />

              {/* chest gem (diamond shape) above belt */}
              <Polygon points="50,44 56,52 50,60 44,52" fill={accent} stroke="#fff" strokeWidth="0.8" />
              <Polygon points="50,44 50,56 44,52" fill="#fff" opacity="0.5" />

              {/* hood */}
              <Path d="M 34 36 C 34 22 42 18 50 18 C 58 18 66 22 66 36 L 62 50 L 38 50 Z"
                    fill={dark} stroke="#0a0510" strokeWidth="2" />
              <Path d="M 34 36 C 34 22 42 18 50 18" stroke="#fff" strokeWidth="0.7" fill="none" opacity="0.45" />
              {/* hood ornament at top */}
              <Circle cx="50" cy="18" r="1.6" fill={accent} stroke="#0a0510" strokeWidth="0.4" />

              {/* face shadow under hood (very dark) */}
              <Path d="M 38 42 L 62 42 L 58 50 L 42 50 Z" fill="#000" />

              {/* TWO glowing eyes (was single slit) */}
              <Ellipse cx="45" cy="45" rx="2" ry="1.4" fill={accent} />
              <Circle cx="45" cy="45" r="0.7" fill="#fff" />
              <Ellipse cx="55" cy="45" rx="2" ry="1.4" fill={accent} />
              <Circle cx="55" cy="45" r="0.7" fill="#fff" />
              {/* brow ridge */}
              <Path d="M 42 42.5 L 47.5 43.5" stroke="#0a0510" strokeWidth="1" strokeLinecap="round" />
              <Path d="M 58 42.5 L 52.5 43.5" stroke="#0a0510" strokeWidth="1" strokeLinecap="round" />
            </G>
          </>
        )}

        {tier === 3 && (
          // P3 SENTINEL — taller figure on a stepped stone base
          <>
            {/* base — wider with steps */}
            <Ellipse cx="50" cy="85" rx="36" ry="9" fill="#0a0510" opacity="0.45" />
            <Path d="M 12 76 Q 12 92 50 94 Q 88 92 88 76 Z" fill={`url(#${id}stone)`}
                  stroke="#0a0510" strokeWidth="2" />
            <Ellipse cx="50" cy="76" rx="38" ry="7" fill={`url(#${id}stonetop)`}
                     stroke="#0a0510" strokeWidth="2" />
            <Ellipse cx="50" cy="73" rx="33" ry="4" fill="none" stroke="#cfd5e6" strokeWidth="0.8" opacity="0.7" />
            <Ellipse cx="50" cy="76" rx="26" ry="4.5" fill="none" stroke={accent} strokeWidth="1.2" opacity="0.75" />
            {/* base sigil pattern */}
            <Path d="M 50 74 L 58 78 L 50 82 L 42 78 Z" fill={accent} opacity="0.85" stroke="#0a0510" strokeWidth="0.6" />

            {/* === IDLE-BOB GROUP === */}
            <G transform={`translate(0, ${bob})`}>
              {/* boots peeking out from under robe */}
              <Ellipse cx="40" cy="74" rx="4.5" ry="2.4" fill={darker} stroke="#0a0510" strokeWidth="0.8" />
              <Ellipse cx="40" cy="73.5" rx="3.5" ry="1.2" fill={dark} opacity="0.7" />
              <Ellipse cx="60" cy="74" rx="4.5" ry="2.4" fill={darker} stroke="#0a0510" strokeWidth="0.8" />
              <Ellipse cx="60" cy="73.5" rx="3.5" ry="1.2" fill={dark} opacity="0.7" />

              {/* outer sigil ring around head */}
              <Circle cx="50" cy="20" r="13" fill="none" stroke={accent} strokeWidth="1" opacity="0.55"
                      strokeDasharray="3 2" />
              {/* halo */}
              <Circle cx="50" cy="22" r="10" fill="none" stroke={accent} strokeWidth="2.5" />
              <Circle cx="50" cy="22" r="10" fill="none" stroke="#fff" strokeWidth="0.6" opacity="0.55" />
              {/* robed body */}
              <Path d="M 50 26 C 64 26 72 34 72 46 L 76 74 L 24 74 L 28 46 C 28 34 36 26 50 26 Z"
                    fill={`url(#${id}b)`} stroke="#0a0510" strokeWidth="2.4" />
              <Path d="M 28 46 C 28 34 36 26 50 26" stroke="#fff" strokeWidth="0.8" fill="none" opacity="0.5" />
              {/* robe vertical seam */}
              <Path d="M 50 36 L 50 74" stroke={darker} strokeWidth="0.5" opacity="0.6" />
              {/* head */}
              <Circle cx="50" cy="24" r="9" fill={dark} stroke="#0a0510" strokeWidth="1.5" />
              {/* face hood shadow */}
              <Path d="M 43 22 Q 50 16 57 22 L 55 32 L 45 32 Z" fill="#0a0510" />
              {/* two glowing eyes */}
              <Circle cx="46" cy="23" r="1.5" fill={accent} />
              <Circle cx="54" cy="23" r="1.5" fill={accent} />
              <Circle cx="46" cy="22.5" r="0.5" fill="#fff" />
              <Circle cx="54" cy="22.5" r="0.5" fill="#fff" />
              {/* brow ridge */}
              <Path d="M 43 21 L 48 22" stroke="#0a0510" strokeWidth="1" strokeLinecap="round" />
              <Path d="M 57 21 L 52 22" stroke="#0a0510" strokeWidth="1" strokeLinecap="round" />
              {/* crown */}
              <Polygon points="42,16 46,8 50,14 54,8 58,16" fill={accent} stroke="#0a0510" strokeWidth="0.8" />
              <Circle cx="50" cy="10" r="1.5" fill="#fff" />
              {/* chest sigil */}
              <Polygon points="50,46 60,56 50,66 40,56" fill={accent} stroke="#fff" strokeWidth="0.8" />
              <Polygon points="50,46 50,66 40,56" fill="#fff" opacity="0.35" />
              <Path d="M 40 56 L 60 56 M 50 46 L 50 66" stroke="#0a0510" strokeWidth="0.6" />
              {/* arms with VISIBLE hand cuffs */}
              <Path d="M 30 50 Q 38 60 50 62 Q 62 60 70 50" stroke={`url(#${id}b)`} strokeWidth="5" fill="none" />
              <Path d="M 30 50 Q 38 60 50 62 Q 62 60 70 50" stroke="#0a0510" strokeWidth="0.6" fill="none" />
              <Path d="M 30 50 Q 38 58 50 60" stroke="#fff" strokeWidth="0.5" fill="none" opacity="0.4" />
              {/* hand cuffs */}
              <Circle cx="32" cy="50" r="2" fill={dark} stroke="#0a0510" strokeWidth="0.5" />
              <Circle cx="68" cy="50" r="2" fill={dark} stroke="#0a0510" strokeWidth="0.5" />
              {/* robe trim hem */}
              <Path d="M 24 70 L 76 70" stroke={accent} strokeWidth="1.5" />
              {/* belt with buckle */}
              <Path d="M 28 64 L 72 64" stroke="#0a0510" strokeWidth="2.6" />
              <Path d="M 28 64 L 72 64" stroke={darker} strokeWidth="2" />
              <Polygon points="46,61 54,61 54,67 46,67" fill={accent} stroke="#0a0510" strokeWidth="0.8" />
              {/* floating side gems */}
              <Polygon points="12,46 16,42 20,46 16,50" fill={accent} stroke="#0a0510" strokeWidth="0.6" />
              <Polygon points="80,46 84,42 88,46 84,50" fill={accent} stroke="#0a0510" strokeWidth="0.6" />
              <Circle cx="16" cy="46" r="0.8" fill="#fff" />
              <Circle cx="84" cy="46" r="0.8" fill="#fff" />
            </G>
          </>
        )}

        {tier === 4 && (
          // P4 ANGEL GUARDIAN — winged paladin on a stone pillar
          <>
            {/* base — taller pillar */}
            <Ellipse cx="50" cy="89" rx="38" ry="10" fill="#0a0510" opacity="0.6" />
            {/* pillar shaft (rectangular) */}
            <Path d="M 18 72 L 82 72 L 86 92 L 14 92 Z" fill={`url(#${id}stone)`}
                  stroke="#0a0510" strokeWidth="2.2" />
            {/* pillar top cap */}
            <Path d="M 12 72 L 88 72 L 84 80 L 16 80 Z" fill={`url(#${id}stone)`}
                  stroke="#0a0510" strokeWidth="2" />
            <Ellipse cx="50" cy="72" rx="38" ry="6" fill={`url(#${id}stonetop)`}
                     stroke="#0a0510" strokeWidth="2" />
            <Ellipse cx="50" cy="69" rx="33" ry="4" fill="none" stroke="#cfd5e6" strokeWidth="0.8" opacity="0.7" />
            {/* gold trim band */}
            <Path d="M 16 80 L 84 80" stroke="#ffd166" strokeWidth="1.5" />
            <Path d="M 18 76 L 82 76" stroke="#ffd166" strokeWidth="0.8" opacity="0.85" />
            {/* inner accent ring on top */}
            <Ellipse cx="50" cy="72" rx="24" ry="4" fill="none" stroke={accent} strokeWidth="1.2" opacity="0.8" />
            {/* pillar vertical grooves */}
            <Path d="M 32 72 L 30 92" stroke="#0a0510" strokeWidth="0.7" />
            <Path d="M 68 72 L 70 92" stroke="#0a0510" strokeWidth="0.7" />
            <Path d="M 50 72 L 50 92" stroke="#0a0510" strokeWidth="0.5" opacity="0.6" />
            {/* sigil panel on pillar */}
            <Polygon points="50,80 56,84 50,88 44,84" fill={accent} stroke="#0a0510" strokeWidth="0.6" />

            {/* === WINGS — flap independently from body bob === */}
            <G transform={`rotate(${-wingFlap}, 30, 36)`}>
              <Path d="M 30 36 Q 4 22 -4 50 Q 8 50 22 56 Q 4 60 6 72 Q 22 64 30 60 Z"
                    fill={accent} stroke="#0a0510" strokeWidth="1.5" />
              <Path d="M 6 30 L 24 46" stroke="#fff" strokeWidth="0.6" opacity="0.65" />
              <Path d="M 0 46 L 22 52" stroke="#fff" strokeWidth="0.5" opacity="0.55" />
              <Path d="M 8 64 L 26 58" stroke="#fff" strokeWidth="0.5" opacity="0.5" />
              <Path d="M 30 36 Q 4 22 -4 50" stroke="#fff" strokeWidth="0.6" fill="none" opacity="0.4" />
              {/* extra inner feather lines */}
              <Path d="M 12 38 L 26 50" stroke="#0a0510" strokeWidth="0.4" opacity="0.5" />
              <Path d="M 4 54 L 24 56" stroke="#0a0510" strokeWidth="0.4" opacity="0.5" />
            </G>
            <G transform={`rotate(${wingFlap}, 70, 36)`}>
              <Path d="M 70 36 Q 96 22 104 50 Q 92 50 78 56 Q 96 60 94 72 Q 78 64 70 60 Z"
                    fill={accent} stroke="#0a0510" strokeWidth="1.5" />
              <Path d="M 94 30 L 76 46" stroke="#fff" strokeWidth="0.6" opacity="0.65" />
              <Path d="M 100 46 L 78 52" stroke="#fff" strokeWidth="0.5" opacity="0.55" />
              <Path d="M 92 64 L 74 58" stroke="#fff" strokeWidth="0.5" opacity="0.5" />
              <Path d="M 70 36 Q 96 22 104 50" stroke="#fff" strokeWidth="0.6" fill="none" opacity="0.4" />
              <Path d="M 88 38 L 74 50" stroke="#0a0510" strokeWidth="0.4" opacity="0.5" />
              <Path d="M 96 54 L 76 56" stroke="#0a0510" strokeWidth="0.4" opacity="0.5" />
            </G>

            {/* === IDLE-BOB GROUP — body floats relative to wings === */}
            <G transform={`translate(0, ${bob})`}>
              {/* boots peeking out from under armor skirt */}
              <Ellipse cx="40" cy="72" rx="5" ry="2.6" fill={darker} stroke="#0a0510" strokeWidth="0.9" />
              <Ellipse cx="40" cy="71.5" rx="4" ry="1.4" fill={dark} opacity="0.7" />
              <Path d="M 37 70 L 43 70" stroke="#ffd166" strokeWidth="0.6" />
              <Ellipse cx="60" cy="72" rx="5" ry="2.6" fill={darker} stroke="#0a0510" strokeWidth="0.9" />
              <Ellipse cx="60" cy="71.5" rx="4" ry="1.4" fill={dark} opacity="0.7" />
              <Path d="M 57 70 L 63 70" stroke="#ffd166" strokeWidth="0.6" />

              {/* halo behind head */}
              <Circle cx="50" cy="18" r="11" fill="none" stroke={accent} strokeWidth="2.6" />
              <Circle cx="50" cy="18" r="11" fill="none" stroke="#fff" strokeWidth="0.8" opacity="0.55" />
              <Circle cx="50" cy="18" r="8" fill="none" stroke={accent} strokeWidth="0.8" opacity="0.7" />

              {/* armoured body */}
              <Path d="M 50 26 C 64 26 72 34 72 44 L 74 70 L 26 70 L 28 44 C 28 34 36 26 50 26 Z"
                    fill={`url(#${id}b)`} stroke="#0a0510" strokeWidth="2.6" />
              <Path d="M 28 44 C 28 34 36 26 50 26" stroke="#fff" strokeWidth="0.9" fill="none" opacity="0.5" />
              {/* breastplate */}
              <Path d="M 38 36 L 62 36 L 60 66 L 40 66 Z" fill={dark} stroke="#0a0510" strokeWidth="1.5" />
              <Path d="M 38 36 L 62 36" stroke="#fff" strokeWidth="0.7" opacity="0.5" />
              {/* gold trim on breastplate */}
              <Path d="M 38 36 L 62 36" stroke="#ffd166" strokeWidth="1" />
              <Path d="M 40 66 L 60 66" stroke="#ffd166" strokeWidth="0.8" />
              {/* large diamond sigil on chest */}
              <Polygon points="50,42 60,52 50,62 40,52" fill={accent} stroke="#fff" strokeWidth="0.9" />
              <Polygon points="50,42 50,62 40,52" fill="#fff" opacity="0.4" />
              <Path d="M 40 52 L 60 52 M 50 42 L 50 62" stroke="#0a0510" strokeWidth="0.6" />
              {/* belt with buckle */}
              <Path d="M 28 66 L 72 66" stroke="#0a0510" strokeWidth="2.6" />
              <Path d="M 28 66 L 72 66" stroke="#ffd166" strokeWidth="1.6" />
              <Polygon points="46,63 54,63 54,69 46,69" fill={accent} stroke="#0a0510" strokeWidth="0.7" />
              <Polygon points="46,63 50,66 50,63" fill="#fff" opacity="0.5" />
              {/* head with helmet */}
              <Circle cx="50" cy="22" r="9" fill={accent} stroke="#0a0510" strokeWidth="1.5" />
              {/* helmet top crest */}
              <Path d="M 50 13 L 48 17 L 52 17 Z" fill="#ffd166" stroke="#0a0510" strokeWidth="0.5" />
              {/* visor strip */}
              <Path d="M 41 22 L 59 22" stroke="#0a0510" strokeWidth="1.8" />
              <Path d="M 42 23 L 58 23" stroke="#fff" strokeWidth="0.6" />
              {/* TWO glowing eyes inside visor */}
              <Circle cx="46" cy="23" r="1" fill="#fff" />
              <Circle cx="54" cy="23" r="1" fill="#fff" />
              {/* brow / face plate detail */}
              <Path d="M 50 24 L 50 30 M 47 28 L 53 28" stroke="#0a0510" strokeWidth="0.6" />
              {/* small forehead gem */}
              <Circle cx="50" cy="17" r="1.8" fill="#fff" stroke="#0a0510" strokeWidth="0.4" />

              {/* pauldron (left shoulder) */}
              <Path d="M 26 36 Q 22 28 32 26 L 36 36 Z" fill={accent} stroke="#0a0510" strokeWidth="1.1" />
              <Path d="M 26 36 Q 22 28 32 26" stroke="#fff" strokeWidth="0.5" fill="none" opacity="0.55" />
              <Circle cx="29" cy="31" r="1" fill="#ffd166" />
              {/* pauldron (right shoulder) */}
              <Path d="M 74 36 Q 78 28 68 26 L 64 36 Z" fill={accent} stroke="#0a0510" strokeWidth="1.1" />
              <Path d="M 74 36 Q 78 28 68 26" stroke="#fff" strokeWidth="0.5" fill="none" opacity="0.55" />
              <Circle cx="71" cy="31" r="1" fill="#ffd166" />

              {/* staff in right hand */}
              <Rect x="76" y="20" width="2.5" height="48" fill="#3a2806" stroke="#0a0510" strokeWidth="0.5" />
              <Polygon points="77,16 71,22 77,30 83,22" fill={accent} stroke="#fff" strokeWidth="0.8" />
              <Circle cx="77" cy="22" r="1.5" fill="#fff" />
              <Circle cx="77" cy="22" r="3" fill={accent} opacity="0.3" />
              {/* hand gripping staff */}
              <Circle cx="77" cy="46" r="2" fill={dark} stroke="#0a0510" strokeWidth="0.5" />
            </G>
          </>
        )}

        {tier === 5 && (
          // P5 GREATER CHAMPION — bigger, on a tiered stone dais with gold inlay
          <>
            {/* drop shadow */}
            <Ellipse cx="50" cy="92" rx="44" ry="9" fill="#0a0510" opacity="0.65" />
            {/* base — multi-tier dais */}
            <Path d="M 6 78 L 94 78 L 88 92 L 12 92 Z" fill={`url(#${id}stone)`}
                  stroke="#0a0510" strokeWidth="2.4" />
            {/* upper tier */}
            <Path d="M 12 70 L 88 70 L 84 80 L 16 80 Z" fill={`url(#${id}stone)`}
                  stroke="#0a0510" strokeWidth="2.2" />
            <Ellipse cx="50" cy="70" rx="38" ry="5.5" fill={`url(#${id}stonetop)`}
                     stroke="#0a0510" strokeWidth="2" />
            {/* rim lighting on top edge */}
            <Ellipse cx="50" cy="67" rx="33" ry="3" fill="none" stroke="#cfd5e6" strokeWidth="1" opacity="0.75" />
            {/* gold inlay on tiers */}
            <Path d="M 16 80 L 84 80" stroke="#ffd166" strokeWidth="1.6" />
            <Path d="M 12 78 L 88 78" stroke="#ffd166" strokeWidth="1" opacity="0.85" />
            <Path d="M 6 78 L 94 78" stroke="#ffd166" strokeWidth="0.6" opacity="0.7" />
            {/* base gems */}
            <Polygon points="50,82 56,86 50,90 44,86" fill={accent} stroke="#fff" strokeWidth="0.6" />
            <Polygon points="22,84 26,82 30,84 26,86" fill={accent} stroke="#0a0510" strokeWidth="0.4" />
            <Polygon points="70,84 74,82 78,84 74,86" fill={accent} stroke="#0a0510" strokeWidth="0.4" />
            {/* pillar grooves */}
            <Path d="M 28 70 L 26 92" stroke="#0a0510" strokeWidth="0.6" />
            <Path d="M 72 70 L 74 92" stroke="#0a0510" strokeWidth="0.6" />

            {/* === WINGS (4 total — upper + lower pair on each side) flap === */}
            <G transform={`rotate(${-wingFlap}, 30, 32)`}>
              <Path d="M 30 32 Q 0 14 -8 38 Q 4 38 22 50 Z" fill={accent} stroke="#0a0510" strokeWidth="1.4" />
              <Path d="M 30 32 Q 0 14 -8 38" stroke="#fff" strokeWidth="0.6" fill="none" opacity="0.5" />
              <Path d="M 6 22 L 24 42" stroke="#fff" strokeWidth="0.6" opacity="0.6" />
              <Path d="M 0 32 L 22 46" stroke="#fff" strokeWidth="0.5" opacity="0.6" />
              {/* feather separators */}
              <Path d="M 12 24 L 24 44" stroke="#0a0510" strokeWidth="0.4" opacity="0.5" />
              <Path d="M 6 36 L 22 48" stroke="#0a0510" strokeWidth="0.4" opacity="0.5" />
            </G>
            <G transform={`rotate(${-wingFlap * 0.6}, 30, 50)`}>
              <Path d="M 30 50 Q 2 48 -4 70 Q 14 64 30 60 Z" fill={accent} stroke="#0a0510" strokeWidth="1.4" opacity="0.9" />
              <Path d="M 4 56 L 26 58" stroke="#fff" strokeWidth="0.5" opacity="0.5" />
              <Path d="M 8 66 L 28 62" stroke="#fff" strokeWidth="0.5" opacity="0.5" />
              <Path d="M 6 60 L 28 60" stroke="#0a0510" strokeWidth="0.4" opacity="0.5" />
            </G>
            <G transform={`rotate(${wingFlap}, 70, 32)`}>
              <Path d="M 70 32 Q 100 14 108 38 Q 96 38 78 50 Z" fill={accent} stroke="#0a0510" strokeWidth="1.4" />
              <Path d="M 70 32 Q 100 14 108 38" stroke="#fff" strokeWidth="0.6" fill="none" opacity="0.5" />
              <Path d="M 94 22 L 76 42" stroke="#fff" strokeWidth="0.6" opacity="0.6" />
              <Path d="M 100 32 L 78 46" stroke="#fff" strokeWidth="0.5" opacity="0.6" />
              <Path d="M 88 24 L 76 44" stroke="#0a0510" strokeWidth="0.4" opacity="0.5" />
              <Path d="M 94 36 L 78 48" stroke="#0a0510" strokeWidth="0.4" opacity="0.5" />
            </G>
            <G transform={`rotate(${wingFlap * 0.6}, 70, 50)`}>
              <Path d="M 70 50 Q 98 48 104 70 Q 86 64 70 60 Z" fill={accent} stroke="#0a0510" strokeWidth="1.4" opacity="0.9" />
              <Path d="M 96 56 L 74 58" stroke="#fff" strokeWidth="0.5" opacity="0.5" />
              <Path d="M 92 66 L 72 62" stroke="#fff" strokeWidth="0.5" opacity="0.5" />
              <Path d="M 94 60 L 72 60" stroke="#0a0510" strokeWidth="0.4" opacity="0.5" />
            </G>

            {/* === IDLE-BOB GROUP — body floats relative to wings === */}
            <G transform={`translate(0, ${bob})`}>
              {/* boots at the bottom */}
              <Ellipse cx="38" cy="70" rx="5.5" ry="2.8" fill={darker} stroke="#0a0510" strokeWidth="0.9" />
              <Ellipse cx="38" cy="69.5" rx="4.5" ry="1.5" fill={dark} opacity="0.7" />
              <Path d="M 34 68 L 42 68" stroke="#ffd166" strokeWidth="0.7" />
              <Ellipse cx="62" cy="70" rx="5.5" ry="2.8" fill={darker} stroke="#0a0510" strokeWidth="0.9" />
              <Ellipse cx="62" cy="69.5" rx="4.5" ry="1.5" fill={dark} opacity="0.7" />
              <Path d="M 58 68 L 66 68" stroke="#ffd166" strokeWidth="0.7" />

              {/* multi-halo (opacity pulses gently) */}
              <Circle cx="50" cy="16" r="13" fill="none" stroke={accent} strokeWidth="2.8" opacity={haloPulse} />
              <Circle cx="50" cy="16" r="10" fill="none" stroke="#fff" strokeWidth="0.7" opacity={0.6 * haloPulse} />
              <Circle cx="50" cy="16" r="7" fill="none" stroke={accent} strokeWidth="1" opacity={0.7 * haloPulse} />

              {/* armoured body */}
              <Path d="M 50 24 C 66 24 74 32 74 44 L 78 68 L 22 68 L 26 44 C 26 32 34 24 50 24 Z"
                    fill={`url(#${id}b)`} stroke="#0a0510" strokeWidth="2.8" />
              <Path d="M 26 44 C 26 32 34 24 50 24" stroke="#fff" strokeWidth="1" fill="none" opacity="0.55" />
              {/* breastplate */}
              <Path d="M 34 36 L 66 36 L 64 64 L 36 64 Z" fill={dark} stroke="#0a0510" strokeWidth="1.6" />
              <Path d="M 34 36 L 66 36" stroke="#fff" strokeWidth="0.7" opacity="0.55" />
              {/* gold trim on breastplate */}
              <Path d="M 34 36 L 66 36" stroke="#ffd166" strokeWidth="1.2" />
              <Path d="M 36 64 L 64 64" stroke="#ffd166" strokeWidth="1" />
              <Path d="M 34 36 L 36 64" stroke="#ffd166" strokeWidth="0.6" opacity="0.85" />
              <Path d="M 66 36 L 64 64" stroke="#ffd166" strokeWidth="0.6" opacity="0.85" />
              {/* large double-diamond sigil */}
              <Polygon points="50,38 64,50 50,62 36,50" fill={accent} stroke="#fff" strokeWidth="1" />
              <Polygon points="50,42 60,50 50,58 40,50" fill="#fff" opacity="0.5" />
              <Polygon points="50,42 60,50 50,58 40,50" fill="none" stroke="#0a0510" strokeWidth="0.5" />
              <Path d="M 36 50 L 64 50 M 50 38 L 50 62" stroke="#0a0510" strokeWidth="0.6" />
              {/* belt with buckle */}
              <Path d="M 26 64 L 74 64" stroke="#0a0510" strokeWidth="2.8" />
              <Path d="M 26 64 L 74 64" stroke="#ffd166" strokeWidth="1.8" />
              <Polygon points="46,61 54,61 54,67 46,67" fill={accent} stroke="#0a0510" strokeWidth="0.8" />
              <Polygon points="46,61 50,64 50,61" fill="#fff" opacity="0.5" />
              {/* head with golden crown */}
              <Circle cx="50" cy="20" r="9" fill={accent} stroke="#0a0510" strokeWidth="1.5" />
              {/* gold crown points */}
              <Polygon points="40,14 44,4 48,12 52,2 56,12 60,4 64,14" fill="#ffd166" stroke="#0a0510" strokeWidth="0.8" />
              <Circle cx="52" cy="5" r="2" fill="#fff" />
              {/* visor */}
              <Path d="M 42 21 L 58 21" stroke="#0a0510" strokeWidth="1.8" />
              <Path d="M 43 22 L 57 22" stroke="#fff" strokeWidth="0.5" />
              {/* TWO eye dots inside visor */}
              <Circle cx="46" cy="22" r="0.9" fill="#fff" />
              <Circle cx="54" cy="22" r="0.9" fill="#fff" />
              {/* face plate detail */}
              <Path d="M 50 24 L 50 30 M 47 28 L 53 28" stroke="#0a0510" strokeWidth="0.6" />
              {/* forehead gem */}
              <Circle cx="50" cy="15" r="2" fill="#fff" stroke="#0a0510" strokeWidth="0.4" />

              {/* shoulder pauldrons (with edge highlights and inset gem) */}
              <Path d="M 22 38 Q 18 30 28 26 L 36 36 Z" fill={accent} stroke="#0a0510" strokeWidth="1.2" />
              <Path d="M 22 38 Q 18 30 28 26" stroke="#fff" strokeWidth="0.5" fill="none" opacity="0.6" />
              <Circle cx="26" cy="31" r="1.2" fill="#ffd166" stroke="#0a0510" strokeWidth="0.3" />
              <Path d="M 78 38 Q 82 30 72 26 L 64 36 Z" fill={accent} stroke="#0a0510" strokeWidth="1.2" />
              <Path d="M 78 38 Q 82 30 72 26" stroke="#fff" strokeWidth="0.5" fill="none" opacity="0.6" />
              <Circle cx="74" cy="31" r="1.2" fill="#ffd166" stroke="#0a0510" strokeWidth="0.3" />

              {/* greatsword behind body */}
              <Rect x="48.5" y="-2" width="3" height="76" fill="#cfd5e6" stroke="#0a0510" strokeWidth="0.6" />
              <Path d="M 48.5 -2 L 51.5 -2" stroke="#fff" strokeWidth="0.5" />
              <Polygon points="46,-2 54,-2 50,-10" fill="#cfd5e6" stroke="#0a0510" strokeWidth="0.6" />
              <Rect x="42" y="42" width="16" height="3.5" fill="#7a6a3a" stroke="#0a0510" strokeWidth="0.5" />
              <Path d="M 42 42 L 58 42" stroke="#ffd166" strokeWidth="0.8" />
              <Circle cx="50" cy="55" r="2" fill="#ffd166" stroke="#0a0510" strokeWidth="0.4" />

              {/* floating motes */}
              <Circle cx="8" cy="10" r="1.5" fill="#fff" opacity={0.85 * haloPulse} />
              <Circle cx="92" cy="10" r="1.5" fill="#fff" opacity={0.85 * haloPulse} />
            </G>
          </>
        )}

        {tier === 6 && (
          // P6 COSMIC MYTHIC — floating cosmic being on a magic dais with floating orbs
          <>
            {/* drop shadow on floor */}
            <Ellipse cx="50" cy="94" rx="48" ry="6" fill="#0a0510" opacity="0.75" />
            {/* orbit rings under figure (magic dais) */}
            <Ellipse cx="50" cy="84" rx="44" ry="9" fill="none" stroke="#ffd166" strokeWidth="0.7" opacity={0.7 * haloPulse} strokeDasharray="2 3" />
            <Ellipse cx="50" cy="84" rx="36" ry="6.5" fill="none" stroke={accent} strokeWidth="1.5" opacity="0.75" />
            <Ellipse cx="50" cy="84" rx="28" ry="4.5" fill="none" stroke="#fff" strokeWidth="0.6" opacity="0.55" />
            {/* magic platform top — runic disc */}
            <Ellipse cx="50" cy="80" rx="30" ry="5" fill={`url(#${id}stonetop)`} stroke="#0a0510" strokeWidth="2" />
            <Ellipse cx="50" cy="80" rx="30" ry="5" fill="none" stroke="#ffd166" strokeWidth="1.2" />
            {/* runes on the disc */}
            <Path d="M 32 80 L 36 78 L 32 82 Z" fill={accent} />
            <Path d="M 50 80 L 53 77 L 53 83 Z" fill="#fff" opacity="0.85" />
            <Path d="M 68 80 L 64 78 L 68 82 Z" fill={accent} />
            {/* glow under the disc — figure appears to hover */}
            <Ellipse cx="50" cy="76" rx="22" ry="3" fill="#ffd166" opacity={0.65 * haloPulse} />

            {/* reality-tear cracks (pulsing white) */}
            <Path d="M 50 -8 L 50 2" stroke="#fff" strokeWidth="1.5" opacity={0.7 * haloPulse} />
            <Path d="M 14 4 L 22 12" stroke="#fff" strokeWidth="1.2" opacity={0.6 * haloPulse} />
            <Path d="M 86 4 L 78 12" stroke="#fff" strokeWidth="1.2" opacity={0.6 * haloPulse} />
            <Path d="M -4 50 L 6 50" stroke="#fff" strokeWidth="1.2" opacity={0.6 * haloPulse} />
            <Path d="M 94 50 L 104 50" stroke="#fff" strokeWidth="1.2" opacity={0.6 * haloPulse} />

            {/* === TRIPLE WINGS per side — each pair flaps at different rate === */}
            <G transform={`rotate(${-wingFlap}, 30, 30)`}>
              <Path d="M 30 30 Q 0 8 -10 36 Q 6 36 22 48 Z" fill={accent} stroke="#0a0510" strokeWidth="1.4" />
              <Path d="M -4 16 L 24 38" stroke="#fff" strokeWidth="0.6" opacity="0.65" />
              <Path d="M 10 16 L 24 40" stroke="#0a0510" strokeWidth="0.4" opacity="0.55" />
            </G>
            <G transform={`rotate(${-wingFlap * 0.75}, 28, 46)`}>
              <Path d="M 28 46 Q -10 42 -10 64 Q 6 60 28 56 Z" fill={accent} stroke="#0a0510" strokeWidth="1.4" opacity="0.92" />
              <Path d="M -8 42 L 22 52" stroke="#fff" strokeWidth="0.5" opacity="0.6" />
              <Path d="M -4 56 L 26 56" stroke="#0a0510" strokeWidth="0.4" opacity="0.5" />
            </G>
            <G transform={`rotate(${-wingFlap * 0.5}, 30, 60)`}>
              <Path d="M 30 60 Q -2 64 -2 80 Q 16 72 32 68 Z" fill={accent} stroke="#0a0510" strokeWidth="1.4" opacity="0.85" />
              <Path d="M 0 70 L 28 64" stroke="#fff" strokeWidth="0.5" opacity="0.55" />
              <Path d="M 4 76 L 28 70" stroke="#0a0510" strokeWidth="0.4" opacity="0.5" />
            </G>
            <G transform={`rotate(${wingFlap}, 70, 30)`}>
              <Path d="M 70 30 Q 100 8 110 36 Q 94 36 78 48 Z" fill={accent} stroke="#0a0510" strokeWidth="1.4" />
              <Path d="M 104 16 L 76 38" stroke="#fff" strokeWidth="0.6" opacity="0.65" />
              <Path d="M 90 16 L 76 40" stroke="#0a0510" strokeWidth="0.4" opacity="0.55" />
            </G>
            <G transform={`rotate(${wingFlap * 0.75}, 72, 46)`}>
              <Path d="M 72 46 Q 110 42 110 64 Q 94 60 72 56 Z" fill={accent} stroke="#0a0510" strokeWidth="1.4" opacity="0.92" />
              <Path d="M 108 42 L 78 52" stroke="#fff" strokeWidth="0.5" opacity="0.6" />
              <Path d="M 104 56 L 74 56" stroke="#0a0510" strokeWidth="0.4" opacity="0.5" />
            </G>
            <G transform={`rotate(${wingFlap * 0.5}, 70, 60)`}>
              <Path d="M 70 60 Q 102 64 102 80 Q 84 72 68 68 Z" fill={accent} stroke="#0a0510" strokeWidth="1.4" opacity="0.85" />
              <Path d="M 100 70 L 72 64" stroke="#fff" strokeWidth="0.5" opacity="0.55" />
              <Path d="M 96 76 L 72 70" stroke="#0a0510" strokeWidth="0.4" opacity="0.5" />
            </G>

            {/* === IDLE-BOB GROUP — body hovers above the dais === */}
            <G transform={`translate(0, ${bob})`}>
              {/* boots peeking out from radiant body */}
              <Ellipse cx="38" cy="74" rx="6" ry="3" fill={darker} stroke="#0a0510" strokeWidth="1" />
              <Ellipse cx="38" cy="73.5" rx="5" ry="1.6" fill={dark} opacity="0.7" />
              <Path d="M 33 71.5 L 43 71.5" stroke="#ffd166" strokeWidth="0.8" />
              <Ellipse cx="62" cy="74" rx="6" ry="3" fill={darker} stroke="#0a0510" strokeWidth="1" />
              <Ellipse cx="62" cy="73.5" rx="5" ry="1.6" fill={dark} opacity="0.7" />
              <Path d="M 57 71.5 L 67 71.5" stroke="#ffd166" strokeWidth="0.8" />

              {/* multi-layer halo (opacity pulses) */}
              <Circle cx="50" cy="14" r="16" fill="none" stroke="#ffd166" strokeWidth="0.7" opacity={0.65 * haloPulse} strokeDasharray="1 3" />
              <Circle cx="50" cy="14" r="13" fill="none" stroke={accent} strokeWidth="2.5" opacity={haloPulse} />
              <Circle cx="50" cy="14" r="10" fill="none" stroke="#fff" strokeWidth="0.8" opacity={0.7 * haloPulse} />
              <Circle cx="50" cy="14" r="7" fill="none" stroke={accent} strokeWidth="1.2" opacity={haloPulse} />

              {/* radiant body */}
              <Path d="M 50 24 C 70 24 80 32 80 46 L 84 72 L 16 72 L 20 46 C 20 32 30 24 50 24 Z"
                    fill={`url(#${id}b)`} stroke="#0a0510" strokeWidth="3" />
              <Path d="M 50 24 C 70 24 80 32 80 46 L 84 72 L 16 72 L 20 46 C 20 32 30 24 50 24 Z"
                    fill="none" stroke="#ffd166" strokeWidth="1.2" />
              <Path d="M 20 46 C 20 32 30 24 50 24" stroke="#fff" strokeWidth="1" fill="none" opacity="0.55" />

              {/* head + crown */}
              <Circle cx="50" cy="18" r="10" fill={accent} stroke="#0a0510" strokeWidth="1.6" />
              <Polygon points="36,14 40,0 46,10 50,-2 54,10 60,0 64,14" fill="#ffd166" stroke="#0a0510" strokeWidth="0.8" />
              <Circle cx="50" cy="2" r="2.5" fill="#fff" />
              <Path d="M 42 19 L 58 19" stroke="#0a0510" strokeWidth="1.5" />
              <Path d="M 44 20 L 56 20" stroke="#fff" strokeWidth="0.6" />
              {/* TWO glowing eyes inside visor */}
              <Circle cx="46" cy="20" r="1" fill="#fff" />
              <Circle cx="54" cy="20" r="1" fill="#fff" />
              {/* forehead gem */}
              <Circle cx="50" cy="12" r="2.5" fill="#fff" stroke="#0a0510" strokeWidth="0.5" />

              {/* chest plate with cosmic core */}
              <Path d="M 32 36 L 68 36 L 66 70 L 34 70 Z" fill={dark} stroke="#0a0510" strokeWidth="1.8" />
              <Path d="M 32 36 L 68 36" stroke="#ffd166" strokeWidth="1.2" />
              <Path d="M 34 70 L 66 70" stroke="#ffd166" strokeWidth="1" />
              {/* cosmic singularity core */}
              <Circle cx="50" cy="52" r="13" fill="#000" stroke="#0a0510" strokeWidth="2.2" />
              <Circle cx="50" cy="52" r="11" fill={accent} />
              <Polygon points="50,42 54,50 62,52 54,54 50,62 46,54 38,52 46,50" fill="#fff" opacity={0.9 * haloPulse} />
              <Circle cx="50" cy="52" r="3" fill="#000" />
              <Circle cx="50" cy="52" r="3" fill="none" stroke="#fff" strokeWidth="0.6" />
              {/* orbital ring around the chest core */}
              <Ellipse cx="50" cy="52" rx="17" ry="4" fill="none" stroke="#ffd166" strokeWidth="0.8" opacity={0.85 * haloPulse} />

              {/* belt with buckle */}
              <Path d="M 24 70 L 76 70" stroke="#0a0510" strokeWidth="3" />
              <Path d="M 24 70 L 76 70" stroke="#ffd166" strokeWidth="2" />
              <Polygon points="46,67 54,67 54,73 46,73" fill={accent} stroke="#0a0510" strokeWidth="0.8" />
              <Polygon points="46,67 50,70 50,67" fill="#fff" opacity="0.5" />

              {/* twin scepters at sides — held in hands */}
              <Rect x="16" y="40" width="2" height="40" fill="#a8b4d0" stroke="#0a0510" strokeWidth="0.5" />
              <Circle cx="17" cy="40" r="3.5" fill={accent} stroke="#fff" strokeWidth="0.6" />
              <Circle cx="17" cy="40" r="1.5" fill="#fff" />
              <Circle cx="17" cy="40" r="5" fill={accent} opacity={0.25 * haloPulse} />
              <Circle cx="17" cy="50" r="2" fill={dark} stroke="#0a0510" strokeWidth="0.5" />
              <Rect x="82" y="40" width="2" height="40" fill="#a8b4d0" stroke="#0a0510" strokeWidth="0.5" />
              <Circle cx="83" cy="40" r="3.5" fill={accent} stroke="#fff" strokeWidth="0.6" />
              <Circle cx="83" cy="40" r="1.5" fill="#fff" />
              <Circle cx="83" cy="40" r="5" fill={accent} opacity={0.25 * haloPulse} />
              <Circle cx="83" cy="50" r="2" fill={dark} stroke="#0a0510" strokeWidth="0.5" />

              {/* shoulder pauldrons with gems */}
              <Path d="M 20 40 Q 14 28 26 24 L 36 36 Z" fill={accent} stroke="#0a0510" strokeWidth="1.2" />
              <Path d="M 80 40 Q 86 28 74 24 L 64 36 Z" fill={accent} stroke="#0a0510" strokeWidth="1.2" />
              <Path d="M 20 40 Q 14 28 26 24" stroke="#fff" strokeWidth="0.5" fill="none" opacity="0.6" />
              <Path d="M 80 40 Q 86 28 74 24" stroke="#fff" strokeWidth="0.5" fill="none" opacity="0.6" />
              <Circle cx="22" cy="30" r="1.5" fill="#ffd166" stroke="#0a0510" strokeWidth="0.4" />
              <Circle cx="78" cy="30" r="1.5" fill="#ffd166" stroke="#0a0510" strokeWidth="0.4" />

              {/* orbital motes around */}
              <Circle cx="-4" cy="16" r="2" fill="#fff" opacity={0.95 * haloPulse} />
              <Circle cx="104" cy="16" r="2" fill="#fff" opacity={0.95 * haloPulse} />
              <Circle cx="-6" cy="64" r="1.8" fill="#fff7a8" opacity={0.9 * haloPulse} />
              <Circle cx="106" cy="64" r="1.8" fill="#fff7a8" opacity={0.9 * haloPulse} />
              <Circle cx="50" cy="-6" r="2.5" fill="#fff" opacity={haloPulse} />
            </G>
          </>
        )}
      </Svg>
    </View>
  );
}

function GroundShadow({ width, height, opacity = 0.42 }) {
  return (
    <View
      pointerEvents="none"
      style={{
        position: 'absolute',
        left: (TILE - width) / 2,
        bottom: TILE * 0.05,
        width,
        height,
        borderRadius: height,
        backgroundColor: '#000',
        opacity,
        transform: [{ scaleX: 1.2 }],
      }}
    />
  );
}

function TowerView({ t, time, selected = false }) {
  if (t.kind === 'rock') {
    return <RockView t={t} />;
  }
  if (t.kind === 'special') {
    const recipe = SPECIAL_BY_ID[t.specialId];
    if (!recipe) return null;
    return (
      <View pointerEvents="none" style={{
        position: 'absolute', left: t.c * TILE, top: t.r * TILE,
        width: TILE, height: TILE, alignItems: 'center', justifyContent: 'center',
      }}>
        <GroundShadow width={TILE * 1.25} height={TILE * 0.22} opacity={0.38} />
        {selected && <SelectionRing color={recipe.accent || '#ffd166'} />}
        <SpecialSvg recipe={recipe} time={time || 0} id={t.id} />
        {/* Full special tower name written below the tile */}
        <View style={{
          position: 'absolute',
          left: -TILE * 0.6, right: -TILE * 0.6,
          bottom: -TILE * 0.45,
          alignItems: 'center',
        }}>
          <View style={{
            backgroundColor: '#000c',
            paddingHorizontal: 4, paddingVertical: 1,
            borderRadius: 3,
            borderWidth: 1, borderColor: recipe.accent + 'aa',
          }}>
            <Text numberOfLines={1} style={{
              color: '#fff',
              fontSize: TILE * 0.32,
              fontWeight: '800',
              letterSpacing: 0.3,
            }}>
              {recipe.name}
            </Text>
          </View>
        </View>
      </View>
    );
  }
  // Gem
  return (
    <View pointerEvents="none" style={{
      position: 'absolute', left: t.c * TILE, top: t.r * TILE,
      width: TILE, height: TILE, alignItems: 'center', justifyContent: 'center',
    }}>
      <GroundShadow width={TILE * 0.86} height={TILE * 0.16} opacity={0.32} />
      {selected && <SelectionRing color={GEMS[t.gemType].color} />}
      <GemSvg gemType={t.gemType} tier={t.tier} />
    </View>
  );
}

function SelectionRing({ color }) {
  return (
    <View style={{
      position: 'absolute',
      width: TILE * 1.35,
      height: TILE * 1.35,
      borderRadius: TILE,
      borderWidth: 2,
      borderColor: color,
      opacity: 0.95,
      shadowColor: color,
      shadowOpacity: 0.8,
      shadowRadius: 8,
      shadowOffset: { width: 0, height: 0 },
    }} />
  );
}

function CandidateView({ t, time }) {
  const pulse = 0.55 + 0.35 * Math.sin(time * 6);
  return (
    <View pointerEvents="none" style={{
      position: 'absolute', left: t.c * TILE, top: t.r * TILE,
      width: TILE, height: TILE, alignItems: 'center', justifyContent: 'center',
    }}>
      <GroundShadow width={TILE * 0.95} height={TILE * 0.16} opacity={0.34} />
      <View style={{
        position: 'absolute',
        width: TILE * 1.15, height: TILE * 1.15,
        borderRadius: TILE,
        borderWidth: 3, borderColor: '#ffd166',
        opacity: pulse,
      }} />
      <GemSvg gemType={t.gemType} tier={t.tier} />
    </View>
  );
}

// Per-enemy idle motion params (bob, sway).
const BOB_PARAMS = {
  grunt:  { yHz: 3.5, yAmp: 1.6, xHz: 0,   xAmp: 0 },
  runner: { yHz: 7,   yAmp: 1.2, xHz: 0,   xAmp: 0 },
  tank:   { yHz: 1.2, yAmp: 0.8, xHz: 0,   xAmp: 0 },
  swarm:  { yHz: 6,   yAmp: 1.0, xHz: 9,   xAmp: 1.8 },
  flyer:  { yHz: 5,   yAmp: 2.6, xHz: 0,   xAmp: 0 },
  boss:   { yHz: 1.5, yAmp: 2.0, xHz: 0,   xAmp: 0 },
  mega:   { yHz: 0.9, yAmp: 2.6, xHz: 0.5, xAmp: 1.2 },
};

function EnemyView({ e, time }) {
  const def = ENEMIES[e.type];
  const size = TILE * def.size;
  const slowed = e.effects.some((ef) => ef.type === 'slow');
  const burning = e.effects.some((ef) => ef.type === 'poison');
  const badges = enemyBadges(e, def);
  const b = BOB_PARAMS[e.type] || BOB_PARAMS.grunt;
  const phase = (e.id * 0.91) % (Math.PI * 2);
  const bobY = Math.sin(time * b.yHz + phase) * b.yAmp;
  const bobX = b.xAmp ? Math.sin(time * b.xHz + phase + 1) * b.xAmp : 0;
  // Wing flap drives a different cycle for flyer
  const flying = e.flying || def.flying;
  const flap = flying ? Math.sin(time * 11 + phase) : 0;
  return (
    <View pointerEvents="none" style={{
      position: 'absolute',
      left: e.c * TILE + (TILE - size) / 2,
      top: e.r * TILE + (TILE - size) / 2,
      width: size, height: size,
    }}>
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          left: size * 0.16,
          top: size * 0.78,
          width: size * 0.72,
          height: Math.max(3, size * 0.13),
          borderRadius: size,
          backgroundColor: '#000',
          opacity: flying ? 0.18 : 0.42,
          transform: [{ scaleX: flying ? 0.7 : 1.2 }],
        }}
      />
      <View style={{ transform: [{ translateX: bobX }, { translateY: bobY }] }}>
        <CreatureSvg
          type={e.type}
          size={size}
          burning={burning}
          flap={flap}
          tier={e.tier || 0}
          bossVariant={e.bossVariant}
          rosterId={e.rosterId}
        />
      </View>
      {slowed && (
        <View style={{
          position: 'absolute', left: -3, top: -3,
          width: size + 6, height: size + 6, borderRadius: size,
          borderWidth: 2, borderColor: '#4cc9ff',
          opacity: 0.9,
        }} />
      )}
      {burning && (
        <View style={{
          position: 'absolute', left: -5, top: -5,
          width: size + 10, height: size + 10, borderRadius: size,
          borderWidth: 2, borderColor: '#5cf28a',
          opacity: 0.45 + 0.25 * Math.sin(time * 8 + phase),
        }} />
      )}
      {(e.shieldHp > 0 || e._bossShieldType) && (
        <View style={{
          position: 'absolute', left: -7, top: -7,
          width: size + 14, height: size + 14, borderRadius: size,
          borderWidth: 2,
          borderColor: e._bossShieldType ? '#ff4d6d' : '#7be5d1',
          opacity: 0.72,
        }} />
      )}
      {badges.length > 0 && (
        <View style={{
          position: 'absolute',
          left: -Math.max(10, size * 0.18),
          top: -20,
          flexDirection: 'row',
          gap: 2,
        }}>
          {badges.map((b, i) => (
            <View key={`${b.label}${i}`} style={{
              minWidth: 18,
              height: 12,
              borderRadius: 3,
              paddingHorizontal: 2,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: '#070a14ee',
              borderWidth: 1,
              borderColor: b.color,
            }}>
              <Text style={{ color: b.color, fontSize: 6.5, fontWeight: '900' }}>{b.label}</Text>
            </View>
          ))}
        </View>
      )}
      <View style={{
        position: 'absolute', top: -6, left: 0, width: size, height: e.type === 'boss' || e.type === 'mega' ? 5 : 3,
        backgroundColor: '#000a', borderRadius: 2,
      }}>
        <View style={{
          width: Math.max(0, size * (e.hp / e.maxHp)), height: e.type === 'boss' || e.type === 'mega' ? 5 : 3,
          backgroundColor: e.hp / e.maxHp < 0.3 ? '#ff4d6d' : '#5cf28a', borderRadius: 2,
        }} />
        {e.shieldHp > 0 && (
          <View style={{
            position: 'absolute',
            left: 0,
            top: 0,
            width: Math.max(2, size * Math.min(1, e.shieldHp / Math.max(1, e.maxHp * 0.22))),
            height: e.type === 'boss' || e.type === 'mega' ? 5 : 3,
            backgroundColor: '#7be5d1',
            borderRadius: 2,
            opacity: 0.9,
          }} />
        )}
      </View>
      {(e.type === 'boss' || e.type === 'mega') && (
        <View style={{
          position: 'absolute',
          left: -size * 0.7,
          right: -size * 0.7,
          top: -36,
          alignItems: 'center',
        }}>
          <View style={{
            backgroundColor: '#10070bee',
            borderWidth: 1,
            borderColor: '#ff4d6d',
            borderRadius: 5,
            paddingHorizontal: 5,
            paddingVertical: 1,
          }}>
            <Text numberOfLines={1} style={{ color: '#ffd166', fontSize: 8, fontWeight: '900', letterSpacing: 0.8 }}>
              {(e.bossName || e.rosterId || e.bossVariant || 'BOSS').toString().replace(/_/g, ' ').toUpperCase()}
            </Text>
          </View>
        </View>
      )}
    </View>
  );
}

function CreatureSvg({ type, size, burning, flap, tier, bossVariant, rosterId }) {
  const spriteKey = rosterId || bossVariant;
  if ((type === 'boss' || type === 'mega') && USE_SPRITES.bosses && spriteKey && ASSET_MAP.bosses[spriteKey]) {
    const spriteSize = size * (type === 'mega' ? 1.25 : 1.15);
    return (
      <RemoteSprite
        source={ASSET_MAP.bosses[spriteKey]}
        style={{
          width: spriteSize,
          height: spriteSize,
          marginLeft: (size - spriteSize) / 2,
          marginTop: (size - spriteSize) / 2,
          shadowColor: '#000',
          shadowOpacity: 0.55,
          shadowRadius: 10,
          shadowOffset: { width: 0, height: 4 },
        }}
      >
        <CreatureFallbackSvg
          type={type}
          size={size}
          burning={burning}
          flap={flap}
          tier={tier}
          bossVariant={bossVariant}
          rosterId={rosterId}
        />
      </RemoteSprite>
    );
  }
  return (
    <CreatureFallbackSvg
      type={type}
      size={size}
      burning={burning}
      flap={flap}
      tier={tier}
      bossVariant={bossVariant}
      rosterId={rosterId}
    />
  );
}

function CreatureFallbackSvg({ type, size, burning, flap, tier, bossVariant, rosterId }) {
  const t = tier || 0;
  if (type === 'grunt') {
    if (t === 4) return <MythicGruntSvg size={size} burning={burning} />;
    if (t === 3) return <ApexGruntSvg size={size} burning={burning} />;
    if (t === 2) return <ChampionGruntSvg size={size} burning={burning} />;
    if (t === 1) return <EliteGruntSvg size={size} burning={burning} />;
    return <GruntSvg size={size} burning={burning} />;
  }
  if (type === 'runner') {
    if (t === 4) return <MythicRunnerSvg size={size} burning={burning} />;
    if (t === 3) return <ApexRunnerSvg size={size} burning={burning} />;
    if (t === 2) return <ChampionRunnerSvg size={size} burning={burning} />;
    if (t === 1) return <EliteRunnerSvg size={size} burning={burning} />;
    return <RunnerSvg size={size} burning={burning} />;
  }
  if (type === 'tank') {
    if (t === 4) return <MythicTankSvg size={size} burning={burning} />;
    if (t === 3) return <ApexTankSvg size={size} burning={burning} />;
    if (t === 2) return <ChampionTankSvg size={size} burning={burning} />;
    if (t === 1) return <EliteTankSvg size={size} burning={burning} />;
    return <TankSvg size={size} burning={burning} />;
  }
  if (type === 'swarm') {
    if (t === 4) return <MythicSwarmSvg size={size} burning={burning} />;
    if (t === 3) return <ApexSwarmSvg size={size} burning={burning} />;
    if (t === 2) return <ChampionSwarmSvg size={size} burning={burning} />;
    if (t === 1) return <EliteSwarmSvg size={size} burning={burning} />;
    return <SwarmSvg size={size} burning={burning} />;
  }
  if (type === 'flyer') {
    if (t >= 2) return <ChampionFlyerSvg size={size} burning={burning} flap={flap} />;
    if (t === 1) return <EliteFlyerSvg size={size} burning={burning} flap={flap} />;
    return <FlyerSvg size={size} burning={burning} flap={flap} />;
  }
  if (type === 'boss') {
    if (bossVariant === 'ender') return <WorldEnderBossSvg size={size} burning={burning} />;
    if (bossVariant === 'destroyer') return <DestroyerBossSvg size={size} burning={burning} />;
    if (bossVariant === 'blood') return <BloodBossSvg size={size} burning={burning} />;
    if (bossVariant === 'void') return <VoidBossSvg size={size} burning={burning} />;
    return <BossSvg size={size} burning={burning} />;
  }
  if (type === 'mega') {
    if (bossVariant === 'ender-mega') return <WorldEnderMegaSvg size={size} burning={burning} />;
    return <MegaSvg size={size} burning={burning} />;
  }
  return null;
}

// All creatures render in a 100x100 viewBox. Each id-prefix makes
// gradient ids unique even if multiple of the same type are on screen.
let gradId = 0;
const nextGid = () => `g${++gradId}`;

const GruntSvg = React.memo(function GruntSvg({ size, burning }) {
  const id = useRef(nextGid()).current;
  const body1 = burning ? '#a8f8c8' : '#d4c8ff';
  const body2 = burning ? '#2e8c50' : '#5a3d8c';
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100">
      <Defs>
        <LinearGradient id={`${id}b`} x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={body1} />
          <Stop offset="1" stopColor={body2} />
        </LinearGradient>
        <RadialGradient id={`${id}e`} cx="0.5" cy="0.5" r="0.5">
          <Stop offset="0" stopColor="#fff7a8" />
          <Stop offset="0.6" stopColor="#ffd166" />
          <Stop offset="1" stopColor="#ff8800" />
        </RadialGradient>
      </Defs>
      <Ellipse cx="50" cy="93" rx="28" ry="3.5" fill="#000" opacity="0.45" />
      {/* horns */}
      <Polygon points="22,30 30,6 36,32" fill="#2a1840" />
      <Polygon points="78,30 70,6 64,32" fill="#2a1840" />
      {/* ears */}
      <Polygon points="14,55 4,48 16,68" fill={body2} stroke="#1a0c2e" strokeWidth="1.5" />
      <Polygon points="86,55 96,48 84,68" fill={body2} stroke="#1a0c2e" strokeWidth="1.5" />
      {/* body */}
      <Circle cx="50" cy="55" r="34" fill={`url(#${id}b)`} stroke="#1a0c2e" strokeWidth="2.5" />
      <Ellipse cx="50" cy="72" rx="22" ry="11" fill="#fff" opacity="0.13" />
      {/* eye sockets */}
      <Ellipse cx="38" cy="50" rx="8" ry="7" fill="#0a0510" />
      <Ellipse cx="62" cy="50" rx="8" ry="7" fill="#0a0510" />
      {/* eyes glow */}
      <Circle cx="38" cy="49" r="5.5" fill={`url(#${id}e)`} />
      <Circle cx="62" cy="49" r="5.5" fill={`url(#${id}e)`} />
      <Circle cx="38" cy="50" r="2" fill="#000" />
      <Circle cx="62" cy="50" r="2" fill="#000" />
      {/* brow */}
      <Path d="M 28 40 L 44 44" stroke="#1a0c2e" strokeWidth="2.5" strokeLinecap="round" />
      <Path d="M 72 40 L 56 44" stroke="#1a0c2e" strokeWidth="2.5" strokeLinecap="round" />
      {/* mouth */}
      <Path d="M 34 68 Q 50 80 66 68 Q 60 72 50 72 Q 40 72 34 68 Z" fill="#0a0510" />
      <Polygon points="42,69 44,77 46,69" fill="#fff" />
      <Polygon points="54,69 56,77 58,69" fill="#fff" />
    </Svg>
  );
});

const RunnerSvg = React.memo(function RunnerSvg({ size, burning }) {
  const id = useRef(nextGid()).current;
  const c1 = burning ? '#a8f8c8' : '#ffe19a';
  const c2 = burning ? '#2e8c50' : '#a07020';
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100">
      <Defs>
        <LinearGradient id={`${id}c`} x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={c1} />
          <Stop offset="1" stopColor={c2} />
        </LinearGradient>
      </Defs>
      <Ellipse cx="50" cy="93" rx="22" ry="3" fill="#000" opacity="0.4" />
      {/* cloak silhouette: tall hood narrowing at top, flared at bottom */}
      <Path
        d="M 50 4 C 60 8 66 18 70 30 L 78 58 L 76 86 L 24 86 L 22 58 L 30 30 C 34 18 40 8 50 4 Z"
        fill={`url(#${id}c)`}
        stroke="#3a2806"
        strokeWidth="2"
      />
      {/* outer cloak fold lines */}
      <Path d="M 36 30 L 30 70" stroke="#3a2806" strokeWidth="1" opacity="0.5" />
      <Path d="M 64 30 L 70 70" stroke="#3a2806" strokeWidth="1" opacity="0.5" />
      <Path d="M 50 30 L 50 78" stroke="#3a2806" strokeWidth="1" opacity="0.4" />
      {/* shadow inside hood */}
      <Path d="M 32 30 C 38 22 44 18 50 18 C 56 18 62 22 68 30 L 64 50 L 36 50 Z" fill="#0a0510" />
      {/* glowing eye slits */}
      <Path d="M 36 40 L 46 36 L 46 42 L 36 44 Z" fill="#ff4d6d" />
      <Path d="M 64 40 L 54 36 L 54 42 L 64 44 Z" fill="#ff4d6d" />
      <Path d="M 39 39 L 44 38" stroke="#fff" strokeWidth="1" opacity="0.8" />
      <Path d="M 61 39 L 56 38" stroke="#fff" strokeWidth="1" opacity="0.8" />
      {/* belt */}
      <Rect x="26" y="62" width="48" height="6" fill="#3a2806" />
      <Rect x="46" y="61" width="8" height="8" fill="#ffd166" stroke="#3a2806" strokeWidth="0.8" />
      {/* small dagger hilt at side */}
      <Rect x="68" y="64" width="3" height="14" fill="#3a2806" />
      <Rect x="65" y="62" width="9" height="3" fill="#ffd166" />
    </Svg>
  );
});

const TankSvg = React.memo(function TankSvg({ size, burning }) {
  const id = useRef(nextGid()).current;
  const a1 = burning ? '#a8f8c8' : '#a8b4d0';
  const a2 = burning ? '#2e8c50' : '#3d4660';
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100">
      <Defs>
        <LinearGradient id={`${id}a`} x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={a1} />
          <Stop offset="1" stopColor={a2} />
        </LinearGradient>
        <LinearGradient id={`${id}h`} x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={a1} />
          <Stop offset="1" stopColor="#5a6480" />
        </LinearGradient>
      </Defs>
      <Ellipse cx="50" cy="94" rx="38" ry="4" fill="#000" opacity="0.55" />
      {/* pauldrons */}
      <Path d="M 6 50 Q 4 32 22 28 L 36 50 L 30 68 L 8 64 Z" fill={`url(#${id}a)`} stroke="#1a2034" strokeWidth="2" />
      <Path d="M 94 50 Q 96 32 78 28 L 64 50 L 70 68 L 92 64 Z" fill={`url(#${id}a)`} stroke="#1a2034" strokeWidth="2" />
      {/* spike on each pauldron */}
      <Polygon points="14,38 18,22 22,40" fill="#1a2034" />
      <Polygon points="86,38 82,22 78,40" fill="#1a2034" />
      {/* torso */}
      <Path d="M 26 36 L 74 36 L 80 82 L 72 92 L 28 92 L 20 82 Z" fill={`url(#${id}a)`} stroke="#1a2034" strokeWidth="2.5" />
      {/* chest plate */}
      <Path d="M 38 44 L 62 44 L 60 76 L 40 76 Z" fill="#5a6480" stroke="#1a2034" strokeWidth="1.5" />
      <Path d="M 50 44 L 50 76" stroke="#1a2034" strokeWidth="1.5" />
      {/* helmet */}
      <Path d="M 26 38 L 32 14 L 68 14 L 74 38 Z" fill={`url(#${id}h)`} stroke="#1a2034" strokeWidth="2.5" />
      {/* helmet crest */}
      <Path d="M 50 14 L 45 4 L 55 4 Z" fill="#7a1d2e" />
      <Path d="M 46 4 L 46 -2 L 54 -2 L 54 4 Z" fill="#ff4d6d" />
      {/* visor */}
      <Rect x="28" y="24" width="44" height="8" fill="#0a0510" />
      <Rect x="32" y="26" width="36" height="3" fill="#ff4d6d" opacity="0.9" />
      <Circle cx="38" cy="27.5" r="1.3" fill="#fff" />
      <Circle cx="62" cy="27.5" r="1.3" fill="#fff" />
      {/* rivets */}
      <Circle cx="30" cy="48" r="1.8" fill="#1a2034" />
      <Circle cx="70" cy="48" r="1.8" fill="#1a2034" />
      <Circle cx="30" cy="80" r="1.8" fill="#1a2034" />
      <Circle cx="70" cy="80" r="1.8" fill="#1a2034" />
    </Svg>
  );
});

const SwarmSvg = React.memo(function SwarmSvg({ size, burning }) {
  const id = useRef(nextGid()).current;
  const b1 = burning ? '#a8f8c8' : '#ffafc4';
  const b2 = burning ? '#2e8c50' : '#a04060';
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100">
      <Defs>
        <RadialGradient id={`${id}b`} cx="0.4" cy="0.35" r="0.65">
          <Stop offset="0" stopColor={b1} />
          <Stop offset="1" stopColor={b2} />
        </RadialGradient>
      </Defs>
      <Ellipse cx="50" cy="92" rx="32" ry="3.5" fill="#000" opacity="0.4" />
      {/* 6 legs */}
      <Path d="M 22 52 Q 8 38 6 30" stroke={b2} strokeWidth="3.2" fill="none" strokeLinecap="round" />
      <Path d="M 20 62 Q 4 60 2 64" stroke={b2} strokeWidth="3.2" fill="none" strokeLinecap="round" />
      <Path d="M 24 72 Q 10 82 8 90" stroke={b2} strokeWidth="3.2" fill="none" strokeLinecap="round" />
      <Path d="M 78 52 Q 92 38 94 30" stroke={b2} strokeWidth="3.2" fill="none" strokeLinecap="round" />
      <Path d="M 80 62 Q 96 60 98 64" stroke={b2} strokeWidth="3.2" fill="none" strokeLinecap="round" />
      <Path d="M 76 72 Q 90 82 92 90" stroke={b2} strokeWidth="3.2" fill="none" strokeLinecap="round" />
      {/* body */}
      <Ellipse cx="50" cy="55" rx="32" ry="28" fill={`url(#${id}b)`} stroke="#5a1830" strokeWidth="2" />
      {/* segments */}
      <Path d="M 22 55 Q 50 62 78 55" stroke="#5a1830" strokeWidth="1.2" fill="none" opacity="0.6" />
      <Path d="M 24 65 Q 50 72 76 65" stroke="#5a1830" strokeWidth="1.2" fill="none" opacity="0.5" />
      {/* highlight */}
      <Ellipse cx="40" cy="40" rx="14" ry="9" fill="#fff" opacity="0.35" />
      {/* mandibles */}
      <Path d="M 38 76 Q 36 88 42 82" stroke="#5a1830" strokeWidth="2.5" fill="none" strokeLinecap="round" />
      <Path d="M 62 76 Q 64 88 58 82" stroke="#5a1830" strokeWidth="2.5" fill="none" strokeLinecap="round" />
      {/* big eye */}
      <Circle cx="50" cy="52" r="14" fill="#fff" stroke="#5a1830" strokeWidth="1.5" />
      <Circle cx="50" cy="52" r="11" fill="#0b1020" />
      <Circle cx="50" cy="52" r="6" fill="#ff4d6d" />
      <Circle cx="47" cy="50" r="2.5" fill="#fff" />
    </Svg>
  );
});

const FlyerSvg = React.memo(function FlyerSvg({ size, burning, flap }) {
  const id = useRef(nextGid()).current;
  const c1 = burning ? '#a8f8c8' : '#a8f0a8';
  const c2 = burning ? '#2e8c50' : '#406040';
  // wing angle from -8 to +8 degrees
  const wing = (flap || 0) * 12;
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100">
      <Defs>
        <LinearGradient id={`${id}b`} x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={c1} />
          <Stop offset="1" stopColor={c2} />
        </LinearGradient>
      </Defs>
      <Ellipse cx="50" cy="92" rx="20" ry="3" fill="#000" opacity="0.3" />
      {/* wings - left */}
      <G rotation={-wing} originX="35" originY="40">
        <Path d="M 35 40 Q 5 30 0 55 Q 18 50 35 55 Z" fill={c2} stroke="#1a2a1a" strokeWidth="1.5" />
        <Path d="M 12 42 L 22 50" stroke="#1a2a1a" strokeWidth="1" />
        <Path d="M 6 50 L 20 55" stroke="#1a2a1a" strokeWidth="1" />
      </G>
      {/* wings - right */}
      <G rotation={wing} originX="65" originY="40">
        <Path d="M 65 40 Q 95 30 100 55 Q 82 50 65 55 Z" fill={c2} stroke="#1a2a1a" strokeWidth="1.5" />
        <Path d="M 88 42 L 78 50" stroke="#1a2a1a" strokeWidth="1" />
        <Path d="M 94 50 L 80 55" stroke="#1a2a1a" strokeWidth="1" />
      </G>
      {/* body */}
      <Ellipse cx="50" cy="52" rx="22" ry="26" fill={`url(#${id}b)`} stroke="#1a2a1a" strokeWidth="2" />
      {/* pointed ears */}
      <Polygon points="38,30 32,16 44,28" fill={c2} stroke="#1a2a1a" strokeWidth="1" />
      <Polygon points="62,30 68,16 56,28" fill={c2} stroke="#1a2a1a" strokeWidth="1" />
      {/* eyes */}
      <Circle cx="42" cy="48" r="4.5" fill="#ffd166" />
      <Circle cx="58" cy="48" r="4.5" fill="#ffd166" />
      <Circle cx="42" cy="49" r="2" fill="#000" />
      <Circle cx="58" cy="49" r="2" fill="#000" />
      {/* fanged mouth */}
      <Path d="M 42 62 Q 50 70 58 62 Q 54 65 50 65 Q 46 65 42 62 Z" fill="#0a0510" />
      <Polygon points="46,62 47,68 48,62" fill="#fff" />
      <Polygon points="52,62 53,68 54,62" fill="#fff" />
    </Svg>
  );
});

const BossSvg = React.memo(function BossSvg({ size, burning }) {
  const id = useRef(nextGid()).current;
  const b1 = burning ? '#a8f8c8' : '#ff8095';
  const b2 = burning ? '#2e8c50' : '#7a1d2e';
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100">
      <Defs>
        <LinearGradient id={`${id}b`} x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={b1} />
          <Stop offset="1" stopColor={b2} />
        </LinearGradient>
        <RadialGradient id={`${id}e`} cx="0.5" cy="0.5" r="0.5">
          <Stop offset="0" stopColor="#fff" />
          <Stop offset="0.3" stopColor="#ffd166" />
          <Stop offset="0.8" stopColor="#ff4500" />
          <Stop offset="1" stopColor="#a00000" />
        </RadialGradient>
      </Defs>
      <Ellipse cx="50" cy="95" rx="42" ry="4.5" fill="#000" opacity="0.6" />
      {/* cape behind */}
      <Path d="M 18 60 L 6 96 L 30 92 L 32 64 Z" fill="#3a0a18" stroke="#1a0510" strokeWidth="1.5" />
      <Path d="M 82 60 L 94 96 L 70 92 L 68 64 Z" fill="#3a0a18" stroke="#1a0510" strokeWidth="1.5" />
      {/* horn crown — 5 spikes plus 2 outer curves */}
      <Path d="M 12 38 Q 4 12 22 30 Z" fill="#0a0510" />
      <Polygon points="24,25 18,2 32,22" fill="#0a0510" />
      <Polygon points="38,18 32,0 44,16" fill="#0a0510" />
      <Polygon points="50,14 46,-4 54,-4 50,14" fill="#0a0510" />
      <Polygon points="62,18 56,16 68,0" fill="#0a0510" />
      <Polygon points="76,25 68,22 82,2" fill="#0a0510" />
      <Path d="M 88 38 Q 96 12 78 30 Z" fill="#0a0510" />
      {/* body */}
      <Circle cx="50" cy="55" r="38" fill={`url(#${id}b)`} stroke="#1a0510" strokeWidth="3" />
      <Ellipse cx="50" cy="72" rx="24" ry="11" fill="#fff" opacity="0.13" />
      {/* gold crown band */}
      <Path d="M 16 30 Q 50 24 84 30 L 84 36 Q 50 30 16 36 Z" fill="#ffd166" stroke="#7a5a0a" strokeWidth="1.5" />
      <Circle cx="50" cy="32" r="3" fill="#ff4d6d" stroke="#7a5a0a" strokeWidth="1" />
      <Circle cx="32" cy="33" r="2" fill="#4cc9ff" stroke="#7a5a0a" strokeWidth="0.8" />
      <Circle cx="68" cy="33" r="2" fill="#5cf28a" stroke="#7a5a0a" strokeWidth="0.8" />
      {/* eye sockets */}
      <Ellipse cx="36" cy="52" rx="11" ry="8" fill="#0a0510" />
      <Ellipse cx="64" cy="52" rx="11" ry="8" fill="#0a0510" />
      {/* glowing eyes */}
      <Circle cx="36" cy="51" r="7" fill={`url(#${id}e)`} />
      <Circle cx="64" cy="51" r="7" fill={`url(#${id}e)`} />
      <Ellipse cx="36" cy="51" rx="2" ry="4" fill="#000" />
      <Ellipse cx="64" cy="51" rx="2" ry="4" fill="#000" />
      {/* scowl brows */}
      <Path d="M 24 40 L 44 46" stroke="#1a0510" strokeWidth="3.5" strokeLinecap="round" />
      <Path d="M 76 40 L 56 46" stroke="#1a0510" strokeWidth="3.5" strokeLinecap="round" />
      {/* fanged mouth */}
      <Path d="M 28 68 Q 50 86 72 68 Q 64 76 50 76 Q 36 76 28 68 Z" fill="#0a0510" />
      <Polygon points="36,69 39,82 42,69" fill="#fff" />
      <Polygon points="44,70 47,84 50,70" fill="#fff" />
      <Polygon points="50,70 53,84 56,70" fill="#fff" />
      <Polygon points="58,69 61,82 64,69" fill="#fff" />
      {/* scar across cheek */}
      <Path d="M 70 56 L 76 64" stroke="#1a0510" strokeWidth="1.8" />
      <Path d="M 72 54 L 78 62" stroke="#fff" strokeWidth="0.8" opacity="0.5" />
    </Svg>
  );
});

const MegaSvg = React.memo(function MegaSvg({ size, burning }) {
  const id = useRef(nextGid()).current;
  const r1 = burning ? '#a8f8c8' : '#3a0a18';
  const r2 = burning ? '#2e8c50' : '#0a0510';
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100">
      <Defs>
        <LinearGradient id={`${id}r`} x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={r1} />
          <Stop offset="1" stopColor={r2} />
        </LinearGradient>
        <RadialGradient id={`${id}eye`} cx="0.5" cy="0.5" r="0.5">
          <Stop offset="0" stopColor="#fff" />
          <Stop offset="0.4" stopColor="#ff4d6d" />
          <Stop offset="1" stopColor="#5a0010" />
        </RadialGradient>
      </Defs>
      <Ellipse cx="50" cy="96" rx="46" ry="4" fill="#000" opacity="0.7" />
      {/* tattered cloak */}
      <Path
        d="M 50 4 L 88 28 L 96 80 L 84 96 L 70 88 L 60 96 L 50 88 L 40 96 L 30 88 L 16 96 L 4 80 L 12 28 Z"
        fill={`url(#${id}r)`}
        stroke="#0a0000"
        strokeWidth="2.5"
      />
      {/* cloak inner lining */}
      <Path
        d="M 50 12 L 80 32 L 80 70 L 20 70 L 20 32 Z"
        fill="#0a0000"
      />
      {/* skull face */}
      <Ellipse cx="50" cy="48" rx="22" ry="24" fill="#e8e0c8" stroke="#0a0000" strokeWidth="2" />
      {/* skull cracks */}
      <Path d="M 38 30 L 42 42 L 38 50" stroke="#0a0000" strokeWidth="1" fill="none" />
      <Path d="M 60 28 L 62 38" stroke="#0a0000" strokeWidth="1" fill="none" />
      {/* eye sockets — deep black with red glow */}
      <Ellipse cx="40" cy="46" rx="6.5" ry="7" fill="#0a0000" />
      <Ellipse cx="60" cy="46" rx="6.5" ry="7" fill="#0a0000" />
      <Circle cx="40" cy="46" r="4" fill={`url(#${id}eye)`} />
      <Circle cx="60" cy="46" r="4" fill={`url(#${id}eye)`} />
      <Circle cx="40" cy="46" r="1.5" fill="#fff" />
      <Circle cx="60" cy="46" r="1.5" fill="#fff" />
      {/* nose hole */}
      <Polygon points="50,54 47,60 53,60" fill="#0a0000" />
      {/* teeth grin */}
      <Rect x="38" y="62" width="24" height="6" fill="#e8e0c8" stroke="#0a0000" strokeWidth="1" />
      <Line x1="42" y1="62" x2="42" y2="68" stroke="#0a0000" strokeWidth="0.8" />
      <Line x1="46" y1="62" x2="46" y2="68" stroke="#0a0000" strokeWidth="0.8" />
      <Line x1="50" y1="62" x2="50" y2="68" stroke="#0a0000" strokeWidth="0.8" />
      <Line x1="54" y1="62" x2="54" y2="68" stroke="#0a0000" strokeWidth="0.8" />
      <Line x1="58" y1="62" x2="58" y2="68" stroke="#0a0000" strokeWidth="0.8" />
      {/* hood horns */}
      <Polygon points="20,28 8,2 30,22" fill="#0a0000" />
      <Polygon points="80,28 92,2 70,22" fill="#0a0000" />
      {/* shoulder spikes */}
      <Polygon points="14,44 4,52 16,54" fill="#0a0000" />
      <Polygon points="86,44 96,52 84,54" fill="#0a0000" />
    </Svg>
  );
});

// ───── Elite variants (waves 11+) ───────────────────────────────────────────

// Elite Grunt: warlord. Darker, war paint, broken horn, scar, bone necklace.
const EliteGruntSvg = React.memo(function EliteGruntSvg({ size, burning }) {
  const id = useRef(nextGid()).current;
  const body1 = burning ? '#a8f8c8' : '#7050a8';
  const body2 = burning ? '#2e8c50' : '#2a1840';
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100">
      <Defs>
        <LinearGradient id={`${id}b`} x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={body1} />
          <Stop offset="1" stopColor={body2} />
        </LinearGradient>
        <RadialGradient id={`${id}e`} cx="0.5" cy="0.5" r="0.5">
          <Stop offset="0" stopColor="#fff" />
          <Stop offset="0.5" stopColor="#ff4d6d" />
          <Stop offset="1" stopColor="#7a1d2e" />
        </RadialGradient>
      </Defs>
      <Ellipse cx="50" cy="93" rx="30" ry="3.5" fill="#000" opacity="0.55" />
      {/* horns — right one broken/jagged */}
      <Polygon points="22,30 28,4 36,32" fill="#0a0510" />
      <Polygon points="78,30 72,14 64,32" fill="#0a0510" />
      <Polygon points="71,12 70,8 74,14" fill="#0a0510" />
      {/* ears with piercings */}
      <Polygon points="14,55 4,48 16,68" fill={body2} stroke="#0a0510" strokeWidth="1.5" />
      <Polygon points="86,55 96,48 84,68" fill={body2} stroke="#0a0510" strokeWidth="1.5" />
      <Circle cx="10" cy="60" r="2" fill="#ffd166" />
      <Circle cx="90" cy="60" r="2" fill="#ffd166" />
      {/* body */}
      <Circle cx="50" cy="55" r="34" fill={`url(#${id}b)`} stroke="#0a0510" strokeWidth="3" />
      <Ellipse cx="50" cy="72" rx="22" ry="11" fill="#fff" opacity="0.1" />
      {/* war paint stripes */}
      <Path d="M 30 40 L 36 36 L 32 50 L 28 46 Z" fill="#ff4d6d" opacity="0.85" />
      <Path d="M 70 40 L 64 36 L 68 50 L 72 46 Z" fill="#ff4d6d" opacity="0.85" />
      <Path d="M 44 24 L 56 24 L 54 30 L 46 30 Z" fill="#ff4d6d" opacity="0.85" />
      {/* eye sockets */}
      <Ellipse cx="38" cy="50" rx="8" ry="7" fill="#0a0000" />
      <Ellipse cx="62" cy="50" rx="8" ry="7" fill="#0a0000" />
      {/* red eyes glow */}
      <Circle cx="38" cy="49" r="5.5" fill={`url(#${id}e)`} />
      <Circle cx="62" cy="49" r="5.5" fill={`url(#${id}e)`} />
      <Ellipse cx="38" cy="50" rx="1.5" ry="3" fill="#000" />
      <Ellipse cx="62" cy="50" rx="1.5" ry="3" fill="#000" />
      {/* scar across left eye */}
      <Path d="M 30 36 L 46 58" stroke="#fff" strokeWidth="1.8" opacity="0.85" />
      <Path d="M 31 37 L 45 57" stroke="#7a1d2e" strokeWidth="0.8" />
      {/* angry brows */}
      <Path d="M 26 38 L 46 46" stroke="#0a0510" strokeWidth="3" strokeLinecap="round" />
      <Path d="M 74 38 L 54 46" stroke="#0a0510" strokeWidth="3" strokeLinecap="round" />
      {/* snarling mouth with bigger fangs */}
      <Path d="M 30 68 Q 50 82 70 68 Q 62 74 50 74 Q 38 74 30 68 Z" fill="#0a0000" />
      <Polygon points="38,68 41,80 44,68" fill="#fff" />
      <Polygon points="48,69 50,82 52,69" fill="#fff" />
      <Polygon points="56,68 59,80 62,68" fill="#fff" />
      {/* bone necklace */}
      <Path d="M 28 78 Q 50 92 72 78" stroke="#e8e0c8" strokeWidth="1.5" fill="none" />
      <Ellipse cx="40" cy="84" rx="2" ry="3.5" fill="#e8e0c8" stroke="#0a0510" strokeWidth="0.6" />
      <Ellipse cx="50" cy="86" rx="2.5" ry="4" fill="#e8e0c8" stroke="#0a0510" strokeWidth="0.6" />
      <Ellipse cx="60" cy="84" rx="2" ry="3.5" fill="#e8e0c8" stroke="#0a0510" strokeWidth="0.6" />
    </Svg>
  );
});

// Elite Runner: assassin. Dark cloak, metal hood trim, two daggers, green eyes.
const EliteRunnerSvg = React.memo(function EliteRunnerSvg({ size, burning }) {
  const id = useRef(nextGid()).current;
  const c1 = burning ? '#a8f8c8' : '#2a2040';
  const c2 = burning ? '#2e8c50' : '#0a0510';
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100">
      <Defs>
        <LinearGradient id={`${id}c`} x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={c1} />
          <Stop offset="1" stopColor={c2} />
        </LinearGradient>
      </Defs>
      <Ellipse cx="50" cy="93" rx="24" ry="3.2" fill="#000" opacity="0.5" />
      {/* cloak */}
      <Path
        d="M 50 4 C 60 8 66 18 70 30 L 80 60 L 76 88 L 24 88 L 20 60 L 30 30 C 34 18 40 8 50 4 Z"
        fill={`url(#${id}c)`}
        stroke="#000"
        strokeWidth="2.2"
      />
      {/* metallic hood trim */}
      <Path d="M 32 30 C 38 22 44 18 50 18 C 56 18 62 22 68 30" stroke="#a8b4d0" strokeWidth="2.2" fill="none" />
      <Path d="M 32 30 C 38 22 44 18 50 18 C 56 18 62 22 68 30" stroke="#fff" strokeWidth="0.8" fill="none" opacity="0.6" />
      {/* cloak fold shadows */}
      <Path d="M 36 30 L 28 70" stroke="#000" strokeWidth="1.5" opacity="0.6" />
      <Path d="M 64 30 L 72 70" stroke="#000" strokeWidth="1.5" opacity="0.6" />
      <Path d="M 50 30 L 50 80" stroke="#000" strokeWidth="1.2" opacity="0.5" />
      {/* deep hood shadow */}
      <Path d="M 32 30 C 38 22 44 18 50 18 C 56 18 62 22 68 30 L 64 52 L 36 52 Z" fill="#000" />
      {/* glowing green eye slits */}
      <Path d="M 36 40 L 46 36 L 46 42 L 36 44 Z" fill="#5cf28a" />
      <Path d="M 64 40 L 54 36 L 54 42 L 64 44 Z" fill="#5cf28a" />
      <Circle cx="42" cy="40" r="1.2" fill="#fff" />
      <Circle cx="58" cy="40" r="1.2" fill="#fff" />
      {/* spiked belt */}
      <Rect x="22" y="62" width="56" height="6" fill="#000" />
      <Rect x="22" y="62" width="56" height="2" fill="#a8b4d0" />
      <Polygon points="30,60 33,55 36,60" fill="#a8b4d0" />
      <Polygon points="42,60 45,55 48,60" fill="#a8b4d0" />
      <Polygon points="54,60 57,55 60,60" fill="#a8b4d0" />
      <Polygon points="66,60 69,55 72,60" fill="#a8b4d0" />
      {/* belt buckle (skull) */}
      <Circle cx="50" cy="65" r="4" fill="#a8b4d0" stroke="#000" strokeWidth="0.8" />
      <Circle cx="48.5" cy="64.5" r="0.8" fill="#000" />
      <Circle cx="51.5" cy="64.5" r="0.8" fill="#000" />
      {/* two dagger hilts at hips */}
      <Rect x="20" y="64" width="3" height="14" fill="#000" />
      <Rect x="17" y="62" width="9" height="3" fill="#a8b4d0" stroke="#000" strokeWidth="0.5" />
      <Polygon points="20,78 23,84 21.5,78" fill="#a8b4d0" />
      <Rect x="77" y="64" width="3" height="14" fill="#000" />
      <Rect x="74" y="62" width="9" height="3" fill="#a8b4d0" stroke="#000" strokeWidth="0.5" />
      <Polygon points="77,78 80,84 78.5,78" fill="#a8b4d0" />
    </Svg>
  );
});

// Elite Tank: ironclad. Dark steel, spike crown, skull crest, chest skull.
const EliteTankSvg = React.memo(function EliteTankSvg({ size, burning }) {
  const id = useRef(nextGid()).current;
  const a1 = burning ? '#a8f8c8' : '#5a6480';
  const a2 = burning ? '#2e8c50' : '#1a2034';
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100">
      <Defs>
        <LinearGradient id={`${id}a`} x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={a1} />
          <Stop offset="1" stopColor={a2} />
        </LinearGradient>
      </Defs>
      <Ellipse cx="50" cy="95" rx="40" ry="4.5" fill="#000" opacity="0.65" />
      {/* pauldrons with multi-spikes */}
      <Path d="M 4 50 Q 2 30 22 26 L 36 50 L 30 70 L 6 66 Z" fill={`url(#${id}a)`} stroke="#000" strokeWidth="2.2" />
      <Path d="M 96 50 Q 98 30 78 26 L 64 50 L 70 70 L 94 66 Z" fill={`url(#${id}a)`} stroke="#000" strokeWidth="2.2" />
      <Polygon points="10,38 14,18 18,40" fill="#000" />
      <Polygon points="18,30 22,12 24,32" fill="#000" />
      <Polygon points="90,38 86,18 82,40" fill="#000" />
      <Polygon points="82,30 78,12 76,32" fill="#000" />
      {/* torso */}
      <Path d="M 24 36 L 76 36 L 82 84 L 72 94 L 28 94 L 18 84 Z" fill={`url(#${id}a)`} stroke="#000" strokeWidth="2.5" />
      {/* chest plate with skull emblem */}
      <Path d="M 36 44 L 64 44 L 62 78 L 38 78 Z" fill="#3d4660" stroke="#000" strokeWidth="1.5" />
      <Ellipse cx="50" cy="56" rx="9" ry="8" fill="#e8e0c8" stroke="#000" strokeWidth="1" />
      <Ellipse cx="46.5" cy="55" rx="2" ry="2.5" fill="#0a0510" />
      <Ellipse cx="53.5" cy="55" rx="2" ry="2.5" fill="#0a0510" />
      <Polygon points="50,59 48,63 52,63" fill="#0a0510" />
      <Rect x="46" y="64" width="8" height="2" fill="#0a0510" />
      <Line x1="50" y1="60" x2="50" y2="78" stroke="#000" strokeWidth="1" />
      {/* helmet with spike crown */}
      <Path d="M 24 38 L 30 12 L 70 12 L 76 38 Z" fill={`url(#${id}a)`} stroke="#000" strokeWidth="2.5" />
      <Polygon points="30,12 28,2 36,10" fill="#000" />
      <Polygon points="40,8 38,-2 44,6" fill="#000" />
      <Polygon points="50,4 47,-4 53,-4 50,4" fill="#000" />
      <Polygon points="60,8 56,6 62,-2" fill="#000" />
      <Polygon points="70,12 64,10 72,2" fill="#000" />
      {/* visor */}
      <Rect x="26" y="22" width="48" height="9" fill="#0a0000" />
      <Rect x="30" y="24" width="40" height="3" fill="#ff4d6d" />
      <Circle cx="38" cy="25.5" r="1.5" fill="#fff" />
      <Circle cx="62" cy="25.5" r="1.5" fill="#fff" />
      {/* battle damage cracks */}
      <Path d="M 40 50 L 38 56 L 42 62" stroke="#000" strokeWidth="1.2" fill="none" />
      <Path d="M 65 70 L 70 76" stroke="#000" strokeWidth="1.2" />
      {/* rivets */}
      <Circle cx="30" cy="48" r="2" fill="#000" />
      <Circle cx="70" cy="48" r="2" fill="#000" />
      <Circle cx="32" cy="86" r="2" fill="#000" />
      <Circle cx="68" cy="86" r="2" fill="#000" />
    </Svg>
  );
});

// Elite Swarm: venomous brood. Blood-red, venom drip, stinger tail.
const EliteSwarmSvg = React.memo(function EliteSwarmSvg({ size, burning }) {
  const id = useRef(nextGid()).current;
  const b1 = burning ? '#a8f8c8' : '#c04060';
  const b2 = burning ? '#2e8c50' : '#400010';
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100">
      <Defs>
        <RadialGradient id={`${id}b`} cx="0.4" cy="0.35" r="0.65">
          <Stop offset="0" stopColor={b1} />
          <Stop offset="1" stopColor={b2} />
        </RadialGradient>
      </Defs>
      <Ellipse cx="50" cy="92" rx="34" ry="3.5" fill="#000" opacity="0.5" />
      {/* 6 spiked legs */}
      <Path d="M 22 52 Q 6 36 4 26" stroke={b2} strokeWidth="3.5" fill="none" strokeLinecap="round" />
      <Path d="M 20 62 Q 2 58 0 62" stroke={b2} strokeWidth="3.5" fill="none" strokeLinecap="round" />
      <Path d="M 24 72 Q 8 82 6 92" stroke={b2} strokeWidth="3.5" fill="none" strokeLinecap="round" />
      <Path d="M 78 52 Q 94 36 96 26" stroke={b2} strokeWidth="3.5" fill="none" strokeLinecap="round" />
      <Path d="M 80 62 Q 98 58 100 62" stroke={b2} strokeWidth="3.5" fill="none" strokeLinecap="round" />
      <Path d="M 76 72 Q 92 82 94 92" stroke={b2} strokeWidth="3.5" fill="none" strokeLinecap="round" />
      {/* leg joint spikes */}
      <Polygon points="6,26 8,20 10,28" fill={b2} />
      <Polygon points="94,26 92,20 90,28" fill={b2} />
      {/* stinger tail */}
      <Path d="M 50 82 Q 50 92 56 96" stroke={b2} strokeWidth="3" fill="none" />
      <Polygon points="54,94 60,100 56,92" fill={b2} stroke="#0a0510" strokeWidth="0.8" />
      {/* body */}
      <Ellipse cx="50" cy="55" rx="32" ry="28" fill={`url(#${id}b)`} stroke="#000" strokeWidth="2.5" />
      {/* carapace plates */}
      <Path d="M 22 50 Q 50 58 78 50" stroke="#000" strokeWidth="1.5" fill="none" opacity="0.8" />
      <Path d="M 24 62 Q 50 70 76 62" stroke="#000" strokeWidth="1.5" fill="none" opacity="0.7" />
      <Path d="M 26 72 Q 50 78 74 72" stroke="#000" strokeWidth="1.5" fill="none" opacity="0.6" />
      {/* spikes on back */}
      <Polygon points="36,32 38,22 40,34" fill="#0a0510" />
      <Polygon points="48,28 50,18 52,28" fill="#0a0510" />
      <Polygon points="60,32 62,22 64,34" fill="#0a0510" />
      {/* highlight */}
      <Ellipse cx="40" cy="42" rx="12" ry="7" fill="#fff" opacity="0.25" />
      {/* large dripping mandibles */}
      <Path d="M 36 76 Q 32 92 42 86" stroke="#0a0510" strokeWidth="3" fill="none" strokeLinecap="round" />
      <Path d="M 64 76 Q 68 92 58 86" stroke="#0a0510" strokeWidth="3" fill="none" strokeLinecap="round" />
      {/* venom drip from mouth */}
      <Path d="M 50 78 Q 49 88 50 94" stroke="#5cf28a" strokeWidth="2" fill="none" strokeLinecap="round" />
      <Circle cx="50" cy="96" r="2.5" fill="#5cf28a" />
      <Circle cx="49" cy="92" r="1" fill="#5cf28a" />
      {/* big eye with slit pupil */}
      <Circle cx="50" cy="52" r="16" fill="#fff" stroke="#000" strokeWidth="2" />
      <Circle cx="50" cy="52" r="13" fill="#0b1020" />
      <Circle cx="50" cy="52" r="9" fill="#ffd166" />
      <Ellipse cx="50" cy="52" rx="2.5" ry="9" fill="#0a0510" />
      <Circle cx="47" cy="48" r="2" fill="#fff" />
    </Svg>
  );
});

// Elite Flyer: wraith bat. Dark forest green, 4 eyes, larger wings, stinger.
const EliteFlyerSvg = React.memo(function EliteFlyerSvg({ size, burning, flap }) {
  const id = useRef(nextGid()).current;
  const c1 = burning ? '#a8f8c8' : '#3a6040';
  const c2 = burning ? '#2e8c50' : '#0a200a';
  const wing = (flap || 0) * 15;
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100">
      <Defs>
        <LinearGradient id={`${id}b`} x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={c1} />
          <Stop offset="1" stopColor={c2} />
        </LinearGradient>
      </Defs>
      <Ellipse cx="50" cy="92" rx="22" ry="3" fill="#000" opacity="0.35" />
      {/* wings - left (larger, tattered) */}
      <G rotation={-wing} originX="35" originY="40">
        <Path d="M 35 40 Q -2 22 -4 60 Q 14 50 24 56 Q 8 62 12 72 Q 24 62 35 60 Z"
              fill={c2} stroke="#000" strokeWidth="1.8" />
        <Path d="M 10 36 L 24 50" stroke="#000" strokeWidth="1.2" />
        <Path d="M 0 50 L 22 58" stroke="#000" strokeWidth="1.2" />
        <Path d="M 8 66 L 24 60" stroke="#000" strokeWidth="1.2" />
      </G>
      {/* wings - right */}
      <G rotation={wing} originX="65" originY="40">
        <Path d="M 65 40 Q 102 22 104 60 Q 86 50 76 56 Q 92 62 88 72 Q 76 62 65 60 Z"
              fill={c2} stroke="#000" strokeWidth="1.8" />
        <Path d="M 90 36 L 76 50" stroke="#000" strokeWidth="1.2" />
        <Path d="M 100 50 L 78 58" stroke="#000" strokeWidth="1.2" />
        <Path d="M 92 66 L 76 60" stroke="#000" strokeWidth="1.2" />
      </G>
      {/* tail/stinger */}
      <Path d="M 50 78 Q 52 90 48 96" stroke={c2} strokeWidth="3" fill="none" />
      <Polygon points="48,96 50,100 46,94" fill={c2} stroke="#000" strokeWidth="0.8" />
      {/* body */}
      <Ellipse cx="50" cy="50" rx="22" ry="26" fill={`url(#${id}b)`} stroke="#000" strokeWidth="2.2" />
      {/* devil ears */}
      <Polygon points="36,28 28,8 44,26" fill={c2} stroke="#000" strokeWidth="1.2" />
      <Polygon points="64,28 72,8 56,26" fill={c2} stroke="#000" strokeWidth="1.2" />
      {/* 4 eyes — two main + two smaller */}
      <Circle cx="40" cy="46" r="4" fill="#ff4d6d" />
      <Circle cx="60" cy="46" r="4" fill="#ff4d6d" />
      <Circle cx="40" cy="47" r="1.5" fill="#000" />
      <Circle cx="60" cy="47" r="1.5" fill="#000" />
      <Circle cx="44" cy="38" r="2" fill="#ff4d6d" />
      <Circle cx="56" cy="38" r="2" fill="#ff4d6d" />
      <Circle cx="44" cy="38" r="0.8" fill="#000" />
      <Circle cx="56" cy="38" r="0.8" fill="#000" />
      {/* fanged mouth */}
      <Path d="M 40 60 Q 50 70 60 60 Q 55 64 50 64 Q 45 64 40 60 Z" fill="#0a0510" />
      <Polygon points="44,60 46,68 48,60" fill="#fff" />
      <Polygon points="52,60 54,68 56,60" fill="#fff" />
    </Svg>
  );
});

// ───── Boss variants ────────────────────────────────────────────────────────

// Void King (wave 20): purple-violet, floating crown, void rift, more horns.
const VoidBossSvg = React.memo(function VoidBossSvg({ size, burning }) {
  const id = useRef(nextGid()).current;
  const b1 = burning ? '#a8f8c8' : '#9e7afc';
  const b2 = burning ? '#2e8c50' : '#2a1840';
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100">
      <Defs>
        <LinearGradient id={`${id}b`} x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={b1} />
          <Stop offset="1" stopColor={b2} />
        </LinearGradient>
        <RadialGradient id={`${id}e`} cx="0.5" cy="0.5" r="0.5">
          <Stop offset="0" stopColor="#fff" />
          <Stop offset="0.4" stopColor="#c4a8ff" />
          <Stop offset="1" stopColor="#5a3d8c" />
        </RadialGradient>
        <RadialGradient id={`${id}v`} cx="0.5" cy="0.5" r="0.5">
          <Stop offset="0" stopColor="#fff" />
          <Stop offset="0.3" stopColor="#c4a8ff" />
          <Stop offset="0.8" stopColor="#5a3d8c" />
          <Stop offset="1" stopColor="#0a0510" />
        </RadialGradient>
      </Defs>
      <Ellipse cx="50" cy="95" rx="44" ry="4.5" fill="#000" opacity="0.65" />
      {/* purple cape with violet trim */}
      <Path d="M 14 58 L 2 96 L 28 92 L 30 62 Z" fill="#2a1840" stroke="#0a0510" strokeWidth="1.5" />
      <Path d="M 86 58 L 98 96 L 72 92 L 70 62 Z" fill="#2a1840" stroke="#0a0510" strokeWidth="1.5" />
      <Path d="M 14 58 L 30 62" stroke="#9e7afc" strokeWidth="1.2" />
      <Path d="M 86 58 L 70 62" stroke="#9e7afc" strokeWidth="1.2" />
      {/* 7 horns crown (more than demon) */}
      <Path d="M 8 36 Q 0 4 22 28 Z" fill="#0a0510" />
      <Polygon points="20,22 14,-2 28,18" fill="#0a0510" />
      <Polygon points="32,14 26,-4 40,12" fill="#0a0510" />
      <Polygon points="44,8 40,-8 50,8 46,-2" fill="#0a0510" />
      <Polygon points="56,8 54,-2 60,-8 50,8" fill="#0a0510" />
      <Polygon points="68,14 60,12 74,-4" fill="#0a0510" />
      <Polygon points="80,22 72,18 86,-2" fill="#0a0510" />
      <Path d="M 92 36 Q 100 4 78 28 Z" fill="#0a0510" />
      {/* body */}
      <Circle cx="50" cy="55" r="38" fill={`url(#${id}b)`} stroke="#0a0510" strokeWidth="3" />
      <Ellipse cx="50" cy="72" rx="24" ry="11" fill="#fff" opacity="0.12" />
      {/* floating crown (gap between head & crown) */}
      <Rect x="20" y="20" width="60" height="3" fill="#9e7afc" opacity="0.7" />
      <Path d="M 16 24 L 22 14 L 28 22 L 34 12 L 40 22 L 46 10 L 50 22 L 54 10 L 60 22 L 66 12 L 72 22 L 78 14 L 84 24 Z"
            fill="#9e7afc" stroke="#0a0510" strokeWidth="1.8" />
      <Circle cx="22" cy="14" r="1.5" fill="#fff" />
      <Circle cx="50" cy="10" r="2" fill="#fff" />
      <Circle cx="78" cy="14" r="1.5" fill="#fff" />
      {/* void rift in chest */}
      <Ellipse cx="50" cy="68" rx="11" ry="6" fill={`url(#${id}v)`} />
      <Path d="M 42 68 L 58 68" stroke="#fff" strokeWidth="0.8" opacity="0.6" />
      {/* eye sockets */}
      <Ellipse cx="36" cy="50" rx="11" ry="8" fill="#0a0510" />
      <Ellipse cx="64" cy="50" rx="11" ry="8" fill="#0a0510" />
      {/* glowing eyes */}
      <Circle cx="36" cy="51" r="7" fill={`url(#${id}e)`} />
      <Circle cx="64" cy="51" r="7" fill={`url(#${id}e)`} />
      <Ellipse cx="36" cy="51" rx="2" ry="5" fill="#000" />
      <Ellipse cx="64" cy="51" rx="2" ry="5" fill="#000" />
      {/* brows */}
      <Path d="M 24 40 L 44 46" stroke="#0a0510" strokeWidth="3.5" strokeLinecap="round" />
      <Path d="M 76 40 L 56 46" stroke="#0a0510" strokeWidth="3.5" strokeLinecap="round" />
      {/* mouth — closed, scarred */}
      <Path d="M 32 76 L 68 76" stroke="#0a0510" strokeWidth="3" strokeLinecap="round" />
      <Path d="M 38 73 L 44 79" stroke="#0a0510" strokeWidth="1.2" />
      <Path d="M 50 73 L 56 79" stroke="#0a0510" strokeWidth="1.2" />
      <Path d="M 62 73 L 68 79" stroke="#0a0510" strokeWidth="1.2" />
      {/* purple energy wisps around head */}
      <Circle cx="14" cy="48" r="1.5" fill="#c4a8ff" opacity="0.7" />
      <Circle cx="86" cy="48" r="1.5" fill="#c4a8ff" opacity="0.7" />
      <Circle cx="20" cy="40" r="1" fill="#c4a8ff" opacity="0.5" />
      <Circle cx="80" cy="40" r="1" fill="#c4a8ff" opacity="0.5" />
    </Svg>
  );
});

// ───── Champion variants (waves 21+) — blood-cursed by the coming tyrant ────

// Champion Grunt — Bloodfang Berserker. Skull half-mask, axe glimpse, blood drip.
const ChampionGruntSvg = React.memo(function ChampionGruntSvg({ size, burning }) {
  const id = useRef(nextGid()).current;
  const body1 = burning ? '#a8f8c8' : '#603048';
  const body2 = burning ? '#2e8c50' : '#1a0a14';
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100">
      <Defs>
        <LinearGradient id={`${id}b`} x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={body1} />
          <Stop offset="1" stopColor={body2} />
        </LinearGradient>
        <RadialGradient id={`${id}e`} cx="0.5" cy="0.5" r="0.5">
          <Stop offset="0" stopColor="#fff" />
          <Stop offset="0.4" stopColor="#ff4d6d" />
          <Stop offset="1" stopColor="#5a0010" />
        </RadialGradient>
      </Defs>
      <Ellipse cx="50" cy="93" rx="32" ry="4" fill="#000" opacity="0.65" />
      {/* axe blade visible behind shoulder */}
      <Path d="M 78 40 L 96 30 L 96 50 L 82 56 Z" fill="#8a98b8" stroke="#000" strokeWidth="1.5" />
      <Path d="M 84 42 L 90 38" stroke="#fff" strokeWidth="0.8" opacity="0.6" />
      <Rect x="76" y="38" width="3" height="42" fill="#3a2806" stroke="#000" strokeWidth="0.8" />
      {/* twin horns + 2 smaller side spikes */}
      <Polygon points="22,30 28,2 36,32" fill="#0a0510" />
      <Polygon points="78,30 72,2 64,32" fill="#0a0510" />
      <Polygon points="18,42 12,28 22,40" fill="#0a0510" />
      <Polygon points="82,42 88,28 78,40" fill="#0a0510" />
      {/* ears with multiple piercings */}
      <Polygon points="14,55 4,48 16,68" fill={body2} stroke="#0a0510" strokeWidth="1.5" />
      <Polygon points="86,55 96,48 84,68" fill={body2} stroke="#0a0510" strokeWidth="1.5" />
      <Circle cx="10" cy="56" r="1.5" fill="#ffd166" />
      <Circle cx="10" cy="62" r="1.5" fill="#ffd166" />
      <Circle cx="90" cy="56" r="1.5" fill="#ffd166" />
      <Circle cx="90" cy="62" r="1.5" fill="#ffd166" />
      {/* body */}
      <Circle cx="50" cy="55" r="34" fill={`url(#${id}b)`} stroke="#0a0510" strokeWidth="3.2" />
      <Ellipse cx="50" cy="72" rx="22" ry="11" fill="#fff" opacity="0.08" />
      {/* skull half-mask covering upper face */}
      <Path d="M 18 36 Q 50 28 82 36 L 78 60 Q 50 64 22 60 Z"
            fill="#e8e0c8" stroke="#0a0510" strokeWidth="1.8" />
      <Path d="M 18 36 Q 50 28 82 36 L 78 60 Q 50 64 22 60 Z"
            fill="#7a1d2e" opacity="0.25" />
      {/* skull crack lines */}
      <Path d="M 32 42 L 28 50 L 32 54" stroke="#0a0510" strokeWidth="0.8" fill="none" />
      <Path d="M 68 42 L 72 50" stroke="#0a0510" strokeWidth="0.8" fill="none" />
      <Path d="M 50 28 L 50 36" stroke="#0a0510" strokeWidth="1" fill="none" />
      {/* eye holes in mask with red glow */}
      <Ellipse cx="38" cy="48" rx="8" ry="7" fill="#0a0000" />
      <Ellipse cx="62" cy="48" rx="8" ry="7" fill="#0a0000" />
      <Circle cx="38" cy="47" r="5.5" fill={`url(#${id}e)`} />
      <Circle cx="62" cy="47" r="5.5" fill={`url(#${id}e)`} />
      <Ellipse cx="38" cy="48" rx="1.5" ry="3.5" fill="#000" />
      <Ellipse cx="62" cy="48" rx="1.5" ry="3.5" fill="#000" />
      {/* nose hole in mask */}
      <Polygon points="50,52 47,58 53,58" fill="#0a0000" />
      {/* blood drip from mask */}
      <Path d="M 32 58 Q 30 70 32 78" stroke="#7a1d2e" strokeWidth="1.5" fill="none" />
      <Circle cx="32" cy="80" r="1.5" fill="#7a1d2e" />
      <Path d="M 68 58 Q 70 68 69 76" stroke="#7a1d2e" strokeWidth="1.5" fill="none" />
      <Circle cx="69" cy="78" r="1.2" fill="#7a1d2e" />
      {/* mouth below mask — snarling */}
      <Path d="M 32 70 Q 50 82 68 70 Q 60 76 50 76 Q 40 76 32 70 Z" fill="#0a0000" />
      <Polygon points="36,70 39,80 42,70" fill="#fff" />
      <Polygon points="48,70 50,82 52,70" fill="#fff" />
      <Polygon points="58,70 61,80 64,70" fill="#fff" />
      {/* shoulder bone spikes */}
      <Polygon points="14,65 6,72 18,70" fill="#e8e0c8" stroke="#0a0510" strokeWidth="0.8" />
      <Polygon points="86,65 94,72 82,70" fill="#e8e0c8" stroke="#0a0510" strokeWidth="0.8" />
    </Svg>
  );
});

// Champion Runner — Phantom Strider. Tattered cloak, red runes, 4 daggers.
const ChampionRunnerSvg = React.memo(function ChampionRunnerSvg({ size, burning }) {
  const id = useRef(nextGid()).current;
  const c1 = burning ? '#a8f8c8' : '#1a0a14';
  const c2 = burning ? '#2e8c50' : '#000';
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100">
      <Defs>
        <LinearGradient id={`${id}c`} x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={c1} />
          <Stop offset="1" stopColor={c2} />
        </LinearGradient>
      </Defs>
      <Ellipse cx="50" cy="93" rx="25" ry="3.4" fill="#000" opacity="0.55" />
      {/* phantom mist behind */}
      <Ellipse cx="50" cy="60" rx="40" ry="8" fill="#7a1d2e" opacity="0.25" />
      <Ellipse cx="30" cy="78" rx="20" ry="4" fill="#7a1d2e" opacity="0.2" />
      <Ellipse cx="70" cy="78" rx="20" ry="4" fill="#7a1d2e" opacity="0.2" />
      {/* tattered cloak silhouette */}
      <Path
        d="M 50 4
           C 60 8 66 18 70 30
           L 82 60
           L 86 82
           L 78 78 L 76 88 L 70 84 L 64 92 L 56 86 L 50 90 L 44 86 L 36 92 L 30 84 L 24 88 L 22 78 L 14 82
           L 18 60
           L 30 30
           C 34 18 40 8 50 4 Z"
        fill={`url(#${id}c)`}
        stroke="#000"
        strokeWidth="2.2"
      />
      {/* blood-red runes on cloak */}
      <Path d="M 38 50 L 42 46 L 42 56 L 38 60 Z" fill="#7a1d2e" />
      <Path d="M 62 50 L 58 46 L 58 56 L 62 60 Z" fill="#7a1d2e" />
      <Path d="M 50 64 L 46 68 L 54 68 Z" fill="#7a1d2e" />
      <Path d="M 28 70 L 32 74 L 28 78" stroke="#7a1d2e" strokeWidth="1.5" fill="none" />
      <Path d="M 72 70 L 68 74 L 72 78" stroke="#7a1d2e" strokeWidth="1.5" fill="none" />
      {/* iron hood trim */}
      <Path d="M 32 30 C 38 22 44 18 50 18 C 56 18 62 22 68 30" stroke="#a8b4d0" strokeWidth="2.4" fill="none" />
      {/* spikes on hood trim */}
      <Polygon points="34,28 32,22 38,28" fill="#a8b4d0" />
      <Polygon points="50,20 47,12 53,12" fill="#a8b4d0" />
      <Polygon points="66,28 68,22 62,28" fill="#a8b4d0" />
      {/* abyssal hood shadow */}
      <Path d="M 32 30 C 38 22 44 18 50 18 C 56 18 62 22 68 30 L 64 54 L 36 54 Z" fill="#000" />
      {/* burning red eye slits */}
      <Path d="M 36 40 L 46 36 L 46 42 L 36 44 Z" fill="#ff4d6d" />
      <Path d="M 64 40 L 54 36 L 54 42 L 64 44 Z" fill="#ff4d6d" />
      <Circle cx="42" cy="40" r="1.5" fill="#fff" />
      <Circle cx="58" cy="40" r="1.5" fill="#fff" />
      {/* tear-streaks of blood from eyes */}
      <Path d="M 42 44 L 40 52" stroke="#7a1d2e" strokeWidth="1.2" />
      <Path d="M 58 44 L 60 52" stroke="#7a1d2e" strokeWidth="1.2" />
      {/* belt with skull */}
      <Rect x="22" y="60" width="56" height="6" fill="#000" />
      <Circle cx="50" cy="63" r="4" fill="#e8e0c8" stroke="#000" strokeWidth="0.8" />
      <Circle cx="48.5" cy="62.5" r="0.8" fill="#7a1d2e" />
      <Circle cx="51.5" cy="62.5" r="0.8" fill="#7a1d2e" />
      {/* 4 dagger hilts — two each side */}
      <Rect x="16" y="62" width="3" height="14" fill="#000" />
      <Rect x="13" y="60" width="9" height="3" fill="#a8b4d0" />
      <Rect x="22" y="68" width="3" height="14" fill="#000" />
      <Rect x="19" y="66" width="9" height="3" fill="#7a1d2e" />
      <Rect x="81" y="62" width="3" height="14" fill="#000" />
      <Rect x="78" y="60" width="9" height="3" fill="#a8b4d0" />
      <Rect x="75" y="68" width="3" height="14" fill="#000" />
      <Rect x="72" y="66" width="9" height="3" fill="#7a1d2e" />
    </Svg>
  );
});

// Champion Tank — Hellforged Juggernaut. Crowned helm, brutal armor, war hammer.
const ChampionTankSvg = React.memo(function ChampionTankSvg({ size, burning }) {
  const id = useRef(nextGid()).current;
  const a1 = burning ? '#a8f8c8' : '#404a60';
  const a2 = burning ? '#2e8c50' : '#0a0e1c';
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100">
      <Defs>
        <LinearGradient id={`${id}a`} x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={a1} />
          <Stop offset="1" stopColor={a2} />
        </LinearGradient>
      </Defs>
      <Ellipse cx="50" cy="95" rx="42" ry="5" fill="#000" opacity="0.75" />
      {/* war hammer behind right shoulder */}
      <Rect x="78" y="32" width="3" height="62" fill="#3a2806" stroke="#000" strokeWidth="0.5" />
      <Rect x="72" y="22" width="14" height="14" fill={a1} stroke="#000" strokeWidth="1.5" />
      <Polygon points="72,22 68,29 72,36" fill={a1} stroke="#000" strokeWidth="1.5" />
      <Polygon points="86,22 90,29 86,36" fill={a1} stroke="#000" strokeWidth="1.5" />
      <Circle cx="79" cy="29" r="2" fill="#7a1d2e" />
      {/* pauldrons with multiple long spikes */}
      <Path d="M 2 50 Q 0 28 22 24 L 36 50 L 30 72 L 4 68 Z" fill={`url(#${id}a)`} stroke="#000" strokeWidth="2.5" />
      <Path d="M 98 50 Q 100 28 78 24 L 64 50 L 70 72 L 96 68 Z" fill={`url(#${id}a)`} stroke="#000" strokeWidth="2.5" />
      <Polygon points="8,36 12,12 16,38" fill="#000" />
      <Polygon points="16,28 20,4 22,30" fill="#000" />
      <Polygon points="24,22 26,-4 30,24" fill="#000" />
      <Polygon points="92,36 88,12 84,38" fill="#000" />
      <Polygon points="84,28 80,4 78,30" fill="#000" />
      <Polygon points="76,22 74,-4 70,24" fill="#000" />
      {/* torso wider, more menacing */}
      <Path d="M 22 36 L 78 36 L 84 86 L 74 96 L 26 96 L 16 86 Z" fill={`url(#${id}a)`} stroke="#000" strokeWidth="3" />
      {/* horned chest plate with demon skull */}
      <Path d="M 34 44 L 66 44 L 64 82 L 36 82 Z" fill="#1a2034" stroke="#000" strokeWidth="1.8" />
      <Polygon points="34,44 30,38 38,42" fill="#000" />
      <Polygon points="66,44 70,38 62,42" fill="#000" />
      {/* demon skull on chest */}
      <Ellipse cx="50" cy="58" rx="11" ry="9" fill="#e8e0c8" stroke="#000" strokeWidth="1.2" />
      <Polygon points="42,52 38,42 46,50" fill="#e8e0c8" stroke="#000" strokeWidth="1" />
      <Polygon points="58,52 62,42 54,50" fill="#e8e0c8" stroke="#000" strokeWidth="1" />
      <Ellipse cx="46" cy="58" rx="2.5" ry="3" fill="#ff4d6d" />
      <Ellipse cx="54" cy="58" rx="2.5" ry="3" fill="#ff4d6d" />
      <Polygon points="50,62 47,67 53,67" fill="#0a0510" />
      <Rect x="45" y="68" width="10" height="2" fill="#0a0510" />
      <Line x1="46" y1="68" x2="46" y2="74" stroke="#0a0510" strokeWidth="0.6" />
      <Line x1="50" y1="68" x2="50" y2="74" stroke="#0a0510" strokeWidth="0.6" />
      <Line x1="54" y1="68" x2="54" y2="74" stroke="#0a0510" strokeWidth="0.6" />
      {/* helmet — crowned with massive central horn */}
      <Path d="M 22 38 L 28 10 L 72 10 L 78 38 Z" fill={`url(#${id}a)`} stroke="#000" strokeWidth="3" />
      <Polygon points="50,10 45,-10 55,-10" fill="#000" />
      <Polygon points="38,10 35,-2 41,8" fill="#000" />
      <Polygon points="62,10 65,-2 59,8" fill="#000" />
      <Polygon points="28,10 24,2 32,8" fill="#000" />
      <Polygon points="72,10 76,2 68,8" fill="#000" />
      {/* visor — deep red glow */}
      <Rect x="24" y="22" width="52" height="10" fill="#0a0000" />
      <Rect x="28" y="24" width="44" height="3" fill="#ff4d6d" />
      <Circle cx="36" cy="25.5" r="1.8" fill="#fff" />
      <Circle cx="64" cy="25.5" r="1.8" fill="#fff" />
      <Rect x="34" y="28" width="32" height="2" fill="#7a1d2e" />
      {/* gold trim band on helmet */}
      <Path d="M 25 35 Q 50 33 75 35 L 75 38 Q 50 36 25 38 Z" fill="#ffd166" stroke="#000" strokeWidth="0.8" />
      {/* battle damage and rivets */}
      <Path d="M 36 78 L 32 86 L 38 92" stroke="#000" strokeWidth="1.2" fill="none" />
      <Circle cx="28" cy="48" r="2.2" fill="#000" />
      <Circle cx="72" cy="48" r="2.2" fill="#000" />
      <Circle cx="32" cy="88" r="2.2" fill="#000" />
      <Circle cx="68" cy="88" r="2.2" fill="#000" />
    </Svg>
  );
});

// Champion Swarm — Hivemother. Huge glowing veins, multiple stingers, brood egg.
const ChampionSwarmSvg = React.memo(function ChampionSwarmSvg({ size, burning }) {
  const id = useRef(nextGid()).current;
  const b1 = burning ? '#a8f8c8' : '#7a1d2e';
  const b2 = burning ? '#2e8c50' : '#1a0008';
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100">
      <Defs>
        <RadialGradient id={`${id}b`} cx="0.4" cy="0.35" r="0.65">
          <Stop offset="0" stopColor={b1} />
          <Stop offset="1" stopColor={b2} />
        </RadialGradient>
      </Defs>
      <Ellipse cx="50" cy="92" rx="36" ry="4" fill="#000" opacity="0.6" />
      {/* 8 legs — six standard plus two big claws on front */}
      <Path d="M 22 52 Q 4 32 0 22" stroke={b2} strokeWidth="4" fill="none" strokeLinecap="round" />
      <Path d="M 20 62 Q 0 58 -2 62" stroke={b2} strokeWidth="4" fill="none" strokeLinecap="round" />
      <Path d="M 24 72 Q 6 82 4 96" stroke={b2} strokeWidth="4" fill="none" strokeLinecap="round" />
      <Path d="M 78 52 Q 96 32 100 22" stroke={b2} strokeWidth="4" fill="none" strokeLinecap="round" />
      <Path d="M 80 62 Q 100 58 102 62" stroke={b2} strokeWidth="4" fill="none" strokeLinecap="round" />
      <Path d="M 76 72 Q 94 82 96 96" stroke={b2} strokeWidth="4" fill="none" strokeLinecap="round" />
      {/* front claws */}
      <Path d="M 28 46 Q 12 30 16 14" stroke={b2} strokeWidth="5" fill="none" strokeLinecap="round" />
      <Path d="M 72 46 Q 88 30 84 14" stroke={b2} strokeWidth="5" fill="none" strokeLinecap="round" />
      <Polygon points="12,14 18,8 18,18" fill={b2} stroke="#000" strokeWidth="0.8" />
      <Polygon points="88,14 82,8 82,18" fill={b2} stroke="#000" strokeWidth="0.8" />
      {/* leg joint spikes */}
      <Polygon points="2,22 4,16 8,24" fill="#0a0008" />
      <Polygon points="98,22 96,16 92,24" fill="#0a0008" />
      {/* three stingers (rear) */}
      <Path d="M 40 84 Q 36 96 42 100" stroke={b2} strokeWidth="3" fill="none" />
      <Polygon points="40,98 44,104 38,96" fill={b2} stroke="#000" strokeWidth="0.6" />
      <Path d="M 50 84 Q 50 98 52 102" stroke={b2} strokeWidth="3" fill="none" />
      <Polygon points="50,100 54,106 48,98" fill={b2} stroke="#000" strokeWidth="0.6" />
      <Path d="M 60 84 Q 64 96 58 100" stroke={b2} strokeWidth="3" fill="none" />
      <Polygon points="60,98 56,104 62,96" fill={b2} stroke="#000" strokeWidth="0.6" />
      {/* body — fatter than elite */}
      <Ellipse cx="50" cy="55" rx="34" ry="30" fill={`url(#${id}b)`} stroke="#000" strokeWidth="3" />
      {/* glowing veins through body */}
      <Path d="M 24 50 Q 36 56 28 70" stroke="#ff4d6d" strokeWidth="1.5" fill="none" opacity="0.85" />
      <Path d="M 76 50 Q 64 56 72 70" stroke="#ff4d6d" strokeWidth="1.5" fill="none" opacity="0.85" />
      <Path d="M 50 30 L 50 76" stroke="#ff4d6d" strokeWidth="1" fill="none" opacity="0.7" />
      <Path d="M 30 38 Q 40 50 30 62" stroke="#ff4d6d" strokeWidth="0.8" fill="none" opacity="0.6" />
      <Path d="M 70 38 Q 60 50 70 62" stroke="#ff4d6d" strokeWidth="0.8" fill="none" opacity="0.6" />
      {/* carapace plates */}
      <Path d="M 22 52 Q 50 60 78 52" stroke="#000" strokeWidth="1.5" fill="none" opacity="0.8" />
      <Path d="M 24 64 Q 50 72 76 64" stroke="#000" strokeWidth="1.5" fill="none" opacity="0.7" />
      <Path d="M 26 74 Q 50 80 74 74" stroke="#000" strokeWidth="1.5" fill="none" opacity="0.6" />
      {/* back spikes — bigger */}
      <Polygon points="34,30 36,16 40,32" fill="#0a0008" />
      <Polygon points="46,26 50,12 54,26" fill="#0a0008" />
      <Polygon points="60,30 62,16 66,32" fill="#0a0008" />
      {/* highlight */}
      <Ellipse cx="40" cy="40" rx="10" ry="6" fill="#fff" opacity="0.2" />
      {/* brood egg visible on belly */}
      <Ellipse cx="50" cy="72" rx="6" ry="9" fill="#e8e0c8" stroke="#000" strokeWidth="1" opacity="0.9" />
      <Path d="M 47 68 L 52 76" stroke="#7a1d2e" strokeWidth="0.8" />
      {/* mandibles */}
      <Path d="M 34 76 Q 28 94 40 86" stroke="#0a0008" strokeWidth="3.5" fill="none" strokeLinecap="round" />
      <Path d="M 66 76 Q 72 94 60 86" stroke="#0a0008" strokeWidth="3.5" fill="none" strokeLinecap="round" />
      {/* venom drips */}
      <Circle cx="36" cy="92" r="2" fill="#5cf28a" />
      <Circle cx="64" cy="92" r="2" fill="#5cf28a" />
      {/* compound eye cluster — one big eye plus 4 smaller around */}
      <Circle cx="50" cy="52" r="16" fill="#fff" stroke="#000" strokeWidth="2.5" />
      <Circle cx="50" cy="52" r="13" fill="#0b1020" />
      <Circle cx="50" cy="52" r="9" fill="#ff4d6d" />
      <Ellipse cx="50" cy="52" rx="2.5" ry="9" fill="#0a0510" />
      <Circle cx="47" cy="48" r="2.2" fill="#fff" />
      {/* small ocelli around */}
      <Circle cx="34" cy="46" r="2.5" fill="#ff4d6d" stroke="#000" strokeWidth="0.6" />
      <Circle cx="66" cy="46" r="2.5" fill="#ff4d6d" stroke="#000" strokeWidth="0.6" />
      <Circle cx="38" cy="38" r="2" fill="#ff4d6d" stroke="#000" strokeWidth="0.5" />
      <Circle cx="62" cy="38" r="2" fill="#ff4d6d" stroke="#000" strokeWidth="0.5" />
    </Svg>
  );
});

// ───── Blood Tyrant (wave 30 boss) ─────────────────────────────────────────

const BloodBossSvg = React.memo(function BloodBossSvg({ size, burning }) {
  const id = useRef(nextGid()).current;
  const b1 = burning ? '#a8f8c8' : '#a82038';
  const b2 = burning ? '#2e8c50' : '#3a0010';
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100">
      <Defs>
        <LinearGradient id={`${id}b`} x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={b1} />
          <Stop offset="1" stopColor={b2} />
        </LinearGradient>
        <RadialGradient id={`${id}e`} cx="0.5" cy="0.5" r="0.5">
          <Stop offset="0" stopColor="#fff" />
          <Stop offset="0.3" stopColor="#ffd166" />
          <Stop offset="0.7" stopColor="#ff4d6d" />
          <Stop offset="1" stopColor="#3a0010" />
        </RadialGradient>
        <RadialGradient id={`${id}p`} cx="0.5" cy="0.5" r="0.5">
          <Stop offset="0" stopColor="#ff4d6d" opacity="0.5" />
          <Stop offset="1" stopColor="#7a1d2e" opacity="0" />
        </RadialGradient>
      </Defs>
      {/* blood pool aura */}
      <Ellipse cx="50" cy="95" rx="50" ry="8" fill={`url(#${id}p)`} />
      <Ellipse cx="50" cy="95" rx="44" ry="5" fill="#7a1d2e" opacity="0.7" />
      <Ellipse cx="50" cy="96" rx="38" ry="3" fill="#3a0010" opacity="0.9" />
      {/* dripping blood from base */}
      <Path d="M 22 92 Q 20 100 24 104" stroke="#7a1d2e" strokeWidth="2" fill="none" />
      <Circle cx="24" cy="106" r="1.5" fill="#7a1d2e" />
      <Path d="M 78 92 Q 80 100 76 104" stroke="#7a1d2e" strokeWidth="2" fill="none" />
      <Circle cx="76" cy="106" r="1.5" fill="#7a1d2e" />
      {/* tattered black-red cape behind */}
      <Path
        d="M 10 56 L -2 96 L 14 92 L 8 80 L 20 88 L 22 60 Z"
        fill="#3a0010" stroke="#0a0000" strokeWidth="1.5"
      />
      <Path
        d="M 90 56 L 102 96 L 86 92 L 92 80 L 80 88 L 78 60 Z"
        fill="#3a0010" stroke="#0a0000" strokeWidth="1.5"
      />
      {/* massive curved goat horns */}
      <Path
        d="M 18 30 Q 0 14 -2 34 Q 6 36 16 36 Z"
        fill="#0a0000" stroke="#7a1d2e" strokeWidth="0.5"
      />
      <Path
        d="M 82 30 Q 100 14 102 34 Q 94 36 84 36 Z"
        fill="#0a0000" stroke="#7a1d2e" strokeWidth="0.5"
      />
      {/* central spike crown */}
      <Polygon points="32,22 28,4 40,20" fill="#0a0000" />
      <Polygon points="42,16 38,-2 48,16" fill="#0a0000" />
      <Polygon points="50,12 45,-6 55,-6 50,12" fill="#0a0000" />
      <Polygon points="58,16 52,16 62,-2" fill="#0a0000" />
      <Polygon points="68,22 60,20 72,4" fill="#0a0000" />
      {/* body — wider, more imposing */}
      <Circle cx="50" cy="55" r="40" fill={`url(#${id}b)`} stroke="#0a0000" strokeWidth="3.5" />
      <Ellipse cx="50" cy="74" rx="26" ry="12" fill="#fff" opacity="0.1" />
      {/* bone armor plates on shoulders */}
      <Path d="M 12 50 Q 8 38 18 36 L 26 48 L 22 60 Z" fill="#e8e0c8" stroke="#0a0000" strokeWidth="1.5" />
      <Path d="M 88 50 Q 92 38 82 36 L 74 48 L 78 60 Z" fill="#e8e0c8" stroke="#0a0000" strokeWidth="1.5" />
      <Polygon points="14,44 8,38 18,42" fill="#0a0000" />
      <Polygon points="86,44 92,38 82,42" fill="#0a0000" />
      {/* exposed ribcage on chest */}
      <Path d="M 36 60 L 40 80 M 44 60 L 46 82 M 50 60 L 50 84 M 56 60 L 54 82 M 64 60 L 60 80"
            stroke="#e8e0c8" strokeWidth="1.5" fill="none" />
      <Path d="M 34 60 Q 50 64 66 60" stroke="#e8e0c8" strokeWidth="2" fill="none" />
      {/* bone necklace of severed heads */}
      <Path d="M 24 76 Q 50 88 76 76" stroke="#e8e0c8" strokeWidth="1.5" fill="none" />
      <Circle cx="34" cy="82" r="3" fill="#e8e0c8" stroke="#0a0000" strokeWidth="0.6" />
      <Circle cx="33" cy="81" r="0.5" fill="#7a1d2e" />
      <Circle cx="35" cy="81" r="0.5" fill="#7a1d2e" />
      <Circle cx="50" cy="86" r="3.5" fill="#e8e0c8" stroke="#0a0000" strokeWidth="0.6" />
      <Circle cx="49" cy="85" r="0.6" fill="#7a1d2e" />
      <Circle cx="51" cy="85" r="0.6" fill="#7a1d2e" />
      <Circle cx="66" cy="82" r="3" fill="#e8e0c8" stroke="#0a0000" strokeWidth="0.6" />
      <Circle cx="65" cy="81" r="0.5" fill="#7a1d2e" />
      <Circle cx="67" cy="81" r="0.5" fill="#7a1d2e" />
      {/* eye sockets */}
      <Ellipse cx="36" cy="48" rx="12" ry="9" fill="#0a0000" />
      <Ellipse cx="64" cy="48" rx="12" ry="9" fill="#0a0000" />
      {/* glowing fiery eyes */}
      <Circle cx="36" cy="48" r="7.5" fill={`url(#${id}e)`} />
      <Circle cx="64" cy="48" r="7.5" fill={`url(#${id}e)`} />
      <Ellipse cx="36" cy="48" rx="2.5" ry="6" fill="#000" />
      <Ellipse cx="64" cy="48" rx="2.5" ry="6" fill="#000" />
      {/* blood tears */}
      <Path d="M 36 54 Q 34 64 38 70" stroke="#7a1d2e" strokeWidth="2.2" fill="none" />
      <Circle cx="38" cy="72" r="1.5" fill="#7a1d2e" />
      <Path d="M 64 54 Q 66 64 62 70" stroke="#7a1d2e" strokeWidth="2.2" fill="none" />
      <Circle cx="62" cy="72" r="1.5" fill="#7a1d2e" />
      {/* fierce brow ridges */}
      <Path d="M 22 36 L 46 44" stroke="#0a0000" strokeWidth="4" strokeLinecap="round" />
      <Path d="M 78 36 L 54 44" stroke="#0a0000" strokeWidth="4" strokeLinecap="round" />
      {/* gaping fanged mouth */}
      <Path d="M 26 64 Q 50 90 74 64 Q 64 76 50 76 Q 36 76 26 64 Z" fill="#0a0000" />
      <Polygon points="32,64 36,82 40,64" fill="#fff" />
      <Polygon points="42,65 45,84 48,65" fill="#fff" />
      <Polygon points="50,65 52,86 56,65" fill="#fff" />
      <Polygon points="58,64 62,84 65,64" fill="#fff" />
      <Polygon points="68,64 72,82 76,64" fill="#fff" />
      {/* blood drip from mouth */}
      <Path d="M 50 80 Q 49 90 51 96" stroke="#7a1d2e" strokeWidth="2" fill="none" />
      {/* tongue */}
      <Path d="M 44 72 Q 50 80 56 72" fill="#7a1d2e" stroke="#0a0000" strokeWidth="0.8" />
      {/* glowing battle scars */}
      <Path d="M 76 58 L 88 70" stroke="#0a0000" strokeWidth="2.5" />
      <Path d="M 76 58 L 88 70" stroke="#ff4d6d" strokeWidth="0.8" opacity="0.7" />
      <Path d="M 80 50 L 90 56" stroke="#0a0000" strokeWidth="1.8" />
    </Svg>
  );
});

// ───── Apex variants (waves 31+) — void-touched, ascended forms ─────────────

// Apex Grunt — Soulreaper. Spectral hood, crystalline armor shards, third eye.
const ApexGruntSvg = React.memo(function ApexGruntSvg({ size, burning }) {
  const id = useRef(nextGid()).current;
  const body1 = burning ? '#a8f8c8' : '#4cc9ff';
  const body2 = burning ? '#2e8c50' : '#0a1a3a';
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100">
      <Defs>
        <LinearGradient id={`${id}b`} x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={body1} />
          <Stop offset="1" stopColor={body2} />
        </LinearGradient>
        <RadialGradient id={`${id}e`} cx="0.5" cy="0.5" r="0.5">
          <Stop offset="0" stopColor="#fff" />
          <Stop offset="0.4" stopColor="#5cf28a" />
          <Stop offset="1" stopColor="#0a4a20" />
        </RadialGradient>
        <RadialGradient id={`${id}a`} cx="0.5" cy="0.5" r="0.5">
          <Stop offset="0" stopColor="#4cc9ff" opacity="0.5" />
          <Stop offset="1" stopColor="#4cc9ff" opacity="0" />
        </RadialGradient>
      </Defs>
      {/* ethereal aura */}
      <Circle cx="50" cy="50" r="45" fill={`url(#${id}a)`} />
      <Ellipse cx="50" cy="94" rx="30" ry="3.5" fill="#000" opacity="0.5" />
      {/* spectral wisps trailing up */}
      <Path d="M 18 30 Q 20 14 14 4" stroke="#4cc9ff" strokeWidth="1.2" fill="none" opacity="0.6" />
      <Path d="M 82 30 Q 80 14 86 4" stroke="#4cc9ff" strokeWidth="1.2" fill="none" opacity="0.6" />
      <Circle cx="14" cy="4" r="1.5" fill="#4cc9ff" opacity="0.7" />
      <Circle cx="86" cy="4" r="1.5" fill="#4cc9ff" opacity="0.7" />
      {/* crystalline horns */}
      <Polygon points="22,30 28,2 36,32" fill="#0a1a3a" stroke="#4cc9ff" strokeWidth="1" />
      <Polygon points="78,30 72,2 64,32" fill="#0a1a3a" stroke="#4cc9ff" strokeWidth="1" />
      <Path d="M 28 16 L 30 20" stroke="#fff" strokeWidth="0.6" opacity="0.7" />
      <Path d="M 72 16 L 70 20" stroke="#fff" strokeWidth="0.6" opacity="0.7" />
      {/* ears */}
      <Polygon points="14,55 4,48 16,68" fill={body2} stroke="#4cc9ff" strokeWidth="1.2" />
      <Polygon points="86,55 96,48 84,68" fill={body2} stroke="#4cc9ff" strokeWidth="1.2" />
      {/* body */}
      <Circle cx="50" cy="55" r="34" fill={`url(#${id}b)`} stroke="#0a1a3a" strokeWidth="3" />
      <Ellipse cx="50" cy="72" rx="22" ry="11" fill="#fff" opacity="0.15" />
      {/* crystal shard plates floating around body */}
      <Polygon points="22,60 18,72 28,68" fill="#4cc9ff" opacity="0.85" stroke="#0a1a3a" strokeWidth="0.8" />
      <Polygon points="78,60 82,72 72,68" fill="#4cc9ff" opacity="0.85" stroke="#0a1a3a" strokeWidth="0.8" />
      <Polygon points="20,42 14,38 22,36" fill="#4cc9ff" opacity="0.85" stroke="#0a1a3a" strokeWidth="0.8" />
      <Polygon points="80,42 86,38 78,36" fill="#4cc9ff" opacity="0.85" stroke="#0a1a3a" strokeWidth="0.8" />
      {/* spectral runes on forehead */}
      <Path d="M 44 30 L 50 26 L 56 30 L 50 34 Z" fill="none" stroke="#5cf28a" strokeWidth="1.2" />
      <Circle cx="50" cy="30" r="1.5" fill="#5cf28a" />
      {/* eye sockets */}
      <Ellipse cx="38" cy="50" rx="8" ry="7" fill="#000" />
      <Ellipse cx="62" cy="50" rx="8" ry="7" fill="#000" />
      {/* glowing green eyes (apex = different colour from earlier tiers) */}
      <Circle cx="38" cy="49" r="5.5" fill={`url(#${id}e)`} />
      <Circle cx="62" cy="49" r="5.5" fill={`url(#${id}e)`} />
      <Ellipse cx="38" cy="50" rx="1.5" ry="3.5" fill="#000" />
      <Ellipse cx="62" cy="50" rx="1.5" ry="3.5" fill="#000" />
      {/* third eye on forehead */}
      <Ellipse cx="50" cy="40" rx="4" ry="3.5" fill="#000" />
      <Circle cx="50" cy="40" r="2.5" fill={`url(#${id}e)`} />
      <Ellipse cx="50" cy="40" rx="0.8" ry="2" fill="#000" />
      {/* etched brows */}
      <Path d="M 26 38 L 46 44" stroke="#0a1a3a" strokeWidth="3" strokeLinecap="round" />
      <Path d="M 74 38 L 54 44" stroke="#0a1a3a" strokeWidth="3" strokeLinecap="round" />
      {/* fanged mouth — closed grin */}
      <Path d="M 32 70 L 68 70" stroke="#0a1a3a" strokeWidth="2.5" strokeLinecap="round" />
      <Polygon points="38,70 39,76 41,70" fill="#fff" />
      <Polygon points="48,70 49,77 50,70" fill="#fff" />
      <Polygon points="58,70 59,76 61,70" fill="#fff" />
      {/* tiny floating motes */}
      <Circle cx="12" cy="78" r="1.2" fill="#5cf28a" opacity="0.7" />
      <Circle cx="88" cy="80" r="1.2" fill="#5cf28a" opacity="0.7" />
      <Circle cx="6" cy="36" r="1" fill="#4cc9ff" opacity="0.6" />
      <Circle cx="94" cy="36" r="1" fill="#4cc9ff" opacity="0.6" />
    </Svg>
  );
});

// Apex Runner — Voidblade. Trailing afterimages, void cloak, twin curved blades.
const ApexRunnerSvg = React.memo(function ApexRunnerSvg({ size, burning }) {
  const id = useRef(nextGid()).current;
  const c1 = burning ? '#a8f8c8' : '#1a0e4a';
  const c2 = burning ? '#2e8c50' : '#000';
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100">
      <Defs>
        <LinearGradient id={`${id}c`} x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={c1} />
          <Stop offset="1" stopColor={c2} />
        </LinearGradient>
        <RadialGradient id={`${id}a`} cx="0.5" cy="0.5" r="0.5">
          <Stop offset="0" stopColor="#9e7afc" opacity="0.55" />
          <Stop offset="1" stopColor="#9e7afc" opacity="0" />
        </RadialGradient>
      </Defs>
      {/* void aura */}
      <Circle cx="50" cy="55" r="50" fill={`url(#${id}a)`} />
      <Ellipse cx="50" cy="94" rx="26" ry="3.5" fill="#000" opacity="0.6" />
      {/* afterimage trail behind (3 ghost cloaks) */}
      <Path
        d="M 50 8 L 78 60 L 76 88 L 24 88 L 22 60 Z"
        fill="#9e7afc" opacity="0.12"
        transform="translate(-10,2)"
      />
      <Path
        d="M 50 8 L 78 60 L 76 88 L 24 88 L 22 60 Z"
        fill="#9e7afc" opacity="0.18"
        transform="translate(-5,1)"
      />
      {/* main cloak — tattered hem with sharp jags */}
      <Path
        d="M 50 4
           C 60 8 66 18 70 30
           L 84 60
           L 88 84
           L 80 78 L 78 90 L 70 82 L 64 92 L 56 86 L 50 92 L 44 86 L 36 92 L 30 82 L 22 90 L 20 78 L 12 84
           L 16 60
           L 30 30
           C 34 18 40 8 50 4 Z"
        fill={`url(#${id}c)`} stroke="#000" strokeWidth="2.4"
      />
      {/* glowing void runes on cloak */}
      <Path d="M 30 50 L 30 60 L 36 60" stroke="#9e7afc" strokeWidth="1.5" fill="none" />
      <Path d="M 70 50 L 70 60 L 64 60" stroke="#9e7afc" strokeWidth="1.5" fill="none" />
      <Path d="M 50 64 L 46 70 L 54 70 Z" fill="#9e7afc" />
      <Path d="M 38 72 L 38 80 M 42 76 L 38 76" stroke="#9e7afc" strokeWidth="1" />
      <Path d="M 62 72 L 62 80 M 58 76 L 62 76" stroke="#9e7afc" strokeWidth="1" />
      {/* crystal hood trim */}
      <Path d="M 32 30 C 38 22 44 18 50 18 C 56 18 62 22 68 30" stroke="#9e7afc" strokeWidth="2.5" fill="none" />
      <Polygon points="34,28 30,18 38,26" fill="#9e7afc" />
      <Polygon points="50,18 47,8 53,8" fill="#9e7afc" />
      <Polygon points="66,28 70,18 62,26" fill="#9e7afc" />
      {/* abyssal hood */}
      <Path d="M 32 30 C 38 22 44 18 50 18 C 56 18 62 22 68 30 L 64 54 L 36 54 Z" fill="#000" />
      {/* three glowing eye slits — left/right pairs + center */}
      <Path d="M 34 40 L 44 36 L 44 42 L 34 44 Z" fill="#9e7afc" />
      <Path d="M 66 40 L 56 36 L 56 42 L 66 44 Z" fill="#9e7afc" />
      <Circle cx="50" cy="38" r="2.5" fill="#fff" />
      <Circle cx="50" cy="38" r="1.5" fill="#9e7afc" />
      <Circle cx="40" cy="40" r="1.2" fill="#fff" />
      <Circle cx="60" cy="40" r="1.2" fill="#fff" />
      {/* belt with floating purple gem */}
      <Rect x="20" y="60" width="60" height="6" fill="#000" />
      <Rect x="20" y="60" width="60" height="1.5" fill="#9e7afc" opacity="0.7" />
      <Polygon points="46,57 50,52 54,57 50,69 Z" fill="#9e7afc" stroke="#fff" strokeWidth="0.6" />
      <Polygon points="46,57 50,52 50,60 Z" fill="#fff" opacity="0.6" />
      {/* twin curved void-blades behind shoulders */}
      <Path d="M 8 30 Q 4 50 18 64 L 22 60 Q 12 50 14 32 Z" fill="#9e7afc" stroke="#000" strokeWidth="1.5" />
      <Path d="M 92 30 Q 96 50 82 64 L 78 60 Q 88 50 86 32 Z" fill="#9e7afc" stroke="#000" strokeWidth="1.5" />
      <Path d="M 10 32 Q 8 50 18 60" stroke="#fff" strokeWidth="0.5" fill="none" opacity="0.6" />
      <Path d="M 90 32 Q 92 50 82 60" stroke="#fff" strokeWidth="0.5" fill="none" opacity="0.6" />
    </Svg>
  );
});

// Apex Tank — Worldbreaker Titan. Massive, crystalline weak points, halo.
const ApexTankSvg = React.memo(function ApexTankSvg({ size, burning }) {
  const id = useRef(nextGid()).current;
  const a1 = burning ? '#a8f8c8' : '#2a3450';
  const a2 = burning ? '#2e8c50' : '#000';
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100">
      <Defs>
        <LinearGradient id={`${id}a`} x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={a1} />
          <Stop offset="1" stopColor={a2} />
        </LinearGradient>
        <RadialGradient id={`${id}g`} cx="0.5" cy="0.5" r="0.5">
          <Stop offset="0" stopColor="#fff" />
          <Stop offset="0.4" stopColor="#5cf28a" />
          <Stop offset="1" stopColor="#0a4a20" />
        </RadialGradient>
      </Defs>
      <Ellipse cx="50" cy="96" rx="46" ry="5.5" fill="#000" opacity="0.8" />
      {/* halo of energy above */}
      <Ellipse cx="50" cy="2" rx="34" ry="3" fill="none" stroke="#5cf28a" strokeWidth="1.5" opacity="0.75" />
      <Ellipse cx="50" cy="2" rx="34" ry="3" fill="none" stroke="#fff" strokeWidth="0.5" opacity="0.5" />
      <Circle cx="50" cy="2" r="2" fill="#5cf28a" />
      {/* twin greatswords crossed behind (silhouettes) */}
      <Rect x="6" y="22" width="3" height="60" fill="#a8b4d0" stroke="#000" strokeWidth="0.8"
            transform="rotate(-18,7.5,52)" />
      <Polygon points="-2,12 8,12 12,22 4,30" fill="#a8b4d0" stroke="#000" strokeWidth="0.8"
               transform="rotate(-18,7.5,52)" />
      <Rect x="91" y="22" width="3" height="60" fill="#a8b4d0" stroke="#000" strokeWidth="0.8"
            transform="rotate(18,92.5,52)" />
      <Polygon points="88,12 98,12 96,22 88,30" fill="#a8b4d0" stroke="#000" strokeWidth="0.8"
               transform="rotate(18,92.5,52)" />
      {/* pauldrons — colossal with crystals embedded */}
      <Path d="M 0 50 Q -2 24 22 20 L 38 50 L 30 74 L 2 70 Z" fill={`url(#${id}a)`} stroke="#000" strokeWidth="2.8" />
      <Path d="M 100 50 Q 102 24 78 20 L 62 50 L 70 74 L 98 70 Z" fill={`url(#${id}a)`} stroke="#000" strokeWidth="2.8" />
      {/* crystalline pauldron gems */}
      <Polygon points="14,40 8,46 14,52 20,46" fill="#5cf28a" stroke="#000" strokeWidth="1" />
      <Polygon points="86,40 92,46 86,52 80,46" fill="#5cf28a" stroke="#000" strokeWidth="1" />
      <Polygon points="14,40 14,52" stroke="#fff" strokeWidth="0.5" opacity="0.6" />
      <Polygon points="86,40 86,52" stroke="#fff" strokeWidth="0.5" opacity="0.6" />
      {/* multi-spike pauldron tops */}
      <Polygon points="4,32 8,4 12,34" fill="#000" />
      <Polygon points="14,24 18,-2 22,26" fill="#000" />
      <Polygon points="24,18 28,-8 32,22" fill="#000" />
      <Polygon points="96,32 92,4 88,34" fill="#000" />
      <Polygon points="86,24 82,-2 78,26" fill="#000" />
      <Polygon points="76,18 72,-8 68,22" fill="#000" />
      {/* torso — wide and angular */}
      <Path d="M 20 36 L 80 36 L 86 86 L 76 96 L 24 96 L 14 86 Z" fill={`url(#${id}a)`} stroke="#000" strokeWidth="3.2" />
      {/* central core glow on chest */}
      <Circle cx="50" cy="60" r="12" fill="#000" stroke="#000" strokeWidth="2" />
      <Circle cx="50" cy="60" r="9" fill={`url(#${id}g)`} />
      <Polygon points="50,52 44,60 50,68 56,60" fill="#fff" opacity="0.5" />
      {/* glowing seams down the torso */}
      <Path d="M 30 40 L 30 90" stroke="#5cf28a" strokeWidth="1.2" opacity="0.85" />
      <Path d="M 70 40 L 70 90" stroke="#5cf28a" strokeWidth="1.2" opacity="0.85" />
      <Path d="M 25 70 L 75 70" stroke="#5cf28a" strokeWidth="1" opacity="0.7" />
      {/* helmet — angular crystal crown */}
      <Path d="M 20 38 L 28 8 L 72 8 L 80 38 Z" fill={`url(#${id}a)`} stroke="#000" strokeWidth="3" />
      {/* crystal crown spikes */}
      <Polygon points="28,8 26,-12 36,4" fill="#5cf28a" stroke="#000" strokeWidth="1" />
      <Polygon points="42,4 40,-14 48,2" fill="#5cf28a" stroke="#000" strokeWidth="1" />
      <Polygon points="50,2 47,-16 53,-16" fill="#5cf28a" stroke="#000" strokeWidth="1" />
      <Polygon points="58,4 60,-14 52,2" fill="#5cf28a" stroke="#000" strokeWidth="1" />
      <Polygon points="72,8 74,-12 64,4" fill="#5cf28a" stroke="#000" strokeWidth="1" />
      {/* visor — wide with green glow + 4 sensor lenses */}
      <Rect x="22" y="20" width="56" height="12" fill="#000" />
      <Rect x="26" y="22" width="48" height="3" fill="#5cf28a" />
      <Circle cx="34" cy="27" r="2.2" fill="#5cf28a" stroke="#fff" strokeWidth="0.5" />
      <Circle cx="44" cy="27" r="1.5" fill="#5cf28a" stroke="#fff" strokeWidth="0.4" />
      <Circle cx="56" cy="27" r="1.5" fill="#5cf28a" stroke="#fff" strokeWidth="0.4" />
      <Circle cx="66" cy="27" r="2.2" fill="#5cf28a" stroke="#fff" strokeWidth="0.5" />
      {/* gold trim */}
      <Path d="M 22 35 Q 50 33 78 35 L 78 38 Q 50 36 22 38 Z" fill="#ffd166" stroke="#000" strokeWidth="0.8" />
      {/* rivets */}
      <Circle cx="26" cy="48" r="2.2" fill="#000" />
      <Circle cx="74" cy="48" r="2.2" fill="#000" />
      <Circle cx="30" cy="88" r="2.2" fill="#000" />
      <Circle cx="70" cy="88" r="2.2" fill="#000" />
    </Svg>
  );
});

// Apex Swarm — Worldeater Larva. Segmented worm form, multiple maws, tentacles.
const ApexSwarmSvg = React.memo(function ApexSwarmSvg({ size, burning }) {
  const id = useRef(nextGid()).current;
  const b1 = burning ? '#a8f8c8' : '#5a3050';
  const b2 = burning ? '#2e8c50' : '#0e0418';
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100">
      <Defs>
        <RadialGradient id={`${id}b`} cx="0.4" cy="0.35" r="0.65">
          <Stop offset="0" stopColor={b1} />
          <Stop offset="1" stopColor={b2} />
        </RadialGradient>
        <RadialGradient id={`${id}o`} cx="0.5" cy="0.5" r="0.5">
          <Stop offset="0" stopColor="#fff" />
          <Stop offset="0.4" stopColor="#ffd166" />
          <Stop offset="1" stopColor="#a05000" />
        </RadialGradient>
      </Defs>
      <Ellipse cx="50" cy="92" rx="36" ry="4.5" fill="#000" opacity="0.7" />
      {/* writhing tentacles outside body */}
      <Path d="M 14 50 Q 0 36 4 22 Q 12 32 16 42" stroke={b2} strokeWidth="4" fill="none" strokeLinecap="round" />
      <Path d="M 18 70 Q 0 76 -2 88 Q 10 84 18 80" stroke={b2} strokeWidth="4" fill="none" strokeLinecap="round" />
      <Path d="M 86 50 Q 100 36 96 22 Q 88 32 84 42" stroke={b2} strokeWidth="4" fill="none" strokeLinecap="round" />
      <Path d="M 82 70 Q 100 76 102 88 Q 90 84 82 80" stroke={b2} strokeWidth="4" fill="none" strokeLinecap="round" />
      {/* tentacle tips with suckers */}
      <Circle cx="4" cy="22" r="2.5" fill={b2} stroke="#000" strokeWidth="0.6" />
      <Circle cx="-2" cy="88" r="2.5" fill={b2} stroke="#000" strokeWidth="0.6" />
      <Circle cx="96" cy="22" r="2.5" fill={b2} stroke="#000" strokeWidth="0.6" />
      <Circle cx="102" cy="88" r="2.5" fill={b2} stroke="#000" strokeWidth="0.6" />
      {/* main body — wider, ovoid larva */}
      <Ellipse cx="50" cy="55" rx="36" ry="30" fill={`url(#${id}b)`} stroke="#000" strokeWidth="3" />
      {/* glowing yellow innards visible through translucent segments */}
      <Ellipse cx="50" cy="68" rx="20" ry="6" fill="#ffd166" opacity="0.55" />
      <Ellipse cx="50" cy="58" rx="14" ry="4" fill="#ffd166" opacity="0.4" />
      {/* segmented carapace lines */}
      <Path d="M 18 45 Q 50 52 82 45" stroke="#000" strokeWidth="1.5" fill="none" opacity="0.85" />
      <Path d="M 16 56 Q 50 64 84 56" stroke="#000" strokeWidth="1.5" fill="none" opacity="0.8" />
      <Path d="M 18 67 Q 50 74 82 67" stroke="#000" strokeWidth="1.5" fill="none" opacity="0.75" />
      <Path d="M 22 78 Q 50 82 78 78" stroke="#000" strokeWidth="1.5" fill="none" opacity="0.7" />
      {/* secondary maws on the sides */}
      <Ellipse cx="22" cy="55" rx="6" ry="4" fill="#0a0008" stroke="#000" strokeWidth="1" />
      <Polygon points="18,55 22,52 26,55 22,58" fill="#fff" />
      <Polygon points="18,55 26,55 22,58" fill="#0a0008" />
      <Ellipse cx="78" cy="55" rx="6" ry="4" fill="#0a0008" stroke="#000" strokeWidth="1" />
      <Polygon points="74,55 78,52 82,55 78,58" fill="#fff" />
      <Polygon points="74,55 82,55 78,58" fill="#0a0008" />
      {/* spines along back */}
      <Polygon points="30,32 32,18 36,32" fill="#0a0008" />
      <Polygon points="42,28 44,12 48,28" fill="#0a0008" />
      <Polygon points="52,28 54,12 56,28" fill="#0a0008" />
      <Polygon points="62,28 64,12 66,28" fill="#0a0008" />
      <Polygon points="68,32 64,32 72,18" fill="#0a0008" />
      {/* acid drip from multiple points */}
      <Circle cx="22" cy="62" r="1.5" fill="#5cf28a" />
      <Circle cx="78" cy="62" r="1.5" fill="#5cf28a" />
      <Path d="M 22 62 L 22 70" stroke="#5cf28a" strokeWidth="1" />
      <Path d="M 78 62 L 78 70" stroke="#5cf28a" strokeWidth="1" />
      {/* huge gaping main maw */}
      <Path d="M 28 76 Q 50 96 72 76 Q 60 84 50 84 Q 40 84 28 76 Z" fill="#0a0008" stroke="#000" strokeWidth="1.5" />
      <Polygon points="32,76 36,90 40,76" fill="#fff" />
      <Polygon points="42,78 45,92 48,78" fill="#fff" />
      <Polygon points="52,78 55,92 58,78" fill="#fff" />
      <Polygon points="60,76 64,90 68,76" fill="#fff" />
      {/* drooling tongue */}
      <Path d="M 46 84 Q 50 94 54 84" fill="#5cf28a" stroke="#000" strokeWidth="0.8" />
      {/* compound eye — 6 eyes arranged like a cluster */}
      <Circle cx="50" cy="48" r="14" fill="#000" stroke="#000" strokeWidth="1.5" />
      <Circle cx="44" cy="44" r="3.5" fill={`url(#${id}o)`} />
      <Circle cx="56" cy="44" r="3.5" fill={`url(#${id}o)`} />
      <Circle cx="50" cy="40" r="3" fill={`url(#${id}o)`} />
      <Circle cx="44" cy="52" r="3" fill={`url(#${id}o)`} />
      <Circle cx="56" cy="52" r="3" fill={`url(#${id}o)`} />
      <Circle cx="50" cy="54" r="3" fill={`url(#${id}o)`} />
      <Circle cx="44" cy="44" r="1.2" fill="#000" />
      <Circle cx="56" cy="44" r="1.2" fill="#000" />
    </Svg>
  );
});

// ───── Champion Flyer (waves 21+) — fills the gap from previous batch ──────

// Champion Flyer — Nightwing. Skull face, larger jagged wings, tail with hook.
const ChampionFlyerSvg = React.memo(function ChampionFlyerSvg({ size, burning, flap }) {
  const id = useRef(nextGid()).current;
  const c1 = burning ? '#a8f8c8' : '#1a3020';
  const c2 = burning ? '#2e8c50' : '#000';
  const wing = (flap || 0) * 18;
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100">
      <Defs>
        <LinearGradient id={`${id}b`} x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={c1} />
          <Stop offset="1" stopColor={c2} />
        </LinearGradient>
      </Defs>
      <Ellipse cx="50" cy="92" rx="22" ry="3" fill="#000" opacity="0.45" />
      {/* huge tattered wings — left */}
      <G rotation={-wing} originX="35" originY="40">
        <Path d="M 35 40 Q -6 18 -8 60 Q 10 48 22 54 Q 0 60 4 74 Q 18 64 28 60 Q 12 72 18 84 Q 28 70 35 62 Z"
              fill={c2} stroke="#000" strokeWidth="1.8" />
        <Path d="M 12 30 L 26 50" stroke="#000" strokeWidth="1.2" />
        <Path d="M -4 52 L 22 58" stroke="#000" strokeWidth="1.2" />
        <Path d="M 4 70 L 26 62" stroke="#000" strokeWidth="1.2" />
        <Path d="M 16 80 L 28 64" stroke="#000" strokeWidth="1.2" />
        {/* claws on wing tips */}
        <Polygon points="-8,60 -12,54 -4,58" fill="#a8b4d0" stroke="#000" strokeWidth="0.5" />
        <Polygon points="4,74 0,82 8,76" fill="#a8b4d0" stroke="#000" strokeWidth="0.5" />
      </G>
      {/* huge tattered wings — right */}
      <G rotation={wing} originX="65" originY="40">
        <Path d="M 65 40 Q 106 18 108 60 Q 90 48 78 54 Q 100 60 96 74 Q 82 64 72 60 Q 88 72 82 84 Q 72 70 65 62 Z"
              fill={c2} stroke="#000" strokeWidth="1.8" />
        <Path d="M 88 30 L 74 50" stroke="#000" strokeWidth="1.2" />
        <Path d="M 104 52 L 78 58" stroke="#000" strokeWidth="1.2" />
        <Path d="M 96 70 L 74 62" stroke="#000" strokeWidth="1.2" />
        <Path d="M 84 80 L 72 64" stroke="#000" strokeWidth="1.2" />
        <Polygon points="108,60 112,54 104,58" fill="#a8b4d0" stroke="#000" strokeWidth="0.5" />
        <Polygon points="96,74 100,82 92,76" fill="#a8b4d0" stroke="#000" strokeWidth="0.5" />
      </G>
      {/* tail with hooked end */}
      <Path d="M 50 78 Q 56 92 50 100" stroke={c2} strokeWidth="3" fill="none" />
      <Path d="M 50 100 Q 46 102 44 96" stroke={c2} strokeWidth="2.5" fill="none" />
      <Polygon points="44,96 40,98 46,92" fill="#a8b4d0" stroke="#000" strokeWidth="0.6" />
      {/* body — skull-faced */}
      <Ellipse cx="50" cy="48" rx="22" ry="26" fill={`url(#${id}b)`} stroke="#000" strokeWidth="2.2" />
      {/* skull mask on face */}
      <Ellipse cx="50" cy="44" rx="16" ry="18" fill="#e8e0c8" stroke="#000" strokeWidth="1.2" />
      {/* skull cracks */}
      <Path d="M 42 32 L 46 42" stroke="#000" strokeWidth="0.8" fill="none" />
      <Path d="M 58 30 L 56 38" stroke="#000" strokeWidth="0.8" fill="none" />
      {/* devil/bat ears */}
      <Polygon points="34,28 26,4 44,24" fill={c2} stroke="#000" strokeWidth="1.2" />
      <Polygon points="66,28 74,4 56,24" fill={c2} stroke="#000" strokeWidth="1.2" />
      {/* eye sockets — empty black with red glow inside */}
      <Ellipse cx="42" cy="44" rx="5" ry="6" fill="#0a0000" />
      <Ellipse cx="58" cy="44" rx="5" ry="6" fill="#0a0000" />
      <Circle cx="42" cy="44" r="2.5" fill="#ff4d6d" />
      <Circle cx="58" cy="44" r="2.5" fill="#ff4d6d" />
      <Circle cx="42" cy="44" r="0.8" fill="#fff" />
      <Circle cx="58" cy="44" r="0.8" fill="#fff" />
      {/* nose hole */}
      <Polygon points="50,52 47,58 53,58" fill="#0a0000" />
      {/* fanged grin */}
      <Rect x="40" y="60" width="20" height="5" fill="#e8e0c8" stroke="#000" strokeWidth="0.8" />
      <Line x1="44" y1="60" x2="44" y2="65" stroke="#000" strokeWidth="0.7" />
      <Line x1="48" y1="60" x2="48" y2="65" stroke="#000" strokeWidth="0.7" />
      <Line x1="52" y1="60" x2="52" y2="65" stroke="#000" strokeWidth="0.7" />
      <Line x1="56" y1="60" x2="56" y2="65" stroke="#000" strokeWidth="0.7" />
    </Svg>
  );
});

// ───── Destroyer boss (wave 40) — apocalyptic war engine ────────────────────

const DestroyerBossSvg = React.memo(function DestroyerBossSvg({ size, burning }) {
  const id = useRef(nextGid()).current;
  const b1 = burning ? '#a8f8c8' : '#3a2a40';
  const b2 = burning ? '#2e8c50' : '#0a0410';
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100">
      <Defs>
        <LinearGradient id={`${id}b`} x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={b1} />
          <Stop offset="1" stopColor={b2} />
        </LinearGradient>
        <RadialGradient id={`${id}core`} cx="0.5" cy="0.5" r="0.5">
          <Stop offset="0" stopColor="#fff" />
          <Stop offset="0.3" stopColor="#ffd166" />
          <Stop offset="0.7" stopColor="#ff6f1f" />
          <Stop offset="1" stopColor="#5a1a00" />
        </RadialGradient>
        <RadialGradient id={`${id}eye`} cx="0.5" cy="0.5" r="0.5">
          <Stop offset="0" stopColor="#fff" />
          <Stop offset="0.4" stopColor="#ff6f1f" />
          <Stop offset="1" stopColor="#3a0a00" />
        </RadialGradient>
        <RadialGradient id={`${id}aura`} cx="0.5" cy="0.5" r="0.5">
          <Stop offset="0" stopColor="#ff6f1f" opacity="0.5" />
          <Stop offset="1" stopColor="#ff6f1f" opacity="0" />
        </RadialGradient>
      </Defs>
      {/* ember aura under the engine */}
      <Ellipse cx="50" cy="94" rx="48" ry="7" fill={`url(#${id}aura)`} />
      <Ellipse cx="50" cy="96" rx="42" ry="4" fill="#3a0a00" opacity="0.85" />
      {/* embers floating */}
      <Circle cx="14" cy="78" r="1.5" fill="#ff6f1f" opacity="0.85" />
      <Circle cx="86" cy="78" r="1.5" fill="#ff6f1f" opacity="0.85" />
      <Circle cx="8" cy="60" r="1.2" fill="#ffd166" opacity="0.7" />
      <Circle cx="92" cy="60" r="1.2" fill="#ffd166" opacity="0.7" />
      <Circle cx="20" cy="40" r="1" fill="#ffd166" opacity="0.6" />
      <Circle cx="80" cy="40" r="1" fill="#ffd166" opacity="0.6" />
      {/* hulking shoulder armor with smokestacks */}
      <Path d="M 6 56 Q 4 30 22 26 L 32 54 L 28 70 L 8 66 Z" fill={`url(#${id}b)`} stroke="#000" strokeWidth="2.5" />
      <Path d="M 94 56 Q 96 30 78 26 L 68 54 L 72 70 L 92 66 Z" fill={`url(#${id}b)`} stroke="#000" strokeWidth="2.5" />
      {/* smokestacks */}
      <Rect x="10" y="14" width="8" height="20" fill="#1a1424" stroke="#000" strokeWidth="1.2" />
      <Rect x="9" y="12" width="10" height="3" fill="#000" />
      <Ellipse cx="14" cy="10" rx="6" ry="2" fill="#1a1424" opacity="0.85" />
      <Ellipse cx="14" cy="4" rx="9" ry="3" fill="#3a3030" opacity="0.55" />
      <Rect x="82" y="14" width="8" height="20" fill="#1a1424" stroke="#000" strokeWidth="1.2" />
      <Rect x="81" y="12" width="10" height="3" fill="#000" />
      <Ellipse cx="86" cy="10" rx="6" ry="2" fill="#1a1424" opacity="0.85" />
      <Ellipse cx="86" cy="4" rx="9" ry="3" fill="#3a3030" opacity="0.55" />
      {/* shoulder spikes */}
      <Polygon points="2,42 -2,34 10,38" fill="#000" />
      <Polygon points="98,42 102,34 90,38" fill="#000" />
      {/* central armored body */}
      <Path d="M 18 32 L 82 32 L 88 86 L 78 96 L 22 96 L 12 86 Z" fill={`url(#${id}b)`} stroke="#000" strokeWidth="3.2" />
      {/* head — angular reinforced helmet (no separate head, the visor is built into the body) */}
      <Path d="M 22 30 L 30 14 L 70 14 L 78 30 Z" fill={`url(#${id}b)`} stroke="#000" strokeWidth="2.8" />
      <Polygon points="50,14 47,2 53,2" fill="#000" />
      <Polygon points="36,14 34,4 40,12" fill="#000" />
      <Polygon points="64,14 66,4 60,12" fill="#000" />
      {/* visor housing 4 lensed compound eyes */}
      <Rect x="24" y="20" width="52" height="10" fill="#000" />
      <Circle cx="34" cy="25" r="3.5" fill={`url(#${id}eye)`} stroke="#fff" strokeWidth="0.5" />
      <Circle cx="44" cy="25" r="2.8" fill={`url(#${id}eye)`} stroke="#fff" strokeWidth="0.4" />
      <Circle cx="56" cy="25" r="2.8" fill={`url(#${id}eye)`} stroke="#fff" strokeWidth="0.4" />
      <Circle cx="66" cy="25" r="3.5" fill={`url(#${id}eye)`} stroke="#fff" strokeWidth="0.5" />
      {/* gold trim band */}
      <Path d="M 22 31 Q 50 30 78 31 L 78 34 Q 50 32 22 34 Z" fill="#ffd166" stroke="#000" strokeWidth="0.8" />
      {/* chest plate with massive glowing core */}
      <Path d="M 30 38 L 70 38 L 72 78 L 28 78 Z" fill="#1a1424" stroke="#000" strokeWidth="2" />
      <Circle cx="50" cy="58" r="15" fill="#000" stroke="#000" strokeWidth="2.5" />
      <Circle cx="50" cy="58" r="12" fill={`url(#${id}core)`} />
      <Polygon points="50,46 42,58 50,70 58,58" fill="#fff" opacity="0.55" />
      {/* exhaust vents emitting ember glow */}
      <Rect x="32" y="80" width="6" height="3" fill="#000" />
      <Rect x="33" y="81" width="4" height="1" fill="#ff6f1f" />
      <Rect x="46" y="80" width="8" height="3" fill="#000" />
      <Rect x="47" y="81" width="6" height="1" fill="#ff6f1f" />
      <Rect x="62" y="80" width="6" height="3" fill="#000" />
      <Rect x="63" y="81" width="4" height="1" fill="#ff6f1f" />
      {/* heavy plating seams */}
      <Path d="M 24 40 L 24 90" stroke="#000" strokeWidth="1.5" />
      <Path d="M 76 40 L 76 90" stroke="#000" strokeWidth="1.5" />
      <Path d="M 50 38 L 50 50" stroke="#000" strokeWidth="1.5" />
      {/* chain hanging across chest */}
      <Path d="M 24 42 Q 50 56 76 42" stroke="#7a6a3a" strokeWidth="1.5" fill="none" />
      <Circle cx="32" cy="46" r="1.5" fill="#7a6a3a" stroke="#000" strokeWidth="0.4" />
      <Circle cx="40" cy="50" r="1.5" fill="#7a6a3a" stroke="#000" strokeWidth="0.4" />
      <Circle cx="60" cy="50" r="1.5" fill="#7a6a3a" stroke="#000" strokeWidth="0.4" />
      <Circle cx="68" cy="46" r="1.5" fill="#7a6a3a" stroke="#000" strokeWidth="0.4" />
      {/* rivets */}
      <Circle cx="28" cy="46" r="2" fill="#000" />
      <Circle cx="72" cy="46" r="2" fill="#000" />
      <Circle cx="30" cy="86" r="2" fill="#000" />
      <Circle cx="70" cy="86" r="2" fill="#000" />
      {/* battle damage cracks with ember glow inside */}
      <Path d="M 38 80 L 34 86 L 38 90" stroke="#000" strokeWidth="1.5" fill="none" />
      <Path d="M 38 80 L 34 86 L 38 90" stroke="#ff6f1f" strokeWidth="0.6" fill="none" opacity="0.85" />
      <Path d="M 64 70 L 70 78" stroke="#000" strokeWidth="1.5" />
      <Path d="M 64 70 L 70 78" stroke="#ff6f1f" strokeWidth="0.6" opacity="0.85" />
    </Svg>
  );
});

// ───── Mythic variants (waves 41+) — eldritch, divine corruption ────────────

// Mythic Grunt — Herald of Ruin. Floating, gold-broken halo, event-horizon eye.
const MythicGruntSvg = React.memo(function MythicGruntSvg({ size, burning }) {
  const id = useRef(nextGid()).current;
  const body1 = burning ? '#a8f8c8' : '#1a0a2a';
  const body2 = burning ? '#2e8c50' : '#000';
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100">
      <Defs>
        <LinearGradient id={`${id}b`} x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={body1} />
          <Stop offset="1" stopColor={body2} />
        </LinearGradient>
        <RadialGradient id={`${id}h`} cx="0.5" cy="0.5" r="0.5">
          <Stop offset="0" stopColor="#000" />
          <Stop offset="0.6" stopColor="#5a0050" />
          <Stop offset="0.9" stopColor="#ff6f1f" />
          <Stop offset="1" stopColor="#ffd166" />
        </RadialGradient>
        <RadialGradient id={`${id}aura`} cx="0.5" cy="0.5" r="0.5">
          <Stop offset="0" stopColor="#ffd166" opacity="0.55" />
          <Stop offset="1" stopColor="#ffd166" opacity="0" />
        </RadialGradient>
      </Defs>
      {/* divine aura */}
      <Circle cx="50" cy="48" r="50" fill={`url(#${id}aura)`} />
      {/* broken golden halo behind head */}
      <Circle cx="50" cy="32" r="32" fill="none" stroke="#ffd166" strokeWidth="3" opacity="0.85" />
      <Circle cx="50" cy="32" r="32" fill="none" stroke="#fff" strokeWidth="1" opacity="0.6"
              strokeDasharray="6 4" />
      {/* halo cracks */}
      <Path d="M 30 18 L 22 4" stroke="#ffd166" strokeWidth="2" opacity="0.8" />
      <Path d="M 70 18 L 78 4" stroke="#ffd166" strokeWidth="2" opacity="0.8" />
      <Path d="M 18 36 L 6 30" stroke="#ffd166" strokeWidth="2" opacity="0.7" />
      <Path d="M 82 36 L 94 30" stroke="#ffd166" strokeWidth="2" opacity="0.7" />
      {/* floating — no ground shadow, replaced by levitation glow */}
      <Ellipse cx="50" cy="96" rx="22" ry="3" fill="#ffd166" opacity="0.35" />
      {/* three orbiting smaller heads — small skull motifs */}
      <Circle cx="18" cy="60" r="4" fill="#e8e0c8" stroke="#000" strokeWidth="0.8" />
      <Circle cx="17" cy="59" r="0.6" fill="#ff6f1f" />
      <Circle cx="19" cy="59" r="0.6" fill="#ff6f1f" />
      <Circle cx="82" cy="60" r="4" fill="#e8e0c8" stroke="#000" strokeWidth="0.8" />
      <Circle cx="81" cy="59" r="0.6" fill="#ff6f1f" />
      <Circle cx="83" cy="59" r="0.6" fill="#ff6f1f" />
      <Circle cx="50" cy="92" r="4" fill="#e8e0c8" stroke="#000" strokeWidth="0.8" />
      <Circle cx="49" cy="91" r="0.6" fill="#ff6f1f" />
      <Circle cx="51" cy="91" r="0.6" fill="#ff6f1f" />
      {/* central body — robed figure with no defined arms */}
      <Path d="M 28 32 Q 50 22 72 32 L 76 80 Q 70 88 50 86 Q 30 88 24 80 Z"
            fill={`url(#${id}b)`} stroke="#000" strokeWidth="2.8" />
      {/* gold trim on robe edges */}
      <Path d="M 28 32 Q 50 22 72 32" stroke="#ffd166" strokeWidth="1.8" fill="none" />
      <Path d="M 24 80 Q 50 86 76 80" stroke="#ffd166" strokeWidth="1.5" fill="none" />
      {/* divine sigil on chest */}
      <Polygon points="50,52 60,58 56,68 44,68 40,58" fill="none" stroke="#ffd166" strokeWidth="1.5" />
      <Circle cx="50" cy="60" r="2.5" fill="#ffd166" />
      <Path d="M 50 56 L 50 64 M 46 60 L 54 60" stroke="#000" strokeWidth="0.6" />
      {/* event-horizon central eye — black hole with accretion ring */}
      <Circle cx="50" cy="40" r="12" fill={`url(#${id}h)`} />
      <Circle cx="50" cy="40" r="6" fill="#000" />
      <Circle cx="50" cy="40" r="6" fill="none" stroke="#ffd166" strokeWidth="0.6" opacity="0.7" />
      {/* tiny side eyes */}
      <Circle cx="36" cy="34" r="1.8" fill="#ffd166" />
      <Circle cx="36" cy="34" r="0.8" fill="#000" />
      <Circle cx="64" cy="34" r="1.8" fill="#ffd166" />
      <Circle cx="64" cy="34" r="0.8" fill="#000" />
      {/* small flame motes orbiting */}
      <Circle cx="10" cy="48" r="1.5" fill="#ff6f1f" opacity="0.85" />
      <Circle cx="90" cy="48" r="1.5" fill="#ff6f1f" opacity="0.85" />
      <Circle cx="6" cy="70" r="1.2" fill="#ffd166" opacity="0.7" />
      <Circle cx="94" cy="70" r="1.2" fill="#ffd166" opacity="0.7" />
    </Svg>
  );
});

// Mythic Runner — Time-Wraith. Three overlapping ghost shells, hourglass body.
const MythicRunnerSvg = React.memo(function MythicRunnerSvg({ size, burning }) {
  const id = useRef(nextGid()).current;
  const c1 = burning ? '#a8f8c8' : '#4cc9ff';
  const c2 = burning ? '#2e8c50' : '#000';
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100">
      <Defs>
        <LinearGradient id={`${id}c`} x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={c1} />
          <Stop offset="1" stopColor={c2} />
        </LinearGradient>
      </Defs>
      <Ellipse cx="50" cy="94" rx="24" ry="3" fill="#4cc9ff" opacity="0.45" />
      {/* THREE ghost-shell silhouettes phased back */}
      <Path d="M 50 4 L 78 60 L 76 90 L 24 90 L 22 60 Z"
            fill="#4cc9ff" opacity="0.18" transform="translate(-12, 3)" />
      <Path d="M 50 4 L 78 60 L 76 90 L 24 90 L 22 60 Z"
            fill="#4cc9ff" opacity="0.18" transform="translate(12, 3)" />
      <Path d="M 50 4 L 78 60 L 76 90 L 24 90 L 22 60 Z"
            fill="#4cc9ff" opacity="0.25" transform="translate(0, -2)" />
      {/* main cloak — note hourglass cinch at the middle */}
      <Path
        d="M 50 4
           C 60 8 66 18 70 30
           L 76 44
           Q 60 50 60 54
           Q 60 58 76 64
           L 82 88
           L 18 88
           L 24 64
           Q 40 58 40 54
           Q 40 50 24 44
           L 30 30
           C 34 18 40 8 50 4 Z"
        fill={`url(#${id}c)`} stroke="#000" strokeWidth="2.4"
      />
      {/* hourglass detail at the cinch */}
      <Path d="M 40 48 L 60 48 L 50 54 L 60 60 L 40 60 L 50 54 Z" fill="#ffd166" stroke="#000" strokeWidth="1" />
      <Circle cx="50" cy="48" r="1" fill="#fff" />
      <Circle cx="50" cy="60" r="1" fill="#fff" />
      {/* clock-rune marks on cloak */}
      <Circle cx="50" cy="34" r="5" fill="none" stroke="#fff" strokeWidth="1" opacity="0.7" />
      <Path d="M 50 30 L 50 34 L 53 36" stroke="#fff" strokeWidth="0.8" opacity="0.7" />
      <Circle cx="32" cy="76" r="3" fill="none" stroke="#fff" strokeWidth="0.7" opacity="0.55" />
      <Circle cx="68" cy="76" r="3" fill="none" stroke="#fff" strokeWidth="0.7" opacity="0.55" />
      {/* iron hood trim */}
      <Path d="M 32 30 C 38 22 44 18 50 18 C 56 18 62 22 68 30" stroke="#fff" strokeWidth="2.2" fill="none" />
      {/* deep hood */}
      <Path d="M 32 30 C 38 22 44 18 50 18 C 56 18 62 22 68 30 L 64 44 L 36 44 Z" fill="#000" />
      {/* three eye slits */}
      <Path d="M 36 36 L 44 32 L 44 38 L 36 40 Z" fill="#4cc9ff" />
      <Path d="M 64 36 L 56 32 L 56 38 L 64 40 Z" fill="#4cc9ff" />
      <Circle cx="50" cy="34" r="2" fill="#fff" />
      <Circle cx="50" cy="34" r="1" fill="#4cc9ff" />
      {/* drifting time-particles */}
      <Circle cx="14" cy="60" r="1.5" fill="#4cc9ff" opacity="0.7" />
      <Circle cx="86" cy="60" r="1.5" fill="#4cc9ff" opacity="0.7" />
      <Circle cx="10" cy="44" r="1" fill="#fff" opacity="0.5" />
      <Circle cx="90" cy="44" r="1" fill="#fff" opacity="0.5" />
    </Svg>
  );
});

// Mythic Tank — Iron God on Throne. Throne base, 9-spike crown, orbiting orbs.
const MythicTankSvg = React.memo(function MythicTankSvg({ size, burning }) {
  const id = useRef(nextGid()).current;
  const a1 = burning ? '#a8f8c8' : '#4a4060';
  const a2 = burning ? '#2e8c50' : '#0a0410';
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100">
      <Defs>
        <LinearGradient id={`${id}a`} x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={a1} />
          <Stop offset="1" stopColor={a2} />
        </LinearGradient>
        <RadialGradient id={`${id}eye`} cx="0.5" cy="0.5" r="0.5">
          <Stop offset="0" stopColor="#fff" />
          <Stop offset="0.3" stopColor="#ffd166" />
          <Stop offset="0.8" stopColor="#ff6f1f" />
          <Stop offset="1" stopColor="#3a0a00" />
        </RadialGradient>
      </Defs>
      <Ellipse cx="50" cy="97" rx="48" ry="5" fill="#000" opacity="0.85" />
      {/* throne backrest behind */}
      <Path d="M 6 60 L 6 8 L 18 0 L 38 0 L 30 14 L 30 90 L 6 90 Z" fill="#1a1424" stroke="#000" strokeWidth="1.5" />
      <Path d="M 94 60 L 94 8 L 82 0 L 62 0 L 70 14 L 70 90 L 94 90 Z" fill="#1a1424" stroke="#000" strokeWidth="1.5" />
      {/* throne crystals on backrest */}
      <Polygon points="14,12 10,20 18,20" fill="#ffd166" stroke="#000" strokeWidth="0.6" />
      <Polygon points="86,12 90,20 82,20" fill="#ffd166" stroke="#000" strokeWidth="0.6" />
      {/* gold trim along throne */}
      <Path d="M 6 8 L 18 0 L 38 0 L 30 14" stroke="#ffd166" strokeWidth="1.5" fill="none" />
      <Path d="M 94 8 L 82 0 L 62 0 L 70 14" stroke="#ffd166" strokeWidth="1.5" fill="none" />
      {/* main body — broader, throne-anchored */}
      <Path d="M 22 36 L 78 36 L 84 90 L 16 90 Z" fill={`url(#${id}a)`} stroke="#000" strokeWidth="3" />
      {/* pauldrons with crystal embeds */}
      <Path d="M 0 50 Q -2 26 22 22 L 36 50 L 28 72 L 4 68 Z" fill={`url(#${id}a)`} stroke="#000" strokeWidth="2.5" />
      <Path d="M 100 50 Q 102 26 78 22 L 64 50 L 72 72 L 96 68 Z" fill={`url(#${id}a)`} stroke="#000" strokeWidth="2.5" />
      <Polygon points="14,42 8,50 14,58 20,50" fill="#ffd166" stroke="#000" strokeWidth="1" />
      <Polygon points="86,42 92,50 86,58 80,50" fill="#ffd166" stroke="#000" strokeWidth="1" />
      <Path d="M 14 42 L 14 58 M 8 50 L 20 50" stroke="#fff" strokeWidth="0.5" opacity="0.6" />
      <Path d="M 86 42 L 86 58 M 80 50 L 92 50" stroke="#fff" strokeWidth="0.5" opacity="0.6" />
      {/* chest plate with cosmic sigil */}
      <Path d="M 30 42 L 70 42 L 72 82 L 28 82 Z" fill="#1a1424" stroke="#000" strokeWidth="2" />
      <Path d="M 36 50 L 64 50 L 60 76 L 40 76 Z" fill="none" stroke="#ffd166" strokeWidth="1.5" />
      <Polygon points="50,52 55,60 50,68 45,60" fill="#ffd166" />
      <Circle cx="50" cy="60" r="1.5" fill="#000" />
      <Path d="M 36 60 L 64 60" stroke="#ffd166" strokeWidth="0.8" opacity="0.7" />
      {/* helmet with 9 spike crown */}
      <Path d="M 22 38 L 28 10 L 72 10 L 78 38 Z" fill={`url(#${id}a)`} stroke="#000" strokeWidth="3" />
      <Polygon points="28,10 26,-2 32,8" fill="#ffd166" stroke="#000" strokeWidth="0.8" />
      <Polygon points="34,8 32,-6 38,4" fill="#ffd166" stroke="#000" strokeWidth="0.8" />
      <Polygon points="40,4 38,-10 44,0" fill="#ffd166" stroke="#000" strokeWidth="0.8" />
      <Polygon points="46,2 44,-14 50,-4" fill="#ffd166" stroke="#000" strokeWidth="0.8" />
      <Polygon points="50,-4 48,-16 52,-16 54,-4" fill="#ffd166" stroke="#000" strokeWidth="0.8" />
      <Polygon points="54,2 56,-14 50,-4" fill="#ffd166" stroke="#000" strokeWidth="0.8" />
      <Polygon points="60,4 62,-10 56,0" fill="#ffd166" stroke="#000" strokeWidth="0.8" />
      <Polygon points="66,8 68,-6 62,4" fill="#ffd166" stroke="#000" strokeWidth="0.8" />
      <Polygon points="72,10 74,-2 68,8" fill="#ffd166" stroke="#000" strokeWidth="0.8" />
      {/* cyclops eye (single huge) */}
      <Ellipse cx="50" cy="26" rx="14" ry="7" fill="#000" stroke="#000" strokeWidth="1.5" />
      <Circle cx="50" cy="26" r="6" fill={`url(#${id}eye)`} />
      <Ellipse cx="50" cy="26" rx="2" ry="5" fill="#000" />
      {/* gold trim on helmet */}
      <Path d="M 22 35 Q 50 33 78 35 L 78 38 Q 50 36 22 38 Z" fill="#ffd166" stroke="#000" strokeWidth="0.8" />
      {/* 6 orbiting orbs */}
      <Circle cx="8" cy="34" r="2.5" fill="#ffd166" stroke="#000" strokeWidth="0.8" />
      <Circle cx="92" cy="34" r="2.5" fill="#ffd166" stroke="#000" strokeWidth="0.8" />
      <Circle cx="4" cy="60" r="2" fill="#ffd166" stroke="#000" strokeWidth="0.8" />
      <Circle cx="96" cy="60" r="2" fill="#ffd166" stroke="#000" strokeWidth="0.8" />
      <Circle cx="8" cy="80" r="2.5" fill="#ffd166" stroke="#000" strokeWidth="0.8" />
      <Circle cx="92" cy="80" r="2.5" fill="#ffd166" stroke="#000" strokeWidth="0.8" />
      <Circle cx="8" cy="34" r="1" fill="#fff" />
      <Circle cx="92" cy="34" r="1" fill="#fff" />
    </Svg>
  );
});

// Mythic Swarm — Cosmic Brood. Body is a starfield, multiple eyes, void tears.
const MythicSwarmSvg = React.memo(function MythicSwarmSvg({ size, burning }) {
  const id = useRef(nextGid()).current;
  const b1 = burning ? '#a8f8c8' : '#1a0a3a';
  const b2 = burning ? '#2e8c50' : '#000';
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100">
      <Defs>
        <RadialGradient id={`${id}b`} cx="0.4" cy="0.35" r="0.65">
          <Stop offset="0" stopColor={b1} />
          <Stop offset="1" stopColor={b2} />
        </RadialGradient>
        <RadialGradient id={`${id}o`} cx="0.5" cy="0.5" r="0.5">
          <Stop offset="0" stopColor="#fff" />
          <Stop offset="0.4" stopColor="#4cc9ff" />
          <Stop offset="1" stopColor="#0a1a3a" />
        </RadialGradient>
      </Defs>
      <Ellipse cx="50" cy="92" rx="38" ry="4.5" fill="#4cc9ff" opacity="0.3" />
      {/* writhing tentacles */}
      <Path d="M 14 50 Q -2 30 4 12 Q 14 24 18 40" stroke={b2} strokeWidth="4" fill="none" strokeLinecap="round" />
      <Path d="M 18 70 Q -2 76 -4 92 Q 12 86 20 80" stroke={b2} strokeWidth="4" fill="none" strokeLinecap="round" />
      <Path d="M 86 50 Q 102 30 96 12 Q 86 24 82 40" stroke={b2} strokeWidth="4" fill="none" strokeLinecap="round" />
      <Path d="M 82 70 Q 102 76 104 92 Q 88 86 80 80" stroke={b2} strokeWidth="4" fill="none" strokeLinecap="round" />
      {/* tentacle tips */}
      <Circle cx="4" cy="12" r="2.5" fill="#4cc9ff" opacity="0.7" />
      <Circle cx="-4" cy="92" r="2.5" fill="#4cc9ff" opacity="0.7" />
      <Circle cx="96" cy="12" r="2.5" fill="#4cc9ff" opacity="0.7" />
      <Circle cx="104" cy="92" r="2.5" fill="#4cc9ff" opacity="0.7" />
      {/* body — starfield interior */}
      <Ellipse cx="50" cy="55" rx="36" ry="30" fill={`url(#${id}b)`} stroke="#fff" strokeWidth="2" opacity="0.95" />
      {/* stars inside body */}
      <Circle cx="32" cy="42" r="1" fill="#fff" />
      <Circle cx="42" cy="48" r="0.7" fill="#fff" />
      <Circle cx="60" cy="46" r="0.8" fill="#fff" />
      <Circle cx="68" cy="42" r="1.1" fill="#fff" />
      <Circle cx="30" cy="60" r="0.7" fill="#fff" />
      <Circle cx="40" cy="68" r="0.9" fill="#fff" />
      <Circle cx="58" cy="68" r="0.8" fill="#fff" />
      <Circle cx="70" cy="60" r="1" fill="#fff" />
      <Circle cx="22" cy="50" r="0.7" fill="#4cc9ff" />
      <Circle cx="78" cy="50" r="0.7" fill="#4cc9ff" />
      <Circle cx="50" cy="76" r="0.8" fill="#fff" />
      {/* nebula swirls */}
      <Path d="M 28 52 Q 36 48 32 60" stroke="#4cc9ff" strokeWidth="1" fill="none" opacity="0.6" />
      <Path d="M 72 52 Q 64 48 68 60" stroke="#9e7afc" strokeWidth="1" fill="none" opacity="0.6" />
      {/* void tear lines around body */}
      <Path d="M 86 30 L 96 24" stroke="#fff" strokeWidth="1.5" opacity="0.7" />
      <Path d="M 14 30 L 4 24" stroke="#fff" strokeWidth="1.5" opacity="0.7" />
      <Path d="M 50 14 L 50 4" stroke="#fff" strokeWidth="1.5" opacity="0.7" />
      <Polygon points="86,30 96,24 92,30" fill="#fff" opacity="0.4" />
      <Polygon points="14,30 4,24 8,30" fill="#fff" opacity="0.4" />
      <Polygon points="50,14 50,4 53,10" fill="#fff" opacity="0.4" />
      {/* nine eyes scattered across body */}
      <Circle cx="36" cy="38" r="3" fill={`url(#${id}o)`} stroke="#fff" strokeWidth="0.5" />
      <Circle cx="64" cy="38" r="3" fill={`url(#${id}o)`} stroke="#fff" strokeWidth="0.5" />
      <Circle cx="22" cy="55" r="2.5" fill={`url(#${id}o)`} stroke="#fff" strokeWidth="0.4" />
      <Circle cx="78" cy="55" r="2.5" fill={`url(#${id}o)`} stroke="#fff" strokeWidth="0.4" />
      <Circle cx="36" cy="70" r="2.5" fill={`url(#${id}o)`} stroke="#fff" strokeWidth="0.4" />
      <Circle cx="64" cy="70" r="2.5" fill={`url(#${id}o)`} stroke="#fff" strokeWidth="0.4" />
      <Circle cx="50" cy="32" r="2.5" fill={`url(#${id}o)`} stroke="#fff" strokeWidth="0.5" />
      <Circle cx="50" cy="78" r="2" fill={`url(#${id}o)`} stroke="#fff" strokeWidth="0.4" />
      {/* central larger eye */}
      <Circle cx="50" cy="55" r="9" fill="#000" stroke="#fff" strokeWidth="1.2" />
      <Circle cx="50" cy="55" r="6" fill={`url(#${id}o)`} />
      <Ellipse cx="50" cy="55" rx="1.5" ry="4" fill="#000" />
      <Circle cx="48" cy="53" r="1" fill="#fff" />
      {/* eye highlights */}
      <Circle cx="36" cy="38" r="0.6" fill="#fff" />
      <Circle cx="64" cy="38" r="0.6" fill="#fff" />
      {/* mouth — black void rip */}
      <Path d="M 30 84 Q 50 96 70 84 Q 60 90 50 90 Q 40 90 30 84 Z" fill="#000" />
      <Path d="M 30 84 Q 50 96 70 84" stroke="#fff" strokeWidth="0.8" fill="none" opacity="0.7" />
    </Svg>
  );
});

// ───── World Ender (wave 50 boss) — the apocalypse incarnate ────────────────

const WorldEnderBossSvg = React.memo(function WorldEnderBossSvg({ size, burning }) {
  const id = useRef(nextGid()).current;
  const b1 = burning ? '#a8f8c8' : '#1a0a3a';
  const b2 = burning ? '#2e8c50' : '#000';
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100">
      <Defs>
        <RadialGradient id={`${id}b`} cx="0.5" cy="0.5" r="0.5">
          <Stop offset="0" stopColor={b1} />
          <Stop offset="1" stopColor={b2} />
        </RadialGradient>
        <RadialGradient id={`${id}eye`} cx="0.5" cy="0.5" r="0.5">
          <Stop offset="0" stopColor="#fff" />
          <Stop offset="0.3" stopColor="#ffd166" />
          <Stop offset="0.7" stopColor="#ff4d6d" />
          <Stop offset="1" stopColor="#3a0050" />
        </RadialGradient>
        <RadialGradient id={`${id}core`} cx="0.5" cy="0.5" r="0.5">
          <Stop offset="0" stopColor="#fff" />
          <Stop offset="0.2" stopColor="#ffd166" />
          <Stop offset="0.5" stopColor="#ff4d6d" />
          <Stop offset="0.8" stopColor="#9e7afc" />
          <Stop offset="1" stopColor="#000" />
        </RadialGradient>
        <RadialGradient id={`${id}aura`} cx="0.5" cy="0.5" r="0.5">
          <Stop offset="0" stopColor="#9e7afc" opacity="0.55" />
          <Stop offset="1" stopColor="#9e7afc" opacity="0" />
        </RadialGradient>
      </Defs>
      {/* cosmic horror aura */}
      <Circle cx="50" cy="50" r="50" fill={`url(#${id}aura)`} />
      <Ellipse cx="50" cy="96" rx="50" ry="6" fill="#3a0050" opacity="0.8" />
      <Ellipse cx="50" cy="96" rx="40" ry="3" fill="#000" opacity="0.95" />
      {/* reality tear marks radiating outward */}
      <Path d="M 50 4 L 50 -4" stroke="#fff" strokeWidth="2" opacity="0.8" />
      <Path d="M 14 12 L 6 4" stroke="#fff" strokeWidth="1.5" opacity="0.7" />
      <Path d="M 86 12 L 94 4" stroke="#fff" strokeWidth="1.5" opacity="0.7" />
      <Path d="M 6 50 L -2 50" stroke="#fff" strokeWidth="1.5" opacity="0.6" />
      <Path d="M 94 50 L 102 50" stroke="#fff" strokeWidth="1.5" opacity="0.6" />
      <Polygon points="50,-4 48,2 52,2" fill="#fff" opacity="0.5" />
      <Polygon points="6,4 12,10 8,12" fill="#fff" opacity="0.5" />
      <Polygon points="94,4 88,10 92,12" fill="#fff" opacity="0.5" />
      {/* eight writhing void tentacles (long) */}
      <Path d="M 18 56 Q -8 42 -4 14 Q 0 38 16 48" stroke={b2} strokeWidth="4.5" fill="none" strokeLinecap="round" />
      <Path d="M 14 76 Q -8 84 -10 100 Q 6 92 20 84" stroke={b2} strokeWidth="4.5" fill="none" strokeLinecap="round" />
      <Path d="M 82 56 Q 108 42 104 14 Q 100 38 84 48" stroke={b2} strokeWidth="4.5" fill="none" strokeLinecap="round" />
      <Path d="M 86 76 Q 108 84 110 100 Q 94 92 80 84" stroke={b2} strokeWidth="4.5" fill="none" strokeLinecap="round" />
      <Path d="M 38 92 Q 30 104 38 110" stroke={b2} strokeWidth="3.5" fill="none" strokeLinecap="round" />
      <Path d="M 62 92 Q 70 104 62 110" stroke={b2} strokeWidth="3.5" fill="none" strokeLinecap="round" />
      <Path d="M 50 92 Q 50 110 54 116" stroke={b2} strokeWidth="3.5" fill="none" strokeLinecap="round" />
      {/* tentacle tip eyes */}
      <Circle cx="-4" cy="14" r="2.5" fill="#ff4d6d" stroke="#000" strokeWidth="0.6" />
      <Circle cx="-10" cy="100" r="2.5" fill="#ff4d6d" stroke="#000" strokeWidth="0.6" />
      <Circle cx="104" cy="14" r="2.5" fill="#ff4d6d" stroke="#000" strokeWidth="0.6" />
      <Circle cx="110" cy="100" r="2.5" fill="#ff4d6d" stroke="#000" strokeWidth="0.6" />
      {/* crown of broken reality shards */}
      <Polygon points="22,22 16,-2 30,16" fill="#fff" opacity="0.85" />
      <Polygon points="34,12 28,-8 42,4" fill="#fff" opacity="0.85" />
      <Polygon points="46,8 42,-12 52,-6" fill="#fff" opacity="0.85" />
      <Polygon points="54,8 50,-12 58,-6" fill="#9e7afc" opacity="0.85" />
      <Polygon points="66,12 58,4 72,-8" fill="#fff" opacity="0.85" />
      <Polygon points="78,22 70,16 84,-2" fill="#fff" opacity="0.85" />
      {/* body — vast cosmic horror */}
      <Circle cx="50" cy="55" r="40" fill={`url(#${id}b)`} stroke="#fff" strokeWidth="3" opacity="0.95" />
      {/* starfield inside body */}
      <Circle cx="28" cy="42" r="1" fill="#fff" />
      <Circle cx="40" cy="38" r="0.8" fill="#fff" />
      <Circle cx="60" cy="38" r="0.8" fill="#fff" />
      <Circle cx="72" cy="42" r="1" fill="#fff" />
      <Circle cx="32" cy="58" r="0.8" fill="#fff" />
      <Circle cx="68" cy="58" r="0.8" fill="#fff" />
      <Circle cx="28" cy="72" r="0.7" fill="#fff" />
      <Circle cx="72" cy="72" r="0.7" fill="#fff" />
      <Circle cx="22" cy="55" r="0.8" fill="#4cc9ff" />
      <Circle cx="78" cy="55" r="0.8" fill="#4cc9ff" />
      <Circle cx="50" cy="86" r="0.9" fill="#fff" />
      <Circle cx="42" cy="84" r="0.6" fill="#fff" />
      <Circle cx="58" cy="84" r="0.6" fill="#fff" />
      {/* nebula clouds inside body */}
      <Path d="M 24 50 Q 38 46 30 64" stroke="#9e7afc" strokeWidth="1.2" fill="none" opacity="0.6" />
      <Path d="M 76 50 Q 62 46 70 64" stroke="#ff4d6d" strokeWidth="1.2" fill="none" opacity="0.6" />
      {/* eyes covering the body — 12 total + central core */}
      <Circle cx="34" cy="34" r="3.5" fill={`url(#${id}eye)`} stroke="#fff" strokeWidth="0.5" />
      <Circle cx="66" cy="34" r="3.5" fill={`url(#${id}eye)`} stroke="#fff" strokeWidth="0.5" />
      <Circle cx="22" cy="50" r="3" fill={`url(#${id}eye)`} stroke="#fff" strokeWidth="0.4" />
      <Circle cx="78" cy="50" r="3" fill={`url(#${id}eye)`} stroke="#fff" strokeWidth="0.4" />
      <Circle cx="26" cy="68" r="2.5" fill={`url(#${id}eye)`} stroke="#fff" strokeWidth="0.4" />
      <Circle cx="74" cy="68" r="2.5" fill={`url(#${id}eye)`} stroke="#fff" strokeWidth="0.4" />
      <Circle cx="34" cy="80" r="2.5" fill={`url(#${id}eye)`} stroke="#fff" strokeWidth="0.4" />
      <Circle cx="66" cy="80" r="2.5" fill={`url(#${id}eye)`} stroke="#fff" strokeWidth="0.4" />
      <Circle cx="38" cy="62" r="2" fill={`url(#${id}eye)`} stroke="#fff" strokeWidth="0.3" />
      <Circle cx="62" cy="62" r="2" fill={`url(#${id}eye)`} stroke="#fff" strokeWidth="0.3" />
      <Circle cx="50" cy="32" r="3" fill={`url(#${id}eye)`} stroke="#fff" strokeWidth="0.5" />
      <Circle cx="50" cy="78" r="2.5" fill={`url(#${id}eye)`} stroke="#fff" strokeWidth="0.4" />
      {/* eye pupils */}
      <Ellipse cx="34" cy="34" rx="0.8" ry="2" fill="#000" />
      <Ellipse cx="66" cy="34" rx="0.8" ry="2" fill="#000" />
      <Ellipse cx="22" cy="50" rx="0.6" ry="1.8" fill="#000" />
      <Ellipse cx="78" cy="50" rx="0.6" ry="1.8" fill="#000" />
      <Ellipse cx="50" cy="32" rx="0.6" ry="1.5" fill="#000" />
      {/* central singularity core */}
      <Circle cx="50" cy="55" r="14" fill="#000" stroke="#fff" strokeWidth="2" />
      <Circle cx="50" cy="55" r="12" fill={`url(#${id}core)`} />
      <Circle cx="50" cy="55" r="4" fill="#000" />
      <Circle cx="50" cy="55" r="4" fill="none" stroke="#fff" strokeWidth="0.6" />
      {/* accretion ring */}
      <Ellipse cx="50" cy="55" rx="16" ry="3" fill="none" stroke="#9e7afc" strokeWidth="0.8" opacity="0.75" />
      <Ellipse cx="50" cy="55" rx="14" ry="2" fill="none" stroke="#fff" strokeWidth="0.4" opacity="0.55" />
      {/* mouth — black hole maw at bottom */}
      <Ellipse cx="50" cy="88" rx="14" ry="5" fill="#000" stroke="#fff" strokeWidth="1" />
      <Polygon points="40,86 44,94 48,86" fill="#fff" />
      <Polygon points="48,86 52,95 56,86" fill="#fff" />
      <Polygon points="56,86 60,94 64,86" fill="#fff" />
    </Svg>
  );
});

// ───── World Ender Mega (wave 50 mega) — twin-headed apocalypse ─────────────

const WorldEnderMegaSvg = React.memo(function WorldEnderMegaSvg({ size, burning }) {
  const id = useRef(nextGid()).current;
  const r1 = burning ? '#a8f8c8' : '#0a0418';
  const r2 = burning ? '#2e8c50' : '#000';
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100">
      <Defs>
        <RadialGradient id={`${id}b`} cx="0.5" cy="0.5" r="0.5">
          <Stop offset="0" stopColor={r1} />
          <Stop offset="1" stopColor={r2} />
        </RadialGradient>
        <RadialGradient id={`${id}eye`} cx="0.5" cy="0.5" r="0.5">
          <Stop offset="0" stopColor="#fff" />
          <Stop offset="0.4" stopColor="#ff4d6d" />
          <Stop offset="1" stopColor="#3a0050" />
        </RadialGradient>
        <RadialGradient id={`${id}core`} cx="0.5" cy="0.5" r="0.5">
          <Stop offset="0" stopColor="#fff" />
          <Stop offset="0.2" stopColor="#9e7afc" />
          <Stop offset="0.6" stopColor="#ff4d6d" />
          <Stop offset="1" stopColor="#000" />
        </RadialGradient>
      </Defs>
      <Ellipse cx="50" cy="97" rx="50" ry="5" fill="#000" opacity="0.95" />
      {/* outer void halo */}
      <Circle cx="50" cy="50" r="48" fill="none" stroke="#9e7afc" strokeWidth="0.8" opacity="0.55" strokeDasharray="3 2" />
      {/* writhing void tentacles — 6 long */}
      <Path d="M 14 40 Q -8 24 -6 4" stroke={r2} strokeWidth="5" fill="none" strokeLinecap="round" />
      <Path d="M 8 64 Q -10 70 -8 92" stroke={r2} strokeWidth="5" fill="none" strokeLinecap="round" />
      <Path d="M 86 40 Q 108 24 106 4" stroke={r2} strokeWidth="5" fill="none" strokeLinecap="round" />
      <Path d="M 92 64 Q 110 70 108 92" stroke={r2} strokeWidth="5" fill="none" strokeLinecap="round" />
      <Path d="M 32 92 Q 24 104 30 110" stroke={r2} strokeWidth="4" fill="none" strokeLinecap="round" />
      <Path d="M 68 92 Q 76 104 70 110" stroke={r2} strokeWidth="4" fill="none" strokeLinecap="round" />
      <Circle cx="-6" cy="4" r="2.5" fill="#ff4d6d" stroke="#000" strokeWidth="0.5" />
      <Circle cx="-8" cy="92" r="2.5" fill="#ff4d6d" stroke="#000" strokeWidth="0.5" />
      <Circle cx="106" cy="4" r="2.5" fill="#ff4d6d" stroke="#000" strokeWidth="0.5" />
      <Circle cx="108" cy="92" r="2.5" fill="#ff4d6d" stroke="#000" strokeWidth="0.5" />
      {/* shoulder horn spires */}
      <Polygon points="10,42 4,12 18,38" fill="#000" stroke="#9e7afc" strokeWidth="0.5" />
      <Polygon points="90,42 96,12 82,38" fill="#000" stroke="#9e7afc" strokeWidth="0.5" />
      {/* main body — vast cosmic mass */}
      <Path
        d="M 18 38 Q 14 18 30 18
           L 38 16 L 50 4 L 62 16 L 70 18
           Q 86 18 82 38
           L 90 56 L 84 84 L 70 94 L 50 92 L 30 94 L 16 84 L 10 56 Z"
        fill={`url(#${id}b)`} stroke="#fff" strokeWidth="2.8"
      />
      {/* stars inside body */}
      <Circle cx="30" cy="36" r="1.2" fill="#fff" />
      <Circle cx="70" cy="36" r="1.2" fill="#fff" />
      <Circle cx="40" cy="30" r="0.8" fill="#fff" />
      <Circle cx="60" cy="30" r="0.8" fill="#fff" />
      <Circle cx="50" cy="20" r="1" fill="#fff" />
      <Circle cx="22" cy="60" r="0.9" fill="#fff" />
      <Circle cx="78" cy="60" r="0.9" fill="#fff" />
      <Circle cx="26" cy="78" r="0.8" fill="#fff" />
      <Circle cx="74" cy="78" r="0.8" fill="#fff" />
      <Circle cx="18" cy="48" r="0.7" fill="#4cc9ff" />
      <Circle cx="82" cy="48" r="0.7" fill="#4cc9ff" />
      <Circle cx="50" cy="74" r="0.7" fill="#9e7afc" />
      <Circle cx="40" cy="68" r="0.8" fill="#fff" />
      <Circle cx="60" cy="68" r="0.8" fill="#fff" />
      <Circle cx="34" cy="44" r="0.7" fill="#4cc9ff" />
      <Circle cx="66" cy="44" r="0.7" fill="#4cc9ff" />
      {/* nebula swirls */}
      <Path d="M 20 50 Q 30 46 26 60" stroke="#9e7afc" strokeWidth="1" fill="none" opacity="0.6" />
      <Path d="M 80 50 Q 70 46 74 60" stroke="#ff4d6d" strokeWidth="1" fill="none" opacity="0.6" />
      {/* TWO heads — left and right */}
      {/* left head: skull-faced, bone */}
      <Ellipse cx="32" cy="34" rx="14" ry="16" fill="#e8e0c8" stroke="#000" strokeWidth="1.5" />
      <Path d="M 24 24 L 28 32" stroke="#000" strokeWidth="0.6" />
      <Path d="M 38 22 L 36 28" stroke="#000" strokeWidth="0.6" />
      <Ellipse cx="28" cy="34" rx="3" ry="3.5" fill="#000" />
      <Ellipse cx="36" cy="34" rx="3" ry="3.5" fill="#000" />
      <Circle cx="28" cy="34" r="1.5" fill="#ff4d6d" />
      <Circle cx="36" cy="34" r="1.5" fill="#ff4d6d" />
      <Circle cx="28" cy="34" r="0.5" fill="#fff" />
      <Circle cx="36" cy="34" r="0.5" fill="#fff" />
      <Polygon points="32,40 30,44 34,44" fill="#000" />
      <Rect x="26" y="46" width="12" height="3" fill="#e8e0c8" stroke="#000" strokeWidth="0.5" />
      <Line x1="29" y1="46" x2="29" y2="49" stroke="#000" strokeWidth="0.4" />
      <Line x1="32" y1="46" x2="32" y2="49" stroke="#000" strokeWidth="0.4" />
      <Line x1="35" y1="46" x2="35" y2="49" stroke="#000" strokeWidth="0.4" />
      {/* horns on left head */}
      <Polygon points="22,24 14,4 26,16" fill="#000" />
      <Polygon points="40,18 44,4 38,18" fill="#000" />
      {/* right head: mirror with crown of shards */}
      <Ellipse cx="68" cy="34" rx="14" ry="16" fill="#e8e0c8" stroke="#000" strokeWidth="1.5" />
      <Path d="M 76 24 L 72 32" stroke="#000" strokeWidth="0.6" />
      <Path d="M 62 22 L 64 28" stroke="#000" strokeWidth="0.6" />
      <Ellipse cx="64" cy="34" rx="3" ry="3.5" fill="#000" />
      <Ellipse cx="72" cy="34" rx="3" ry="3.5" fill="#000" />
      <Circle cx="64" cy="34" r="1.5" fill="#ff4d6d" />
      <Circle cx="72" cy="34" r="1.5" fill="#ff4d6d" />
      <Circle cx="64" cy="34" r="0.5" fill="#fff" />
      <Circle cx="72" cy="34" r="0.5" fill="#fff" />
      <Polygon points="68,40 66,44 70,44" fill="#000" />
      <Rect x="62" y="46" width="12" height="3" fill="#e8e0c8" stroke="#000" strokeWidth="0.5" />
      <Line x1="65" y1="46" x2="65" y2="49" stroke="#000" strokeWidth="0.4" />
      <Line x1="68" y1="46" x2="68" y2="49" stroke="#000" strokeWidth="0.4" />
      <Line x1="71" y1="46" x2="71" y2="49" stroke="#000" strokeWidth="0.4" />
      {/* horns on right head */}
      <Polygon points="78,24 86,4 74,16" fill="#000" />
      <Polygon points="60,18 56,4 62,18" fill="#000" />
      {/* central chest singularity core */}
      <Circle cx="50" cy="64" r="14" fill="#000" stroke="#fff" strokeWidth="2.2" />
      <Circle cx="50" cy="64" r="11" fill={`url(#${id}core)`} />
      <Circle cx="50" cy="64" r="3" fill="#000" />
      <Ellipse cx="50" cy="64" rx="16" ry="3" fill="none" stroke="#9e7afc" strokeWidth="0.7" opacity="0.7" />
      <Ellipse cx="50" cy="64" rx="14" ry="2" fill="none" stroke="#fff" strokeWidth="0.4" opacity="0.55" />
      {/* third smaller mouth at bottom */}
      <Ellipse cx="50" cy="86" rx="10" ry="3" fill="#000" stroke="#fff" strokeWidth="0.8" />
      <Polygon points="44,84 46,90 48,84" fill="#fff" />
      <Polygon points="50,84 52,90 54,84" fill="#fff" />
      <Polygon points="56,84 58,90 60,84" fill="#fff" />
      {/* connecting bone joints between heads */}
      <Path d="M 44 38 Q 50 42 56 38" stroke="#e8e0c8" strokeWidth="2" fill="none" />
      <Circle cx="50" cy="40" r="1.5" fill="#e8e0c8" stroke="#000" strokeWidth="0.4" />
    </Svg>
  );
});


function ProjectileView({ p }) {
  const len = Math.hypot(p.toX - p.fromX, p.toY - p.fromY);
  const angle = Math.atan2(p.toY - p.fromY, p.toX - p.fromX);
  const midX = (p.fromX + p.toX) / 2;
  const midY = (p.fromY + p.toY) / 2;
  return (
    <View pointerEvents="none" style={{
      position: 'absolute',
      left: midX - len / 2,
      top: midY - 3,
      width: len,
      height: 6,
      transform: [{ rotate: `${angle}rad` }],
    }}>
      <View style={{
        position: 'absolute',
        left: 0,
        top: 1,
        width: len,
        height: 4,
        borderRadius: 4,
        backgroundColor: p.color,
        opacity: 0.18,
      }} />
      <View style={{
        position: 'absolute',
        left: 0,
        top: 2,
        width: len,
        height: 2,
        borderRadius: 2,
        backgroundColor: p.color,
        opacity: 0.95,
      }} />
      <View style={{
        position: 'absolute',
        right: -2,
        top: 0,
        width: 6,
        height: 6,
        borderRadius: 6,
        backgroundColor: '#fff',
        opacity: 0.8,
      }} />
    </View>
  );
}

// Visual effects: muzzle flashes, impact sparks, death bursts.
function FxLayer({ fx, time }) {
  return (
    <>
      {fx.map((f) => {
        const life = f.until - f.start;
        const t = (time - f.start) / life;
        if (t < 0 || t > 1) return null;
        if (f.type === 'muzzle') {
          const size = 8 + 18 * (1 - t);
          const opacity = 1 - t;
          return (
            <View key={`fx${f.id}`} pointerEvents="none" style={{
              position: 'absolute',
              left: f.x - size / 2, top: f.y - size / 2,
              width: size, height: size, borderRadius: size,
              backgroundColor: '#fff',
              opacity: opacity * 0.85,
              shadowColor: f.color, shadowOpacity: opacity,
              shadowRadius: 8, shadowOffset: { width: 0, height: 0 },
            }} />
          );
        }
        if (f.type === 'impact') {
          // expanding ring + bright core
          const ringSize = 6 + 22 * t;
          const ringOp = (1 - t) * 0.9;
          const coreSize = 6 * (1 - t);
          return (
            <View key={`fx${f.id}`} pointerEvents="none" style={{ position: 'absolute', left: f.x, top: f.y }}>
              <View style={{
                position: 'absolute',
                left: -ringSize / 2, top: -ringSize / 2,
                width: ringSize, height: ringSize, borderRadius: ringSize,
                borderWidth: 2, borderColor: f.color,
                opacity: ringOp,
              }} />
              {coreSize > 0.5 && (
                <View style={{
                  position: 'absolute',
                  left: -coreSize / 2, top: -coreSize / 2,
                  width: coreSize, height: coreSize, borderRadius: coreSize,
                  backgroundColor: '#fff',
                  opacity: (1 - t),
                }} />
              )}
            </View>
          );
        }
        if (f.type === 'shield') {
          const size = 12 + 28 * t;
          const opacity = (1 - t) * 0.9;
          return (
            <View key={`fx${f.id}`} pointerEvents="none" style={{ position: 'absolute', left: f.x, top: f.y }}>
              <View style={{
                position: 'absolute',
                left: -size / 2,
                top: -size / 2,
                width: size,
                height: size,
                borderRadius: size,
                borderWidth: 2,
                borderColor: '#7be5d1',
                opacity,
              }} />
              <View style={{
                position: 'absolute',
                left: -size * 0.28,
                top: -size * 0.28,
                width: size * 0.56,
                height: size * 0.56,
                borderRadius: size,
                backgroundColor: '#7be5d1',
                opacity: opacity * 0.2,
              }} />
            </View>
          );
        }
        if (f.type === 'text') {
          const y = f.y - 18 * t;
          const opacity = (1 - t) * (1 - t);
          return (
            <View key={`fx${f.id}`} pointerEvents="none" style={{
              position: 'absolute',
              left: f.x - 28,
              top: y - 9,
              width: 56,
              alignItems: 'center',
              opacity,
            }}>
              <Text style={{
                color: f.color || '#fff',
                fontSize: f.big ? 12 : 10,
                fontWeight: '900',
                textShadowColor: '#000',
                textShadowOffset: { width: 0, height: 1 },
                textShadowRadius: 2,
              }}>
                {f.text}
              </Text>
            </View>
          );
        }
        if (f.type === 'death') {
          // particle flies outward with simple drag + gravity
          const elapsed = time - f.start;
          const drag = Math.exp(-2.5 * elapsed);
          const px = f.x + f.vx * elapsed * drag;
          const py = f.y + f.vy * elapsed * drag + 40 * elapsed * elapsed;
          const size = 3 + 2 * (1 - t);
          const opacity = (1 - t) * (1 - t);
          return (
            <View key={`fx${f.id}`} pointerEvents="none" style={{
              position: 'absolute',
              left: px - size / 2, top: py - size / 2,
              width: size, height: size, borderRadius: size,
              backgroundColor: f.color,
              opacity,
            }} />
          );
        }
        return null;
      })}
    </>
  );
}

// Big wave-start banner — fades in, holds, fades out.
function WaveBanner({ banner, time }) {
  if (!banner || time > banner.until) return null;
  const life = banner.until - banner.start;
  const t = (time - banner.start) / life;
  // ease: in for first 20%, hold middle, out for last 30%
  let opacity;
  if (t < 0.2) opacity = t / 0.2;
  else if (t < 0.7) opacity = 1;
  else opacity = (1 - t) / 0.3;
  const slide = (1 - opacity) * 30;
  // Trial colours echo the trial's theme.
  const trialColor = {
    SPEED:     '#ffd166', // gold — fast = lightning
    AERIAL:    '#a8e0ff', // sky-blue
    SWARM:     '#ff8fab', // pink — bug horde
    ARMORED:   '#cfd5e6', // steel grey
    ENDURANCE: '#7be5d1', // teal — last stand
  }[banner.trial];
  const accentColor = banner.finalWave ? '#ff4d6d'
    : banner.boss ? '#ff4d6d'
    : banner.trial ? trialColor
    : banner.mythic ? '#ff6f1f'
    : banner.apex ? '#5cf28a'
    : banner.champion ? '#ffd166'
    : banner.elite ? '#b08bff'
    : '#4cc9ff';
  return (
    <View pointerEvents="none" style={{
      position: 'absolute',
      left: 0, right: 0, top: VIEWPORT_H * 0.32,
      alignItems: 'center',
      opacity,
      transform: [{ translateY: slide }],
    }}>
      {/* wood-banner backdrop */}
      <View style={{
        backgroundColor: '#1a0c08e6',
        paddingVertical: 16, paddingHorizontal: 32,
        borderRadius: 14,
        borderWidth: 3, borderColor: '#3a2818',
        borderTopWidth: 5, borderTopColor: accentColor,
        borderBottomWidth: 5, borderBottomColor: accentColor,
        alignItems: 'center',
        shadowColor: '#000', shadowOpacity: 0.8, shadowRadius: 16, shadowOffset: { width: 0, height: 8 },
        position: 'relative',
      }}>
        {/* gold corner studs */}
        <View style={[styles.cornerStud, { top: 4, left: 4 }]} />
        <View style={[styles.cornerStud, { top: 4, right: 4 }]} />
        <View style={[styles.cornerStud, { bottom: 4, left: 4 }]} />
        <View style={[styles.cornerStud, { bottom: 4, right: 4 }]} />

        <Text style={{
          color: accentColor,
          fontSize: banner.finalWave ? 16 : 14, fontWeight: '900',
          letterSpacing: 6,
          textShadowColor: '#000', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 2,
        }}>
          {banner.finalWave ? '✦  THE FINAL WAVE  ✦'
            : banner.boss ? '⚠  BOSS WAVE  ⚠'
            : banner.trial ? `⚔  ${banner.trial} TRIAL  ⚔`
            : banner.mythic ? '✦  MYTHIC WAVE  ✦'
            : banner.apex ? '◆  APEX WAVE  ◆'
            : banner.champion ? '☠  CHAMPION WAVE  ☠'
            : banner.elite ? 'ELITE WAVE'
            : 'INCOMING'}
        </Text>
        <Text style={{
          color: '#fff', fontSize: banner.finalWave ? 64 : 56, fontWeight: '900',
          letterSpacing: 4, marginTop: 4,
          textShadowColor: accentColor,
          textShadowOffset: { width: 0, height: 0 },
          textShadowRadius: banner.finalWave ? 28 : 18,
        }}>
          WAVE {banner.wave}
        </Text>
        {banner.waveName && (
          <Text style={{
            color: '#fff', fontSize: 18, fontWeight: '900',
            letterSpacing: 3, marginTop: 4,
            textShadowColor: '#000',
            textShadowOffset: { width: 0, height: 1 },
            textShadowRadius: 3,
          }}>
            {banner.waveName.toUpperCase()}
          </Text>
        )}
        {banner.bossName && (
          <Text style={{
            color: '#ffd166', fontSize: 22, fontWeight: '900',
            letterSpacing: 5, marginTop: 4,
            textShadowColor: '#ff4d6d',
            textShadowOffset: { width: 0, height: 0 },
            textShadowRadius: 10,
          }}>
            {banner.bossName}
          </Text>
        )}
        <Text style={{
          color: '#cfd5e6', fontSize: 11, letterSpacing: 3, marginTop: 6, fontWeight: '700',
        }}>
          {banner.total} ENEMIES
        </Text>
        {banner.lesson && (
          <Text numberOfLines={1} style={{
            color: '#e8e0c8', fontSize: 10, letterSpacing: 1.5, marginTop: 4, fontWeight: '700',
            maxWidth: 300,
          }}>
            {banner.lesson.toUpperCase()}
          </Text>
        )}
      </View>
    </View>
  );
}

// ─── Tower targeting / candidate action picker ───────────────────────────────
function TowerInspect({ tower, onMode }) {
  const isGem = tower.kind === 'gem';
  const name = isGem
    ? `${GEMS[tower.gemType].name} ${tier(tower.tier).short}`
    : (SPECIAL_BY_ID[tower.specialId]?.name || tower.specialId);
  const color = isGem ? GEMS[tower.gemType].color : (SPECIAL_BY_ID[tower.specialId]?.accent || '#ffd166');
  const stats = isGem ? gemStats(tower.gemType, tower.tier) : SPECIAL_BY_ID[tower.specialId]?.stats;
  const mode = TARGET_MODE_IDS.has(tower.targetMode) ? tower.targetMode : DEFAULT_TARGET_MODE;
  return (
    <>
      <View style={styles.modalHeaderRow}>
        <View style={{
          width: 32, height: 32, backgroundColor: color,
          transform: [{ rotate: '45deg' }], borderRadius: 4, marginRight: 14,
          shadowColor: color, shadowOpacity: 0.9, shadowRadius: 6,
        }} />
        <View style={{ flex: 1 }}>
          <Text style={styles.modalTitle}>{name}</Text>
          <Text style={styles.modalSub}>Targeting · {targetModeLabel(mode)}</Text>
        </View>
      </View>
      {stats && (
        <View style={styles.modalRow}>
          <ModalStat label="DAMAGE" value={stats.damage} />
          <ModalStat label="RANGE" value={stats.range.toFixed(1)} />
          <ModalStat label="RATE" value={`${stats.cooldown.toFixed(2)}s`} />
        </View>
      )}
      <Text style={styles.combineHint}>
        Pick how this tower chooses enemies. Manual waits for your next enemy tap.
      </Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {TARGET_MODES.map((m) => {
          const selected = mode === m.id;
          return (
            <TouchableOpacity
              key={m.id}
              onPress={() => onMode(m.id)}
              activeOpacity={0.8}
              style={{
                width: '30.5%',
                minWidth: 82,
                borderRadius: 6,
                borderWidth: 1.5,
                borderColor: selected ? color : '#2a335f',
                backgroundColor: selected ? '#1d2240' : '#101630',
                paddingVertical: 8,
                alignItems: 'center',
              }}
            >
              <Text style={{ color: selected ? color : '#cfd5e6', fontSize: 11, fontWeight: '900' }}>
                {m.name.toUpperCase()}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </>
  );
}

// ─── Candidate inspect / action picker ───────────────────────────────────────
function CandidateInspect({ candidate, candidates = [], onSelectCandidate, allTowers, gold = 0, onKeep, onMerge, onChainMerge, onCombine }) {
  const g = GEMS[candidate.gemType];
  const t = tier(candidate.tier);
  const stats = gemStats(candidate.gemType, candidate.tier);
  const matches = allTowers.filter(
    (x) => x.id !== candidate.id && x.kind === 'gem' && x.gemType === candidate.gemType && x.tier === candidate.tier
  ).length;
  const canMerge1 = matches >= 1 && candidate.tier < 6;
  const canMerge2 = matches >= 3 && candidate.tier + 2 <= 6;
  const chainMerge = findChainMergeMatch(candidate, allTowers);
  const canChainMerge = !!chainMerge;
  const chainMergeDesc = candidate.tier + 2 <= 6
    ? (canChainMerge
      ? `${gemLabel(candidate.gemType, candidate.tier)} + ${gemLabel(candidate.gemType, candidate.tier)} + ${gemLabel(candidate.gemType, candidate.tier + 1)} → ${gemLabel(candidate.gemType, candidate.tier + 2)}`
      : `Need ${gemLabel(candidate.gemType, candidate.tier)} + ${gemLabel(candidate.gemType, candidate.tier + 1)}`)
    : 'Already too pure for chain merge';
  const craftable = SPECIAL_RECIPES.filter((r) => findRecipeMatch(candidate, allTowers, r) !== null);
  // Multi-candidate strip — show all 5 placements with their family colour so
  // the player can switch which one's actions are visible without closing the
  // modal. Selected candidate gets a brighter border.
  const candidateChips = candidates.length > 1 ? (
    <View style={{ flexDirection: 'row', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
      {candidates.map((c) => {
        const cg = GEMS[c.gemType];
        const ct = tier(c.tier);
        const isActive = c.id === candidate.id;
        return (
          <TouchableOpacity
            key={c.id}
            onPress={() => onSelectCandidate && onSelectCandidate(c.id)}
            activeOpacity={0.75}
            style={{
              flex: 1, minWidth: 80,
              paddingHorizontal: 8, paddingVertical: 6,
              borderRadius: 6,
              borderWidth: isActive ? 2 : 1,
              borderColor: isActive ? '#ffd166' : cg.color + '88',
              backgroundColor: cg.color + (isActive ? '40' : '22'),
            }}
          >
            <Text style={{ color: cg.color, fontWeight: '800', fontSize: 11, textAlign: 'center' }}>
              {cg.name.toUpperCase()}
            </Text>
            <Text style={{ color: '#fff', fontWeight: '700', fontSize: 12, textAlign: 'center' }}>
              {ct.name} {ct.short}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  ) : null;
  return (
    <>
      {candidateChips}
      <View style={styles.modalHeaderRow}>
        <View style={{
          width: 32, height: 32, backgroundColor: g.color,
          transform: [{ rotate: '45deg' }], borderRadius: 4, marginRight: 14,
          shadowColor: g.color, shadowOpacity: 0.9, shadowRadius: 6,
        }} />
        <View style={{ flex: 1 }}>
          <Text style={styles.modalTitle}>
            {g.name} <Text style={{ color: '#ffd166' }}>{t.short}</Text>
          </Text>
          <Text style={styles.modalSub}>{t.name} · {g.ability}</Text>
        </View>
      </View>
      <View style={styles.modalRow}>
        <ModalStat label="DAMAGE" value={stats.damage} />
        <ModalStat label="RANGE" value={stats.range.toFixed(1)} />
        <ModalStat label="RATE" value={`${stats.cooldown.toFixed(2)}s`} />
      </View>

      <Text style={styles.combineHint}>
        Pick ONE action. Other candidates this round become rocks.
      </Text>

      <View style={{ gap: 8 }}>
        <ActionRow
          label="KEEP"
          desc="Keep this gem · other 4 → rocks"
          color="#4cc9ff"
          enabled
          onPress={onKeep}
        />
        <ActionRow
          label="MERGE +1"
          desc={canMerge1
            ? `Combine 2 same → ${tier(candidate.tier + 1).name} (you have ${matches + 1})`
            : `Need 1 more ${g.name} ${t.short} (have ${matches})`}
          color="#5cf28a"
          enabled={canMerge1}
          onPress={() => onMerge(1)}
        />
        <ActionRow
          label="MERGE +2"
          desc={canMerge2
            ? `Combine 4 same → ${tier(candidate.tier + 2).name} (you have ${matches + 1})`
            : `Need 3 more ${g.name} ${t.short} (have ${matches})`}
          color="#ffd166"
          enabled={canMerge2}
          onPress={() => onMerge(2)}
        />
        <ActionRow
          label="CHAIN MERGE"
          desc={chainMergeDesc}
          color="#b08bff"
          enabled={canChainMerge}
          onPress={onChainMerge}
        />
      </View>

      {craftable.length > 0 && (
        <View style={styles.craftSection}>
          <Text style={styles.craftSectionLabel}>COMBINE RECIPES READY</Text>
          {craftable.map((r) => {
            const cost = recipeGoldCost(r);
            const affordable = gold >= cost;
            return (
              <TouchableOpacity
                key={r.id}
                style={[styles.craftBtn, { borderColor: r.accent }, !affordable && { opacity: 0.45 }]}
                onPress={() => onCombine(r.id)}
                activeOpacity={affordable ? 0.85 : 1}
                disabled={!affordable}
              >
                <View style={[styles.craftIcon, { backgroundColor: r.color, borderColor: r.accent }]}>
                  <Text style={styles.specialIconStar}>★</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.craftBtnName}>{r.name} <Text style={{ color: '#ffd166' }}>{r.tier}</Text></Text>
                  <Text style={styles.craftBtnDesc}>{r.description}</Text>
                  <Text style={[styles.craftBtnCost, { color: affordable ? '#ffd166' : '#ff6f6f' }]}>
                    ⬡ {cost}g{affordable ? '' : `  (have ${gold})`}
                  </Text>
                </View>
                <Text style={styles.craftBtnArrow}>▶</Text>
              </TouchableOpacity>
            );
          })}
        </View>
      )}
    </>
  );
}

function ActionRow({ label, desc, color, enabled, onPress }) {
  return (
    <TouchableOpacity
      style={[styles.actionRowBtn, { borderColor: enabled ? color : '#2a335f' }, !enabled && { opacity: 0.5 }]}
      onPress={enabled ? onPress : undefined}
      activeOpacity={0.85}
    >
      <View style={{ flex: 1 }}>
        <Text style={[styles.actionRowLabel, { color: enabled ? color : '#7c84a8' }]}>{label}</Text>
        <Text style={styles.actionRowDesc}>{desc}</Text>
      </View>
      <Text style={[styles.actionRowArrow, { color: enabled ? color : '#7c84a8' }]}>▶</Text>
    </TouchableOpacity>
  );
}

function ModalStat({ label, value }) {
  return (
    <View style={styles.modalStat}>
      <Text style={styles.modalStatLabel}>{label}</Text>
      <Text style={styles.modalStatValue}>{value}</Text>
    </View>
  );
}

function HudStat({ label, value, color }) {
  return (
    <View style={styles.hudStat}>
      <View style={[styles.hudStatPlaque, { borderColor: color + 'aa' }]}>
        <Text style={[styles.hudValue, { color }]} numberOfLines={1}>{value}</Text>
      </View>
      <Text style={[styles.hudLabel, { color: color + 'cc' }]}>{label}</Text>
    </View>
  );
}

// Boss signature tick (Phase F). Runs once per step before tower firing.
function applyBossSignatures(s, dt) {
  for (const e of s.enemies) {
    if (e.hp <= 0) continue;
    // Endless bosses (W60+) carry a rosterId — prefer it so each boss in the
    // 20-cycle keeps its own signature even when sharing a skin renderer.
    const sig = BOSS_SIGNATURES[e.rosterId] || BOSS_SIGNATURES[e.bossVariant];
    if (!sig) continue;
    e._sigT = (e._sigT || 0) + dt;
    if (sig === 'HoundSprint') {
      if (e._sigT >= 6) { e._sigT = 0; e._sigBurstEnd = s.time + 2; }
      // _eliteSpeed is read in movement; HoundSprint sets it to 1.6 during burst.
      e._eliteSpeed = (s.time < (e._sigBurstEnd || 0)) ? 1.6 : (e._elite ? MUT_ELITE_SPEED : 1);
    } else if (sig === 'JudgmentSlam') {
      if (e._sigT >= 10) {
        e._sigT = 0;
        // Stun the 3 nearest firing towers for 1.5s.
        const cands = [];
        for (const t of s.towers) {
          if (t.kind !== 'gem' && t.kind !== 'special') continue;
          cands.push({ t, d: Math.hypot(t.r - e.r, t.c - e.c) });
        }
        cands.sort((a, b) => a.d - b.d);
        for (const c of cands.slice(0, 3)) c.t._stunUntil = s.time + 1.5;
      }
    } else if (sig === 'SkyCourtAdds') {
      if (e._sigT >= 8) {
        e._sigT = 0;
        const def = ENEMIES.swarm;
        const hp = computeEnemyHP('swarm', s.wave, s.difficulty || DIFFICULTIES[DEFAULT_DIFFICULTY]);
        for (let i = 0; i < 2; i++) {
          s.enemies.push({
            id: s.nextEnemyId++,
            r: e.r, c: e.c,
            hp, maxHp: hp,
            type: 'swarm',
            armor: def.armor,
            subPath: e.subPath ? e.subPath.slice(Math.max(0, e.pathIdx)) : [{ r: e.r, c: e.c }, GOAL],
            pathIdx: 0,
            effects: [],
            tier: 0, elite: false, bossVariant: null,
            spawnWave: s.wave, spawnedAt: s.time, _lastDmgT: s.time,
          });
        }
      }
    } else if (sig === 'InvisibilityPulse') {
      if (e._sigT >= 8) { e._sigT = 0; e._sigInvisEnd = s.time + 3; }
      // _inFog gate is consulted in target picking (added in Phase D).
      if (s.time < (e._sigInvisEnd || 0)) e._inFog = true;
    } else if (sig === 'PhaseShields') {
      if (e._sigT >= 6) {
        e._sigT = 0;
        const types = ['physical', 'magic', 'poison', 'burn'];
        e._sigShieldIdx = ((e._sigShieldIdx || 0) + 1) % types.length;
        e._sigShieldEnd = s.time + 2;
        e._bossShieldType = types[e._sigShieldIdx];
      } else if (s.time >= (e._sigShieldEnd || 0)) {
        e._bossShieldType = null;
      }
    }
  }
}

// ─── Game step (combat phase) ────────────────────────────────────────────────
function step(dt, s, onEnd) {
  s.time += dt;
  // Utility cooldown tick + Gold Rain accumulator (Phase E).
  if (s.skillCooldowns) {
    for (const u of UTILITIES) {
      if (s.skillCooldowns[u.id] > 0) s.skillCooldowns[u.id] = Math.max(0, s.skillCooldowns[u.id] - dt);
    }
  }
  if (effectActive(s, 'GoldRain')) {
    s.goldRainAcc = (s.goldRainAcc || 0) + 50 * dt;
    if (s.goldRainAcc >= 1) {
      const add = Math.floor(s.goldRainAcc);
      s.gold += add;
      s.goldRainAcc -= add;
    }
  }
  if (s.phase !== 'attacking') return;

  // Spawn from queue
  while (s.spawnQueue.length && s.spawnQueue[0].atTime <= s.time) {
    const sp = s.spawnQueue.shift();
    const def = ENEMIES[sp.type];
    const mods = spawnMods(sp);
    const flying = def.flying || mods.includes('flying');
    const diff = s.difficulty || DIFFICULTIES[DEFAULT_DIFFICULTY];
    const hp = computeEnemyHP(sp.type, s.wave, diff);   // P5 single HP source
    const subPath = flying
      ? [SPAWN, GOAL] // flyers go direct
      : bfsCheckpoints(s.grid, SPAWN) || [SPAWN, GOAL];
    // Tier 0 = base (W1-10), 1 = elite (W11-20), 2 = champion (W21-30),
    // 3 = apex (W31-40), 4 = mythic (W41+). Bosses/mega use bossVariant slot.
    const tier = sp.type === 'boss' || sp.type === 'mega' ? 0
      : s.wave >= 41 ? 4
      : s.wave >= 31 ? 3
      : s.wave >= 21 ? 2
      : s.wave >= 11 ? 1
      : 0;
    const elite = tier >= 1;
    // Boss + mega skins by milestone wave.
    let bossVariant = null;
    let rosterId = null;
    if (sp.type === 'boss') {
      // Endless cycle (W60+): pick from BOSS_ROSTER and reuse the matching
      // core SVG renderer until per-roster art lands.
      const endlessEntry = endlessBossEntry(s.wave);
      if (sp.bossVariant) {
        bossVariant = sp.bossVariant;
      } else if (endlessEntry) {
        bossVariant = endlessEntry.skin;
        rosterId = endlessEntry.id;
      } else {
        bossVariant = s.wave === 20 ? 'void'
          : s.wave === 30 ? 'blood'
          : s.wave === 40 ? 'destroyer'
          : s.wave === 50 ? 'ender'
          : 'demon';
      }
    } else if (sp.type === 'mega') {
      bossVariant = sp.bossVariant || (s.wave === 50 ? 'ender-mega' : 'colossus');
    }
    const enemy = {
      id: s.nextEnemyId++,
      r: SPAWN.r, c: SPAWN.c,
      hp, maxHp: hp,
      type: sp.type,
      flying,
      armor: def.armor,
      subPath, pathIdx: 0,
      effects: [],
      tier,
      elite,
      bossVariant,
      rosterId,                           // endless-cycle roster id (W60+ bosses)
      spawnWave: s.wave,
      spawnedAt: s.time,                  // for killstreak anti-farm (doc §54.3)
      _lastDmgT: s.time,                  // RegenWaves idle tracker
    };
    applySpawnAbilities(enemy, sp, s);
    s.enemies.push(enemy);
    // Apply milestone evolution at spawn (doc §57.2) for W100+.
    const ms = milestoneMults(s.wave);
    if (ms.speed !== 1 || ms.armor !== 1) {
      const last = s.enemies[s.enemies.length - 1];
      last._milestoneSpeed = ms.speed;
      last.armor = Math.round(last.armor * ms.armor);
    }
    // Apply mutation on-spawn effects (Elite, ResistShifts, ShieldRotations, ArmorBloom).
    if (s.activeMutations.length) {
      const rng = mulberry32((s.matchSeed >>> 0) ^ (s.nextEnemyId * 0x9E3779B1) >>> 0);
      applyMutationsOnSpawn(s.enemies[s.enemies.length - 1], s.activeMutations, rng);
    }
    // CandyLure (Phase E): tag the next 3 spawns with a 50% slow for 5s.
    if (s.candyLureRemaining > 0 && effectActive(s, 'CandyLure')) {
      const last = s.enemies[s.enemies.length - 1];
      last.effects.push({ type: 'slow', factor: 0.5, until: s.time + 5 });
      s.candyLureRemaining -= 1;
    }
  }

  // Move enemies
  const muts = s.activeMutations || [];
  for (const e of s.enemies) {
    if (e.hp <= 0) continue;
    const def = ENEMIES[e.type];
    e.effects = e.effects.filter((ef) => ef.until > s.time);
    let speedMul = 1;
    for (const ef of e.effects) {
      if (ef.type === 'slow') speedMul = Math.min(speedMul, ef.factor);
      if (ef.type === 'poison') e.hp -= ef.dps * dt * damageMultByType(e, 'poison');
    }
    if (e.rush) {
      const burst = Math.sin(s.time * 1.7 + e.id * 0.43) > 0.55;
      if (burst) speedMul *= 1.65;
    }
    if (e.recharge && (s.time - (e._lastDmgT || 0)) >= 2.0) {
      e.hp = Math.min(e.maxHp || e.hp, e.hp + (e.maxHp || e.hp) * 0.018 * dt);
    }
    if (e.krakenShell && s.time >= (e._shellNext || 0)) {
      e._shellNext = s.time + 4.5;
      e.effects = e.effects.filter((ef) => ef.type !== 'slow' && ef.type !== 'poison');
    }
    if (e.blink && s.time >= (e._blinkNext || 0) && e.subPath && e.pathIdx < e.subPath.length - 3) {
      e.pathIdx = Math.min(e.subPath.length - 1, e.pathIdx + 2);
      const snap = e.subPath[e.pathIdx];
      e.r = snap.r;
      e.c = snap.c;
      e._blinkNext = s.time + 4.5;
    }
    // Per-tick mutation effects (doc §56).
    if (muts.length) {
      if (muts.includes('ArmorBloom') && (e._bloomNextT || 0) <= s.time && (e._bloomStacks || 0) < MUT_ARMOR_BLOOM_MAX) {
        e.armor = (e.armor || 0) + MUT_ARMOR_BLOOM_PER;
        e._bloomStacks = (e._bloomStacks || 0) + 1;
        e._bloomNextT = s.time + MUT_ARMOR_BLOOM_PERIOD;
      }
      if (muts.includes('RegenWaves') && (s.time - (e._lastDmgT || 0)) >= MUT_REGEN_IDLE) {
        e.hp = Math.min(e.maxHp || e.hp, e.hp + (e.maxHp || e.hp) * MUT_REGEN_FRACTION * dt);
      }
      if (muts.includes('ResistShifts') && s.time - (e._resistFlipT || 0) >= MUT_RESIST_FLIP_PERIOD) {
        e._resistFlipT = s.time;
        if (e._resistState === 'magic') { e._resistState = 'physical'; e.magicResist = 0; e.physicalResist = MUT_RESIST_VALUE; }
        else { e._resistState = 'magic'; e.physicalResist = 0; e.magicResist = MUT_RESIST_VALUE; }
      }
      if (muts.includes('ShieldRotations') && s.time - (e._shieldT || 0) >= MUT_SHIELD_PERIOD && e._shieldTypes) {
        e._shieldT = s.time;
        e._shieldIdx = ((e._shieldIdx || 0) + 1) % e._shieldTypes.length;
        e._shieldBlockType = e._shieldTypes[e._shieldIdx];
      }
      if (muts.includes('SpeedSurge')) {
        speedMul *= 1 + 0.4 * Math.sin((s.time / MUT_SPEED_SURGE_PERIOD) * Math.PI * 2);
      }
      if (muts.includes('FogOfWarLanes') && e.subPath && e.subPath.length) {
        const frac = e.pathIdx / e.subPath.length;
        e._inFog = s.fogZones.some((z) => frac >= z.start && frac <= z.end);
      }
    }
    if (e.hp <= 0) continue;
    if (!e.subPath || e.pathIdx >= e.subPath.length) {
      const fresh = (e.flying || def.flying)
        ? [{ r: Math.floor(e.r), c: Math.floor(e.c) }, GOAL]
        : bfsCheckpoints(s.grid, { r: Math.floor(e.r), c: Math.floor(e.c) });
      if (fresh) { e.subPath = fresh; e.pathIdx = 0; } else continue;
    }
    const target = e.subPath[e.pathIdx];
    const dr = target.r - e.r;
    const dc = target.c - e.c;
    const dist = Math.hypot(dr, dc);
    const diffSpeed = (s.difficulty || DIFFICULTIES[DEFAULT_DIFFICULTY]).speedMul;
    // Phase E: Freeze fully stops; SpeedShield pauses; CandyLure tags first
    // few spawned enemies with a manual slow (applied at spawn — see below).
    if (effectActive(s, 'Freeze') || effectActive(s, 'SpeedShield')) speedMul = 0;
    const move = def.speed * speedMul * diffSpeed * rampSpeed(s.wave)
               * (e._eliteSpeed || 1) * (e._milestoneSpeed || 1) * dt;
    if (dist <= move) {
      e.r = target.r;
      e.c = target.c;
      e.pathIdx += 1;
      if (e.pathIdx >= e.subPath.length) {
        e.hp = -1;
        s.lives -= 1;
        s.killStreak = 0;   // leak breaks the streak (P9)
        playSound('life_lost');
      }
    } else {
      e.r += (dr / dist) * move;
      e.c += (dc / dist) * move;
    }
  }

  // Boss signatures per tick (Phase F) — must run before tower fire so
  // JudgmentSlam stuns / InvisibilityPulse fog take effect this frame.
  applyBossSignatures(s, dt);

  // Towers fire (gems and specials, never rocks/candidates)
  for (const t of s.towers) {
    if (t.kind !== 'gem' && t.kind !== 'special') continue;
    if (t._stunUntil && t._stunUntil > s.time) continue;   // JudgmentSlam stun
    const disarmed = s.enemies.some((e) =>
      e.hp > 0 && e.disarmAura && Math.hypot(e.r - t.r, e.c - t.c) <= 2.2
    );
    if (disarmed) continue;
    t.cooldown = Math.max(0, t.cooldown - dt);
    if (t.cooldown > 0) continue;
    const stats = t.kind === 'gem'
      ? gemStats(t.gemType, t.tier)
      : SPECIAL_BY_ID[t.specialId]?.stats;
    if (!stats) continue;
    const color = t.kind === 'gem' ? GEMS[t.gemType].color : SPECIAL_BY_ID[t.specialId].accent;
    const inRange = [];
    const isOpalTower = t.kind === 'gem' && t.gemType === 'opal';
    const opalP6Active = s.towers.some((x) => x.kind === 'gem' && x.gemType === 'opal' && x.tier === 6);
    for (const e of s.enemies) {
      if (e.hp <= 0) continue;
      // FogOfWarLanes: non-Opal towers skip fogged enemies (doc §A.1b),
      // unless any Opal P6 is on the board (doc §A8.Opal: global reveal).
      if (e._inFog && !isOpalTower && !opalP6Active) continue;
      if (e.hidden && !isOpalTower && !opalP6Active) continue;
      const d = Math.hypot(e.r - t.r, e.c - t.c);
      if (d <= stats.range) inRange.push({ e, d });
    }
    if (inRange.length === 0) continue;
    const sortedTargets = sortTargetsForTower(t, inRange, stats);
    // Aquamarine P6 (doc §A8.Aquamarine): ×2 attack speed when any mutation active.
    const cdMult = (p6Family(t) === 'aquamarine' && s.activeMutations.length > 0) ? 0.5 : 1;
    t.cooldown = stats.cooldown * cdMult;
    fireAt(t, sortedTargets, stats, color, s);
    // TowerEcho (Phase E): a second shot follows immediately. Re-evaluates
    // in-range (the first volley may have killed the target).
    if (effectActive(s, 'TowerEcho')) {
      const inRange2 = sortedTargets.filter((x) => x.e.hp > 0);
      if (inRange2.length) fireAt(t, inRange2, stats, color, s);
    }
  }

  s.projectiles = s.projectiles.filter((p) => p.until > s.time);
  s.fx = s.fx.filter((f) => f.until > s.time);

  // Resolve deaths & rewards
  const goldAuraActive = s.towers.some((t) => {
    if (t.kind !== 'special') return false;
    const r = SPECIAL_BY_ID[t.specialId];
    return r && r.stats.goldAura;
  });
  const diffGold = (s.difficulty || DIFFICULTIES[DEFAULT_DIFFICULTY]).goldMul;
  const blessing = effectActive(s, 'GoldBlessing') ? 1.5 : 1;
  const goldMul = (goldAuraActive ? 2 : 1) * diffGold * (s.rewardMult || 1) * blessing;

  const alive = [];
  for (const e of s.enemies) {
    if (e.hp <= 0) {
      if (e.subPath && e.pathIdx < e.subPath.length) {
        // Anti-farm gate for streak only (doc §54.3): a too-quick-too-shallow
        // kill still pays gold, just doesn't extend the killstreak ladder.
        const pathFrac = e.subPath.length > 0 ? e.pathIdx / e.subPath.length : 1;
        const aliveSec = s.time - (e.spawnedAt || s.time);
        const validForStreak = pathFrac >= STREAK_MIN_PATH_FRACTION || aliveSec >= STREAK_MIN_ALIVE_SECONDS;
        if (validForStreak) s.killStreak += 1;
        playSound('kill', 0.05);
        const perKill = killGoldFor(e.type, s.wave);
        const reward = Math.max(1, Math.round(perKill * goldMul * streakMult(s.killStreak)));
        s.gold += reward;
        s.score += perKill * 4;
        // Emerald P6 rule-break (doc §A8.Emerald): poison spreads on kill to
        // enemies within 3 tiles, 12s remaining. _spreadCopy on the effect
        // prevents recursive spreading.
        const ep = e.effects && e.effects.find((ef) => ef.type === 'poison' && ef.source === 'emerald-p6' && !ef._spreadCopy);
        if (ep) {
          for (const o of s.enemies) {
            if (o === e || o.hp <= 0) continue;
            const dr = o.r - e.r, dc = o.c - e.c;
            if (dr * dr + dc * dc > 9) continue;          // 3 tiles
            o.effects = o.effects.filter((ef) => ef.type !== 'poison');
            o.effects.push({ type: 'poison', dps: ep.dps, until: s.time + 12, source: 'emerald-p6', _spreadCopy: true });
          }
        }
        // Death burst: 8 particles radiating outward
        const def = ENEMIES[e.type];
        const burstCount = e.type === 'boss' || e.type === 'mega' ? 16 : 8;
        for (let i = 0; i < burstCount; i++) {
          const angle = (i / burstCount) * Math.PI * 2 + Math.random() * 0.4;
          const speed = 30 + Math.random() * 50;
          s.fx.push({
            id: s.nextFxId++,
            type: 'death',
            x: e.c * TILE + TILE / 2,
            y: e.r * TILE + TILE / 2,
            vx: Math.cos(angle) * speed,
            vy: Math.sin(angle) * speed,
            color: def.color,
            start: s.time,
            until: s.time + 0.55,
          });
        }
      }
    } else {
      alive.push(e);
    }
  }
  s.enemies = alive;

  // Wave end?
  if (s.spawnQueue.length === 0 && s.enemies.length === 0) {
    // Boss lump bonus removed — doc §54.2 V4 pays boss reward per-kill at 5×,
    // already credited above via killGoldFor.
    s.killStreak = 0;                  // doc §54.3: streak resets on wave clear
    playSound('wave_clear');
    s.score += 50 + s.wave * 10;
    // HealOverTime (Phase E): +1 life per wave for up to 5 waves.
    if (s.healOverTimeWaves > 0) {
      s.lives += 1;
      s.healOverTimeWaves -= 1;
    }
    s.flash = { text: `Wave ${s.wave} cleared!`, until: s.time + 2.0 };

    if (s.wave >= s.totalWaves) {
      playSound('victory');
      onEnd(true, s.score, s.wave);
      return;
    }
    // Return to build phase for the NEXT wave
    s.phase = 'placing';
    s.placementsThisRound = 0;
    s.candidates = [];
    s.playerLevel = levelForWave(s.wave + 1);
  }

  if (s.lives <= 0) { playSound('defeat'); onEnd(false, s.score, s.wave); }
}

function fireAt(tower, inRange, stats, color, s) {
  playSound('shot', 0.08);   // throttle so swarm fire doesn't spam audio
  // Muzzle flash at tower
  s.fx.push({
    id: s.nextFxId++,
    type: 'muzzle',
    x: tower.c * TILE + TILE / 2,
    y: tower.r * TILE + TILE / 2,
    color,
    start: s.time,
    until: s.time + 0.16,
  });
  // P5 synergy multiplier (doc §A7) — same for every hit this attack.
  const synMult = p5SynergyMult(tower, s);
  const p6 = p6Family(tower);
  // P6 rule-break: Amethyst doubles armor reduction (doc §A8.Amethyst).
  const effArmorBreak = (stats.armorBreak || 0) * (p6 === 'amethyst' ? 2 : 1);
  // Phase E active effects on the volley:
  const dmgBoost = effectActive(s, 'DamageBoost') ? 2 : 1;
  const critForced = effectActive(s, 'CritBoost');
  const handleHit = (enemy, dmg) => {
    const dmgType = towerDamageType(tower);
    if (enemy.evasion && dmgType === 'physical' && p6 !== 'diamond' && !critForced && Math.random() < enemy.evasion) {
      s.fx.push({
        id: s.nextFxId++,
        type: 'impact',
        x: enemy.c * TILE + TILE / 2,
        y: enemy.r * TILE + TILE / 2,
        color: '#cfd5e6',
        start: s.time,
        until: s.time + 0.18,
      });
      s.fx.push({
        id: s.nextFxId++,
        type: 'text',
        x: enemy.c * TILE + TILE / 2,
        y: enemy.r * TILE + TILE / 2 - 6,
        text: 'MISS',
        color: '#ffd166',
        start: s.time,
        until: s.time + 0.55,
      });
      return;
    }
    s.fx.push({
      id: s.nextFxId++,
      type: 'impact',
      x: enemy.c * TILE + TILE / 2,
      y: enemy.r * TILE + TILE / 2,
      color,
      start: s.time,
      until: s.time + 0.28,
    });
    // Resist (doc §53.4) → optional armor bypass (Diamond P6 / CritBoost crit) → armor.
    const typed = dmg * synMult * dmgBoost * damageMultByType(enemy, dmgType);
    let reduced;
    if (p6 === 'diamond' || critForced) {
      reduced = typed;                                   // crit / Diamond P6: bypass armor
    } else {
      const effectiveArmor = Math.max(0, enemy.armor - effArmorBreak);
      reduced = typed * (100 / (100 + effectiveArmor * 6));
    }
    if (enemy.shieldHp > 0) {
      const shieldTake = Math.min(enemy.shieldHp, reduced);
      enemy.shieldHp -= shieldTake;
      reduced -= shieldTake;
      if (shieldTake > 0) {
        s.fx.push({
          id: s.nextFxId++,
          type: 'shield',
          x: enemy.c * TILE + TILE / 2,
          y: enemy.r * TILE + TILE / 2,
          start: s.time,
          until: s.time + 0.35,
        });
        if (enemy.shieldHp <= 0) {
          s.fx.push({
            id: s.nextFxId++,
            type: 'text',
            x: enemy.c * TILE + TILE / 2,
            y: enemy.r * TILE + TILE / 2 - 8,
            text: 'BREAK',
            color: '#7be5d1',
            start: s.time,
            until: s.time + 0.65,
          });
        }
      }
    }
    enemy.hp -= reduced;
    if ((enemy.type === 'boss' || enemy.type === 'mega' || reduced >= (enemy.maxHp || 1) * 0.08) && reduced > 1) {
      s.fx.push({
        id: s.nextFxId++,
        type: 'text',
        x: enemy.c * TILE + TILE / 2,
        y: enemy.r * TILE + TILE / 2 - 10,
        text: `${Math.round(reduced)}`,
        color: critForced || p6 === 'diamond' ? '#ffd166' : '#fff',
        big: critForced || p6 === 'diamond',
        start: s.time,
        until: s.time + 0.5,
      });
    }
    if (enemy.reactiveArmor) {
      enemy._reactiveHits = (enemy._reactiveHits || 0) + 1;
      if (enemy._reactiveHits % 5 === 0) enemy.armor = Math.min(80, (enemy.armor || 0) + 2);
    }
    enemy._lastDmgT = s.time;                            // RegenWaves idle tracker
    // SplitEvolution mutation (doc §A.1b): 6% per hit, max 1 split per enemy.
    if (s.activeMutations.includes('SplitEvolution') && !enemy._splitDone && enemy.hp > 0 && Math.random() < MUT_SPLIT_CHANCE) {
      enemy._splitDone = true;
      const halfHp = Math.max(1, Math.floor((enemy.maxHp || enemy.hp) * 0.5));
      s.enemies.push({
        ...enemy,
        id: s.nextEnemyId++,
        hp: halfHp, maxHp: halfHp,
        effects: [],
        _splitDone: true,
      });
    }
    // Slow — Sapphire P6 pushes slow factor to 0.05 (= 95% slow, doc §A8.Sapphire).
    if (typeof stats.slow === 'number' && stats.slow > 0) {
      const factor = p6 === 'sapphire' ? 0.05 : 1 - stats.slow;
      enemy.effects = enemy.effects.filter((ef) => ef.type !== 'slow');
      enemy.effects.push({ type: 'slow', factor, until: s.time + 1.2 });
    } else if (stats.slow && typeof stats.slow === 'object') {
      enemy.effects = enemy.effects.filter((ef) => ef.type !== 'slow');
      enemy.effects.push({ type: 'slow', factor: stats.slow.factor, until: s.time + stats.slow.duration });
    }
    if (stats.poison) {
      enemy.effects = enemy.effects.filter((ef) => ef.type !== 'poison');
      enemy.effects.push({
        type: 'poison',
        dps: stats.poison.dps,
        until: s.time + stats.poison.duration,
        source: p6 === 'emerald' ? 'emerald-p6' : null,  // doc §A8.Emerald spread-on-kill marker
      });
    }
  };

  // P6 rule-break: Topaz P6 fires +2 targets (5 total — doc §A8.Topaz).
  const effMulti = stats.multi ? stats.multi + (p6 === 'topaz' ? 2 : 0) : 0;
  // P6 rule-break: Ruby P6 turns splash into a 5-hop chain (doc §A8.Ruby).
  const rubyP6Chain = p6 === 'ruby' && stats.splash;

  if (effMulti) {
    const targets = inRange.slice(0, effMulti);
    for (const { e } of targets) {
      handleHit(e, stats.damage);
      s.projectiles.push(makeProjectile(tower, e, color, s));
    }
  } else if (stats.chain || rubyP6Chain) {
    // Ruby P6: 5 hops, -25% damage per hop. Standard chain: stats.chain hops, -30%.
    const hops = rubyP6Chain ? 5 : stats.chain;
    const decay = rubyP6Chain ? 0.75 : 0.7;
    let prev = inRange[0].e;
    let mult = 1;
    handleHit(prev, stats.damage * mult);
    s.projectiles.push(makeProjectile(tower, prev, color, s));
    const hit = new Set([prev.id]);
    for (let h = 1; h < hops; h++) {
      mult *= decay;
      let best = null, bestD = Infinity;
      for (const e of s.enemies) {
        if (hit.has(e.id) || e.hp <= 0) continue;
        const d = Math.hypot(e.r - prev.r, e.c - prev.c);
        if (d <= stats.range && d < bestD) { best = e; bestD = d; }
      }
      if (!best) break;
      handleHit(best, stats.damage * mult);
      s.projectiles.push({
        id: s.nextProjectileId++,
        fromX: prev.c * TILE + TILE / 2, fromY: prev.r * TILE + TILE / 2,
        toX: best.c * TILE + TILE / 2, toY: best.r * TILE + TILE / 2,
        color, until: s.time + 0.08,
      });
      hit.add(best.id);
      prev = best;
    }
  } else {
    const target = inRange[0].e;
    handleHit(target, stats.damage);
    s.projectiles.push(makeProjectile(tower, target, color, s));
    if (stats.splash) {
      for (const e of s.enemies) {
        if (e === target || e.hp <= 0) continue;
        const d = Math.hypot(e.r - target.r, e.c - target.c);
        if (d <= stats.splash) handleHit(e, stats.damage * 0.6);
      }
    }
  }
}

function makeProjectile(tower, enemy, color, s) {
  return {
    id: s.nextProjectileId++,
    fromX: tower.c * TILE + TILE / 2, fromY: tower.r * TILE + TILE / 2,
    toX: enemy.c * TILE + TILE / 2, toY: enemy.r * TILE + TILE / 2,
    color, until: s.time + 0.08,
  };
}

function ActiveStatusStrip({ items }) {
  if (!items || items.length === 0) return null;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={{ maxHeight: 28, backgroundColor: '#090d1dee', borderBottomWidth: 1, borderBottomColor: '#202949' }}
      contentContainerStyle={{ paddingHorizontal: 8, paddingVertical: 4, gap: 6 }}
    >
      {items.map((item) => (
        <View key={item.id} style={{
          borderRadius: 5,
          borderWidth: 1,
          borderColor: item.color,
          backgroundColor: '#101630',
          paddingHorizontal: 7,
          height: 20,
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'row',
          gap: 4,
        }}>
          <View style={{ width: 5, height: 5, borderRadius: 5, backgroundColor: item.color }} />
          <Text numberOfLines={1} style={{ color: item.color, fontSize: 9, fontWeight: '900' }}>
            {item.label.toUpperCase()}{item.time ? ` ${item.time}s` : ''}
          </Text>
        </View>
      ))}
    </ScrollView>
  );
}

function BoardActionTray({ actions, cooldown, onAction }) {
  if (!actions || actions.length === 0) return null;
  const visible = actions.slice(0, 3);
  return (
    <View pointerEvents="box-none" style={{
      position: 'absolute',
      top: 10,
      left: 12,
      right: 12,
      alignItems: 'center',
      zIndex: 20,
      gap: 6,
    }}>
      <View style={{
        borderRadius: 4,
        backgroundColor: '#070a14dd',
        borderWidth: 1,
        borderColor: '#3a2818',
        paddingHorizontal: 8,
        paddingVertical: 2,
      }}>
        <Text style={{ color: '#ffd166', fontSize: 8, fontWeight: '900', letterSpacing: 1.2 }}>BOARD ACTION</Text>
      </View>
      {visible.map((action) => {
        const enabled = action.affordable && cooldown <= 0;
        const kindColor = action.kind === 'recipe' ? '#b08bff' : action.kind === 'chain' ? '#7be5d1' : '#ffd166';
        return (
          <TouchableOpacity
            key={action.signature}
            disabled={!enabled}
            onPress={() => onAction(action)}
            activeOpacity={0.8}
            style={{
              maxWidth: Math.min(360, VIEWPORT_W - 36),
              borderRadius: 6,
              borderWidth: 1.5,
              borderColor: enabled ? kindColor : '#4a3c1a',
              backgroundColor: enabled ? '#282318ee' : '#16130dee',
              paddingVertical: 6,
              paddingHorizontal: 10,
              opacity: enabled ? 1 : 0.72,
              shadowColor: kindColor,
              shadowOpacity: enabled ? 0.35 : 0,
              shadowRadius: 6,
              shadowOffset: { width: 0, height: 0 },
            }}
          >
            <Text numberOfLines={1} style={{ color: enabled ? kindColor : '#9a8750', fontSize: 11, fontWeight: '900', textAlign: 'center' }}>
              {action.label}
            </Text>
            {(action.cost > 0 || cooldown > 0) && (
              <Text style={{ color: '#cfd5e6', fontSize: 9, textAlign: 'center', marginTop: 1 }}>
                {cooldown > 0 ? `${cooldown.toFixed(1)}s` : `${action.cost}g`}
              </Text>
            )}
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

function TutorialCard({ tutorial, onNext, onSkip }) {
  if (!tutorial) return null;
  return (
    <View style={{
      position: 'absolute',
      left: 12,
      right: 12,
      bottom: 12,
      zIndex: 25,
      borderRadius: 8,
      borderWidth: 1.5,
      borderColor: '#ffd166',
      backgroundColor: '#101630ee',
      padding: 10,
    }}>
      <Text style={{ color: '#ffd166', fontSize: 12, fontWeight: '900' }}>{tutorial.title}</Text>
      <Text style={{ color: '#dfe5ff', fontSize: 12, lineHeight: 17, marginTop: 3 }}>{tutorial.body}</Text>
      <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
        <TouchableOpacity onPress={onSkip} style={{ paddingVertical: 6, paddingHorizontal: 10 }}>
          <Text style={{ color: '#9aa3c7', fontSize: 11, fontWeight: '800' }}>SKIP</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={onNext} style={{ paddingVertical: 6, paddingHorizontal: 12, borderRadius: 6, backgroundColor: '#ffd166' }}>
          <Text style={{ color: '#17120a', fontSize: 11, fontWeight: '900' }}>NEXT</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  lobbyRoot: {
    flex: 1, backgroundColor: '#0b1020',
    paddingHorizontal: 18, paddingTop: 24, paddingBottom: 12,
    // justifyContent removed — ScrollView handles vertical layout now
  },
  lobbyHeader: { alignItems: 'center', marginTop: 12 },
  // Wood-sign banner for the lobby title — dark wood gradient via stacked colors,
  // gold trim on all sides, four corner studs, hanging chains.
  titleBannerWrap: {
    alignItems: 'center', marginTop: 16, marginBottom: 8,
    paddingHorizontal: 18, position: 'relative',
  },
  titleChain: {
    position: 'absolute', top: -8, width: 3, height: 24,
    backgroundColor: '#6a6470',
    borderLeftWidth: 1, borderLeftColor: '#3a3848',
    borderRightWidth: 1, borderRightColor: '#9aa3c7',
  },
  titleBanner: {
    backgroundColor: '#3a2818',
    borderWidth: 3, borderColor: '#1a0c08',
    borderRadius: 12,
    padding: 4,
    shadowColor: '#000', shadowOpacity: 0.7, shadowRadius: 12, shadowOffset: { width: 0, height: 6 },
    elevation: 8,
    position: 'relative',
  },
  titleBannerInner: {
    backgroundColor: '#2a1a08',
    borderWidth: 2, borderColor: '#ffd166',
    borderRadius: 8,
    paddingHorizontal: 28, paddingVertical: 14,
    alignItems: 'center',
  },
  cornerStud: {
    position: 'absolute',
    width: 10, height: 10, borderRadius: 5,
    backgroundColor: '#ffd166',
    borderWidth: 1.5, borderColor: '#b89020',
    zIndex: 10,
    shadowColor: '#ffd166', shadowOpacity: 0.6, shadowRadius: 3, shadowOffset: { width: 0, height: 0 },
  },
  lobbyCrystalRow: { flexDirection: 'row', marginBottom: 6 },
  lobbyCrystal: {
    fontSize: 28, marginHorizontal: 4,
    textShadowColor: '#000a', textShadowOffset: { width: 0, height: 2 }, textShadowRadius: 3,
  },
  lobbyTitle: {
    color: '#ffd166', fontSize: 34, fontWeight: '900', letterSpacing: 2,
    textShadowColor: '#000', textShadowOffset: { width: 0, height: 2 }, textShadowRadius: 4,
  },
  lobbySubtitle: {
    color: '#cfd5e6', fontSize: 11, letterSpacing: 8, marginTop: 4, fontWeight: '700',
  },

  statsCard: {
    backgroundColor: '#2a1a08', borderRadius: 14, padding: 14,
    borderWidth: 3, borderColor: '#1a0c08',
    shadowColor: '#000', shadowOpacity: 0.6, shadowRadius: 10, shadowOffset: { width: 0, height: 4 },
    elevation: 6,
    position: 'relative',
  },
  statsCardLabel: {
    color: '#ffd166', fontSize: 11, letterSpacing: 3, fontWeight: '900',
    marginBottom: 12, textAlign: 'center',
    textShadowColor: '#000', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 2,
  },
  statsRow: { flexDirection: 'row', justifyContent: 'space-around', marginBottom: 6 },
  // Medallion-style stat tile: circular dark base with gold ring + big value + label below
  statTile: {
    flex: 1, alignItems: 'center', paddingVertical: 4, paddingHorizontal: 4,
  },
  statTileMedallion: {
    width: 72, height: 72, borderRadius: 36,
    backgroundColor: '#161c33',
    borderWidth: 3, borderColor: '#ffd166',
    alignItems: 'center', justifyContent: 'center',
    shadowColor: '#000', shadowOpacity: 0.7, shadowRadius: 6, shadowOffset: { width: 0, height: 3 },
  },
  statTileMedallionInner: {
    position: 'absolute',
    width: 64, height: 64, borderRadius: 32,
    borderWidth: 1, borderColor: '#b89020', opacity: 0.7,
  },
  statTileLabel: {
    color: '#ffd166', fontSize: 10, letterSpacing: 1.5, fontWeight: '800',
    marginTop: 6, textAlign: 'center',
  },
  statTileValue: {
    fontSize: 18, fontWeight: '900',
    textShadowColor: '#000', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 2,
  },
  statsHint: { color: '#cfd5e6', fontSize: 11, textAlign: 'center', fontStyle: 'italic', marginTop: 8, opacity: 0.8 },
  newBestText: { color: '#ffd166', fontSize: 14, fontWeight: '900', letterSpacing: 2, textAlign: 'center', marginTop: 8 },

  modeList: { gap: 10 },
  soloHeader: {
    color: '#ffd166', fontSize: 11, fontWeight: '900',
    letterSpacing: 3, marginBottom: 6, marginLeft: 4,
    textShadowColor: '#000', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 2,
  },
  diffBtn: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#2a1a08',
    borderRadius: 12, padding: 13, paddingLeft: 18,
    borderWidth: 2.5,
    shadowColor: '#000', shadowOpacity: 0.65, shadowRadius: 8, shadowOffset: { width: 0, height: 4 },
    position: 'relative',
  },
  diffName: {
    fontSize: 17, fontWeight: '900', letterSpacing: 1.8,
    textShadowColor: '#000', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 2,
  },
  diffShort: { color: '#cfd5e6', fontSize: 11, fontStyle: 'italic' },
  diffTagline: { color: '#e8e0c8', fontSize: 11, marginTop: 3, opacity: 0.92 },
  diffStats: { color: '#c4a878', fontSize: 9.5, marginTop: 4, letterSpacing: 0.5, fontWeight: '700' },
  diffCornerGem: {
    position: 'absolute', width: 5, height: 5, borderRadius: 3,
    zIndex: 8,
    shadowOpacity: 0.9, shadowRadius: 2, shadowOffset: { width: 0, height: 0 },
  },
  diffRibbon: {
    position: 'absolute', left: 0, top: 0, bottom: 0, width: 5,
    borderTopLeftRadius: 12, borderBottomLeftRadius: 12,
  },
  diffStrip: {
    flexDirection: 'row', justifyContent: 'center',
    paddingBottom: 4,
  },
  diffPill: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 8, paddingVertical: 3,
    borderRadius: 12, borderWidth: 1,
    alignSelf: 'center',
  },
  diffPillDot: { width: 6, height: 6, borderRadius: 3, marginRight: 6 },
  diffPillText: { fontSize: 10, fontWeight: '800', letterSpacing: 1.5 },
  modeBtnPrimary: {
    backgroundColor: '#4cc9ff', paddingHorizontal: 20, paddingVertical: 18,
    borderRadius: 16, flexDirection: 'row', alignItems: 'center',
    shadowColor: '#4cc9ff', shadowOpacity: 0.5, shadowRadius: 14, shadowOffset: { width: 0, height: 4 }, elevation: 6,
  },
  modeBtnTitlePrimary: { color: '#0b1020', fontSize: 20, fontWeight: '900', letterSpacing: 2 },
  modeBtnSubPrimary: { color: '#0b1020', fontSize: 12, opacity: 0.7, marginTop: 2 },
  modeBtnArrow: { color: '#0b1020', fontSize: 22, fontWeight: '900' },
  modeBtnSecondary: {
    backgroundColor: '#2a335f', paddingHorizontal: 20, paddingVertical: 16,
    borderRadius: 16, alignItems: 'center', marginTop: 8,
  },
  modeBtnTitleSecondary: { color: '#fff', fontSize: 14, fontWeight: '800', letterSpacing: 2 },
  modeBtnLocked: {
    backgroundColor: '#161c33', paddingHorizontal: 20, paddingVertical: 16,
    borderRadius: 16, flexDirection: 'row', alignItems: 'center',
    borderWidth: 1, borderColor: '#2a335f', opacity: 0.7,
  },
  modeBtnTitleLocked: { color: '#9aa3c7', fontSize: 16, fontWeight: '800', letterSpacing: 1.5 },
  modeBtnSubLocked: { color: '#7c84a8', fontSize: 12, marginTop: 2 },
  modeBtnLock: { fontSize: 18 },

  lobbyFooter: {
    flexDirection: 'row', justifyContent: 'space-around',
    paddingTop: 8, borderTopWidth: 1, borderTopColor: '#161c33',
  },
  footerBtn: {
    alignItems: 'center', paddingVertical: 8, paddingHorizontal: 14,
    backgroundColor: '#2a1a08',
    borderWidth: 2, borderColor: '#1a0c08',
    borderTopWidth: 2, borderTopColor: '#ffd166',
    borderRadius: 10,
    shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 4, shadowOffset: { width: 0, height: 2 },
  },
  footerIcon: {
    color: '#ffd166', fontSize: 20,
    textShadowColor: '#000', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 2,
  },
  footerLabel: { color: '#ffd166', fontSize: 10, letterSpacing: 1.5, marginTop: 3, fontWeight: '800' },
  footerVersion: { color: '#cfd5e6', fontSize: 11, fontWeight: '700' },

  gameRoot: { flex: 1, backgroundColor: '#0b1020' },
  hud: {
    flexDirection: 'row', justifyContent: 'space-around',
    paddingVertical: 10, paddingHorizontal: 8,
    backgroundColor: '#1a0c08',
    borderBottomWidth: 3, borderBottomColor: '#3a2818',
    shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 6, shadowOffset: { width: 0, height: 3 },
  },
  hudStat: { alignItems: 'center', minWidth: 60 },
  // Carved-stone plaque around each HUD value — dark base, coloured rim
  hudStatPlaque: {
    minWidth: 56, paddingVertical: 4, paddingHorizontal: 10,
    backgroundColor: '#0a0e1c',
    borderRadius: 10,
    borderWidth: 2,
    alignItems: 'center', justifyContent: 'center',
    shadowColor: '#000', shadowOpacity: 0.6, shadowRadius: 4, shadowOffset: { width: 0, height: 2 },
  },
  hudLabel: { fontSize: 9, letterSpacing: 2, fontWeight: '800', marginTop: 3 },
  hudValue: { fontSize: 20, fontWeight: '900', textShadowColor: '#000', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 2 },

  marker: { position: 'absolute', width: TILE, height: TILE, alignItems: 'center', justifyContent: 'center' },
  markerText: { color: '#fff', fontSize: TILE * 0.55, opacity: 0.6, fontWeight: '700' },

  recenterBtn: {
    position: 'absolute', right: 12, bottom: 12,
    width: 44, height: 44, backgroundColor: '#161c33e0',
    borderRadius: 22, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: '#2a335f',
  },
  recenterText: { color: '#fff', fontSize: 22, fontWeight: '800' },
  tiltBtn: {
    position: 'absolute', right: 12, bottom: 64,
    width: 44, height: 44, backgroundColor: '#161c33e0',
    borderRadius: 22, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: '#2a335f',
  },
  tiltBtnText: { color: '#ffd166', fontSize: 14, fontWeight: '800', letterSpacing: 1 },

  bottomBar: {
    paddingHorizontal: 12, paddingTop: 14, paddingBottom: 14,
    alignItems: 'center',
    backgroundColor: '#1a0c08',
    borderTopWidth: 3, borderTopColor: '#3a2818',
    shadowColor: '#000', shadowOpacity: 0.6, shadowRadius: 8, shadowOffset: { width: 0, height: -4 },
  },
  phaseBadge: {
    backgroundColor: '#4cc9ff',
    paddingHorizontal: 18, paddingVertical: 5,
    borderRadius: 999, marginBottom: 8,
    borderWidth: 2, borderColor: '#1a0c08',
    shadowColor: '#4cc9ff', shadowOpacity: 0.7, shadowRadius: 8, shadowOffset: { width: 0, height: 0 },
  },
  phaseBadgeText: {
    color: '#0b1020', fontWeight: '900', fontSize: 12, letterSpacing: 2,
    textShadowColor: '#fff6', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 1,
  },
  bottomMessage: {
    color: '#e8e0c8', fontSize: 13, fontWeight: '700',
    textAlign: 'center', letterSpacing: 0.5,
    textShadowColor: '#000', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 2,
  },
  bottomRow: { marginTop: 8 },
  speedBtn: {
    backgroundColor: '#2a335f', width: 56, height: 36,
    borderRadius: 18, alignItems: 'center', justifyContent: 'center',
  },
  speedBtnText: { color: '#fff', fontWeight: '800', fontSize: 14 },

  flashWrap: { position: 'absolute', top: 16, left: 0, right: 0, alignItems: 'center' },
  flashText: {
    color: '#fff', backgroundColor: '#000c',
    paddingHorizontal: 16, paddingVertical: 8, borderRadius: 8,
    fontSize: 14, fontWeight: '800', overflow: 'hidden',
  },

  modalBackdrop: { flex: 1, backgroundColor: '#000c', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 20 },
  modalCard: {
    backgroundColor: '#161c33', borderRadius: 18,
    padding: 22, paddingTop: 28,
    width: '100%', maxWidth: 420,
    borderWidth: 3, borderColor: '#1a0c08',
    borderTopWidth: 5, borderTopColor: '#ffd166',
    borderBottomWidth: 5, borderBottomColor: '#ffd166',
    shadowColor: '#000', shadowOpacity: 0.85, shadowRadius: 28, shadowOffset: { width: 0, height: 14 },
    position: 'relative',
  },
  modalCloseX: {
    position: 'absolute', top: 8, right: 8,
    width: 40, height: 40, borderRadius: 20,
    alignItems: 'center', justifyContent: 'center', zIndex: 10,
  },
  modalCloseXText: { color: '#9aa3c7', fontSize: 22, fontWeight: '700' },
  modalHeaderRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 10, paddingRight: 32 },
  modalTitle: { color: '#fff', fontSize: 24, fontWeight: '900', letterSpacing: 0.5 },
  modalSub: { color: '#9aa3c7', fontSize: 12, marginTop: 4, letterSpacing: 0.5 },
  modalRow: {
    flexDirection: 'row', justifyContent: 'space-around',
    marginVertical: 14, backgroundColor: '#0f1530',
    borderRadius: 14, paddingVertical: 14,
    borderWidth: 1, borderColor: '#1f2a4a',
  },
  modalStat: { alignItems: 'center', flex: 1 },
  modalStatLabel: { color: '#7c84a8', fontSize: 10, letterSpacing: 2, fontWeight: '700' },
  modalStatValue: { color: '#fff', fontSize: 18, fontWeight: '900', marginTop: 4 },
  combineHint: { color: '#9aa3c7', fontSize: 13, textAlign: 'center', marginBottom: 14, lineHeight: 18 },

  actionRowBtn: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#0f1530', padding: 14, borderRadius: 14,
    borderWidth: 2,
    shadowColor: '#000', shadowOpacity: 0.4, shadowRadius: 6, shadowOffset: { width: 0, height: 3 },
  },
  actionRowLabel: { fontSize: 15, fontWeight: '900', letterSpacing: 1.8 },
  actionRowDesc: { color: '#9aa3c7', fontSize: 12, marginTop: 3 },
  actionRowArrow: { fontSize: 20, fontWeight: '900', marginLeft: 8 },

  specialIcon: {
    width: 36, height: 36, borderRadius: 18, borderWidth: 2,
    alignItems: 'center', justifyContent: 'center', marginRight: 14,
  },
  specialIconStar: {
    color: '#fff', fontSize: 18, fontWeight: '900',
    textShadowColor: '#000a', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 2,
  },

  craftSection: { marginTop: 16, paddingTop: 12, borderTopWidth: 1, borderTopColor: '#2a335f' },
  craftSectionLabel: {
    color: '#ffd166', fontSize: 12, letterSpacing: 1.5, fontWeight: '800',
    marginBottom: 8, textAlign: 'center',
  },
  craftBtn: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#0f1530', padding: 10, paddingRight: 14,
    borderRadius: 12, marginBottom: 8, borderWidth: 1.5,
  },
  craftIcon: {
    width: 32, height: 32, borderRadius: 16, borderWidth: 2,
    alignItems: 'center', justifyContent: 'center', marginRight: 12,
  },
  craftBtnName: { color: '#fff', fontSize: 14, fontWeight: '800' },
  craftBtnDesc: { color: '#9aa3c7', fontSize: 12, marginTop: 1 },
  craftBtnCost: { fontSize: 11, fontWeight: '800', marginTop: 3, letterSpacing: 0.5 },
  craftBtnArrow: { color: '#ffd166', fontSize: 18, fontWeight: '900', marginLeft: 6 },

  recipeBookCard: {
    backgroundColor: '#161c33', borderRadius: 18, padding: 0,
    width: '100%', maxWidth: 480, maxHeight: '85%',
    borderWidth: 1, borderColor: '#2a335f', overflow: 'hidden',
  },
  recipeBookHeader: {
    paddingHorizontal: 20, paddingTop: 20, paddingBottom: 12,
    borderBottomWidth: 1, borderBottomColor: '#2a335f',
    flexDirection: 'row', alignItems: 'center',
  },
  recipeBookTitle: { color: '#fff', fontSize: 22, fontWeight: '900', letterSpacing: 1, flex: 1 },
  recipeBookList: { paddingHorizontal: 14, paddingVertical: 10 },
  recipeBookSection: {
    color: '#ffd166', fontSize: 13, letterSpacing: 2, fontWeight: '800',
    marginTop: 10, marginBottom: 6, paddingHorizontal: 6,
  },
  recipeRow: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#0f1530', padding: 10, borderRadius: 10,
    marginBottom: 6, borderWidth: 1,
  },
  recipeRowText: { flex: 1, marginLeft: 10 },
  recipeRowName: { color: '#fff', fontSize: 14, fontWeight: '800' },
  recipeRowDesc: { color: '#9aa3c7', fontSize: 11, marginTop: 2 },
  recipeRowIngredients: { color: '#7c84a8', fontSize: 11, marginTop: 4, fontStyle: 'italic' },
});
