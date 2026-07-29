import { Cron } from 'croner'
import type { TimeTriggerV3 } from '../automations/v3-types.ts'

export interface ScheduledOccurrenceV1 {
  occurrenceKey: string
  scheduledAt: string
  recovery: boolean
  skipReason?: 'missed'
}

export interface OccurrenceCalculationV1 {
  due?: ScheduledOccurrenceV1
  next?: ScheduledOccurrenceV1
  completed?: boolean
}

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

export function intervalIndex(anchorMs: number, occurrenceMs: number, everyMs: number): number {
  return Math.floor((occurrenceMs - anchorMs) / everyMs)
}

export function calculateTimeOccurrence(
  trigger: TimeTriggerV3,
  options: { now: Date; lastClaimedAt?: Date; activeSince?: Date },
): OccurrenceCalculationV1 {
  const nowMs = options.now.getTime()
  const lastMs = options.lastClaimedAt?.getTime()
  const activeSinceMs = options.activeSince?.getTime() ?? nowMs
  const schedule = trigger.schedule

  if (schedule.kind === 'once') {
    const atMs = Date.parse(schedule.at)
    if (lastMs !== undefined && lastMs >= atMs) return { completed: true }
    if (atMs > nowMs) return { next: { occurrenceKey: iso(atMs), scheduledAt: iso(atMs), recovery: false } }
    const missed = atMs < activeSinceMs
      || (schedule.expiresAt !== undefined && Date.parse(schedule.expiresAt) < nowMs)
    return {
      completed: true,
      due: {
        occurrenceKey: iso(atMs),
        scheduledAt: iso(atMs),
        recovery: missed,
        ...(missed ? { skipReason: 'missed' as const } : {}),
      },
    }
  }

  if (schedule.kind === 'interval') {
    const anchorMs = Date.parse(schedule.anchorAt)
    if (nowMs < anchorMs) return {
      next: { occurrenceKey: `interval:0:${iso(anchorMs)}`, scheduledAt: iso(anchorMs), recovery: false },
    }
    const currentIndex = Math.floor((nowMs - anchorMs) / schedule.everyMs)
    const lastIndex = lastMs === undefined || lastMs < anchorMs ? -1 : intervalIndex(anchorMs, lastMs, schedule.everyMs)
    const boundaryMs = anchorMs + currentIndex * schedule.everyMs
    const nextMs = anchorMs + (currentIndex + 1) * schedule.everyMs
    const unseen = currentIndex > lastIndex
    const missed = boundaryMs < activeSinceMs
    return {
      ...(unseen ? { due: {
        occurrenceKey: `interval:${currentIndex}:${iso(boundaryMs)}`,
        scheduledAt: iso(boundaryMs),
        recovery: missed,
        ...(missed ? { skipReason: 'missed' as const } : {}),
      } } : {}),
      next: { occurrenceKey: `interval:${currentIndex + 1}:${iso(nextMs)}`, scheduledAt: iso(nextMs), recovery: false },
    }
  }

  const cron = new Cron(schedule.expression, schedule.timezone ? { timezone: schedule.timezone } : {})
  const matchesNow = cron.match(options.now)
  const previous = matchesNow
    ? new Date(Math.floor(nowMs / 1_000) * 1_000)
    : cron.previousRuns(1, options.now)[0] ?? null
  const next = cron.nextRun(options.now)
  const unseen = previous && (lastMs === undefined || previous.getTime() > lastMs)
  const missed = !!previous && previous.getTime() < activeSinceMs
  const due = unseen
    ? {
        occurrenceKey: previous.toISOString(),
        scheduledAt: previous.toISOString(),
        recovery: missed,
        ...(missed ? { skipReason: 'missed' as const } : {}),
      }
    : undefined
  return {
    ...(due ? { due } : {}),
    ...(next ? { next: { occurrenceKey: next.toISOString(), scheduledAt: next.toISOString(), recovery: false } } : {}),
  }
}
