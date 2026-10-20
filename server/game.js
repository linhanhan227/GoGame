/**
 * 对局房间：服务端权威状态机
 * phase: playing -> scoring -> finished
 */
import {
  applyMove,
  computeScore,
  groupAt,
  toSGF,
  neighbors,
  BLACK,
  WHITE,
  EMPTY,
} from '../shared/go-engine.js';

export const MAIN_TIME_BY_SIZE = { 9: 300, 13: 480, 19: 600 };

export class GameRoom {
  constructor({ id, size, komi, black, white }) {
    this.id = id;
    this.size = size;
    this.komi = komi ?? 7.5;
    this.players = { black, white };
    this.board = new Uint8Array(size * size);
    this.toPlay = BLACK;
    this.ko = -1;
    this.captures = { black: 0, white: 0 };
    this.moves = [];
    this.phase = 'playing';
    this.dead = new Set();
    this.confirmed = new Set();
    this.lastMove = null;
    this.passes = 0;
    this.timeLeft = { black: MAIN_TIME_BY_SIZE[size] ?? 600, white: MAIN_TIME_BY_SIZE[size] ?? 600 };
    this.startedAt = Date.now();
    this.result = null;
    this.disconnected = new Set();
    this.onMove = null;
    this.onFinish = null;
  }

  colorOf(userId) {
    if (this.players.black.id === userId) return 'black';
    if (this.players.white.id === userId) return 'white';
    return null;
  }

  stoneOf(color) {
    return color === 'black' ? BLACK : WHITE;
  }

  opponentColor(color) {
    return color === 'black' ? 'white' : 'black';
  }

  snapshot() {
    return {
      id: this.id,
      size: this.size,
      komi: this.komi,
      players: this.players,
      board: Array.from(this.board),
      toPlay: this.toPlay === BLACK ? 'black' : 'white',
      ko: this.ko,
      captures: this.captures,
      moves: this.moves,
      moveNumber: this.moves.length,
      phase: this.phase,
      dead: [...this.dead],
      confirmed: [...this.confirmed],
      lastMove: this.lastMove,
      timeLeft: this.timeLeft,
      passes: this.passes,
      result: this.result,
      provisional: this.phase === 'scoring' ? this.scoreNow() : null,
      disconnected: [...this.disconnected],
    };
  }

  scoreNow() {
    const s = computeScore(this.board, this.size, this.dead);
    return {
      ...s,
      diff: +(s.black - s.white - this.komi).toFixed(2),
      komi: this.komi,
    };
  }

  /** 落子 */
  play(userId, x, y) {
    const color = this.colorOf(userId);
    if (!color) return { ok: false, error: '你不是本局对局者' };
    if (this.phase === 'finished') return { ok: false, error: '对局已结束' };
    if (this.phase === 'scoring') return { ok: false, error: '正在点目，请确认或恢复对局' };
    if (this.toPlay !== this.stoneOf(color)) return { ok: false, error: '未轮到你落子' };

    const point = y * this.size + x;
    const res = applyMove({ board: this.board, size: this.size, ko: this.ko, toPlay: this.toPlay }, point);
    if (!res.ok) return { ok: false, error: res.reason };

    this.board = res.board;
    this.ko = res.ko;
    this.lastMove = { x, y, color };
    this.captures[color] += res.captured.length;
    this.passes = 0;

    const move = {
      seq: this.moves.length + 1,
      color: this.stoneOf(color),
      x,
      y,
      pass: false,
      captured: res.captured.length,
    };
    this.moves.push(move);
    this.toPlay = this.toPlay === BLACK ? WHITE : BLACK;
    if (this.onMove) this.onMove(this, move);
    return { ok: true };
  }

  /** 虚手 */
  pass(userId) {
    const color = this.colorOf(userId);
    if (!color) return { ok: false, error: '你不是本局对局者' };
    if (this.phase === 'finished') return { ok: false, error: '对局已结束' };
    if (this.phase === 'scoring') return { ok: false, error: '正在点目' };
    if (this.toPlay !== this.stoneOf(color)) return { ok: false, error: '未轮到你落子' };

    this.passes += 1;
    this.ko = -1;
    const move = {
      seq: this.moves.length + 1,
      color: this.stoneOf(color),
      x: null,
      y: null,
      pass: true,
      captured: 0,
    };
    this.moves.push(move);
    this.toPlay = this.toPlay === BLACK ? WHITE : BLACK;
    if (this.passes >= 2) this.enterScoring();
    if (this.onMove) this.onMove(this, move);
    return { ok: true };
  }

