import { randomBytes } from 'node:crypto'
import path from 'node:path'

export interface ServerConfig {
  name: string
  version: string
  host: string
  port: number
  /** 配对 token，手机端必须携带相同 token 才能连接 */
  token: string
  /** 文件类操作的工作区根目录，agent 不能越出该目录 */
  workspaceRoot: string
  /** 是否允许执行 shell 命令（PA_ALLOW_SHELL=1） */
  allowShell: boolean
  /** coding agent 的可执行命令，如 "zcode"、"claude"；未配置则不注册该 agent */
  codingCommand: string | null
  /** coding agent 的参数模板，元素中的 {{prompt}} 会被替换为任务描述 */
  codingArgsTemplate: string[] | null
}

const DEFAULT_PORT = 4310

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const token = env.PA_TOKEN && env.PA_TOKEN.length > 0 ? env.PA_TOKEN : randomBytes(16).toString('hex')
  const workspaceRoot = path.resolve(
    env.PA_WORKSPACE && env.PA_WORKSPACE.length > 0 ? env.PA_WORKSPACE : process.cwd(),
  )

  let codingCommand: string | null = env.PA_CODING_COMMAND || null
  let codingArgsTemplate: string[] | null = null
  if (env.PA_CODING_ARGS) {
    try {
      const parsed: unknown = JSON.parse(env.PA_CODING_ARGS)
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
        codingArgsTemplate = parsed
      }
    } catch {
      // JSON 不合法时保持 null，启动横幅里会提示
    }
  }
  if (codingCommand && !codingArgsTemplate) codingArgsTemplate = ['{{prompt}}']

  return {
    name: 'pocket-agent-server',
    version: '0.1.0',
    host: env.PA_HOST || '0.0.0.0',
    port: Number.parseInt(env.PA_PORT || '', 10) || DEFAULT_PORT,
    token,
    workspaceRoot,
    allowShell: env.PA_ALLOW_SHELL === '1',
    codingCommand,
    codingArgsTemplate,
  }
}
