import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import type { TaskInfo } from '@pocket-agent/protocol'
import type { AgentClient, LogLine } from '../lib/client'
import { theme } from '../theme'

interface ScreenshotMeta {
  image: string
  width: number
  height: number
  originX: number
  originY: number
}

interface Props {
  client: AgentClient
  taskId: string
  onBack: () => void
  onReplaceTask: (taskId: string) => void
}

const LOG_TEXT_STYLES: Record<LogLine['kind'], { color: string }> = {
  status: { color: theme.accent },
  stdout: { color: theme.text },
  stderr: { color: theme.danger },
  info: { color: theme.warn },
}

/** 任务详情：实时输出流、取消、交互式 stdin、结果展示；截图任务支持点选远程控制 */
export function TaskDetailScreen({ client, taskId, onBack, onReplaceTask }: Props) {
  const [task, setTask] = useState<TaskInfo | undefined>(client.tasks.get(taskId))
  const [logs, setLogs] = useState<LogLine[]>(client.getLogs(taskId))
  const [shot, setShot] = useState<ScreenshotMeta | null>(null)
  const [tapMode, setTapMode] = useState(false)
  const [inputText, setInputText] = useState('')
  const [tapping, setTapping] = useState(false)
  const scrollRef = useRef<ScrollView>(null)
  const imageLayout = useRef<{ width: number; height: number }>({ width: 0, height: 0 })

  useEffect(() => {
    setTask(client.tasks.get(taskId))
    setLogs([...client.getLogs(taskId)])
    const result = client.results.get(taskId) as ScreenshotMeta | undefined
    if (result && typeof result === 'object' && 'image' in result && typeof result.image === 'string') {
      setShot(result)
    }
    const unsubTasks = client.subscribeTasks((tasks) => {
      const current = tasks.find((t) => t.id === taskId)
      setTask(current)
      const res = client.results.get(taskId) as ScreenshotMeta | undefined
      if (res && typeof res === 'object' && 'image' in res && typeof res.image === 'string') setShot(res)
    })
    const unsubLogs = client.subscribeLogs(taskId, () => {
      setLogs([...client.getLogs(taskId)])
    })
    return () => {
      unsubTasks()
      unsubLogs()
    }
  }, [client, taskId])

  useEffect(() => {
    if (logs.length === 0) return
    const timer = setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 80)
    return () => clearTimeout(timer)
  }, [logs.length])

  const running = task?.status === 'running' || task?.status === 'queued'

  const refreshScreenshot = (): void => {
    const newId = client.invoke('computer', 'screenshot')
    onReplaceTask(newId)
  }

  /** 点选：把点击位置换算成虚拟屏幕坐标发给 mouse_click */
  const handleTap = async (e: { nativeEvent: { changedTouches: Array<{ locationX: number; locationY: number }> } }): Promise<void> => {
    if (!tapMode || !shot || tapping) return
    const touch = e.nativeEvent.changedTouches[0]
    const layout = imageLayout.current
    if (!touch || layout.width === 0 || layout.height === 0) return
    const vx = shot.originX + (touch.locationX / layout.width) * shot.width
    const vy = shot.originY + (touch.locationY / layout.height) * shot.height
    setTapping(true)
    try {
      await client.request('computer', 'mouse_click', { x: Math.round(vx), y: Math.round(vy) })
    } catch {
      // 点击失败不打断界面
    }
    setTapping(false)
  }

  const sendInput = (): void => {
    const text = inputText
    if (!text) return
    client.sendInput(taskId, text)
    setInputText('')
  }

  const resultJson = useMemo(() => {
    if (!task || task.status !== 'completed') return null
    const result = client.results.get(taskId)
    if (result == null) return null
    try {
      const json = JSON.stringify(result, null, 2)
      return json.length > 4000 ? `${json.slice(0, 4000)}\n…（截断）` : json
    } catch {
      return null
    }
  }, [task, taskId, client, logs.length])

  return (
    <KeyboardAvoidingView style={s.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={0}>
      <View style={s.header}>
        <Pressable onPress={onBack} hitSlop={12}>
          <Text style={s.back}>‹ 返回</Text>
        </Pressable>
        <Text style={s.title} numberOfLines={1}>
          {task ? `${task.agentId}.${task.action}` : taskId}
        </Text>
        {running ? (
          <Pressable onPress={() => client.cancel(taskId)}>
            <Text style={s.cancel}>终止</Text>
          </Pressable>
        ) : (
          <View style={s.headerSpacer} />
        )}
      </View>

      {task ? (
        <View style={s.metaRow}>
          <Text style={[s.statusBadge, { color: statusColor(task.status) }]}>{statusLabel(task.status)}</Text>
          {running ? <ActivityIndicator size="small" color={theme.accent} /> : null}
          {task.error ? (
            <Text style={s.errorText} numberOfLines={1}>
              {task.error}
            </Text>
          ) : null}
        </View>
      ) : null}

      <ScrollView ref={scrollRef} style={s.logs} contentContainerStyle={s.logsContent}>
        {logs.length === 0 && !shot ? <Text style={s.logsEmpty}>等待输出…</Text> : null}
        {shot ? (
          <View style={s.shotWrap}>
            <View
              style={tapMode ? s.shotTouchableActive : s.shotTouchable}
              onLayout={(e) => {
                imageLayout.current = {
                  width: e.nativeEvent.layout.width,
                  height: e.nativeEvent.layout.height,
                }
              }}
              onTouchEnd={(e) => {
                void handleTap(e)
              }}
            >
              <Image source={{ uri: shot.image }} style={[s.shotImage, { aspectRatio: shot.width / shot.height }]} resizeMode="contain" />
            </View>
            <View style={s.shotBar}>
              <Pressable
                style={[s.shotButton, tapMode && s.shotButtonActive]}
                onPress={() => setTapMode((v) => !v)}
              >
                <Text style={s.shotButtonText}>{tapMode ? '🖱 点选模式：开（点图点击鼠标）' : '🖱 点选模式：关'}</Text>
              </Pressable>
              <Pressable style={s.shotButton} onPress={refreshScreenshot}>
                <Text style={s.shotButtonText}>↻ 刷新截图</Text>
              </Pressable>
            </View>
          </View>
        ) : null}
        {logs.map((line) => (
          <Text key={line.id} style={[s.logLine, { color: LOG_TEXT_STYLES[line.kind].color }, line.kind === 'status' && s.logStatus]} selectable>
            {line.text}
          </Text>
        ))}
        {resultJson ? (
          <View style={s.resultBox}>
            <Text style={s.resultTitle}>结果</Text>
            <Text style={s.resultJson} selectable>
              {resultJson}
            </Text>
          </View>
        ) : null}
      </ScrollView>

      {task?.inputCapable && running ? (
        <View style={s.inputBar}>
          <TextInput
            style={s.input}
            value={inputText}
            onChangeText={setInputText}
            placeholder="输入发送到进程 stdin（回车发送）"
            placeholderTextColor={theme.textDim}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="send"
            onSubmitEditing={sendInput}
          />
          <Pressable style={s.sendButton} onPress={sendInput}>
            <Text style={s.sendButtonText}>发送</Text>
          </Pressable>
        </View>
      ) : null}
    </KeyboardAvoidingView>
  )
}

