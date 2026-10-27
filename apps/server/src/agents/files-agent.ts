import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { AgentInfo } from '@pocket-agent/protocol'
import type { AgentContext, InvokeContext, ServerAgent } from './types'
import { asRecord, optionalBool, optionalNumber, optionalString, requireString } from './params'

const MAX_READ_BYTES = 512 * 1024
const DOWNLOAD_CHUNK_BYTES = 192 * 1024
const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024
const UPLOAD_TIMEOUT_MS = 10 * 60_000

interface ListEntry {
  name: string
  kind: 'directory' | 'file'
  size: number | null
  modifiedMs: number | null
}

interface SearchHit {
  path: string
  kind: 'directory' | 'file'
  size: number | null
  matchedLine?: string
}

/** 工作区文件操作：所有路径都被限制在 PA_WORKSPACE 之内 */
export class FilesAgent implements ServerAgent {
  readonly info: AgentInfo = {
    id: 'files',
    name: '📁 Files Agent',
    description: '浏览、搜索、编辑、传输服务端工作区（PA_WORKSPACE）内的文件',
    actions: [
      { name: 'list', description: '列出目录内容' },
      { name: 'read', description: '读取文本文件（默认上限 512KB）' },
      { name: 'write', description: '写入文本文件（自动创建父目录）' },
      { name: 'search', description: '按文件名 / 内容搜索（递归，跳过 node_modules 与隐藏目录）' },
      { name: 'move', description: '移动 / 重命名' },
      { name: 'copy', description: '复制（目录递归）' },
      { name: 'mkdir', description: '创建目录' },
      { name: 'delete', description: '删除文件或目录（需要 confirm: true）' },
      { name: 'download', description: '下载文件到手机（分片 base64 流 + sha256 校验）' },
      { name: 'upload', description: '从手机上传文件（upload.start/chunk/end 分片协议）' },
    ],
  }

  async invoke(action: string, params: unknown, ctx: AgentContext & InvokeContext): Promise<void> {
    const record = asRecord(params)
    ctx.emit({ kind: 'started' })
    switch (action) {
      case 'list':
        return this.list(record, ctx)
      case 'read':
        return this.read(record, ctx)
      case 'write':
        return this.write(record, ctx)
      case 'search':
        return this.search(record, ctx)
      case 'move':
        return this.move(record, ctx)
      case 'copy':
        return this.copy(record, ctx)
      case 'mkdir':
        return this.mkdir(record, ctx)
      case 'delete':
        return this.remove(record, ctx)
      case 'download':
        return this.download(record, ctx)
      case 'upload':
        return this.upload(record, ctx)
      default:
        throw new Error(`files agent 不支持的动作：${action}`)
    }
  }

  private resolveSafe(ctx: AgentContext, rel: string): string {
    const root = path.resolve(ctx.workspaceRoot)
    const target = path.resolve(root, rel)
    const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep
    if (target !== root && !target.startsWith(rootWithSep)) {
      throw new Error('路径超出工作区范围（PA_WORKSPACE）')
    }
    return target
  }

  private async list(params: Record<string, unknown>, ctx: AgentContext & InvokeContext): Promise<void> {
    const rel = optionalString(params, 'path', '.')
    const target = this.resolveSafe(ctx, rel)
    const dirents = await fs.readdir(target, { withFileTypes: true })
    const entries: ListEntry[] = []
    for (const dirent of dirents) {
      const full = path.join(target, dirent.name)
      let size: number | null = null
      let modifiedMs: number | null = null
      try {
        const stat = await fs.stat(full)
        size = stat.size
        modifiedMs = stat.mtimeMs
      } catch {
        // 竞态下条目可能刚被删掉，跳过 stat 失败
      }
      entries.push({
        name: dirent.name,
        kind: dirent.isDirectory() ? 'directory' : 'file',
        size,
        modifiedMs,
      })
    }
    entries.sort((a, b) =>
      a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'directory' ? -1 : 1,
    )
    ctx.emit({ kind: 'completed', result: { path: rel, entries } })
  }

