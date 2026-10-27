import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { SafeAreaView, StatusBar, StyleSheet, Text } from 'react-native'
import * as Linking from 'expo-linking'
import type { AgentInfo, ServerInfo, TaskInfo } from '@pocket-agent/protocol'
import { AgentClient, type ClientState } from './src/lib/client'
import {
  getLastServerId,
  getSeq,
  loadServers,
  saveServers,
  setLastServerId,
  setSeq,
  type ServerRecord,
} from './src/lib/storage'
import { theme } from './src/theme'
import { ConnectScreen, type ConnectPrefill } from './src/screens/ConnectScreen'
import { HomeScreen } from './src/screens/HomeScreen'
import { AgentScreen } from './src/screens/AgentScreen'
import { TasksScreen } from './src/screens/TasksScreen'
import { TaskDetailScreen } from './src/screens/TaskDetailScreen'
import { FilesScreen } from './src/screens/FilesScreen'
import { FileScreen } from './src/screens/FileScreen'

type Route =
  | { name: 'connect' }
  | { name: 'home' }
  | { name: 'agent'; agent: AgentInfo }
  | { name: 'tasks' }
  | { name: 'task'; id: string }
  | { name: 'files'; path: string }
  | { name: 'file'; path: string }

export default function App() {
  const [stack, setStack] = useState<Route[]>([{ name: 'connect' }])
  const [state, setState] = useState<ClientState>('idle')
  const [statusText, setStatusText] = useState('')
  const [server, setServer] = useState<ServerInfo | null>(null)
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [tasks, setTasks] = useState<TaskInfo[]>([])
  const [savedServers, setSavedServers] = useState<ServerRecord[]>([])
  const [prefill, setPrefill] = useState<ConnectPrefill | null>(null)
  const [filesVersion, setFilesVersion] = useState(0)

  const activeServerRef = useRef<ServerRecord | null>(null)

  const client = useMemo(
    () =>
      new AgentClient({
        onState: (s, detail) => {
          setState(s)
          setStatusText(detail ?? '')
          // 致命错误或手动断开才退回连接页；reconnecting 留在原地
          if (s === 'idle' || s === 'error') {
            setStack((current) => (current[0].name === 'connect' ? current : [{ name: 'connect' }]))
          }
        },
        onWelcome: (srv, ags) => {
          setServer(srv)
          setAgents(ags)
          setStack((current) => {
            const next = [...current]
            if (next[0].name === 'connect') next.shift()
            return next.length > 0 ? next : [{ name: 'home' }]
          })
        },
      }),
    [],
  )

  useEffect(() => client.subscribeTasks(setTasks), [client])

  // 事件游标持久化（断线重连补发用）
  useEffect(() => {
    client.onSeqPersist = (seq) => {
      const rec = activeServerRef.current
      if (rec) void setSeq(rec.id, seq)
    }
    return () => {
      client.onSeqPersist = null
    }
  }, [client])

  const connectTo = useCallback(
    async (rec: ServerRecord) => {
      activeServerRef.current = rec
      void setLastServerId(rec.id)
      const since = await getSeq(rec.id)
      client.resetData()
      client.connect(rec.host, rec.port, rec.token, since)
    },
    [client],
  )

  const handleSaveServer = useCallback((rec: ServerRecord) => {
    setSavedServers((prev) => {
      const next = prev.some((item) => item.id === rec.id)
        ? prev.map((item) => (item.id === rec.id ? rec : item))
        : [...prev, rec]
      void saveServers(next)
      return next
    })
  }, [])

  const handleDeleteServer = useCallback((id: string) => {
    setSavedServers((prev) => {
      const next = prev.filter((item) => item.id !== id)
      void saveServers(next)
      return next
    })
  }, [])

  // 深链配对：pocket-agent://connect?host=&port=&token=
  useEffect(() => {
    const apply = (url: string): void => {
      const { queryParams } = Linking.parse(url)
      if (queryParams && queryParams.host && queryParams.port && queryParams.token) {
        setPrefill({
          host: String(queryParams.host),
          port: String(queryParams.port),
          token: String(queryParams.token),
        })
      }
    }
    void Linking.getInitialURL().then((url) => {
      if (url) apply(url)
    })
    const sub = Linking.addEventListener('url', (e) => apply(e.url))
    return () => sub.remove()
  }, [])

  // 启动时自动连接上次的服务器
  useEffect(() => {
    void (async () => {
      const list = await loadServers()
      setSavedServers(list)
      const lastId = await getLastServerId()
      const last = list.find((item) => item.id === lastId)
      if (last && prefill == null) void connectTo(last)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---- 路由栈 --------------------------------------------------------------

  const push = useCallback((route: Route) => setStack((s) => [...s, route]), [])
  const replace = useCallback((route: Route) => setStack((s) => [...s.slice(0, -1), route]), [])
  const pop = useCallback(() => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)), [])
  const top = stack[stack.length - 1]

  const openTask = useCallback((id: string) => push({ name: 'task', id }), [push])

  const refreshFiles = useCallback(() => setFilesVersion((v) => v + 1), [])

  return (
    <SafeAreaView style={s.root}>
      <StatusBar barStyle="light-content" />
      {state === 'reconnecting' && top.name !== 'connect' ? (
        <Text style={s.reconnectBanner}>⚡ {statusText || '连接中断，正在重连…（任务在服务端继续运行）'}</Text>
      ) : null}
      {top.name === 'connect' ? (
        <ConnectScreen
          state={state}
          statusText={statusText}
          savedServers={savedServers}
          prefill={prefill}
          onConnect={(rec) => void connectTo(rec)}
          onSaveServer={handleSaveServer}
          onDeleteServer={handleDeleteServer}
        />
      ) : null}
      {top.name === 'home' && server ? (
        <HomeScreen
          server={server}
          agents={agents}
          tasks={tasks}
          statusText={state === 'connected' ? '' : statusText}
          onOpenAgent={(agent) => push({ name: 'agent', agent })}
          onOpenTasks={() => push({ name: 'tasks' })}
          onOpenFiles={() => push({ name: 'files', path: '.' })}
          onDisconnect={() => {
            client.disconnect()
            activeServerRef.current = null
          }}
        />
      ) : null}
      {top.name === 'agent' ? (
        <AgentScreen client={client} agent={top.agent} onOpenTask={openTask} />
      ) : null}
      {top.name === 'tasks' ? <TasksScreen client={client} onOpenTask={openTask} /> : null}
      {top.name === 'task' ? (
        <TaskDetailScreen
          client={client}
          taskId={top.id}
          onBack={pop}
          onReplaceTask={(id) => replace({ name: 'task', id })}
        />
      ) : null}
      {top.name === 'files' ? (
        <FilesScreen
          client={client}
          path={top.path}
          version={filesVersion}
          onOpenDir={(rel) => push({ name: 'files', path: rel })}
          onOpenFile={(rel) => push({ name: 'file', path: rel })}
          onRefresh={refreshFiles}
          onOpenTask={openTask}
        />
      ) : null}
      {top.name === 'file' ? (
        <FileScreen
          client={client}
          path={top.path}
          onChanged={refreshFiles}
          onBack={pop}
        />
      ) : null}
    </SafeAreaView>
  )
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  reconnectBanner: {
    color: theme.warn,
    backgroundColor: '#2a2313',
    fontSize: 12,
    textAlign: 'center',
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
})
