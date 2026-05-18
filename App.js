import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  Dimensions,
  SafeAreaView,
  Animated,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';

const ROWS = 8;
const COLS = 7;
const GEMS = ['🔴', '🟢', '🔵', '🟡', '🟣', '🟠'];

const { width: SCREEN_W } = Dimensions.get('window');
const BOARD_PADDING = 12;
const TILE_SIZE = Math.floor((SCREEN_W - BOARD_PADDING * 2 - (COLS + 1) * 4) / COLS);

const randomGem = () => GEMS[Math.floor(Math.random() * GEMS.length)];

const makeBoard = () => {
  // Generate a board with no initial 3-in-a-row.
  const board = Array.from({ length: ROWS }, () => Array(COLS).fill(null));
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      let g;
      do {
        g = randomGem();
      } while (
        (c >= 2 && board[r][c - 1] === g && board[r][c - 2] === g) ||
        (r >= 2 && board[r - 1][c] === g && board[r - 2][c] === g)
      );
      board[r][c] = g;
    }
  }
  return board;
};

const findMatches = (board) => {
  const matched = Array.from({ length: ROWS }, () => Array(COLS).fill(false));
  // Horizontal
  for (let r = 0; r < ROWS; r++) {
    let runStart = 0;
    for (let c = 1; c <= COLS; c++) {
      if (c === COLS || board[r][c] !== board[r][runStart]) {
        if (board[r][runStart] && c - runStart >= 3) {
          for (let k = runStart; k < c; k++) matched[r][k] = true;
        }
        runStart = c;
      }
    }
  }
  // Vertical
  for (let c = 0; c < COLS; c++) {
    let runStart = 0;
    for (let r = 1; r <= ROWS; r++) {
      if (r === ROWS || board[r][c] !== board[runStart][c]) {
        if (board[runStart][c] && r - runStart >= 3) {
          for (let k = runStart; k < r; k++) matched[k][c] = true;
        }
        runStart = r;
      }
    }
  }
  return matched;
};

const countMatched = (m) => m.reduce((a, row) => a + row.filter(Boolean).length, 0);

const collapseAndRefill = (board, matched) => {
  const next = board.map((row) => row.slice());
  for (let c = 0; c < COLS; c++) {
    let writeRow = ROWS - 1;
    for (let r = ROWS - 1; r >= 0; r--) {
      if (!matched[r][c]) {
        next[writeRow][c] = next[r][c];
        if (writeRow !== r) next[r][c] = null;
        writeRow--;
      } else {
        next[r][c] = null;
      }
    }
    for (let r = writeRow; r >= 0; r--) {
      next[r][c] = randomGem();
    }
  }
  return next;
};

const areAdjacent = (a, b) => {
  if (!a || !b) return false;
  const dr = Math.abs(a.r - b.r);
  const dc = Math.abs(a.c - b.c);
  return dr + dc === 1;
};

