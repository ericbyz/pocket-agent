import { spawn, type ChildProcess } from 'node:child_process'
import os from 'node:os'
import type { AgentInfo } from '@pocket-agent/protocol'
import type { AgentContext, InvokeContext, ServerAgent } from './types'
import { asRecord, optionalNumber, optionalString, requireString } from './params'
import { killTree, pumpOutput, waitClose } from '../exec'

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 10 * 60_000
const INTERACTIVE_TIMEOUT_MS = 2 * 60 * 60_000

/** PowerShell 单引号字面量转义 */
function psQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

const MOUSE_HELPER = `
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;
public static class PAM{
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint dx,uint dy,uint data,UIntPtr e);
  public static void Click(uint f){mouse_event(f,0,0,0,UIntPtr.Zero);mouse_event(f*2,0,0,0,UIntPtr.Zero);}
  public static void Wheel(int d){mouse_event(0x800,0,0,(uint)d,UIntPtr.Zero);}
}';
`.trim()

const MOUSE_BUTTON_FLAGS: Record<string, number> = { left: 0x2, right: 0x8, middle: 0x20 }

/** SendKeys 特殊字符转义 */
function sendKeysEscape(text: string): string {
  return text.replace(/[+^%~(){}\[\]]/g, (ch) => `{${ch}}`)
}

const SPECIAL_KEYS = new Set([
  'enter', 'esc', 'tab', 'backspace', 'delete', 'space', 'up', 'down', 'left', 'right',
  'home', 'end', 'pageup', 'pagedown', 'insert',
  ...Array.from({ length: 24 }, (_, i) => `f${i + 1}`),
])

function buildCombo(key: string, ctrl?: boolean, alt?: boolean, shift?: boolean): string {
  const lower = key.toLowerCase()
  if (!SPECIAL_KEYS.has(lower)) throw new Error(`不支持的按键：${key}（可用：字母数字、enter/esc/tab/方向键/f1-f24 等）`)
  const body = lower === 'space' ? ' ' : lower === 'backspace' ? '{BS}' : `{${lower.toUpperCase()}}`
  return `${ctrl ? '^' : ''}${alt ? '%' : ''}${shift ? '+' : ''}${body}`
}

/**
 * Windows 本机操作 agent：交互式终端、进程、剪贴板、截屏、电源、鼠标键盘注入。
 * 高危动作（终端 / 进程 / 电源 / 鼠标键盘）需要 PA_ALLOW_SHELL=1。
 */
export class ComputerAgent implements ServerAgent {
  readonly info: AgentInfo = {
    id: 'computer',
    name: '💻 Computer Agent',
    description: '控制这台 Windows：交互式终端、截屏、进程、剪贴板、鼠标键盘、电源',
    actions: [
      { name: 'run_command', description: '执行 PowerShell 命令；interactive:true 进入双向终端（需 PA_ALLOW_SHELL=1）' },
      { name: 'screenshot', description: '截取整个虚拟屏幕，返回 PNG（含坐标信息，可配合鼠标动作点选）' },
      { name: 'sysinfo', description: '读取主机名、系统版本、CPU、内存等信息' },
      { name: 'processes', description: '列出占用内存最高的进程' },
      { name: 'kill_process', description: '结束进程（需 PA_ALLOW_SHELL=1）' },
      { name: 'clipboard_get', description: '读取剪贴板文本' },
      { name: 'clipboard_set', description: '写入剪贴板文本' },
      { name: 'open', description: '打开 URL / 文件 / 应用（需 PA_ALLOW_SHELL=1）' },
      { name: 'power', description: '锁屏 / 睡眠 / 关机 / 重启（需 PA_ALLOW_SHELL=1 且 confirm:true）' },
      { name: 'mouse_move', description: '移动鼠标到虚拟屏幕坐标（需 PA_ALLOW_SHELL=1）' },
      { name: 'mouse_click', description: '点击鼠标（需 PA_ALLOW_SHELL=1）' },
      { name: 'scroll', description: '滚动滚轮（需 PA_ALLOW_SHELL=1）' },
      { name: 'key_type', description: '输入一段文本（需 PA_ALLOW_SHELL=1）' },
      { name: 'key_tap', description: '按键 / 组合键，如 ctrl+s（需 PA_ALLOW_SHELL=1）' },
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
      case 'processes':
        return this.processes(ctx)
      case 'kill_process':
        return this.killProcess(params, ctx)
      case 'clipboard_get':
        return this.clipboardGet(ctx)
      case 'clipboard_set':
        return this.clipboardSet(params, ctx)
      case 'open':
        return this.open(params, ctx)
      case 'power':
        return this.power(params, ctx)
      case 'mouse_move':
        return this.mouseMove(params, ctx)
      case 'mouse_click':
        return this.mouseClick(params, ctx)
      case 'scroll':
        return this.scroll(params, ctx)
      case 'key_type':
        return this.keyType(params, ctx)
      case 'key_tap':
        return this.keyTap(params, ctx)
      default:
        throw new Error(`computer agent 不支持的动作：${action}`)
    }
  }

