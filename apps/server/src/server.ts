import http from 'node:http'
import { WebSocketServer } from 'ws'
import type { ServerConfig } from './config'
import { createAgents } from './agents/registry'
import { Hub } from './hub'

export interface RunningServer {
  port: number
  close: () => Promise<void>
}

/** 启动 HTTP（/health）+ WebSocket 服务，返回运行句柄（便于测试复用） */
export async function startServer(config: ServerConfig): Promise<RunningServer> {
  const agents = createAgents(config)
  const hub = new Hub(config, agents)

  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, name: config.name, version: config.version }))
      return
    }
    res.writeHead(404)
    res.end()
  })

  const wss = new WebSocketServer({ server, maxPayload: 32 * 1024 * 1024 })
  hub.attach(wss)

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, config.host, () => resolve())
  })

  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : config.port
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        wss.close()
        server.close(() => resolve())
      }),
  }
}
