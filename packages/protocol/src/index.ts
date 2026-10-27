import { z } from 'zod'

/** 协议版本：不兼容变更时递增 */
export const PROTOCOL_VERSION = 1

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

export const AgentEventSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('started') }),
  z.object({
    kind: z.literal('output'),
    stream: z.enum(['stdout', 'stderr', 'info']),
    chunk: z.string(),
  }),
  z.object({ kind: z.literal('completed'), result: z.unknown() }),
  z.object({ kind: z.literal('failed'), error: z.string() }),
])
export type AgentEvent = z.infer<typeof AgentEventSchema>

// ---------------------------------------------------------------------------
// 手机 App -> 服务端
// ---------------------------------------------------------------------------

export const HelloMessageSchema = z.object({
  type: z.literal('hello'),
  protocol: z.number(),
  token: z.string(),
  clientName: z.string().optional(),
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

export const PingMessageSchema = z.object({
  type: z.literal('ping'),
})

export const ClientMessageSchema = z.discriminatedUnion('type', [
  HelloMessageSchema,
  AgentsListMessageSchema,
  AgentInvokeMessageSchema,
  AgentCancelMessageSchema,
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
  event: AgentEventSchema,
})
export type AgentEventMessage = z.infer<typeof AgentEventMessageSchema>

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
  PongMessageSchema,
  ErrorMessageSchema,
])
export type ServerMessage = z.infer<typeof ServerMessageSchema>
