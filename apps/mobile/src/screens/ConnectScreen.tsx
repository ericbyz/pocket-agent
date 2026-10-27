import { useEffect, useState } from 'react'
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import type { ClientState } from '../lib/client'
import type { ServerRecord } from '../lib/storage'
import { theme } from '../theme'

export interface ConnectPrefill {
  host: string
  port: string
  token: string
}

interface Props {
  state: ClientState
  statusText: string
  savedServers: ServerRecord[]
  prefill: ConnectPrefill | null
  onConnect: (rec: ServerRecord) => void
  onSaveServer: (rec: ServerRecord) => void
  onDeleteServer: (id: string) => void
}

export function ConnectScreen({ state, statusText, savedServers, prefill, onConnect, onSaveServer, onDeleteServer }: Props) {
  const [host, setHost] = useState('')
  const [port, setPort] = useState('4310')
  const [token, setToken] = useState('')
  const [name, setName] = useState('')
  const [qrFilled, setQrFilled] = useState(false)

  useEffect(() => {
    if (prefill) {
      setHost(prefill.host)
      setPort(prefill.port)
      setToken(prefill.token)
      setQrFilled(true)
    }
  }, [prefill])

  const busy = state === 'connecting' || state === 'reconnecting'

  const connect = (): void => {
    const rec: ServerRecord = {
      id: `srv-${host}-${port}`,
      name: name.trim() || `${host}:${port}`,
      host: host.trim(),
      port: port.trim() || '4310',
      token: token.trim(),
    }
    if (!rec.host || !rec.token) return
    onSaveServer(rec)
    onConnect(rec)
  }

  return (
    <KeyboardAvoidingView style={s.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView style={s.root} contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
        <Text style={s.logo}>⚡</Text>
        <Text style={s.title}>Pocket Agent</Text>
        <Text style={s.subtitle}>用手机驱动 Windows 上的各种 Agent</Text>

        {savedServers.length > 0 ? (
          <View style={s.section}>
            <Text style={s.sectionTitle}>已保存的服务器</Text>
            {savedServers.map((rec) => (
              <View key={rec.id} style={s.savedRow}>
                <Pressable style={s.savedButton} onPress={() => onConnect(rec)} disabled={busy}>
                  <Text style={s.savedName}>{rec.name}</Text>
                  <Text style={s.savedMeta}>
                    {rec.host}:{rec.port}
                  </Text>
                </Pressable>
                <Pressable hitSlop={8} onPress={() => onDeleteServer(rec.id)}>
                  <Text style={s.savedDelete}>✕</Text>
                </Pressable>
              </View>
            ))}
          </View>
        ) : null}

        <View style={s.card}>
          <Text style={s.label}>{qrFilled ? '已从二维码填入 ✓ 直接点「连 接」' : '手动连接（或扫服务端终端里的二维码）'}</Text>
          <Text style={s.label}>名称（可选）</Text>
          <TextInput style={s.input} value={name} onChangeText={setName} placeholder="如：书房台式机" placeholderTextColor={theme.textDim} />
          <Text style={s.label}>服务端地址</Text>
          <TextInput
            style={s.input}
            value={host}
            onChangeText={setHost}
            placeholder="例如 192.168.1.8"
            placeholderTextColor={theme.textDim}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Text style={s.label}>端口</Text>
          <TextInput style={s.input} value={port} onChangeText={setPort} keyboardType="number-pad" />
          <Text style={s.label}>配对 Token</Text>
          <TextInput
            style={[s.input, s.mono]}
            value={token}
            onChangeText={setToken}
            placeholder="服务端控制台输出"
            placeholderTextColor={theme.textDim}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Pressable style={[s.button, busy && s.buttonDisabled]} disabled={busy} onPress={connect}>
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={s.buttonText}>连 接</Text>}
          </Pressable>
          {statusText ? <Text style={[s.status, state === 'error' && s.statusError]}>{statusText}</Text> : null}
        </View>

        <Text style={s.tips}>提示：手机与服务端需在同一局域网；扫终端二维码可免手动输入。断线后 App 自动重连并补发错过的事件。</Text>
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

const s = StyleSheet.create({
  flex: { flex: 1, backgroundColor: theme.bg },
  root: { flex: 1, backgroundColor: theme.bg },
  content: { padding: 24, paddingTop: 64 },
  logo: { fontSize: 52, textAlign: 'center' },
  title: { color: theme.text, fontSize: 26, fontWeight: '700', textAlign: 'center', marginTop: 8 },
  subtitle: { color: theme.textDim, fontSize: 14, textAlign: 'center', marginTop: 6, marginBottom: 24 },
  section: { marginBottom: 20 },
  sectionTitle: { color: theme.textDim, fontSize: 12, marginBottom: 8, letterSpacing: 1 },
  savedRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  savedButton: {
    flex: 1,
    backgroundColor: theme.card,
    borderColor: theme.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    padding: 12,
  },
  savedName: { color: theme.text, fontSize: 15, fontWeight: '600' },
  savedMeta: { color: theme.textDim, fontSize: 12, marginTop: 2, fontFamily: theme.mono },
  savedDelete: { color: theme.textDim, fontSize: 16, paddingHorizontal: 6 },
  card: {
    backgroundColor: theme.card,
    borderColor: theme.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 14,
    padding: 18,
  },
  label: { color: theme.textDim, fontSize: 12, marginTop: 12, marginBottom: 6 },
  input: {
    backgroundColor: theme.bg,
    borderColor: theme.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    color: theme.text,
    fontSize: 15,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  mono: { fontFamily: theme.mono },
  button: { backgroundColor: theme.accent, borderRadius: 10, marginTop: 20, paddingVertical: 13, alignItems: 'center' },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  status: { color: theme.textDim, fontSize: 13, marginTop: 12, textAlign: 'center' },
  statusError: { color: theme.danger },
  tips: { color: theme.textDim, fontSize: 12, lineHeight: 18, marginTop: 20, textAlign: 'center' },
})
