import { spawn, type ChildProcess } from 'node:child_process'
import os from 'node:os'
import type { AgentInfo } from '@pocket-agent/protocol'
import type { AgentContext, InvokeContext, ServerAgent } from './types'
import { asRecord, optionalNumber, requireString } from './params'
import { killTree, pumpOutput, waitClose } from '../exec'

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 10 * 60_000

/** Windows 本机操作：执行 PowerShell 命令、截屏、系统信息 */
export class ComputerAgent implements ServerAgent {
  readonly info: AgentInfo = {
    id: 'computer',
    name: '💻 Computer Agent',
    description: '在本机执行 PowerShell 命令、截取屏幕、读取系统信息',
    actions: [
      { name: 'run_command', description: '执行 PowerShell 命令（服务端需开启 PA_ALLOW_SHELL=1）' },
      { name: 'screenshot', description: '截取整个虚拟屏幕，返回 PNG 截图' },
      { name: 'sysinfo', description: '读取主机名、系统版本、CPU、内存等信息' },
    ],
  }

  private running = new Map<string, ChildProcess>()

  async invoke(action: string, params: unknown, ctx: AgentContext & InvokeContext): Promise<void> {
    switch (action) {
      case 'run_command':
        return this.runCommand(params, ctx)
      case 'screenshot':
        return this.screenshot(ctx)
      case 'sysinfo':
        return this.sysinfo(ctx)
      default:
        throw new Error(`computer agent 不支持的动作：${action}`)
    }
  }

  cancel(requestId: string): void {
    const child = this.running.get(requestId)
    if (child) killTree(child)
  }

  private async runCommand(rawParams: unknown, ctx: AgentContext & InvokeContext): Promise<void> {
    const params = asRecord(rawParams)
    const command = requireString(params, 'command')
    const timeoutMs = optionalNumber(params, 'timeoutMs', {
      min: 1_000,
      max: MAX_TIMEOUT_MS,
      fallback: DEFAULT_TIMEOUT_MS,
    })
    if (!ctx.allowShell) {
      ctx.emit({ kind: 'failed', error: 'shell 执行未启用：在服务端设置 PA_ALLOW_SHELL=1 并重启后才能运行命令' })
      return
    }

    ctx.emit({ kind: 'started' })
    // 用 -EncodedCommand 传递脚本，避免引号转义问题；先固定输出编码为 UTF-8，避免中文乱码
    const script = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n' + command
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    )
    this.running.set(ctx.requestId, child)
    const timer = setTimeout(() => {
      ctx.emit({ kind: 'output', stream: 'info', chunk: `\n[pocket-agent] 已超过 ${timeoutMs}ms，强制终止\n` })
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

  private async screenshot(ctx: AgentContext & InvokeContext): Promise<void> {
    ctx.emit({ kind: 'started' })
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      'Add-Type -AssemblyName System.Drawing',
      '$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen',
      '$bmp = New-Object System.Drawing.Bitmap $vs.Width, $vs.Height',
      '$g = [System.Drawing.Graphics]::FromImage($bmp)',
      '$g.CopyFromScreen($vs.X, $vs.Y, 0, 0, $bmp.Size)',
      '$ms = New-Object System.IO.MemoryStream',
      '$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)',
      '[Convert]::ToBase64String($ms.ToArray())',
    ].join('; ')
    const base64 = (await this.execScript(script)).trim()
    ctx.emit({ kind: 'completed', result: { image: `data:image/png;base64,${base64}` } })
  }

  private execScript(script: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
      )
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (data: Buffer) => { stdout += data.toString('utf8') })
      child.stderr.on('data', (data: Buffer) => { stderr += data.toString('utf8') })
      child.once('close', (code) => {
        if (code === 0) resolve(stdout)
        else reject(new Error(stderr.trim() || `PowerShell 退出码 ${code ?? 'null'}`))
      })
      child.once('error', reject)
    })
  }

  private async sysinfo(ctx: AgentContext & InvokeContext): Promise<void> {
    ctx.emit({ kind: 'started' })
    ctx.emit({
      kind: 'completed',
      result: {
        hostname: os.hostname(),
        platform: `${os.type()} ${os.release()} (${os.arch()})`,
        cpuModel: os.cpus()[0]?.model ?? 'unknown',
        cpuCount: os.cpus().length,
        totalMemGb: Math.round((os.totalmem() / 2 ** 30) * 10) / 10,
        freeMemGb: Math.round((os.freemem() / 2 ** 30) * 10) / 10,
        uptimeHours: Math.round((os.uptime() / 3600) * 10) / 10,
      },
    })
  }
}
