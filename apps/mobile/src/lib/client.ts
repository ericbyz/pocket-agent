import type { AgentEvent, AgentInfo, ClientMessage, ServerInfo, ServerMessage } from '@pocket-agent/protocol'

export type ClientState = 'idle' | 'connecting' | 'connected' | 'error'

export interface AgentClientCallbacks {
  onState: (state: ClientState, detail?: string) => void
  onWelcome: (server: ServerInfo, agents: AgentInfo[]) => void
  onAgents: (agents: AgentInfo[]) => void
}

type AgentEventListener = (requestId: string, event: AgentEvent) => void

/** 服务端连接封装：hello 配对、消息分发、agent 调用与事件订阅 */
export class AgentClient {
  private ws: WebSocket | null = null
  private listeners = new Set<AgentEventListener>()

  constructor(private readonly callbacks: AgentClientCallbacks) {}

  subscribeEvents(listener: AgentEventListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  connect(host: string, port: string, token: string): void {
    this.disconnect()
    this.callbacks.onState('connecting', `正在连接 ${host}:${port} …`)
    const ws = new WebSocket(`ws://${host}:${port}`)
    this.ws = ws
    ws.onopen = () => {
      this.send({ type: 'hello', protocol: 1, token, clientName: 'pocket-agent-mobile' })
    }
    ws.onmessage = (ev) => this.handleMessage(String(ev.data))
    ws.onerror = () => {
      this.callbacks.onState('error', '连接失败：请检查地址、端口以及服务端是否在运行')
    }
    ws.onclose = () => {
      if (this.ws === ws) {
        this.ws = null
        this.callbacks.onState('idle', '连接已断开')
      }
    }
  }

  disconnect(): void {
    const ws = this.ws
    this.ws = null
    if (ws) {
      ws.onclose = null
      ws.onerror = null
      ws.onmessage = null
      ws.close()
    }
    this.callbacks.onState('idle')
  }

  listAgents(): void {
    this.send({ type: 'agents.list' })
  }

  invoke(agentId: string, action: string, params: unknown): string {
    const requestId = `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    this.send({ type: 'agent.invoke', requestId, agentId, action, params })
    return requestId
  }

  cancel(requestId: string): void {
    this.send({ type: 'agent.cancel', requestId })
  }

  private send(msg: ClientMessage): void {
    this.ws?.send(JSON.stringify(msg))
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
        this.callbacks.onState('connected')
        this.callbacks.onWelcome(msg.server, msg.agents)
        break
      case 'agents':
        this.callbacks.onAgents(msg.agents)
        break
      case 'agent.event':
        for (const listener of this.listeners) listener(msg.requestId, msg.event)
        break
      case 'error':
        this.callbacks.onState('error', `服务端错误 ${msg.code}：${msg.message}`)
        break
      case 'pong':
        break
    }
  }
}
