const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g

/** 终端输出清理：去 ANSI 控制序列，规范 \r */
export function cleanTerminalText(raw: string): string {
  return raw.replace(ANSI_RE, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}
