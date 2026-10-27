import { useEffect, useRef, useState } from 'react'
import {
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import type { AgentEvent, AgentInfo } from '@pocket-agent/protocol'
import type { AgentClient } from '../lib/client'
import { theme } from '../theme'

interface LogEntry {
  id: number
  kind: 'status' | 'stdout' | 'stderr' | 'info' | 'image'
  text?: string
  uri?: string
}

interface Props {
  client: AgentClient
  agent: AgentInfo
  onBack: () => void
}

interface FieldSpec {
  key: string
  placeholder: string
  multiline?: boolean
}

/** 已知动作的参数表单；未收录的动作退回 JSON 输入 */
const FORM_FIELDS: Record<string, FieldSpec[]> = {
  'computer.run_command': [{ key: 'command', placeholder: "PowerShell 命令，如 Get-Process | Select-Object -First 5" }],
  'computer.screenshot': [],
  'computer.sysinfo': [],
  'files.list': [{ key: 'path', placeholder: '相对路径（留空 = 工作区根目录）' }],
  'files.read': [{ key: 'path', placeholder: '相对路径，如 src/index.ts' }],
  'files.write': [
    { key: 'path', placeholder: '相对路径，如 notes/todo.txt' },
    { key: 'content', placeholder: '文件内容', multiline: true },
  ],
  'files.mkdir': [{ key: 'path', placeholder: '相对路径' }],
  'files.delete': [{ key: 'path', placeholder: '相对路径（发送时自动带 confirm: true）' }],
  'coding.run_task': [
    { key: 'prompt', placeholder: '任务描述，例如：修复登录页的空指针并补个测试', multiline: true },
    { key: 'cwd', placeholder: '项目目录（工作区内相对路径，留空 = 根目录）' },
  ],
}

function buildParams(agentId: string, action: string, values: Record<string, string>): unknown {
  const key = `${agentId}.${action}`
  const g = (k: string) => (values[k] ?? '').trim()
  switch (key) {
    case 'computer.run_command':
      return { command: g('command') }
    case 'files.delete':
      return { path: g('path'), confirm: true }
    case 'files.write':
      return { path: g('path'), content: values['content'] ?? '' }
    default: {
      const fields = FORM_FIELDS[key]
      if (fields) {
        const params: Record<string, string> = {}
        for (const field of fields) {
          const v = g(field.key)
          if (v) params[field.key] = v
        }
        return params
      }
      const json = g('__json')
      if (!json) return {}
      return JSON.parse(json) as unknown
    }
  }
}

function describeResult(result: unknown): string {
  if (result && typeof result === 'object' && 'exitCode' in result) {
    const code = (result as { exitCode: unknown }).exitCode
    return `（exit ${code === null || code === undefined ? '-' : code}）`
  }
  return ''
}

export function AgentScreen({ client, agent, onBack }: Props) {
  const [selected, setSelected] = useState(agent.actions[0]?.name ?? '')
  const [values, setValues] = useState<Record<string, string>>({})
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [runningId, setRunningId] = useState<string | null>(null)
  const runningRef = useRef<string | null>(null)
  const logIdRef = useRef(0)
  const scrollRef = useRef<ScrollView>(null)

  const push = (entry: Omit<LogEntry, 'id'>): void => {
    logIdRef.current += 1
    setLogs((prev) => [...prev, { ...entry, id: logIdRef.current }])
  }

  useEffect(() => {
    let active = true
    const unsubscribe = client.subscribeEvents((requestId, event: AgentEvent) => {
      if (!active || requestId !== runningRef.current) return
      switch (event.kind) {
        case 'started':
          push({ kind: 'status', text: '▶ 已开始' })
          break
        case 'output':
          push({
            kind: event.stream === 'stderr' ? 'stderr' : event.stream === 'info' ? 'info' : 'stdout',
            text: event.chunk,
          })
          break
        case 'completed': {
          const result = event.result as Record<string, unknown> | undefined
          const image = result && typeof result['image'] === 'string' ? (result['image'] as string) : null
          if (image) push({ kind: 'image', uri: image })
          push({ kind: 'status', text: `✓ 完成${describeResult(result)}` })
          runningRef.current = null
          setRunningId(null)
          break
        }
        case 'failed':
          push({ kind: 'status', text: `✗ 失败：${event.error}` })
          runningRef.current = null
          setRunningId(null)
          break
      }
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [client])

  useEffect(() => {
    if (logs.length === 0) return
    const timer = setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 80)
    return () => clearTimeout(timer)
  }, [logs.length])

  const run = (): void => {
    if (runningRef.current) return
    const action = agent.actions.find((a) => a.name === selected)
    if (!action) return
    let params: unknown
    try {
      params = buildParams(agent.id, action.name, values)
    } catch (err) {
      push({ kind: 'status', text: `✗ 参数不是合法 JSON：${err instanceof Error ? err.message : String(err)}` })
      return
    }
    setLogs([])
    push({ kind: 'status', text: `▶ ${agent.id}.${action.name}` })
    const requestId = client.invoke(agent.id, action.name, params)
    runningRef.current = requestId
    setRunningId(requestId)
  }

  const cancel = (): void => {
    if (runningRef.current) client.cancel(runningRef.current)
  }

  const setValue = (key: string, value: string): void => {
    setValues((prev) => ({ ...prev, [key]: value }))
  }

  const fields = FORM_FIELDS[`${agent.id}.${selected}`]
  const selectedAction = agent.actions.find((a) => a.name === selected)

  return (
    <View style={s.root}>
      <View style={s.header}>
        <Pressable onPress={onBack} hitSlop={12}>
          <Text style={s.back}>‹ 返回</Text>
        </Pressable>
        <Text style={s.title} numberOfLines={1}>{agent.name}</Text>
      </View>
      <Text style={s.desc}>{agent.description}</Text>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.chips} contentContainerStyle={s.chipsContent}>
        {agent.actions.map((action) => (
          <Pressable
            key={action.name}
            style={[s.chip, action.name === selected && s.chipActive]}
            onPress={() => setSelected(action.name)}
          >
            <Text style={[s.chipText, action.name === selected && s.chipTextActive]}>{action.name}</Text>
          </Pressable>
        ))}
      </ScrollView>

      <View style={s.form}>
        {selectedAction ? <Text style={s.actionDesc}>{selectedAction.description}</Text> : null}
        {fields ? (
          fields.map((field) => (
            <TextInput
              key={field.key}
              style={[s.input, field.multiline && s.inputMultiline, fields.length > 0 && s.monoInput]}
              value={values[field.key] ?? ''}
              onChangeText={(v) => setValue(field.key, v)}
              placeholder={field.placeholder}
              placeholderTextColor={theme.textDim}
              multiline={field.multiline}
              autoCapitalize="none"
              autoCorrect={false}
            />
          ))
        ) : (
          <TextInput
            style={[s.input, s.inputMultiline, s.monoInput]}
            value={values['__json'] ?? ''}
            onChangeText={(v) => setValue('__json', v)}
            placeholder='参数 JSON，如 {"key": "value"}；无参可留空'
            placeholderTextColor={theme.textDim}
            multiline
            autoCapitalize="none"
            autoCorrect={false}
          />
        )}
        <View style={s.buttonRow}>
          <Pressable
            style={[s.runButton, runningId && s.runButtonDisabled]}
            disabled={runningId != null}
            onPress={run}
          >
            <Text style={s.runButtonText}>{runningId ? '执行中…' : '▶ 执行'}</Text>
          </Pressable>
          {runningId ? (
            <Pressable style={s.cancelButton} onPress={cancel}>
              <Text style={s.cancelButtonText}>终止</Text>
            </Pressable>
          ) : null}
        </View>
      </View>

      <Text style={s.sectionTitle}>输出</Text>
      <ScrollView ref={scrollRef} style={s.logs} contentContainerStyle={s.logsContent}>
        {logs.length === 0 ? <Text style={s.logsEmpty}>执行一个动作后，输出会实时显示在这里。</Text> : null}
        {logs.map((entry) =>
          entry.kind === 'image' && entry.uri ? (
            <Image key={entry.id} source={{ uri: entry.uri }} style={s.logImage} resizeMode="contain" />
          ) : (
            <Text
              key={entry.id}
              style={[s.logLine, LOG_TEXT_STYLES[entry.kind as Exclude<LogEntry['kind'], 'image'>]]}
              selectable
            >
              {entry.text}
            </Text>
          ),
        )}
      </ScrollView>
    </View>
  )
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingTop: 56 },
  back: { color: theme.accent, fontSize: 15 },
  title: { color: theme.text, fontSize: 18, fontWeight: '700', flex: 1 },
  desc: { color: theme.textDim, fontSize: 12, paddingHorizontal: 16, marginTop: 6 },
  chips: { marginTop: 12, maxHeight: 40 },
  chipsContent: { paddingHorizontal: 16, gap: 8 },
  chip: {
    borderColor: theme.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 7,
    backgroundColor: theme.card,
  },
  chipActive: { backgroundColor: theme.accentDim, borderColor: theme.accent },
  chipText: { color: theme.textDim, fontSize: 13, fontFamily: theme.mono },
  chipTextActive: { color: theme.text },
  form: { paddingHorizontal: 16, paddingTop: 12 },
  actionDesc: { color: theme.textDim, fontSize: 11, marginBottom: 8 },
  input: {
    backgroundColor: theme.card,
    borderColor: theme.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    color: theme.text,
    fontSize: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 10,
  },
  inputMultiline: { minHeight: 72, textAlignVertical: 'top' },
  monoInput: { fontFamily: theme.mono },
  buttonRow: { flexDirection: 'row', gap: 10 },
  runButton: { backgroundColor: theme.accent, borderRadius: 10, paddingVertical: 12, paddingHorizontal: 24 },
  runButtonDisabled: { opacity: 0.5 },
  runButtonText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  cancelButton: {
    borderColor: theme.danger,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 24,
    backgroundColor: theme.card,
  },
  cancelButtonText: { color: theme.danger, fontSize: 15, fontWeight: '600' },
  sectionTitle: { color: theme.textDim, fontSize: 12, paddingHorizontal: 16, marginTop: 16, marginBottom: 8, letterSpacing: 1 },
  logs: { flex: 1, backgroundColor: theme.bg, marginHorizontal: 12, marginBottom: 12 },
  logsContent: { padding: 12, paddingBottom: 24 },
  logsEmpty: { color: theme.textDim, fontSize: 12 },
  logLine: { fontSize: 12, lineHeight: 18, fontFamily: theme.mono, marginBottom: 2 },
  log_status: { color: theme.accent, marginTop: 6, fontWeight: '700' },
  log_stdout: { color: theme.text },
  log_stderr: { color: theme.danger },
  log_info: { color: theme.warn },
  logImage: { width: '100%', height: 220, borderRadius: 8, marginVertical: 8, backgroundColor: theme.card },
})

const LOG_TEXT_STYLES = {
  status: s.log_status,
  stdout: s.log_stdout,
  stderr: s.log_stderr,
  info: s.log_info,
} as const
