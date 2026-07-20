const SENSITIVE_KEY = /(?:^|[_-])(token|key|secret|password|authorization|cookie|private[_-]?key)(?:$|[_-])/i
const CAMEL_SENSITIVE_KEY = /(?:accessToken|refreshToken|apiKey|privateKey|clientSecret)/i
const URL_VALUE = /([?&](?:access_token|refresh_token|api_key|key|token|secret|signature|sig|password)=)[^&#\s]*/gi
const BEARER = /\b(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi
const COMMON_SECRET = /\b((?:sk|pk|api|key)[-_][A-Za-z0-9_-]{8,})\b/g

const MAX_DEPTH = 8
const MAX_KEYS = 100
const MAX_ARRAY = 100
const MAX_STRING = 4_096

export function redactString(value: string): string {
  const bounded = value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}...[truncated ${value.length - MAX_STRING} chars]` : value
  return bounded
    .replace(BEARER, '$1[REDACTED]')
    .replace(URL_VALUE, '$1[REDACTED]')
    .replace(COMMON_SECRET, '[REDACTED]')
}

export function sanitizeForDisclosure(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'string') return redactString(value)
  if (typeof value !== 'object') return String(value)
  if (depth >= MAX_DEPTH) return '[MAX_DEPTH]'
  if (seen.has(value)) return '[CIRCULAR]'
  seen.add(value)
  if (Array.isArray(value)) {
    const result = value.slice(0, MAX_ARRAY).map(item => sanitizeForDisclosure(item, depth + 1, seen))
    if (value.length > MAX_ARRAY) result.push(`[${value.length - MAX_ARRAY} items omitted]`)
    return result
  }
  if (value instanceof Error) {
    return sanitizeForDisclosure({ name: value.name, message: value.message, stack: value.stack }, depth + 1, seen)
  }
  const entries = Object.entries(value as Record<string, unknown>)
  const result: Record<string, unknown> = {}
  for (const [key, item] of entries.slice(0, MAX_KEYS)) {
    result[key] = SENSITIVE_KEY.test(key) || CAMEL_SENSITIVE_KEY.test(key)
      ? '[REDACTED]'
      : sanitizeForDisclosure(item, depth + 1, seen)
  }
  if (entries.length > MAX_KEYS) result.__omittedKeys = entries.length - MAX_KEYS
  return result
}
