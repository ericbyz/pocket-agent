import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { AgentInfo } from '@pocket-agent/protocol'
import type { AgentContext, InvokeContext, ServerAgent } from './types'
import { asRecord, optionalNumber, optionalString, requireString } from './params'
import { killTree, pumpOutput, waitClose } from '../exec'

const DEFAULT_TIMEOUT_MS = 30 * 60_000
const MAX_TIMEOUT_MS = 2 * 60 * 60_000

/**
 * 编码 agent：在项目目录里驱动一个 CLI 编码 agent（如 zcode / claude / codex），
 * 把 stdout/stderr 实时流回手机。命令与参数由环境变量配置：
 *   PA_CODING_COMMAND=zcode
 *   PA_CODING_ARGS=["-p","{{prompt}}"]
 * 参数模板里的 {{prompt}} 会被替换为任务描述；spawn 不经过 shell，无注入风险。
 */
export class CodingAgent implements ServerAgent {
  readonly info: AgentInfo
  private running = new Map<string, ChildProcess>()

  constructor(
    private readonly command: string,
    private readonly argsTemplate: string[],
  ) {
    this.info = {
      id: 'coding',
      name: '🧑‍💻 Coding Agent',
      description: `在项目目录里运行编码 CLI（${command}），输出实时回传手机`,
      actions: [
        { name: 'run_task', description: '执行一次编码任务：参数模板中的 {{prompt}} 会被替换为任务描述' },
      ],
    }
  }

  async invoke(action: string, params: unknown, ctx: AgentContext & InvokeContext): Promise<void> {
    if (action !== 'run_task') {
      throw new Error(`coding agent 不支持的动作：${action}`)
    }
    const record = asRecord(params)
    const prompt = requireString(record, 'prompt')
    const relCwd = optionalString(record, 'cwd', '.')
    const timeoutMs = optionalNumber(record, 'timeoutMs', {
      min: 5_000,
      max: MAX_TIMEOUT_MS,
      fallback: DEFAULT_TIMEOUT_MS,
    })

    const root = path.resolve(ctx.workspaceRoot)
    const cwd = path.resolve(root, relCwd)
    const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep
    if (cwd !== root && !cwd.startsWith(rootWithSep)) {
      throw new Error('cwd 超出工作区范围（PA_WORKSPACE）')
    }
    await fs.access(cwd)

    ctx.emit({ kind: 'started' })
    const args = this.argsTemplate.map((arg) => arg.replaceAll('{{prompt}}', prompt))
    const child = spawn(this.command, args, { cwd, windowsHide: true })
    this.running.set(ctx.requestId, child)
    const timer = setTimeout(() => {
      ctx.emit({ kind: 'output', stream: 'info', chunk: '\n[pocket-agent] 任务超时，已强制终止\n' })
      killTree(child)
    }, timeoutMs)

    try {
      pumpOutput(child, (stream, chunk) => ctx.emit({ kind: 'output', stream, chunk }))
      const exitCode = await waitClose(child)
      ctx.emit({ kind: 'completed', result: { exitCode } })
    } finally {
      clearTimeout(timer)
      this.running.delete(ctx.requestId)
    }
  }

  cancel(requestId: string): void {
    const child = this.running.get(requestId)
    if (child) killTree(child)
  }
}