function statusLabel(status: TaskInfo['status']): string {
  return { queued: '排队中', running: '运行中', completed: '完成', failed: '失败', cancelled: '已取消', interrupted: '已中断' }[status]
}

function statusColor(status: TaskInfo['status']): string {
  return {
    queued: theme.warn,
    running: theme.accent,
    completed: theme.ok,
    failed: theme.danger,
    cancelled: theme.textDim,
    interrupted: theme.warn,
  }[status]
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingTop: 56, paddingBottom: 8 },
  back: { color: theme.accent, fontSize: 15 },
  title: { color: theme.text, fontSize: 16, fontWeight: '700', flex: 1, fontFamily: theme.mono },
  cancel: { color: theme.danger, fontSize: 14 },
  headerSpacer: { width: 28 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingBottom: 8 },
  statusBadge: { fontSize: 13, fontWeight: '700' },
  errorText: { color: theme.danger, fontSize: 12, flex: 1 },
  logs: { flex: 1, paddingHorizontal: 12 },
  logsContent: { padding: 12, paddingBottom: 24 },
  logsEmpty: { color: theme.textDim, fontSize: 12 },
  logLine: { fontSize: 12, lineHeight: 18, fontFamily: theme.mono, marginBottom: 2 },
  logStatus: { fontWeight: '700', marginTop: 6 },
  shotWrap: { marginBottom: 12 },
  shotTouchable: { borderRadius: 8, overflow: 'hidden', backgroundColor: theme.card },
  shotTouchableActive: { borderRadius: 8, overflow: 'hidden', backgroundColor: theme.card, borderWidth: 2, borderColor: theme.accent },
  shotImage: { width: '100%', height: undefined },
  shotBar: { flexDirection: 'row', gap: 8, marginTop: 8 },
  shotButton: {
    flex: 1,
    backgroundColor: theme.card,
    borderColor: theme.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingVertical: 8,
    alignItems: 'center',
  },
  shotButtonActive: { backgroundColor: theme.accentDim, borderColor: theme.accent },
  shotButtonText: { color: theme.text, fontSize: 12 },
  resultBox: {
    backgroundColor: theme.card,
    borderColor: theme.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    padding: 12,
    marginTop: 10,
  },
  resultTitle: { color: theme.textDim, fontSize: 11, marginBottom: 6, letterSpacing: 1 },
  resultJson: { color: theme.text, fontSize: 11, fontFamily: theme.mono },
  inputBar: {
    flexDirection: 'row',
    gap: 8,
    padding: 12,
    paddingBottom: 20,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
    backgroundColor: theme.bg,
  },
  input: {
    flex: 1,
    backgroundColor: theme.card,
    borderColor: theme.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    color: theme.text,
    fontSize: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontFamily: theme.mono,
  },
  sendButton: { backgroundColor: theme.accent, borderRadius: 10, paddingHorizontal: 18, justifyContent: 'center' },
  sendButtonText: { color: '#fff', fontSize: 14, fontWeight: '600' },
})
