import http from 'node:http'
import { WebSocketServer } from 'ws'
import type { ServerConfig } from './config'
import { createAgents } from './agents/registry'
import { Hub } from './hub'
import { Store } from './store'
import { TaskManager } from './task-manager'

export interface RunningServer {
  port: number
  store: Store
  tasks: TaskManager
  hub: Hub
  close: () => Promise<void>
}

/** 组装并启动 HTTP（/health）+ WebSocket 服务，返回运行句柄（便于测试复用） */
export async function startServer(config: ServerConfig): Promise<RunningServer> {
  const store = new Store(config.dataDir)
  const orphans = store.markOrphans()
  if (orphans > 0) console.log(`  ↩ 上次运行遗留 ${orphans} 个未完成任务，已标记为 interrupted`)

  const agents = createAgents(config)
  const hub = new Hub(config, store)
  const tasks = new TaskManager(
    config,
    store,
    agents,
    (msg) => hub.broadcast(msg),
    () => hub.authedCount(),
  )
  hub.setTaskManager(tasks)

  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      const snapshot = tasks.snapshot(200)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          ok: true,
          name: config.name,
          version: config.version,
          running: snapshot.filter((t) => t.status === 'running').length,
          queued: snapshot.filter((t) => t.status === 'queued').length,
        }),
      )
      return
    }
    res.writeHead(404)
    res.end()
  })

  const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 * 1024 })
  hub.attach(wss)

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, config.host, () => resolve())
  })

  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : config.port
  return {
    port,
    store,
    tasks,
    hub,
    close: () =>
      new Promise<void>((resolve) => {
        wss.close()
        server.close(() => resolve())
        store.close()
      }),
  }
}