  cancel(requestId: string): void {
    const child = this.running.get(requestId)
    if (child) killTree(child)
  }

  // ---- 终端 ---------------------------------------------------------------

  private async runCommand(rawParams: unknown, ctx: AgentContext & InvokeContext): Promise<void> {
    const params = asRecord(rawParams)
    const interactive = params['interactive'] === true
    const command = optionalString(params, 'command', '')
    const timeoutMs = optionalNumber(params, 'timeoutMs', {
      min: 1_000,
      max: MAX_TIMEOUT_MS,
      fallback: interactive ? INTERACTIVE_TIMEOUT_MS : DEFAULT_TIMEOUT_MS,
    })
    if (!ctx.allowShell) {
      ctx.emit({ kind: 'failed', error: 'shell 执行未启用：在服务端设置 PA_ALLOW_SHELL=1 并重启后才能运行命令' })
      return
    }
    if (!interactive && command.length === 0) {
      ctx.emit({ kind: 'failed', error: '缺少必填参数 command（或使用 interactive:true 打开双向终端）' })
      return
    }

    ctx.emit({ kind: 'started' })

    if (interactive) {
      // 双向 REPL：stdin 保持打开，手机端通过 agent.input 逐行输入
      const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
      this.running.set(ctx.requestId, child)
      ctx.setInput((data) => child.stdin?.write(data))
      const timer = setTimeout(() => killTree(child), timeoutMs)
      pumpOutput(child, (stream, chunk) => ctx.emit({ kind: 'output', stream, chunk }))
      const exitCode = await waitClose(child)
      clearTimeout(timer)
      this.running.delete(ctx.requestId)
      ctx.setInput(null)
      ctx.emit({ kind: 'completed', result: { exitCode } })
      return
    }

    // 单发：用 -EncodedCommand 传递脚本，避免引号转义问题；先固定输出编码为 UTF-8
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

  // ---- 只读信息 -----------------------------------------------------------

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
      "$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)",
      '[pscustomobject]@{ x = $vs.X; y = $vs.Y; w = $vs.Width; h = $vs.Height; b64 = [Convert]::ToBase64String($ms.ToArray()) } | ConvertTo-Json -Compress',
    ].join('; ')
    const stdout = await this.execScript(script)
    const shot = JSON.parse(stdout) as { x: number; y: number; w: number; h: number; b64: string }
    ctx.emit({
      kind: 'completed',
      result: {
        image: `data:image/png;base64,${shot.b64}`,
        width: shot.w,
        height: shot.h,
        originX: shot.x,
        originY: shot.y,
      },
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

  private async processes(ctx: AgentContext & InvokeContext): Promise<void> {
    ctx.emit({ kind: 'started' })
    const script = [
      '$p = Get-Process | Sort-Object WS -Descending | Select-Object -First 30 Name,Id,@{n="memMB";e={[math]::Round($_.WS/1MB,1)}},@{n="cpuS";e={if($_.CPU){[math]::Round($_.CPU,1)}}}',
      '$p | ConvertTo-Json -Compress',
    ].join('; ')
    const stdout = await this.execScript(script)
    const parsed = JSON.parse(stdout) as unknown
    const list = Array.isArray(parsed) ? parsed : [parsed]
    ctx.emit({ kind: 'completed', result: { processes: list } })
  }

  // ---- 需要 PA_ALLOW_SHELL 的本机控制 ------------------------------------

  private async killProcess(rawParams: unknown, ctx: AgentContext & InvokeContext): Promise<void> {
    this.requireShell(ctx)
    const params = asRecord(rawParams)
    const pid = optionalNumber(params, 'pid', { fallback: 0 })
    const name = optionalString(params, 'name', '')
    if (pid <= 0 && !name) throw new Error('需要 pid 或 name 参数')
    const script = pid > 0 ? `Stop-Process -Id ${pid} -Force` : `Get-Process ${psQuote(name)} | Stop-Process -Force`
    await this.runSimple(script, ctx)
  }

  private async clipboardGet(ctx: AgentContext & InvokeContext): Promise<void> {
    ctx.emit({ kind: 'started' })
    const text = await this.execScript('Get-Clipboard -Raw')
    ctx.emit({ kind: 'completed', result: { text } })
  }

  private async clipboardSet(rawParams: unknown, ctx: AgentContext & InvokeContext): Promise<void> {
    const text = requireString(asRecord(rawParams), 'text')
    ctx.emit({ kind: 'started' })
    await this.execScript(`Set-Clipboard -Value ${psQuote(text)}`)
    ctx.emit({ kind: 'completed', result: { bytes: Buffer.byteLength(text, 'utf8') } })
  }

  private async open(rawParams: unknown, ctx: AgentContext & InvokeContext): Promise<void> {
    this.requireShell(ctx)
    const target = requireString(asRecord(rawParams), 'target')
    ctx.emit({ kind: 'started' })
    await this.execScript(`Start-Process ${psQuote(target)}`)
    ctx.emit({ kind: 'completed', result: { opened: target } })
  }

  private async power(rawParams: unknown, ctx: AgentContext & InvokeContext): Promise<void> {
    this.requireShell(ctx)
    const params = asRecord(rawParams)
    const action = requireString(params, 'action')
    if (params['confirm'] !== true) throw new Error('电源操作是危险动作，请带上 confirm: true')
    const commands: Record<string, string> = {
      lock: 'rundll32.exe user32.dll,LockWorkStation',
      sleep: 'rundll32.exe powrprof.dll,SetSuspendState 0,1,0',
      shutdown: 'shutdown /s /t 5',
      restart: 'shutdown /r /t 5',
    }
    const cmd = commands[action]
    if (!cmd) throw new Error(`不支持的电源动作：${action}（lock/sleep/shutdown/restart）`)
    ctx.emit({ kind: 'started' })
    if (action === 'lock' || action === 'sleep') {
      // 锁屏/睡眠会中断会话，不等 PowerShell 返回
      spawn('cmd.exe', ['/c', cmd], { stdio: 'ignore', windowsHide: true, detached: true }).unref()
    } else {
      await this.execScript(cmd)
    }
    ctx.emit({ kind: 'completed', result: { action } })
  }

  // ---- 鼠标 / 键盘（虚拟屏幕坐标 = 截图结果里的 origin + 归一化 × 尺寸）--

  private async mouseMove(rawParams: unknown, ctx: AgentContext & InvokeContext): Promise<void> {
    this.requireShell(ctx)
    const params = asRecord(rawParams)
    const x = Math.round(optionalNumber(params, 'x', { fallback: Number.NaN }))
    const y = Math.round(optionalNumber(params, 'y', { fallback: Number.NaN }))
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('需要 x / y（虚拟屏幕像素坐标）')
    await this.runSimple(`${MOUSE_HELPER} [PAM]::SetCursorPos(${x}, ${y}) | Out-Null`, ctx)
  }

  private async mouseClick(rawParams: unknown, ctx: AgentContext & InvokeContext): Promise<void> {
    this.requireShell(ctx)
    const params = asRecord(rawParams)
    const button = optionalString(params, 'button', 'left')
    const flag = MOUSE_BUTTON_FLAGS[button]
    if (!flag) throw new Error(`不支持的按键：${button}（left/right/middle）`)
    const x = optionalNumber(params, 'x', { fallback: Number.NaN })
    const y = optionalNumber(params, 'y', { fallback: Number.NaN })
    const move = Number.isFinite(x) && Number.isFinite(y) ? `[PAM]::SetCursorPos(${Math.round(x)}, ${Math.round(y)}) | Out-Null; ` : ''
    const double = params['double'] === true
    const click = double
      ? `[PAM]::Click(${flag}); Start-Sleep -Milliseconds 60; [PAM]::Click(${flag})`
      : `[PAM]::Click(${flag})`
    await this.runSimple(`${MOUSE_HELPER} ${move}${click}`, ctx)
  }

  private async scroll(rawParams: unknown, ctx: AgentContext & InvokeContext): Promise<void> {
    this.requireShell(ctx)
    const delta = Math.round(optionalNumber(asRecord(rawParams), 'delta', { fallback: 0 }))
    if (delta === 0) throw new Error('需要 delta（正数向上，负数向下，单位约 120/格）')
    await this.runSimple(`${MOUSE_HELPER} [PAM]::Wheel(${delta})`, ctx)
  }

  private async keyType(rawParams: unknown, ctx: AgentContext & InvokeContext): Promise<void> {
    this.requireShell(ctx)
    const text = requireString(asRecord(rawParams), 'text')
    await this.runSimple(
      `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait(${psQuote(sendKeysEscape(text))})`,
      ctx,
    )
  }

  private async keyTap(rawParams: unknown, ctx: AgentContext & InvokeContext): Promise<void> {
    this.requireShell(ctx)
    const params = asRecord(rawParams)
    const key = requireString(params, 'key')
    const combo = buildCombo(key, params['ctrl'] === true, params['alt'] === true, params['shift'] === true)
    await this.runSimple(
      `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait(${psQuote(combo)})`,
      ctx,
    )
  }

  // ---- 工具 ---------------------------------------------------------------

  private requireShell(ctx: AgentContext): void {
    if (!ctx.allowShell) throw new Error('该动作需要 PA_ALLOW_SHELL=1')
  }

  private async runSimple(script: string, ctx: AgentContext & InvokeContext): Promise<void> {
    ctx.emit({ kind: 'started' })
    await this.execScript(script)
    ctx.emit({ kind: 'completed', result: {} })
  }

  private execScript(script: string): Promise<string> {
    const full = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ' + script
    return new Promise((resolve, reject) => {
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(full, 'utf16le').toString('base64')],
        { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
      )
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (data: Buffer) => {
        stdout += data.toString('utf8')
      })
      child.stderr.on('data', (data: Buffer) => {
        stderr += data.toString('utf8')
      })
      child.once('close', (code) => {
        if (code === 0) resolve(stdout.trim())
        else reject(new Error(stderr.trim() || `PowerShell 退出码 ${code ?? 'null'}`))
      })
      child.once('error', reject)
    })
  }
}
