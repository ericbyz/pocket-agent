import { timingSafeEqual } from 'node:crypto'
import os from 'node:os'
import { WebSocket, WebSocketServer } from 'ws'
import {
  ClientMessageSchema,
  PROTOCOL_VERSION,
  type AgentEvent,
  type ClientMessage,
  type ServerMessage,
} from '@pocket-agent/protocol'
import type { ServerConfig } from './config'
import type { ServerAgent } from './agents/types'

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

/** 连接层：配对鉴权、协议校验、把 agent.invoke 路由到对应 agent 并回传事件 */
export class Hub {
  constructor(
    private readonly config: ServerConfig,
    private readonly agents: ServerAgent[],
  ) {}

  attach(wss: WebSocketServer): void {
    wss.on('connection', (ws) => this.handleConnection(ws))
  }

  private handleConnection(ws: WebSocket): void {
    let authed = false
    // requestId -> cancel 函数；连接断开时统一取消，避免进程在后台空跑
    const running = new Map<string, () => void>()

    const send = (msg: ServerMessage): void => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
    }

    ws.on('message', (raw) => {
      let data: unknown
      try {
        data = JSON.parse((raw as Buffer).toString('utf8'))
      } catch {
        send({ type: 'error', code: 'bad_json', message: '消息不是合法 JSON' })
        return
      }
      const parsed = ClientMessageSchema.safeParse(data)
      if (!parsed.success) {
        send({ type: 'error', code: 'bad_message', message: `消息不符合协议：${parsed.error.issues[0]?.message ?? ''}` })
        return
      }
      const msg = parsed.data

      if (!authed) {
        if (msg.type !== 'hello') {
          send({ type: 'error', code: 'unauthorized', message: '请先发送 hello 完成配对' })
          return
        }
        if (!safeEqual(msg.token, this.config.token)) {
          send({ type: 'error', code: 'bad_token', message: '配对 token 不正确' })
          ws.close(4001, 'bad token')
          return
        }
        authed = true
        send(this.welcome())
        return
      }

      switch (msg.type) {
        case 'hello':
          send(this.welcome())
          break
        case 'ping':
          send({ type: 'pong' })
          break
        case 'agents.list':
          send({ type: 'agents', agents: this.agents.map((agent) => agent.info) })
          break
        case 'agent.cancel':
          running.get(msg.requestId)?.()
          break
        case 'agent.invoke':
          this.invoke(msg, send, running)
          break
      }
    })

    ws.on('close', () => {
      for (const cancel of running.values()) cancel()
      running.clear()
    })
  }

  private invoke(
    msg: Extract<ClientMessage, { type: 'agent.invoke' }>,
    send: (msg: ServerMessage) => void,
    running: Map<string, () => void>,
  ): void {
    const agent = this.agents.find((candidate) => candidate.info.id === msg.agentId)
    if (!agent) {
      send({ type: 'error', code: 'agent_not_found', message: `找不到 agent：${msg.agentId}`, requestId: msg.requestId })
      return
    }
    if (running.has(msg.requestId)) {
      send({ type: 'error', code: 'request_exists', message: 'requestId 已存在，请换一个', requestId: msg.requestId })
      return
    }

    const emit = (event: AgentEvent): void => send({ type: 'agent.event', requestId: msg.requestId, event })
    const cleanup = (): void => {
      running.delete(msg.requestId)
    }
    running.set(msg.requestId, () => agent.cancel?.(msg.requestId))

    agent
      .invoke(msg.action, msg.params ?? {}, {
        requestId: msg.requestId,
        emit,
        workspaceRoot: this.config.workspaceRoot,
        allowShell: this.config.allowShell,
      })
      .then(cleanup)
      .catch((err: unknown) => {
        emit({ kind: 'failed', error: err instanceof Error ? err.message : String(err) })
        cleanup()
      })
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
      agents: this.agents.map((agent) => agent.info),
    }
  }
}
