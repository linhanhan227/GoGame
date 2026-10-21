/**
 * 在线围棋服务端
 * - 托管 dist 静态前端（纯静态构建产物）
 * - WebSocket 自动撮合 + 对局权威判定
 * - SQLite 落库（用户 / 对局 / 每一手）
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import { GameRoom, MAIN_TIME_BY_SIZE } from './game.js';
import { chooseMove } from './ai.js';
import {
  upsertUser,
  getUser,
  touchUser,
  getLeaderboard,
  getRecentGames,
  getGameRecord,
  getUserGames,
  createGameRow,
  recordMoveRow,
  finishGameRow,
  applyResult,
  totalUsers,
  dbPing,
  dbInfo,
  sweepUnfinishedGames,
  closeDb,
  DB_FILE,
} from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const DISCONNECT_GRACE_MS = 30_000;

/* ---------------------------------- 状态 ---------------------------------- */

/** @type {Map<string, GameRoom>} */
const rooms = new Map();
/** @type {Map<string, string>} userId -> gameId */
const userRoom = new Map();
/** @type {Map<string, {ws: import('ws').WebSocket, userId: string}>} */
const onlineUsers = new Map();
/** @type {Map<number, Array<{userId: string, nickname: string}>>} size -> queue */
const queues = new Map([[9, []], [13, []], [19, []]]);
/** 断线宽限计时器 userId -> timeout */
const graceTimers = new Map();
const BOT_ID = 'bot:ai';

/* -------------------------------- 静态资源 -------------------------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

function serveStatic(pathname, res) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.join(DIST, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(DIST)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      // SPA 回退
      fs.readFile(path.join(DIST, 'index.html'), (e2, html) => {
        if (e2) {
          res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(
            '<h1>前端尚未构建</h1><p>请先执行 <code>npm run build</code>，再运行 <code>npm start</code>。</p>'
          );
          return;
        }
        res.writeHead(200, { 'Content-Type': MIME['.html'] }).end(html);
      });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    // config.js 是运行时配置，必须实时生效（否则平台改了 wsUrl 要等缓存过期）
    const noCache = ext === '.html' || rel === '/config.js';
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': noCache ? 'no-cache' : 'public, max-age=3600',
    });
    res.end(data);
  });
}

/* ------------------------------- HTTP 服务 ------------------------------- */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function sendJson(res, code, data) {
  res.writeHead(code, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store', ...CORS });
  res.end(JSON.stringify(data));
}

function healthPayload() {
  return {
    ok: true,
    db: dbPing(),
    online: onlineUsers.size,
    rooms: rooms.size,
    users: totalUsers(),
    uptime: Math.round(process.uptime()),
    node: process.version,
    dbFile: DB_FILE,
    dbInfo: dbInfo(),
  };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  try {
    // 平台探活：Bonto 及常见外部监控会打 /healthz 或 /health
    if (url.pathname === '/healthz' || url.pathname === '/health') {
      sendJson(res, 200, healthPayload());
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS).end();
        return;
      }

      if (url.pathname === '/api/health') {
        sendJson(res, 200, healthPayload());
        return;
      }

      if (url.pathname.startsWith('/api/game/')) {
        const raw = url.pathname.slice('/api/game/'.length);
        const isSgf = raw.endsWith('.sgf');
        const id = isSgf ? raw.slice(0, -4) : raw;
        const rec = getGameRecord(id);
        if (!rec) {
          sendJson(res, 404, { error: 'not found' });
          return;
        }
        if (isSgf) {
          res.writeHead(200, {
            'Content-Type': 'application/x-go-sgf; charset=utf-8',
            'Content-Disposition': `attachment; filename="${id}.sgf"`,
            ...CORS,
          });
          res.end(rec.sgf || '');
          return;
        }
        sendJson(res, 200, rec);
        return;
      }

      if (url.pathname === '/api/lobby') {
        sendJson(res, 200, {
          online: onlineUsers.size,
          leaderboard: getLeaderboard(10),
          recent: getRecentGames(12),
        });
        return;
      }

      sendJson(res, 404, { error: 'unknown endpoint' });
      return;
    }

    serveStatic(url.pathname, res);
  } catch (e) {
    console.error('[http] 请求处理异常:', e);
    if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
  }
});

/* ------------------------------ WebSocket ------------------------------ */

const wss = new WebSocketServer({
  server,
  path: '/ws',
  // 免费容器只有 0.5 CPU，压缩的 CPU 开销大于省下的带宽
  perMessageDeflate: false,
  maxPayload: 64 * 1024,
});

const send = (ws, payload) => {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(payload));
};

