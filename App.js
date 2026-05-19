import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  StyleSheet,
  Text,
  View,
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
const STARTING_LIVES = 20;
const MAX_PLACEMENTS = 5;
const STONE_REFUND = 0;     // rocks can't be sold under standard rules
const NUM_WAVES = 50;

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

// ─── Roll odds by player level (design doc §10) ─────────────────────────────
// Each row is [P1, P2, P3, P4, P5]. P6 only via merge/recipe.
const ROLL_ODDS = [
  /* level 1 */ [1.00, 0.00, 0.00, 0.00, 0.00],
  /* level 2 */ [0.70, 0.30, 0.00, 0.00, 0.00],
  /* level 3 */ [0.50, 0.30, 0.20, 0.00, 0.00],
  /* level 4 */ [0.30, 0.30, 0.30, 0.10, 0.00],
  /* level 5+*/ [0.10, 0.20, 0.30, 0.30, 0.10],
];
function rollPurity(level) {
  const row = ROLL_ODDS[Math.min(level, 5) - 1];
  const r = Math.random();
  let cum = 0;
  for (let i = 0; i < row.length; i++) {
    cum += row[i];
    if (r < cum) return i + 1;
  }
  return 1;
}
// Player level grows every 4 waves: L1 W1-4, L2 W5-8, L3 W9-12, L4 W13-16, L5 W17+
function levelForWave(wave) {
  return Math.min(5, Math.floor((wave - 1) / 4) + 1);
}

// ─── Kill gold curve (design doc §16) ────────────────────────────────────────
const KILL_GOLD_BY_WAVE = [
  0, 1, 1, 2, 2, 3, 4, 5, 6, 8, 10,    // waves 1-10
  11, 12, 14, 16, 18, 19, 20, 22, 25, 30,   // 11-20
  28, 32, 36, 40, 44, 48, 52, 58, 64, 75,   // 21-30
  70, 78, 86, 95, 105, 116, 128, 140, 155, 180, // 31-40
  175, 195, 215, 235, 260, 290, 320, 350, 380, 500, // 41-50
];
const BOSS_GOLD_BONUS = {
  10: 250, 20: 1000, 30: 2500, 40: 6000, 50: 15000,
};

