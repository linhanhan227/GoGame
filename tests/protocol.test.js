/**
 * 自动化验证：规则引擎单测 + 端到端协议流程
 * 运行：node tests/protocol.test.js
 */
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMove, computeScore, createBoard, BLACK, WHITE, EMPTY, toIndex } from '../shared/go-engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = 8099;
const DB_FILE = path.join(ROOT, 'data', 'test.db');

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} ${extra}`);
  }
};

/* ------------------------------ 1. 规则引擎 ------------------------------ */

console.log('\n[1] 规则引擎');

{
  // 提子：白 (0,0) 被黑 (1,0)(0,1) 包围
  let board = createBoard(9);
  board[toIndex(0, 0, 9)] = WHITE;
  board[toIndex(1, 0, 9)] = BLACK;
  const res = applyMove({ board, size: 9, ko: -1, toPlay: BLACK }, toIndex(0, 1, 9));
  ok('落子提子', res.ok && res.captured.length === 1 && res.board[toIndex(0, 0, 9)] === EMPTY);
}

{
  // 自杀禁着
  let board = createBoard(3);
  board[toIndex(1, 0, 3)] = WHITE;
  board[toIndex(0, 1, 3)] = WHITE;
  const res = applyMove({ board, size: 3, ko: -1, toPlay: BLACK }, toIndex(0, 0, 3));
  ok('禁自杀', !res.ok && /自杀/.test(res.reason), res.reason);
}

{
  // 打劫
  let board = createBoard(5);
  board[toIndex(1, 1, 5)] = WHITE;
  board[toIndex(0, 2, 5)] = WHITE;
  board[toIndex(2, 2, 5)] = WHITE;
  board[toIndex(1, 3, 5)] = WHITE;
  board[toIndex(0, 1, 5)] = BLACK;
  board[toIndex(2, 1, 5)] = BLACK;
  board[toIndex(1, 0, 5)] = BLACK;

  const take = applyMove({ board, size: 5, ko: -1, toPlay: BLACK }, toIndex(1, 2, 5));
  ok('劫：先手提子成功', take.ok && take.captured.length === 1);
  ok('劫：生成劫点', take.ko === toIndex(1, 1, 5));

  const back = applyMove(
    { board: take.board, size: 5, ko: take.ko, toPlay: WHITE },
    toIndex(1, 1, 5)
  );
  ok('劫：禁止立即提回', !back.ok && /打劫/.test(back.reason), back.reason);
}

{
  // 数子：5x5，黑占 x=2 竖线，白占 x=4 竖线
  const size = 5;
  const board = createBoard(size);
  for (let y = 0; y < size; y++) board[toIndex(2, y, size)] = BLACK;
  for (let y = 0; y < size; y++) board[toIndex(4, y, size)] = WHITE;
  const s = computeScore(board, size, new Set());
  // 左区 x=0,1（10 点）仅邻黑 -> 黑 5+10=15；x=3 同时邻黑白 -> 单官；白 5 子
  ok('数子：黑 15 / 白 5', s.black === 15 && s.white === 5, JSON.stringify(s));
}

{
  // 数子：死子标记后归属改变
  const size = 5;
  const board = createBoard(size);
  for (let y = 0; y < size; y++) board[toIndex(2, y, size)] = BLACK;
  board[toIndex(0, 0, size)] = WHITE;
  const alive = computeScore(board, size, new Set());
  const dead = computeScore(board, size, new Set([toIndex(0, 0, size)]));
  ok('数子：活白子存在时左区为单官', alive.black === 15 && alive.white === 1, JSON.stringify(alive));
  ok('数子：标死后归黑', dead.black === 25 && dead.white === 0, JSON.stringify(dead));
}

/* ------------------------------ 2. 端到端 ------------------------------ */

class TestClient {
  constructor(name) {
    this.name = name;
    this.messages = [];
    this.waiters = [];
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
      this.ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        this.messages.push(msg);
        for (const w of [...this.waiters]) {
          if (w.match(msg)) {
            this.waiters.splice(this.waiters.indexOf(w), 1);
            w.resolve(msg);
          }
        }
      });
    });
  }

  send(payload) {
    this.ws.send(JSON.stringify(payload));
  }

  waitFor(type, timeout = 4000, predicate = () => true) {
    const hit = this.messages.find((m) => m.type === type && predicate(m));
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== wrapped);
        reject(new Error(`${this.name} 等待 ${type} 超时`));
      }, timeout);
      const wrapped = (msg) => {
        clearTimeout(timer);
        resolve(msg);
      };
      this.waiters.push({ match: (m) => m.type === type && predicate(m), resolve: wrapped });
    });
  }

  clear() {
    this.messages = [];
  }
}

async function waitHealth() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/health`);
      if (r.ok) return await r.json();
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('服务未启动');
}

