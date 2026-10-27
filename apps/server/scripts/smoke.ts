import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'
import type { AgentEvent, ServerMessage, TaskInfo } from '@pocket-agent/protocol'
import { loadConfig } from '../src/config'
import { startServer } from '../src/server'

const PORT = 43991

interface EventLine {
  seq: number
  requestId: string
  event: AgentEvent
}

async function main(): Promise<void> {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-agent-smoke-'))
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocket-agent-smoke-data-'))
  const env = {
    PA_TOKEN: 'smoke-token',
    PA_PORT: String(PORT),
    PA_ALLOW_SHELL: '1',
    PA_WORKSPACE: workspace,
    PA_DATA_DIR: dataDir,
  }

  // ---- 第一轮服务 ----------------------------------------------------------

  const server = await startServer(loadConfig(env))
  const ws = await openSocket()
  const inbox: ServerMessage[] = []
  const waiters: Array<(msg: ServerMessage) => void> = []
  ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw)) as ServerMessage
    const waiter = waiters.shift()
    if (waiter) waiter(msg)
    else inbox.push(msg)
  })

  const next = (label: string): Promise<ServerMessage> => {
    const queued = inbox.shift()
    if (queued) return Promise.resolve(queued)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`等待 ${label} 超时`)), 30_000)
      waiters.push((msg) => {
        clearTimeout(timer)
        resolve(msg)
      })
    })
  }

  const drainUntil = async (pred: (msg: ServerMessage) => boolean, label: string): Promise<ServerMessage> => {
    for (;;) {
      const msg = await next(label)
      if (pred(msg)) return msg
      // 限流错误与当前等待无关时跳过（限流有自己的专项断言）
      if (msg.type === 'error' && msg.code !== 'rate_limited') {
        throw new Error(`${label}：收到错误 ${msg.code} ${msg.message}`)
      }
    }
  }

  const waitEvent = async <K extends AgentEvent['kind']>(
    requestId: string,
    kind: K,
  ): Promise<{ seq: number; requestId: string; event: Extract<AgentEvent, { kind: K }> }> => {
    const msg = await drainUntil(
      (m) => m.type === 'agent.event' && m.requestId === requestId && m.event.kind === kind,
      `request=${requestId} 的 ${kind} 事件`,
    )
    if (msg.type !== 'agent.event') throw new Error('unreachable')
    return { seq: msg.seq, requestId, event: msg.event as Extract<AgentEvent, { kind: K }> }
  }

  // 1. 配对 + welcome（含任务快照与 lastSeq）
  ws.send(JSON.stringify({ type: 'hello', protocol: 2, token: 'smoke-token', deviceName: 'smoke' }))
  const welcome = await drainUntil((m) => m.type === 'welcome', 'welcome')
  if (welcome.type !== 'welcome') throw new Error('unreachable')
  assert.equal(welcome.server.protocol, 2)
  assert.ok(welcome.agents.some((a) => a.id === 'computer'))
  assert.ok(welcome.agents.some((a) => a.id === 'files'))
  assert.ok(Array.isArray(welcome.tasks))
  assert.equal(typeof welcome.lastSeq, 'number')

  // 2. sysinfo + task.update 推送
  ws.send(JSON.stringify({ type: 'agent.invoke', requestId: 'sys', agentId: 'computer', action: 'sysinfo' }))
  const runningUpdate = await drainUntil(
    (m) => m.type === 'task.update' && m.task.id === 'sys' && m.task.status === 'running',
    'sys running',
  )
  if (runningUpdate.type !== 'task.update') throw new Error('unreachable')
  assert.equal(runningUpdate.task.inputCapable, false)
  const sys = await waitEvent('sys', 'completed')
  assert.equal((sys.event.result as { hostname?: string }).hostname, os.hostname())

  // 3. run_command：输出流 + 完成
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
    const msg = await drainUntil((m) => m.type === 'agent.event' && m.requestId === 'sh', 'run_command 结果')
    if (msg.type !== 'agent.event') continue
    if (msg.event.kind === 'output' && msg.event.chunk.includes('pocket-agent-smoke-ok')) sawOutput = true
    if (msg.event.kind === 'failed') throw new Error(`run_command 失败：${msg.event.error}`)
    if (msg.event.kind === 'completed') break
  }
  assert.ok(sawOutput, '应收到命令 stdout 输出')

  // 4. 交互式终端：stdin 写入 → 输出回传 → cancel → cancelled 状态
  ws.send(
    JSON.stringify({
      type: 'agent.invoke',
      requestId: 'term',
      agentId: 'computer',
      action: 'run_command',
      params: { interactive: true },
    }),
  )
  const termCapable = await drainUntil(
    (m) => m.type === 'task.update' && m.task.id === 'term' && m.task.inputCapable,
    'term inputCapable',
  )
  if (termCapable.type !== 'task.update') throw new Error('unreachable')
  ws.send(JSON.stringify({ type: 'agent.input', requestId: 'term', data: "Write-Output 'stdin-works-123'\n" }))
  await drainUntil(
    (m) => m.type === 'agent.event' && m.requestId === 'term' && m.event.kind === 'output' && m.event.chunk.includes('stdin-works-123'),
    'term stdin 回显',
  )
  ws.send(JSON.stringify({ type: 'agent.cancel', requestId: 'term' }))
  await drainUntil(
    (m) => m.type === 'task.update' && m.task.id === 'term' && m.task.status === 'cancelled',
    'term cancelled',
  )

  // 5. files 写入 / 读取 / 搜索
  ws.send(JSON.stringify({ type: 'agent.invoke', requestId: 'w', agentId: 'files', action: 'write', params: { path: 'demo/hello.txt', content: 'hi from smoke' } }))
  await waitEvent('w', 'completed')
  ws.send(JSON.stringify({ type: 'agent.invoke', requestId: 'r', agentId: 'files', action: 'read', params: { path: 'demo/hello.txt' } }))
  const read = await waitEvent('r', 'completed')
  assert.equal((read.event.result as { content?: string }).content, 'hi from smoke')
  ws.send(JSON.stringify({ type: 'agent.invoke', requestId: 'srch', agentId: 'files', action: 'search', params: { pattern: 'hello', content: 'smoke' } }))
  const search = await waitEvent('srch', 'completed')
  const hits = (search.event.result as { results?: Array<{ path: string }> }).results ?? []
  assert.ok(hits.some((hit) => hit.path.includes('hello.txt')), '搜索应命中 hello.txt')

  // 6. 下载：file 分片 + sha256
  ws.send(JSON.stringify({ type: 'agent.invoke', requestId: 'dl', agentId: 'files', action: 'download', params: { path: 'demo/hello.txt' } }))
  const fileChunks: Array<{ data: string; offset: number; bytes: number }> = []
  for (;;) {
    const msg = await drainUntil((m) => m.type === 'agent.event' && m.requestId === 'dl', 'download 事件')
    if (msg.type !== 'agent.event') continue
    if (msg.event.kind === 'file') fileChunks.push({ data: msg.event.data, offset: msg.event.offset, bytes: msg.event.bytes })
    if (msg.event.kind === 'completed') {
      const result = msg.event.result as { bytes: number; sha256: string }
      assert.equal(result.bytes, Buffer.byteLength('hi from smoke'))
      assert.ok(/^[0-9a-f]{64}$/.test(result.sha256))
      break
    }
  }
  assert.ok(fileChunks.length >= 1, '应有 file 分片事件')
  const downloaded = Buffer.concat(fileChunks.map((chunk) => Buffer.from(chunk.data, 'base64')))
  assert.equal(downloaded.toString('utf8'), 'hi from smoke')

  // 7. 上传：upload.start / chunk / end → 内容回读一致
  const payload = Buffer.from(Array.from({ length: 300_000 }, (_, i) => i % 251))
  const b64 = payload.toString('base64')
  ws.send(JSON.stringify({ type: 'upload.start', requestId: 'up', path: 'bin/upload-test.bin', bytes: payload.length }))
  const CHUNK = 192 * 1024
  for (let i = 0; i < b64.length; i += CHUNK) {
    ws.send(JSON.stringify({ type: 'upload.chunk', requestId: 'up', data: b64.slice(i, i + CHUNK) }))
  }
  ws.send(JSON.stringify({ type: 'upload.end', requestId: 'up' }))
  const upDone = await waitEvent('up', 'completed')
  assert.equal((upDone.event.result as { bytes: number }).bytes, payload.length)
  const roundTrip = fs.readFileSync(path.join(workspace, 'bin', 'upload-test.bin'))
  assert.ok(roundTrip.equals(payload), '上传内容应逐字节一致')

  // 8. 越权路径被拒绝
  ws.send(JSON.stringify({ type: 'agent.invoke', requestId: 'x', agentId: 'files', action: 'read', params: { path: '../../windows/win.ini' } }))
  const denied = await waitEvent('x', 'failed')
  assert.match(denied.event.error, /工作区/)

  // 9. 错误 token 被拒绝
  const bad = new WebSocket(`ws://127.0.0.1:${PORT}`)
  const badMsg = await new Promise<ServerMessage>((resolve, reject) => {
    bad.on('message', (raw) => resolve(JSON.parse(String(raw)) as ServerMessage))
    bad.on('error', reject)
    bad.on('open', () => bad.send(JSON.stringify({ type: 'hello', protocol: 2, token: 'wrong-token' })))
  })
  assert.equal(badMsg.type, 'error')
  assert.equal(badMsg.code, 'bad_token')
  bad.close()

  // 10. 限流：突发超过桶容量 → rate_limited
  let rateLimited = 0
  const rateListener = (raw: WebSocket.RawData): void => {
    try {
      const msg = JSON.parse(String(raw)) as ServerMessage
      if (msg.type === 'error' && msg.code === 'rate_limited') rateLimited += 1
    } catch {
      // 忽略
    }
  }
  ws.on('message', rateListener)
  for (let i = 0; i < 40; i += 1) {
    ws.send(JSON.stringify({ type: 'agent.invoke', requestId: `rl-${i}`, agentId: 'computer', action: 'sysinfo' }))
  }
  // 等消息与任务处理完（部分 invoke 会被拒绝——这正是被测行为）
  await new Promise((resolve) => setTimeout(resolve, 2_500))
  ws.off('message', rateListener)
  assert.ok(rateLimited >= 1, `应至少触发一次限流（实际 ${rateLimited} 次）`)

  // 11. tasks.list / tasks.clear
  ws.send(JSON.stringify({ type: 'tasks.list', limit: 50 }))
  const listed = await drainUntil((m) => m.type === 'tasks', 'tasks.list')
  if (listed.type !== 'tasks') throw new Error('unreachable')
  assert.ok((listed.tasks as TaskInfo[]).some((t) => t.id === 'sh'))
  assert.ok((listed.tasks as TaskInfo[]).some((t) => t.id === 'term' && t.status === 'cancelled'))

  // 12. 断线重连：hello.since=0 → 补发全部事件（含早前 'hi from smoke' 所在任务）
  const lastSeqBefore = welcome.lastSeq
  void lastSeqBefore
  ws.close()
  await server.close()

  // ---- 第二轮服务（同一数据目录：验证持久化 + resume）----------------------

  const server2 = await startServer(loadConfig(env))
  const ws2 = await openSocket()
  const replayed: EventLine[] = []
  const resumeDone = new Promise<void>((resolve) => {
    let settled = false
    ws2.on('message', (raw) => {
      const msg = JSON.parse(String(raw)) as ServerMessage
      if (msg.type === 'welcome' && !settled) {
        settled = true
        return
      }
      if (msg.type === 'agent.event') replayed.push({ seq: msg.seq, requestId: msg.requestId, event: msg.event })
      // 补发完成后服务端没有显式结束标记；用「上传任务的 completed 事件已到达」近似判断补发完毕
      if (msg.type === 'agent.event' && msg.requestId === 'up' && msg.event.kind === 'completed') resolve()
    })
  })
  ws2.send(JSON.stringify({ type: 'hello', protocol: 2, token: 'smoke-token', since: 0 }))
  await Promise.race([
    resumeDone,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('resume 补发超时')), 20_000)),
  ])
  assert.ok(replayed.length > 20, `应补发大量事件（实际 ${replayed.length}）`)
  for (let i = 1; i < replayed.length; i += 1) {
    assert.ok(replayed[i].seq > replayed[i - 1].seq, '补发事件 seq 应严格递增')
  }
  assert.ok(
    replayed.some((line) => line.requestId === 'term' && line.event.kind === 'output' && line.event.chunk.includes('stdin-works-123')),
    '补发应包含交互终端的 stdin 回显',
  )

  // 13. 重启后任务历史仍在
  ws2.send(JSON.stringify({ type: 'tasks.list', limit: 200 }))
  const listed2 = await new Promise<ServerMessage>((resolve) => {
    const timer = setTimeout(() => resolve({ type: 'error', code: 'timeout', message: '' }), 10_000)
    const onMsg = (raw: WebSocket.RawData): void => {
      const msg = JSON.parse(String(raw)) as ServerMessage
      if (msg.type === 'tasks') {
        clearTimeout(timer)
        ws2.off('message', onMsg)
        resolve(msg)
      }
    }
    ws2.on('message', onMsg)
  })
  if (listed2.type !== 'tasks') throw new Error('tasks.list 超时')
  assert.ok((listed2.tasks as TaskInfo[]).some((t) => t.id === 'sh' && t.status === 'completed'), '重启后历史任务应保留')

  console.log('SMOKE OK')
  ws2.close()
  await server2.close()
  fs.rmSync(workspace, { recursive: true, force: true })
  fs.rmSync(dataDir, { recursive: true, force: true })
  process.exit(0)
}

function openSocket(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`)
    ws.once('open', () => resolve(ws))
    ws.once('error', (err) => reject(new Error(`连接失败：${err.message}`)))
  })
}

main().catch((err) => {
  console.error('SMOKE FAILED:', err)
  process.exit(1)
})
