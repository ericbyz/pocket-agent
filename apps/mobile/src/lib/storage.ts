import AsyncStorage from '@react-native-async-storage/async-storage'

export interface ServerRecord {
  id: string
  name: string
  host: string
  port: string
  token: string
}

const KEY_SERVERS = 'pa.servers.v1'
const KEY_LAST = 'pa.lastServer'
const seqKey = (id: string): string => `pa.seq.${id}`

export async function loadServers(): Promise<ServerRecord[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY_SERVERS)
    const parsed = raw ? (JSON.parse(raw) as ServerRecord[]) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export async function saveServers(list: ServerRecord[]): Promise<void> {
  await AsyncStorage.setItem(KEY_SERVERS, JSON.stringify(list))
}

export async function getLastServerId(): Promise<string | null> {
  return AsyncStorage.getItem(KEY_LAST)
}

export async function setLastServerId(id: string): Promise<void> {
  await AsyncStorage.setItem(KEY_LAST, id)
}

/** 断线重连的事件游标（hello.since） */
export async function getSeq(serverId: string): Promise<number> {
  const raw = await AsyncStorage.getItem(seqKey(serverId))
  return raw ? Number.parseInt(raw, 10) || 0 : 0
}

export async function setSeq(serverId: string, seq: number): Promise<void> {
  await AsyncStorage.setItem(seqKey(serverId), String(seq))
}
