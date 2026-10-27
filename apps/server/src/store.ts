import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import type { AgentEvent, TaskInfo, TaskStatus } from '@pocket-agent/protocol'

/** 事件回放缓冲上限（环形裁剪） */
const KEEP_EVENTS = 20_000
/** 已结束任务保留条数 */
const KEEP_FINISHED_TASKS = 300

interface TaskRow {
  id: string
  agent_id: string
  action: string
  status: string
  error: string | null
  created_at: number
  ended_at: number | null
  input_capable: number
}

interface EventRow {
  seq: number
  task_id: string
  event: string
}

function rowToTask(row: TaskRow): TaskInfo {
  return {
    id: row.id,
    agentId: row.agent_id,
    action: row.action,
    status: row.status as TaskStatus,
    createdAt: row.created_at,
    endedAt: row.ended_at ?? undefined,
    error: row.error ?? undefined,
    inputCapable: row.input_capable === 1,
  }
}

/**
 * SQLite 持久层：任务表 + 事件环形缓冲。
 * 事件带全局自增 seq，支撑断线重连补发（hello.since）与服务重启后的历史查询。
 */
export class Store {
  private db: Database.Database
  private appendCount = 0

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true })
    this.db = new Database(path.join(dataDir, 'pocket-agent.db'))
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = NORMAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        action TEXT NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        created_at INTEGER NOT NULL,
        ended_at INTEGER,
        input_capable INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at DESC);
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        event TEXT NOT NULL,
        ts INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id);
    `)
  }

  /** 服务重启：遗留的 queued/running 任务标记为 interrupted */
  markOrphans(): number {
    const res = this.db
      .prepare(`UPDATE tasks SET status = 'interrupted', ended_at = ? WHERE status IN ('queued','running')`)
      .run(Date.now())
    return res.changes
  }

  upsertTask(task: TaskInfo): void {
    this.db
      .prepare(
        `INSERT INTO tasks (id, agent_id, action, status, error, created_at, ended_at, input_capable)
         VALUES (@id, @agentId, @action, @status, @error, @createdAt, @endedAt, @inputCapable)
         ON CONFLICT(id) DO UPDATE SET
           status = @status, error = @error, ended_at = @endedAt, input_capable = @inputCapable`,
      )
      .run({
        id: task.id,
        agentId: task.agentId,
        action: task.action,
        status: task.status,
        error: task.error ?? null,
        createdAt: task.createdAt,
        endedAt: task.endedAt ?? null,
        inputCapable: task.inputCapable ? 1 : 0,
      })
  }

  getTask(id: string): TaskInfo | undefined {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined
    return row ? rowToTask(row) : undefined
  }

  listTasks(limit: number, status?: TaskStatus): TaskInfo[] {
    const rows = status
      ? (this.db
          .prepare('SELECT * FROM tasks WHERE status = ? ORDER BY created_at DESC LIMIT ?')
          .all(status, limit) as TaskRow[])
      : (this.db
          .prepare('SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?')
          .all(limit) as TaskRow[])
    return rows.map(rowToTask)
  }

  hasTask(id: string): boolean {
    return this.getTask(id) !== undefined
  }

  /** 追加事件，返回分配的全局 seq */
  appendEvent(taskId: string, event: AgentEvent): number {
    const res = this.db
      .prepare('INSERT INTO events (task_id, event, ts) VALUES (?, ?, ?)')
      .run(taskId, JSON.stringify(event), Date.now())
    this.appendCount += 1
    if (this.appendCount % 500 === 0) this.trim()
    return Number(res.lastInsertRowid)
  }

  /** 补发 since 之后的事件（断线重连 / 服务重启后） */
  eventsSince(since: number, limit = 5_000): Array<{ seq: number; taskId: string; event: AgentEvent }> {
    const rows = this.db
      .prepare('SELECT seq, task_id, event FROM events WHERE seq > ? ORDER BY seq ASC LIMIT ?')
      .all(since, limit) as EventRow[]
    return rows.map((row) => ({ seq: row.seq, taskId: row.task_id, event: JSON.parse(row.event) as AgentEvent }))
  }

  oldestSeq(): number | null {
    const row = this.db.prepare('SELECT MIN(seq) AS m FROM events').get() as { m: number | null }
    return row.m
  }

  lastSeq(): number {
    const row = this.db.prepare('SELECT MAX(seq) AS m FROM events').get() as { m: number | null }
    return row.m ?? 0
  }

  clearFinished(): number {
    const res = this.db
      .prepare(`DELETE FROM tasks WHERE status IN ('completed','failed','cancelled','interrupted')`)
      .run()
    this.db.prepare(`DELETE FROM events WHERE task_id NOT IN (SELECT id FROM tasks)`).run()
    return res.changes
  }

  private trim(): void {
    this.db.prepare(
      `DELETE FROM events WHERE seq <= (SELECT MAX(seq) FROM events) - ${KEEP_EVENTS}`,
    ).run()
    this.db
      .prepare(
        `DELETE FROM tasks WHERE status IN ('completed','failed','cancelled','interrupted')
         AND id NOT IN (
           SELECT id FROM tasks WHERE status IN ('completed','failed','cancelled','interrupted')
           ORDER BY created_at DESC LIMIT ${KEEP_FINISHED_TASKS}
         )`,
      )
      .run()
    this.db.prepare(`DELETE FROM events WHERE task_id NOT IN (SELECT id FROM tasks)`).run()
  }

  close(): void {
    this.db.close()
  }
}