export default function App() {
  const [board, setBoard] = useState(makeBoard);
  const [selected, setSelected] = useState(null);
  const [score, setScore] = useState(0);
  const [moves, setMoves] = useState(20);
  const [busy, setBusy] = useState(false);
  const [combo, setCombo] = useState(0);
  const [gameOver, setGameOver] = useState(false);
  const scorePulse = useRef(new Animated.Value(1)).current;

  const pulseScore = useCallback(() => {
    Animated.sequence([
      Animated.timing(scorePulse, { toValue: 1.25, duration: 120, useNativeDriver: true }),
      Animated.timing(scorePulse, { toValue: 1, duration: 160, useNativeDriver: true }),
    ]).start();
  }, [scorePulse]);

  const resolveCascade = useCallback(
    async (startingBoard) => {
      setBusy(true);
      let current = startingBoard;
      let chain = 0;
      let totalCleared = 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const matched = findMatches(current);
        const cleared = countMatched(matched);
        if (cleared === 0) break;
        chain += 1;
        totalCleared += cleared;
        const gained = cleared * 10 * chain;
        setScore((s) => s + gained);
        setCombo(chain);
        pulseScore();
        current = collapseAndRefill(current, matched);
        setBoard(current);
        // small delay for animation feel
        // eslint-disable-next-line no-await-in-loop
        await new Promise((res) => setTimeout(res, 220));
      }
      setCombo(0);
      setBusy(false);
      return totalCleared;
    },
    [pulseScore]
  );

  const trySwap = useCallback(
    async (a, b) => {
      if (busy || moves <= 0) return;
      const swapped = board.map((row) => row.slice());
      [swapped[a.r][a.c], swapped[b.r][b.c]] = [swapped[b.r][b.c], swapped[a.r][a.c]];
      const matched = findMatches(swapped);
      if (countMatched(matched) === 0) {
        // invalid swap — flash and revert
        setBoard(swapped);
        setBusy(true);
        await new Promise((res) => setTimeout(res, 180));
        setBoard(board);
        setBusy(false);
        return;
      }
      setBoard(swapped);
      setMoves((m) => m - 1);
      await resolveCascade(swapped);
    },
    [board, busy, moves, resolveCascade]
  );

  useEffect(() => {
    // initial cascade in case the random board has any matches (shouldn't, but safe)
    resolveCascade(board).then(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (moves <= 0 && !busy) setGameOver(true);
  }, [moves, busy]);

  const onTile = (r, c) => {
    if (busy || gameOver) return;
    const pos = { r, c };
    if (!selected) {
      setSelected(pos);
      return;
    }
    if (selected.r === r && selected.c === c) {
      setSelected(null);
      return;
    }
    if (areAdjacent(selected, pos)) {
      const a = selected;
      setSelected(null);
      trySwap(a, pos);
    } else {
      setSelected(pos);
    }
  };

  const reset = () => {
    setBoard(makeBoard());
    setSelected(null);
    setScore(0);
    setMoves(20);
    setCombo(0);
    setGameOver(false);
  };

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="light" />
      <View style={styles.header}>
        <Text style={styles.title}>Gem Match</Text>
        <View style={styles.statsRow}>
          <View style={styles.stat}>
            <Text style={styles.statLabel}>SCORE</Text>
            <Animated.Text style={[styles.statValue, { transform: [{ scale: scorePulse }] }]}>
              {score}
            </Animated.Text>
          </View>
          <View style={styles.stat}>
            <Text style={styles.statLabel}>MOVES</Text>
            <Text style={styles.statValue}>{moves}</Text>
          </View>
          <View style={styles.stat}>
            <Text style={styles.statLabel}>COMBO</Text>
            <Text style={[styles.statValue, combo > 1 && styles.combo]}>
              {combo > 1 ? `x${combo}` : '—'}
            </Text>
          </View>
        </View>
      </View>

      <View style={styles.board}>
        {board.map((row, r) => (
          <View key={r} style={styles.row}>
            {row.map((gem, c) => {
              const isSel = selected && selected.r === r && selected.c === c;
              return (
                <TouchableOpacity
                  key={c}
                  activeOpacity={0.7}
                  onPress={() => onTile(r, c)}
                  style={[
                    styles.tile,
                    { width: TILE_SIZE, height: TILE_SIZE },
                    isSel && styles.tileSelected,
                  ]}
                >
                  <Text style={{ fontSize: TILE_SIZE * 0.6 }}>{gem}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        ))}
      </View>

      <View style={styles.footer}>
        {gameOver ? (
          <View style={styles.gameOver}>
            <Text style={styles.gameOverText}>Game Over!</Text>
            <Text style={styles.gameOverScore}>Final Score: {score}</Text>
            <TouchableOpacity style={styles.button} onPress={reset}>
              <Text style={styles.buttonText}>Play Again</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <>
            <Text style={styles.hint}>
              Tap a gem, then tap an adjacent gem to swap. Match 3+ to score.
            </Text>
            <TouchableOpacity style={styles.buttonSmall} onPress={reset}>
              <Text style={styles.buttonText}>Restart</Text>
            </TouchableOpacity>
          </>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: '#0b1020',
  },
  header: {
    paddingTop: 12,
    paddingHorizontal: 16,
  },
  title: {
    color: '#fff',
    fontSize: 28,
    fontWeight: '800',
    letterSpacing: 1,
    textAlign: 'center',
    marginBottom: 8,
  },
  statsRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    backgroundColor: '#161c33',
    borderRadius: 14,
    paddingVertical: 10,
    marginBottom: 12,
  },
  stat: {
    alignItems: 'center',
    minWidth: 70,
  },
  statLabel: {
    color: '#7c84a8',
    fontSize: 11,
    letterSpacing: 1.5,
    marginBottom: 2,
  },
  statValue: {
    color: '#fff',
    fontSize: 20,
    fontWeight: '700',
  },
  combo: {
    color: '#ffd166',
  },
  board: {
    padding: BOARD_PADDING,
    backgroundColor: '#0f1530',
    borderRadius: 16,
    marginHorizontal: 12,
    alignSelf: 'center',
  },
  row: {
    flexDirection: 'row',
  },
  tile: {
    margin: 2,
    backgroundColor: '#1c2347',
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tileSelected: {
    backgroundColor: '#3a4380',
    borderWidth: 2,
    borderColor: '#ffd166',
  },
  footer: {
    flex: 1,
    paddingHorizontal: 24,
    paddingTop: 16,
    alignItems: 'center',
  },
  hint: {
    color: '#9aa3c7',
    textAlign: 'center',
    fontSize: 13,
    marginBottom: 12,
  },
  gameOver: {
    alignItems: 'center',
  },
  gameOverText: {
    color: '#ffd166',
    fontSize: 24,
    fontWeight: '800',
    marginBottom: 6,
  },
  gameOverScore: {
    color: '#fff',
    fontSize: 18,
    marginBottom: 14,
  },
  button: {
    backgroundColor: '#5b6cff',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 999,
  },
  buttonSmall: {
    backgroundColor: '#2a335f',
    paddingHorizontal: 18,
    paddingVertical: 8,
    borderRadius: 999,
  },
  buttonText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 14,
    letterSpacing: 0.5,
  },
});
