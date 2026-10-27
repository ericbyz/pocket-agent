# Changelog

## 0.2.0（2026-10-27）

从「能跑的骨架」升级为完整的远程 Agent 平台。协议 v1 → v2（不兼容）。

### 服务端

- **任务系统**：TaskManager（排队 / 并发上限 / 取消 / 终态落库），SQLite 持久化（better-sqlite3），服务重启标记 interrupted 并保留历史
- **断线恢复**：事件全局 seq + 环形缓冲（2 万条），`hello.since` 补发；断开默认不取消任务
- **交互式 stdin**：`agent.input` 路由到运行中任务；`run_command --interactive` 提供 PowerShell REPL；coding agent 支持多轮会话
- **computer agent 新动作**：processes / kill_process / clipboard_get / clipboard_set / open / power / mouse_move / mouse_click / scroll / key_type / key_tap（SendKeys + mouse_event P/Invoke）；screenshot 返回虚拟屏幕坐标供点选换算
- **files agent 新动作**：search（文件名+内容）/ move / copy / download（分片+sha256）/ upload（start/chunk/end 分片协议，临时文件+原子改名）
- **Hub 加固**：每连接令牌桶限流、30s 心跳（2 次未响应断开）、协议版本协商、优雅停机（SIGINT 取消任务落库）、EADDRINUSE 友好提示
- **通知**：`PA_NOTIFY_URL`（ntfy/webhook），无客户端在线时推送任务终态
- **配置**：支持 `pocket-agent.json` 配置文件（env 优先）；新增 `PA_DATA_DIR` / `PA_MAX_CONCURRENT` / `PA_NOTIFY_URL` / `PA_CANCEL_ON_DISCONNECT`
- **配对**：终端打印二维码（深链 `pocket-agent://connect?...`）

### 手机 App

- 多服务器管理（保存 / 自动连接上次）、扫码深链配对、指数退避自动重连 + 事件游标持久化
- 任务中心：全部任务的状态 / 过滤 / 清空；任务详情：实时输出（ANSI 清理）、取消、交互输入条、结果 JSON
- 截图点选：点选模式开启后点图即 `mouse_click`，一键刷新截图
- 文件浏览器：目录导航、上传（系统选择器 → 分片）、预览 / 编辑 / 下载到手机（分享）、删除确认

### 协议（v2）

- 消息新增：`agent.input` / `tasks.list` / `tasks.get` / `tasks.clear` / `upload.start` / `upload.chunk` / `upload.end` / `task.update`
- `agent.event` 带全局 `seq`；`welcome` 携带任务快照与 `lastSeq`；`hello` 支持 `since` 补发
- `AgentEvent` 新增 `file`（下载分片）与 `cancelled` 终态

### 测试

smoke 从 6 组断言扩到 13 组：配对/任务推送/输出流/交互终端回显与取消/文件写读搜/下载分片+sha256/上传逐字节回环/越权拒绝/坏 token/限流/任务列表/断线 resume（seq 严格递增）/重启持久化。

## 0.1.0（2026-10-27）

初始骨架：protocol / server / mobile 三包，token 配对 WebSocket，computer / files / coding 三个 agent（单发命令、文件读写、CLI 单次任务），CI。