  private async read(params: Record<string, unknown>, ctx: AgentContext & InvokeContext): Promise<void> {
    const rel = requireString(params, 'path')
    const target = this.resolveSafe(ctx, rel)
    const maxBytes = optionalNumber(params, 'maxBytes', {
      min: 1,
      max: 4 * 1024 * 1024,
      fallback: MAX_READ_BYTES,
    })
    const stat = await fs.stat(target)
    if (!stat.isFile()) throw new Error('目标不是文件')
    if (stat.size > maxBytes) {
      throw new Error(`文件太大（${stat.size} 字节 > 上限 ${maxBytes}），请用 download 下载完整文件`)
    }
    const content = await fs.readFile(target, 'utf8')
    ctx.emit({ kind: 'completed', result: { path: rel, bytes: stat.size, content } })
  }

  private async write(params: Record<string, unknown>, ctx: AgentContext & InvokeContext): Promise<void> {
    const rel = requireString(params, 'path')
    const content = typeof params['content'] === 'string' ? params['content'] : ''
    const target = this.resolveSafe(ctx, rel)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, content, 'utf8')
    ctx.emit({ kind: 'completed', result: { path: rel, bytes: Buffer.byteLength(content, 'utf8') } })
  }

  private async search(params: Record<string, unknown>, ctx: AgentContext & InvokeContext): Promise<void> {
    const pattern = requireString(params, 'pattern').toLowerCase()
    const content = optionalString(params, 'content', '').toLowerCase()
    const maxResults = optionalNumber(params, 'maxResults', { min: 1, max: 500, fallback: 100 })
    const root = path.resolve(ctx.workspaceRoot)
    const results: SearchHit[] = []

    const walk = async (dir: string, depth: number): Promise<void> => {
      if (results.length >= maxResults || depth > 12) return
      let dirents
      try {
        dirents = await fs.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const dirent of dirents) {
        if (results.length >= maxResults) return
        if (dirent.name.startsWith('.') || dirent.name === 'node_modules') continue
        const full = path.join(dir, dirent.name)
        const rel = path.relative(root, full)
        const nameHit = dirent.name.toLowerCase().includes(pattern)
        if (dirent.isDirectory()) {
          if (nameHit) results.push({ path: rel, kind: 'directory', size: null })
          await walk(full, depth + 1)
          continue
        }
        let matchedLine: string | undefined
        if (content) {
          try {
            const stat = await fs.stat(full)
            if (stat.size <= 1024 * 1024) {
              const text = await fs.readFile(full, 'utf8')
              const line = text.split('\n').find((l) => l.toLowerCase().includes(content))
              if (line) matchedLine = line.trim().slice(0, 200)
            }
          } catch {
            // 读取失败按不匹配处理
          }
          if (matchedLine === undefined && !nameHit) continue
        }
        if (nameHit || matchedLine !== undefined) {
          const stat = await fs.stat(full).catch(() => null)
          results.push({ path: rel, kind: 'file', size: stat?.size ?? null, matchedLine })
        }
      }
    }
    await walk(root, 0)
    ctx.emit({ kind: 'completed', result: { results, truncated: results.length >= maxResults } })
  }

  private async move(params: Record<string, unknown>, ctx: AgentContext & InvokeContext): Promise<void> {
    const from = this.resolveSafe(ctx, requireString(params, 'from'))
    const to = this.resolveSafe(ctx, requireString(params, 'to'))
    await fs.mkdir(path.dirname(to), { recursive: true })
    try {
      await fs.rename(from, to)
    } catch {
      // 跨盘等场景退回复制 + 删除
      await fs.cp(from, to, { recursive: true })
      await fs.rm(from, { recursive: true, force: true })
    }
    ctx.emit({ kind: 'completed', result: { from, to } })
  }

  private async copy(params: Record<string, unknown>, ctx: AgentContext & InvokeContext): Promise<void> {
    const from = this.resolveSafe(ctx, requireString(params, 'from'))
    const to = this.resolveSafe(ctx, requireString(params, 'to'))
    await fs.mkdir(path.dirname(to), { recursive: true })
    await fs.cp(from, to, { recursive: true })
    ctx.emit({ kind: 'completed', result: { from, to } })
  }

  private async mkdir(params: Record<string, unknown>, ctx: AgentContext & InvokeContext): Promise<void> {
    const rel = requireString(params, 'path')
    const target = this.resolveSafe(ctx, rel)
    await fs.mkdir(target, { recursive: true })
    ctx.emit({ kind: 'completed', result: { path: rel } })
  }

  private async remove(params: Record<string, unknown>, ctx: AgentContext & InvokeContext): Promise<void> {
    const rel = requireString(params, 'path')
    if (!optionalBool(params, 'confirm', false)) {
      throw new Error('删除是危险操作，请带上 confirm: true')
    }
    const target = this.resolveSafe(ctx, rel)
    await fs.rm(target, { recursive: true, force: false })
    ctx.emit({ kind: 'completed', result: { path: rel, deleted: true } })
  }

  /** 分片流回手机：file 事件（base64）→ completed（bytes + sha256） */
  private async download(params: Record<string, unknown>, ctx: AgentContext & InvokeContext): Promise<void> {
    const rel = requireString(params, 'path')
    const target = this.resolveSafe(ctx, rel)
    const stat = await fs.stat(target)
    if (!stat.isFile()) throw new Error('目标不是文件')
    if (stat.size > MAX_DOWNLOAD_BYTES) throw new Error(`文件超过下载上限（${MAX_DOWNLOAD_BYTES / 1024 / 1024}MB）`)

    await new Promise<void>((resolve, reject) => {
      const hash = createHash('sha256')
      const stream = createReadStream(target, { highWaterMark: DOWNLOAD_CHUNK_BYTES })
      let offset = 0
      stream.on('data', (chunk: string | Buffer) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        hash.update(buf)
        ctx.emit({ kind: 'file', data: buf.toString('base64'), offset, bytes: buf.length })
        offset += buf.length
      })
      stream.on('error', reject)
      stream.on('end', () => {
        ctx.emit({
          kind: 'completed',
          result: { path: rel, bytes: offset, sha256: hash.digest('hex') },
        })
        resolve()
      })
    })
  }

  /**
   * 上传接收端：hub 把 upload.chunk / upload.end 通过 channel 转进来。
   * 通道在同步段就注册（分片可能紧跟 start 到达，先缓冲），先写 .part
   * 临时文件，end 时校验大小后原子改名。
   */
  private async upload(params: Record<string, unknown>, ctx: AgentContext & InvokeContext): Promise<void> {
    const rel = requireString(params, 'path')
    const declaredBytes = optionalNumber(params, 'bytes', { fallback: 0 })
    const overwrite = optionalBool(params, 'overwrite', false)
    const target = this.resolveSafe(ctx, rel)
    if (existsSync(target) && !overwrite) throw new Error('目标已存在（overwrite: true 覆盖）')

    const buffered: Array<{ kind: 'chunk' | 'end'; data?: string }> = []
    let live: ((kind: 'chunk' | 'end', data?: string) => void) | null = null
    ctx.setChannel((kind, data) => {
      if (live) live(kind, data)
      else if (kind === 'chunk' && data) buffered.push({ kind, data })
      else if (kind === 'end') buffered.push({ kind })
    })

    await fs.mkdir(path.dirname(target), { recursive: true })
    const part = `${target}.part-${ctx.requestId}`

    await new Promise<void>((resolve) => {
      const stream = createWriteStream(part)
      const hash = createHash('sha256')
      let got = 0
      let settled = false

      const timer = setTimeout(() => fail('上传超时（10 分钟无 end）'), UPLOAD_TIMEOUT_MS)

      const fail = (error: string) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        ctx.setChannel(null)
        try {
          stream.destroy()
        } catch {
          // 忽略
        }
        fs.rm(part, { force: true }).catch(() => undefined)
        ctx.emit({ kind: 'failed', error })
        resolve()
      }

      stream.on('error', (err: Error) => fail(`写入失败：${err.message}`))

      live = (kind, data) => {
        if (settled) return
        if (kind === 'chunk') {
          if (!data) return
          const buf = Buffer.from(data, 'base64')
          got += buf.length
          hash.update(buf)
          stream.write(buf)
          return
        }
        stream.end(() => {
          if (declaredBytes > 0 && got !== declaredBytes) {
            fail(`大小不符：声明 ${declaredBytes} 字节，实际 ${got}`)
            return
          }
          fs.rename(part, target)
            .then(() => {
              settled = true
              clearTimeout(timer)
              ctx.setChannel(null)
              ctx.emit({
                kind: 'completed',
                result: { path: rel, bytes: got, sha256: hash.digest('hex') },
              })
              resolve()
            })
            .catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)))
        })
      }
      for (const item of buffered) live(item.kind, item.data)
    })
  }
}
