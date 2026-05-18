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
// Crystal Maze Defence — inspired by classic Gem TD
//
//   • Place stones on a large tile grid (25g each). Stones are walls that
//     shape the enemy maze. They don't attack.
//   • Start a wave; enemies BFS toward the goal.
//   • When a wave starts, every stone rolls into a random Rough (I) gem of
//     one of 8 types (Sapphire, Diamond, Opal, Emerald, Amethyst, Aquamarine,
//     Ruby, Topaz).
//   • Combine 5 same-type same-tier gems → 1 of the next tier.
//     Rough → Clouded → Polished → Brilliant → Pristine → Ascendant.
//   • The board is larger than the screen — pan with one finger, pinch to zoom.
//
// 20 waves with bosses on 10, 15, and 20.
// ─────────────────────────────────────────────────────────────────────────────

const COLS = 14;
const ROWS = 22;
const TILE = 36; // logical pixels at scale=1
const BOARD_W = COLS * TILE;
const BOARD_H = ROWS * TILE;

const SCREEN = Dimensions.get('window');
const SCREEN_W = SCREEN.width;
const SCREEN_H = SCREEN.height;

// reserve room for HUD (top) + bottom bar; the rest is the viewport
const VIEWPORT_H = Math.max(360, SCREEN_H - 230);
const VIEWPORT_W = SCREEN_W;

const FIT_SCALE = Math.min(VIEWPORT_W / BOARD_W, VIEWPORT_H / BOARD_H);
const MIN_SCALE = Math.max(0.3, FIT_SCALE * 0.6);
const MAX_SCALE = 2.4;
const INITIAL_SCALE = FIT_SCALE * 0.97;

const SPAWN = { r: 0, c: Math.floor(COLS / 2) };
const GOAL = { r: ROWS - 1, c: Math.floor(COLS / 2) };

const STARTING_GOLD = 175;
const STARTING_LIVES = 25;
const STONE_COST = 25;

// ─── Gem tiers (canonical Crystal Maze purity: P1 Cracked → P6 Ascendant) ──
const TIERS = [
  { id: 1, name: 'Cracked',   short: 'P1', dmgMul: 1.0,  rangeBonus: 0,   cdMul: 1.0,  sellMul: 0.5  },
  { id: 2, name: 'Cut',       short: 'P2', dmgMul: 2.5,  rangeBonus: 0.2, cdMul: 0.95, sellMul: 0.5  },
  { id: 3, name: 'Polished',  short: 'P3', dmgMul: 6.25, rangeBonus: 0.4, cdMul: 0.9,  sellMul: 0.55 },
  { id: 4, name: 'Radiant',   short: 'P4', dmgMul: 15.6, rangeBonus: 0.7, cdMul: 0.85, sellMul: 0.6  },
  { id: 5, name: 'Perfect',   short: 'P5', dmgMul: 39,   rangeBonus: 1.1, cdMul: 0.75, sellMul: 0.65 },
  { id: 6, name: 'Ascendant', short: 'P6', dmgMul: 97,   rangeBonus: 2.0, cdMul: 0.6,  sellMul: 0.7  },
];
const tier = (n) => TIERS[n - 1];
const sellValue = (t) => Math.floor(STONE_COST * Math.pow(5, t - 1) * tier(t).sellMul);

// ─── Gem types (roles match Roblox CMD) ──────────────────────────────────────
// P6 Ascendant target stats from Roblox reference:
//   Sapphire 36 · Diamond 460 · Opal 6 · Emerald 12 · Amethyst 70 ·
//   Aquamarine 80 · Ruby 150 · Topaz 200
// Bases are tuned so base × 97 (T6 dmgMul) lands near these.
const GEMS = {
  sapphire: {
    id: 'sapphire', name: 'Sapphire', color: '#4cc9ff',
    base: { damage: 0.4, range: 3.2, cooldown: 0.6 },
    effect: { type: 'slow', factor: 0.35, duration: 1.6 }, // 65% slow
    ability: 'Slow 65% / control',
  },
  diamond: {
    id: 'diamond', name: 'Diamond', color: '#e6f1ff',
    base: { damage: 5, range: 2.6, cooldown: 0.7 },
    ability: 'High raw damage (single target)',
  },
  opal: {
    id: 'opal', name: 'Opal', color: '#ffd4f0',
    base: { damage: 0.1, range: 3.0, cooldown: 1.0 },
    multi: 2,
    ability: 'Support · multi-shot · wide range',
  },
  emerald: {
    id: 'emerald', name: 'Emerald', color: '#5cf28a',
    base: { damage: 0.15, range: 2.4, cooldown: 1.0 },
    effect: { type: 'burn', dps: 1.3, duration: 5.0 }, // poison DoT
    ability: 'Poison DoT (5s)',
  },
  amethyst: {
    id: 'amethyst', name: 'Amethyst', color: '#b08bff',
    base: { damage: 0.7, range: 2.5, cooldown: 0.6 },
    armorBreak: true, // doubles damage to enemies with armor (tank, boss, mega)
    ability: 'Armor break · 2× vs tanky',
  },
  aquamarine: {
    id: 'aquamarine', name: 'Aquamarine', color: '#7be5d1',
    base: { damage: 0.85, range: 2.8, cooldown: 0.3 }, // FAST attacks
    ability: 'Fast attacks (0.3s rate)',
  },
  ruby: {
    id: 'ruby', name: 'Ruby', color: '#ff4d6d',
    base: { damage: 1.5, range: 2.6, cooldown: 1.0 },
    splash: 1.2,
    ability: 'Splash damage (radius 1.2)',
  },
  topaz: {
    id: 'topaz', name: 'Topaz', color: '#ffd166',
    base: { damage: 2.0, range: 4.0, cooldown: 0.6 },
    multi: 3,
    ability: 'Split-shot (3 targets, long range)',
  },
};
const GEM_IDS = Object.keys(GEMS);

function gemStats(gemId, t) {
  const g = GEMS[gemId];
  const ti = tier(t);
  return {
    damage: g.base.damage * ti.dmgMul,
    range: g.base.range + ti.rangeBonus,
    cooldown: g.base.cooldown * ti.cdMul,
    splash: g.splash || 0,
    chain: g.chain || 0,
    multi: g.multi || 0,
    armorBreak: g.armorBreak || false,
    effect: g.effect
      ? { ...g.effect, dps: g.effect.dps ? g.effect.dps * ti.dmgMul : undefined }
      : null,
    color: g.color,
    name: g.name,
  };
}

