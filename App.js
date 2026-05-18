import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  Dimensions,
  SafeAreaView,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';

// ─────────────────────────────────────────────────────────────────────────────
// Crystal Maze Defence
//
// Open-grid tower defense. Enemies spawn at the top, must reach the bottom.
// You place crystal towers on empty cells — they block movement, so your
// placements *form the maze*. Enemies always take the shortest path; if your
// placement would fully wall them off, the placement is rejected.
// ─────────────────────────────────────────────────────────────────────────────

const COLS = 9;
const ROWS = 13;
const SCREEN = Dimensions.get('window');
const BOARD_MARGIN = 8;
const TILE = Math.floor((SCREEN.width - BOARD_MARGIN * 2) / COLS);
const BOARD_W = TILE * COLS;
const BOARD_H = TILE * ROWS;

const SPAWN = { r: 0, c: Math.floor(COLS / 2) };
const GOAL = { r: ROWS - 1, c: Math.floor(COLS / 2) };

const STARTING_GOLD = 80;
const STARTING_LIVES = 15;

// ─── Tower types ─────────────────────────────────────────────────────────────
const TOWERS = {
  ruby: {
    id: 'ruby',
    name: 'Ruby',
    glyph: '◆',
    color: '#ff4d6d',
    cost: 25,
    damage: 4,
    range: 2.6,
    cooldown: 0.7, // seconds between shots
    effect: null,
    description: 'Solid damage. Reliable.',
  },
  sapphire: {
    id: 'sapphire',
    name: 'Sapphire',
    glyph: '◆',
    color: '#4cc9ff',
    cost: 40,
    damage: 2,
    range: 3.2,
    cooldown: 0.9,
    effect: { type: 'slow', factor: 0.5, duration: 1.4 },
    description: 'Slows enemies for 1.4s.',
  },
  emerald: {
    id: 'emerald',
    name: 'Emerald',
    glyph: '◆',
    color: '#5cf28a',
    cost: 50,
    damage: 1,
    range: 2.4,
    cooldown: 0.4,
    effect: { type: 'poison', dps: 3, duration: 2.5 },
    description: 'Fast. Poisons over time.',
  },
  topaz: {
    id: 'topaz',
    name: 'Topaz',
    glyph: '◆',
    color: '#ffd166',
    cost: 75,
    damage: 6,
    range: 2.2,
    cooldown: 1.1,
    splash: 1.0, // splash radius in tiles
    effect: null,
    description: 'Splash damage. Expensive.',
  },
};

// ─── Enemy types ─────────────────────────────────────────────────────────────
const ENEMIES = {
  grunt:  { hp: 14, speed: 1.6, gold: 4,  color: '#c4b9ff', size: 0.55 },
  runner: { hp: 8,  speed: 3.2, gold: 5,  color: '#ffd166', size: 0.45 },
  tank:   { hp: 60, speed: 0.9, gold: 14, color: '#7d8aa8', size: 0.7  },
  swarm:  { hp: 4,  speed: 2.4, gold: 2,  color: '#ff8fab', size: 0.35 },
};

// ─── Wave plan ───────────────────────────────────────────────────────────────
const WAVES = [
  { spawns: [['grunt', 8, 0.6]] },
  { spawns: [['grunt', 12, 0.5]] },
  { spawns: [['grunt', 8, 0.5], ['runner', 5, 0.4]] },
  { spawns: [['grunt', 14, 0.45], ['runner', 6, 0.4]] },
  { spawns: [['runner', 14, 0.3]] },
  { spawns: [['grunt', 10, 0.4], ['tank', 2, 1.5]] },
  { spawns: [['swarm', 24, 0.18]] },
  { spawns: [['grunt', 10, 0.35], ['runner', 8, 0.3], ['tank', 3, 1.2]] },
  { spawns: [['tank', 6, 1.0], ['runner', 12, 0.3]] },
  { spawns: [['grunt', 18, 0.3], ['tank', 4, 1.0], ['swarm', 30, 0.15]] },
];

