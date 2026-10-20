/**
 * 解析运行时配置（来自 /config.js），把 WebSocket 与 HTTP 接口地址
 * 从「构建期写死」改为「部署期可改」。
 */
const cfg = (typeof window !== 'undefined' && window.__GO_CONFIG__) || {};

function normalizeWs(value) {
  const raw = String(value || '').trim();
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  if (!raw) return `${proto}://${location.host}/ws`;
  if (/^wss?:\/\//i.test(raw)) return raw;
  if (raw.startsWith('/')) return `${proto}://${location.host}${raw}`;
  return raw;
}

export const WS_URL = normalizeWs(cfg.wsUrl);
export const API_BASE = String(cfg.apiBase || '').replace(/\/+$/, '');
export const WS_SOURCE = String(cfg.wsUrl || '').trim() ? 'config.js' : '同源默认';

/** 拼接 HTTP 接口地址，兼容静态托管跨域访问 Node 服务 */
export function apiUrl(path) {
  return API_BASE ? `${API_BASE}${path}` : path;
}

/** 给用户看的连接诊断信息 */
export function connHints(url) {
  const hints = [];
  const httpsPage = location.protocol === 'https:';
  const isLocalHost = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);

  if (httpsPage && url.startsWith('ws://')) {
    hints.push('当前页面是 HTTPS，浏览器会拦截 ws:// 明文连接，必须改为 wss://。');
  }
  if (!isLocalHost && /(^|\/\/)(localhost|127\.0\.0\.1)/.test(url)) {
    hints.push('远端页面无法连到访问者自己的 localhost，请把 wsUrl 改成服务器实际 IP 或域名。');
  }
  hints.push('纯静态托管（Nginx / OSS / Vercel / GitHub Pages 等）本身没有 WebSocket 能力，必须另起 Node 服务并在 config.js 里把 wsUrl 指向它。');
  hints.push('若 Node 服务与页面同域，可用 Nginx 把 /ws 反代到 127.0.0.1:8080。');
  return hints;
}
