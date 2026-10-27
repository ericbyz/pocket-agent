import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native'
import type { AgentInfo, ServerInfo } from '@pocket-agent/protocol'
import { theme } from '../theme'

interface Props {
  server: ServerInfo
  agents: AgentInfo[]
  statusText: string
  onOpenAgent: (agent: AgentInfo) => void
  onRefresh: () => void
  onDisconnect: () => void
}

export function HomeScreen({ server, agents, statusText, onOpenAgent, onRefresh, onDisconnect }: Props) {
  return (
    <View style={s.root}>
      <View style={s.header}>
        <Text style={s.serverName}>{server.name}</Text>
        <Text style={s.serverMeta}>
          v{server.version} · {server.platform}
        </Text>
        {statusText ? <Text style={s.status}>{statusText}</Text> : null}
      </View>

      <Text style={s.sectionTitle}>Agents（{agents.length}）</Text>
      <FlatList
        data={agents}
        keyExtractor={(item) => item.id}
        contentContainerStyle={s.list}
        renderItem={({ item }) => (
          <Pressable style={s.agentCard} onPress={() => onOpenAgent(item)}>
            <Text style={s.agentName}>{item.name}</Text>
            <Text style={s.agentDesc}>{item.description}</Text>
            <Text style={s.agentActions}>
              {item.actions.map((action) => action.name).join(' · ')}
            </Text>
          </Pressable>
        )}
      />

      <View style={s.footer}>
        <Pressable style={[s.footerButton, s.accentButton]} onPress={onRefresh}>
          <Text style={s.footerButtonText}>刷新</Text>
        </Pressable>
        <Pressable style={[s.footerButton, s.dangerButton]} onPress={onDisconnect}>
          <Text style={[s.footerButtonText, { color: theme.danger }]}>断开</Text>
        </Pressable>
      </View>
    </View>
  )
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: { paddingHorizontal: 20, paddingTop: 60, paddingBottom: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: theme.border },
  serverName: { color: theme.text, fontSize: 20, fontWeight: '700' },
  serverMeta: { color: theme.textDim, fontSize: 12, marginTop: 4 },
  status: { color: theme.warn, fontSize: 12, marginTop: 4 },
  sectionTitle: { color: theme.textDim, fontSize: 12, paddingHorizontal: 20, paddingTop: 16, paddingBottom: 8, letterSpacing: 1 },
  list: { paddingHorizontal: 16, paddingBottom: 16 },
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
  footer: { flexDirection: 'row', gap: 12, padding: 16, borderTopWidth: StyleSheet.hairlineWidth, borderColor: theme.border },
  footerButton: { flex: 1, borderRadius: 12, paddingVertical: 13, alignItems: 'center' },
  accentButton: { backgroundColor: theme.accentDim },
  dangerButton: { backgroundColor: theme.card },
  footerButtonText: { color: theme.text, fontSize: 15, fontWeight: '600' },
})
