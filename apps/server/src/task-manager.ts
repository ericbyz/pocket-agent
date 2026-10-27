import type { AgentEvent, ServerMessage, TaskInfo, TaskStatus } from '@pocket-agent/protocol'
import type { ServerConfig } from './config'
import type { Store } from './store'
import type { ServerAgent } from './agents/types'

interface RunningHandle {
  cancel: () => void
  input: ((data: string) => void) | null
  channel: ((kind: 'chunk' | 'end', data?: string) => void) | null
}

/**
 * 任务生命周期管理：入队 → 限并发执行 → 终态落库。
 * 每条 agent 事件打全局 seq 后广播并持久化，客户端断线重连按 seq 补发。
 */
export class TaskManager {
  private handles = new Map<string, RunningHandle>()
  private cancelRequested = new Set<string>()
  private queue: string[] = []
  /** 排队任务的参数（任务启动后即删除；服务重启时排队任务会被标记 interrupted，无需落库） */
  private pendingParams = new Map<string, unknown>()
  private runningCount = 0
  private seqCounter: number

  constructor(
    private readonly config: ServerConfig,
    private readonly store: Store,
    private readonly agents: ServerAgent[],
    private readonly broadcast: (msg: ServerMessage) => void,
    private readonly connectedClients: () => number,
  ) {
    this.seqCounter = store.lastSeq()
  }

  getAgent(agentId: string): ServerAgent | undefined {
    return this.agents.find((candidate) => candidate.info.id === agentId)
  }

  /** 校验并创建任务；已存在同名 id 时报错（幂等保护） */
  invoke(requestId: string, agentId: string, action: string, params: unknown): { ok: true; task: TaskInfo } | { ok: false; code: string; message: string } {
    const agent = this.getAgent(agentId)
    if (!agent) return { ok: false, code: 'agent_not_found', message: `找不到 agent：${agentId}` }
    if (this.store.hasTask(requestId)) return { ok: false, code: 'request_exists', message: 'requestId 已存在，请换一个' }

    const task: TaskInfo = {
      id: requestId,
      agentId,
      action,
      status: 'queued',
      createdAt: Date.now(),
      inputCapable: false,
    }
    this.store.upsertTask(task)
    this.broadcast({ type: 'task.update', task })
    this.pendingParams.set(requestId, params)
    this.queue.push(requestId)
    this.pump()
    return { ok: true, task }
  }

  private pump(): void {
    while (this.runningCount < this.config.maxConcurrent && this.queue.length > 0) {
      const taskId = this.queue.shift()
      if (!taskId) break
      const task = this.store.getTask(taskId)
      // 可能已被取消或清理
      if (!task || task.status !== 'queued') continue
      this.start(task, this.pendingParams.get(taskId))
      this.pendingParams.delete(taskId)
    }
  }

  private start(task: TaskInfo, params: unknown): void {
    const agent = this.getAgent(task.agentId)
    if (!agent) {
      this.finalize(task.id, { kind: 'failed', error: `agent 不存在：${task.agentId}` })
      return
    }
    this.runningCount += 1
    const running: TaskInfo = { ...task, status: 'running' }
    this.store.upsertTask(running)
    this.broadcast({ type: 'task.update', task: running })

    const handle: RunningHandle = { cancel: () => agent.cancel?.(task.id), input: null, channel: null }
    this.handles.set(task.id, handle)

    const ctx = {
      requestId: task.id,
      emit: (event: AgentEvent) => this.onEvent(task.id, event),
      setInput: (fn: ((data: string) => void) | null) => {
        handle.input = fn
        const updated = this.store.getTask(task.id)
        if (updated && updated.status === 'running' && updated.inputCapable !== (fn !== null)) {
          const next = { ...updated, inputCapable: fn !== null }
          this.store.upsertTask(next)
          this.broadcast({ type: 'task.update', task: next })
        }
      },
      setChannel: (fn: ((kind: 'chunk' | 'end', data?: string) => void) | null) => {
        handle.channel = fn
      },
      workspaceRoot: this.config.workspaceRoot,
      allowShell: this.config.allowShell,
    }

    agent
      .invoke(task.action, params, ctx)
      .then(() => {
        // agent 正常返回但没有发终态事件：补一个 failed，避免任务卡在 running
        const current = this.store.getTask(task.id)
        if (current && current.status === 'running') {
          this.onEvent(task.id, { kind: 'failed', error: 'agent 未发出终态事件' })
        }
      })
      .catch((err: unknown) => {
        this.onEvent(task.id, { kind: 'failed', error: err instanceof Error ? err.message : String(err) })
      })
  }

  private onEvent(taskId: string, event: AgentEvent): void {
    this.seqCounter += 1
    const seq = this.store.appendEvent(taskId, event)
    this.broadcast({ type: 'agent.event', requestId: taskId, seq, event })
    if (event.kind === 'completed' || event.kind === 'failed') {
      this.finalize(taskId, event)
    }
  }