// ─── Special tower recipes (inspired by Roblox CMD recipes) ────────────────
// Each special tower is a NAMED upgrade crafted from 3 specific gems. Crafting
// transforms the anchor cell into the special tower and consumes the other two
// from the board. Recipes don't stack — once crafted the result is a 'special'
// kind, not a 'gem'.
// All 18 canonical recipes from the Crystal Maze design doc. Internal IDs
// follow the original Roblox project's stable IDs. Display names use the
// latest canonical list. Ingredients are either gems ({gemType,tier}) or
// other special towers ({specialId}).
const SPECIAL_RECIPES = [
  // ── P2 ────────────────────────────────────────────────────────────────
  {
    id: 'MoonsteelPrism', name: 'Moonsteel', tier: 'P2',
    color: '#d8e1f2', accent: '#7eb6ff',
    description: 'Single-target · armor break · light slow',
    ingredients: [
      { gemType: 'sapphire', tier: 2 },
      { gemType: 'diamond',  tier: 2 },
      { gemType: 'topaz',    tier: 2 },
    ],
    stats: {
      damage: 80, range: 3.2, cooldown: 0.7, armorBreak: true,
      effect: { type: 'slow', factor: 0.5, duration: 1.2 },
    },
  },
  {
    id: 'VerdantArcstone', name: 'Wildroot', tier: 'P2',
    color: '#5cf28a', accent: '#88f088',
    description: 'Poison aura · support · reveal',
    ingredients: [
      { gemType: 'emerald',    tier: 2 },
      { gemType: 'opal',       tier: 2 },
      { gemType: 'aquamarine', tier: 2 },
    ],
    stats: {
      damage: 20, range: 3.0, cooldown: 0.55,
      effect: { type: 'burn', dps: 35, duration: 4.0 },
    },
  },
  {
    id: 'EmberstarObelisk', name: 'Ember Obelisk', tier: 'P2',
    color: '#ff8a4d', accent: '#ffd166',
    description: 'Burning splash · area denial',
    ingredients: [
      { gemType: 'ruby',       tier: 2 },
      { gemType: 'amethyst',   tier: 2 },
      { gemType: 'aquamarine', tier: 2 },
    ],
    stats: {
      damage: 45, range: 2.8, cooldown: 0.5, splash: 1.7,
      effect: { type: 'burn', dps: 18, duration: 3.0 },
    },
  },
  // ── P3 ────────────────────────────────────────────────────────────────
  {
    id: 'RoseglassFocus', name: 'Roseglass', tier: 'P3',
    color: '#ff8aff', accent: '#ffd6ff',
    description: 'Boss killer · high single-target damage',
    ingredients: [
      { gemType: 'diamond', tier: 3 },
      { gemType: 'diamond', tier: 2 },
      { gemType: 'topaz',   tier: 2 },
    ],
    stats: { damage: 180, range: 3.4, cooldown: 0.9, armorBreak: true },
  },
  {
    id: 'JadeVeilLens', name: 'Jade Oracle', tier: 'P3',
    color: '#5cf28a', accent: '#88f088',
    description: 'Poison · slow · control',
    ingredients: [
      { gemType: 'emerald',  tier: 3 },
      { gemType: 'opal',     tier: 2 },
      { gemType: 'sapphire', tier: 2 },
    ],
    stats: {
      damage: 40, range: 3.4, cooldown: 0.65,
      effect: { type: 'slow', factor: 0.45, duration: 1.6 },
    },
  },
  {
    id: 'StormsplitReactor', name: 'Stormsplit', tier: 'P3',
    color: '#ffd166', accent: '#fff7a8',
    description: 'Rapid chain lightning · swarm shredder',
    ingredients: [
      { gemType: 'topaz',      tier: 3 },
      { gemType: 'aquamarine', tier: 2 },
      { gemType: 'sapphire',   tier: 2 },
    ],
    stats: { damage: 35, range: 3.4, cooldown: 0.3, chain: 5 },
  },
  {
    id: 'GildedHexcore', name: 'Goldhex', tier: 'P3',
    color: '#ffd166', accent: '#b08bff',
    description: 'Armor shred · Greed Aura: 2× gold',
    ingredients: [
      { gemType: 'amethyst', tier: 3 },
      { gemType: 'amethyst', tier: 2 },
      { gemType: 'diamond',  tier: 2 },
    ],
    stats: { damage: 90, range: 3.0, cooldown: 0.7, armorBreak: true, goldAura: true },
  },
  // ── P4 ────────────────────────────────────────────────────────────────
  {
    id: 'MoonsteelWarden', name: 'Lunar Warden', tier: 'P4',
    color: '#c0d8ff', accent: '#fff',
    description: 'Slow / cleave · armored frontline',
    ingredients: [
      { specialId: 'MoonsteelPrism' },
      { gemType: 'aquamarine', tier: 3 },
      { gemType: 'ruby',       tier: 3 },
    ],
    stats: {
      damage: 220, range: 3.6, cooldown: 0.6, armorBreak: true, splash: 1.4,
      effect: { type: 'slow', factor: 0.5, duration: 1.5 },
    },
  },
  {
    id: 'VerdantCascade', name: 'Seraph', tier: 'P4',
    color: '#88f088', accent: '#fff',
    description: 'Poison surge · attack speed aura',
    ingredients: [
      { specialId: 'VerdantArcstone' },
      { gemType: 'emerald', tier: 3 },
      { gemType: 'topaz',   tier: 3 },
    ],
    stats: {
      damage: 60, range: 3.4, cooldown: 0.3,
      effect: { type: 'burn', dps: 90, duration: 4 },
    },
  },
  {
    id: 'ObsidianBreaker', name: 'Obsidian Breaker', tier: 'P4',
    color: '#2a335f', accent: '#ff4d6d',
    description: 'Corruption · armor shred · % damage',
    ingredients: [
      { specialId: 'GildedHexcore' },
      { gemType: 'emerald',  tier: 3 },
      { gemType: 'amethyst', tier: 3 },
    ],
    stats: { damage: 240, range: 3.2, cooldown: 0.65, armorBreak: true, goldAura: true },
  },
  {
    id: 'SkyquartzSentinel', name: 'Skylar', tier: 'P4',
    color: '#cfd5e6', accent: '#7be5d1',
    description: 'Piercing shots · line damage · high range',
    ingredients: [
      { gemType: 'diamond',  tier: 4 },
      { gemType: 'amethyst', tier: 3 },
      { gemType: 'sapphire', tier: 3 },
    ],
    stats: { damage: 480, range: 4.2, cooldown: 0.85, armorBreak: true, chain: 3 },
  },
  // ── P5 ────────────────────────────────────────────────────────────────
  {
    id: 'RoyalRoseglass', name: 'Monarch', tier: 'P5',
    color: '#ffafff', accent: '#fff',
    description: 'Divine light · purifies · true damage',
    ingredients: [
      { specialId: 'RoseglassFocus' },
      { specialId: 'MoonsteelWarden' },
      { gemType: 'diamond', tier: 4 },
    ],
    stats: { damage: 900, range: 3.8, cooldown: 0.85, armorBreak: true, splash: 1.5 },
  },
  {
    id: 'CrimsonThunderheart', name: 'Thunderheart', tier: 'P5',
    color: '#ff4d6d', accent: '#ffd166',
    description: 'Massive area damage · burning storm',
    ingredients: [
      { specialId: 'EmberstarObelisk' },
      { gemType: 'ruby',       tier: 4 },
      { gemType: 'aquamarine', tier: 4 },
    ],
    stats: {
      damage: 220, range: 3.5, cooldown: 0.5, splash: 2.2, chain: 4,
      effect: { type: 'burn', dps: 70, duration: 4 },
    },
  },
  {
    id: 'CoralResonance', name: 'Coral Choir', tier: 'P5',
    color: '#7be5d1', accent: '#5cf28a',
    description: 'Harmony · empowers · multi-target',
    ingredients: [
      { specialId: 'JadeVeilLens' },
      { gemType: 'opal',       tier: 4 },
      { gemType: 'aquamarine', tier: 4 },
    ],
    stats: {
      damage: 180, range: 3.6, cooldown: 0.3, multi: 3,
      effect: { type: 'slow', factor: 0.35, duration: 1.8 },
    },
  },
  {
    id: 'FrostsunEye', name: 'Frozen Sun', tier: 'P5',
    color: '#a8e0ff', accent: '#ffd166',
    description: 'Protector · chain · slow · all rounder',
    ingredients: [
      { specialId: 'StormsplitReactor' },
      { gemType: 'sapphire', tier: 4 },
      { gemType: 'ruby',     tier: 4 },
    ],
    stats: {
      damage: 240, range: 3.8, cooldown: 0.4, chain: 6,
      effect: { type: 'slow', factor: 0.5, duration: 2 },
    },
  },
  // ── P6 Mythic ────────────────────────────────────────────────────────
  {
    id: 'SovereignDiamondLens', name: 'Diamond Sovereign', tier: 'P6',
    color: '#fff', accent: '#ffd166',
    description: 'MYTHIC · timeless guardian · time control · true damage',
    ingredients: [
      { specialId: 'RoyalRoseglass' },
      { gemType: 'diamond',  tier: 6 },
      { gemType: 'amethyst', tier: 5 },
    ],
    stats: {
      damage: 2400, range: 4.0, cooldown: 0.7, armorBreak: true, splash: 1.8,
      effect: { type: 'slow', factor: 0.3, duration: 2 },
    },
  },
  {
    id: 'PrismaticWorldcore', name: 'Core of the World', tier: 'P6',
    color: '#b08bff', accent: '#7be5d1',
    description: 'MYTHIC · global · void explosions · all stats',
    ingredients: [
      { specialId: 'CoralResonance' },
      { gemType: 'opal',       tier: 6 },
      { gemType: 'aquamarine', tier: 5 },
      { gemType: 'topaz',      tier: 5 },
    ],
    stats: { damage: 800, range: 4.4, cooldown: 0.3, multi: 5, splash: 2.0 },
  },
  {
    id: 'AbyssbreakerMonolith', name: 'Luna', tier: 'P6',
    color: '#1a0033', accent: '#b08bff',
    description: 'MYTHIC · divine execution · judgement beam',
    ingredients: [
      { specialId: 'CrimsonThunderheart' },
      { specialId: 'ObsidianBreaker' },
      { gemType: 'ruby', tier: 6 },
    ],
    stats: {
      damage: 1800, range: 4.6, cooldown: 0.55, armorBreak: true, splash: 2.4,
      effect: { type: 'burn', dps: 600, duration: 5 },
    },
  },
];

const SPECIAL_BY_ID = Object.fromEntries(SPECIAL_RECIPES.map((r) => [r.id, r]));

// Does this tower match the given ingredient spec?
function matchesIngredient(tower, ing) {
  if (ing.specialId) {
    return tower.kind === 'special' && tower.specialId === ing.specialId;
  }
  return (
    tower.kind === 'gem' &&
    tower.gemType === ing.gemType &&
    tower.tier === ing.tier
  );
}