async function run() {
  // 清理上一次的库文件；WAL/SHM 必须一并删除，否则残留日志可能被回放，
  // 让「干净库」假设失效（表现为排行榜/对局数不符合预期）。
  for (const f of [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`]) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* 文件不存在即视为已清理 */
    }
  }

  const server = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), GO_DB: DB_FILE },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', () => {});
  server.stderr.on('data', (d) => process.stderr.write(d));

  try {
    console.log('\n[2] HTTP 服务');
    const health = await waitHealth();
    ok('健康检查', health.ok === true);
    const page = await fetch(`http://127.0.0.1:${PORT}/`);
    const html = await page.text();
    ok('静态首页可访问', page.ok && html.includes('<div id="root">'));

    console.log('\n[3] 匹配与对局');
    const a = new TestClient('A');
    const b = new TestClient('B');
    await a.connect();
    await b.connect();
    a.send({ type: 'login', userId: 'test-a', nickname: '甲' });
    b.send({ type: 'login', userId: 'test-b', nickname: '乙' });
    const loginA = await a.waitFor('logged_in');
    const loginB = await b.waitFor('logged_in');
    ok('登录成功', loginA.user.nickname === '甲' && loginB.user.nickname === '乙');

    a.send({ type: 'queue', size: 9 });
    b.send({ type: 'queue', size: 9 });

    const stateA = await a.waitFor('state');
    const stateB = await b.waitFor('state');
    ok('自动匹配成功', stateA.game.id === stateB.game.id && stateA.game.size === 9);
    ok('双方颜色互补', stateA.you !== stateB.you);
    ok('初始棋盘为空', stateA.game.board.every((v) => v === 0));

    const black = stateA.you === 'black' ? a : b;
    const white = stateA.you === 'black' ? b : a;
    const gameId = stateA.game.id;

    // 黑 (1,0)，白 (0,0)，黑 (0,1) 提子
    black.send({ type: 'move', x: 1, y: 0 });
    await white.waitFor('state', 4000, (m) => m.game.moveNumber === 1);
    white.send({ type: 'move', x: 0, y: 0 });
    await black.waitFor('state', 4000, (m) => m.game.moveNumber === 2);
    black.send({ type: 'move', x: 0, y: 1 });
    const afterCapture = await white.waitFor('state', 4000, (m) => m.game.moveNumber === 3);
    ok('提子生效', afterCapture.game.captures.black === 1, JSON.stringify(afterCapture.game.captures));
    ok('被提子位置清空', afterCapture.game.board[0] === 0);

    // 非法落子
    white.send({ type: 'move', x: 1, y: 0 });
    const err = await white.waitFor('error');
    ok('拒绝占用点落子', /已有棋子/.test(err.message), err.message);

    // 非轮次落子
    black.send({ type: 'move', x: 5, y: 5 });
    const err2 = await black.waitFor('error');
    ok('拒绝非轮次落子', /未轮到/.test(err2.message), err2.message);

    // 双方虚手 -> 点目
    white.send({ type: 'pass' });
    await black.waitFor('state', 4000, (m) => m.game.passes === 1);
    black.send({ type: 'pass' });
    const scoring = await white.waitFor('state', 4000, (m) => m.game.phase === 'scoring');
    ok('双方虚手进入点目', scoring.game.phase === 'scoring');
    ok('点目给出估算', scoring.game.provisional !== null);

    // 标记死子：黑方把白 (0,0) 标死（已被提，改为标 (8,8) 无子不生效）
    // 直接双方确认
    white.send({ type: 'confirm_score' });
    await black.waitFor('state', 4000, (m) => m.game.confirmed.length === 1);
    black.send({ type: 'confirm_score' });
    const over = await black.waitFor('game_over');
    ok('双方确认后终局', !!over.result && /胜|和棋/.test(over.result.text), JSON.stringify(over.result));

    console.log('\n[4] 数据持久化');
    const rec = await (await fetch(`http://127.0.0.1:${PORT}/api/game/${gameId}`)).json();
    ok('对局记录入库', rec.id === gameId && rec.moves.length === 5, `moves=${rec.moves?.length}`);
    ok('终局结果入库', !!rec.result && rec.ended_at !== null);
    const sgfRes = await fetch(`http://127.0.0.1:${PORT}/api/game/${gameId}.sgf`);
    const sgf = await sgfRes.text();
    ok('SGF 棋谱可下载', sgfRes.ok && sgf.startsWith('(;GM[1]') && sgf.includes(';B['), sgf.slice(0, 40));

    const lobby = await (await fetch(`http://127.0.0.1:${PORT}/api/lobby`)).json();
    ok('排行榜有战绩', lobby.leaderboard.length >= 1, JSON.stringify(lobby.leaderboard));
    ok('最近对局可见', lobby.recent.length >= 1);

    console.log('\n[5] 人机练习');
    const c = new TestClient('C');
    await c.connect();
    c.send({ type: 'login', userId: 'test-c', nickname: '丙' });
    await c.waitFor('logged_in');
    c.send({ type: 'practice', size: 9 });
    const s = await c.waitFor('state');
    ok('创建人机对局', s.game.size === 9 && Object.values(s.game.players).some((p) => p.id === 'bot:ai'));
    const myColor = s.you;
    let cur = s;
    if (cur.game.toPlay !== myColor) {
      // AI 执黑先手
      cur = await c.waitFor('state', 6000, (m) => m.game.moveNumber >= 1);
    }
    const size = cur.game.size;
    const empty = cur.game.board.findIndex((v) => v === 0);
    c.send({ type: 'move', x: empty % size, y: Math.floor(empty / size) });
    const botMoved = await c.waitFor('state', 8000, (m) => m.game.moveNumber >= cur.game.moveNumber + 2);
    ok('AI 自动应手', botMoved.game.moveNumber >= cur.game.moveNumber + 2, `moves=${botMoved.game.moveNumber}`);

    a.ws.close();
    b.ws.close();
    c.ws.close();
  } finally {
    server.kill();
    await new Promise((r) => setTimeout(r, 300));
    for (const f of [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`]) {
      try {
        fs.rmSync(f, { force: true });
      } catch {}
    }
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail === 0 ? 0 : 1);
}

run().catch((e) => {
  console.error('测试异常：', e);
  process.exit(1);
});
