/**
 * 启动引导（Bonto 等「只执行 npm start、没有自定义构建步骤」的托管平台专用）
 *
 * 这类平台只会跑 `npm start`，不会替我们执行 `npm run build`。因此：
 *   1. dist/ 缺失        → 现场构建
 *   2. 源码内容与指纹不符 → 现场构建（平台上保存文件会重启进程，正好触发重建）
 *   3. 构建失败但已有 dist → 用旧产物继续跑，避免整站不可用
 *
 * 过期判定用「源码内容指纹」而非时间戳：git checkout / 平台文件同步不保留 mtime，
 * 用时间戳会在每次检出后误触发一次构建。
 *
 * 环境变量：
 *   SKIP_BUILD=1   跳过构建检查，直接用现有 dist（启动最快，适合产物已提交的场景）
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, DIST, computeFingerprint, readStamp, writeBuildInfo } from './build-info.js';

const ENTRY = path.join(DIST, 'index.html');

function needsBuild() {
  if (process.env.SKIP_BUILD === '1') return false;
  if (!fs.existsSync(ENTRY)) return true;
  const stamp = readStamp();
  if (!stamp?.fingerprint) return true; // 首次启用指纹机制，重建一次
  return stamp.fingerprint !== computeFingerprint();
}

function build(extraArgs = []) {
  const viteBin = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  if (!fs.existsSync(viteBin)) {
    console.error('[boot] 未找到 vite，无法构建。请先执行 npm install（含 devDependencies）。');
    return false;
  }
  const started = Date.now();
  const r = spawnSync(
    process.execPath,
    [viteBin, 'build', '--config', 'client/vite.config.js', ...extraArgs],
    { cwd: ROOT, stdio: 'inherit', env: process.env }
  );
  if (r.status === 0) {
    console.log(`[boot] 前端构建完成，耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
    return true;
  }
  console.error(`[boot] 前端构建失败（exit ${r.status ?? r.signal}）`);
  return false;
}

if (needsBuild()) {
  console.log('[boot] 构建产物缺失或已过期，开始构建前端…');
  // 清理 outDir 在部分受限文件系统上会失败；此时退回「不清理、直接覆盖」再试一次。
  // 代价是残留旧的 hash 资源文件（体积很小），收益是构建不会因为删不掉目录而整体失败。
  let okBuild = build();
  if (!okBuild && fs.existsSync(ENTRY)) {
    console.warn('[boot] 清理产物目录失败，改为覆盖式构建重试…');
    okBuild = build(['--no-emptyOutDir']);
  }
  if (!okBuild && !fs.existsSync(ENTRY)) {
    console.error('[boot] 无可用 dist，进程退出。请检查构建日志或改用 `npm run build` 预构建。');
    process.exit(1);
  }
  if (okBuild) writeBuildInfo({ builtBy: 'boot' });
  else console.warn('[boot] 构建失败，继续使用现有 dist（可能不是最新前端）。');
}

console.log(
  `[boot] Node ${process.version} · PORT=${process.env.PORT || 8080} · ` +
    `NODE_ENV=${process.env.NODE_ENV || 'development'} · 数据库=${process.env.GO_DB || 'data/go.db'}`
);

await import('../server/index.js');
