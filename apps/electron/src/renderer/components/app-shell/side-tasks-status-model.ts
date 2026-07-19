import type { PiChildSessionInfo } from '@mortise/shared/agent'
import type { SessionEvent } from '@mortise/shared/protocol'

export interface SideTaskSections {
  running: PiChildSessionInfo[]
  completed: PiChildSessionInfo[]
}

export function applySideTaskSessionNames(
  tasks: PiChildSessionInfo[],
  sessionNames: ReadonlyMap<string, string | undefined>,
): PiChildSessionInfo[] {
  return tasks.map(task => {
    if (task.name?.trim()) return task
    const sessionName = sessionNames.get(task.sessionId)?.trim()
    return sessionName ? { ...task, name: sessionName } : task
  })
}

export function sideTaskTitle(
  task: Pick<PiChildSessionInfo, 'name' | 'firstMessage'>,
  fallback: string,
): string {
  return task.name?.trim() || task.firstMessage?.trim() || fallback
}

export function partitionSideTasks(
  tasks: PiChildSessionInfo[],
  runningSessionIds: ReadonlySet<string>,
): SideTaskSections {
  const sections: SideTaskSections = { running: [], completed: [] }
  for (const task of tasks) {
    sections[runningSessionIds.has(task.sessionId) ? 'running' : 'completed'].push(task)
  }
  return sections
}

export function sideTaskSemanticPart(sessionId: string): string {
  const readable = sessionId
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48) || 'session'
  let hash = 2166136261
  for (let index = 0; index < sessionId.length; index += 1) {
    hash ^= sessionId.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `${readable}.${(hash >>> 0).toString(16).padStart(8, '0')}`
}

const PARENT_REFRESH_EVENTS = new Set<SessionEvent['type']>([
  'tool_result',
  'complete',
  'title_generated',
  'name_changed',
])

const CHILD_REFRESH_EVENTS = new Set<SessionEvent['type']>([
  'complete',
  'interrupted',
  'error',
  'typed_error',
  'title_generated',
  'name_changed',
  'async_operation',
])

export function shouldRefreshSideTasks(
  event: SessionEvent,
  parentSessionId: string,
  knownChildSessionIds: ReadonlySet<string>,
): boolean {
  if (event.sessionId === parentSessionId) return PARENT_REFRESH_EVENTS.has(event.type)
  return knownChildSessionIds.has(event.sessionId) && CHILD_REFRESH_EVENTS.has(event.type)
}

export function shouldShowSideTasksTrigger(
  taskCount: number,
  loading: boolean,
  error: string | null,
): boolean {
  return loading || Boolean(error) || taskCount > 0
}
