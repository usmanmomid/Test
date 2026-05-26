// spatial_sim.js — REAL spatial tower-defence sim  (PLAN P39, plain Node)
//
//   node spatial_sim.js            → W1-500 summary (sampled) + endless verdict
//   node spatial_sim.js full       → every wave printed
//   node spatial_sim.js Nightmare  → one difficulty
//
// Unlike sim.js (aggregate, single exposureFactor guess) this builds the
// player's actual strategy — a SPIRAL around Checkpoint 5 (board centre) with
// towers in concentric rings, bigger tier inward — generates the enemy path
// through it, and runs a tick-based combat sim. Multi-pass exposure (a centre
// tower hitting an enemy on every loop of the spiral) falls out of the geometry
// instead of being assumed. Used to derive an endless-mode HP curve to W500.

'use strict';

// ───────────────────────── CONFIG / ASSUMPTIONS ─────────────────────────────
const GRID = 41;
const CENTER = { x: 20, y: 20 };          // Checkpoint 5, board centre (doc §5)
const GOAL = { x: 40, y: 20 };
const DT = 0.15;                          // sim tick seconds
const A = {
  spiralLoops: 6,                         // how many times the path winds in
  spiralR: 18,                            // outer radius (tiles)
  towerRingStep: 2,                       // rings at r = 2,4,...,18
  towersPerRingPer: 3,                    // 1 tower per 3 tiles of ring perimeter
  towersPerWave: 0.85,                    // net firing towers gained per wave
  effectiveDpsMult: 1.45,                 // splash/multi/poison/aura uplift
  livesAllowedLeakPct: 0.0,               // (info) leaks counted, lives separate
};

// Avg raw single-target DPS per purity P1..P6 (from GEM_STATS damage/cooldown).
const GEM_DPS = [3.4, 6.8, 12, 27, 54, 400];
// Tower attack range in TILES per purity (studs/4; ~30-60 studs). Inner high-tier
// towers also have the longest reach, which compounds the spiral's multi-pass.
const GEM_RANGE = [7.5, 8, 8.5, 9, 10, 13];

const DIFFICULTY = {
  Easy:      { hp: 0.30, count: 0.50, speed: 0.90 },
  Normal:    { hp: 0.90, count: 0.95, speed: 1.00 },
  Hard:      { hp: 1.03, count: 1.00, speed: 1.05 },
  Nightmare: { hp: 1.05, count: 1.00, speed: 1.10 },
};

// ───────────────────────── ENEMY HP CURVE (candidate, extended endless) ─────
// Decelerating growth from the DPS-derivation, extended past W50 for endless.
// BaseHP 3 per regular enemy.
function growth(i) {
  if (i <= 10) return 1.28;
  if (i <= 25) return 1.16;
  if (i <= 40) return 1.07;
  if (i <= 50) return 1.045;
  if (i <= 100) return 1.035;   // endless: still rising, player board saturating
  if (i <= 200) return 1.025;
  return 1.018;                 // deep endless: slow climb so run eventually ends
}
const _hpCache = [0, 3];
function regularHP(w) {
  for (let i = _hpCache.length; i <= w; i++) _hpCache[i] = _hpCache[i - 1] * growth(i);
  return _hpCache[w];
}
function waveCount(w) {
  if (w <= 9)  return 15;
  if (w <= 19) return 20 + Math.floor((w - 10) * 0.5);
  if (w <= 29) return 22 + Math.floor((w - 20) * 0.6);
  if (w <= 39) return 25 + Math.floor((w - 30) * 0.5);
  return 30;                                   // cap (perf lock)
}
const isBoss = (w) => w % 10 === 0;
function milestoneMult(w) {                    // endless milestones every W25 from W100
  if (w < 100) return { speed: 1, armor: 1 };
  const idx = Math.floor((w - 100) / 25) + 1;
  return { speed: 1 + idx * 0.03, armor: 1 + idx * 0.05 };
}

// ───────────────────────── SPIRAL PATH ──────────────────────────────────────
function buildPath() {
  const pts = [];
  const steps = 3000;
  for (let s = 0; s <= steps; s++) {
    const f = s / steps;
    const theta = f * A.spiralLoops * 2 * Math.PI;
    const r = A.spiralR * (1 - f);                 // wind inward to centre
    pts.push({ x: CENTER.x + r * Math.cos(theta), y: CENTER.y + r * Math.sin(theta) });
  }
  for (let s = 1; s <= 300; s++) {                 // centre → goal
    const f = s / 300;
    pts.push({ x: CENTER.x + (GOAL.x - CENTER.x) * f, y: CENTER.y + (GOAL.y - CENTER.y) * f });
  }
  // cumulative arc length
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i].x - pts[i - 1].x, dy = pts[i].y - pts[i - 1].y;
    cum[i] = cum[i - 1] + Math.hypot(dx, dy);
  }
  return { pts, cum, length: cum[cum.length - 1] };
}
function posAtDistance(path, d) {                  // interpolate {x,y} at arc length d
  const { pts, cum } = path;
  if (d <= 0) return pts[0];
  if (d >= path.length) return pts[pts.length - 1];
  // binary search
  let lo = 0, hi = cum.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] < d) lo = m + 1; else hi = m; }
  const i = Math.max(1, lo);
  const seg = cum[i] - cum[i - 1] || 1;
  const t = (d - cum[i - 1]) / seg;
  return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t };
}

