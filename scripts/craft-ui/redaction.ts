const SENSITIVE_KEY = /(?:^|[_-])(authorization|cookie|password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)(?:$|[_-])/i
const BEARER = /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi
const URL_CREDENTIAL = /(https?:\/\/[^\s:/?#]+:)[^@\s/]+@/gi
const COMMON_SECRET = /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b/g

export function redactText(value: string, secrets: readonly string[] = []): string {
  let output = value
    .replace(BEARER, 'Bearer [REDACTED]')
    .replace(URL_CREDENTIAL, '$1[REDACTED]@')
    .replace(COMMON_SECRET, '[REDACTED]')
    .replace(/\b(?:https?|wss?|file):\/\/[^\s"'<>]+/gi, redactUrl)
  for (const secret of secrets) {
    if (secret.length >= 8) output = output.split(secret).join('[REDACTED]')
  }
  return output
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value)
    for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, '[REDACTED]')
    if (url.username) url.username = '[REDACTED]'
    if (url.password) url.password = '[REDACTED]'
    return url.toString()
  } catch {
    return value
  }
}

export function redactValue(value: unknown, secrets: readonly string[] = []): unknown {
  if (typeof value === 'string') return redactText(value, secrets)
  if (Array.isArray(value)) return value.map(item => redactValue(item, secrets))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
    key,
    SENSITIVE_KEY.test(key) ? '[REDACTED]' : redactValue(item, secrets),
  ]))
}
