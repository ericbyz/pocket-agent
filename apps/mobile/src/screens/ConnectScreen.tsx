import { useState } from 'react'
import {
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
import { theme } from '../theme'

interface Props {
  state: ClientState
  statusText: string
  onConnect: (host: string, port: string, token: string) => void
}

export function ConnectScreen({ state, statusText, onConnect }: Props) {
  const [host, setHost] = useState('')
  const [port, setPort] = useState('4310')
  const [token, setToken] = useState('')
  const connecting = state === 'connecting'

  return (
    <KeyboardAvoidingView style={s.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView style={s.root} contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
        <Text style={s.logo}>⚡</Text>
        <Text style={s.title}>Pocket Agent</Text>
        <Text style={s.subtitle}>连接 Windows 服务端，随身驱动各种 Agent</Text>

        <View style={s.card}>
          <Text style={s.label}>服务端地址（服务端启动时会打印）</Text>
          <TextInput
            style={s.input}
            value={host}
            onChangeText={setHost}
            placeholder="例如 192.168.1.8"
            placeholderTextColor={theme.textDim}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="numbers-and-punctuation"
          />
          <Text style={s.label}>端口</Text>
          <TextInput style={s.input} value={port} onChangeText={setPort} keyboardType="number-pad" />
          <Text style={s.label}>配对 Token</Text>
          <TextInput
            style={[s.input, s.mono]}
            value={token}
            onChangeText={setToken}
            placeholder="服务端控制台输出的 token"
            placeholderTextColor={theme.textDim}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Pressable
            style={[s.button, connecting && s.buttonDisabled]}
            disabled={connecting}
            onPress={() => onConnect(host.trim(), port.trim(), token.trim())}
          >
            <Text style={s.buttonText}>{connecting ? '连接中…' : '连 接'}</Text>
          </Pressable>
          {statusText ? (
            <Text style={[s.status, state === 'error' && s.statusError]}>{statusText}</Text>
          ) : null}
        </View>

        <Text style={s.tips}>
          提示：手机与服务端需在同一局域网；首次启动服务端时 Windows 防火墙弹窗请选择「允许」。
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

const s = StyleSheet.create({
  flex: { flex: 1, backgroundColor: theme.bg },
  root: { flex: 1, backgroundColor: theme.bg },
  content: { padding: 24, paddingTop: 72 },
  logo: { fontSize: 56, textAlign: 'center' },
  title: { color: theme.text, fontSize: 26, fontWeight: '700', textAlign: 'center', marginTop: 8 },
  subtitle: { color: theme.textDim, fontSize: 14, textAlign: 'center', marginTop: 6, marginBottom: 28 },
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
  button: {
    backgroundColor: theme.accent,
    borderRadius: 10,
    marginTop: 20,
    paddingVertical: 13,
    alignItems: 'center',
  },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  status: { color: theme.textDim, fontSize: 13, marginTop: 12, textAlign: 'center' },
  statusError: { color: theme.danger },
  tips: { color: theme.textDim, fontSize: 12, lineHeight: 18, marginTop: 20, textAlign: 'center' },
})
