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
} from 'react-native';
import { StatusBar } from 'expo-status-bar';

// ─────────────────────────────────────────────────────────────────────────────
// Crystal Maze Defence — inspired by classic Gem TD
//
//   • Place stones on a large tile grid (25g each). Stones are walls that
//     shape the enemy maze. They don't attack.
//   • Start a wave; enemies BFS toward the goal.
//   • When the wave ends, every stone rolls into a random Chipped (I) gem of
//     one of 8 types.
//   • Combine 5 same-type same-tier gems → 1 of the next tier.
//     Chipped → Flawed → Normal → Flawless → Perfect.
//   • Ultimate recipe: 5 different-type Perfect (V) gems → 1 Ultimate Crystal
//     (massive damage, every ability, max range).
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

const STARTING_GOLD = 100;
const STARTING_LIVES = 25;
const STONE_COST = 25;

// ─── Gem tiers ───────────────────────────────────────────────────────────────
const TIERS = [
  { id: 1, name: 'Chipped',   short: 'I',   dmgMul: 1.0,  rangeBonus: 0,   cdMul: 1.0,  sellMul: 0.5  },
  { id: 2, name: 'Flawed',    short: 'II',  dmgMul: 1.8,  rangeBonus: 0.2, cdMul: 0.95, sellMul: 0.5  },
  { id: 3, name: 'Normal',    short: 'III', dmgMul: 3.2,  rangeBonus: 0.4, cdMul: 0.9,  sellMul: 0.55 },
  { id: 4, name: 'Flawless',  short: 'IV',  dmgMul: 5.8,  rangeBonus: 0.6, cdMul: 0.85, sellMul: 0.6  },
  { id: 5, name: 'Perfect',   short: 'V',   dmgMul: 10.5, rangeBonus: 1.0, cdMul: 0.75, sellMul: 0.65 },
  { id: 6, name: 'Ultimate',  short: '★',   dmgMul: 28,   rangeBonus: 2.0, cdMul: 0.55, sellMul: 0.7  },
];
const tier = (n) => TIERS[n - 1];
const sellValue = (t) => Math.floor(STONE_COST * Math.pow(5, t - 1) * tier(t).sellMul);

// ─── Gem types ───────────────────────────────────────────────────────────────
const GEMS = {
  diamond: {
    id: 'diamond', name: 'Diamond', color: '#e6f1ff',
    base: { damage: 5, range: 2.6, cooldown: 1.0 },
    ability: 'High single-target damage',
  },
  ruby: {
    id: 'ruby', name: 'Ruby', color: '#ff4d6d',
    base: { damage: 2, range: 2.4, cooldown: 0.6 },
    effect: { type: 'burn', dps: 3, duration: 2.0 },
    ability: 'Burn DoT (3 dps · 2s)',
  },
  sapphire: {
    id: 'sapphire', name: 'Sapphire', color: '#4cc9ff',
    base: { damage: 1, range: 3.0, cooldown: 0.8 },
    effect: { type: 'slow', factor: 0.5, duration: 1.4 },
    ability: 'Slow 50% (1.4s)',
  },
  emerald: {
    id: 'emerald', name: 'Emerald', color: '#5cf28a',
    base: { damage: 3, range: 2.3, cooldown: 0.9 },
    splash: 1.0,
    ability: 'Splash 1.0 radius',
  },
  topaz: {
    id: 'topaz', name: 'Topaz', color: '#ffd166',
    base: { damage: 2, range: 3.0, cooldown: 0.7 },
    chain: 3,
    ability: 'Chain lightning (3 jumps)',
  },
  amethyst: {
    id: 'amethyst', name: 'Amethyst', color: '#b08bff',
    base: { damage: 1.5, range: 2.5, cooldown: 0.5 },
    multi: 2,
    ability: 'Fires at 2 enemies',
  },
  aquamarine: {
    id: 'aquamarine', name: 'Aquamarine', color: '#7be5d1',
    base: { damage: 4, range: 3.5, cooldown: 1.1 },
    ability: 'Long range sniper',
  },
  opal: {
    id: 'opal', name: 'Opal', color: '#ffd4f0',
    base: { damage: 0.8, range: 2.2, cooldown: 0.22 },
    ability: 'Frenzy: 4–5 shots/s',
  },
};
const GEM_IDS = Object.keys(GEMS);

