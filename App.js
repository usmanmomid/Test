import React, { useState, useEffect, useRef, useCallback } from 'react';
import Svg, {
  Path, Circle, Ellipse, Rect, G, LinearGradient, RadialGradient,
  Stop, Defs, Polygon, Line,
} from 'react-native-svg';
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

function LobbyScreen({ stats, onStartSolo }) {
  const [recipeBookOpen, setRecipeBookOpen] = useState(false);
  return (
    <SafeAreaView style={styles.lobbyRoot}>
      <StatusBar barStyle="light-content" />
      <LobbyBackground width={VIEWPORT_W} height={VIEWPORT_H + 200} />
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
      lives: STARTING_LIVES,
      score: 0,
      speed: 1,
      inspect: null,               // candidate id being inspected
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
    // Wave-start banner: stored separately from `flash` so it can render big.
    const totalEnemies = queue.length;
    const isBossWave = s.wave % 10 === 0;
    const bossNames = { 10: 'DEMON LORD', 20: 'VOID KING', 30: 'BLOOD TYRANT', 40: 'DESTROYER', 50: 'WORLD ENDER' };
    s.waveBanner = {
      wave: s.wave,
      total: totalEnemies,
      boss: isBossWave,
      bossName: bossNames[s.wave] || null,
      elite: s.wave >= 11 && !isBossWave,
      start: s.time,
      until: s.time + 2.4,
    };
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
  const recenter = () => { s.pan.x = 0; s.pan.y = 0; s.scale = INITIAL_SCALE; s.tiltAngle = 0; force(); };
  const toggleTilt = () => {
    // Cycle 0 → 30 → 50 (pseudo-3D iso) → back to 0
    s.tiltAngle = s.tiltAngle === 0 ? 30 : s.tiltAngle === 30 ? 50 : 0;
    force();
  };

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
          {s.enemies.map((e) => <EnemyView key={`e${e.id}`} e={e} time={s.time} />)}

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

const BoardChrome = React.memo(function BoardChrome() {
  return (
    <>
      {/* Vertical gradient strips (blue → purple) */}
      {Array.from({ length: GRADIENT_STRIPS }).map((_, i) => (
        <View key={`gr${i}`} pointerEvents="none" style={{
          position: 'absolute',
          left: i * STRIP_W, top: 0,
          width: STRIP_W + 1, height: BOARD_H,
          backgroundColor: gradColor(i / (GRADIENT_STRIPS - 1)),
        }} />
      ))}

      {/* Subtle tile grid (vertical lines + horizontal lines) */}
      {Array.from({ length: COLS + 1 }).map((_, i) => (
        <View key={`gv${i}`} pointerEvents="none" style={{
          position: 'absolute',
          left: i * TILE, top: 0,
          width: 1, height: BOARD_H,
          backgroundColor: '#00000040',
        }} />
      ))}
      {Array.from({ length: ROWS + 1 }).map((_, i) => (
        <View key={`gh${i}`} pointerEvents="none" style={{
          position: 'absolute',
          left: 0, top: i * TILE,
          width: BOARD_W, height: 1,
          backgroundColor: '#00000040',
        }} />
      ))}

      {/* Decorative crystals outside the play area */}
      {CRYSTAL_SPECS.map((c, i) => <DecoCrystal key={`dc${i}`} {...c} />)}

      {/* Stone wall frame */}
      <View pointerEvents="none" style={{
        position: 'absolute',
        left: -WALL_THICKNESS, top: -WALL_THICKNESS,
        width: BOARD_W + WALL_THICKNESS * 2,
        height: BOARD_H + WALL_THICKNESS * 2,
        borderWidth: WALL_THICKNESS,
        borderColor: '#28233f',
        borderRadius: 6,
      }} />
      {/* Inner highlight (slight bevel) */}
      <View pointerEvents="none" style={{
        position: 'absolute',
        left: -2, top: -2,
        width: BOARD_W + 4, height: BOARD_H + 4,
        borderWidth: 2,
        borderColor: '#4a4060',
        borderRadius: 4,
      }} />
      {/* Outer highlight */}
      <View pointerEvents="none" style={{
        position: 'absolute',
        left: -WALL_THICKNESS - 1, top: -WALL_THICKNESS - 1,
        width: BOARD_W + WALL_THICKNESS * 2 + 2,
        height: BOARD_H + WALL_THICKNESS * 2 + 2,
        borderWidth: 1,
        borderColor: '#1a1530',
        borderRadius: 7,
      }} />

      {/* Vignette: subtle dark corners */}
      <View pointerEvents="none" style={{
        position: 'absolute',
        left: 0, top: 0, width: BOARD_W, height: BOARD_H,
        backgroundColor: '#00000026',
      }} />
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
function PathLayer({ path, time }) {
  if (!path) return null;
  const len = path.length;
  // The wave position (in path indices) advances with time.
  const head = (time * 18) % (len + 20);
  return (
    <>
      {path.map((p, i) => {
        // Distance from the wave's head, in path indices.
        const dist = head - i;
        let brightness = 0.0;
        if (dist >= 0 && dist < 8) brightness = 1 - dist / 8;
        const baseOpacity = 0.45;
        const totalBlue = Math.min(1, baseOpacity + brightness * 0.55);
        return (
          <View key={`p${i}`} pointerEvents="none" style={{
            position: 'absolute',
            left: p.c * TILE, top: p.r * TILE,
            width: TILE, height: TILE,
            backgroundColor: brightness > 0.1 ? '#4cc9ff' : '#15204a',
            opacity: brightness > 0.1 ? totalBlue : 0.55,
          }} />
        );
      })}
    </>
  );
}

function Marker({ pt, label, color }) {
  return (
    <View pointerEvents="none" style={[styles.marker, { left: pt.c * TILE, top: pt.r * TILE, backgroundColor: color }]}>
      <Text style={styles.markerText}>{label}</Text>
    </View>
  );
}

// Pseudo-3D rock — deterministic random variant by id so the same rock
// keeps the same shape across renders.
function RockView({ t }) {
  const seed = (t.id * 2654435761) >>> 0;
  const variant = seed % 4;
  const rot = ((seed >> 4) & 0x3F) - 32; // -32..+31 degrees
  const baseColors = ['#4a4a5e', '#4f4860', '#3f4458', '#52516a'];
  const highlightColors = ['#8c8aa8', '#9a90b0', '#7e8aa0', '#a09ab8'];
  const shadowColors = ['#22222e', '#26222e', '#1e2230', '#2a2738'];
  const base = baseColors[variant];
  const hi = highlightColors[variant];
  const sh = shadowColors[variant];
  const spikeAngle = ((seed >> 10) & 0xFF) - 128;
  const showSpike = variant !== 0;
  return (
    <View pointerEvents="none" style={{
      position: 'absolute', left: t.c * TILE, top: t.r * TILE,
      width: TILE, height: TILE, alignItems: 'center', justifyContent: 'center',
    }}>
      {/* shadow under stone */}
      <View style={{
        position: 'absolute', left: TILE * 0.15, top: TILE * 0.55,
        width: TILE * 0.7, height: TILE * 0.28,
        borderRadius: TILE * 0.4,
        backgroundColor: '#000', opacity: 0.45,
      }} />
      {/* main rock body, rotated for variation */}
      <View style={{
        width: TILE * 0.78, height: TILE * 0.78,
        transform: [{ rotate: `${rot}deg` }],
        alignItems: 'center', justifyContent: 'center',
      }}>
        {/* dark base */}
        <View style={{
          position: 'absolute', width: '100%', height: '100%',
          backgroundColor: sh,
          borderRadius: variant === 0 ? TILE * 0.3 : 4,
        }} />
        {/* main face */}
        <View style={{
          position: 'absolute',
          left: 0, top: 0, right: TILE * 0.05, bottom: TILE * 0.12,
          backgroundColor: base,
          borderRadius: variant === 0 ? TILE * 0.3 : 3,
        }} />
        {/* top-left highlight facet */}
        <View style={{
          position: 'absolute',
          left: 0, top: 0,
          width: '55%', height: '55%',
          backgroundColor: hi,
          opacity: 0.7,
          borderTopLeftRadius: variant === 0 ? TILE * 0.3 : 3,
          borderBottomRightRadius: 8,
        }} />
        {/* small dark facet (chipped corner) */}
        {showSpike && (
          <View style={{
            position: 'absolute',
            right: 1, top: TILE * 0.18,
            width: '32%', height: '32%',
            backgroundColor: sh,
            transform: [{ rotate: `${spikeAngle}deg` }],
            borderRadius: 2,
            opacity: 0.85,
          }} />
        )}
      </View>
    </View>
  );
}

function TowerView({ t }) {
  if (t.kind === 'rock') {
    return <RockView t={t} />;
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
  const g = GEMS[t.gemType];
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
      {/* Crystal body (rotated square) */}
      <View style={{
        width: TILE * 0.72, height: TILE * 0.72,
        backgroundColor: g.color, borderRadius: 4,
        transform: [{ rotate: '45deg' }],
        shadowColor: g.color, shadowOpacity: 0.9,
        shadowRadius: 4 + t.tier, shadowOffset: { width: 0, height: 0 },
        elevation: 3 + t.tier,
        borderWidth: isAscendant ? 2 : t.tier >= 4 ? 1.5 : 0,
        borderColor: isAscendant ? '#ffd166' : '#fff',
      }}>
        {/* Top-left facet (lighter) */}
        <View style={{
          position: 'absolute',
          left: 0, top: 0,
          width: '50%', height: '50%',
          backgroundColor: '#fff',
          opacity: 0.22,
          borderTopLeftRadius: 4,
        }} />
        {/* Bottom-right facet (darker, simulating shaded side) */}
        <View style={{
          position: 'absolute',
          right: 0, bottom: 0,
          width: '50%', height: '50%',
          backgroundColor: '#000',
          opacity: 0.18,
          borderBottomRightRadius: 4,
        }} />
        {/* Center crisp diagonal line (gem fold) */}
        <View style={{
          position: 'absolute',
          left: 0, top: '50%',
          width: '100%', height: 1,
          backgroundColor: '#000',
          opacity: 0.15,
        }} />
        <View style={{
          position: 'absolute',
          top: 0, left: '50%',
          width: 1, height: '100%',
          backgroundColor: '#000',
          opacity: 0.15,
        }} />
      </View>
      {/* Specular highlight (small bright dot) */}
      <View style={{
        position: 'absolute',
        width: TILE * 0.16, height: TILE * 0.16,
        borderRadius: TILE,
        backgroundColor: '#fff',
        opacity: 0.7,
        top: TILE * 0.2, left: TILE * 0.22,
      }} />
      {/* Tier label */}
      <Text style={{
        position: 'absolute', color: t.tier >= 3 ? '#0b1020' : '#fff',
        fontSize: TILE * 0.34, fontWeight: '900',
        textShadowColor: '#fff8',
        textShadowOffset: { width: 0, height: 0 }, textShadowRadius: 1,
      }}>
        {gemLabel(t.gemType, t.tier)}
      </Text>
    </View>
  );
}

function CandidateView({ t, time }) {
  const g = GEMS[t.gemType];
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
        fontSize: TILE * 0.34, fontWeight: '900' }}>
        {gemLabel(t.gemType, t.tier)}
      </Text>
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
  const b = BOB_PARAMS[e.type] || BOB_PARAMS.grunt;
  const phase = (e.id * 0.91) % (Math.PI * 2);
  const bobY = Math.sin(time * b.yHz + phase) * b.yAmp;
  const bobX = b.xAmp ? Math.sin(time * b.xHz + phase + 1) * b.xAmp : 0;
  // Wing flap drives a different cycle for flyer
  const flap = def.flying ? Math.sin(time * 11 + phase) : 0;
  return (
    <View pointerEvents="none" style={{
      position: 'absolute',
      left: e.c * TILE + (TILE - size) / 2,
      top: e.r * TILE + (TILE - size) / 2,
      width: size, height: size,
    }}>
      <View style={{ transform: [{ translateX: bobX }, { translateY: bobY }] }}>
        <CreatureSvg
          type={e.type}
          size={size}
          burning={burning}
          flap={flap}
          elite={e.elite}
          bossVariant={e.bossVariant}
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
      <View style={{
        position: 'absolute', top: -6, left: 0, width: size, height: 3,
        backgroundColor: '#000a', borderRadius: 2,
      }}>
        <View style={{
          width: Math.max(0, size * (e.hp / e.maxHp)), height: 3,
          backgroundColor: '#5cf28a', borderRadius: 2,
        }} />
      </View>
    </View>
  );
}

function CreatureSvg({ type, size, burning, flap, elite, bossVariant }) {
  if (type === 'grunt')  return elite ? <EliteGruntSvg size={size} burning={burning} />
                                      : <GruntSvg size={size} burning={burning} />;
  if (type === 'runner') return elite ? <EliteRunnerSvg size={size} burning={burning} />
                                      : <RunnerSvg size={size} burning={burning} />;
  if (type === 'tank')   return elite ? <EliteTankSvg size={size} burning={burning} />
                                      : <TankSvg size={size} burning={burning} />;
  if (type === 'swarm')  return elite ? <EliteSwarmSvg size={size} burning={burning} />
                                      : <SwarmSvg size={size} burning={burning} />;
  if (type === 'flyer')  return elite ? <EliteFlyerSvg size={size} burning={burning} flap={flap} />
                                      : <FlyerSvg size={size} burning={burning} flap={flap} />;
  if (type === 'boss') {
    if (bossVariant === 'void') return <VoidBossSvg size={size} burning={burning} />;
    return <BossSvg size={size} burning={burning} />;
  }
  if (type === 'mega')   return <MegaSvg size={size} burning={burning} />;
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
  return (
    <View pointerEvents="none" style={{
      position: 'absolute',
      left: 0, right: 0, top: VIEWPORT_H * 0.32,
      alignItems: 'center',
      opacity,
      transform: [{ translateY: slide }],
    }}>
      <Text style={{
        color: banner.boss ? '#ff4d6d' : banner.elite ? '#b08bff' : '#4cc9ff',
        fontSize: 14, fontWeight: '700',
        letterSpacing: 6,
      }}>
        {banner.boss ? '⚠  BOSS WAVE  ⚠' : banner.elite ? 'ELITE WAVE' : 'INCOMING'}
      </Text>
      <Text style={{
        color: '#fff', fontSize: 56, fontWeight: '900',
        letterSpacing: 4,
        textShadowColor: banner.boss ? '#ff4d6d' : banner.elite ? '#b08bff' : '#4cc9ff',
        textShadowOffset: { width: 0, height: 0 },
        textShadowRadius: 18,
      }}>
        WAVE {banner.wave}
      </Text>
      {banner.bossName && (
        <Text style={{
          color: '#ffd166', fontSize: 22, fontWeight: '800',
          letterSpacing: 5, marginTop: 2,
          textShadowColor: '#ff4d6d',
          textShadowOffset: { width: 0, height: 0 },
          textShadowRadius: 10,
        }}>
          {banner.bossName}
        </Text>
      )}
      <Text style={{
        color: '#9aa3c7', fontSize: 12, letterSpacing: 3, marginTop: 4,
      }}>
        {banner.total} ENEMIES
      </Text>
    </View>
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
    // Elite variant for normal enemies once we hit wave 11+.
    const elite = s.wave >= 11 && sp.type !== 'boss' && sp.type !== 'mega';
    // Boss skins by milestone wave.
    let bossVariant = null;
    if (sp.type === 'boss') {
      bossVariant = s.wave === 20 ? 'void'
        : s.wave === 30 ? 'blood'
        : s.wave === 40 ? 'destroyer'
        : s.wave === 50 ? 'ender'
        : 'demon';
    }
    s.enemies.push({
      id: s.nextEnemyId++,
      r: SPAWN.r, c: SPAWN.c,
      hp, maxHp: hp,
      type: sp.type,
      armor: def.armor,
      subPath, pathIdx: 0,
      effects: [],
      elite,
      bossVariant,
      spawnWave: s.wave,
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
  s.fx = s.fx.filter((f) => f.until > s.time);

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
  const handleHit = (enemy, dmg) => {
    // Impact sparks at enemy
    s.fx.push({
      id: s.nextFxId++,
      type: 'impact',
      x: enemy.c * TILE + TILE / 2,
      y: enemy.r * TILE + TILE / 2,
      color,
      start: s.time,
      until: s.time + 0.28,
    });
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
  tiltBtn: {
    position: 'absolute', right: 12, bottom: 64,
    width: 44, height: 44, backgroundColor: '#161c33e0',
    borderRadius: 22, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: '#2a335f',
  },
  tiltBtnText: { color: '#ffd166', fontSize: 14, fontWeight: '800', letterSpacing: 1 },

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
