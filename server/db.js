/**
 * SQLite 持久层 —— 使用 Node 内置 node:sqlite（无原生编译依赖）
 * 数据文件：data/go.db
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = process.env.GO_DB || path.join(DATA_DIR, 'go.db');

fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

export const db = new DatabaseSync(DB_FILE);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA synchronous = NORMAL');

db.exec(`
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
`);

const now = () => Date.now();

const stmt = {
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
};

export function getUser(id) {
  return stmt.getUser.get(id);
}

export function upsertUser(id, nickname) {
  const existing = stmt.getUser.get(id);
  const t = now();
  if (existing) {
    if (existing.nickname !== nickname) stmt.updateNick.run(nickname, t, id);
    else stmt.touch.run(t, id);
    return stmt.getUser.get(id);
  }
  stmt.insertUser.run(id, nickname, t, t);
  return stmt.getUser.get(id);
}

export function touchUser(id) {
  stmt.touch.run(now(), id);
}

export function getLeaderboard(limit = 10) {
  return stmt.leaderboard.all(limit);
}

export function createGameRow(g) {
  stmt.createGame.run(
    g.id, g.size, g.komi, g.blackId, g.blackName, g.whiteId, g.whiteName, g.startedAt
  );
}

export function recordMoveRow(gameId, seq, color, x, y, pass, captured) {
  stmt.insertMove.run(gameId, seq, color, x ?? null, y ?? null, pass ? 1 : 0, captured, now());
}

export function finishGameRow(g) {
  stmt.finishGame.run(
    g.winner, g.result, g.endReason, g.movesCount,
    g.blackScore ?? null, g.whiteScore ?? null, g.sgf, now(), g.id
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
  stmt.bumpUser.run(scoreB === 1 ? 1 : 0, scoreB === 0 ? 1 : 0, deltaB, blackId);
  stmt.bumpUser.run(scoreB === 0 ? 1 : 0, scoreB === 1 ? 1 : 0, -deltaB, whiteId);
}

export function getRecentGames(limit = 12) {
  return stmt.recentGames.all(limit);
}

export function getGameRecord(id) {
  const game = stmt.gameById.get(id);
  if (!game) return null;
  return { ...game, moves: stmt.movesByGame.all(id) };
}

export function getUserGames(userId, limit = 10) {
  return stmt.userGames.all(userId, userId, limit);
}

export function totalUsers() {
  return stmt.countUsers.get().n;
}
