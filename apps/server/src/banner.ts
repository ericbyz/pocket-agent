import os from 'node:os'
import qrcode from 'qrcode-terminal'
import type { ServerConfig } from './config'

export interface LanAddress {
  ip: string
  url: string
}

export function lanAddresses(port: number): LanAddress[] {
  const addresses: LanAddress[] = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) {
        addresses.push({ ip: ni.address, url: `ws://${ni.address}:${port}` })
      }
    }
  }
  // 常见内网段（192.168 / 10. / 172.16-31）优先，虚拟网卡（172 常见）排后
  const rank = (ip: string): number => {
    if (ip.startsWith('192.168.')) return 0
    if (ip.startsWith('10.')) return 1
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2
    return 3
  }
  return addresses.sort((a, b) => rank(a.ip) - rank(b.ip))
}

function pairUrl(ip: string, port: number, token: string): string {
  const q = `host=${encodeURIComponent(ip)}&port=${port}&token=${encodeURIComponent(token)}`
  return `pocket-agent://connect?${q}`
}

/** 打印启动横幅；返回用于日志的主地址 */
export function printBanner(config: ServerConfig, version: string): void {
  const addrs = lanAddresses(config.port)
  const primary = addrs[0]

  console.log('')
  console.log(`  ⚡ Pocket Agent Server v${version}`)
  console.log('  ──────────────────────────────────────────────')
  for (const addr of addrs) console.log(`  局域网地址    ${addr.url}`)
  console.log(`  本机地址      ws://127.0.0.1:${config.port}`)
  console.log(`  配对 token    ${config.token}`)
  console.log(`  工作区        ${config.workspaceRoot}`)
  console.log(`  数据目录      ${config.dataDir}`)
  console.log(
    `  shell/控制类  ${config.allowShell ? '已开启（PA_ALLOW_SHELL=1）' : '关闭（设置 PA_ALLOW_SHELL=1 开启终端/鼠标键盘等）'}`,
  )
  console.log(
    `  coding agent  ${
      config.codingCommand
        ? `已配置：${config.codingCommand} ${JSON.stringify(config.codingArgsTemplate)}`
        : '未配置（可选，见 README）'
    }`,
  )
  if (config.notifyUrl) console.log(`  完成通知      ${config.notifyUrl}（无客户端连接时推送）`)
  console.log(`  并发任务上限  ${config.maxConcurrent}`)
  console.log('')
  if (primary) {
    console.log('  手机 App 扫码配对（或手动输入上面的地址与 token）：')
    console.log('')
    qrcode.generate(pairUrl(primary.ip, config.port, config.token), { small: true }, (code) => {
      console.log(code)
    })
    console.log(`  备用手动配对：${pairUrl(primary.ip, config.port, config.token)}`)
    console.log('')
  }
  console.log('  断线重连：任务在服务端继续执行，事件落库，App 重连后自动补发。Ctrl+C 退出。')
  console.log('')
}
