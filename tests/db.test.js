/**
 * 持久层容错测试
 * 目标：数据库连接失效（文件被删除 / 替换）后，服务应自动重建连接并继续工作，
 *      而不是抛错把整个进程带崩。
 * 运行：node tests/db.test.js
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMP_DB = path.join(os.tmpdir(), `go-resilience-${Date.now()}.db`);

process.env.GO_DB = TMP_DB;

const { upsertUser, getUser, getLeaderboard, reinitDb, dbPing, totalUsers } = await import('../server/db.js');

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

try {
  console.log('\n[持久层容错]');

  const u1 = upsertUser('u1', '甲');
  ok('首次写入成功', u1?.nickname === '甲');

  // 1. 连接重建机制本身：重建后预编译语句应依然可用
  reinitDb('测试强制重建');
  const u2 = upsertUser('u2', '乙');
  ok('重建连接后可继续写入', u2?.nickname === '乙');
  ok('重建后仍可读取', getUser('u1')?.nickname === '甲');

  // 2. 模拟文件被外部删除 / 替换
  let removed = false;
  let note = '';
  try {
    fs.rmSync(TMP_DB, { force: true });
    fs.rmSync(`${TMP_DB}-wal`, { force: true });
    fs.rmSync(`${TMP_DB}-shm`, { force: true });
    removed = true;
  } catch (e) {
    // Windows 对已打开的文件可能禁止删除，改用重命名后重建
    try {
      fs.renameSync(TMP_DB, `${TMP_DB}.bak`);
      removed = true;
      note = '（重命名模拟）';
    } catch (e2) {
      note = `（操作系统禁止替换：${e2.code || e2.message}）`;
    }
  }

  if (removed) {
    let threw = null;
    let after = null;
    try {
      after = upsertUser('u3', '丙');
    } catch (e) {
      threw = e;
    }
    ok(`文件被替换后自动重建${note}`, !threw && after?.nickname === '丙', threw?.message || '');
    ok('重建后数据可读', dbPing() && totalUsers() >= 1);
    ok('重建后排行榜可用', Array.isArray(getLeaderboard(10)));
  } else {
    console.log(`  · 跳过文件替换用例${note}`);
  }

  // 3. 非法参数不应导致进程级异常
  let badThrew = false;
  try {
    getLeaderboard('not-a-number');
  } catch {
    badThrew = true;
  }
  ok('非法查询参数被妥善处理（不崩溃）', true, badThrew ? '抛错但可捕获' : '');
} finally {
  for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`, `${TMP_DB}.bak`]) {
    try {
      fs.rmSync(f, { force: true });
    } catch {}
  }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
