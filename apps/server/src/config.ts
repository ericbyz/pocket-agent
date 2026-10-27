import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import fs from 'node:fs'
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
  /** coding agent 的可执行命令；未配置则不注册该 agent */
  codingCommand: string | null
  /** coding agent 的参数模板，元素中的 {{prompt}} 会被替换为任务描述 */
  codingArgsTemplate: string[] | null
  /** SQLite 数据目录（任务历史 + 事件回放缓冲） */
  dataDir: string
  /** 同时运行的任务上限，超出排队 */
  maxConcurrent: number
  /** 任务完成通知（ntfy / webhook URL），仅在无客户端连接时触发 */
  notifyUrl: string | null
  /** 客户端断开时是否取消其发起的运行中任务（默认保留，重连可恢复） */
  cancelOnDisconnect: boolean
}

const DEFAULT_PORT = 4310

interface ConfigFile {
  host?: string
  port?: number
  token?: string
  workspace?: string
  allowShell?: boolean
  codingCommand?: string
  codingArgs?: string[]
  dataDir?: string
  maxConcurrent?: number
  notifyUrl?: string
  cancelOnDisconnect?: boolean
}

function readConfigFile(env: NodeJS.ProcessEnv): ConfigFile {
  const file = env.PA_CONFIG && env.PA_CONFIG.length > 0 ? env.PA_CONFIG : path.join(process.cwd(), 'pocket-agent.json')
  if (!existsSync(file)) return {}
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as ConfigFile
  } catch (err) {
    console.warn(`⚠ 配置文件 ${file} 解析失败，已忽略：${err instanceof Error ? err.message : err}`)
    return {}
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const file = readConfigFile(env)

  const token =
    env.PA_TOKEN || file.token || randomBytes(16).toString('hex')
  const workspaceRoot = path.resolve(env.PA_WORKSPACE || file.workspace || process.cwd())

  let codingCommand: string | null = env.PA_CODING_COMMAND || file.codingCommand || null
  let codingArgsTemplate: string[] | null = null
  const codingArgsRaw = env.PA_CODING_ARGS || (file.codingArgs ? JSON.stringify(file.codingArgs) : null)
  if (codingArgsRaw) {
    try {
      const parsed: unknown = JSON.parse(codingArgsRaw)
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
        codingArgsTemplate = parsed
      }
    } catch {
      // JSON 不合法时保持 null，启动横幅里会提示
    }
  }
  if (codingCommand && !codingArgsTemplate) codingArgsTemplate = ['{{prompt}}']

  const maxConcurrent =
    Number.parseInt(env.PA_MAX_CONCURRENT || '', 10) || file.maxConcurrent || 3

  return {
    name: 'pocket-agent-server',
    version: '0.2.0',
    host: env.PA_HOST || file.host || '0.0.0.0',
    port: Number.parseInt(env.PA_PORT || '', 10) || file.port || DEFAULT_PORT,
    token,
    workspaceRoot,
    allowShell: env.PA_ALLOW_SHELL === '1' || file.allowShell === true,
    codingCommand,
    codingArgsTemplate,
    dataDir: path.resolve(env.PA_DATA_DIR || file.dataDir || path.join(process.cwd(), 'data')),
    maxConcurrent: maxConcurrent >= 1 ? maxConcurrent : 1,
    notifyUrl: env.PA_NOTIFY_URL || file.notifyUrl || null,
    cancelOnDisconnect: env.PA_CANCEL_ON_DISCONNECT === '1' || file.cancelOnDisconnect === true,
  }
}
