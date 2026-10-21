/**
 * SQLite 持久层 —— 使用 Node 内置 node:sqlite（无原生编译依赖）
 * 数据文件：data/go.db
 *
 * 容错设计：数据库文件被外部删除 / 替换时连接会失效（SQLITE_ERROR: locking protocol）。
 * 此处对每次访问做「失败即重建连接并重试一次」的兜底，避免单次查询异常拖垮整个服务。
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
export const DB_FILE = process.env.GO_DB || path.join(DATA_DIR, 'go.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  nickname    TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL,
  wins        INTEGER NOT NULL DEFAULT 0,
  losses      INTEGER NOT NULL DEFAULT 0,
  rating      INTEGER NOT NULL DEFAULT 1000,
  games       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS games (
  id          TEXT PRIMARY KEY,
  size        INTEGER NOT NULL,
  komi        REAL NOT NULL,
  black_id    TEXT,
  black_name  TEXT,
  white_id    TEXT,
  white_name  TEXT,
  winner      TEXT,
  result      TEXT,
  end_reason  TEXT,
  moves_count INTEGER NOT NULL DEFAULT 0,
  black_score REAL,
  white_score REAL,
  sgf         TEXT,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER
);

CREATE TABLE IF NOT EXISTS moves (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id   TEXT NOT NULL,
  seq       INTEGER NOT NULL,
  color     INTEGER NOT NULL,
  x         INTEGER,
  y         INTEGER,
  pass      INTEGER NOT NULL DEFAULT 0,
  captured  INTEGER NOT NULL DEFAULT 0,
  played_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_moves_game ON moves(game_id, seq);
CREATE INDEX IF NOT EXISTS idx_games_ended ON games(ended_at DESC);
`;

/** @type {DatabaseSync | null} */
let db = null;
/** 预编译语句表：重建连接后就地刷新，外部引用始终有效 */
const stmt = {};

