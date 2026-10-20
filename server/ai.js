/**
 * 轻量 AI 陪练
 * 策略：开局按星位/三四线布局，中盘走接触战（提子 > 打吃 > 靠近对方棋子），
 * 并抑制自团与贴子砌墙。不追求棋力，只保证棋形自然、可用于单人验证系统。
 */
import { applyMove, groupAt, neighbors, EMPTY, BLACK, WHITE } from '../shared/go-engine.js';

const OPENING = {
  19: [
    [3, 3], [15, 15], [3, 15], [15, 3],
    [9, 3], [3, 9], [15, 9], [9, 15],
    [9, 9], [2, 5], [5, 2], [16, 13], [13, 16],
  ],
  13: [
    [3, 3], [9, 9], [3, 9], [9, 3],
    [6, 3], [3, 6], [9, 6], [6, 9],
    [6, 6], [2, 4], [4, 2], [10, 8], [8, 10],
  ],
  9: [
    [2, 2], [6, 6], [2, 6], [6, 2],
    [4, 4], [4, 2], [2, 4], [6, 4], [4, 6],
  ],
};

function isEyeFill(board, point, size, color) {
  const nbs = neighbors(point, size);
  if (nbs.length < 2) return false;
  return nbs.every((n) => board[n] === color);
}

function stonesOnBoard(board) {
  let n = 0;
  for (let i = 0; i < board.length; i++) if (board[i] !== EMPTY) n++;
  return n;
}

export function chooseMove(room, color) {
  const size = room.size;
  const stone = color === 'black' ? BLACK : WHITE;
  const enemyStone = color === 'black' ? WHITE : BLACK;
  const state = { board: room.board, size, ko: room.ko, toPlay: stone };

  // 布局阶段：优先占据空余的星位 / 三四线要点
  if (stonesOnBoard(room.board) < 10) {
    const book = OPENING[size] || OPENING[19];
    const free = book.filter(([x, y]) => room.board[y * size + x] === EMPTY);
    if (free.length) {
      const [x, y] = free[0];
      const res = applyMove(state, y * size + x);
      if (res.ok) return y * size + x;
    }
  }

  const center = (size - 1) / 2;
  let best = null;
  let bestScore = -Infinity;

  for (let i = 0; i < room.board.length; i++) {
    if (room.board[i] !== EMPTY) continue;
    const res = applyMove(state, i);
    if (!res.ok) continue;
    if (isEyeFill(room.board, i, size, stone)) continue;

    const x = i % size;
    const y = (i - x) / size;

    // 提子优先
    let score = res.captured.length * 16;

    // 落子后己方气数
    const g = groupAt(res.board, i, size);
    score += Math.min(g.liberties.size, 6) * 0.8;

    // 接触战：靠近对方棋子，抑制自团
    let ownAdj = 0;
    let enemyAdj = 0;
    for (const n of neighbors(i, size)) {
      if (room.board[n] === stone) ownAdj++;
      else if (room.board[n] === enemyStone) enemyAdj++;
    }
    score += enemyAdj * 1.5 + Math.min(ownAdj, 1) * 0.9;
    if (ownAdj > 1) score -= (ownAdj - 1) * 1.7;

    // 局部密度：避免贴着自己反复下
    let nearbyOwn = 0;
    let nearbyEnemy = 0;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
        const v = room.board[ny * size + nx];
        if (v === stone) nearbyOwn++;
        else if (v === enemyStone) nearbyEnemy++;
      }
    }
    score -= nearbyOwn * 0.55;
    score += nearbyEnemy * 0.12;

    // 轻微向中心靠拢，避免一路爬边
    score -= Math.hypot(x - center, y - center) * 0.1;
    score += Math.random() * 1.2;

    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}
