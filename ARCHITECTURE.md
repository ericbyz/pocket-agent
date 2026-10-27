# Pocket Agent 架构

本文描述 v0.2 的整体设计：分层、协议、任务生命周期、断线恢复、安全模型与扩展方式。

## 1. 分层总览

```
┌─────────────────────────────────────────────────────────┐
│ 手机 App（apps/mobile, Expo RN）                          │
│  AgentClient ── 连接/重连/游标 ── 任务表缓存 ── 请求 Promise │
│  Screens: Connect / Home / Agent / Tasks / TaskDetail /   │
│           Files / File                                    │
└──────────────────┬──────────────────────────────────────┘
                   │ WebSocket (JSON, @pocket-agent/protocol)
┌──────────────────▼──────────────────────────────────────┐
│ Hub（hub.ts）                                             │
│  配对鉴权(timingSafeEqual) · 消息校验(zod) · 令牌桶限流      │
│  心跳(30s ping / 2 次未响应断开) · resume 补发路由          │
├──────────────────────────────────────────────────────────┤
│ TaskManager（task-manager.ts）                             │
│  排队(并发上限) → 运行 → 终态 · cancel(含3s兜底)            │
│  事件打全局 seq → 广播+落库 · stdin/上传通道路由 · 通知      │
├──────────────┬───────────────┬───────────────────────────┤
│ computer     │ files         │ coding（可配置 CLI）        │
│ 终端/截屏/    │ 浏览/搜索/编辑 │ run_task/{{prompt}}        │
│ 鼠标键盘/进程 │ 分片上传下载   │ interactive 多轮 stdin     │
│ 剪贴板/电源   │               │                            │
├──────────────┴───────────────┴───────────────────────────┤
│ Store（store.ts, better-sqlite3）                          │
│  tasks 表 · events 表(全局 seq, 环形裁剪 20k)              │
└─────────────────────────────────────────────────────────┘
```

## 2. 协议（packages/protocol）

一条 WebSocket 连接上的 JSON 消息，zod 双端校验。`PROTOCOL_VERSION = 2`，hello 不匹配直接关闭。

### 消息一览

**手机 → 服务端**

| 消息 | 用途 |
| --- | --- |
| `hello {protocol, token, deviceName?, since?}` | 配对；`since` 携带本地事件游标触发补发 |
| `ping` | 心跳 |
| `agents.list` | 拉取 agent 列表 |
| `agent.invoke {requestId, agentId, action, params?}` | 发起任务（requestId 即任务 id，客户端生成保证幂等） |
| `agent.cancel {requestId}` | 取消任务 |
| `agent.input {requestId, data}` | 向交互式任务写 stdin（原样写入，换行由客户端补） |
| `tasks.list / tasks.get / tasks.clear` | 任务中心 |
| `upload.start {requestId, path, bytes, overwrite?}` | 开始上传（作为 files.upload 任务执行） |
| `upload.chunk {requestId, data}` | base64 分片（≤256KB/片） |
| `upload.end {requestId}` | 结束，触发校验+原子改名 |

**服务端 → 手机**

| 消息 | 用途 |
| --- | --- |
| `welcome {server, agents, tasks, lastSeq}` | 配对成功 + 全量快照 + 当前游标 |
| `agents {agents}` | agent 列表 |
| `agent.event {requestId, seq, event}` | 事件流（见下） |
| `tasks {tasks}` / `task.update {task}` | 任务快照 / 单任务变更推送 |
| `pong` / `error {code, message, requestId?}` | 心跳应答 / 错误 |

### 事件流与 seq

`AgentEvent` 是判别联合：`started` / `output{stream,chunk}` / `file{data,offset,bytes}`（下载分片）/ `completed{result}` / `failed{error}` / `cancelled`。

每条事件在服务端获得**全局单调递增的 seq**（SQLite AUTOINCREMENT 主键），同时广播给在线客户端并落库。这带来三个性质：

1. **断线补发**：客户端把见过的最大 seq 持久化（AsyncStorage，按服务器 id 隔离），重连时 `hello.since` → 服务端按 `eventsSince(since)` 重放。
2. **重启恢复**：事件在库里，服务重启后同样可重放；遗留 running/queued 任务被标为 `interrupted`。
3. **环形缓冲**：events 表保留最近 2 万条，`since` 早于最旧 seq 时提示 `resume_unavailable` 并从最早可用处补发。

## 3. 任务生命周期