// Returns the array of OTHER tower instances that complete the recipe (anchor
// excluded), or null if the recipe can't be assembled around this anchor.
function findRecipeMatch(anchor, allTowers, recipe) {
  if (anchor.kind !== 'gem' && anchor.kind !== 'special') return null;
  const remaining = recipe.ingredients.slice();
  const anchorIdx = remaining.findIndex((ing) => matchesIngredient(anchor, ing));
  if (anchorIdx === -1) return null;
  remaining.splice(anchorIdx, 1);
  const usedIds = new Set([anchor.id]);
  const matched = [];
  for (const ing of remaining) {
    const m = allTowers.find(
      (t) => !usedIds.has(t.id) && matchesIngredient(t, ing)
    );
    if (!m) return null;
    usedIds.add(m.id);
    matched.push(m);
  }
  return matched;
}

// Format an ingredient for display: "Diamond P3" or "Moonsteel"
function ingredientLabel(ing) {
  if (ing.specialId) return SPECIAL_BY_ID[ing.specialId]?.name || ing.specialId;
  return `${GEMS[ing.gemType].name} ${tier(ing.tier).short}`;
}

// ─── Enemies & waves ─────────────────────────────────────────────────────────
const ENEMIES = {
  grunt:  { hp: 18,   speed: 1.6, gold: 4,  color: '#c4b9ff', size: 0.55, armored: false },
  runner: { hp: 10,   speed: 3.2, gold: 5,  color: '#ffd166', size: 0.45, armored: false },
  tank:   { hp: 90,   speed: 0.9, gold: 16, color: '#7d8aa8', size: 0.7,  armored: true  },
  swarm:  { hp: 6,    speed: 2.4, gold: 2,  color: '#ff8fab', size: 0.35, armored: false },
  boss:   { hp: 480,  speed: 1.0, gold: 70, color: '#ff4d6d', size: 0.9,  armored: true  },
  mega:   { hp: 1500, speed: 1.1, gold: 200, color: '#ff2244', size: 1.1, armored: true  },
};

const WAVES = [
  { spawns: [['grunt', 6, 0.7]] },
  { spawns: [['grunt', 10, 0.55]] },
  { spawns: [['grunt', 8, 0.5], ['runner', 4, 0.5]] },
  { spawns: [['runner', 12, 0.4]] },
  { spawns: [['grunt', 10, 0.4], ['tank', 1, 1.0]] },
  { spawns: [['swarm', 22, 0.18]] },
  { spawns: [['grunt', 14, 0.4], ['runner', 6, 0.35]] },
  { spawns: [['tank', 3, 1.2], ['grunt', 12, 0.45]] },
  { spawns: [['runner', 18, 0.3], ['swarm', 14, 0.2]] },
  { spawns: [['boss', 1, 0.5]] },
  { spawns: [['grunt', 16, 0.35], ['runner', 12, 0.3]] },
  { spawns: [['tank', 6, 1.0], ['swarm', 32, 0.15]] },
  { spawns: [['runner', 28, 0.2]] },
  { spawns: [['grunt', 18, 0.3], ['tank', 4, 1.0], ['runner', 12, 0.3]] },
  { spawns: [['boss', 2, 4.0], ['grunt', 22, 0.35], ['swarm', 30, 0.15]] },
  { spawns: [['tank', 10, 0.8]] },
  { spawns: [['runner', 36, 0.18]] },
  { spawns: [['swarm', 60, 0.1]] },
  { spawns: [['boss', 3, 3.0], ['tank', 8, 0.9]] },
  { spawns: [['mega', 1, 0.5], ['boss', 3, 2.0], ['runner', 24, 0.22]] },
];

// ─── BFS ─────────────────────────────────────────────────────────────────────
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

const emptyGrid = () =>
  Array.from({ length: ROWS }, () => Array(COLS).fill(false));

const rollGemType = () => GEM_IDS[Math.floor(Math.random() * GEM_IDS.length)];

// ─── App ─────────────────────────────────────────────────────────────────────
// Top-level shell: holds match stats and routes between Lobby / Game / End.
// Stats live in React state — persisted across runs of the same session, but
// NOT across app restarts. AsyncStorage persistence is a planned add-on.
export default function App() {
  const [screen, setScreen] = useState('lobby');
  const [lastResult, setLastResult] = useState({ won: false, score: 0, waveReached: 0 });
  const [stats, setStats] = useState({
    bestScore: 0,
    bestWave: 0,
    gamesPlayed: 0,
    wins: 0,
  });

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

  if (screen === 'lobby') {
    return <LobbyScreen stats={stats} onStartSolo={() => setScreen('game')} />;
  }
  if (screen === 'win' || screen === 'lose') {
    return (
      <EndScreen
        won={screen === 'win'}
        score={lastResult.score}
        waveReached={lastResult.waveReached}
        stats={stats}
        onPlayAgain={() => setScreen('game')}
        onLobby={() => setScreen('lobby')}
      />
    );
  }
  return <Game onEnd={recordResult} />;
}

