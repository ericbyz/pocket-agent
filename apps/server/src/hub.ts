import { timingSafeEqual } from 'node:crypto'
import os from 'node:os'
import { WebSocket, WebSocketServer } from 'ws'
import {
  ClientMessageSchema,
  PROTOCOL_VERSION,
  type ClientMessage,
  type ServerMessage,
  type TaskStatus,
} from '@pocket-agent/protocol'
import type { ServerConfig } from './config'
import type { Store } from './store'
import type { TaskManager } from './task-manager'
import { createInvokeBucket } from './ratelimit'

const HEARTBEAT_INTERVAL_MS = 30_000
const HEARTBEAT_MISSES_LIMIT = 2

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

interface Conn {
  ws: WebSocket
  authed: boolean
  alive: boolean
  misses: number
  bucket: ReturnType<typeof createInvokeBucket>
  deviceName: string
}

/**
 * 连接层：配对鉴权、协议校验、限流、心跳、resume 补发，
 * 以及 agent.invoke / input / upload.* / tasks.* 的路由。
 */
export class Hub {
  private conns = new Set<Conn>()
  private tasks!: TaskManager
  private heartbeat?: ReturnType<typeof setInterval>

  constructor(
    private readonly config: ServerConfig,
    private readonly store: Store,
  ) {}

  setTaskManager(tasks: TaskManager): void {
    this.tasks = tasks
  }

  attach(wss: WebSocketServer): void {
    wss.on('connection', (ws) => this.handleConnection(ws))
    this.heartbeat = setInterval(() => this.tick(), HEARTBEAT_INTERVAL_MS)
    this.heartbeat.unref()
  }

  authedCount(): number {
    let count = 0
    for (const conn of this.conns) if (conn.authed) count += 1
    return count
  }

  broadcast(msg: ServerMessage): void {
    const raw = JSON.stringify(msg)
    for (const conn of this.conns) {
      if (conn.authed && conn.ws.readyState === WebSocket.OPEN) conn.ws.send(raw)
    }
  }

  private tick(): void {
    for (const conn of this.conns) {
      if (conn.alive) {
        conn.misses = 0
      } else {
        conn.misses += 1
        if (conn.misses >= HEARTBEAT_MISSES_LIMIT) {
          conn.ws.terminate()
          continue
        }
      }
      conn.alive = false
      try {
        conn.ws.ping()
      } catch {
        // 已断开的连接，terminate 会在 close 事件里清理
      }
    }
  }

  private handleConnection(ws: WebSocket): void {
    const conn: Conn = {
      ws,
      authed: false,
      alive: true,
      misses: 0,
      bucket: createInvokeBucket(),
      deviceName: 'unknown',
    }
    this.conns.add(conn)

    const send = (msg: ServerMessage): void => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
    }

    ws.on('pong', () => {
      conn.alive = true
    })

    ws.on('message', (raw) => {
      conn.alive = true
      let data: unknown
      try {
        data = JSON.parse((raw as Buffer).toString('utf8'))
      } catch {
        send({ type: 'error', code: 'bad_json', message: '消息不是合法 JSON' })
        return
      }
      const parsed = ClientMessageSchema.safeParse(data)
      if (!parsed.success) {
        send({
          type: 'error',
          code: 'bad_message',
          message: `消息不符合协议：${parsed.error.issues[0]?.message ?? ''}`,
        })
        return
      }
      this.handleMessage(conn, parsed.data, send)
    })

    ws.on('close', () => {
      this.conns.delete(conn)
      // 默认不取消：任务继续跑，事件落库，重连按 seq 补发。
      // PA_CANCEL_ON_DISCONNECT=1 且已无其他客户端时，取消所有运行中任务。
      if (conn.authed && this.config.cancelOnDisconnect && this.tasks && this.authedCount() === 0) {
        this.tasks.cancelAll('客户端断开且 PA_CANCEL_ON_DISCONNECT=1')
      }
    })

