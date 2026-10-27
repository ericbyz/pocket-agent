import fs from 'node:fs/promises'
import path from 'node:path'
import type { AgentInfo } from '@pocket-agent/protocol'
import type { AgentContext, InvokeContext, ServerAgent } from './types'
import { asRecord, optionalBool, optionalNumber, optionalString, requireString } from './params'

const MAX_READ_BYTES = 512 * 1024

interface ListEntry {
  name: string
  kind: 'directory' | 'file'
  size: number | null
  modifiedMs: number | null
}

/** 工作区文件操作：所有路径都被限制在 PA_WORKSPACE 之内 */
export class FilesAgent implements ServerAgent {
  readonly info: AgentInfo = {
    id: 'files',
    name: '📁 Files Agent',
    description: '浏览、读写服务端工作区（PA_WORKSPACE）内的文件',
    actions: [
      { name: 'list', description: '列出目录内容' },
      { name: 'read', description: '读取文本文件（默认上限 512KB）' },
      { name: 'write', description: '写入文本文件（自动创建父目录）' },
      { name: 'mkdir', description: '创建目录' },
      { name: 'delete', description: '删除文件或目录（需要 confirm: true）' },
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
      case 'mkdir':
        return this.mkdir(record, ctx)
      case 'delete':
        return this.remove(record, ctx)
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
      throw new Error(`文件太大（${stat.size} 字节 > 上限 ${maxBytes}），暂不支持读取超大文件`)
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
}