// ─── BFS pathfinder ──────────────────────────────────────────────────────────
// grid[r][c] === true means blocked (tower present).
// Returns array of {r,c} from start to goal inclusive, or null if no path.
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
        const prev = visited[p.r][p.c];
        p = prev;
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

// ─── Main App ────────────────────────────────────────────────────────────────
export default function App() {
  const [screen, setScreen] = useState('menu'); // menu | game | win | lose
  const [finalScore, setFinalScore] = useState(0);

  if (screen === 'menu') {
    return (
      <MenuScreen
        onStart={() => setScreen('game')}
      />
    );
  }
  if (screen === 'win' || screen === 'lose') {
    return (
      <EndScreen
        won={screen === 'win'}
        score={finalScore}
        onBack={() => setScreen('menu')}
      />
    );
  }
  return (
    <Game
      onEnd={(won, score) => {
        setFinalScore(score);
        setScreen(won ? 'win' : 'lose');
      }}
    />
  );
}

// ─── Menu ────────────────────────────────────────────────────────────────────
function MenuScreen({ onStart }) {
  return (
    <SafeAreaView style={styles.menuRoot}>
      <StatusBar style="light" />
      <View style={styles.menuTop}>
        <Text style={styles.menuCrystal}>◆</Text>
        <Text style={styles.menuTitle}>Crystal Maze</Text>
        <Text style={styles.menuSubtitle}>D E F E N C E</Text>
      </View>
      <View style={styles.menuMid}>
        <Text style={styles.menuRule}>Place crystal towers to shape the maze.</Text>
        <Text style={styles.menuRule}>Enemies always take the shortest path.</Text>
        <Text style={styles.menuRule}>Survive 10 waves.</Text>
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
          {won ? '◆' : '✦'}
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
  // Persistent (across renders) game state lives in a ref so the loop reads
  // fresh values without re-binding the interval.
  const stateRef = useRef(null);
  if (!stateRef.current) {
    stateRef.current = {
      grid: emptyGrid(),
      towers: [], // {id,r,c,type, cooldown}
      enemies: [], // {id,r,c (float), hp, maxHp, type, pathIdx, effects:[{type,factor?,dps?,until}]}
      projectiles: [], // {id, fromX, fromY, toX, toY, color, until}
      path: bfs(emptyGrid(), SPAWN, GOAL),
      wave: 0,
      waveActive: false,
      spawnQueue: [], // {type, atTime}
      time: 0,
      nextEnemyId: 1,
      nextProjectileId: 1,
      nextTowerId: 1,
      gold: STARTING_GOLD,
      lives: STARTING_LIVES,
      score: 0,
      speed: 1,
      selectedTower: 'ruby',
      pendingPlacement: null, // {r,c} preview
    };
  }
  const [tick, setTick] = useState(0);
  const force = useCallback(() => setTick((t) => (t + 1) % 1e9), []);

  // Game loop
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

  const tryPlaceTower = (r, c) => {
    if (s.grid[r][c]) return; // already a tower
    if ((r === SPAWN.r && c === SPAWN.c) || (r === GOAL.r && c === GOAL.c)) return;
    // can't place under a live enemy
    for (const e of s.enemies) {
      if (Math.round(e.r) === r && Math.round(e.c) === c) return;
    }
    const def = TOWERS[s.selectedTower];
    if (s.gold < def.cost) return;
    // tentatively place
    s.grid[r][c] = true;
    const newPath = bfs(s.grid, SPAWN, GOAL);
    if (!newPath) {
      s.grid[r][c] = false;
      return; // would fully block
    }
    // check each enemy can still reach goal from its current cell
    for (const e of s.enemies) {
      const ep = bfs(s.grid, { r: Math.floor(e.r), c: Math.floor(e.c) }, GOAL);
      if (!ep) {
        s.grid[r][c] = false;
        return;
      }
    }
    s.gold -= def.cost;
    s.towers.push({
      id: s.nextTowerId++,
      r,
      c,
      type: s.selectedTower,
      cooldown: 0,
    });
    s.path = newPath;
    // reassign enemy paths
    for (const e of s.enemies) {
      const ep = bfs(s.grid, { r: Math.floor(e.r), c: Math.floor(e.c) }, GOAL);
      e.subPath = ep;
      e.pathIdx = 0;
    }
    force();
  };

  const startWave = () => {
    if (s.waveActive) return;
    if (s.wave >= WAVES.length) return;
    const w = WAVES[s.wave];
    const queue = [];
    let t = s.time;
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

  const sellTower = (towerId) => {
    const idx = s.towers.findIndex((t) => t.id === towerId);
    if (idx < 0) return;
    const t = s.towers[idx];
    const def = TOWERS[t.type];
    s.gold += Math.floor(def.cost * 0.6);
    s.towers.splice(idx, 1);
    s.grid[t.r][t.c] = false;
    s.path = bfs(s.grid, SPAWN, GOAL);
    for (const e of s.enemies) {
      e.subPath = bfs(s.grid, { r: Math.floor(e.r), c: Math.floor(e.c) }, GOAL);
      e.pathIdx = 0;
    }
    force();
  };

  const toggleSpeed = () => {
    s.speed = s.speed === 1 ? 2 : s.speed === 2 ? 3 : 1;
    force();
  };

  const onCellPress = (r, c) => {
    const existing = s.towers.find((t) => t.r === r && t.c === c);
    if (existing) {
      sellTower(existing.id);
    } else {
      tryPlaceTower(r, c);
    }
  };

  const canStart = !s.waveActive && s.wave < WAVES.length;

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
          width: BOARD_W,
          height: BOARD_H,
          marginHorizontal: BOARD_MARGIN,
          backgroundColor: '#0f1530',
          borderRadius: 8,
          overflow: 'hidden',
          alignSelf: 'center',
        }}
      >
        {/* path tint */}
        {s.path && s.path.map((p, i) => (
          <View
            key={`p${i}`}
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

        {/* spawn & goal markers */}
        <View
          style={[
            styles.marker,
            { left: SPAWN.c * TILE, top: SPAWN.r * TILE, backgroundColor: '#3a1f4a' },
          ]}
        >
          <Text style={styles.markerText}>↓</Text>
        </View>
        <View
          style={[
            styles.marker,
            { left: GOAL.c * TILE, top: GOAL.r * TILE, backgroundColor: '#1f4a3a' },
          ]}
        >
          <Text style={styles.markerText}>◇</Text>
        </View>

        {/* tap layer: invisible touchables per cell (flattened) */}
        {Array.from({ length: ROWS * COLS }).map((_, i) => {
          const r = Math.floor(i / COLS);
          const c = i % COLS;
          return (
            <TouchableOpacity
              key={`t${i}`}
              activeOpacity={0.6}
              onPress={() => onCellPress(r, c)}
              style={{
                position: 'absolute',
                left: c * TILE,
                top: r * TILE,
                width: TILE,
                height: TILE,
              }}
            />
          );
        })}

        {/* towers */}
        {s.towers.map((t) => {
          const def = TOWERS[t.type];
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
                backgroundColor: def.color,
                borderRadius: 6,
                transform: [{ rotate: '45deg' }],
                shadowColor: def.color,
                shadowOpacity: 0.6,
                shadowRadius: 6,
                elevation: 4,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            />
          );
        })}

        {/* enemies */}
        {s.enemies.map((e) => {
          const def = ENEMIES[e.type];
          const size = TILE * def.size;
          const slowed = e.effects.some((ef) => ef.type === 'slow');
          const poisoned = e.effects.some((ef) => ef.type === 'poison');
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
                  backgroundColor: poisoned ? '#5cf28a' : def.color,
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

        {/* projectiles — center-pivoted beams (RN <0.75 has no transformOrigin) */}
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

      <View style={styles.bottomBar}>
        <View style={styles.towerRow}>
          {Object.values(TOWERS).map((t) => {
            const sel = s.selectedTower === t.id;
            const afford = s.gold >= t.cost;
            return (
              <TouchableOpacity
                key={t.id}
                onPress={() => {
                  s.selectedTower = t.id;
                  force();
                }}
                style={[
                  styles.towerBtn,
                  sel && styles.towerBtnSel,
                  !afford && { opacity: 0.4 },
                ]}
              >
                <Text style={[styles.towerGlyph, { color: t.color }]}>◆</Text>
                <Text style={styles.towerCost}>{t.cost}g</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        <View style={styles.actionRow}>
          <TouchableOpacity
            style={[styles.actionBtn, !canStart && { opacity: 0.35 }]}
            onPress={canStart ? startWave : undefined}
          >
            <Text style={styles.actionBtnText}>
              {s.wave >= WAVES.length ? 'DONE' : s.waveActive ? 'IN PROGRESS' : 'NEXT WAVE'}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.speedBtn} onPress={toggleSpeed}>
            <Text style={styles.speedBtnText}>{s.speed}x</Text>
          </TouchableOpacity>
        </View>

        <Text style={styles.tipText}>
          Tap a cell to place {TOWERS[s.selectedTower].name}. Tap a tower to sell.
        </Text>
      </View>
    </SafeAreaView>
  );
}

// ─── Game step ───────────────────────────────────────────────────────────────
function step(dt, s, onEnd) {
  s.time += dt;

  // Spawn from queue
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

  // Move enemies
  for (const e of s.enemies) {
    if (e.hp <= 0) continue;
    const def = ENEMIES[e.type];
    // expire effects
    e.effects = e.effects.filter((ef) => ef.until > s.time);
    let speedMul = 1;
    for (const ef of e.effects) {
      if (ef.type === 'slow') speedMul = Math.min(speedMul, ef.factor);
      if (ef.type === 'poison') e.hp -= ef.dps * dt;
    }
    if (e.hp <= 0) continue;

    // Ensure subPath valid & current
    if (!e.subPath || e.pathIdx >= e.subPath.length) {
      const fresh = bfs(s.grid, { r: Math.floor(e.r), c: Math.floor(e.c) }, GOAL);
      if (fresh) {
        e.subPath = fresh;
        e.pathIdx = 0;
      } else {
        continue;
      }
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
        // reached goal
        e.hp = -1;
        s.lives -= 1;
      }
    } else {
      e.r += (dr / dist) * move;
      e.c += (dc / dist) * move;
    }
  }

  // Towers fire
  // Tower center → enemy center, in tile coords; convert to px for projectile.
  for (const t of s.towers) {
    t.cooldown = Math.max(0, t.cooldown - dt);
    if (t.cooldown > 0) continue;
    const def = TOWERS[t.type];
    // Find nearest enemy in range
    let best = null;
    let bestDist = Infinity;
    for (const e of s.enemies) {
      if (e.hp <= 0) continue;
      const d = Math.hypot(e.r - t.r, e.c - t.c);
      if (d <= def.range && d < bestDist) {
        bestDist = d;
        best = e;
      }
    }
    if (!best) continue;
    // fire
    t.cooldown = def.cooldown;
    applyDamage(best, def, s);
    if (def.splash) {
      for (const e of s.enemies) {
        if (e === best || e.hp <= 0) continue;
        const d = Math.hypot(e.r - best.r, e.c - best.c);
        if (d <= def.splash) applyDamage(e, { ...def, splash: 0, damage: def.damage * 0.6 }, s);
      }
    }
    s.projectiles.push({
      id: s.nextProjectileId++,
      fromX: t.c * TILE + TILE / 2,
      fromY: t.r * TILE + TILE / 2,
      toX: best.c * TILE + TILE / 2,
      toY: best.r * TILE + TILE / 2,
      color: def.color,
      until: s.time + 0.08,
    });
  }

  // Cull projectiles
  s.projectiles = s.projectiles.filter((p) => p.until > s.time);

  // Resolve deaths & rewards
  const alive = [];
  for (const e of s.enemies) {
    if (e.hp <= 0) {
      // if reached goal, we already decremented lives and didn't pay gold
      // distinguish by checking pathIdx
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

  // Wave end?
  if (s.waveActive && s.spawnQueue.length === 0 && s.enemies.length === 0) {
    s.waveActive = false;
    s.gold += 20 + s.wave * 5; // wave bonus
    s.score += 100 + s.wave * 20;
    if (s.wave >= WAVES.length) {
      onEnd(true, s.score);
    }
  }

  // Lose?
  if (s.lives <= 0) {
    onEnd(false, s.score);
  }
}

function applyDamage(enemy, towerDef, s) {
  enemy.hp -= towerDef.damage;
  if (towerDef.effect) {
    // refresh effect of same type
    enemy.effects = enemy.effects.filter((ef) => ef.type !== towerDef.effect.type);
    enemy.effects.push({
      ...towerDef.effect,
      until: s.time + towerDef.effect.duration,
    });
  }
}

// ─── HUD bits ────────────────────────────────────────────────────────────────
function HudStat({ label, value, color }) {
  return (
    <View style={styles.hudStat}>
      <Text style={styles.hudLabel}>{label}</Text>
      <Text style={[styles.hudValue, { color }]}>{value}</Text>
    </View>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  menuRoot: {
    flex: 1,
    backgroundColor: '#0b1020',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 24,
  },
  menuTop: { alignItems: 'center', marginTop: 60 },
  menuCrystal: { color: '#4cc9ff', fontSize: 96, marginBottom: 8 },
  menuTitle: { color: '#fff', fontSize: 38, fontWeight: '800', letterSpacing: 1 },
  menuSubtitle: { color: '#9aa3c7', fontSize: 16, letterSpacing: 6, marginTop: 4 },
  menuMid: { alignItems: 'center', paddingHorizontal: 32 },
  menuRule: { color: '#9aa3c7', fontSize: 14, marginVertical: 4, textAlign: 'center' },
  bigButton: {
    backgroundColor: '#4cc9ff',
    paddingHorizontal: 64,
    paddingVertical: 16,
    borderRadius: 999,
    marginBottom: 32,
  },
  bigButtonText: {
    color: '#0b1020',
    fontWeight: '800',
    fontSize: 18,
    letterSpacing: 4,
  },

  gameRoot: { flex: 1, backgroundColor: '#0b1020' },
  hud: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    paddingVertical: 8,
    paddingHorizontal: 8,
    backgroundColor: '#0b1020',
  },
  hudStat: { alignItems: 'center', minWidth: 60 },
  hudLabel: { color: '#7c84a8', fontSize: 10, letterSpacing: 1.5 },
  hudValue: { fontSize: 18, fontWeight: '700' },
  marker: {
    position: 'absolute',
    width: TILE,
    height: TILE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  markerText: { color: '#fff', fontSize: TILE * 0.5, opacity: 0.5 },

  bottomBar: {
    flex: 1,
    paddingHorizontal: 12,
    paddingTop: 8,
  },
  towerRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    marginBottom: 8,
  },
  towerBtn: {
    backgroundColor: '#161c33',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    alignItems: 'center',
    minWidth: 60,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  towerBtnSel: {
    borderColor: '#ffd166',
    backgroundColor: '#1f2750',
  },
  towerGlyph: { fontSize: 22 },
  towerCost: { color: '#fff', fontSize: 12, marginTop: 2 },

  actionRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 8,
    marginVertical: 6,
  },
  actionBtn: {
    flex: 1,
    backgroundColor: '#4cc9ff',
    paddingVertical: 12,
    borderRadius: 999,
    alignItems: 'center',
    marginRight: 8,
  },
  actionBtnText: {
    color: '#0b1020',
    fontWeight: '800',
    fontSize: 14,
    letterSpacing: 2,
  },
  speedBtn: {
    backgroundColor: '#2a335f',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  speedBtnText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  tipText: {
    color: '#7c84a8',
    fontSize: 11,
    textAlign: 'center',
    marginTop: 4,
  },
});
