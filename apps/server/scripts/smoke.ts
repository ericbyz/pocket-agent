import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'
import type { AgentEvent, ServerMessage } from '@pocket-agent/protocol'
import { loadConfig } from '../src/config'
import { startServer } from '../src/server'

const PORT = 43991

async function main(): Promise<void> {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-agent-smoke-'))
  const config = loadConfig({
    PA_TOKEN: 'smoke-token',
    PA_PORT: String(PORT),
    PA_ALLOW_SHELL: '1',
    PA_WORKSPACE: workspace,
  })
  const server = await startServer(config)
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`)
  const queue: ServerMessage[] = []
  const waiters: Array<(msg: ServerMessage) => void> = []

  ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw)) as ServerMessage
    const waiter = waiters.shift()
    if (waiter) waiter(msg)
    else queue.push(msg)
  })

  try {
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve())
      ws.once('error', (err) => reject(new Error(`连接失败：${err.message}`)))
    })

    const next = (label: string): Promise<ServerMessage> => {
      const queued = queue.shift()
      if (queued) return Promise.resolve(queued)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`等待 ${label} 超时`)), 20_000)
        waiters.push((msg) => {
          clearTimeout(timer)
          resolve(msg)
        })
      })
    }

    const waitEvent = async <K extends AgentEvent['kind']>(
      requestId: string,
      kind: K,
    ): Promise<Extract<AgentEvent, { kind: K }>> => {
      for (;;) {
        const msg = await next(`request=${requestId} 的 ${kind} 事件`)
        if (msg.type === 'agent.event' && msg.requestId === requestId && msg.event.kind === kind) {
          return msg.event as Extract<AgentEvent, { kind: K }>
        }
      }
    }

    // 1. 配对
    ws.send(JSON.stringify({ type: 'hello', protocol: 1, token: 'smoke-token', clientName: 'smoke' }))
    const welcome = await next('welcome')
    assert.equal(welcome.type, 'welcome')
    assert.ok(welcome.agents.some((a) => a.id === 'computer'), '应注册 computer agent')
    assert.ok(welcome.agents.some((a) => a.id === 'files'), '应注册 files agent')

    // 2. computer.sysinfo
    ws.send(JSON.stringify({ type: 'agent.invoke', requestId: 'sys', agentId: 'computer', action: 'sysinfo' }))
    const sys = await waitEvent('sys', 'completed')
    assert.equal((sys.result as { hostname?: string }).hostname, os.hostname())

    // 3. computer.run_command：输出流 + 完成
    ws.send(
      JSON.stringify({
        type: 'agent.invoke',
        requestId: 'sh',
        agentId: 'computer',
        action: 'run_command',
        params: { command: "Write-Output 'pocket-agent-smoke-ok'" },
      }),
    )
    let sawOutput = false
    for (;;) {
      const msg = await next('run_command 结果')
      if (msg.type !== 'agent.event' || msg.requestId !== 'sh') continue
      if (msg.event.kind === 'output' && msg.event.chunk.includes('pocket-agent-smoke-ok')) {
        sawOutput = true
        continue
      }
      if (msg.event.kind === 'failed') throw new Error(`run_command 失败：${msg.event.error}`)
      if (msg.event.kind === 'completed') break
    }
    assert.ok(sawOutput, '应收到命令 stdout 输出')

    // 4. files 写入/读取回环
    ws.send(
      JSON.stringify({
        type: 'agent.invoke',
        requestId: 'w',
        agentId: 'files',
        action: 'write',
        params: { path: 'demo/hello.txt', content: 'hi from smoke' },
      }),
    )
    await waitEvent('w', 'completed')
    ws.send(JSON.stringify({ type: 'agent.invoke', requestId: 'r', agentId: 'files', action: 'read', params: { path: 'demo/hello.txt' } }))
    const read = await waitEvent('r', 'completed')
    assert.equal((read.result as { content?: string }).content, 'hi from smoke')

    // 5. 越权路径必须被拒绝
    ws.send(JSON.stringify({ type: 'agent.invoke', requestId: 'x', agentId: 'files', action: 'read', params: { path: '../../windows/win.ini' } }))
    const denied = await waitEvent('x', 'failed')
    assert.match(denied.error, /工作区/)

    // 6. 错误 token 必须被拒绝
    const bad = new WebSocket(`ws://127.0.0.1:${PORT}`)
    const badMsg = await new Promise<ServerMessage>((resolve, reject) => {
      bad.on('message', (raw) => resolve(JSON.parse(String(raw)) as ServerMessage))
      bad.on('error', reject)
      bad.on('open', () => bad.send(JSON.stringify({ type: 'hello', protocol: 1, token: 'wrong-token' })))
    })
    assert.equal(badMsg.type, 'error')
    assert.equal(badMsg.code, 'bad_token')
    bad.close()

    console.log('SMOKE OK')
    ws.close()
  } finally {
    ws.close()
    await server.close()
    fs.rmSync(workspace, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error('SMOKE FAILED:', err)
  process.exit(1)
})
