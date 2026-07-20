import { describe, expect, it } from 'bun:test'
import { calculateTimeOccurrence } from './occurrences.ts'

describe('Automations V3 time occurrences', () => {
  it('recovers one missed once occurrence and expires it deterministically', () => {
    const due = calculateTimeOccurrence({ id: 'trg_123456789abc', type: 'time', schedule: { kind: 'once', at: '2026-07-20T10:00:00Z' } }, { now: new Date('2026-07-20T10:05:00Z') })
    expect(due.due).toMatchObject({ scheduledAt: '2026-07-20T10:00:00.000Z', recovery: true })
    const expired = calculateTimeOccurrence({ id: 'trg_123456789abc', type: 'time', schedule: { kind: 'once', at: '2026-07-20T10:00:00Z', expiresAt: '2026-07-20T10:01:00Z' } }, { now: new Date('2026-07-20T10:05:00Z') })
    expect(expired.due?.skipReason).toBe('expired')
  })

  it('persists a skipped once misfire as a completed occurrence', () => {
    const result = calculateTimeOccurrence({
      id: 'trg_once_skip', type: 'time',
      schedule: { kind: 'once', at: '2026-07-20T09:00:00Z', misfire: 'skip' },
    }, { now: new Date('2026-07-20T10:00:00Z') })
    expect(result.completed).toBe(true)
    expect(result.due).toMatchObject({
      scheduledAt: '2026-07-20T09:00:00.000Z',
      skipReason: 'misfire',
    })
  })

  it('coalesces missed intervals while preserving the anchor', () => {
    const result = calculateTimeOccurrence({
      id: 'trg_123456789abc', type: 'time',
      schedule: { kind: 'interval', everyMs: 60_000, anchorAt: '2026-07-20T10:00:00Z' },
    }, { now: new Date('2026-07-20T10:05:30Z'), lastClaimedAt: new Date('2026-07-20T10:01:00Z') })
    expect(result.due?.occurrenceKey).toContain('interval:5:')
    expect(result.next?.scheduledAt).toBe('2026-07-20T10:06:00.000Z')
  })

  it('supports six-field cron and skips missed cron by default', () => {
    const result = calculateTimeOccurrence({
      id: 'trg_123456789abc', type: 'time', schedule: { kind: 'cron', expression: '*/10 * * * * *', timezone: 'UTC' },
    }, { now: new Date('2026-07-20T10:00:25Z'), lastClaimedAt: new Date('2026-07-20T10:00:00Z') })
    expect(result.due).toBeUndefined()
    expect(result.next?.scheduledAt).toBe('2026-07-20T10:00:30.000Z')
  })

  it('claims a five-field cron occurrence when the timer wakes inside its scheduled minute', () => {
    const result = calculateTimeOccurrence({
      id: 'trg_123456789abc', type: 'time', schedule: { kind: 'cron', expression: '0 10 * * *', timezone: 'UTC' },
    }, { now: new Date('2026-07-20T10:00:00.250Z') })
    expect(result.due).toMatchObject({ scheduledAt: '2026-07-20T10:00:00.000Z', recovery: false })
  })
})