function broadcastLobby() {
  const payload = {
    type: 'lobby',
    online: onlineUsers.size,
    queues: Object.fromEntries([...queues].map(([k, v]) => [k, v.length])),
    leaderboard: getLeaderboard(10),
    recent: getRecentGames(12),
    players: [...onlineUsers.values()].map(({ userId, ws }) => {
      const rid = userRoom.get(userId);
      const r = rid ? rooms.get(rid) : null;
      return {
        id: userId,
        nickname: ws.nickname || '匿名棋士',
        inGame: !!r && r.phase !== 'finished',
      };
    }),
  };
  for (const { ws } of onlineUsers.values()) send(ws, payload);
}

function broadcastState(room) {
  for (const color of ['black', 'white']) {
    const p = room.players[color];
    if (!p || p.id === BOT_ID) continue;
    const entry = onlineUsers.get(p.id);
    if (!entry) continue;
    send(entry.ws, { type: 'state', you: color, game: room.snapshot() });
  }
}

function newGameId() {
  return 'g' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
}

function startGame(p1, p2, size, { vsBot = false } = {}) {
  const id = newGameId();
  const blackFirst = Math.random() < 0.5;
  const a = { id: p1.userId, nickname: p1.nickname };
  const b = { id: p2.userId, nickname: p2.nickname };
  const black = blackFirst ? a : b;
  const white = blackFirst ? b : a;

  const room = new GameRoom({ id, size, komi: 7.5, black, white });
  room.vsBot = vsBot;

  room.onMove = (r, move) => {
    recordMoveRow(r.id, move.seq, move.color, move.x, move.y, move.pass, move.captured);
    broadcastState(r);
    if (r.vsBot) {
      if (r.phase === 'scoring') {
        setTimeout(() => {
          if (r.phase === 'scoring') {
            r.confirmScore(BOT_ID);
            broadcastState(r);
          }
        }, 900);
      } else {
        scheduleBotMove(r);
      }
    }
  };

  room.onFinish = (r, result) => {
    const blackWon = result.winner === 'black';
    finishGameRow({
      id: r.id,
      winner: result.winner,
      result: result.text,
      endReason: result.reason,
      movesCount: r.moves.length,
      blackScore: result.blackScore,
      whiteScore: result.whiteScore,
      sgf: r.sgf(),
    });
    if (!r.vsBot) applyResult(r.players.black.id, r.players.white.id, result.winner);
    broadcastState(r);
    for (const color of ['black', 'white']) {
      const p = r.players[color];
      if (p.id === BOT_ID) continue;
      const entry = onlineUsers.get(p.id);
      if (entry) send(entry.ws, { type: 'game_over', result, you: color });
    }
    userRoom.delete(r.players.black.id);
    userRoom.delete(r.players.white.id);
    setTimeout(() => rooms.delete(r.id), 10 * 60 * 1000);
    broadcastLobby();
  };

  rooms.set(id, room);
  createGameRow({
    id,
    size,
    komi: 7.5,
    blackId: black.id,
    blackName: black.nickname,
    whiteId: white.id,
    whiteName: white.nickname,
    startedAt: Date.now(),
  });
  if (!vsBot) {
    userRoom.set(black.id, id);
    userRoom.set(white.id, id);
  } else {
    userRoom.set(black.id === BOT_ID ? white.id : black.id, id);
  }

  broadcastState(room);
  broadcastLobby();
  if (vsBot) scheduleBotMove(room);
  return room;
}

function scheduleBotMove(room) {
  if (!room.vsBot || room.phase !== 'playing') return;
  const botColor = room.players.black.id === BOT_ID ? 'black' : 'white';
  const botStone = botColor === 'black' ? 1 : 2;
  if (room.toPlay !== botStone) return;

  setTimeout(() => {
    if (room.phase !== 'playing') return;
    if (room.toPlay !== botStone) return;
    // 对方虚手表示愿意终局，AI 跟随虚手进入点目
    if (room.passes >= 1) {
      room.pass(BOT_ID);
      return;
    }
    const point = chooseMove(room, botColor);
    if (point == null) {
      room.pass(BOT_ID);
      return;
    }
    const x = point % room.size;
    const y = (point - x) / room.size;
    const res = room.play(BOT_ID, x, y);
    if (!res.ok) room.pass(BOT_ID);
  }, 500 + Math.random() * 500);
}

function tryMatch(size) {
  const q = queues.get(size) || [];
  while (q.length >= 2) {
    const a = q.shift();
    const b = q.find((p) => p.userId !== a.userId);
    if (!b) {
      q.unshift(a);
      break;
    }
    q.splice(q.indexOf(b), 1);
    startGame(a, b, size);
  }
  queues.set(size, q);
}

