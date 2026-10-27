import { useMemo, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native'
import type { AgentInfo } from '@pocket-agent/protocol'
import type { AgentClient } from '../lib/client'
import { theme } from '../theme'

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
  'computer.processes': [],
  'computer.kill_process': [
    { key: 'pid', placeholder: '进程 PID（与 name 二选一）' },
    { key: 'name', placeholder: '进程名（与 pid 二选一）' },
  ],
  'computer.clipboard_get': [],
  'computer.clipboard_set': [{ key: 'text', placeholder: '要写入剪贴板的文本', multiline: true }],
  'computer.open': [{ key: 'target', placeholder: 'URL / 文件路径 / 应用名' }],
  'computer.power': [{ key: 'action', placeholder: 'lock | sleep | shutdown | restart' }],
  'computer.mouse_move': [
    { key: 'x', placeholder: 'X（虚拟屏幕像素）' },
    { key: 'y', placeholder: 'Y（虚拟屏幕像素）' },
  ],
  'computer.mouse_click': [
    { key: 'x', placeholder: 'X（可空 = 原位点击）' },
    { key: 'y', placeholder: 'Y' },
    { key: 'button', placeholder: 'left | right | middle（默认 left）' },
  ],
  'computer.scroll': [{ key: 'delta', placeholder: '正数向上 / 负数向下，约 120/格' }],
  'computer.key_type': [{ key: 'text', placeholder: '要输入的文本', multiline: true }],
  'computer.key_tap': [
    { key: 'key', placeholder: '如 s、enter、f5、tab' },
    { key: 'mods', placeholder: '修饰键：ctrl / ctrl+alt / shift（可空）' },
  ],
  'files.list': [{ key: 'path', placeholder: '相对路径（留空 = 工作区根目录）' }],
  'files.read': [{ key: 'path', placeholder: '相对路径，如 src/index.ts' }],
  'files.write': [
    { key: 'path', placeholder: '相对路径，如 notes/todo.txt' },
    { key: 'content', placeholder: '文件内容', multiline: true },
  ],
  'files.search': [
    { key: 'pattern', placeholder: '文件名关键字（必填）' },
    { key: 'content', placeholder: '内容关键字（可选，提供后按内容匹配）' },
  ],
  'files.move': [
    { key: 'from', placeholder: '原路径' },
    { key: 'to', placeholder: '目标路径' },
  ],
  'files.copy': [
    { key: 'from', placeholder: '原路径' },
    { key: 'to', placeholder: '目标路径' },
  ],
  'files.mkdir': [{ key: 'path', placeholder: '相对路径' }],
  'files.delete': [{ key: 'path', placeholder: '相对路径（发送时自动带 confirm: true）' }],
  'coding.run_task': [
    { key: 'prompt', placeholder: '任务描述，例如：修复登录页的空指针并补个测试', multiline: true },
    { key: 'cwd', placeholder: '项目目录（工作区内相对路径，留空 = 根目录）' },
  ],
}

/** 支持交互模式（stdin 保持打开）的动作 */
const INTERACTIVE_ACTIONS = new Set(['computer.run_command', 'coding.run_task'])

function buildParams(agentId: string, action: string, values: Record<string, string>, interactive: boolean): unknown {
  const key = `${agentId}.${action}`
  const g = (k: string) => (values[k] ?? '').trim()
  switch (key) {
    case 'computer.run_command':
      return g('command') ? { command: g('command'), interactive } : { interactive }
    case 'computer.kill_process': {
      const pid = Number.parseInt(g('pid'), 10)
      return pid > 0 ? { pid } : { name: g('name') }
    }
    case 'computer.power':
      return { action: g('action'), confirm: true }
    case 'computer.mouse_click': {
      const params: Record<string, unknown> = {}
      const x = Number.parseInt(g('x'), 10)
      const y = Number.parseInt(g('y'), 10)
      if (Number.isFinite(x) && Number.isFinite(y)) {
        params.x = x
        params.y = y
      }
      if (g('button')) params.button = g('button')
      return params
    }
    case 'computer.key_tap': {
      const mods = g('mods').toLowerCase()
      return {
        key: g('key'),
        ctrl: mods.includes('ctrl'),
        alt: mods.includes('alt'),
        shift: mods.includes('shift'),
      }
    }
    case 'files.delete':
      return { path: g('path'), confirm: true }
    case 'files.write':
      return { path: g('path'), content: values['content'] ?? '' }
    case 'coding.run_task':
      return g('prompt') ? { prompt: g('prompt'), cwd: g('cwd') || undefined, interactive } : { interactive }
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

interface Props {
  client: AgentClient
  agent: AgentInfo
  onOpenTask: (taskId: string) => void
}

export function AgentScreen({ client, agent, onOpenTask }: Props) {
  const [selected, setSelected] = useState(agent.actions[0]?.name ?? '')
  const [values, setValues] = useState<Record<string, string>>({})
  const [interactive, setInteractive] = useState(false)
  const [error, setError] = useState('')

  const fields = useMemo(() => FORM_FIELDS[`${agent.id}.${selected}`], [agent.id, selected])
  const selectedAction = agent.actions.find((a) => a.name === selected)
  const interactiveAvailable = INTERACTIVE_ACTIONS.has(`${agent.id}.${selected}`)

  const run = (): void => {
    if (!selectedAction) return
    let params: unknown
    try {
      params = buildParams(agent.id, selectedAction.name, values, interactive)
    } catch (err) {
      setError(`参数不是合法 JSON：${err instanceof Error ? err.message : String(err)}`)
      return
    }
    setError('')
    const requestId = client.invoke(agent.id, selectedAction.name, params)
    onOpenTask(requestId)
  }

  const setValue = (key: string, value: string): void => {
    setValues((prev) => ({ ...prev, [key]: value }))
  }

  return (
    <View style={s.root}>
      <ScrollView contentContainerStyle={s.content}>
        <Text style={s.desc}>{agent.description}</Text>

        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.chipsContent}>
          {agent.actions.map((action) => (
            <Pressable
              key={action.name}
              style={[s.chip, action.name === selected && s.chipActive]}
              onPress={() => {
                setSelected(action.name)
                setValues({})
                setInteractive(false)
              }}
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
                style={[s.input, field.multiline && s.inputMultiline, s.monoInput]}
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
          {interactiveAvailable ? (
            <View style={s.switchRow}>
              <Switch value={interactive} onValueChange={setInteractive} trackColor={{ true: theme.accent }} />
              <Text style={s.switchLabel}>交互模式（保持 stdin 打开，可在任务详情里持续输入）</Text>
            </View>
          ) : null}
          <Pressable style={s.runButton} onPress={run}>
            <Text style={s.runButtonText}>▶ 运行</Text>
          </Pressable>
          {error ? <Text style={s.error}>{error}</Text> : null}
          <Text style={s.hint}>运行后跳转任务详情，输出实时滚动；断线也不会中断任务。</Text>
        </View>
      </ScrollView>
    </View>
  )
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  content: { padding: 16, paddingTop: 56 },
  desc: { color: theme.textDim, fontSize: 12, marginBottom: 10 },
  chipsContent: { gap: 8, paddingBottom: 4 },
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
  form: { marginTop: 10 },
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
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 },
  switchLabel: { color: theme.textDim, fontSize: 12, flex: 1 },
  runButton: { backgroundColor: theme.accent, borderRadius: 10, paddingVertical: 12, alignItems: 'center' },
  runButtonText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  error: { color: theme.danger, fontSize: 12, marginTop: 8 },
  hint: { color: theme.textDim, fontSize: 11, marginTop: 10, textAlign: 'center' },
})