// ─── Lobby (mobile home screen) ──────────────────────────────────────────────
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
          <StatTile label="HIGHEST WAVE" value={`${stats.bestWave}/20`} color="#4cc9ff" />
        </View>
        <View style={styles.statsRow}>
          <StatTile label="GAMES" value={stats.gamesPlayed} color="#fff" />
          <StatTile label="WINS" value={stats.wins} color="#5cf28a" />
        </View>
        {stats.gamesPlayed === 0 && (
          <Text style={styles.statsHint}>
            No games yet. Tap SOLO to play your first match.
          </Text>
        )}
      </View>

      <View style={styles.modeList}>
        <TouchableOpacity style={styles.modeBtnPrimary} onPress={onStartSolo} activeOpacity={0.85}>
          <View style={{ flex: 1 }}>
            <Text style={styles.modeBtnTitlePrimary}>SOLO</Text>
            <Text style={styles.modeBtnSubPrimary}>Defend 20 waves on your own</Text>
          </View>
          <Text style={styles.modeBtnArrow}>▶</Text>
        </TouchableOpacity>

        <View style={styles.modeBtnLocked}>
          <View style={{ flex: 1 }}>
            <Text style={styles.modeBtnTitleLocked}>QUICK MATCH</Text>
            <Text style={styles.modeBtnSubLocked}>1v1 race · matchmaking · coming soon</Text>
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
        <TouchableOpacity
          style={styles.footerBtn}
          activeOpacity={0.7}
          onPress={() => setRecipeBookOpen(true)}
        >
          <Text style={styles.footerIcon}>📖</Text>
          <Text style={styles.footerLabel}>RECIPES</Text>
        </TouchableOpacity>
        <View style={styles.footerBtn}>
          <Text style={styles.footerVersion}>v0.4</Text>
        </View>
      </View>

      <RecipeBookModal
        visible={recipeBookOpen}
        onClose={() => setRecipeBookOpen(false)}
      />
    </SafeAreaView>
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
            <TouchableOpacity
              onPress={onClose}
              hitSlop={{ top: 12, right: 12, bottom: 12, left: 12 }}
            >
              <Text style={styles.modalCloseXText}>✕</Text>
            </TouchableOpacity>
          </View>
          <ScrollView style={styles.recipeBookList}>
            <Text style={[styles.recipeRowDesc, { padding: 6, marginBottom: 8 }]}>
              Each wave's end rolls your stones into random gems. Collect the right
              gems to craft 18 named special towers. Higher tiers require lower
              specials as ingredients.
            </Text>
            {tiers.map((p) => {
              const recipes = SPECIAL_RECIPES.filter((r) => r.tier === p);
              if (recipes.length === 0) return null;
              const label = p === 'P6' ? `${p} · MYTHIC` : p;
              return (
                <View key={p}>
                  <Text style={styles.recipeBookSection}>{label}</Text>
                  {recipes.map((r) => (
                    <View
                      key={r.id}
                      style={[styles.recipeRow, { borderColor: r.accent }]}
                    >
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

function StatTile({ label, value, color }) {
  return (
    <View style={styles.statTile}>
      <Text style={styles.statTileLabel}>{label}</Text>
      <Text style={[styles.statTileValue, { color }]}>{value}</Text>
    </View>
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
          <StatTile label="WAVE REACHED" value={`${waveReached}/20`} color="#4cc9ff" />
        </View>
        {newBest && <Text style={styles.newBestText}>★ NEW BEST SCORE ★</Text>}
      </View>

      <View style={styles.modeList}>
        <TouchableOpacity style={styles.modeBtnPrimary} onPress={onPlayAgain} activeOpacity={0.85}>
          <View style={{ flex: 1 }}>
            <Text style={styles.modeBtnTitlePrimary}>PLAY AGAIN</Text>
            <Text style={styles.modeBtnSubPrimary}>Another round of 20 waves</Text>
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
      grid: emptyGrid(),
      towers: [],
      enemies: [],
      projectiles: [],
      path: bfs(emptyGrid(), SPAWN, GOAL),
      wave: 0,
      waveActive: false,
      spawnQueue: [],
      time: 0,
      nextEnemyId: 1,
      nextProjectileId: 1,
      nextTowerId: 1,
      gold: STARTING_GOLD,
      lives: STARTING_LIVES,
      score: 0,
      speed: 1,
      inspect: null,
      flash: null,
      pan: { x: 0, y: 0 },
      scale: INITIAL_SCALE,
    };
  }
  const [, setTick] = useState(0);
  const force = useCallback(() => setTick((t) => (t + 1) % 1e9), []);

  // Pan / pinch state (in a ref so render loop reads fresh values)
  const gestureRef = useRef({
    mode: null,
    startTx: 0,
    startTy: 0,
    startDist: 0,
    startScale: 1,
  });

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: (e) =>
        e.nativeEvent.touches && e.nativeEvent.touches.length >= 2,
      onMoveShouldSetPanResponder: (e, gesture) => {
        const touches = e.nativeEvent.touches;
        if (touches.length === 2) return true;
        return Math.abs(gesture.dx) > 8 || Math.abs(gesture.dy) > 8;
      },
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (e) => {
        const g = gestureRef.current;
        const touches = e.nativeEvent.touches;
        if (touches.length === 2) {
          g.mode = 'pinch';
          g.startDist = Math.hypot(
            touches[0].pageX - touches[1].pageX,
            touches[0].pageY - touches[1].pageY
          ) || 1;
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
            g.startDist = Math.hypot(
              touches[0].pageX - touches[1].pageX,
              touches[0].pageY - touches[1].pageY
            ) || 1;
            g.startScale = s.scale;
          }
          const dist = Math.hypot(
            touches[0].pageX - touches[1].pageX,
            touches[0].pageY - touches[1].pageY
          );
          const ns = Math.max(MIN_SCALE, Math.min(MAX_SCALE, g.startScale * (dist / g.startDist)));
          s.scale = ns;
        } else if (g.mode === 'pan') {
          s.pan.x = g.startTx + gesture.dx;
          s.pan.y = g.startTy + gesture.dy;
        }
      },
      onPanResponderRelease: () => {
        gestureRef.current.mode = null;
      },
      onPanResponderTerminate: () => {
        gestureRef.current.mode = null;
      },
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

  const flash = (text) => {
    s.flash = { text, until: s.time + 1.5 };
  };

  const tryPlaceStone = (r, c) => {
    if (s.grid[r][c]) return;
    if ((r === SPAWN.r && c === SPAWN.c) || (r === GOAL.r && c === GOAL.c)) return;
    for (const e of s.enemies) {
      if (Math.round(e.r) === r && Math.round(e.c) === c) return;
    }
    if (s.gold < STONE_COST) {
      flash('Not enough gold');
      return;
    }
    s.grid[r][c] = true;
    const newPath = bfs(s.grid, SPAWN, GOAL);
    if (!newPath) {
      s.grid[r][c] = false;
      flash('Would block the path');
      return;
    }
    for (const e of s.enemies) {
      const ep = bfs(s.grid, { r: Math.floor(e.r), c: Math.floor(e.c) }, GOAL);
      if (!ep) {
        s.grid[r][c] = false;
        flash('Would trap an enemy');
        return;
      }
    }
    s.gold -= STONE_COST;
    s.towers.push({
      id: s.nextTowerId++,
      r, c,
      kind: 'stone',
      cooldown: 0,
    });
    s.path = newPath;
    for (const e of s.enemies) {
      e.subPath = bfs(s.grid, { r: Math.floor(e.r), c: Math.floor(e.c) }, GOAL);
      e.pathIdx = 0;
    }
    force();
  };

  const sellTower = (towerId) => {
    const idx = s.towers.findIndex((t) => t.id === towerId);
    if (idx < 0) return;
    const t = s.towers[idx];
    if (t.kind === 'stone') {
      s.gold += Math.floor(STONE_COST * 0.5);
    } else if (t.kind === 'special') {
      // Refund roughly the cost of ingredients
      const recipe = SPECIAL_RECIPES.find((r) => r.id === t.specialId);
      const ingredientValue = recipe
        ? recipe.ingredients.reduce((sum, ing) => sum + sellValue(ing.tier), 0)
        : STONE_COST * 3;
      s.gold += Math.floor(ingredientValue * 0.6);
    } else {
      s.gold += sellValue(t.tier);
    }
    s.towers.splice(idx, 1);
    s.grid[t.r][t.c] = false;
    s.path = bfs(s.grid, SPAWN, GOAL);
    for (const e of s.enemies) {
      e.subPath = bfs(s.grid, { r: Math.floor(e.r), c: Math.floor(e.c) }, GOAL);
      e.pathIdx = 0;
    }
    s.inspect = null;
    force();
  };

  const tryCraft = (anchorId, recipeId) => {
    const anchor = s.towers.find((t) => t.id === anchorId);
    const recipe = SPECIAL_RECIPES.find((r) => r.id === recipeId);
    if (!anchor || !recipe) return;
    const others = findRecipeMatch(anchor, s.towers, recipe);
    if (!others) {
      flash('Missing ingredients');
      return;
    }
    const ids = new Set(others.map((t) => t.id));
    for (const t of others) s.grid[t.r][t.c] = false;
    s.towers = s.towers.filter((t) => !ids.has(t.id));
    anchor.kind = 'special';
    anchor.specialId = recipe.id;
    anchor.cooldown = 0;
    delete anchor.gemType;
    delete anchor.tier;
    s.path = bfs(s.grid, SPAWN, GOAL);
    for (const e of s.enemies) {
      e.subPath = bfs(s.grid, { r: Math.floor(e.r), c: Math.floor(e.c) }, GOAL);
      e.pathIdx = 0;
    }
    s.inspect = null;
    flash(`${recipe.name}!`);
    force();
  };

  const tryCombine = (towerId) => {
    const anchor = s.towers.find((t) => t.id === towerId);
    if (!anchor || anchor.kind !== 'gem') return;
    if (anchor.tier >= 6) {
      flash('Already Ascendant');
      return;
    }
    const matches = s.towers.filter(
      (t) =>
        t.id !== anchor.id &&
        t.kind === 'gem' &&
        t.gemType === anchor.gemType &&
        t.tier === anchor.tier
    );
    if (matches.length < 4) {
      flash(`Need 4 more ${GEMS[anchor.gemType].name} ${tier(anchor.tier).short}`);
      return;
    }
    const consume = matches.slice(0, 4);
    const ids = new Set(consume.map((t) => t.id));
    for (const t of consume) s.grid[t.r][t.c] = false;
    s.towers = s.towers.filter((t) => !ids.has(t.id));
    anchor.tier += 1;
    s.path = bfs(s.grid, SPAWN, GOAL);
    for (const e of s.enemies) {
      e.subPath = bfs(s.grid, { r: Math.floor(e.r), c: Math.floor(e.c) }, GOAL);
      e.pathIdx = 0;
    }
    s.inspect = null;
    if (anchor.tier === 6) {
      flash(`${GEMS[anchor.gemType].name} ASCENDANT!`);
    } else {
      flash(`${GEMS[anchor.gemType].name} ${tier(anchor.tier).short}!`);
    }
    force();
  };

  const startWave = () => {
    if (s.waveActive || s.wave >= WAVES.length) return;
    // Roll any stones into random Chipped crystals BEFORE the wave begins,
    // so the player has defenders during the wave they're about to play.
    let rolled = 0;
    for (const t of s.towers) {
      if (t.kind === 'stone') {
        t.kind = 'gem';
        t.gemType = rollGemType();
        t.tier = 1;
        t.cooldown = 0;
        rolled += 1;
      }
    }
    if (rolled > 0) {
      s.flash = { text: `Rolled ${rolled} crystal${rolled > 1 ? 's' : ''}!`, until: s.time + 1.8 };
    }
    const w = WAVES[s.wave];
    const queue = [];
    let t = s.time + 1.2; // small delay so player can see the roll
    for (const [type, count, gap] of w.spawns) {
      for (let i = 0; i < count; i++) {
        t += gap;
        queue.push({ type, atTime: t });
      }
    }
    s.spawnQueue = queue;
    s.waveActive = true;
    s.wave += 1;
    force();
  };

  const toggleSpeed = () => {
    s.speed = s.speed === 1 ? 2 : s.speed === 2 ? 3 : 1;
    force();
  };

  const recenter = () => {
    s.pan.x = 0;
    s.pan.y = 0;
    s.scale = INITIAL_SCALE;
    force();
  };

  const onBoardPress = (e) => {
    const { locationX, locationY } = e.nativeEvent;
    const c = Math.floor(locationX / TILE);
    const r = Math.floor(locationY / TILE);
    if (r < 0 || r >= ROWS || c < 0 || c >= COLS) return;
    const existing = s.towers.find((t) => t.r === r && t.c === c);
    if (existing) {
      s.inspect = existing.id;
      force();
    } else {
      tryPlaceStone(r, c);
    }
  };

  const inspectTower = s.inspect ? s.towers.find((t) => t.id === s.inspect) : null;
  const canStart = !s.waveActive && s.wave < WAVES.length;
  const flashing = s.flash && s.flash.until > s.time ? s.flash.text : null;

  // Board origin so that, at scale=1, the board would be centered in viewport.
  const boardLeft = (VIEWPORT_W - BOARD_W) / 2 + s.pan.x;
  const boardTop = (VIEWPORT_H - BOARD_H) / 2 + s.pan.y;

  return (
    <SafeAreaView style={styles.gameRoot}>
      <StatusBar barStyle="light-content" />
      <View style={styles.hud}>
        <HudStat label="LIVES" value={s.lives} color="#ff4d6d" />
        <HudStat label="GOLD" value={s.gold} color="#ffd166" />
        <HudStat
          label="WAVE"
          value={`${Math.min(s.wave + (s.waveActive ? 0 : 1), WAVES.length)}/${WAVES.length}`}
          color="#4cc9ff"
        />
        <HudStat label="SCORE" value={s.score} color="#fff" />
      </View>

      <View
        style={{
          width: VIEWPORT_W,
          height: VIEWPORT_H,
          backgroundColor: '#0a0e1c',
          overflow: 'hidden',
        }}
        {...panResponder.panHandlers}
      >
        <View
          pointerEvents="box-none"
          style={{
            position: 'absolute',
            left: boardLeft,
            top: boardTop,
            width: BOARD_W,
            height: BOARD_H,
            backgroundColor: '#0f1530',
            borderRadius: 4,
            transform: [{ scale: s.scale }],
          }}
        >
          {/* path tint */}
          {s.path && s.path.map((p, i) => (
            <View
              key={`p${i}`}
              pointerEvents="none"
              style={{
                position: 'absolute',
                left: p.c * TILE,
                top: p.r * TILE,
                width: TILE,
                height: TILE,
                backgroundColor: '#15204a',
              }}
            />
          ))}

          {/* spawn & goal */}
          <View
            pointerEvents="none"
            style={[
              styles.marker,
              { left: SPAWN.c * TILE, top: SPAWN.r * TILE, backgroundColor: '#3a1f4a' },
            ]}
          >
            <Text style={styles.markerText}>↓</Text>
          </View>
          <View
            pointerEvents="none"
            style={[
              styles.marker,
              { left: GOAL.c * TILE, top: GOAL.r * TILE, backgroundColor: '#1f4a3a' },
            ]}
          >
            <Text style={styles.markerText}>◇</Text>
          </View>

          {/* tap layer */}
          <Pressable
            onPress={onBoardPress}
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              width: BOARD_W,
              height: BOARD_H,
            }}
          />

          {/* towers */}
          {s.towers.map((t) => {
            if (t.kind === 'stone') {
              return (
                <View
                  key={`tw${t.id}`}
                  pointerEvents="none"
                  style={{
                    position: 'absolute',
                    left: t.c * TILE + TILE * 0.15,
                    top: t.r * TILE + TILE * 0.15,
                    width: TILE * 0.7,
                    height: TILE * 0.7,
                    backgroundColor: '#5a627f',
                    borderRadius: 4,
                    borderWidth: 1,
                    borderColor: '#7c84a8',
                  }}
                />
              );
            }
            if (t.kind === 'special') {
              const recipe = SPECIAL_BY_ID[t.specialId];
              if (!recipe) return null;
              const tierLevel = parseInt(recipe.tier.slice(1), 10); // P2 → 2
              return (
                <View
                  key={`tw${t.id}`}
                  pointerEvents="none"
                  style={{
                    position: 'absolute',
                    left: t.c * TILE,
                    top: t.r * TILE,
                    width: TILE,
                    height: TILE,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  {/* big halo for specials */}
                  <View
                    style={{
                      position: 'absolute',
                      width: TILE * (1.0 + tierLevel * 0.05),
                      height: TILE * (1.0 + tierLevel * 0.05),
                      borderRadius: TILE,
                      backgroundColor: recipe.accent,
                      opacity: 0.18 + tierLevel * 0.04,
                    }}
                  />
                  {/* outer ring */}
                  <View
                    style={{
                      width: TILE * 0.85,
                      height: TILE * 0.85,
                      borderRadius: TILE * 0.42,
                      backgroundColor: recipe.color,
                      borderWidth: 2,
                      borderColor: recipe.accent,
                      shadowColor: recipe.accent,
                      shadowOpacity: 1,
                      shadowRadius: 6 + tierLevel,
                      shadowOffset: { width: 0, height: 0 },
                      elevation: 4 + tierLevel,
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    {/* inner core */}
                    <View
                      style={{
                        width: TILE * 0.5,
                        height: TILE * 0.5,
                        backgroundColor: recipe.accent,
                        transform: [{ rotate: '45deg' }],
                        borderRadius: 4,
                      }}
                    />
                  </View>
                  {/* star icon overlay */}
                  <Text
                    style={{
                      position: 'absolute',
                      color: '#fff',
                      fontSize: TILE * 0.32,
                      fontWeight: '900',
                      textShadowColor: '#000a',
                      textShadowOffset: { width: 0, height: 1 },
                      textShadowRadius: 2,
                    }}
                  >
                    {tierLevel >= 6 ? '✦' : '★'}
                  </Text>
                </View>
              );
            }
            const g = GEMS[t.gemType];
            const tBlock = tier(t.tier);
            const isAscendant = t.tier === 6;
            return (
              <View
                key={`tw${t.id}`}
                pointerEvents="none"
                style={{
                  position: 'absolute',
                  left: t.c * TILE,
                  top: t.r * TILE,
                  width: TILE,
                  height: TILE,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {/* outer halo (visible from tier 3+) */}
                {t.tier >= 3 && (
                  <View
                    style={{
                      position: 'absolute',
                      width: TILE * (0.85 + t.tier * 0.04),
                      height: TILE * (0.85 + t.tier * 0.04),
                      borderRadius: TILE,
                      backgroundColor: g.color,
                      opacity: 0.15 + t.tier * 0.05,
                    }}
                  />
                )}
                {/* gem body */}
                <View
                  style={{
                    width: TILE * 0.7,
                    height: TILE * 0.7,
                    backgroundColor: g.color,
                    borderRadius: 5,
                    transform: [{ rotate: '45deg' }],
                    shadowColor: g.color,
                    shadowOpacity: 0.9,
                    shadowRadius: 4 + t.tier,
                    shadowOffset: { width: 0, height: 0 },
                    elevation: 3 + t.tier,
                    borderWidth: isAscendant ? 2 : t.tier >= 4 ? 1.5 : 0,
                    borderColor: isAscendant ? '#ffd166' : '#fff',
                  }}
                />
                {/* inner highlight */}
                <View
                  style={{
                    position: 'absolute',
                    width: TILE * 0.18,
                    height: TILE * 0.18,
                    borderRadius: TILE,
                    backgroundColor: '#fff',
                    opacity: 0.55,
                    top: TILE * 0.22,
                    left: TILE * 0.22,
                  }}
                />
                {/* tier label */}
                <Text
                  style={{
                    position: 'absolute',
                    color: t.tier >= 3 ? '#0b1020' : '#fff',
                    fontSize: TILE * 0.26,
                    fontWeight: '900',
                    textShadowColor: '#fff8',
                    textShadowOffset: { width: 0, height: 0 },
                    textShadowRadius: 1,
                  }}
                >
                  {tBlock.short}
                </Text>
              </View>
            );
          })}

          {/* enemies */}
          {s.enemies.map((e) => {
            const def = ENEMIES[e.type];
            const size = TILE * def.size;
            const slowed = e.effects.some((ef) => ef.type === 'slow');
            const burning = e.effects.some((ef) => ef.type === 'burn');
            return (
              <View
                key={`e${e.id}`}
                pointerEvents="none"
                style={{
                  position: 'absolute',
                  left: e.c * TILE + (TILE - size) / 2,
                  top: e.r * TILE + (TILE - size) / 2,
                  width: size,
                  height: size,
                }}
              >
                <View
                  style={{
                    width: size,
                    height: size,
                    borderRadius: size / 2,
                    backgroundColor: burning ? '#ff8a4d' : def.color,
                    borderWidth: slowed ? 2 : 0,
                    borderColor: '#4cc9ff',
                  }}
                />
                <View
                  style={{
                    position: 'absolute',
                    top: -5,
                    left: 0,
                    width: size,
                    height: 3,
                    backgroundColor: '#000a',
                    borderRadius: 2,
                  }}
                >
                  <View
                    style={{
                      width: Math.max(0, size * (e.hp / e.maxHp)),
                      height: 3,
                      backgroundColor: '#5cf28a',
                      borderRadius: 2,
                    }}
                  />
                </View>
              </View>
            );
          })}

          {/* projectiles */}
          {s.projectiles.map((p) => {
            const len = Math.hypot(p.toX - p.fromX, p.toY - p.fromY);
            const angle = Math.atan2(p.toY - p.fromY, p.toX - p.fromX);
            const midX = (p.fromX + p.toX) / 2;
            const midY = (p.fromY + p.toY) / 2;
            return (
              <View
                key={`pr${p.id}`}
                pointerEvents="none"
                style={{
                  position: 'absolute',
                  left: midX - len / 2,
                  top: midY - 1,
                  width: len,
                  height: 2,
                  backgroundColor: p.color,
                  opacity: 0.9,
                  transform: [{ rotate: `${angle}rad` }],
                }}
              />
            );
          })}
        </View>

        {/* floating recenter button */}
        <TouchableOpacity
          onPress={recenter}
          style={styles.recenterBtn}
        >
          <Text style={styles.recenterText}>⤢</Text>
        </TouchableOpacity>

        {flashing && (
          <View pointerEvents="none" style={styles.flashWrap}>
            <Text style={styles.flashText}>{flashing}</Text>
          </View>
        )}
      </View>

      <View style={styles.bottomBar}>
        <View style={styles.actionRow}>
          <View style={styles.stoneInfo}>
            <View style={styles.stoneIcon} />
            <View>
              <Text style={styles.stoneLabel}>STONE</Text>
              <Text style={styles.stoneCost}>{STONE_COST}g · tap a cell</Text>
            </View>
          </View>
          <TouchableOpacity
            style={[styles.actionBtn, !canStart && { opacity: 0.35 }]}
            onPress={canStart ? startWave : undefined}
          >
            <Text style={styles.actionBtnText}>
              {s.wave >= WAVES.length
                ? 'DONE'
                : s.waveActive
                  ? 'IN PROGRESS'
                  : `WAVE ${s.wave + 1}`}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.speedBtn} onPress={toggleSpeed}>
            <Text style={styles.speedBtnText}>{s.speed}x</Text>
          </TouchableOpacity>
        </View>
        <Text style={styles.tipText}>
          {s.waveActive
            ? 'Wave in progress. Pinch to zoom · drag to pan.'
            : 'Tap empty cell = stone · Tap crystal = inspect · Pinch · Drag'}
        </Text>
      </View>

      <Modal
        visible={!!inspectTower}
        transparent
        animationType="fade"
        onRequestClose={() => { s.inspect = null; force(); }}
      >
        <Pressable
          style={styles.modalBackdrop}
          onPress={() => { s.inspect = null; force(); }}
        >
          <Pressable style={styles.modalCard} onPress={() => {}}>
            <TouchableOpacity
              style={styles.modalCloseX}
              onPress={() => { s.inspect = null; force(); }}
              hitSlop={{ top: 12, right: 12, bottom: 12, left: 12 }}
            >
              <Text style={styles.modalCloseXText}>✕</Text>
            </TouchableOpacity>
            {inspectTower && (
              <InspectContent
                tower={inspectTower}
                onSell={() => sellTower(inspectTower.id)}
                onCombine={() => tryCombine(inspectTower.id)}
                onCraft={(recipeId) => tryCraft(inspectTower.id, recipeId)}
                onClose={() => { s.inspect = null; force(); }}
                boardTowers={s.towers}
              />
            )}
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

function InspectContent({ tower, onSell, onCombine, onCraft, onClose, boardTowers }) {
  if (tower.kind === 'stone') {
    return (
      <>
        <Text style={styles.modalTitle}>Stone</Text>
        <Text style={styles.modalSub}>Awaiting the next roll.</Text>
        <View style={styles.modalRow}>
          <ModalStat label="DAMAGE" value="—" />
          <ModalStat label="RANGE" value="—" />
          <ModalStat label="SELL" value={`${Math.floor(STONE_COST * 0.5)}g`} />
        </View>
        <TouchableOpacity style={[styles.modalBtn, styles.modalBtnFull, { backgroundColor: '#ff4d6d' }]} onPress={onSell}>
          <Text style={styles.modalBtnText}>SELL</Text>
        </TouchableOpacity>
      </>
    );
  }
  if (tower.kind === 'special') {
    const recipe = SPECIAL_BY_ID[tower.specialId];
    if (!recipe) {
      return <Text style={styles.modalSub}>Unknown special tower</Text>;
    }
    const refund = Math.floor(
      recipe.ingredients.reduce((s, ing) => {
        if (ing.specialId) {
          const sub = SPECIAL_BY_ID[ing.specialId];
          return s + (sub ? sub.ingredients.reduce((x, i2) => x + (i2.tier ? sellValue(i2.tier) : 0), 0) : 0);
        }
        return s + sellValue(ing.tier);
      }, 0) * 0.5
    );
    const craftableRecipes = SPECIAL_RECIPES.filter(
      (r) => findRecipeMatch(tower, boardTowers, r) !== null
    );
    return (
      <>
        <View style={styles.modalHeaderRow}>
          <View style={[styles.specialIcon, { backgroundColor: recipe.color, borderColor: recipe.accent }]}>
            <Text style={styles.specialIconStar}>★</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.modalTitle}>
              {recipe.name} <Text style={{ color: '#ffd166' }}>{recipe.tier}</Text>
            </Text>
            <Text style={styles.modalSub}>Special · {recipe.description}</Text>
          </View>
        </View>
        <View style={styles.modalRow}>
          <ModalStat label="DAMAGE" value={recipe.stats.damage} />
          <ModalStat label="RANGE" value={recipe.stats.range.toFixed(1)} />
          <ModalStat label="RATE" value={`${recipe.stats.cooldown.toFixed(2)}s`} />
          <ModalStat label="SELL" value={`${refund}g`} />
        </View>
        <TouchableOpacity style={[styles.modalBtn, styles.modalBtnFull, { backgroundColor: '#ff4d6d' }]} onPress={onSell}>
          <Text style={styles.modalBtnText}>SELL</Text>
        </TouchableOpacity>

        {craftableRecipes.length > 0 && (
          <View style={styles.craftSection}>
            <Text style={styles.craftSectionLabel}>UPGRADE RECIPES READY</Text>
            {craftableRecipes.map((r) => (
              <TouchableOpacity
                key={r.id}
                style={[styles.craftBtn, { borderColor: r.accent }]}
                onPress={() => onCraft(r.id)}
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
  // Gem
  const g = GEMS[tower.gemType];
  const t = tier(tower.tier);
  const stats = gemStats(tower.gemType, tower.tier);
  const matches = boardTowers.filter(
    (x) => x.id !== tower.id && x.kind === 'gem' && x.gemType === tower.gemType && x.tier === tower.tier
  ).length;
  const canCombine = tower.tier < 6 && matches >= 4;
  const nextTierName = tower.tier < 6 ? tier(tower.tier + 1).name : null;
  const craftableRecipes = SPECIAL_RECIPES.filter(
    (r) => findRecipeMatch(tower, boardTowers, r) !== null
  );
  return (
    <>
      <View style={styles.modalHeaderRow}>
        <View
          style={{
            width: 32, height: 32,
            backgroundColor: g.color,
            transform: [{ rotate: '45deg' }],
            borderRadius: 4,
            marginRight: 14,
            borderWidth: tower.tier >= 5 ? 2 : 0,
            borderColor: tower.tier === 6 ? '#fff' : '#ffd166',
            shadowColor: g.color,
            shadowOpacity: 0.9,
            shadowRadius: 6,
          }}
        />
        <View style={{ flex: 1 }}>
          <Text style={styles.modalTitle}>
            {g.name} <Text style={{ color: '#ffd166' }}>{t.short}</Text>
          </Text>
          <Text style={styles.modalSub}>
            {t.name} · {g.ability}
          </Text>
        </View>
      </View>
      <View style={styles.modalRow}>
        <ModalStat label="DAMAGE" value={stats.damage < 10 ? stats.damage.toFixed(1) : Math.round(stats.damage)} />
        <ModalStat label="RANGE" value={stats.range.toFixed(1)} />
        <ModalStat label="RATE" value={`${stats.cooldown.toFixed(2)}s`} />
        <ModalStat label="SELL" value={`${sellValue(tower.tier)}g`} />
      </View>
      <Text style={styles.combineHint}>
        {tower.tier === 6
          ? 'Ascendant — fully ascended.'
          : canCombine
            ? `Combine 5 ${g.name} ${t.short} → 1 ${g.name} ${nextTierName}.`
            : `Need 4 more ${g.name} ${t.short} on the board (you have ${matches}).`}
      </Text>
      <View style={styles.modalBtnRow}>
        <TouchableOpacity
          style={[styles.modalBtn, { backgroundColor: canCombine ? '#5cf28a' : '#2a335f' }, !canCombine && { opacity: 0.55 }]}
          onPress={canCombine ? onCombine : undefined}
        >
          <Text style={[styles.modalBtnText, canCombine && { color: '#0b1020' }]}>COMBINE</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.modalBtn, { backgroundColor: '#ff4d6d' }]} onPress={onSell}>
          <Text style={styles.modalBtnText}>SELL</Text>
        </TouchableOpacity>
      </View>

      {craftableRecipes.length > 0 && (
        <View style={styles.craftSection}>
          <Text style={styles.craftSectionLabel}>SPECIAL TOWER RECIPES READY</Text>
          {craftableRecipes.map((r) => (
            <TouchableOpacity
              key={r.id}
              style={[styles.craftBtn, { borderColor: r.accent }]}
              onPress={() => onCraft(r.id)}
              activeOpacity={0.85}
            >
              <View style={[styles.craftIcon, { backgroundColor: r.color, borderColor: r.accent }]}>
                <Text style={styles.specialIconStar}>★</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.craftBtnName}>{r.name}</Text>
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

function ModalStat({ label, value }) {
  return (
    <View style={styles.modalStat}>
      <Text style={styles.modalStatLabel}>{label}</Text>
      <Text style={styles.modalStatValue}>{value}</Text>
    </View>
  );
}

// ─── Step ────────────────────────────────────────────────────────────────────
function step(dt, s, onEnd) {
  s.time += dt;

  while (s.spawnQueue.length && s.spawnQueue[0].atTime <= s.time) {
    const sp = s.spawnQueue.shift();
    const def = ENEMIES[sp.type];
    const subPath = bfs(s.grid, SPAWN, GOAL) || [SPAWN, GOAL];
    s.enemies.push({
      id: s.nextEnemyId++,
      r: SPAWN.r,
      c: SPAWN.c,
      hp: def.hp,
      maxHp: def.hp,
      type: sp.type,
      subPath,
      pathIdx: 0,
      effects: [],
    });
  }

  for (const e of s.enemies) {
    if (e.hp <= 0) continue;
    const def = ENEMIES[e.type];
    e.effects = e.effects.filter((ef) => ef.until > s.time);
    let speedMul = 1;
    for (const ef of e.effects) {
      if (ef.type === 'slow') speedMul = Math.min(speedMul, ef.factor);
      if (ef.type === 'burn') e.hp -= ef.dps * dt;
    }
    if (e.hp <= 0) continue;
    if (!e.subPath || e.pathIdx >= e.subPath.length) {
      const fresh = bfs(s.grid, { r: Math.floor(e.r), c: Math.floor(e.c) }, GOAL);
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

  for (const t of s.towers) {
    if (t.kind === 'stone') continue;
    t.cooldown = Math.max(0, t.cooldown - dt);
    if (t.cooldown > 0) continue;
    let stats;
    if (t.kind === 'gem') {
      stats = gemStats(t.gemType, t.tier);
    } else if (t.kind === 'special') {
      const recipe = SPECIAL_RECIPES.find((r) => r.id === t.specialId);
      if (!recipe) continue;
      stats = { ...recipe.stats, color: recipe.accent || recipe.color, name: recipe.name };
    } else {
      continue;
    }
    const inRange = [];
    for (const e of s.enemies) {
      if (e.hp <= 0) continue;
      const d = Math.hypot(e.r - t.r, e.c - t.c);
      if (d <= stats.range) inRange.push({ e, d });
    }
    if (inRange.length === 0) continue;
    inRange.sort((a, b) => a.d - b.d);
    t.cooldown = stats.cooldown;

    if (stats.multi) {
      const targets = inRange.slice(0, stats.multi);
      for (const { e } of targets) {
        applyDamage(e, stats, s);
        s.projectiles.push(makeProjectile(t, e, stats.color, s));
      }
    } else if (stats.chain) {
      let prev = inRange[0].e;
      applyDamage(prev, stats, s);
      s.projectiles.push(makeProjectile(t, prev, stats.color, s));
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
        applyDamage(best, { ...stats, damage: stats.damage * 0.7 }, s);
        s.projectiles.push({
          id: s.nextProjectileId++,
          fromX: prev.c * TILE + TILE / 2,
          fromY: prev.r * TILE + TILE / 2,
          toX: best.c * TILE + TILE / 2,
          toY: best.r * TILE + TILE / 2,
          color: stats.color,
          until: s.time + 0.08,
        });
        hit.add(best.id);
        prev = best;
        remaining -= 1;
      }
    } else {
      const target = inRange[0].e;
      applyDamage(target, stats, s);
      s.projectiles.push(makeProjectile(t, target, stats.color, s));
      if (stats.splash) {
        for (const e of s.enemies) {
          if (e === target || e.hp <= 0) continue;
          const d = Math.hypot(e.r - target.r, e.c - target.c);
          if (d <= stats.splash) applyDamage(e, { ...stats, splash: 0, damage: stats.damage * 0.6 }, s);
        }
      }
    }
  }

  s.projectiles = s.projectiles.filter((p) => p.until > s.time);

  // Greed Aura: any active special tower with goldAura doubles kill gold.
  const goldAuraActive = s.towers.some((t) => {
    if (t.kind !== 'special') return false;
    const r = SPECIAL_RECIPES.find((x) => x.id === t.specialId);
    return r && r.stats.goldAura;
  });
  const goldMul = goldAuraActive ? 2 : 1;

  const alive = [];
  for (const e of s.enemies) {
    if (e.hp <= 0) {
      if (e.subPath && e.pathIdx < e.subPath.length) {
        const def = ENEMIES[e.type];
        s.gold += def.gold * goldMul;
        s.score += def.gold * 2;
      }
    } else {
      alive.push(e);
    }
  }
  s.enemies = alive;

  if (s.waveActive && s.spawnQueue.length === 0 && s.enemies.length === 0) {
    s.waveActive = false;
    s.gold += 20 + s.wave * 6;
    s.score += 100 + s.wave * 20;
    s.flash = { text: `Wave ${s.wave} cleared! +${20 + s.wave * 6}g`, until: s.time + 1.8 };
    if (s.wave >= WAVES.length) {
      onEnd(true, s.score, s.wave);
    }
  }

  if (s.lives <= 0) onEnd(false, s.score, s.wave);
}

function makeProjectile(tower, enemy, color, s) {
  return {
    id: s.nextProjectileId++,
    fromX: tower.c * TILE + TILE / 2,
    fromY: tower.r * TILE + TILE / 2,
    toX: enemy.c * TILE + TILE / 2,
    toY: enemy.r * TILE + TILE / 2,
    color,
    until: s.time + 0.08,
  };
}

function applyDamage(enemy, stats, s) {
  const def = ENEMIES[enemy.type];
  const armorMul = stats.armorBreak && def.armored ? 2.0 : 1.0;
  enemy.hp -= stats.damage * armorMul;
  if (stats.effect) {
    enemy.effects = enemy.effects.filter((ef) => ef.type !== stats.effect.type);
    enemy.effects.push({ ...stats.effect, until: s.time + stats.effect.duration });
  }
}

function HudStat({ label, value, color }) {
  return (
    <View style={styles.hudStat}>
      <Text style={styles.hudLabel}>{label}</Text>
      <Text style={[styles.hudValue, { color }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  // ── Lobby ────────────────────────────────────────────────────────────────
  lobbyRoot: {
    flex: 1,
    backgroundColor: '#0b1020',
    paddingHorizontal: 18,
    paddingTop: 24,
    paddingBottom: 12,
    justifyContent: 'space-between',
  },
  lobbyHeader: {
    alignItems: 'center',
    marginTop: 32,
  },
  lobbyCrystalRow: { flexDirection: 'row', marginBottom: 8 },
  lobbyCrystal: {
    fontSize: 64,
    marginHorizontal: 6,
    textShadowColor: '#4cc9ff60',
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 12,
  },
  lobbyTitle: {
    color: '#fff',
    fontSize: 38,
    fontWeight: '900',
    letterSpacing: 2,
    textShadowColor: '#4cc9ff80',
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 16,
  },
  lobbySubtitle: {
    color: '#9aa3c7',
    fontSize: 14,
    letterSpacing: 8,
    marginTop: 4,
  },

  statsCard: {
    backgroundColor: '#161c33',
    borderRadius: 16,
    padding: 14,
    borderWidth: 1,
    borderColor: '#2a335f',
  },
  statsCardLabel: {
    color: '#7c84a8',
    fontSize: 12,
    letterSpacing: 2,
    fontWeight: '700',
    marginBottom: 10,
    textAlign: 'center',
  },
  statsRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    marginBottom: 6,
  },
  statTile: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 6,
  },
  statTileLabel: {
    color: '#7c84a8',
    fontSize: 12,
    letterSpacing: 1.5,
    fontWeight: '600',
  },
  statTileValue: {
    fontSize: 22,
    fontWeight: '800',
    marginTop: 2,
  },
  statsHint: {
    color: '#7c84a8',
    fontSize: 12,
    textAlign: 'center',
    fontStyle: 'italic',
    marginTop: 4,
  },
  newBestText: {
    color: '#ffd166',
    fontSize: 14,
    fontWeight: '900',
    letterSpacing: 2,
    textAlign: 'center',
    marginTop: 8,
  },

  modeList: { gap: 12 },
  modeBtnPrimary: {
    backgroundColor: '#4cc9ff',
    paddingHorizontal: 20,
    paddingVertical: 18,
    borderRadius: 16,
    flexDirection: 'row',
    alignItems: 'center',
    shadowColor: '#4cc9ff',
    shadowOpacity: 0.5,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  modeBtnTitlePrimary: {
    color: '#0b1020',
    fontSize: 20,
    fontWeight: '900',
    letterSpacing: 2,
  },
  modeBtnSubPrimary: {
    color: '#0b1020',
    fontSize: 12,
    opacity: 0.7,
    marginTop: 2,
  },
  modeBtnArrow: {
    color: '#0b1020',
    fontSize: 22,
    fontWeight: '900',
  },
  modeBtnSecondary: {
    backgroundColor: '#2a335f',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderRadius: 16,
    alignItems: 'center',
    marginTop: 8,
  },
  modeBtnTitleSecondary: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '800',
    letterSpacing: 2,
  },
  modeBtnLocked: {
    backgroundColor: '#161c33',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderRadius: 16,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#2a335f',
    opacity: 0.7,
  },
  modeBtnTitleLocked: {
    color: '#9aa3c7',
    fontSize: 16,
    fontWeight: '800',
    letterSpacing: 1.5,
  },
  modeBtnSubLocked: {
    color: '#7c84a8',
    fontSize: 12,
    marginTop: 2,
  },
  modeBtnLock: { fontSize: 18 },

  lobbyFooter: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: '#161c33',
  },
  footerBtn: {
    alignItems: 'center',
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  footerIcon: { color: '#9aa3c7', fontSize: 22 },
  footerLabel: { color: '#7c84a8', fontSize: 12, letterSpacing: 1, marginTop: 2 },
  footerVersion: { color: '#7c84a8', fontSize: 12 },

  // ── Game HUD & board ─────────────────────────────────────────────────────
  gameRoot: { flex: 1, backgroundColor: '#0b1020' },
  hud: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    paddingVertical: 10,
    paddingHorizontal: 8,
    backgroundColor: '#0a0e1c',
  },
  hudStat: { alignItems: 'center', minWidth: 64 },
  hudLabel: { color: '#7c84a8', fontSize: 12, letterSpacing: 1.5, fontWeight: '600' },
  hudValue: { fontSize: 20, fontWeight: '800', marginTop: 2 },

  marker: { position: 'absolute', width: TILE, height: TILE, alignItems: 'center', justifyContent: 'center' },
  markerText: { color: '#fff', fontSize: TILE * 0.5, opacity: 0.55 },

  recenterBtn: {
    position: 'absolute',
    right: 12,
    bottom: 12,
    width: 44, height: 44,
    backgroundColor: '#161c33e0',
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#2a335f',
  },
  recenterText: { color: '#fff', fontSize: 22, fontWeight: '800' },

  bottomBar: { paddingHorizontal: 12, paddingTop: 10, paddingBottom: 10 },
  stoneInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#161c33',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 12,
    marginRight: 8,
  },
  stoneIcon: {
    width: 24, height: 24,
    backgroundColor: '#5a627f',
    borderRadius: 4,
    borderWidth: 1,
    borderColor: '#7c84a8',
    marginRight: 10,
  },
  stoneLabel: { color: '#fff', fontWeight: '800', fontSize: 13, letterSpacing: 1 },
  stoneCost: { color: '#9aa3c7', fontSize: 12, marginTop: 1 },

  actionRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginVertical: 6 },
  actionBtn: {
    flex: 1,
    backgroundColor: '#4cc9ff',
    paddingVertical: 14,
    borderRadius: 999,
    alignItems: 'center',
    marginRight: 8,
    shadowColor: '#4cc9ff',
    shadowOpacity: 0.4,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 3 },
  },
  actionBtnText: { color: '#0b1020', fontWeight: '900', fontSize: 14, letterSpacing: 1.5 },
  speedBtn: {
    backgroundColor: '#2a335f',
    width: 48, height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  speedBtnText: { color: '#fff', fontWeight: '800', fontSize: 14 },
  tipText: { color: '#7c84a8', fontSize: 12, textAlign: 'center', marginTop: 6 },

  flashWrap: { position: 'absolute', top: 16, left: 0, right: 0, alignItems: 'center' },
  flashText: {
    color: '#fff',
    backgroundColor: '#000c',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
    fontSize: 14,
    fontWeight: '800',
    overflow: 'hidden',
  },

  // ── Modal ────────────────────────────────────────────────────────────────
  modalBackdrop: {
    flex: 1,
    backgroundColor: '#000c',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  modalCard: {
    backgroundColor: '#161c33',
    borderRadius: 18,
    padding: 22,
    paddingTop: 26,
    width: '100%',
    maxWidth: 420,
    borderWidth: 1,
    borderColor: '#2a335f',
    shadowColor: '#000',
    shadowOpacity: 0.6,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
  },
  modalCloseX: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10,
  },
  modalCloseXText: { color: '#9aa3c7', fontSize: 22, fontWeight: '700' },
  modalHeaderRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 10, paddingRight: 32 },
  modalTitle: { color: '#fff', fontSize: 22, fontWeight: '800' },
  modalSub: { color: '#9aa3c7', fontSize: 12, marginTop: 3 },
  modalRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    marginVertical: 14,
    backgroundColor: '#0f1530',
    borderRadius: 12,
    paddingVertical: 12,
  },
  modalStat: { alignItems: 'center', flex: 1 },
  modalStatLabel: { color: '#7c84a8', fontSize: 12, letterSpacing: 1, fontWeight: '600' },
  modalStatValue: { color: '#fff', fontSize: 16, fontWeight: '800', marginTop: 2 },
  combineHint: { color: '#9aa3c7', fontSize: 13, textAlign: 'center', marginBottom: 14, lineHeight: 18 },
  modalBtnRow: { flexDirection: 'row', justifyContent: 'space-between' },
  modalBtn: {
    flex: 1,
    minHeight: 44,
    paddingVertical: 12,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
    marginHorizontal: 4,
  },
  modalBtnFull: { flex: 0, marginHorizontal: 0 },
  modalBtnText: { color: '#fff', fontWeight: '800', fontSize: 13, letterSpacing: 1 },

  // Special towers
  specialIcon: {
    width: 36, height: 36,
    borderRadius: 18,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 14,
  },
  specialIconStar: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '900',
    textShadowColor: '#000a',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2,
  },

  craftSection: {
    marginTop: 16,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#2a335f',
  },
  craftSectionLabel: {
    color: '#ffd166',
    fontSize: 12,
    letterSpacing: 1.5,
    fontWeight: '800',
    marginBottom: 8,
    textAlign: 'center',
  },
  craftBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#0f1530',
    padding: 10,
    paddingRight: 14,
    borderRadius: 12,
    marginBottom: 8,
    borderWidth: 1.5,
  },
  craftIcon: {
    width: 32, height: 32,
    borderRadius: 16,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  craftBtnName: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '800',
  },
  craftBtnDesc: {
    color: '#9aa3c7',
    fontSize: 12,
    marginTop: 1,
  },
  craftBtnArrow: {
    color: '#ffd166',
    fontSize: 18,
    fontWeight: '900',
    marginLeft: 6,
  },

  // Recipe Book
  recipeBookCard: {
    backgroundColor: '#161c33',
    borderRadius: 18,
    padding: 0,
    width: '100%',
    maxWidth: 480,
    maxHeight: '85%',
    borderWidth: 1,
    borderColor: '#2a335f',
    overflow: 'hidden',
  },
  recipeBookHeader: {
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#2a335f',
    flexDirection: 'row',
    alignItems: 'center',
  },
  recipeBookTitle: {
    color: '#fff',
    fontSize: 22,
    fontWeight: '900',
    letterSpacing: 1,
    flex: 1,
  },
  recipeBookList: { paddingHorizontal: 14, paddingVertical: 10 },
  recipeBookSection: {
    color: '#ffd166',
    fontSize: 13,
    letterSpacing: 2,
    fontWeight: '800',
    marginTop: 10,
    marginBottom: 6,
    paddingHorizontal: 6,
  },
  recipeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#0f1530',
    padding: 10,
    borderRadius: 10,
    marginBottom: 6,
    borderWidth: 1,
  },
  recipeRowText: { flex: 1, marginLeft: 10 },
  recipeRowName: { color: '#fff', fontSize: 14, fontWeight: '800' },
  recipeRowDesc: { color: '#9aa3c7', fontSize: 11, marginTop: 2 },
  recipeRowIngredients: { color: '#7c84a8', fontSize: 11, marginTop: 4, fontStyle: 'italic' },
});
