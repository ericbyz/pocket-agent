import { useEffect, useMemo, useState } from 'react'
import { SafeAreaView, StatusBar, StyleSheet } from 'react-native'
import type { AgentInfo, ServerInfo } from '@pocket-agent/protocol'
import { AgentClient, type ClientState } from './src/lib/client'
import { theme } from './src/theme'
import { ConnectScreen } from './src/screens/ConnectScreen'
import { HomeScreen } from './src/screens/HomeScreen'
import { AgentScreen } from './src/screens/AgentScreen'

type Route = { name: 'connect' } | { name: 'home' } | { name: 'agent'; agent: AgentInfo }

export default function App() {
  const [route, setRoute] = useState<Route>({ name: 'connect' })
  const [state, setState] = useState<ClientState>('idle')
  const [statusText, setStatusText] = useState('')
  const [server, setServer] = useState<ServerInfo | null>(null)
  const [agents, setAgents] = useState<AgentInfo[]>([])

  const client = useMemo(
    () =>
      new AgentClient({
        onState: (s, detail) => {
          setState(s)
          setStatusText(detail ?? '')
        },
        onWelcome: (srv, ags) => {
          setServer(srv)
          setAgents(ags)
          setRoute({ name: 'home' })
        },
        onAgents: (ags) => setAgents(ags),
      }),
    [],
  )

  // 连接断开时退回连接页
  useEffect(() => {
    if (state !== 'connected' && route.name !== 'connect') {
      setRoute({ name: 'connect' })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  return (
    <SafeAreaView style={s.root}>
      <StatusBar barStyle="light-content" />
      {route.name === 'connect' ? (
        <ConnectScreen state={state} statusText={statusText} onConnect={(h, p, t) => client.connect(h, p, t)} />
      ) : null}
      {route.name === 'home' && server ? (
        <HomeScreen
          server={server}
          agents={agents}
          statusText={statusText}
          onOpenAgent={(agent) => setRoute({ name: 'agent', agent })}
          onRefresh={() => client.listAgents()}
          onDisconnect={() => client.disconnect()}
        />
      ) : null}
      {route.name === 'agent' && route.agent ? (
        <AgentScreen client={client} agent={route.agent} onBack={() => setRoute({ name: 'home' })} />
      ) : null}
    </SafeAreaView>
  )
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
})
