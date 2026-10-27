import { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, Alert, FlatList, Pressable, StyleSheet, Text, View } from 'react-native'
import * as DocumentPicker from 'expo-document-picker'
import * as FS from 'expo-file-system/legacy'
import type { AgentClient } from '../lib/client'
import { theme } from '../theme'

interface ListEntry {
  name: string
  kind: 'directory' | 'file'
  size: number | null
  modifiedMs: number | null
}

function joinPath(dir: string, name: string): string {
  const base = dir === '' || dir === '.' ? '' : dir.replace(/\/+$/, '')
  return base ? `${base}/${name}` : name
}

function parentPath(dir: string): string {
  if (dir === '' || dir === '.') return ''
  const parts = dir.split('/')
  parts.pop()
  return parts.join('')
}

function fmtSize(bytes: number | null): string {
  if (bytes == null) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

interface Props {
  client: AgentClient
  path: string
  version: number
  onOpenDir: (rel: string) => void
  onOpenFile: (rel: string) => void
  onRefresh: () => void
  onOpenTask: (taskId: string) => void
}

/** 工作区文件浏览器：目录导航、上传（分片）、进入文件预览 */
export function FilesScreen({ client, path, version, onOpenDir, onOpenFile, onRefresh, onOpenTask }: Props) {
  const [entries, setEntries] = useState<ListEntry[] | null>(null)
  const [error, setError] = useState('')
  const [uploading, setUploading] = useState(false)

  const load = useCallback(async () => {
    setError('')
    setEntries(null)
    try {
      const result = (await client.request('files', 'list', { path })) as { entries?: ListEntry[] }
      setEntries(result.entries ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setEntries([])
    }
  }, [client, path])

  useEffect(() => {
    void load()
  }, [load, version])

  const pickAndUpload = async (): Promise<void> => {
    const res = await DocumentPicker.getDocumentAsync({ multiple: false, copyToCacheDirectory: true })
    if (res.canceled || !res.assets || res.assets.length === 0) return
    const asset = res.assets[0]
    const name = asset.name ?? `upload-${Date.now()}`
    setUploading(true)
    try {
      const base64 = await FS.readAsStringAsync(asset.uri, { encoding: FS.EncodingType.Base64 })
      const target = joinPath(path, name)
      const requestId = client.uploadFileStart(target, base64, false)
      setUploading(false)
      onOpenTask(requestId)
      onRefresh()
    } catch (err) {
      Alert.alert('上传失败', err instanceof Error ? err.message : String(err))
      setUploading(false)
    }
  }

  return (
    <View style={s.root}>
      <View style={s.header}>
        <Pressable onPress={() => onOpenDir(parentPath(path))} hitSlop={8} disabled={path === '' || path === '.'}>
          <Text style={[s.back, (path === '' || path === '.') && s.backDisabled]}>‹ 上级</Text>
        </Pressable>
        <Text style={s.path} numberOfLines={1}>
          /{path === '.' ? '' : path}
        </Text>
        <Pressable onPress={() => void load()} hitSlop={8}>
          <Text style={s.action}>↻</Text>
        </Pressable>
        <Pressable onPress={() => void pickAndUpload()} hitSlop={8} disabled={uploading}>
          <Text style={s.action}>{uploading ? '…' : '⬆ 上传'}</Text>
        </Pressable>
      </View>

      {error ? <Text style={s.error}>{error}</Text> : null}

      {entries === null ? (
        <View style={s.center}>
          <ActivityIndicator color={theme.accent} />
        </View>
      ) : (
        <FlatList
          data={entries}
          keyExtractor={(item) => `${item.kind}:${item.name}`}
          contentContainerStyle={s.list}
          ListEmptyComponent={<Text style={s.empty}>空目录</Text>}
          renderItem={({ item }) => (
            <Pressable
              style={s.row}
              onPress={() => (item.kind === 'directory' ? onOpenDir(joinPath(path, item.name)) : onOpenFile(joinPath(path, item.name)))}
            >
              <Text style={s.icon}>{item.kind === 'directory' ? '📁' : '📄'}</Text>
              <View style={s.rowText}>
                <Text style={[s.name, item.kind === 'directory' && s.dirName]} numberOfLines={1}>
                  {item.name}
                </Text>
                {item.size != null ? <Text style={s.meta}>{fmtSize(item.size)}</Text> : null}
              </View>
            </Pressable>
          )}
        />
      )}
    </View>
  )
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 16,
    paddingTop: 56,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
  },
  back: { color: theme.accent, fontSize: 15 },
  backDisabled: { color: theme.textDim, opacity: 0.4 },
  path: { color: theme.textDim, fontSize: 13, flex: 1, fontFamily: theme.mono },
  action: { color: theme.accent, fontSize: 14 },
  error: { color: theme.danger, fontSize: 12, paddingHorizontal: 16, paddingTop: 8 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  list: { paddingHorizontal: 16, paddingBottom: 24 },
  empty: { color: theme.textDim, fontSize: 13, textAlign: 'center', marginTop: 48 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: theme.card,
    borderColor: theme.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    padding: 14,
    marginBottom: 8,
  },
  icon: { fontSize: 18 },
  rowText: { flex: 1 },
  name: { color: theme.text, fontSize: 14 },
  dirName: { fontWeight: '600' },
  meta: { color: theme.textDim, fontSize: 11, marginTop: 2 },
})