function removeFromQueues(userId) {
  for (const [size, q] of queues) {
    const i = q.findIndex((p) => p.userId === userId);
    if (i >= 0) q.splice(i, 1);
    queues.set(size, q);
  }
}

function handleLogin(ws, msg) {
  const nickname = String(msg.nickname || '').trim().slice(0, 16) || '匿名棋士';
  const userId = String(msg.userId || '').trim() || 'u' + crypto.randomBytes(8).toString('hex');

  const prev = onlineUsers.get(userId);
  if (prev && prev.ws !== ws) {
    try {
      prev.ws.close(4000, '账号已在别处登录');
    } catch {}
  }

  upsertUser(userId, nickname);
  const user = getUser(userId);
  onlineUsers.set(userId, { ws, userId });
  ws.userId = userId;
  ws.nickname = nickname;

  // 断线重连：回到进行中的对局
  const gameId = userRoom.get(userId);
  if (gameId && rooms.has(gameId)) {
    const room = rooms.get(gameId);
    if (room.phase !== 'finished') {
      const color = room.colorOf(userId);
      if (color) {
        room.disconnected.delete(color);
        const t = graceTimers.get(userId);
        if (t) {
          clearTimeout(t);
          graceTimers.delete(userId);
        }
        broadcastLobby();
        send(ws, {
          type: 'logged_in',
          user: { id: user.id, nickname: user.nickname, wins: user.wins, losses: user.losses, rating: user.rating },
          resumed: true,
        });
        send(ws, { type: 'state', you: color, game: room.snapshot() });
        broadcastState(room);
        return;
      }
    }
  }

  // 先推送大厅数据，再确认登录，保证前端首帧即拿到在线人数与榜单
  broadcastLobby();
  send(ws, {
    type: 'logged_in',
    user: { id: user.id, nickname: user.nickname, wins: user.wins, losses: user.losses, rating: user.rating },
    resumed: false,
  });
}

function handleMessage(ws, raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  const userId = ws.userId;

  if (msg.type === 'login') return handleLogin(ws, msg);
  if (!userId) return send(ws, { type: 'error', message: '请先登录' });

  const roomId = userRoom.get(userId);
  const room = roomId ? rooms.get(roomId) : null;

  switch (msg.type) {
    case 'queue': {
      const size = [9, 13, 19].includes(msg.size) ? msg.size : 19;
      if (room && room.phase !== 'finished') return send(ws, { type: 'error', message: '你正在对局中' });
      removeFromQueues(userId);
      queues.get(size).push({ userId, nickname: ws.nickname });
      send(ws, { type: 'queued', size, position: queues.get(size).length });
      tryMatch(size);
      broadcastLobby();
      return;
    }
    case 'cancel_queue': {
      removeFromQueues(userId);
      send(ws, { type: 'queue_cancelled' });
      broadcastLobby();
      return;
    }
    case 'practice': {
      const size = [9, 13, 19].includes(msg.size) ? msg.size : 19;
      if (room && room.phase !== 'finished') return send(ws, { type: 'error', message: '你正在对局中' });
      removeFromQueues(userId);
      startGame(
        { userId, nickname: ws.nickname },
        { userId: BOT_ID, nickname: 'AI 陪练' },
        size,
        { vsBot: true }
      );
      return;
    }
    case 'move': {
      if (!room) return send(ws, { type: 'error', message: '当前没有对局' });
      const res = room.play(userId, Number(msg.x), Number(msg.y));
      if (!res.ok) send(ws, { type: 'error', message: res.error });
      return;
    }
    case 'pass': {
      if (!room) return send(ws, { type: 'error', message: '当前没有对局' });
      const res = room.pass(userId);
      if (!res.ok) send(ws, { type: 'error', message: res.error });
      else broadcastState(room);
      return;
    }
    case 'resign': {
      if (!room) return send(ws, { type: 'error', message: '当前没有对局' });
      const res = room.resign(userId);
      if (!res.ok) send(ws, { type: 'error', message: res.error });
      return;
    }
    case 'mark_dead': {
      if (!room) return;
      const res = room.toggleDead(userId, Number(msg.point));
      if (!res.ok) send(ws, { type: 'error', message: res.error });
      else broadcastState(room);
      return;
    }
    case 'confirm_score': {
      if (!room) return;
      const res = room.confirmScore(userId);
      if (!res.ok) send(ws, { type: 'error', message: res.error });
      else broadcastState(room);
      return;
    }
    case 'resume': {
      if (!room) return;
      const res = room.resumePlay(userId);
      if (!res.ok) send(ws, { type: 'error', message: res.error });
      else broadcastState(room);
      return;
    }
    case 'chat': {
      if (!room) return;
      const text = String(msg.text || '').slice(0, 200);
      if (!text.trim()) return;
      for (const color of ['black', 'white']) {
        const p = room.players[color];
        if (p.id === BOT_ID) continue;
        const entry = onlineUsers.get(p.id);
        if (entry) send(entry.ws, { type: 'chat', from: ws.nickname, color, text });
      }
      return;
    }
    case 'my_games': {
      send(ws, { type: 'my_games', games: getUserGames(userId, 10) });
      return;
    }
    default:
      return;
  }
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });
  // 单条消息异常不得影响其他连接与进程存活
  ws.on('message', (raw) => {
    try {
      handleMessage(ws, raw.toString());
    } catch (e) {
      console.error('[ws] 消息处理异常:', e);
      try {
        send(ws, { type: 'error', message: '服务端处理异常，请重试' });
      } catch {}
    }
  });
  ws.on('error', (e) => console.error('[ws] 连接异常:', e.message));
  ws.on('close', () => {
    try {
      const userId = ws.userId;
      if (!userId) return;
      if (onlineUsers.get(userId)?.ws === ws) onlineUsers.delete(userId);
      removeFromQueues(userId);
      touchUser(userId);

      const gameId = userRoom.get(userId);
      const room = gameId ? rooms.get(gameId) : null;
      if (room && room.phase !== 'finished') {
        const color = room.colorOf(userId);
        if (color) {
          room.disconnected.add(color);
          broadcastState(room);
          const timer = setTimeout(() => {
            graceTimers.delete(userId);
            if (!onlineUsers.has(userId) && room.phase !== 'finished') {
              room.forfeitByDisconnect(color);
            }
          }, DISCONNECT_GRACE_MS);
          graceTimers.set(userId, timer);
        }
      }
      broadcastLobby();
    } catch (e) {
      console.error('[ws] 断开清理异常:', e);
    }
  });
});