function prepareStatements() {
  Object.assign(stmt, {
    getUser: db.prepare('SELECT * FROM users WHERE id = ?'),
    insertUser: db.prepare(
      'INSERT INTO users (id, nickname, created_at, last_seen) VALUES (?, ?, ?, ?)'
    ),
    updateNick: db.prepare('UPDATE users SET nickname = ?, last_seen = ? WHERE id = ?'),
    touch: db.prepare('UPDATE users SET last_seen = ? WHERE id = ?'),
    leaderboard: db.prepare(
      `SELECT id, nickname, wins, losses, games, rating FROM users
       WHERE games > 0 ORDER BY rating DESC, wins DESC LIMIT ?`
    ),
    createGame: db.prepare(
      `INSERT INTO games (id, size, komi, black_id, black_name, white_id, white_name, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ),
    insertMove: db.prepare(
      `INSERT INTO moves (game_id, seq, color, x, y, pass, captured, played_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ),
    finishGame: db.prepare(
      `UPDATE games SET winner = ?, result = ?, end_reason = ?, moves_count = ?,
       black_score = ?, white_score = ?, sgf = ?, ended_at = ? WHERE id = ?`
    ),
    bumpUser: db.prepare(
      `UPDATE users SET games = games + 1,
         wins = wins + CASE WHEN ? = 1 THEN 1 ELSE 0 END,
         losses = losses + CASE WHEN ? = 1 THEN 1 ELSE 0 END,
         rating = rating + ? WHERE id = ?`
    ),
    recentGames: db.prepare(
      `SELECT id, size, black_name, white_name, winner, result, end_reason, moves_count, ended_at
       FROM games WHERE ended_at IS NOT NULL ORDER BY ended_at DESC LIMIT ?`
    ),
    gameById: db.prepare('SELECT * FROM games WHERE id = ?'),
    movesByGame: db.prepare('SELECT seq, color, x, y, pass FROM moves WHERE game_id = ? ORDER BY seq'),
    userGames: db.prepare(
      `SELECT id, size, black_name, white_name, winner, result, ended_at FROM games
       WHERE (black_id = ? OR white_id = ?) AND ended_at IS NOT NULL
       ORDER BY ended_at DESC LIMIT ?`
    ),
    countUsers: db.prepare('SELECT COUNT(*) AS n FROM users'),
    sweepUnfinished: db.prepare(
      `UPDATE games SET ended_at = ?, end_reason = 'interrupted',
         result = COALESCE(result, '服务重启，对局中断')
       WHERE ended_at IS NULL`
    ),
  });
}

/**
 * 容器/托管平台（如 Bonto）的文件系统可能不支持 WAL 或为网络盘，
 * 因此 WAL 失败时降级为 DELETE 日志模式，而不是让整个服务起不来。
 */
function applyPragmas() {
  try {
    db.exec('PRAGMA busy_timeout = 5000');
  } catch {}
  let mode = 'unknown';
  try {
    const row = db.prepare('PRAGMA journal_mode = WAL').get();
    mode = row?.journal_mode || 'wal';
  } catch (e) {
    console.warn('[db] WAL 不可用，降级为 DELETE 模式：', e.message);
    try {
      db.exec('PRAGMA journal_mode = DELETE');
      mode = 'delete';
    } catch {}
  }
  try {
    db.exec('PRAGMA synchronous = NORMAL');
  } catch {}
  return mode;
}

let journalMode = 'unknown';

function open() {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  db = new DatabaseSync(DB_FILE);
  journalMode = applyPragmas();
  db.exec(SCHEMA);
  prepareStatements();
}

export function reinitDb(reason = '') {
  if (reason) console.warn(`[db] 重建连接：${reason}`);
  try {
    db?.close();
  } catch {}
  db = null;
  open();
}

open();

/** 仅这些错误码代表「连接/文件层面失效」，才值得重建连接重试 */
const CONN_ERROR_CODES = new Set([
  10, // SQLITE_IOERR
  11, // SQLITE_CORRUPT
  14, // SQLITE_CANTOPEN
  15, // SQLITE_PROTOCOL（句柄失效时典型报错：locking protocol）
  26, // SQLITE_NOTADB
]);

/** 执行一次数据库操作；连接类错误自动重建并重试一次 */
function withDb(fn) {
  try {
    return fn();
  } catch (e) {
    const retriable =
      CONN_ERROR_CODES.has(e?.errcode) ||
      /locking protocol|not a database|disk image|unable to open|database is locked/i.test(
        e?.message || ''
      );
    if (!retriable) throw e;
    reinitDb(e.message);
    return fn();
  }
}

const now = () => Date.now();

/* --------------------------------- 导出接口 -------------------------------- */

export function getUser(id) {
  return withDb(() => stmt.getUser.get(id));
}

export function upsertUser(id, nickname) {
  return withDb(() => {
    const existing = stmt.getUser.get(id);
    const t = now();
    if (existing) {
      if (existing.nickname !== nickname) stmt.updateNick.run(nickname, t, id);
      else stmt.touch.run(t, id);
      return stmt.getUser.get(id);
    }
    stmt.insertUser.run(id, nickname, t, t);
    return stmt.getUser.get(id);
  });
}

export function touchUser(id) {
  withDb(() => stmt.touch.run(now(), id));
}

export function getLeaderboard(limit = 10) {
  return withDb(() => stmt.leaderboard.all(limit));
}

export function createGameRow(g) {
  withDb(() =>
    stmt.createGame.run(
      g.id, g.size, g.komi, g.blackId, g.blackName, g.whiteId, g.whiteName, g.startedAt
    )
  );
}

export function recordMoveRow(gameId, seq, color, x, y, pass, captured) {
  withDb(() =>
    stmt.insertMove.run(gameId, seq, color, x ?? null, y ?? null, pass ? 1 : 0, captured, now())
  );
}

export function finishGameRow(g) {
  withDb(() =>
    stmt.finishGame.run(
      g.winner, g.result, g.endReason, g.movesCount,
      g.blackScore ?? null, g.whiteScore ?? null, g.sgf, now(), g.id
    )
  );
}

/** Elo 简化版：胜 +K，负 -K，按双方分差调整 */
export function applyResult(blackId, whiteId, winnerColor) {
  const b = getUser(blackId);
  const w = getUser(whiteId);
  if (!b || !w) return;
  const K = 24;
  const expectB = 1 / (1 + 10 ** ((w.rating - b.rating) / 400));
  const scoreB = winnerColor === 'black' ? 1 : winnerColor === 'white' ? 0 : 0.5;
  const deltaB = Math.round(K * (scoreB - expectB));
  withDb(() => {
    stmt.bumpUser.run(scoreB === 1 ? 1 : 0, scoreB === 0 ? 1 : 0, deltaB, blackId);
    stmt.bumpUser.run(scoreB === 0 ? 1 : 0, scoreB === 1 ? 1 : 0, -deltaB, whiteId);
  });
}

export function getRecentGames(limit = 12) {
  return withDb(() => stmt.recentGames.all(limit));
}

export function getGameRecord(id) {
  return withDb(() => {
    const game = stmt.gameById.get(id);
    if (!game) return null;
    return { ...game, moves: stmt.movesByGame.all(id) };
  });
}

export function getUserGames(userId, limit = 10) {
  return withDb(() => stmt.userGames.all(userId, userId, limit));
}

export function totalUsers() {
  return withDb(() => stmt.countUsers.get().n);
}

/**
 * 进程启动时清理「僵尸对局」。
 * 对局状态（rooms / userRoom）只存在于内存，容器休眠、重启或崩溃后必然丢失，
 * 但数据库里的 games 行仍会是 ended_at IS NULL。这里统一标记为中断，
 * 避免大厅/战绩里出现永远打不完的对局。
 * @returns {number} 被清理的行数
 */
export function sweepUnfinishedGames() {
  return withDb(() => {
    const r = stmt.sweepUnfinished.run(now());
    return Number(r.changes || 0);
  });
}

/** 健康检查与运维诊断用的数据库信息 */
export function dbInfo() {
  let size = 0;
  let walSize = 0;
  try {
    size = fs.statSync(DB_FILE).size;
  } catch {}
  try {
    walSize = fs.statSync(`${DB_FILE}-wal`).size;
  } catch {}
  return {
    file: DB_FILE,
    sizeBytes: size,
    walBytes: walSize,
    journalMode,
    users: safeCount(),
  };
}

function safeCount() {
  try {
    return withDb(() => stmt.countUsers.get().n);
  } catch {
    return null;
  }
}

/**
 * 优雅关闭：托管平台在休眠/重启前会发 SIGTERM，
 * 必须先把 WAL 合并回主库再断开，否则容器被强杀可能丢失最近写入。
 */
export function closeDb() {
  if (!db) return;
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch {}
  try {
    db.close();
  } catch {}
  db = null;
}

/** 健康检查：能读即视为正常 */
export function dbPing() {
  try {
    withDb(() => stmt.countUsers.get());
    return true;
  } catch {
    return false;
  }
}
