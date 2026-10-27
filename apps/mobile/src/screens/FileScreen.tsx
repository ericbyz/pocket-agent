import { useEffect, useState } from 'react'
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import * as FS from 'expo-file-system/legacy'
import * as Sharing from 'expo-sharing'
import type { AgentClient } from '../lib/client'
import { theme } from '../theme'

interface Props {
  client: AgentClient
  path: string
  onChanged: () => void
  onBack: () => void
}

/** 文件预览：查看 / 编辑 / 下载到手机（系统分享） / 删除 */
export function FileScreen({ client, path, onChanged, onBack }: Props) {
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)

  const load = async (): Promise<void> => {
    setError('')
    setContent(null)
    try {
      const result = (await client.request('files', 'read', { path })) as { content?: string }
      setContent(result.content ?? '')
      setDraft(result.content ?? '')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, path])

  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      await client.request('files', 'write', { path, content: draft })
      setContent(draft)
      setEditing(false)
      onChanged()
    } catch (err) {
      Alert.alert('保存失败', err instanceof Error ? err.message : String(err))
    }
    setBusy(false)
  }

  const download = async (): Promise<void> => {
    setBusy(true)
    try {
      const { base64 } = await client.downloadFile(path)
      const name = path.split('/').pop() ?? 'file'
      const target = `${FS.documentDirectory}${name}`
      await FS.writeAsStringAsync(target, base64, { encoding: FS.EncodingType.Base64 })
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(target, { dialogTitle: name })
      } else {
        Alert.alert('已保存', target)
      }
    } catch (err) {
      Alert.alert('下载失败', err instanceof Error ? err.message : String(err))
    }
    setBusy(false)
  }

  const remove = (): void => {
    Alert.alert('删除文件', `确定删除 ${path}？不可恢复。`, [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: async () => {
          setBusy(true)
          try {
            await client.request('files', 'delete', { path, confirm: true })
            setBusy(false)
            onChanged()
            onBack()
          } catch (err) {
            Alert.alert('删除失败', err instanceof Error ? err.message : String(err))
            setBusy(false)
          }
        },
      },
    ])
  }

  return (
    <View style={s.root}>
      <View style={s.header}>
        <Pressable onPress={onBack} hitSlop={12}>
          <Text style={s.back}>‹ 返回</Text>
        </Pressable>
        <Text style={s.path} numberOfLines={1}>
          {path}
        </Text>
        <Pressable onPress={remove} disabled={busy} hitSlop={8}>
          <Text style={s.danger}>删除</Text>
        </Pressable>
      </View>

      <View style={s.toolbar}>
        {editing ? (
          <>
            <Pressable style={[s.button, s.buttonPrimary]} onPress={() => void save()} disabled={busy}>
              <Text style={s.buttonPrimaryText}>{busy ? '保存中…' : '保存'}</Text>
            </Pressable>
            <Pressable style={s.button} onPress={() => setEditing(false)} disabled={busy}>
              <Text style={s.buttonText}>取消</Text>
            </Pressable>
          </>
        ) : (
          <>
            <Pressable style={s.button} onPress={() => setEditing(true)} disabled={content === null || busy}>
              <Text style={s.buttonText}>✎ 编辑</Text>
            </Pressable>
            <Pressable style={s.button} onPress={() => void download()} disabled={busy}>
              <Text style={s.buttonText}>⬇ 下载到手机</Text>
            </Pressable>
            <Pressable style={s.button} onPress={() => void load()} disabled={busy}>
              <Text style={s.buttonText}>↻ 刷新</Text>
            </Pressable>
          </>
        )}
      </View>

      {error ? (
        <View style={s.center}>
          <Text style={s.error}>{error}</Text>
        </View>
      ) : content === null ? (
        <View style={s.center}>
          <ActivityIndicator color={theme.accent} />
        </View>
      ) : editing ? (
        <TextInput
          style={s.editor}
          value={draft}
          onChangeText={setDraft}
          multiline
          autoCapitalize="none"
          autoCorrect={false}
          textAlignVertical="top"
        />
      ) : (
        <ScrollView style={s.viewer} contentContainerStyle={s.viewerContent}>
          <Text style={s.content} selectable>
            {content}
          </Text>
        </ScrollView>
      )}
    </View>
  )
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingTop: 56,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
  },
  back: { color: theme.accent, fontSize: 15 },
  path: { color: theme.text, fontSize: 14, flex: 1, fontFamily: theme.mono },
  danger: { color: theme.danger, fontSize: 14 },
  toolbar: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingVertical: 10 },
  button: {
    backgroundColor: theme.card,
    borderColor: theme.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  buttonPrimary: { backgroundColor: theme.accent, borderColor: theme.accent },
  buttonText: { color: theme.text, fontSize: 13 },
  buttonPrimaryText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  error: { color: theme.danger, fontSize: 13, textAlign: 'center' },
  viewer: { flex: 1, marginHorizontal: 12, marginBottom: 12, backgroundColor: theme.card, borderRadius: 10 },
  viewerContent: { padding: 12, paddingBottom: 24 },
  content: { color: theme.text, fontSize: 12, fontFamily: theme.mono, lineHeight: 18 },
  editor: {
    flex: 1,
    marginHorizontal: 12,
    marginBottom: 12,
    backgroundColor: theme.card,
    borderRadius: 10,
    padding: 12,
    color: theme.text,
    fontSize: 12,
    fontFamily: theme.mono,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.accent,
  },
})