// 心跳 + 计时
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {}
  }
}, 30_000);

const ticker = setInterval(() => {
  // 无对局时直接跳过，避免空转（休眠/低配环境下尤为重要）
  if (rooms.size === 0) return;
  for (const room of rooms.values()) {
    try {
      if (room.phase === 'playing') {
        room.tick(1);
        broadcastState(room);
      }
    } catch (e) {
      console.error('[tick] 对局推进异常:', room.id, e);
    }
  }
}, 1000);

wss.on('close', () => {
  clearInterval(heartbeat);
  clearInterval(ticker);
});

// 兜底：任何漏网异常只记录，不让整局服务退出
process.on('uncaughtException', (e) => console.error('[fatal] 未捕获异常:', e));
process.on('unhandledRejection', (e) => console.error('[fatal] 未处理 Promise 拒绝:', e));

// 启动自检：对局状态只存在于内存，容器休眠/重启后必然丢失，
// 数据库里遗留的 ended_at IS NULL 行需要统一标记为中断，否则大厅会显示打不完的对局。
try {
  const swept = sweepUnfinishedGames();
  if (swept > 0) console.log(`[boot] 已清理 ${swept} 局上次进程遗留的未结束对局`);
} catch (e) {
  console.error('[boot] 僵尸对局清理失败:', e.message);
}

server.listen(PORT, HOST, () => {
  const info = dbInfo();
  console.log(`\n  在线围棋服务已启动`);
  console.log(`  → 本机访问: http://localhost:${PORT}`);
  console.log(`  → 局域网对战: http://<本机IP>:${PORT}`);
  console.log(`  → WebSocket: ws://<本机IP>:${PORT}/ws`);
  console.log(`  → 健康检查: /healthz`);
  console.log(`  → 数据库: ${info.file}（${(info.sizeBytes / 1024).toFixed(1)} KB，${info.journalMode}）\n`);
});

/* ------------------------------ 优雅关闭 ------------------------------ */
// 托管平台在休眠、重启、重新部署前会发 SIGTERM；必须先把 WAL 合并回主库再断开，
// 否则容器被强杀时最近写入可能丢失。
let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] 收到 ${signal}，开始关闭`);
  clearInterval(heartbeat);
  clearInterval(ticker);
  for (const t of graceTimers.values()) clearTimeout(t);
  graceTimers.clear();
  for (const ws of wss.clients) {
    try {
      ws.close(1001, '服务重启中，请稍候重连');
    } catch {}
  }
  try {
    closeDb();
  } catch (e) {
    console.error('[shutdown] 关闭数据库异常:', e.message);
  }
  try {
    wss.close();
  } catch {}
  server.close(() => {
    console.log('[shutdown] 已安全退出');
    process.exit(0);
  });
  // 兜底：长连接未及时释放也不阻塞平台重启
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