// ───────────────────────── TOWER FIELD (concentric rings) ───────────────────
// Candidate tower slots on rings r=2..18. Inner rings host higher tier (player
// merges centre towers up over time). Returns slots sorted inner-first.
function buildTowerSlots() {
  const slots = [];
  for (let r = A.towerRingStep; r <= A.spiralR; r += A.towerRingStep) {
    const perim = 2 * Math.PI * r;
    const n = Math.max(4, Math.floor(perim / A.towersPerRingPer));
    for (let k = 0; k < n; k++) {
      const th = (k / n) * 2 * Math.PI;
      slots.push({ x: CENTER.x + r * Math.cos(th), y: CENTER.y + r * Math.sin(th), ring: r });
    }
  }
  slots.sort((a, b) => a.ring - b.ring);          // inner first
  return slots;
}
const SLOTS = buildTowerSlots();

// Active towers at wave W: count grows with wave (capped by slots). Tier rises
// with wave and with how central the slot is (inner = higher).
function activeTowers(w) {
  const count = Math.min(SLOTS.length, Math.max(1, Math.round(w * A.towersPerWave)));
  const maxTier = Math.min(6, 1 + Math.floor(w / 8));     // P6 reachable ~W40+
  const towers = [];
  for (let i = 0; i < count; i++) {
    const s = SLOTS[i];
    // inner slots (low index) get up to maxTier; outer drop a few tiers
    const drop = Math.floor((i / count) * 3);             // 0..3 lower toward outer
    const tier = Math.max(1, maxTier - drop);
    towers.push({
      x: s.x, y: s.y, range: GEM_RANGE[tier - 1],
      dps: GEM_DPS[tier - 1] * A.effectiveDpsMult,
    });
  }
  return towers;
}

// ───────────────────────── COMBAT TICK SIM ──────────────────────────────────
const PATH = buildPath();
function simulateWave(w, diff) {
  const d = DIFFICULTY[diff];
  const towers = activeTowers(w);
  const ms = milestoneMult(w);
  const count = Math.max(1, Math.round(waveCount(w) * d.count));
  const baseHP = regularHP(w) * d.hp;
  const boss = isBoss(w);
  const enemyHP = boss ? baseHP * 5 : baseHP;            // boss-only-ish chunk
  const nEnemies = boss ? (w >= 50 ? 6 : w >= 30 ? 3 : w >= 20 ? 2 : 1) : count;
  const baseSpeed = (boss ? 3.5 : 4.5) * d.speed * ms.speed;  // tiles/sec
  const spawnGap = boss ? 1.2 : 0.5;                    // seconds between spawns

  // enemies: {d: distance along path, hp, alive, leaked, spawnT}
  const enemies = [];
  for (let i = 0; i < nEnemies; i++) enemies.push({ dist: -1, hp: enemyHP, spawnT: i * spawnGap, alive: true, leaked: false });

  let t = 0, leaks = 0, lastSpawn = enemies[enemies.length - 1].spawnT;
  const maxT = lastSpawn + PATH.length / baseSpeed + 5;
  while (t < maxT) {
    // spawn + move
    for (const e of enemies) {
      if (!e.alive) continue;
      if (t < e.spawnT) continue;
      if (e.dist < 0) e.dist = 0;
      e.dist += baseSpeed * DT;
      e.pos = posAtDistance(PATH, e.dist);
      if (e.dist >= PATH.length) { e.alive = false; e.leaked = true; leaks++; }
    }
    // towers fire — each hits furthest-progressed enemy in range
    for (const tw of towers) {
      let target = null, best = -1;
      for (const e of enemies) {
        if (!e.alive || e.dist < 0 || t < e.spawnT) continue;
        const dx = e.pos.x - tw.x, dy = e.pos.y - tw.y;
        if (dx * dx + dy * dy <= tw.range * tw.range && e.dist > best) { best = e.dist; target = e; }
      }
      if (target) {
        target.hp -= tw.dps * DT;
        if (target.hp <= 0) { target.alive = false; }
      }
    }
    if (enemies.every((e) => !e.alive)) break;
    t += DT;
  }
  return { leaks, nEnemies, totalHP: enemyHP * nEnemies, boardDPS: towers.reduce((s, x) => s + x.dps, 0), towers: towers.length };
}

// ───────────────────────── RUN ──────────────────────────────────────────────
function run(diff, full) {
  console.log(`\n=== ${diff} ===  spiral@CP5 · ${SLOTS.length} slots · path ${PATH.length.toFixed(0)} tiles`);
  console.log('   W  towers  boardDPS   totalHP  leaks  verdict');
  let firstWall = null, cumLeaks = 0;
  const sample = (w) => full || w <= 12 || w % 10 === 0 || w % 25 === 0 || w >= 490;
  for (let w = 1; w <= 500; w++) {
    const r = simulateWave(w, diff);
    cumLeaks += r.leaks;
    const leakPct = r.leaks / r.nEnemies;
    const verdict = leakPct === 0 ? 'clear' : leakPct < 0.34 ? 'rough' : 'WALL';
    if (verdict === 'WALL' && firstWall === null) firstWall = w;
    if (sample(w)) {
      console.log(
        `${isBoss(w) ? 'B' : ' '}${String(w).padStart(4)}  ` +
        `${String(r.towers).padStart(5)}  ${r.boardDPS.toFixed(0).padStart(8)}  ` +
        `${r.totalHP.toFixed(0).padStart(8)}  ${String(r.leaks).padStart(4)}  ${verdict}`
      );
    }
  }
  console.log(`  → first WALL wave: ${firstWall ?? 'none in 500'} · total leaks W1-500: ${cumLeaks}`);
  return firstWall;
}

const arg = process.argv[2];
const full = process.argv.includes('full');
if (arg && DIFFICULTY[arg]) run(arg, full);
else for (const dd of Object.keys(DIFFICULTY)) run(dd, full);