```
invoke ──▶ queued ──▶ running ──┬─▶ completed   （agent 发 completed 事件）
             │                   ├─▶ failed      （agent 发 failed 事件或抛异常）
             │                   └─▶ cancelled   （取消请求在途时到达终态）
             └─────────▶ cancelled （排队中被取消）
（服务重启）running/queued ──▶ interrupted
```

关键点：

- **requestId 由客户端生成**，服务端 `tasks` 表主键去重 → 重复发送幂等（返回 `request_exists`）。
- **并发上限**（`PA_MAX_CONCURRENT`，默认 3）：超出排队，状态 `queued` 可取消。
- **取消语义**：queued 直接标记取消；running 标记 `cancelRequested` 后调用 agent 的 `cancel()`（Windows 上 `taskkill /T /F` 杀进程树），随后到达的终态事件记为 `cancelled`。agent 3 秒不响应 cancel 则强制终态。
- **agent 契约**：正常路径 agent 必须发出恰好一个终态事件；忘记发或抛异常由 TaskManager 兜底补 `failed`。
- **通知**：终态到达时若无任何已配对客户端在线且配置了 `PA_NOTIFY_URL`，POST 到 ntfy/webhook。

## 4. 交互式任务（stdin）

agent 在 invoke 时调用 `ctx.setInput(fn)` 注册 stdin 写入函数 → 任务标记 `inputCapable` 并推送 `task.update`。手机端任务详情据此显示输入条，`agent.input` 消息经 TaskManager 路由到该函数。当前使用方：

- `computer.run_command {interactive:true}` — PowerShell REPL
- `coding.run_task {interactive:true}` — 多轮 CLI agent 会话

连接断开**不会**取消任务（默认策略）：REPL 会话保持活着，重连后继续输入，期间输出按 seq 补发。

## 5. 文件传输

**下载**（`files.download`）：`createReadStream` 192KB 分片 → `file` 事件（base64 + offset）→ `completed {bytes, sha256}`；客户端拼装后可校验。

**上传**（`upload.start/chunk/end`）：作为 `files.upload` 任务执行，通道通过 `ctx.setChannel` 注册。注意一个实现细节：`upload.start` 的处理在首个 `await`（mkdir）处让出事件循环时，chunk 消息可能已到达——因此通道在**同步段**先注册为缓冲模式，mkdir 完成后切换为直写模式并回放缓存分片。写入 `.part-<id>` 临时文件，`end` 时校验字节数并原子 rename。

## 6. 安全模型

| 层 | 机制 |
| --- | --- |
| 身份 | 单 token 配对；`timingSafeEqual` 比较；错误即 `close(4001)` |
| 传输 | 局域网明文 ws（公网请反代加 TLS，原生 wss 在 Roadmap） |
| 能力分级 | 控制类动作（终端/进程/电源/鼠标键盘/打开程序）需 `PA_ALLOW_SHELL=1`；截屏/剪贴板/进程列表默认可用 |
| 文件沙箱 | 所有路径 resolve 后必须位于 `PA_WORKSPACE` 内；删除需 `confirm:true`；上传先落临时文件 |
| 注入防护 | CLI agent 经 `spawn` 直启（不经 shell），`{{prompt}}` 作为参数替换 |
| 滥用防护 | 每连接令牌桶（容量 30，0.25/s 补充）；服务端 30s 心跳，2 次未响应断开 |
| 停机 | SIGINT/SIGTERM：取消全部任务、落库、关闭 |

## 7. 扩展点

- **新 agent**：实现 `ServerAgent`（`apps/server/src/agents/types.ts`）→ `registry.ts` 注册。输出流/取消/交互输入/任务历史/断线补发全部自动继承。
- **新消息**：在 `packages/protocol` 加 schema → hub 加路由（客户端 → agent 的数据通道优先复用 `setInput`/`setChannel` 模式）。
- **通知渠道**：`notifyIfIdle` 目前 POST ntfy 格式；换渠道只改这一处。

## 8. 已知限制

- 排队任务的 params 只在内存：服务重启时排队任务直接 `interrupted`（不重跑）。
- running 任务在服务重启后同样 `interrupted`——CLI 进程随服务退出，会话不续跑（Roadmap）。
- 下载上限 200MB、读取上限 512KB（可调参数），超大文件请走分片上传 + 远端拼接。
- `tasks.get` 目前基于 200 条快照内查找，极老任务需 `tasks.list` 翻页。
