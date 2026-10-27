import type { AgentEvent, AgentInfo } from '@pocket-agent/protocol'

/** agent 运行期可用的环境与限制 */
export interface AgentContext {
  workspaceRoot: string
  allowShell: boolean
}

/** 单次调用上下文：agent 通过 emit 把事件流回手机 */
export interface InvokeContext {
  requestId: string
  emit: (event: AgentEvent) => void
}

export interface ServerAgent {
  info: AgentInfo
  /**
   * 执行一个动作。约定：正常路径下 agent 自己发出恰好一个终止事件
   * （completed 或 failed）；抛异常时由 Hub 兜底发出 failed。
   */
  invoke(action: string, params: unknown, ctx: AgentContext & InvokeContext): Promise<void>
  /** 尽力取消一次仍在进行的调用；短操作可不实现 */
  cancel?(requestId: string): void
}
