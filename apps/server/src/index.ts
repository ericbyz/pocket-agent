import os from 'node:os'
import { createRequire } from 'node:module'
import { loadConfig } from './config'
import { startServer } from './server'

const require = createRequire(import.meta.url)
const pkg = require('../package.json') as { version?: string }

function lanAddresses(port: number): string[] {
  const addresses: string[] = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) addresses.push(`ws://${ni.address}:${port}`)
    }
  }
  return addresses
}

async function main(): Promise<void> {
  const config = loadConfig()
  if (pkg.version) config.version = pkg.version
  await startServer(config)

  console.log('')
  console.log(`  ⚡ Pocket Agent Server v${config.version}`)
  console.log('  ──────────────────────────────────────────────')
  for (const addr of lanAddresses(config.port)) console.log(`  局域网地址    ${addr}`)
  console.log(`  本机地址      ws://127.0.0.1:${config.port}`)
  console.log(`  配对 token    ${config.token}`)
  console.log(`  工作区        ${config.workspaceRoot}`)
  console.log(
    `  shell 执行    ${config.allowShell ? '已开启（PA_ALLOW_SHELL=1）' : '关闭（设置 PA_ALLOW_SHELL=1 开启）'}`,
  )
  console.log(
    `  coding agent  ${
      config.codingCommand
        ? `已配置：${config.codingCommand} ${JSON.stringify(config.codingArgsTemplate)}`
        : '未配置（可选，见 README）'
    }`,
  )
  if (!config.codingCommand && process.env.PA_CODING_ARGS) {
    console.log('  ⚠ PA_CODING_ARGS 不是合法的字符串数组，coding agent 未启用')
  }
  console.log('')
  console.log('  在手机 App 中填入上方地址与 token 即可连接。Ctrl+C 退出。')
  console.log('')
}

main().catch((err) => {
  console.error('服务端启动失败：', err)
  process.exit(1)
})
