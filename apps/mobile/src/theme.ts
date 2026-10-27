import { Platform } from 'react-native'

export const theme = {
  bg: '#0e1116',
  card: '#161b24',
  border: '#242b3a',
  text: '#e8ebf2',
  textDim: '#8b93a7',
  accent: '#4f8cff',
  accentDim: '#22304d',
  ok: '#3ecf8e',
  warn: '#f5b453',
  danger: '#ff6161',
  mono: (Platform.select({ ios: 'Menlo', default: 'monospace' }) ?? 'monospace') as string,
}
