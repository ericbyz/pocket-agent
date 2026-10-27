import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import type { AgentInfo, ServerInfo, TaskInfo } from '@pocket-agent/protocol'
import { theme } from '../theme'

interface Props {
  server: ServerInfo
  agents: AgentInfo[]
  tasks: TaskInfo[]
  statusText: string
  onOpenAgent: (agent: AgentInfo) => void
  onOpenTasks: () => void
  onOpenFiles: () => void
  onDisconnect: () => void
}

export function HomeScreen({ server, agents, tasks, statusText, onOpenAgent, onOpenTasks, onOpenFiles, onDisconnect }: Props) {
  const running = tasks.filter((t) => t.status === 'running' || t.status === 'queued')
  const finished = tasks.filter((t) => t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled' || t.status === 'interrupted')

  return (
    <View style={s.root}>
      <View style={s.header}>
        <View style={s.headerText}>
          <Text style={s.serverName}>{server.name}</Text>
          <Text style={s.serverMeta}>
            v{server.version} · {server.platform}
          </Text>
          {statusText ? <Text style={s.status}>{statusText}</Text> : null}
        </View>
        <Pressable onPress={onDisconnect} hitSlop={8}>
          <Text style={s.disconnect}>断开</Text>
        </Pressable>
      </View>

      <View style={s.tiles}>
        <Pressable style={[s.tile, s.tileTasks]} onPress={onOpenTasks}>
          <Text style={s.tileTitle}>任务中心</Text>
          <Text style={s.tileMeta}>
            {running.length > 0 ? `${running.length} 个进行中` : '无进行中任务'} · 历史 {finished.length}
          </Text>
        </Pressable>
        <Pressable style={[s.tile, s.tileFiles]} onPress={onOpenFiles}>
          <Text style={s.tileTitle}>文件</Text>
          <Text style={s.tileMeta}>工作区浏览 / 传输</Text>
        </Pressable>
      </View>

      <Text style={s.sectionTitle}>AGENTS（{agents.length}）</Text>
      <ScrollView contentContainerStyle={s.list}>
        {agents.map((agent) => (
          <Pressable key={agent.id} style={s.agentCard} onPress={() => onOpenAgent(agent)}>
            <Text style={s.agentName}>{agent.name}</Text>
            <Text style={s.agentDesc}>{agent.description}</Text>
            <Text style={s.agentActions}>{agent.actions.map((action) => action.name).join(' · ')}</Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  )
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 56,
    paddingBottom: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
  },
  headerText: { flex: 1 },
  serverName: { color: theme.text, fontSize: 19, fontWeight: '700' },
  serverMeta: { color: theme.textDim, fontSize: 12, marginTop: 3 },
  status: { color: theme.warn, fontSize: 12, marginTop: 3 },
  disconnect: { color: theme.danger, fontSize: 14 },
  tiles: { flexDirection: 'row', gap: 12, paddingHorizontal: 16, paddingTop: 16 },
  tile: { flex: 1, borderRadius: 14, padding: 16, borderWidth: StyleSheet.hairlineWidth },
  tileTasks: { backgroundColor: theme.accentDim, borderColor: theme.accent },
  tileFiles: { backgroundColor: theme.card, borderColor: theme.border },
  tileTitle: { color: theme.text, fontSize: 16, fontWeight: '700' },
  tileMeta: { color: theme.textDim, fontSize: 12, marginTop: 4 },
  sectionTitle: { color: theme.textDim, fontSize: 12, paddingHorizontal: 20, paddingTop: 20, paddingBottom: 8, letterSpacing: 1 },
  list: { paddingHorizontal: 16, paddingBottom: 24 },
  agentCard: {
    backgroundColor: theme.card,
    borderColor: theme.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 14,
    padding: 16,
    marginBottom: 10,
  },
  agentName: { color: theme.text, fontSize: 16, fontWeight: '600' },
  agentDesc: { color: theme.textDim, fontSize: 13, lineHeight: 19, marginTop: 6 },
  agentActions: { color: theme.accent, fontSize: 11, marginTop: 8, fontFamily: theme.mono },
})
