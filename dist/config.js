/**
 * 运行时配置 —— 部署时直接修改本文件即可，无需重新构建前端。
 *
 * wsUrl:
 *   ''                                同源 /ws（Node 服务托管 dist 时用这个）
 *   'ws://192.168.1.10:8080/ws'       静态站点 + 局域网内 Node 服务
 *   'wss://go.example.com/ws'         HTTPS 页面必须用 wss（否则被浏览器按混合内容拦截）
 *   也可写相对路径 '/ws'，表示当前域名下的 /ws（配合 Nginx 反向代理）
 *
 *   托管平台（Bonto 等）属于「同源部署」：页面与 /ws 同一个域名，
 *   保持 '' 即可，前端会按 location.protocol 自动选择 ws / wss。
 *
 * apiBase:
 *   ''                                同源（默认）
 *   'http://192.168.1.10:8080'        静态站点跨域访问 Node 的 HTTP 接口（棋谱下载等）
 */
window.__GO_CONFIG__ = {
  wsUrl: '',
  apiBase: '',
};
