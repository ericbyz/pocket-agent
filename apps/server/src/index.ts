import { createRequire } from 'node:module'
import { loadConfig } from './config'
import { printBanner } from './banner'
import { startServer } from './server'

const require = createRequire(import.meta.url)
const pkg = require('../package.json') as { version?: string }

async function main(): Promise<void> {
  const config = loadConfig()
  if (pkg.version) config.version = pkg.version
  printBanner(config, config.version)
  const running = await startServer(config)

  let shuttingDown = false
  const shutdown = (signal: string): void => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`\n  收到 ${signal}，正在停止：取消运行中任务并落库 …`)
    running.tasks.cancelAll('服务端停止')
    running
      .close()
      .then(() => process.exit(0))
      .catch(() => process.exit(1))
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('uncaughtException', (err) => {
    console.error('未捕获异常：', err)
    shutdown('uncaughtException')
  })
}

main().catch((err) => {
  if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
    console.error(`端口已被占用（${loadConfig().port}）：换一个端口 PA_PORT=xxxx 再试`)
  } else {
    console.error('服务端启动失败：', err)
  }
  process.exit(1)
})
