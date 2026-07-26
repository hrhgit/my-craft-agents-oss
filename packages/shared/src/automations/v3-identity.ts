import { createHash } from 'node:crypto'

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(',')}}`
}

export function automationIdentity(prefix: string, ...parts: unknown[]): string {
  return `${prefix}_${createHash('sha256').update(canonical(parts)).digest('hex')}`
}

export function canonicalAutomationValue(value: unknown): string {
  return canonical(value)
}
