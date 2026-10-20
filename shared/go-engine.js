/**
 * 围棋规则引擎（前后端共用，纯函数，无副作用）
 * 规则：中国规则（数子法），禁自杀、禁立即提回（简单劫）
 */

export const EMPTY = 0;
export const BLACK = 1;
export const WHITE = 2;

export const opponent = (c) => (c === BLACK ? WHITE : BLACK);
export const colorName = (c) => (c === BLACK ? '黑' : c === WHITE ? '白' : '空');

export function createBoard(size) {
  return new Uint8Array(size * size);
}

export function toIndex(x, y, size) {
  return y * size + x;
}

export function toCoords(i, size) {
  return { x: i % size, y: Math.floor(i / size) };
}

export function neighbors(i, size) {
  const x = i % size;
  const y = (i - x) / size;
  const out = [];
  if (y > 0) out.push(i - size);
  if (y < size - 1) out.push(i + size);
  if (x > 0) out.push(i - 1);
  if (x < size - 1) out.push(i + 1);
  return out;
}

/** 取某点的整块棋：棋子列表 + 气集合 */
export function groupAt(board, start, size) {
  const color = board[start];
  if (!color) return { stones: [], liberties: new Set(), color: EMPTY };
  const stones = [];
  const liberties = new Set();
  const seen = new Set([start]);
  const stack = [start];
  while (stack.length) {
    const p = stack.pop();
    stones.push(p);
    for (const n of neighbors(p, size)) {
      if (board[n] === EMPTY) liberties.add(n);
      else if (board[n] === color && !seen.has(n)) {
        seen.add(n);
        stack.push(n);
      }
    }
  }
  return { stones, liberties, color };
}

/**
 * 尝试落子（不修改入参）
 * @param {{board:Uint8Array,size:number,ko:number,toPlay:number}} state
 * @param {number} point
 * @returns {{ok:boolean,reason?:string,board?:Uint8Array,captured?:number[],ko?:number}}
 */
export function applyMove(state, point) {
  const { size, board, ko, toPlay } = state;
  if (point < 0 || point >= board.length) return { ok: false, reason: '坐标越界' };
  if (board[point] !== EMPTY) return { ok: false, reason: '该点已有棋子' };
  if (point === ko) return { ok: false, reason: '打劫：此处不可立即提回' };

  const next = Uint8Array.from(board);
  next[point] = toPlay;
  const enemy = opponent(toPlay);
  const captured = [];

  for (const n of neighbors(point, size)) {
    if (next[n] === enemy) {
      const g = groupAt(next, n, size);
      if (g.liberties.size === 0) {
        for (const s of g.stones) {
          next[s] = EMPTY;
          captured.push(s);
        }
      }
    }
  }

  const own = groupAt(next, point, size);
  if (captured.length === 0 && own.liberties.size === 0) {
    return { ok: false, reason: '禁着点：不可自杀' };
  }

  // 简单劫判定：仅提一子，且己方落子后成单子单气
  let nextKo = -1;
  if (captured.length === 1 && own.stones.length === 1 && own.liberties.size === 1) {
    nextKo = captured[0];
  }

  return { ok: true, board: next, captured, ko: nextKo };
}

/** 是否合法（用于 UI 落子提示 / AI 候选） */
export function isLegal(state, point) {
  return applyMove(state, point).ok;
}

export function legalMoves(state) {
  const out = [];
  for (let i = 0; i < state.board.length; i++) {
    if (state.board[i] === EMPTY && applyMove(state, i).ok) out.push(i);
  }
  return out;
}

/**
 * 中国规则数子：子 + 单方围空。死子集合先移除。
 * @returns {{black:number,white:number,blackStones:number,whiteStones:number,blackTerritory:number,whiteTerritory:number}}
 */
export function computeScore(board, size, dead = new Set()) {
  const b = Uint8Array.from(board);
  for (const p of dead) if (p >= 0 && p < b.length) b[p] = EMPTY;

  let blackStones = 0;
  let whiteStones = 0;
  for (let i = 0; i < b.length; i++) {
    if (b[i] === BLACK) blackStones++;
    else if (b[i] === WHITE) whiteStones++;
  }

  const visited = new Uint8Array(b.length);
  let blackTerritory = 0;
  let whiteTerritory = 0;

  for (let i = 0; i < b.length; i++) {
    if (b[i] !== EMPTY || visited[i]) continue;
    const stack = [i];
    visited[i] = 1;
    let count = 0;
    let touchesBlack = false;
    let touchesWhite = false;
    while (stack.length) {
      const p = stack.pop();
      count++;
      for (const n of neighbors(p, size)) {
        const v = b[n];
        if (v === EMPTY) {
          if (!visited[n]) {
            visited[n] = 1;
            stack.push(n);
          }
        } else if (v === BLACK) touchesBlack = true;
        else touchesWhite = true;
      }
    }
    if (touchesBlack && !touchesWhite) blackTerritory += count;
    else if (touchesWhite && !touchesBlack) whiteTerritory += count;
  }

  return {
    black: blackStones + blackTerritory,
    white: whiteStones + whiteTerritory,
    blackStones,
    whiteStones,
    blackTerritory,
    whiteTerritory,
  };
}

const SGF_LETTERS = 'abcdefghijklmnopqrstuvwxyz';

export function toSGF(moves, { size = 19, komi = 7.5, blackName = '黑方', whiteName = '白方' } = {}) {
  const head =
    `(;GM[1]FF[4]CA[UTF-8]AP[OnlineGo:1.0]SZ[${size}]KM[${komi}]` +
    `PB[${blackName}]PW[${whiteName}]RU[Chinese]`;
  let body = '';
  for (const m of moves) {
    const color = m.color === BLACK ? 'B' : 'W';
    if (m.pass || m.x == null) body += `;${color}[]`;
    else body += `;${color}[${SGF_LETTERS[m.x]}${SGF_LETTERS[m.y]}]`;
  }
  return `${head}${body})`;
}

export const BOARD_SIZES = [9, 13, 19];
export const DEFAULT_KOMI = 7.5;
