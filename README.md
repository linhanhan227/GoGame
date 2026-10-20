# 弈 · 在线围棋

基于 **React** 的在线围棋对战系统，数据落在**本地 SQLite** 文件库，前端是**纯静态构建产物**，对局与匹配通过 Node 服务（WebSocket）完成。整套系统零云依赖，可离线运行，也可在局域网内多人对战。

---

## 1. 快速开始

```bash
npm install
npm run build
npm start            # http://localhost:8080
```

Windows 用户可直接双击 `start.bat`（自动装依赖、构建、开浏览器）。

局域网对战：其他设备访问 `http://<本机IP>:8080` 即可进入同一棋室并自动匹配。

开发模式：

```bash
node server/index.js      # 终端 1：后端（8080）
npm run dev:client        # 终端 2：Vite（5173，/ws 与 /api 已代理）
```

环境变量：`PORT`（默认 8080）、`HOST`（默认 0.0.0.0）、`GO_DB`（默认 `data/go.db`）。

---

## 2. 为什么需要 Node 进程

浏览器里的纯静态页面没有共享状态，两个不同用户无法互相匹配——匹配必然需要一个中转进程。本项目的形态：

| 层 | 实现 | 性质 |
| --- | --- | --- |
| 前端 | React 18 + Vite，构建为 `dist/` | 纯静态资源，可托管在任意静态服务器 |
| 服务 | 单 Node 进程：静态托管 + WebSocket 撮合 | 无外部依赖、无云服务 |
| 数据 | SQLite 文件 `data/go.db` | 本地文件 |

**结论：静态站点可以托管前端，但 WebSocket 必须另有一个 Node 进程。** 下面第 3 节给出三种部署组合。

---

## 3. 部署形态（静态托管 + WebSocket）

前端连接地址由 `dist/config.js` 在**运行时**决定，改这个文件即可，**无需重新构建**。
（该文件由 `client/public/config.js` 在构建时复制生成；若希望配置进版本库，请改源文件后重新 `npm run build`。注意 `.gitignore` 默认忽略 `dist/`。）

```js
window.__GO_CONFIG__ = {
  wsUrl: '',    // '' = 同源 /ws；也可填 'ws://192.168.1.10:8080/ws' 或 '/ws'
  apiBase: '',  // '' = 同源；静态站点跨域访问 Node 的 HTTP 接口时填写
};
```

### A. 一体化部署（推荐，零配置）

Node 同时托管 `dist` 与 WebSocket，页面与 `/ws` 同源，`config.js` 保持默认即可。

### B. 静态站点 + 独立 Node 服务（跨域）

1. 把 `dist/` 整个目录上传到任意静态托管（Nginx / OSS / Vercel / GitHub Pages…）
2. 在能长期运行的机器上执行 `npm start`（默认监听 `0.0.0.0:8080`）
3. 修改静态站点上的 `config.js`：

```js
window.__GO_CONFIG__ = {
  wsUrl: 'ws://192.168.1.10:8080/ws',
  apiBase: 'http://192.168.1.10:8080',
};
```

> 静态托管页面的地址不能写 `localhost`——那指向访问者自己的电脑。
> 若页面是 HTTPS，`ws://` 会被浏览器按混合内容直接拦截，必须用 `wss://`（Node 侧需配证书或前置 TLS 代理）。

### C. 静态站点 + Nginx 反代（同域，最省事）

```nginx
server {
    listen 80;
    server_name go.example.com;
    root /var/www/go;          # dist 目录内容
    index index.html;

    location /ws {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
    }
}
```

此时 `config.js` 保持 `wsUrl: ''`（同源 `/ws`）即可。

### 连接失败时的排查

连接不上时页面顶部会出现**诊断横幅**，直接显示实际连接地址、重试次数与失败原因，无需翻控制台。对照下表：

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 一直「已断开 / 正在重连」 | 静态托管没有 WebSocket 端点 | 按 B 或 C 配置 `wsUrl` / 反向代理 |
| 控制台 `Mixed Content` 报错 | HTTPS 页面连了 `ws://` | 改用 `wss://`，或让页面走 http |
| `WebSocket connection failed` | Node 未启动 / 端口未放行 | `curl http://<ip>:8080/api/health` 自检、检查防火墙 |
| 能连上但大厅无数据 | 连到了别的 WS 服务 | 确认 `wsUrl` 路径是 `/ws` |
| 远端访问提示连 localhost | `wsUrl` 写了 localhost | 改成服务器实际 IP 或域名 |
| 对局中频繁掉线 | 反向代理超时过短 | `proxy_read_timeout` 调到 3600s |

自检接口：`GET /api/health` 返回 `{ ok, db, online, rooms, users, uptime }`，`db:false` 说明数据库不可用。

---

## 4. 功能