  private finalize(taskId: string, terminal: { kind: 'completed' | 'failed'; result?: unknown; error?: string }): void {
    const current = this.store.getTask(taskId)
    if (!current || current.status === 'running' || current.status === 'queued') {
      const status: TaskStatus = this.cancelRequested.has(taskId) ? 'cancelled' : terminal.kind
      const done: TaskInfo = {
        ...current,
        id: taskId,
        agentId: current?.agentId ?? '?',
        action: current?.action ?? '?',
        createdAt: current?.createdAt ?? Date.now(),
        inputCapable: current?.inputCapable ?? false,
        status,
        endedAt: Date.now(),
        error: status === 'failed' ? terminal.error : undefined,
      }
      this.store.upsertTask(done)
      this.broadcast({ type: 'task.update', task: done })
      this.notifyIfIdle(done)
    }
    this.handles.delete(taskId)
    this.cancelRequested.delete(taskId)
    if (this.runningCount > 0) this.runningCount -= 1
    this.pump()
  }

  /** 无任何客户端在线时，向通知渠道（ntfy/webhook）推送任务终态 */
  private notifyIfIdle(task: TaskInfo): void {
    if (!this.config.notifyUrl) return
    if (this.connectedClients() > 0) return
    if (task.status === 'completed' || task.status === 'failed') {
      const text = `【Pocket Agent】${task.agentId}.${task.action} → ${task.status}${
        task.error ? `：${task.error}` : ''
      }`
      fetch(this.config.notifyUrl, {
        method: 'POST',
        headers: { title: `任务${task.status === 'completed' ? '完成' : '失败'}`, priority: task.status === 'failed' ? 'high' : 'default' },
        body: text,
      }).catch((err: unknown) => {
        console.warn(`⚠ 通知发送失败：${err instanceof Error ? err.message : err}`)
      })
    }
  }

  cancel(taskId: string): 'ok' | 'not_found' | 'not_active' {
    const task = this.store.getTask(taskId)
    if (!task) return 'not_found'
    if (task.status !== 'queued' && task.status !== 'running') return 'not_active'

    if (task.status === 'queued') {
      this.queue = this.queue.filter((id) => id !== taskId)
      const cancelled: TaskInfo = { ...task, status: 'cancelled', endedAt: Date.now() }
      this.store.upsertTask(cancelled)
      this.broadcast({ type: 'task.update', task: cancelled })
      return 'ok'
    }

    this.cancelRequested.add(taskId)
    this.handles.get(taskId)?.cancel()
    // 有些 agent 不支持 cancel：兜底在 3s 后强制终态，避免永远 running
    setTimeout(() => {
      const still = this.store.getTask(taskId)
      if (still && still.status === 'running') {
        this.onEvent(taskId, { kind: 'failed', error: '取消超时：agent 未响应 cancel' })
      }
    }, 3_000).unref()
    return 'ok'
  }

  /** 客户端 stdin 输入 → 运行中任务的进程 */
  input(taskId: string, data: string): 'ok' | 'not_found' | 'no_input' {
    const handle = this.handles.get(taskId)
    const task = this.store.getTask(taskId)
    if (!task) return 'not_found'
    if (!handle?.input) return 'no_input'
    handle.input(data)
    return 'ok'
  }

  /** 上传分片通道（upload.chunk / upload.end → files agent） */
  channel(taskId: string, kind: 'chunk' | 'end', data?: string): 'ok' | 'not_found' | 'no_channel' {
    const handle = this.handles.get(taskId)
    if (!this.store.hasTask(taskId)) return 'not_found'
    if (!handle?.channel) return 'no_channel'
    handle.channel(kind, data)
    return 'ok'
  }

  /** 优雅停机 / 客户端断开策略：取消全部运行中任务 */
  cancelAll(reason: string): void {
    for (const [taskId, handle] of this.handles) {
      this.cancelRequested.add(taskId)
      try {
        handle.cancel()
      } catch {
        // 尽力而为
      }
    }
    this.queue = []
    for (const taskId of [...this.handles.keys()]) {
      const task = this.store.getTask(taskId)
      if (task && (task.status === 'running' || task.status === 'queued')) {
        this.finalize(taskId, { kind: 'failed', error: reason })
      }
    }
  }

  snapshot(limit = 50, status?: TaskStatus): TaskInfo[] {
    return this.store.listTasks(limit, status)
  }

  listAgentInfos() {
    return this.agents.map((agent) => agent.info)
  }

  /** 清理已结束任务（含事件），并向所有客户端广播最新快照 */
  clearFinished(): void {
    this.store.clearFinished()
    this.broadcast({ type: 'tasks', tasks: this.snapshot(50) })
  }
}
