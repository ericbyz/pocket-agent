import type {
  AgentEvent,
  AgentInfo,
  ClientMessage,
  ServerInfo,
  ServerMessage,
  TaskInfo,
} from '@pocket-agent/protocol'
import { cleanTerminalText } from './ansi'

export type ClientState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error'

export interface LogLine {
  id: number
  kind: 'status' | 'stdout' | 'stderr' | 'info'
  text: string
}

interface Pending {
  resolve: (result: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const PING_INTERVAL_MS = 20_000
const MAX_LOG_LINES = 1500
const MAX_BACKOFF_MS = 15_000

function genId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** 致命错误码：不自动重连（重连也不会成功） */
const FATAL_CODES = new Set(['bad_token', 'protocol_mismatch'])

export interface AgentClientCallbacks {
  onState: (state: ClientState, detail?: string) => void
  onWelcome: (server: ServerInfo, agents: AgentInfo[]) => void
}

/**
 * 服务端连接封装（v2）：
 * - token 配对 + hello.since 断线补发
 * - 自动重连（指数退避），bad_token 等致命错误停止
 * - request()：一次调用 → Promise（completed / failed）
 * - downloadFile / uploadFile：分片传输
 * - 任务表 + 每任务日志流的内存缓存与订阅
 */
export class AgentClient {
  private ws: WebSocket | null = null
  private shouldReconnect = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private attempts = 0

  private record: { host: string; port: string; token: string } | null = null
  private sinceSeq = 0
  /** 每 N 条事件持久化一次游标 */
  onSeqPersist: ((seq: number) => void) | null = null
  private seqDirty = 0

  readonly tasks = new Map<string, TaskInfo>()
  readonly results = new Map<string, unknown>()
  private logs = new Map<string, LogLine[]>()
  private logId = 0

  private pending = new Map<string, Pending>()
  private taskSubs = new Set<(tasks: TaskInfo[]) => void>()
  private logSubs = new Map<string, Set<() => void>>()

  constructor(private readonly callbacks: AgentClientCallbacks) {}

  // ---- 连接管理 ------------------------------------------------------------

  connect(host: string, port: string, token: string, since = 0): void {
    this.record = { host, port, token }
    this.sinceSeq = since
    this.shouldReconnect = true
    this.attempts = 0
    this.open()
  }

  private open(): void {
    if (!this.record) return
    this.callbacks.onState(this.attempts === 0 ? 'connecting' : 'reconnecting')
    const ws = new WebSocket(`ws://${this.record.host}:${this.record.port}`)
    this.ws = ws

    ws.onopen = () => {
      this.send({
        type: 'hello',
        protocol: 2,
        token: this.record!.token,
        deviceName: 'pocket-agent-mobile',
        since: this.sinceSeq,
      })
      this.startPing()
    }
    ws.onmessage = (ev) => this.handleMessage(String(ev.data))
    ws.onerror = () => {
      // 具体原因在 onclose 里统一走重连
    }
    ws.onclose = () => {
      this.stopPing()
      if (this.ws === ws) this.ws = null
      if (this.shouldReconnect) this.scheduleReconnect()
      else this.callbacks.onState('idle')
    }
  }

  private scheduleReconnect(): void {
    this.attempts += 1
    const delay = Math.min(1000 * 2 ** (this.attempts - 1), MAX_BACKOFF_MS)
    this.callbacks.onState('reconnecting', `连接断开，${Math.round(delay / 1000)}s 后第 ${this.attempts} 次重试…`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.open()
    }, delay)
  }

  disconnect(): void {
    this.shouldReconnect = false
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.stopPing()
    const ws = this.ws
    this.ws = null
    if (ws) {
      ws.onclose = null
      ws.onerror = null
      ws.onmessage = null
      try {
        ws.close()
      } catch {
        // 忽略
      }
    }
    this.failAllPending('连接已断开')
    this.callbacks.onState('idle')
  }

  private startPing(): void {
    this.stopPing()
    this.pingTimer = setInterval(() => this.send({ type: 'ping' }), PING_INTERVAL_MS)
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
  }

  // ---- 调用 ---------------------------------------------------------------

  /** 发起调用，立即返回 requestId（结果通过任务事件流观察） */
  invoke(agentId: string, action: string, params?: unknown): string {
    const requestId = genId('req')
    this.send({ type: 'agent.invoke', requestId, agentId, action, params })
    return requestId
  }

  /** 一次性调用：resolve(completed result) / reject(failed)；timeoutMs<=0 不限时（长任务） */
  request(agentId: string, action: string, params?: unknown, timeoutMs = 120_000): Promise<unknown> {
    const requestId = this.invoke(agentId, action, params)
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(requestId, {
        resolve,
        reject,
        timer: timeoutMs > 0
          ? setTimeout(() => {
              const p = this.pending.get(requestId)
              if (p) {
                this.pending.delete(requestId)
                p.reject(new Error(`请求超时（${Math.round(timeoutMs / 1000)}s）`))
              }
            }, timeoutMs)
          : setTimeout(() => undefined, 0), // noop，保持类型一致
      })
    })
  }

  private fileBufs = new Map<string, string[]>()

  /** 下载文件：收集 file 分片，返回 base64 */
  async downloadFile(path: string): Promise<{ base64: string; bytes: number; sha256?: string }> {
    const requestId = genId('dl')
    const result = (await new Promise<unknown>((resolve, reject) => {
      this.pending.set(requestId, {
        resolve,
        reject,
        timer: setTimeout(() => {
          const p = this.pending.get(requestId)
          if (p) {
            this.pending.delete(requestId)
            p.reject(new Error('下载超时'))
          }
        }, 300_000),
      })
      this.send({ type: 'agent.invoke', requestId, agentId: 'files', action: 'download', params: { path } })
    })) as { bytes: number; sha256?: string }
    const base64 = this.takeFileBuf(requestId)
    this.fileBufs.delete(requestId)
    return { base64, bytes: result.bytes, sha256: result.sha256 }
  }

  private takeFileBuf(requestId: string): string {
    return (this.fileBufs.get(requestId) ?? []).join('')
  }

  /** 上传文件：立即返回 requestId（进度通过任务事件流观察） */
  uploadFileStart(path: string, base64: string, overwrite = false): string {
    const requestId = genId('up')
    const pad = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
    const bytes = Math.floor((base64.length * 3) / 4) - pad
    this.send({ type: 'upload.start', requestId, path, bytes, overwrite })
    const CHUNK = 256 * 1024
    for (let i = 0; i < base64.length; i += CHUNK) {
      this.send({ type: 'upload.chunk', requestId, data: base64.slice(i, i + CHUNK) })
    }
    this.send({ type: 'upload.end', requestId })
    return requestId
  }

  /** 上传文件并等待完成 */
  uploadFile(path: string, base64: string, overwrite = false): Promise<unknown> {
    const requestId = this.uploadFileStart(path, base64, overwrite)
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(requestId, {
        resolve,
        reject,
        timer: setTimeout(() => {
          const p = this.pending.get(requestId)
          if (p) {
            this.pending.delete(requestId)
            p.reject(new Error('上传超时（10 分钟）'))
          }
        }, 10 * 60_000),
      })
    })
  }

  /** 向交互式任务写入 stdin（自动补换行） */
  sendInput(taskId: string, data: string): void {
    this.send({ type: 'agent.input', requestId: taskId, data: data.endsWith('\n') ? data : `${data}\n` })
  }

  cancel(taskId: string): void {
    this.send({ type: 'agent.cancel', requestId: taskId })
  }

  clearFinished(): void {
    this.send({ type: 'tasks.clear' })
  }

  listAgents(): void {
    this.send({ type: 'agents.list' })
  }

  // ---- 数据订阅 -----------------------------------------------------------

  subscribeTasks(cb: (tasks: TaskInfo[]) => void): () => void {
    this.taskSubs.add(cb)
    cb(this.taskSnapshot())
    return () => {
      this.taskSubs.delete(cb)
    }
  }

  subscribeLogs(taskId: string, cb: () => void): () => void {
    let set = this.logSubs.get(taskId)
    if (!set) {
      set = new Set()
      this.logSubs.set(taskId, set)
    }
    set.add(cb)
    cb()
    return () => {
      set?.delete(cb)
    }
  }

  getLogs(taskId: string): LogLine[] {
    return this.logs.get(taskId) ?? []
  }

  taskSnapshot(): TaskInfo[] {
    return [...this.tasks.values()].sort((a, b) => b.createdAt - a.createdAt)
  }

  resetData(): void {
    this.tasks.clear()
    this.results.clear()
    this.logs.clear()
    this.fileBufs.clear()
  }

  // ---- 内部 ---------------------------------------------------------------

  private send(msg: ClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg))
  }

  private handleMessage(raw: string): void {
    let msg: ServerMessage
    try {
      msg = JSON.parse(raw) as ServerMessage
    } catch {
      return
    }
    switch (msg.type) {
      case 'welcome':
        this.attempts = 0
        this.callbacks.onState('connected')
        this.tasks.clear()
        for (const task of msg.tasks) this.tasks.set(task.id, task)
        this.notifyTasks()
        this.callbacks.onWelcome(msg.server, msg.agents)
        this.sinceSeq = Math.max(this.sinceSeq, msg.lastSeq)
        break
      case 'task.update':
        this.tasks.set(msg.task.id, msg.task)
        if (msg.task.status !== 'running' && msg.task.status !== 'queued') {
          this.results.delete(msg.task.id)
        }
        this.notifyTasks()
        break
      case 'tasks':
        this.tasks.clear()
        for (const task of msg.tasks) this.tasks.set(task.id, task)
        this.notifyTasks()
        break
      case 'agent.event':
        this.handleAgentEvent(msg.requestId, msg.seq, msg.event)
        break
      case 'error':
        if (FATAL_CODES.has(msg.code)) {
          this.shouldReconnect = false
          this.callbacks.onState('error', `配对失败：${msg.message}`)
        }
        if (msg.requestId) {
          const p = this.pending.get(msg.requestId)
          if (p) {
            this.pending.delete(msg.requestId)
            clearTimeout(p.timer)
            p.reject(new Error(msg.message))
          }
        }
        break
      case 'pong':
        break
      case 'agents':
        break
    }
  }

  private handleAgentEvent(taskId: string, seq: number, event: AgentEvent): void {
    if (seq > this.sinceSeq) {
      this.sinceSeq = seq
      this.seqDirty += 1
      if (this.seqDirty >= 20) {
        this.seqDirty = 0
        this.onSeqPersist?.(this.sinceSeq)
      }
    }

    const lines = this.logs.get(taskId) ?? []
    const push = (kind: LogLine['kind'], text: string): void => {
      this.logId += 1
      lines.push({ id: this.logId, kind, text: cleanTerminalText(text) })
      if (lines.length > MAX_LOG_LINES) lines.splice(0, lines.length - MAX_LOG_LINES)
      this.logs.set(taskId, lines)
      for (const cb of this.logSubs.get(taskId) ?? []) cb()
    }

    switch (event.kind) {
      case 'started':
        push('status', '▶ 已开始')
        break
      case 'output':
        push(event.stream === 'stderr' ? 'stderr' : event.stream === 'info' ? 'info' : 'stdout', event.chunk)
        break
      case 'file': {
        let buf = this.fileBufs.get(taskId)
        if (!buf) {
          buf = []
          this.fileBufs.set(taskId, buf)
        }
        buf.push(event.data)
        push('info', `↓ 分片 @${event.offset}（${event.bytes}B）`)
        break
      }
      case 'completed': {
        this.results.set(taskId, event.result)
        push('status', `✓ 完成 ${describeResult(event.result)}`)
        const p = this.pending.get(taskId)
        if (p) {
          this.pending.delete(taskId)
          clearTimeout(p.timer)
          p.resolve(event.result)
        }
        this.onSeqPersist?.(this.sinceSeq)
        break
      }
      case 'failed': {
        push('status', `✗ 失败：${event.error}`)
        const p = this.pending.get(taskId)
        if (p) {
          this.pending.delete(taskId)
          clearTimeout(p.timer)
          p.reject(new Error(event.error))
        }
        this.onSeqPersist?.(this.sinceSeq)
        break
      }
      case 'cancelled':
        push('status', '⏹ 已取消')
        break
    }
  }

  private failAllPending(reason: string): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new Error(reason))
    }
    this.pending.clear()
  }

  private notifyTasks(): void {
    const snapshot = this.taskSnapshot()
    for (const cb of this.taskSubs) cb(snapshot)
  }
}

function describeResult(result: unknown): string {
  if (result && typeof result === 'object' && 'exitCode' in result) {
    const code = (result as { exitCode: unknown }).exitCode
    return `（exit ${code === null || code === undefined ? '-' : code}）`
  }
  if (result && typeof result === 'object' && 'bytes' in result) {
    return `（${(result as { bytes: number }).bytes}B）`
  }
  return ''
}
