export function asRecord(params: unknown): Record<string, unknown> {
  if (params === undefined || params === null) return {}
  if (typeof params !== 'object' || Array.isArray(params)) {
    throw new Error('params 必须是 JSON 对象')
  }
  return params as Record<string, unknown>
}

export function requireString(params: Record<string, unknown>, key: string): string {
  const value = params[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`缺少必填参数 ${key}`)
  }
  return value
}

export function optionalString(params: Record<string, unknown>, key: string, fallback = ''): string {
  const value = params[key]
  return typeof value === 'string' ? value : fallback
}

export function optionalNumber(
  params: Record<string, unknown>,
  key: string,
  opts: { min?: number; max?: number; fallback: number },
): number {
  const value = params[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) return opts.fallback
  if (opts.min != null && value < opts.min) return opts.fallback
  if (opts.max != null && value > opts.max) return opts.fallback
  return value
}

export function optionalBool(params: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = params[key]
  return typeof value === 'boolean' ? value : fallback
}
