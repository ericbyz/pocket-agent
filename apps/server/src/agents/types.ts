import type { AgentEvent, AgentInfo } from '@pocket-agent/protocol'

/** agent 运行期可用的环境与限制 */
export interface AgentContext {
  workspaceRoot: string
  allowShell: boolean
}

/**
 * 单次调用上下文：
 * - emit 把事件流回手机（自动持久化 + seq 编号）
 * - setInput 注册 stdin 写入函数（交互式终端 / 多轮 CLI agent）
 * - setChannel 注册上传分片接收函数（files agent 上传用）
 */
export interface InvokeContext {
  requestId: string
  emit: (event: AgentEvent) => void
  setInput: (handler: ((data: string) => void) | null) => void
  setChannel: (handler: ((kind: 'chunk' | 'end', data?: string) => void) | null) => void
}

export interface ServerAgent {
  info: AgentInfo
  /**
   * 执行一个动作。约定：正常路径下 agent 自己发出恰好一个终止事件
   * （completed 或 failed）；抛异常时由 TaskManager 兜底发出 failed。
   * 长任务应注册 setInput 支持交互，并实现 cancel 响应取消。
   */
  invoke(action: string, params: unknown, ctx: AgentContext & InvokeContext): Promise<void>
  /** 尽力取消一次仍在进行的调用 */
  cancel?(requestId: string): void
}
