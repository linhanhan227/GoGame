/**
 * 构建指纹：用「源码内容哈希」而不是时间戳判断 dist 是否过期。
 *
 * 为什么不用 mtime：git checkout / 平台文件同步都不保留原始时间戳，
 * 检出后源码看起来可能比 dist 新，会触发一次无意义的构建。
 * 内容哈希在同样内容下恒定，换机器、重新检出都不会误判。
 *
 * 用法：
 *   node scripts/build-info.js        # 构建后写入 dist/build-info.json
 *   import { computeFingerprint }     # 启动时比对
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(__dirname, '..');
export const DIST = path.join(ROOT, 'dist');
export const STAMP = path.join(DIST, 'build-info.json');

/** 参与指纹计算的源码位置（影响前端产物的全部输入） */
export const SOURCE_DIRS = ['client/src', 'shared'];
export const SOURCE_FILES = [
  'client/index.html',
  'client/vite.config.js',
  'client/public/config.js',
];

const SKIP_EXT = new Set(['.map']);

function walk(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (!SKIP_EXT.has(path.extname(e.name))) out.push(full);
  }
}

function sourceFiles() {
  const files = [];
  for (const d of SOURCE_DIRS) walk(path.join(ROOT, d), files);
  for (const f of SOURCE_FILES) {
    const full = path.join(ROOT, f);
    if (fs.existsSync(full)) files.push(full);
  }
  // 路径排序，保证跨平台/跨文件系统顺序一致
  return files.map((f) => path.relative(ROOT, f).replace(/\\/g, '/')).sort();
}

/** 源码内容指纹（sha1 前 16 位，足够区分一次改动） */
export function computeFingerprint() {
  const h = crypto.createHash('sha1');
  for (const rel of sourceFiles()) {
    h.update(rel);
    h.update('\0');
    try {
      h.update(fs.readFileSync(path.join(ROOT, rel)));
    } catch {
      h.update('!missing');
    }
    h.update('\0');
  }
  return h.digest('hex').slice(0, 16);
}

export function readStamp() {
  try {
    return JSON.parse(fs.readFileSync(STAMP, 'utf8'));
  } catch {
    return null;
  }
}

export function writeBuildInfo(extra = {}) {
  const info = {
    fingerprint: computeFingerprint(),
    builtAt: new Date().toISOString(),
    node: process.version,
    ...extra,
  };
  try {
    fs.mkdirSync(DIST, { recursive: true });
    fs.writeFileSync(STAMP, JSON.stringify(info, null, 2));
  } catch (e) {
    console.warn('[build-info] 写入指纹失败:', e.message);
  }
  return info;
}

/** 直接执行时：构建完成后调用 */
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const info = writeBuildInfo();
  console.log(`[build-info] 已记录源码指纹 ${info.fingerprint}`);
}