// ─── Gems (8 families, with letter codes per doc) ───────────────────────────
const GEMS = {
  sapphire:   { id: 'sapphire',   code: 'B', name: 'Sapphire',   color: '#4cc9ff', ability: 'Slow / control' },
  diamond:    { id: 'diamond',    code: 'D', name: 'Diamond',    color: '#e6f1ff', ability: 'High raw damage' },
  opal:       { id: 'opal',       code: 'E', name: 'Opal',       color: '#ffd4f0', ability: 'Aura / reveal' },
  emerald:    { id: 'emerald',    code: 'G', name: 'Emerald',    color: '#5cf28a', ability: 'Poison DoT' },
  amethyst:   { id: 'amethyst',   code: 'P', name: 'Amethyst',   color: '#b08bff', ability: 'Armor break' },
  aquamarine: { id: 'aquamarine', code: 'Q', name: 'Aquamarine', color: '#7be5d1', ability: 'Fast attack' },
  ruby:       { id: 'ruby',       code: 'R', name: 'Ruby',       color: '#ff4d6d', ability: 'Splash' },
  topaz:      { id: 'topaz',      code: 'Y', name: 'Topaz',      color: '#ffd166', ability: 'Split shot' },
};
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
    { damage: 12, range: 8, cooldown: 1.00, poison: { dps: 128,  duration: 5 } },
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
  { id: 'MoonsteelPrism', name: 'Moonsteel', tier: 'P2',
    color: '#d8e1f2', accent: '#7eb6ff',
    description: 'Single-target · armor break · light slow',
    ingredients: [
      { gemType: 'sapphire', tier: 2 }, { gemType: 'diamond', tier: 2 }, { gemType: 'topaz', tier: 2 },
    ],
    stats: { damage: 80, range: 8.5, cooldown: 0.7, armorBreak: 8, slow: { factor: 0.5, duration: 1.2 } },
  },
  { id: 'VerdantArcstone', name: 'Wildroot', tier: 'P2',
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
  { id: 'MoonsteelWarden', name: 'Lunar Warden', tier: 'P4',
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
  { id: 'CoralResonance', name: 'Coral Choir', tier: 'P5',
    color: '#7be5d1', accent: '#5cf28a',
    description: 'Harmony · multi-target · slow',
    ingredients: [
      { specialId: 'JadeVeilLens' }, { gemType: 'opal', tier: 4 }, { gemType: 'aquamarine', tier: 4 },
    ],
    stats: { damage: 180, range: 9.5, cooldown: 0.3, multi: 3, slow: { factor: 0.35, duration: 1.8 } },
  },
  { id: 'FrostsunEye', name: 'Frozen Sun', tier: 'P5',
    color: '#a8e0ff', accent: '#ffd166',
    description: 'Protector · chain · slow · versatile',
    ingredients: [
      { specialId: 'StormsplitReactor' }, { gemType: 'sapphire', tier: 4 }, { gemType: 'ruby', tier: 4 },
    ],
    stats: { damage: 240, range: 10, cooldown: 0.4, chain: 6, slow: { factor: 0.5, duration: 2 } },
  },
  { id: 'SovereignDiamondLens', name: 'Diamond Sovereign', tier: 'P6',
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

function ingredientLabel(ing) {
  if (ing.specialId) return SPECIAL_BY_ID[ing.specialId]?.name || ing.specialId;
  return `${GEMS[ing.gemType].name} ${tier(ing.tier).short}`;
}

// ─── Enemies ─────────────────────────────────────────────────────────────────
const ENEMIES = {
  grunt:  { hp: 30,    speed: 1.4, gold: 1, color: '#c4b9ff', size: 0.55, armor: 0, flying: false },
  runner: { hp: 18,    speed: 2.8, gold: 1, color: '#ffd166', size: 0.45, armor: 0, flying: false },
  tank:   { hp: 140,   speed: 0.8, gold: 2, color: '#7d8aa8', size: 0.7,  armor: 4, flying: false },
  swarm:  { hp: 12,    speed: 2.2, gold: 1, color: '#ff8fab', size: 0.4,  armor: 0, flying: false },
  flyer:  { hp: 40,    speed: 2.0, gold: 1, color: '#88f088', size: 0.5,  armor: 1, flying: true  },
  boss:   { hp: 2100,  speed: 1.0, gold: 6, color: '#ff4d6d', size: 0.9,  armor: 5, flying: false },
  mega:   { hp: 34000, speed: 1.0, gold: 30, color: '#ff2244', size: 1.1, armor: 9, flying: false },
};

// ─── Wave generator (50 waves) ───────────────────────────────────────────────
// Generates spawn lists + per-wave HP multiplier so we don't have to hand-tune
// every wave. Bosses on 10/20/30/40/50.
function buildWaves() {
  const waves = [];
  for (let w = 1; w <= NUM_WAVES; w++) {
    // Per-wave HP multiplier matches doc anchors:
    // W1 = 1, W10 ≈ 9, W20 ≈ 85, W30 ≈ 800, W40 ≈ 7500, W50 ≈ 70000
    const hpMul = Math.pow(1.25, w - 1);
    let spawns;
    if (w === 10) spawns = [['boss', 1, 0.5]];
    else if (w === 20) spawns = [['boss', 2, 3.0], ['swarm', 22, 0.18]];
    else if (w === 30) spawns = [['boss', 3, 2.5], ['flyer', 10, 0.6]];
    else if (w === 40) spawns = [['mega', 1, 0.0], ['boss', 3, 2.0]];
    else if (w === 50) spawns = [['mega', 2, 3.5], ['boss', 6, 1.5], ['flyer', 18, 0.3]];
    else {
      const count = Math.floor(8 + w * 0.9);
      const types = [];
      if (w >= 1) types.push(['grunt', count, 0.55]);
      if (w >= 4) types.push(['runner', Math.floor(count * 0.4), 0.4]);
      if (w >= 6 && w % 3 === 0) types.push(['swarm', Math.floor(count * 1.2), 0.18]);
      if (w >= 8 && w % 4 === 0) types.push(['tank', Math.max(1, Math.floor(w / 6)), 1.1]);
      if (w >= 12 && w % 5 === 0) types.push(['flyer', Math.floor(count * 0.5), 0.45]);
      spawns = types;
    }
    waves.push({ spawns, hpMul });
  }
  return waves;
}
const WAVES = buildWaves();

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
  const [lastResult, setLastResult] = useState({ won: false, score: 0, waveReached: 0 });
  const [stats, setStats] = useState({ bestScore: 0, bestWave: 0, gamesPlayed: 0, wins: 0 });

  const recordResult = (won, score, waveReached) => {
    setLastResult({ won, score, waveReached });
    setStats((prev) => ({
      bestScore: Math.max(prev.bestScore, score),
      bestWave: Math.max(prev.bestWave, waveReached),
      gamesPlayed: prev.gamesPlayed + 1,
      wins: prev.wins + (won ? 1 : 0),
    }));
    setScreen(won ? 'win' : 'lose');
  };

  if (screen === 'lobby') return <LobbyScreen stats={stats} onStartSolo={() => setScreen('game')} />;
  if (screen === 'win' || screen === 'lose') return (
    <EndScreen
      won={screen === 'win'}
      score={lastResult.score}
      waveReached={lastResult.waveReached}
      stats={stats}
      onPlayAgain={() => setScreen('game')}
      onLobby={() => setScreen('lobby')}
    />
  );
  return <Game onEnd={recordResult} />;
}

// ─── Lobby ───────────────────────────────────────────────────────────────────
function LobbyScreen({ stats, onStartSolo }) {
  const [recipeBookOpen, setRecipeBookOpen] = useState(false);
  return (
    <SafeAreaView style={styles.lobbyRoot}>
      <StatusBar barStyle="light-content" />
      <View style={styles.lobbyHeader}>
        <View style={styles.lobbyCrystalRow}>
          <Text style={[styles.lobbyCrystal, { color: '#ff4d6d' }]}>◆</Text>
          <Text style={[styles.lobbyCrystal, { color: '#4cc9ff' }]}>◆</Text>
          <Text style={[styles.lobbyCrystal, { color: '#5cf28a' }]}>◆</Text>
        </View>
        <Text style={styles.lobbyTitle}>Crystal Maze</Text>
        <Text style={styles.lobbySubtitle}>D E F E N C E</Text>
      </View>

      <View style={styles.statsCard}>
        <Text style={styles.statsCardLabel}>YOUR STATS</Text>
        <View style={styles.statsRow}>
          <StatTile label="BEST SCORE" value={stats.bestScore} color="#ffd166" />
          <StatTile label="HIGHEST WAVE" value={`${stats.bestWave}/${NUM_WAVES}`} color="#4cc9ff" />
        </View>
        <View style={styles.statsRow}>
          <StatTile label="GAMES" value={stats.gamesPlayed} color="#fff" />
          <StatTile label="WINS" value={stats.wins} color="#5cf28a" />
        </View>
        {stats.gamesPlayed === 0 && (
          <Text style={styles.statsHint}>No games yet. Tap SOLO to start.</Text>
        )}
      </View>

      <View style={styles.modeList}>
        <TouchableOpacity style={styles.modeBtnPrimary} onPress={onStartSolo} activeOpacity={0.85}>
          <View style={{ flex: 1 }}>
            <Text style={styles.modeBtnTitlePrimary}>SOLO</Text>
            <Text style={styles.modeBtnSubPrimary}>Defend 50 waves · 5 checkpoints</Text>
          </View>
          <Text style={styles.modeBtnArrow}>▶</Text>
        </TouchableOpacity>
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
      <Text style={styles.statTileLabel}>{label}</Text>
      <Text style={[styles.statTileValue, { color }]}>{value}</Text>
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

function EndScreen({ won, score, waveReached, stats, onPlayAgain, onLobby }) {
  const newBest = score > 0 && score === stats.bestScore;
  return (
    <SafeAreaView style={styles.lobbyRoot}>
      <StatusBar barStyle="light-content" />
      <View style={styles.lobbyHeader}>
        <Text style={[styles.lobbyCrystal, won ? { color: '#5cf28a' } : { color: '#ff4d6d' }]}>
          {won ? '★' : '✦'}
        </Text>
        <Text style={styles.lobbyTitle}>{won ? 'Victory' : 'Defeated'}</Text>
        <Text style={styles.lobbySubtitle}>
          {won ? 'The crystals shine on' : `Fell on wave ${waveReached}`}
        </Text>
      </View>
      <View style={styles.statsCard}>
        <Text style={styles.statsCardLabel}>THIS RUN</Text>
        <View style={styles.statsRow}>
          <StatTile label="SCORE" value={score} color="#ffd166" />
          <StatTile label="WAVE REACHED" value={`${waveReached}/${NUM_WAVES}`} color="#4cc9ff" />
        </View>
        {newBest && <Text style={styles.newBestText}>★ NEW BEST SCORE ★</Text>}
      </View>
      <View style={styles.modeList}>
        <TouchableOpacity style={styles.modeBtnPrimary} onPress={onPlayAgain} activeOpacity={0.85}>
          <View style={{ flex: 1 }}>
            <Text style={styles.modeBtnTitlePrimary}>PLAY AGAIN</Text>
            <Text style={styles.modeBtnSubPrimary}>Another 50-wave run</Text>
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
function Game({ onEnd }) {
  const stateRef = useRef(null);
  if (!stateRef.current) {
    stateRef.current = {
      grid: emptyGrid(),           // true = blocked (tower/special/rock)
      towers: [],                  // committed towers (kind: 'gem' | 'special' | 'rock')
      candidates: [],              // 5 placements this round before Choose Action
      enemies: [],
      projectiles: [],
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
      gold: STARTING_GOLD,
      lives: STARTING_LIVES,
      score: 0,
      speed: 1,
      inspect: null,               // candidate id being inspected
      flash: null,
      pan: { x: 0, y: 0 },
      scale: INITIAL_SCALE,
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
    // Roll gem
    const purity = rollPurity(s.playerLevel);
    const gemType = rollGemType();
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
    s.towers.push(anchor);
    // All other candidates not consumed and not anchor → rocks
    const keep = new Set([anchor.id]);
    // candidates used in merge also disappear (they were "consumed"), turning to rocks
    // But mentally they're "merged into the anchor". Convert to rocks too.
    candidatesToRocks(keep);
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
    s.towers.push(anchor);
    candidatesToRocks(new Set([anchor.id]));
    finishChooseAction();
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
    const w = WAVES[s.wave - 1];
    const queue = [];
    let t = s.time + 0.8;
    for (const [type, count, gap] of w.spawns) {
      for (let i = 0; i < count; i++) {
        t += gap;
        queue.push({ type, atTime: t, hpMul: w.hpMul });
      }
    }
    s.spawnQueue = queue;
    s.inspect = null;
    force();
  };

  // ── Tap handlers ───────────────────────────────────────────────────────
  const onBoardPress = (e) => {
    const { locationX, locationY } = e.nativeEvent;
    const c = Math.floor(locationX / TILE);
    const r = Math.floor(locationY / TILE);
    if (r < 0 || r >= ROWS || c < 0 || c >= COLS) return;
    const candidate = s.candidates.find((t) => t.r === r && t.c === c);
    if (candidate) {
      s.inspect = candidate.id;
      force();
      return;
    }
    if (s.phase === 'placing') {
      tryPlaceCandidate(r, c);
    }
    // Tapping committed towers/rocks during attacking phase: do nothing for now
  };

  const toggleSpeed = () => { s.speed = s.speed === 1 ? 2 : s.speed === 2 ? 3 : 1; force(); };
  const recenter = () => { s.pan.x = 0; s.pan.y = 0; s.scale = INITIAL_SCALE; force(); };

  // ── Derived ─────────────────────────────────────────────────────────────
  const inspectCandidate = s.inspect ? s.candidates.find((c) => c.id === s.inspect) : null;
  const flashing = s.flash && s.flash.until > s.time ? s.flash.text : null;

  const boardLeft = (VIEWPORT_W - BOARD_W) / 2 + s.pan.x;
  const boardTop = (VIEWPORT_H - BOARD_H) / 2 + s.pan.y;

  let bottomMessage = '';
  if (s.phase === 'placing') {
    bottomMessage = `Place gem ${s.placementsThisRound + 1}/${MAX_PLACEMENTS} · level ${s.playerLevel}`;
  } else if (s.phase === 'choosing') {
    bottomMessage = 'Tap a placed gem to choose Keep / Merge / Combine';
  } else if (s.phase === 'attacking') {
    bottomMessage = `Wave ${s.wave}/${NUM_WAVES} in progress · pinch · drag`;
  }

  return (
    <SafeAreaView style={styles.gameRoot}>
      <StatusBar barStyle="light-content" />
      <View style={styles.hud}>
        <HudStat label="LIVES" value={s.lives} color="#ff4d6d" />
        <HudStat label="GOLD" value={s.gold} color="#ffd166" />
        <HudStat label="WAVE" value={`${s.wave}/${NUM_WAVES}`} color="#4cc9ff" />
        <HudStat label="LVL" value={s.playerLevel} color="#b08bff" />
      </View>

      <View
        style={{ width: VIEWPORT_W, height: VIEWPORT_H, backgroundColor: '#0a0e1c', overflow: 'hidden' }}
        {...panResponder.panHandlers}
      >
        <View
          pointerEvents="box-none"
          style={{
            position: 'absolute',
            left: boardLeft, top: boardTop,
            width: BOARD_W, height: BOARD_H,
            backgroundColor: '#0f1530',
            borderRadius: 4,
            transform: [{ scale: s.scale }],
          }}
        >
          {/* path tint */}
          {s.path && s.path.map((p, i) => (
            <View key={`p${i}`} pointerEvents="none" style={{
              position: 'absolute', left: p.c * TILE, top: p.r * TILE,
              width: TILE, height: TILE, backgroundColor: '#15204a',
            }} />
          ))}

          {/* spawn, checkpoints, goal */}
          <Marker pt={SPAWN} label="↓" color="#3a1f4a" />
          {CHECKPOINTS.map((cp, i) => (
            <Marker key={`cp${i}`} pt={cp} label={`${i + 1}`} color="#2a3a55" />
          ))}
          <Marker pt={GOAL} label="◇" color="#1f4a3a" />

          {/* tap layer */}
          <Pressable onPress={onBoardPress} style={{ position: 'absolute', left: 0, top: 0, width: BOARD_W, height: BOARD_H }} />

          {/* committed towers (gems, specials, rocks) */}
          {s.towers.map((t) => <TowerView key={`tw${t.id}`} t={t} />)}

          {/* candidates (highlighted pulsing) */}
          {s.candidates.map((t) => <CandidateView key={`c${t.id}`} t={t} time={s.time} />)}

          {/* enemies */}
          {s.enemies.map((e) => <EnemyView key={`e${e.id}`} e={e} />)}

          {/* projectiles */}
          {s.projectiles.map((p) => <ProjectileView key={`pr${p.id}`} p={p} />)}
        </View>

        <TouchableOpacity onPress={recenter} style={styles.recenterBtn}>
          <Text style={styles.recenterText}>⤢</Text>
        </TouchableOpacity>

        {flashing && (
          <View pointerEvents="none" style={styles.flashWrap}>
            <Text style={styles.flashText}>{flashing}</Text>
          </View>
        )}
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
                allTowers={[...s.candidates, ...s.towers]}
                onKeep={() => resolveKeep(inspectCandidate.id)}
                onMerge={(plus) => resolveMerge(inspectCandidate.id, plus)}
                onCombine={(rid) => resolveCombine(inspectCandidate.id, rid)}
              />
            )}
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

// ─── Tower / candidate / enemy / projectile render ───────────────────────────
function Marker({ pt, label, color }) {
  return (
    <View pointerEvents="none" style={[styles.marker, { left: pt.c * TILE, top: pt.r * TILE, backgroundColor: color }]}>
      <Text style={styles.markerText}>{label}</Text>
    </View>
  );
}

function TowerView({ t }) {
  if (t.kind === 'rock') {
    return (
      <View pointerEvents="none" style={{
        position: 'absolute',
        left: t.c * TILE + TILE * 0.15, top: t.r * TILE + TILE * 0.15,
        width: TILE * 0.7, height: TILE * 0.7,
        backgroundColor: '#5a627f',
        borderRadius: 3,
        borderWidth: 1, borderColor: '#7c84a8',
      }} />
    );
  }
  if (t.kind === 'special') {
    const recipe = SPECIAL_BY_ID[t.specialId];
    if (!recipe) return null;
    const tierLevel = parseInt(recipe.tier.slice(1), 10);
    return (
      <View pointerEvents="none" style={{
        position: 'absolute', left: t.c * TILE, top: t.r * TILE,
        width: TILE, height: TILE, alignItems: 'center', justifyContent: 'center',
      }}>
        <View style={{
          position: 'absolute',
          width: TILE * (1.0 + tierLevel * 0.05),
          height: TILE * (1.0 + tierLevel * 0.05),
          borderRadius: TILE, backgroundColor: recipe.accent,
          opacity: 0.18 + tierLevel * 0.04,
        }} />
        <View style={{
          width: TILE * 0.85, height: TILE * 0.85,
          borderRadius: TILE * 0.42,
          backgroundColor: recipe.color,
          borderWidth: 2, borderColor: recipe.accent,
          shadowColor: recipe.accent, shadowOpacity: 1,
          shadowRadius: 6 + tierLevel, shadowOffset: { width: 0, height: 0 },
          elevation: 4 + tierLevel,
          alignItems: 'center', justifyContent: 'center',
        }}>
          <View style={{
            width: TILE * 0.5, height: TILE * 0.5,
            backgroundColor: recipe.accent,
            transform: [{ rotate: '45deg' }], borderRadius: 3,
          }} />
        </View>
        <Text style={{ position: 'absolute', color: '#fff', fontSize: TILE * 0.45, fontWeight: '900',
          textShadowColor: '#000a', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 2 }}>
          {tierLevel >= 6 ? '✦' : '★'}
        </Text>
      </View>
    );
  }
  // Gem
  const g = GEMS[t.gemType];
  const tBlock = tier(t.tier);
  const isAscendant = t.tier === 6;
  return (
    <View pointerEvents="none" style={{
      position: 'absolute', left: t.c * TILE, top: t.r * TILE,
      width: TILE, height: TILE, alignItems: 'center', justifyContent: 'center',
    }}>
      {t.tier >= 3 && (
        <View style={{
          position: 'absolute',
          width: TILE * (0.85 + t.tier * 0.04),
          height: TILE * (0.85 + t.tier * 0.04),
          borderRadius: TILE, backgroundColor: g.color,
          opacity: 0.15 + t.tier * 0.05,
        }} />
      )}
      <View style={{
        width: TILE * 0.72, height: TILE * 0.72,
        backgroundColor: g.color, borderRadius: 4,
        transform: [{ rotate: '45deg' }],
        shadowColor: g.color, shadowOpacity: 0.9,
        shadowRadius: 4 + t.tier, shadowOffset: { width: 0, height: 0 },
        elevation: 3 + t.tier,
        borderWidth: isAscendant ? 2 : t.tier >= 4 ? 1.5 : 0,
        borderColor: isAscendant ? '#ffd166' : '#fff',
      }} />
      <View style={{
        position: 'absolute',
        width: TILE * 0.18, height: TILE * 0.18,
        borderRadius: TILE,
        backgroundColor: '#fff',
        opacity: 0.55,
        top: TILE * 0.22, left: TILE * 0.22,
      }} />
      <Text style={{
        position: 'absolute', color: t.tier >= 3 ? '#0b1020' : '#fff',
        fontSize: TILE * 0.22, fontWeight: '900',
      }}>
        {tBlock.short}
      </Text>
    </View>
  );
}

function CandidateView({ t, time }) {
  const g = GEMS[t.gemType];
  const tBlock = tier(t.tier);
  const pulse = 0.55 + 0.35 * Math.sin(time * 6);
  return (
    <View pointerEvents="none" style={{
      position: 'absolute', left: t.c * TILE, top: t.r * TILE,
      width: TILE, height: TILE, alignItems: 'center', justifyContent: 'center',
    }}>
      <View style={{
        position: 'absolute',
        width: TILE * 1.05, height: TILE * 1.05,
        borderRadius: TILE,
        borderWidth: 3, borderColor: '#ffd166',
        opacity: pulse,
      }} />
      <View style={{
        width: TILE * 0.72, height: TILE * 0.72,
        backgroundColor: g.color, borderRadius: 4,
        transform: [{ rotate: '45deg' }],
        opacity: 0.85,
        shadowColor: g.color, shadowOpacity: 1,
        shadowRadius: 6, shadowOffset: { width: 0, height: 0 },
      }} />
      <Text style={{ position: 'absolute', color: t.tier >= 3 ? '#0b1020' : '#fff',
        fontSize: TILE * 0.22, fontWeight: '900' }}>
        {tBlock.short}
      </Text>
    </View>
  );
}

function EnemyView({ e }) {
  const def = ENEMIES[e.type];
  const size = TILE * def.size;
  const slowed = e.effects.some((ef) => ef.type === 'slow');
  const burning = e.effects.some((ef) => ef.type === 'poison');
  return (
    <View pointerEvents="none" style={{
      position: 'absolute',
      left: e.c * TILE + (TILE - size) / 2, top: e.r * TILE + (TILE - size) / 2,
      width: size, height: size,
    }}>
      <View style={{
        width: size, height: size, borderRadius: size / 2,
        backgroundColor: burning ? '#5cf28a' : def.color,
        borderWidth: slowed ? 2 : 0, borderColor: '#4cc9ff',
        opacity: def.flying ? 0.85 : 1,
      }} />
      {def.flying && (
        <Text style={{ position: 'absolute', top: -2, left: size * 0.3, color: '#fff', fontSize: 10 }}>✈</Text>
      )}
      <View style={{
        position: 'absolute', top: -4, left: 0, width: size, height: 2,
        backgroundColor: '#000a', borderRadius: 2,
      }}>
        <View style={{
          width: Math.max(0, size * (e.hp / e.maxHp)), height: 2,
          backgroundColor: '#5cf28a', borderRadius: 2,
        }} />
      </View>
    </View>
  );
}

function ProjectileView({ p }) {
  const len = Math.hypot(p.toX - p.fromX, p.toY - p.fromY);
  const angle = Math.atan2(p.toY - p.fromY, p.toX - p.fromX);
  const midX = (p.fromX + p.toX) / 2;
  const midY = (p.fromY + p.toY) / 2;
  return (
    <View pointerEvents="none" style={{
      position: 'absolute',
      left: midX - len / 2, top: midY - 1,
      width: len, height: 2,
      backgroundColor: p.color, opacity: 0.9,
      transform: [{ rotate: `${angle}rad` }],
    }} />
  );
}

// ─── Candidate inspect / action picker ───────────────────────────────────────
function CandidateInspect({ candidate, allTowers, onKeep, onMerge, onCombine }) {
  const g = GEMS[candidate.gemType];
  const t = tier(candidate.tier);
  const stats = gemStats(candidate.gemType, candidate.tier);
  const matches = allTowers.filter(
    (x) => x.id !== candidate.id && x.kind === 'gem' && x.gemType === candidate.gemType && x.tier === candidate.tier
  ).length;
  const canMerge1 = matches >= 1 && candidate.tier < 6;
  const canMerge2 = matches >= 3 && candidate.tier + 2 <= 6;
  const craftable = SPECIAL_RECIPES.filter((r) => findRecipeMatch(candidate, allTowers, r) !== null);
  return (
    <>
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
      </View>

      {craftable.length > 0 && (
        <View style={styles.craftSection}>
          <Text style={styles.craftSectionLabel}>COMBINE RECIPES READY</Text>
          {craftable.map((r) => (
            <TouchableOpacity
              key={r.id}
              style={[styles.craftBtn, { borderColor: r.accent }]}
              onPress={() => onCombine(r.id)}
              activeOpacity={0.85}
            >
              <View style={[styles.craftIcon, { backgroundColor: r.color, borderColor: r.accent }]}>
                <Text style={styles.specialIconStar}>★</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.craftBtnName}>{r.name} <Text style={{ color: '#ffd166' }}>{r.tier}</Text></Text>
                <Text style={styles.craftBtnDesc}>{r.description}</Text>
              </View>
              <Text style={styles.craftBtnArrow}>▶</Text>
            </TouchableOpacity>
          ))}
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
      <Text style={styles.hudLabel}>{label}</Text>
      <Text style={[styles.hudValue, { color }]}>{value}</Text>
    </View>
  );
}

// ─── Game step (combat phase) ────────────────────────────────────────────────
function step(dt, s, onEnd) {
  s.time += dt;
  if (s.phase !== 'attacking') return;

  // Spawn from queue
  while (s.spawnQueue.length && s.spawnQueue[0].atTime <= s.time) {
    const sp = s.spawnQueue.shift();
    const def = ENEMIES[sp.type];
    const hp = Math.floor(def.hp * sp.hpMul);
    const subPath = def.flying
      ? [SPAWN, GOAL] // flyers go direct
      : bfsCheckpoints(s.grid, SPAWN) || [SPAWN, GOAL];
    s.enemies.push({
      id: s.nextEnemyId++,
      r: SPAWN.r, c: SPAWN.c,
      hp, maxHp: hp,
      type: sp.type,
      armor: def.armor,
      subPath, pathIdx: 0,
      effects: [],
    });
  }

  // Move enemies
  for (const e of s.enemies) {
    if (e.hp <= 0) continue;
    const def = ENEMIES[e.type];
    e.effects = e.effects.filter((ef) => ef.until > s.time);
    let speedMul = 1;
    for (const ef of e.effects) {
      if (ef.type === 'slow') speedMul = Math.min(speedMul, ef.factor);
      if (ef.type === 'poison') e.hp -= ef.dps * dt;
    }
    if (e.hp <= 0) continue;
    if (!e.subPath || e.pathIdx >= e.subPath.length) {
      const fresh = def.flying
        ? [{ r: Math.floor(e.r), c: Math.floor(e.c) }, GOAL]
        : bfsCheckpoints(s.grid, { r: Math.floor(e.r), c: Math.floor(e.c) });
      if (fresh) { e.subPath = fresh; e.pathIdx = 0; } else continue;
    }
    const target = e.subPath[e.pathIdx];
    const dr = target.r - e.r;
    const dc = target.c - e.c;
    const dist = Math.hypot(dr, dc);
    const move = def.speed * speedMul * dt;
    if (dist <= move) {
      e.r = target.r;
      e.c = target.c;
      e.pathIdx += 1;
      if (e.pathIdx >= e.subPath.length) {
        e.hp = -1;
        s.lives -= 1;
      }
    } else {
      e.r += (dr / dist) * move;
      e.c += (dc / dist) * move;
    }
  }

  // Towers fire (gems and specials, never rocks/candidates)
  for (const t of s.towers) {
    if (t.kind !== 'gem' && t.kind !== 'special') continue;
    t.cooldown = Math.max(0, t.cooldown - dt);
    if (t.cooldown > 0) continue;
    const stats = t.kind === 'gem'
      ? gemStats(t.gemType, t.tier)
      : SPECIAL_BY_ID[t.specialId]?.stats;
    if (!stats) continue;
    const color = t.kind === 'gem' ? GEMS[t.gemType].color : SPECIAL_BY_ID[t.specialId].accent;
    const inRange = [];
    for (const e of s.enemies) {
      if (e.hp <= 0) continue;
      const d = Math.hypot(e.r - t.r, e.c - t.c);
      if (d <= stats.range) inRange.push({ e, d });
    }
    if (inRange.length === 0) continue;
    inRange.sort((a, b) => a.d - b.d);
    t.cooldown = stats.cooldown;
    fireAt(t, inRange, stats, color, s);
  }

  s.projectiles = s.projectiles.filter((p) => p.until > s.time);

  // Resolve deaths & rewards
  const goldAuraActive = s.towers.some((t) => {
    if (t.kind !== 'special') return false;
    const r = SPECIAL_BY_ID[t.specialId];
    return r && r.stats.goldAura;
  });
  const goldMul = goldAuraActive ? 2 : 1;
  const wavePerKill = KILL_GOLD_BY_WAVE[s.wave] || 1;

  const alive = [];
  for (const e of s.enemies) {
    if (e.hp <= 0) {
      if (e.subPath && e.pathIdx < e.subPath.length) {
        s.gold += wavePerKill * goldMul;
        s.score += wavePerKill * 4;
      }
    } else {
      alive.push(e);
    }
  }
  s.enemies = alive;

  // Wave end?
  if (s.spawnQueue.length === 0 && s.enemies.length === 0) {
    const bossBonus = BOSS_GOLD_BONUS[s.wave] || 0;
    if (bossBonus > 0) {
      s.gold += bossBonus;
      s.score += bossBonus;
    }
    s.score += 50 + s.wave * 10;
    s.flash = { text: `Wave ${s.wave} cleared!${bossBonus ? ` +${bossBonus}g boss bonus` : ''}`, until: s.time + 2.0 };

    if (s.wave >= NUM_WAVES) {
      onEnd(true, s.score, s.wave);
      return;
    }
    // Return to build phase for the NEXT wave
    s.phase = 'placing';
    s.placementsThisRound = 0;
    s.candidates = [];
    s.playerLevel = levelForWave(s.wave + 1);
  }

  if (s.lives <= 0) onEnd(false, s.score, s.wave);
}

function fireAt(tower, inRange, stats, color, s) {
  const handleHit = (enemy, dmg) => {
    const effectiveArmor = Math.max(0, enemy.armor - (stats.armorBreak || 0));
    const reduced = dmg * (100 / (100 + effectiveArmor * 6));
    enemy.hp -= reduced;
    // slow: number (gem sapphire stat) OR object {factor, duration} (special)
    if (typeof stats.slow === 'number' && stats.slow > 0) {
      enemy.effects = enemy.effects.filter((ef) => ef.type !== 'slow');
      enemy.effects.push({ type: 'slow', factor: 1 - stats.slow, until: s.time + 1.2 });
    } else if (stats.slow && typeof stats.slow === 'object') {
      enemy.effects = enemy.effects.filter((ef) => ef.type !== 'slow');
      enemy.effects.push({ type: 'slow', factor: stats.slow.factor, until: s.time + stats.slow.duration });
    }
    if (stats.poison) {
      enemy.effects = enemy.effects.filter((ef) => ef.type !== 'poison');
      enemy.effects.push({ type: 'poison', dps: stats.poison.dps, until: s.time + stats.poison.duration });
    }
  };

  if (stats.multi) {
    const targets = inRange.slice(0, stats.multi);
    for (const { e } of targets) {
      handleHit(e, stats.damage);
      s.projectiles.push(makeProjectile(tower, e, color, s));
    }
  } else if (stats.chain) {
    let prev = inRange[0].e;
    handleHit(prev, stats.damage);
    s.projectiles.push(makeProjectile(tower, prev, color, s));
    let remaining = stats.chain - 1;
    const hit = new Set([prev.id]);
    while (remaining > 0) {
      let best = null;
      let bestD = Infinity;
      for (const e of s.enemies) {
        if (hit.has(e.id) || e.hp <= 0) continue;
        const d = Math.hypot(e.r - prev.r, e.c - prev.c);
        if (d <= stats.range && d < bestD) { best = e; bestD = d; }
      }
      if (!best) break;
      handleHit(best, stats.damage * 0.7);
      s.projectiles.push({
        id: s.nextProjectileId++,
        fromX: prev.c * TILE + TILE / 2, fromY: prev.r * TILE + TILE / 2,
        toX: best.c * TILE + TILE / 2, toY: best.r * TILE + TILE / 2,
        color, until: s.time + 0.08,
      });
      hit.add(best.id);
      prev = best;
      remaining -= 1;
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

// ─── Styles ──────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  lobbyRoot: {
    flex: 1, backgroundColor: '#0b1020',
    paddingHorizontal: 18, paddingTop: 24, paddingBottom: 12,
    justifyContent: 'space-between',
  },
  lobbyHeader: { alignItems: 'center', marginTop: 32 },
  lobbyCrystalRow: { flexDirection: 'row', marginBottom: 8 },
  lobbyCrystal: {
    fontSize: 64, marginHorizontal: 6,
    textShadowColor: '#4cc9ff60', textShadowOffset: { width: 0, height: 0 }, textShadowRadius: 12,
  },
  lobbyTitle: {
    color: '#fff', fontSize: 38, fontWeight: '900', letterSpacing: 2,
    textShadowColor: '#4cc9ff80', textShadowOffset: { width: 0, height: 0 }, textShadowRadius: 16,
  },
  lobbySubtitle: { color: '#9aa3c7', fontSize: 14, letterSpacing: 8, marginTop: 4 },

  statsCard: {
    backgroundColor: '#161c33', borderRadius: 16, padding: 14,
    borderWidth: 1, borderColor: '#2a335f',
  },
  statsCardLabel: {
    color: '#7c84a8', fontSize: 12, letterSpacing: 2, fontWeight: '700',
    marginBottom: 10, textAlign: 'center',
  },
  statsRow: { flexDirection: 'row', justifyContent: 'space-around', marginBottom: 6 },
  statTile: { flex: 1, alignItems: 'center', paddingVertical: 6 },
  statTileLabel: { color: '#7c84a8', fontSize: 12, letterSpacing: 1.5, fontWeight: '600' },
  statTileValue: { fontSize: 22, fontWeight: '800', marginTop: 2 },
  statsHint: { color: '#7c84a8', fontSize: 12, textAlign: 'center', fontStyle: 'italic', marginTop: 4 },
  newBestText: { color: '#ffd166', fontSize: 14, fontWeight: '900', letterSpacing: 2, textAlign: 'center', marginTop: 8 },

  modeList: { gap: 12 },
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
  footerBtn: { alignItems: 'center', paddingVertical: 6, paddingHorizontal: 12 },
  footerIcon: { color: '#9aa3c7', fontSize: 22 },
  footerLabel: { color: '#7c84a8', fontSize: 12, letterSpacing: 1, marginTop: 2 },
  footerVersion: { color: '#7c84a8', fontSize: 12 },

  gameRoot: { flex: 1, backgroundColor: '#0b1020' },
  hud: {
    flexDirection: 'row', justifyContent: 'space-around',
    paddingVertical: 10, paddingHorizontal: 8, backgroundColor: '#0a0e1c',
  },
  hudStat: { alignItems: 'center', minWidth: 64 },
  hudLabel: { color: '#7c84a8', fontSize: 12, letterSpacing: 1.5, fontWeight: '600' },
  hudValue: { fontSize: 20, fontWeight: '800', marginTop: 2 },

  marker: { position: 'absolute', width: TILE, height: TILE, alignItems: 'center', justifyContent: 'center' },
  markerText: { color: '#fff', fontSize: TILE * 0.55, opacity: 0.6, fontWeight: '700' },

  recenterBtn: {
    position: 'absolute', right: 12, bottom: 12,
    width: 44, height: 44, backgroundColor: '#161c33e0',
    borderRadius: 22, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: '#2a335f',
  },
  recenterText: { color: '#fff', fontSize: 22, fontWeight: '800' },

  bottomBar: { paddingHorizontal: 12, paddingTop: 10, paddingBottom: 12, alignItems: 'center' },
  phaseBadge: {
    backgroundColor: '#4cc9ff', paddingHorizontal: 14, paddingVertical: 4,
    borderRadius: 999, marginBottom: 6,
  },
  phaseBadgeText: { color: '#0b1020', fontWeight: '900', fontSize: 12, letterSpacing: 2 },
  bottomMessage: { color: '#fff', fontSize: 14, fontWeight: '600', textAlign: 'center' },
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
    padding: 22, paddingTop: 26,
    width: '100%', maxWidth: 420,
    borderWidth: 1, borderColor: '#2a335f',
    shadowColor: '#000', shadowOpacity: 0.6, shadowRadius: 18, shadowOffset: { width: 0, height: 8 },
  },
  modalCloseX: {
    position: 'absolute', top: 8, right: 8,
    width: 40, height: 40, borderRadius: 20,
    alignItems: 'center', justifyContent: 'center', zIndex: 10,
  },
  modalCloseXText: { color: '#9aa3c7', fontSize: 22, fontWeight: '700' },
  modalHeaderRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 10, paddingRight: 32 },
  modalTitle: { color: '#fff', fontSize: 22, fontWeight: '800' },
  modalSub: { color: '#9aa3c7', fontSize: 12, marginTop: 3 },
  modalRow: {
    flexDirection: 'row', justifyContent: 'space-around',
    marginVertical: 14, backgroundColor: '#0f1530',
    borderRadius: 12, paddingVertical: 12,
  },
  modalStat: { alignItems: 'center', flex: 1 },
  modalStatLabel: { color: '#7c84a8', fontSize: 12, letterSpacing: 1, fontWeight: '600' },
  modalStatValue: { color: '#fff', fontSize: 16, fontWeight: '800', marginTop: 2 },
  combineHint: { color: '#9aa3c7', fontSize: 13, textAlign: 'center', marginBottom: 14, lineHeight: 18 },

  actionRowBtn: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#0f1530', padding: 12, borderRadius: 12,
    borderWidth: 1.5,
  },
  actionRowLabel: { fontSize: 14, fontWeight: '900', letterSpacing: 1.5 },
  actionRowDesc: { color: '#9aa3c7', fontSize: 12, marginTop: 3 },
  actionRowArrow: { fontSize: 18, fontWeight: '900', marginLeft: 8 },

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