- **自动匹配**：按棋盘规格排队，两人到齐立即开局，黑白随机
- **三种规格**：9 / 13 / 19 路，包干计时（5 / 8 / 10 分钟），超时判负
- **完整规则**：提子、禁自杀、简单劫、双方虚手后进入点目阶段
- **点目与数子**：点击死子标记归属，双方确认后按中国规则（数子法）自动计算胜负，贴目 7.5
- **实时同步**：落子、计时、聊天、断线状态全端同步
- **断线重连**：30 秒宽限，刷新页面自动回到原对局；超时判负
- **人机陪练**：单人也能验证系统，AI 开局按星位布局、中盘接触战
- **棋谱与战绩**：每手落库，终局生成 SGF 可下载，Elo 积分排行榜

---

## 5. 目录结构

```
在线围棋/
├── client/                        前端（React + Vite）
│   ├── index.html
│   ├── public/config.js           运行时配置（构建时复制到 dist 根目录）
│   └── src/
│       ├── App.jsx                顶栏 / 登录 / 连接诊断横幅
│       ├── lib/config.js          wsUrl / apiBase 解析
│       ├── lib/useGameSocket.js   WebSocket 状态机（自动重连、诊断信息）
│       ├── components/
│       │   ├── Board.jsx          SVG 棋盘（坐标、星位、最后一手、死子标记）
│       │   ├── Lobby.jsx          匹配、在线棋士、排行榜、最近对局
│       │   └── GameView.jsx       对局界面、计时、操作、聊天、终局结果
│       └── styles.css
├── server/
│   ├── index.js                   HTTP 静态托管 + WebSocket 撮合 + 异常隔离
│   ├── game.js                    对局状态机（落子/虚手/点目/计时/终局）
│   ├── db.js                      SQLite 读写（node:sqlite，连接失效自愈）
│   └── ai.js                      陪练 AI
├── shared/go-engine.js            规则引擎（前后端共用，纯函数）
├── tests/
│   ├── protocol.test.js           规则单测 + 端到端协议测试（28 项）
│   └── db.test.js                 持久层容错测试（4 项）
├── data/go.db                     SQLite 数据文件（自动创建）
└── dist/                          前端构建产物（含 config.js）
```

---

## 6. 规则实现要点

| 项 | 实现 |
| --- | --- |
| 提子 | 落子后检查四邻敌块气数，为 0 则整块移除 |
| 禁自杀 | 无提子且自身气为 0 → 判为禁着点 |
| 劫 | 仅提一子、己方成单子单气时记录劫点，下一手不可立即回提 |
| 终局 | 双方连续虚手 → 点目阶段 → 双方确认 → 数子 |
| 数子 | 子数 + 单方围空（中国规则），白方加贴目 7.5 |
| 计时 | 服务端 1 秒心跳扣减当前行棋方时间；对手断线期间暂停 |

---

## 7. WebSocket 协议

客户端 → 服务端：

```jsonc
{ "type": "login", "userId": "...", "nickname": "..." }
{ "type": "queue", "size": 19 }        // 加入匹配
{ "type": "cancel_queue" }
{ "type": "practice", "size": 9 }      // 人机练习
{ "type": "move", "x": 3, "y": 3 }
{ "type": "pass" } | { "type": "resign" }
{ "type": "mark_dead", "point": 42 }   // 点目阶段标记死子
{ "type": "confirm_score" } | { "type": "resume" }
{ "type": "chat", "text": "好棋" }
```

服务端 → 客户端：`logged_in`、`lobby`、`queued`、`state`（完整对局快照）、`game_over`、`chat`、`error`。

服务端为唯一权威：落子合法性、计时、胜负均以服务端判定为准，前端只做渲染与落子预览。

---

## 8. 数据库

`data/go.db`（WAL 模式），三张表：`users`（昵称/胜负/积分）、`games`（对局元信息、结果、SGF）、`moves`（每一手）。

```bash
node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('data/go.db');console.table(db.prepare('select id,nickname,wins,losses,rating from users order by rating desc limit 10').all())"
```

HTTP 接口：`/api/health`、`/api/lobby`、`/api/game/:id`、`/api/game/:id.sgf`（均带 CORS 头，可跨域调用）。

**容错**：数据库文件在运行期被删除或替换时，连接会失效（`SQLITE_ERROR: locking protocol`）。持久层对此做了一次「失败即重建连接并重试」的兜底；WebSocket 消息处理、计时循环、断开清理均有异常隔离，单个请求出错不会导致服务退出。

---

## 9. 测试

```bash
npm test
```

- `protocol.test.js`：提子、禁自杀、劫争、数子（含死子归属）、自动匹配、颜色分配、非法落子拒绝、非轮次拒绝、点目终局、数据落库、SGF 导出、人机应手 —— **28 项**
- `db.test.js`：连接重建、文件替换后自愈、非法参数不崩溃 —— **4 项**

---

## 10. 已知边界

- 简单劫而非全局同形禁止（三劫循环等罕见情形不判和）
- 数子假设双方已正确标记死子；未实现自动死活判断
- 匹配按棋盘规格排队，时限固定随规格（不支持自选时限）
- 无账号密码体系，身份为浏览器会话级 ID（同浏览器新标签页即新身份，便于本地多人测试）
- 计时为包干制，未实现读秒
- 进程内状态（对局、队列）不持久化：服务重启后进行中的对局丢失，已完成对局与棋谱仍在库中