  enterScoring() {
    this.phase = 'scoring';
    this.dead = new Set();
    this.confirmed = new Set();
  }

  resumePlay(userId) {
    const color = this.colorOf(userId);
    if (!color) return { ok: false, error: '你不是本局对局者' };
    if (this.phase !== 'scoring') return { ok: false, error: '当前不在点目阶段' };
    this.phase = 'playing';
    this.dead = new Set();
    this.confirmed = new Set();
    this.passes = 1; // 恢复后仅需一次虚手即可再次点目
    return { ok: true };
  }

  /** 点目阶段：标记 / 取消标记整块死子 */
  toggleDead(userId, point) {
    const color = this.colorOf(userId);
    if (!color) return { ok: false, error: '你不是本局对局者' };
    if (this.phase !== 'scoring') return { ok: false, error: '当前不在点目阶段' };
    if (point < 0 || point >= this.board.length) return { ok: false, error: '坐标越界' };
    if (this.board[point] === EMPTY) return { ok: false, error: '该点无棋子' };

    const g = groupAt(this.board, point, this.size);
    const isDead = this.dead.has(g.stones[0]);
    for (const s of g.stones) {
      if (isDead) this.dead.delete(s);
      else this.dead.add(s);
    }
    this.confirmed = new Set();
    return { ok: true };
  }

  /** 点目阶段：确认结果；双方均确认则终局 */
  confirmScore(userId) {
    const color = this.colorOf(userId);
    if (!color) return { ok: false, error: '你不是本局对局者' };
    if (this.phase !== 'scoring') return { ok: false, error: '当前不在点目阶段' };
    this.confirmed.add(color);
    if (this.confirmed.has('black') && this.confirmed.has('white')) {
      const s = this.scoreNow();
      const winner = s.diff > 0 ? 'black' : s.diff < 0 ? 'white' : 'draw';
      const diff = Math.abs(s.diff);
      const text =
        winner === 'draw' ? '和棋' : `${winner === 'black' ? '黑' : '白'}胜 ${diff.toFixed(1)} 子`;
      this.finish(winner, 'score', text, { blackScore: s.black, whiteScore: s.white + this.komi });
      return { ok: true, finished: true };
    }
    return { ok: true, finished: false };
  }

  resign(userId) {
    const color = this.colorOf(userId);
    if (!color) return { ok: false, error: '你不是本局对局者' };
    if (this.phase === 'finished') return { ok: false, error: '对局已结束' };
    const winner = this.opponentColor(color);
    this.finish(winner, 'resign', `${winner === 'black' ? '黑' : '白'}中盘胜`);
    return { ok: true };
  }

  timeout() {
    if (this.phase === 'finished') return;
    const loser = this.toPlay === BLACK ? 'black' : 'white';
    const winner = this.opponentColor(loser);
    this.finish(winner, 'timeout', `${winner === 'black' ? '黑' : '白'}胜（对方超时）`);
  }

  forfeitByDisconnect(color) {
    if (this.phase === 'finished') return;
    const winner = this.opponentColor(color);
    this.finish(winner, 'disconnect', `${winner === 'black' ? '黑' : '白'}胜（对方断线）`);
  }

  finish(winner, reason, text, extra = {}) {
    if (this.phase === 'finished') return;
    this.phase = 'finished';
    this.result = { winner, reason, text, ...extra, endedAt: Date.now() };
    if (this.onFinish) this.onFinish(this, this.result);
  }

  /** 计时心跳 */
  tick(seconds = 1) {
    if (this.phase !== 'playing') return;
    if (this.disconnected.size > 0) return;
    const color = this.toPlay === BLACK ? 'black' : 'white';
    this.timeLeft[color] = Math.max(0, this.timeLeft[color] - seconds);
    if (this.timeLeft[color] <= 0) this.timeout();
  }

  sgf() {
    return toSGF(this.moves, {
      size: this.size,
      komi: this.komi,
      blackName: this.players.black.nickname,
      whiteName: this.players.white.nickname,
    });
  }
}
