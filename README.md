# 弈 · 在线围棋

基于 **React** 的在线围棋对战系统，数据落在**本地 SQLite** 文件库，前端是**纯静态构建产物**，对局与匹配通过本机 Node 服务（WebSocket）完成。整套系统零云依赖，可离线运行，也可在局域网内多人对战。

---

## 1. 快速开始

```bash
# 首次运行
npm install
npm run build

# 启动（默认 http://localhost:8080）
npm start
```

Windows 用户可直接双击 `start.bat`（自动装依赖、构建、开浏览器）。

局域网对战：其他设备访问 `http://<本机IP>:8080` 即可进入同一个棋室，自动匹配彼此。

开发模式（前端热更新）：

```bash
node server/index.js          # 终端 1：后端
npm run dev:client            # 终端 2：Vite，5173 端口，/ws 与 /api 已代理到 8080
```

---

## 2. 关于「纯静态」与「在线匹配」的取舍

浏览器里的纯静态页面**没有共享状态**，两个不同用户无法互相匹配——匹配必然需要一个中转进程。因此本项目的形态是：

| 层 | 实现 | 是否静态 |
| --- | --- | --- |
| 前端 | React 18 + Vite，构建为 `dist/` 静态资源 | 是（纯静态产物，可由任意静态服务器托管） |
| 服务 | 本机 Node 进程，托管静态资源 + WebSocket 撮合 | 否（单进程，无外部依赖、无云服务） |
| 数据 | SQLite 文件 `data/go.db` | 本地文件 |

如果你确实需要「双击 HTML 即玩、完全无进程」，可以把匹配降级为本地 AI 对战或同屏双人；但只要要求「两个在线用户互相匹配」，中转进程就不可省略。

---

## 3. 功能

- **自动匹配**：按棋盘规格进入匹配队列，两人到齐立即开局，黑白随机
- **三种规格**：9 / 13 / 19 路，包干计时（5 / 8 / 10 分钟），超时判负
- **完整规则**：提子、禁自杀、简单劫、双方虚手后进入点目阶段
- **点目与数子**：点击死子标记归属，双方确认后按中国规则（数子法）自动计算胜负，贴目 7.5
- **实时同步**：落子、计时、聊天、断线状态全端同步
- **断线重连**：30 秒宽限，刷新页面可自动回到原对局；超时判负
- **人机陪练**：单人也能验证系统，AI 为启发式（提子 / 长气 / 占角偏好）
- **棋谱与战绩**：每手落库，终局生成 SGF 可下载，Elo 积分排行榜

---

## 4. 目录结构

```
在线围棋/
├── client/                  前端（React + Vite）
│   ├── index.html
│   ├── vite.config.js
│   └── src/
│       ├── App.jsx          顶栏 / 登录 / 路由
│       ├── lib/useGameSocket.js   WebSocket 状态机（自动重连）
│       ├── components/
│       │   ├── Board.jsx    SVG 棋盘（坐标、星位、最后一手、死子标记、落子预览）
│       │   ├── Lobby.jsx    匹配、在线棋士、排行榜、最近对局
│       │   └── GameView.jsx 对局界面、计时、操作、聊天、终局结果
│       └── styles.css
├── server/
│   ├── index.js             HTTP 静态托管 + WebSocket 撮合与广播
│   ├── game.js              对局状态机（落子/虚手/点目/计时/终局）
│   ├── db.js                SQLite 读写（node:sqlite）
│   └── ai.js                陪练 AI
├── shared/go-engine.js      规则引擎（前后端共用，纯函数）
├── tests/protocol.test.js   规则单测 + 端到端协议测试
├── data/go.db               SQLite 数据文件（自动创建）
└── dist/                    前端构建产物
```

---

## 5. 规则实现要点

| 项 | 实现 |
| --- | --- |
| 提子 | 落子后检查四邻敌块气数，为 0 则整块移除 |
| 禁自杀 | 无提子且自身气为 0 → 判为禁着点 |
| 劫 | 仅提一子、己方成单子单气时记录劫点，下一手不可立即回提 |
| 终局 | 双方连续虚手 → 点目阶段 → 双方确认 → 数子 |
| 数子 | 子数 + 单方围空（中国规则），白方加贴目 7.5 |
| 计时 | 服务端 1 秒心跳扣减当前行棋方时间；对手断线期间暂停 |

---

## 6. WebSocket 协议

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

服务端为唯一权威：所有落子合法性、计时、胜负均以服务端判定为准，前端只做渲染与乐观预览。

---

## 7. 数据库

`data/go.db`（WAL 模式），三张表：

- `users` — 昵称、胜负、积分（Elo，K=24）
- `games` — 对局元信息、结果、终局比分、SGF
- `moves` — 每一手（序号、颜色、坐标、是否虚手、提子数）

```bash
# 直接查询
node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('data/go.db');console.table(db.prepare('select id,nickname,wins,losses,rating from users order by rating desc limit 10').all())"
```

HTTP 接口：`/api/health`、`/api/lobby`、`/api/game/:id`、`/api/game/:id.sgf`。

---

## 8. 测试

```bash
npm test
```

覆盖：提子、禁自杀、劫争、数子（含死子归属）、自动匹配、颜色分配、非法落子拒绝、非轮次拒绝、点目终局、数据落库、SGF 导出、人机应手。当前 **28 项全部通过**。

---

## 9. 已知边界

- 简单劫而非全局同形禁止（三劫循环等罕见情形不判和）
- 数子假设双方已正确标记死子；未实现自动死活判断
- 匹配按棋盘规格排队，时限固定随规格（不支持自选时限）
- 无账号密码体系，身份为浏览器会话级 ID（同浏览器新标签页即新身份，便于本地多人测试）
- 计时为包干制，未实现读秒