    ws.on('error', () => {
      // 出错的连接由 close 统一清理
    })
  }

  private handleMessage(conn: Conn, msg: ClientMessage, send: (msg: ServerMessage) => void): void {
    if (!conn.authed) {
      if (msg.type !== 'hello') {
        send({ type: 'error', code: 'unauthorized', message: '请先发送 hello 完成配对' })
        return
      }
      if (msg.protocol !== PROTOCOL_VERSION) {
        send({
          type: 'error',
          code: 'protocol_mismatch',
          message: `协议版本不匹配：客户端 ${msg.protocol}，服务端 ${PROTOCOL_VERSION}`,
        })
        wsClose(conn.ws)
        return
      }
      if (!safeEqual(msg.token, this.config.token)) {
        send({ type: 'error', code: 'bad_token', message: '配对 token 不正确' })
        wsClose(conn.ws)
        return
      }
      conn.authed = true
      conn.deviceName = msg.deviceName ?? 'unknown'
      send(this.welcome())
      if (msg.since != null) this.replaySince(msg.since, send)
      return
    }

    switch (msg.type) {
      case 'hello':
        send(this.welcome())
        if (msg.since != null) this.replaySince(msg.since, send)
        break
      case 'ping':
        send({ type: 'pong' })
        break
      case 'agents.list':
        send({
          type: 'agents',
          agents: this.tasks ? this.allAgentInfos() : [],
        })
        break
      case 'agent.invoke':
      case 'upload.start': {
        if (!conn.bucket.take()) {
          send({ type: 'error', code: 'rate_limited', message: '请求过于频繁，请稍后再试' })
          return
        }
        if (msg.type === 'agent.invoke') {
          const result = this.tasks.invoke(msg.requestId, msg.agentId, msg.action, msg.params ?? {})
          if (!result.ok) {
            send({ type: 'error', code: result.code, message: result.message, requestId: msg.requestId })
          }
        } else {
          const result = this.tasks.invoke(msg.requestId, 'files', 'upload', {
            path: msg.path,
            bytes: msg.bytes,
            overwrite: msg.overwrite ?? false,
          })
          if (!result.ok) {
            send({ type: 'error', code: result.code, message: result.message, requestId: msg.requestId })
          }
        }
        break
      }
      case 'agent.cancel': {
        const outcome = this.tasks.cancel(msg.requestId)
        if (outcome === 'not_found') {
          send({ type: 'error', code: 'task_not_found', message: '任务不存在', requestId: msg.requestId })
        }
        break
      }
      case 'agent.input': {
        const outcome = this.tasks.input(msg.requestId, msg.data)
        if (outcome === 'not_found') {
          send({ type: 'error', code: 'task_not_found', message: '任务不存在', requestId: msg.requestId })
        } else if (outcome === 'no_input') {
          send({ type: 'error', code: 'no_input', message: '任务不支持输入（非交互式或已结束）', requestId: msg.requestId })
        }
        break
      }
      case 'tasks.list':
        send({ type: 'tasks', tasks: this.tasks.snapshot(msg.limit ?? 50, msg.status as TaskStatus | undefined) })
        break
      case 'tasks.get': {
        const task = this.tasks.snapshot(200).find((t) => t.id === msg.id)
        if (!task) send({ type: 'error', code: 'task_not_found', message: '任务不存在' })
        else send({ type: 'task.update', task })
        break
      }
      case 'tasks.clear': {
        this.tasks.clearFinished()
        break
      }
      case 'upload.chunk': {
        const outcome = this.tasks.channel(msg.requestId, 'chunk', msg.data)
        if (outcome === 'not_found') {
          send({ type: 'error', code: 'task_not_found', message: '上传任务不存在', requestId: msg.requestId })
        }
        break
      }
      case 'upload.end': {
        const outcome = this.tasks.channel(msg.requestId, 'end')
        if (outcome === 'not_found') {
          send({ type: 'error', code: 'task_not_found', message: '上传任务不存在', requestId: msg.requestId })
        }
        break
      }
    }
  }

  private replaySince(since: number, send: (msg: ServerMessage) => void): void {
    const oldest = this.store.oldestSeq()
    if (oldest != null && since + 1 < oldest) {
      send({
        type: 'error',
        code: 'resume_unavailable',
        message: `补发起点太旧（最早可补发 seq=${oldest}），已跳过缺失部分`,
      })
    }
    for (const row of this.store.eventsSince(since)) {
      send({ type: 'agent.event', requestId: row.taskId, seq: row.seq, event: row.event })
    }
  }

  private allAgentInfos() {
    return this.tasks ? this.tasks.listAgentInfos() : []
  }

  private welcome(): ServerMessage {
    return {
      type: 'welcome',
      server: {
        name: this.config.name,
        version: this.config.version,
        platform: `${os.type()} ${os.release()} ${os.arch()}`,
        protocol: PROTOCOL_VERSION,
      },
      agents: this.allAgentInfos(),
      tasks: this.tasks ? this.tasks.snapshot(50) : [],
      lastSeq: this.store.lastSeq(),
    }
  }
}

function wsClose(ws: WebSocket): void {
  ws.close(4001, 'unauthorized')
}