function gemStats(gemId, t, ultimate = false) {
  const g = GEMS[gemId];
  const ti = tier(t);
  const stats = {
    damage: g.base.damage * ti.dmgMul,
    range: g.base.range + ti.rangeBonus,
    cooldown: g.base.cooldown * ti.cdMul,
    splash: g.splash || 0,
    chain: g.chain || 0,
    multi: g.multi || 0,
    effect: g.effect
      ? { ...g.effect, dps: g.effect.dps ? g.effect.dps * ti.dmgMul : undefined }
      : null,
    color: g.color,
    name: g.name,
  };
  if (ultimate) {
    // Ultimate Crystal: every ability stacked on top of base stats
    stats.splash = Math.max(stats.splash, 1.2);
    stats.chain = Math.max(stats.chain, 4);
    stats.multi = Math.max(stats.multi, 3);
    stats.effect = { type: 'burn', dps: 12 * ti.dmgMul, duration: 3.0 };
  }
  return stats;
}

// ─── Enemies & waves ─────────────────────────────────────────────────────────
const ENEMIES = {
  grunt:  { hp: 18,   speed: 1.6, gold: 4,  color: '#c4b9ff', size: 0.55 },
  runner: { hp: 10,   speed: 3.2, gold: 5,  color: '#ffd166', size: 0.45 },
  tank:   { hp: 90,   speed: 0.9, gold: 16, color: '#7d8aa8', size: 0.7  },
  swarm:  { hp: 6,    speed: 2.4, gold: 2,  color: '#ff8fab', size: 0.35 },
  boss:   { hp: 480,  speed: 1.0, gold: 70, color: '#ff4d6d', size: 0.9  },
  mega:   { hp: 1500, speed: 1.1, gold: 200, color: '#ff2244', size: 1.1 },
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
export default function App() {
  const [screen, setScreen] = useState('menu');
  const [finalScore, setFinalScore] = useState(0);

  if (screen === 'menu') return <MenuScreen onStart={() => setScreen('game')} />;
  if (screen === 'win' || screen === 'lose')
    return (
      <EndScreen
        won={screen === 'win'}
        score={finalScore}
        onBack={() => setScreen('menu')}
      />
    );
  return (
    <Game
      onEnd={(won, score) => {
        setFinalScore(score);
        setScreen(won ? 'win' : 'lose');
      }}
    />
  );
}

function MenuScreen({ onStart }) {
  return (
    <SafeAreaView style={styles.menuRoot}>
      <StatusBar style="light" />
      <View style={styles.menuTop}>
        <View style={styles.menuCrystalRow}>
          <Text style={[styles.menuCrystal, { color: '#ff4d6d' }]}>◆</Text>
          <Text style={[styles.menuCrystal, { color: '#4cc9ff' }]}>◆</Text>
          <Text style={[styles.menuCrystal, { color: '#5cf28a' }]}>◆</Text>
        </View>
        <Text style={styles.menuTitle}>Crystal Maze</Text>
        <Text style={styles.menuSubtitle}>D E F E N C E</Text>
      </View>
      <View style={styles.menuMid}>
        <Text style={styles.menuRule}>Place stones. They become random gems each wave.</Text>
        <Text style={styles.menuRule}>Combine 5 of the same to upgrade.</Text>
        <Text style={styles.menuRule}>5 different Perfect gems → Ultimate.</Text>
        <Text style={styles.menuRule}>Pinch to zoom · drag to pan.</Text>
        <Text style={styles.menuRule}>Survive 20 waves.</Text>
      </View>
      <TouchableOpacity style={styles.bigButton} onPress={onStart}>
        <Text style={styles.bigButtonText}>BEGIN</Text>
      </TouchableOpacity>
      <View style={{ height: 24 }} />
    </SafeAreaView>
  );
}

function EndScreen({ won, score, onBack }) {
  return (
    <SafeAreaView style={styles.menuRoot}>
      <StatusBar style="light" />
      <View style={styles.menuTop}>
        <Text style={[styles.menuCrystal, won ? { color: '#5cf28a' } : { color: '#ff4d6d' }]}>
          {won ? '★' : '✦'}
        </Text>
        <Text style={styles.menuTitle}>{won ? 'Victory' : 'Defeated'}</Text>
        <Text style={styles.menuSubtitle}>SCORE  {score}</Text>
      </View>
      <View style={styles.menuMid}>
        <Text style={styles.menuRule}>
          {won ? 'The crystals shine on.' : 'The maze has fallen.'}
        </Text>
      </View>
      <TouchableOpacity style={styles.bigButton} onPress={onBack}>
        <Text style={styles.bigButtonText}>RETURN</Text>
      </TouchableOpacity>
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

  const tryCombine = (towerId) => {
    const anchor = s.towers.find((t) => t.id === towerId);
    if (!anchor || anchor.kind !== 'gem') return;
    if (anchor.tier >= 6) {
      flash('Already Ultimate');
      return;
    }
    const matches = s.towers.filter(
      (t) =>
        t.id !== anchor.id &&
        t.kind === 'gem' &&
        t.gemType === anchor.gemType &&
        t.tier === anchor.tier &&
        !t.ultimate
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
    flash(`${GEMS[anchor.gemType].name} ${tier(anchor.tier).short}!`);
    force();
  };

  const tryUltimate = (towerId) => {
    const anchor = s.towers.find((t) => t.id === towerId);
    if (!anchor || anchor.kind !== 'gem' || anchor.tier !== 5 || anchor.ultimate) return;
    // need 4 more Perfect gems of 4 different types (none matching anchor)
    const perfects = s.towers.filter(
      (t) => t.id !== anchor.id && t.kind === 'gem' && t.tier === 5 && !t.ultimate
    );
    const distinctTypes = new Set();
    const pick = [];
    for (const p of perfects) {
      if (p.gemType === anchor.gemType) continue;
      if (distinctTypes.has(p.gemType)) continue;
      distinctTypes.add(p.gemType);
      pick.push(p);
      if (pick.length === 4) break;
    }
    if (pick.length < 4) {
      flash('Need 4 more different Perfect gems');
      return;
    }
    const ids = new Set(pick.map((t) => t.id));
    for (const t of pick) s.grid[t.r][t.c] = false;
    s.towers = s.towers.filter((t) => !ids.has(t.id));
    anchor.tier = 6;
    anchor.ultimate = true;
    s.path = bfs(s.grid, SPAWN, GOAL);
    for (const e of s.enemies) {
      e.subPath = bfs(s.grid, { r: Math.floor(e.r), c: Math.floor(e.c) }, GOAL);
      e.pathIdx = 0;
    }
    s.inspect = null;
    flash('ULTIMATE CRYSTAL!');
    force();
  };

  const startWave = () => {
    if (s.waveActive || s.wave >= WAVES.length) return;
    const w = WAVES[s.wave];
    const queue = [];
    let t = s.time + 0.5;
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
      <StatusBar style="light" />
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
            const g = GEMS[t.gemType];
            const tBlock = tier(t.tier);
            return (
              <View
                key={`tw${t.id}`}
                pointerEvents="none"
                style={{
                  position: 'absolute',
                  left: t.c * TILE + TILE * 0.1,
                  top: t.r * TILE + TILE * 0.1,
                  width: TILE * 0.8,
                  height: TILE * 0.8,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <View
                  style={{
                    width: TILE * 0.7,
                    height: TILE * 0.7,
                    backgroundColor: t.ultimate ? '#fff' : g.color,
                    borderRadius: 4,
                    transform: [{ rotate: '45deg' }],
                    shadowColor: t.ultimate ? '#fff' : g.color,
                    shadowOpacity: 0.7 + t.tier * 0.05,
                    shadowRadius: 4 + t.tier,
                    elevation: 3 + t.tier,
                    borderWidth: t.tier >= 4 ? 2 : 0,
                    borderColor: t.ultimate ? '#ffd166' : t.tier >= 5 ? '#fff' : '#ffd166',
                  }}
                />
                <Text
                  style={{
                    position: 'absolute',
                    color: t.ultimate ? '#0b1020' : t.tier >= 3 ? '#0b1020' : '#fff',
                    fontSize: TILE * 0.28,
                    fontWeight: '900',
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
            : 'Tap empty cell = stone · Tap gem = inspect · Pinch · Drag'}
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
            {inspectTower && (
              <InspectContent
                tower={inspectTower}
                onSell={() => sellTower(inspectTower.id)}
                onCombine={() => tryCombine(inspectTower.id)}
                onUltimate={() => tryUltimate(inspectTower.id)}
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

function InspectContent({ tower, onSell, onCombine, onUltimate, onClose, boardTowers }) {
  if (tower.kind === 'stone') {
    return (
      <>
        <Text style={styles.modalTitle}>Stone</Text>
        <Text style={styles.modalSub}>Awaiting the next roll.</Text>
        <View style={styles.modalRow}>
          <ModalStat label="Damage" value="—" />
          <ModalStat label="Range" value="—" />
          <ModalStat label="Sell" value={`${Math.floor(STONE_COST * 0.5)}g`} />
        </View>
        <View style={styles.modalBtnRow}>
          <TouchableOpacity style={[styles.modalBtn, { backgroundColor: '#ff4d6d' }]} onPress={onSell}>
            <Text style={styles.modalBtnText}>SELL</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.modalBtn, { backgroundColor: '#2a335f' }]} onPress={onClose}>
            <Text style={styles.modalBtnText}>CLOSE</Text>
          </TouchableOpacity>
        </View>
      </>
    );
  }
  const g = GEMS[tower.gemType];
  const t = tier(tower.tier);
  const stats = gemStats(tower.gemType, tower.tier, tower.ultimate);
  const matches = boardTowers.filter(
    (x) => x.id !== tower.id && x.kind === 'gem' && x.gemType === tower.gemType && x.tier === tower.tier && !x.ultimate
  ).length;
  const canCombine = !tower.ultimate && tower.tier < 5 && matches >= 4;
  const perfectsDifferent = !tower.ultimate && tower.tier === 5
    ? new Set(
        boardTowers
          .filter((x) => x.id !== tower.id && x.kind === 'gem' && x.tier === 5 && !x.ultimate && x.gemType !== tower.gemType)
          .map((x) => x.gemType)
      ).size
    : 0;
  const canUltimate = !tower.ultimate && tower.tier === 5 && perfectsDifferent >= 4;
  return (
    <>
      <View style={styles.modalHeaderRow}>
        <View
          style={{
            width: 28, height: 28,
            backgroundColor: tower.ultimate ? '#fff' : g.color,
            transform: [{ rotate: '45deg' }],
            borderRadius: 3,
            marginRight: 12,
            borderWidth: tower.ultimate ? 2 : 0,
            borderColor: '#ffd166',
          }}
        />
        <View style={{ flex: 1 }}>
          <Text style={styles.modalTitle}>
            {tower.ultimate ? 'Ultimate ' : ''}{g.name}{' '}
            <Text style={{ color: '#ffd166' }}>{t.short}</Text>
          </Text>
          <Text style={styles.modalSub}>
            {t.name}{tower.ultimate ? ' · all abilities' : ' · ' + g.ability}
          </Text>
        </View>
      </View>
      <View style={styles.modalRow}>
        <ModalStat label="Damage" value={stats.damage.toFixed(1)} />
        <ModalStat label="Range" value={stats.range.toFixed(1)} />
        <ModalStat label="CD" value={`${stats.cooldown.toFixed(2)}s`} />
        <ModalStat label="Sell" value={`${sellValue(tower.tier)}g`} />
      </View>
      <Text style={styles.combineHint}>
        {tower.ultimate
          ? 'Ultimate — maxed.'
          : tower.tier === 5
            ? canUltimate
              ? `Can fuse with 4 different Perfect gems → Ultimate.`
              : `Perfect. Combine with 4 OTHER Perfect types for Ultimate (have ${perfectsDifferent}/4).`
            : canCombine
              ? `Can combine — you have ${matches + 1} of these.`
              : `Need 4 more ${g.name} ${t.short} on the board (you have ${matches}).`}
      </Text>
      <View style={styles.modalBtnRow}>
        {canUltimate ? (
          <TouchableOpacity
            style={[styles.modalBtn, { backgroundColor: '#ffd166' }]}
            onPress={onUltimate}
          >
            <Text style={[styles.modalBtnText, { color: '#0b1020' }]}>ULTIMATE</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            style={[styles.modalBtn, { backgroundColor: canCombine ? '#5cf28a' : '#2a335f' }, !canCombine && { opacity: 0.6 }]}
            onPress={canCombine ? onCombine : undefined}
          >
            <Text style={[styles.modalBtnText, canCombine && { color: '#0b1020' }]}>COMBINE</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity style={[styles.modalBtn, { backgroundColor: '#ff4d6d' }]} onPress={onSell}>
          <Text style={styles.modalBtnText}>SELL</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.modalBtn, { backgroundColor: '#2a335f' }]} onPress={onClose}>
          <Text style={styles.modalBtnText}>CLOSE</Text>
        </TouchableOpacity>
      </View>
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
    if (t.kind !== 'gem') continue;
    t.cooldown = Math.max(0, t.cooldown - dt);
    if (t.cooldown > 0) continue;
    const stats = gemStats(t.gemType, t.tier, t.ultimate);
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

  const alive = [];
  for (const e of s.enemies) {
    if (e.hp <= 0) {
      if (e.subPath && e.pathIdx < e.subPath.length) {
        const def = ENEMIES[e.type];
        s.gold += def.gold;
        s.score += def.gold * 2;
      }
    } else {
      alive.push(e);
    }
  }
  s.enemies = alive;

  if (s.waveActive && s.spawnQueue.length === 0 && s.enemies.length === 0) {
    s.waveActive = false;
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
    s.gold += 20 + s.wave * 6;
    s.score += 100 + s.wave * 20;
    if (rolled > 0) {
      s.flash = { text: `Rolled ${rolled} gem${rolled > 1 ? 's' : ''}!`, until: s.time + 1.8 };
    }
    if (s.wave >= WAVES.length) {
      onEnd(true, s.score);
    }
  }

  if (s.lives <= 0) onEnd(false, s.score);
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
  enemy.hp -= stats.damage;
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
  menuRoot: { flex: 1, backgroundColor: '#0b1020', alignItems: 'center', justifyContent: 'space-between', paddingTop: 24 },
  menuTop: { alignItems: 'center', marginTop: 60 },
  menuCrystalRow: { flexDirection: 'row', marginBottom: 8 },
  menuCrystal: { fontSize: 72, marginHorizontal: 4 },
  menuTitle: { color: '#fff', fontSize: 38, fontWeight: '800', letterSpacing: 1 },
  menuSubtitle: { color: '#9aa3c7', fontSize: 16, letterSpacing: 6, marginTop: 4 },
  menuMid: { alignItems: 'center', paddingHorizontal: 32 },
  menuRule: { color: '#9aa3c7', fontSize: 13, marginVertical: 3, textAlign: 'center' },
  bigButton: { backgroundColor: '#4cc9ff', paddingHorizontal: 64, paddingVertical: 16, borderRadius: 999, marginBottom: 32 },
  bigButtonText: { color: '#0b1020', fontWeight: '800', fontSize: 18, letterSpacing: 4 },

  gameRoot: { flex: 1, backgroundColor: '#0b1020' },
  hud: { flexDirection: 'row', justifyContent: 'space-around', paddingVertical: 8, paddingHorizontal: 8 },
  hudStat: { alignItems: 'center', minWidth: 60 },
  hudLabel: { color: '#7c84a8', fontSize: 10, letterSpacing: 1.5 },
  hudValue: { fontSize: 18, fontWeight: '700' },

  marker: { position: 'absolute', width: TILE, height: TILE, alignItems: 'center', justifyContent: 'center' },
  markerText: { color: '#fff', fontSize: TILE * 0.5, opacity: 0.5 },

  recenterBtn: {
    position: 'absolute',
    right: 10,
    bottom: 10,
    width: 40, height: 40,
    backgroundColor: '#161c33d0',
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#2a335f',
  },
  recenterText: { color: '#fff', fontSize: 20, fontWeight: '800' },

  bottomBar: { paddingHorizontal: 12, paddingTop: 8, paddingBottom: 8 },
  stoneInfo: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#161c33', paddingHorizontal: 10, paddingVertical: 8, borderRadius: 10, marginRight: 8 },
  stoneIcon: { width: 22, height: 22, backgroundColor: '#5a627f', borderRadius: 3, borderWidth: 1, borderColor: '#7c84a8', marginRight: 8 },
  stoneLabel: { color: '#fff', fontWeight: '700', fontSize: 12, letterSpacing: 1 },
  stoneCost: { color: '#9aa3c7', fontSize: 10 },

  actionRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginVertical: 6 },
  actionBtn: { flex: 1, backgroundColor: '#4cc9ff', paddingVertical: 12, borderRadius: 999, alignItems: 'center', marginRight: 8 },
  actionBtnText: { color: '#0b1020', fontWeight: '800', fontSize: 13, letterSpacing: 1.5 },
  speedBtn: { backgroundColor: '#2a335f', paddingHorizontal: 16, paddingVertical: 12, borderRadius: 999, alignItems: 'center', justifyContent: 'center' },
  speedBtnText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  tipText: { color: '#7c84a8', fontSize: 11, textAlign: 'center', marginTop: 4 },

  flashWrap: { position: 'absolute', top: 16, left: 0, right: 0, alignItems: 'center' },
  flashText: { color: '#fff', backgroundColor: '#000b', paddingHorizontal: 14, paddingVertical: 6, borderRadius: 6, fontSize: 14, fontWeight: '700' },

  modalBackdrop: { flex: 1, backgroundColor: '#000a', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 20 },
  modalCard: { backgroundColor: '#161c33', borderRadius: 16, padding: 20, width: '100%', maxWidth: 420, borderWidth: 1, borderColor: '#2a335f' },
  modalHeaderRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  modalTitle: { color: '#fff', fontSize: 22, fontWeight: '800' },
  modalSub: { color: '#9aa3c7', fontSize: 12, marginTop: 2 },
  modalRow: { flexDirection: 'row', justifyContent: 'space-around', marginVertical: 12, backgroundColor: '#0f1530', borderRadius: 10, paddingVertical: 10 },
  modalStat: { alignItems: 'center' },
  modalStatLabel: { color: '#7c84a8', fontSize: 10, letterSpacing: 1 },
  modalStatValue: { color: '#fff', fontSize: 16, fontWeight: '700' },
  combineHint: { color: '#9aa3c7', fontSize: 12, textAlign: 'center', marginBottom: 12 },
  modalBtnRow: { flexDirection: 'row', justifyContent: 'space-between' },
  modalBtn: { flex: 1, paddingVertical: 12, borderRadius: 999, alignItems: 'center', marginHorizontal: 4 },
  modalBtnText: { color: '#fff', fontWeight: '800', fontSize: 12, letterSpacing: 1 },
});
