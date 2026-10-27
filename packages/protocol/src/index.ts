import { z } from 'zod'

/** 协议版本：不兼容变更时递增 */
export const PROTOCOL_VERSION = 2

// ---------------------------------------------------------------------------
// 公共结构
// ---------------------------------------------------------------------------

export const AgentActionSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
})
export type AgentAction = z.infer<typeof AgentActionSchema>

export const AgentInfoSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  description: z.string(),
  actions: z.array(AgentActionSchema),
})
export type AgentInfo = z.infer<typeof AgentInfoSchema>

export const ServerInfoSchema = z.object({
  name: z.string(),
  version: z.string(),
  platform: z.string(),
  protocol: z.number(),
})
export type ServerInfo = z.infer<typeof ServerInfoSchema>

/**
 * 任务状态机：
 * queued → running → completed | failed | cancelled
 * 服务端重启时遗留的 queued/running 会被标记为 interrupted
 */
export const TaskStatusSchema = z.enum([
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
])
export type TaskStatus = z.infer<typeof TaskStatusSchema>

export const TaskInfoSchema = z.object({
  id: z.string().min(1),
  agentId: z.string(),
  action: z.string(),
  status: TaskStatusSchema,
  createdAt: z.number(),
  endedAt: z.number().optional(),
  error: z.string().optional(),
  /** running 且进程 stdin 可写（交互式终端 / 多轮 CLI agent） */
  inputCapable: z.boolean(),
})
export type TaskInfo = z.infer<typeof TaskInfoSchema>

/**
 * Agent 事件流。每条事件在服务端全局单调递增编号（seq），
 * 手机断线重连后可用 hello.since 补发错过的事件。
 */
export const AgentEventSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('started') }),
  z.object({
    kind: z.literal('output'),
    stream: z.enum(['stdout', 'stderr', 'info']),
    chunk: z.string(),
  }),
  /** 文件下载分片：data 为 base64，offset 为文件内字节偏移 */
  z.object({
    kind: z.literal('file'),
    data: z.string(),
    offset: z.number(),
    bytes: z.number(),
  }),
  z.object({ kind: z.literal('completed'), result: z.unknown() }),
  z.object({ kind: z.literal('failed'), error: z.string() }),
  z.object({ kind: z.literal('cancelled') }),
])
export type AgentEvent = z.infer<typeof AgentEventSchema>

// ---------------------------------------------------------------------------
// 手机 App -> 服务端
// ---------------------------------------------------------------------------

export const HelloMessageSchema = z.object({
  type: z.literal('hello'),
  protocol: z.number(),
  token: z.string(),
  deviceName: z.string().optional(),
  /** 断线重连：上次收到的最大事件 seq，服务端补发之后的事件 */
  since: z.number().optional(),
})
export type HelloMessage = z.infer<typeof HelloMessageSchema>

export const AgentsListMessageSchema = z.object({
  type: z.literal('agents.list'),
})

export const AgentInvokeMessageSchema = z.object({
  type: z.literal('agent.invoke'),
  requestId: z.string().min(1),
  agentId: z.string().min(1),
  action: z.string().min(1),
  params: z.unknown().optional(),
})
export type AgentInvokeMessage = z.infer<typeof AgentInvokeMessageSchema>

export const AgentCancelMessageSchema = z.object({
  type: z.literal('agent.cancel'),
  requestId: z.string().min(1),
})

/** 向交互式任务的进程 stdin 写入数据（原样写入，换行由发送方负责） */
export const AgentInputMessageSchema = z.object({
  type: z.literal('agent.input'),
  requestId: z.string().min(1),
  data: z.string(),
})

export const TasksListMessageSchema = z.object({
  type: z.literal('tasks.list'),
  limit: z.number().int().min(1).max(200).optional(),
  status: TaskStatusSchema.optional(),
})

export const TasksGetMessageSchema = z.object({
  type: z.literal('tasks.get'),
  id: z.string().min(1),
})

export const TasksClearMessageSchema = z.object({
  type: z.literal('tasks.clear'),
})

export const UploadStartMessageSchema = z.object({
  type: z.literal('upload.start'),
  requestId: z.string().min(1),
  path: z.string().min(1),
  bytes: z.number().int().min(1),
  overwrite: z.boolean().optional(),
})

export const UploadChunkMessageSchema = z.object({
  type: z.literal('upload.chunk'),
  requestId: z.string().min(1),
  /** base64 编码的分片 */
  data: z.string().min(1),
})

export const UploadEndMessageSchema = z.object({
  type: z.literal('upload.end'),
  requestId: z.string().min(1),
})

export const PingMessageSchema = z.object({
  type: z.literal('ping'),
})

export const ClientMessageSchema = z.discriminatedUnion('type', [
  HelloMessageSchema,
  AgentsListMessageSchema,
  AgentInvokeMessageSchema,
  AgentCancelMessageSchema,
  AgentInputMessageSchema,
  TasksListMessageSchema,
  TasksGetMessageSchema,
  TasksClearMessageSchema,
  UploadStartMessageSchema,
  UploadChunkMessageSchema,
  UploadEndMessageSchema,
  PingMessageSchema,
])
export type ClientMessage = z.infer<typeof ClientMessageSchema>

// ---------------------------------------------------------------------------
// 服务端 -> 手机 App
// ---------------------------------------------------------------------------

export const WelcomeMessageSchema = z.object({
  type: z.literal('welcome'),
  server: ServerInfoSchema,
  agents: z.array(AgentInfoSchema),
  /** 当前任务快照（含历史） */
  tasks: z.array(TaskInfoSchema),
  /** 服务端当前最大事件 seq，客户端据此初始化游标 */
  lastSeq: z.number(),
})
export type WelcomeMessage = z.infer<typeof WelcomeMessageSchema>

export const AgentsMessageSchema = z.object({
  type: z.literal('agents'),
  agents: z.array(AgentInfoSchema),
})
export type AgentsMessage = z.infer<typeof AgentsMessageSchema>

export const AgentEventMessageSchema = z.object({
  type: z.literal('agent.event'),
  requestId: z.string(),
  /** 服务端全局单调递增事件序号 */
  seq: z.number(),
  event: AgentEventSchema,
})
export type AgentEventMessage = z.infer<typeof AgentEventMessageSchema>

export const TasksMessageSchema = z.object({
  type: z.literal('tasks'),
  tasks: z.array(TaskInfoSchema),
})
export type TasksMessage = z.infer<typeof TasksMessageSchema>

export const TaskUpdateMessageSchema = z.object({
  type: z.literal('task.update'),
  task: TaskInfoSchema,
})
export type TaskUpdateMessage = z.infer<typeof TaskUpdateMessageSchema>

export const PongMessageSchema = z.object({
  type: z.literal('pong'),
})

export const ErrorMessageSchema = z.object({
  type: z.literal('error'),
  code: z.string(),
  message: z.string(),
  requestId: z.string().optional(),
})
export type ErrorMessage = z.infer<typeof ErrorMessageSchema>

export const ServerMessageSchema = z.discriminatedUnion('type', [
  WelcomeMessageSchema,
  AgentsMessageSchema,
  AgentEventMessageSchema,
  TasksMessageSchema,
  TaskUpdateMessageSchema,
  PongMessageSchema,
  ErrorMessageSchema,
])
export type ServerMessage = z.infer<typeof ServerMessageSchema>
