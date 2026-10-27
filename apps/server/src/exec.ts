import { spawn, type ChildProcess } from 'node:child_process'

export type OutputStream = 'stdout' | 'stderr'

export function pumpOutput(
  child: ChildProcess,
  onChunk: (stream: OutputStream, chunk: string) => void,
): void {
  child.stdout?.on('data', (data: Buffer) => onChunk('stdout', data.toString('utf8')))
  child.stderr?.on('data', (data: Buffer) => onChunk('stderr', data.toString('utf8')))
}

/** 等待进程退出且 stdio 全部关闭（保证输出已排干） */
export function waitClose(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(child.exitCode)
      return
    }
    child.once('close', (code) => resolve(code))
  })
}

/** Windows 下用 taskkill 连带子进程树一起杀，其他平台退回 SIGKILL */
export function killTree(child: ChildProcess): void {
  if (child.pid == null || child.exitCode !== null) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  } else {
    child.kill('SIGKILL')
  }
}
