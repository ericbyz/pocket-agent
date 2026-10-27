import { useEffect, useState } from 'react'
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native'
import type { TaskInfo, TaskStatus } from '@pocket-agent/protocol'
import type { AgentClient } from '../lib/client'
import { theme } from '../theme'

const STATUS_LABEL: Record<TaskStatus, string> = {
  queued: '排队中',
  running: '运行中',
  completed: '完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
}

const STATUS_COLOR: Record<TaskStatus, string> = {
  queued: theme.warn,
  running: theme.accent,
  completed: theme.ok,
  failed: theme.danger,
  cancelled: theme.textDim,
  interrupted: theme.warn,
}

type Filter = 'all' | 'running' | 'finished'

interface Props {
  client: AgentClient
  onOpenTask: (taskId: string) => void
}

export function TasksScreen({ client, onOpenTask }: Props) {
  const [tasks, setTasks] = useState<TaskInfo[]>(client.taskSnapshot())
  const [filter, setFilter] = useState<Filter>('all')

  useEffect(() => client.subscribeTasks(setTasks), [client])

  const filtered = tasks.filter((task) => {
    if (filter === 'running') return task.status === 'running' || task.status === 'queued'
    if (filter === 'finished')
      return task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled' || task.status === 'interrupted'
    return true
  })

  const fmtTime = (ms: number): string => {
    const d = new Date(ms)
    const hh = String(d.getHours()).padStart(2, '0')
    const mm = String(d.getMinutes()).padStart(2, '0')
    return `${hh}:${mm}`
  }

  return (
    <View style={s.root}>
      <View style={s.header}>
        <Text style={s.title}>任务中心</Text>
        <Pressable onPress={() => client.clearFinished()}>
          <Text style={s.clear}>清空历史</Text>
        </Pressable>
      </View>

      <View style={s.filters}>
        {(
          [
            ['all', '全部'],
            ['running', '进行中'],
            ['finished', '已结束'],
          ] as Array<[Filter, string]>
        ).map(([value, label]) => (
          <Pressable key={value} style={[s.filterChip, filter === value && s.filterChipActive]} onPress={() => setFilter(value)}>
            <Text style={[s.filterText, filter === value && s.filterTextActive]}>{label}</Text>
          </Pressable>
        ))}
      </View>

      <FlatList
        data={filtered}
        keyExtractor={(item) => item.id}
        contentContainerStyle={s.list}
        ListEmptyComponent={<Text style={s.empty}>没有任务。去 Agents 页运行一个动作吧。</Text>}
        renderItem={({ item }) => (
          <Pressable style={s.row} onPress={() => onOpenTask(item.id)}>
            <View style={s.rowTop}>
              <Text style={s.rowTask} numberOfLines={1}>
                {item.agentId}.{item.action}
              </Text>
              <Text style={[s.badge, { color: STATUS_COLOR[item.status] }]}>{STATUS_LABEL[item.status]}</Text>
            </View>
            <View style={s.rowBottom}>
              <Text style={s.rowMeta}>{fmtTime(item.createdAt)}</Text>
              <Text style={s.rowMeta} numberOfLines={1}>
                {item.error ? item.error : item.inputCapable ? '⌨ 可输入' : ''}
              </Text>
            </View>
          </Pressable>
        )}
      />
    </View>
  )
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 56,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
  },
  title: { color: theme.text, fontSize: 20, fontWeight: '700' },
  clear: { color: theme.accent, fontSize: 14 },
  filters: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingVertical: 12 },
  filterChip: {
    borderColor: theme.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 6,
    backgroundColor: theme.card,
  },
  filterChipActive: { backgroundColor: theme.accentDim, borderColor: theme.accent },
  filterText: { color: theme.textDim, fontSize: 13 },
  filterTextActive: { color: theme.text },
  list: { paddingHorizontal: 16, paddingBottom: 24 },
  empty: { color: theme.textDim, fontSize: 13, textAlign: 'center', marginTop: 48 },
  row: {
    backgroundColor: theme.card,
    borderColor: theme.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    padding: 14,
    marginBottom: 8,
  },
  rowTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  rowTask: { color: theme.text, fontSize: 14, fontFamily: theme.mono, flex: 1 },
  badge: { fontSize: 12, fontWeight: '700' },
  rowBottom: { flexDirection: 'row', justifyContent: 'space-between', gap: 8, marginTop: 6 },
  rowMeta: { color: theme.textDim, fontSize: 11, flex: 1 },
})
