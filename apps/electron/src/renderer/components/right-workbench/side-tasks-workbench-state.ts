import type { PiChildSessionInfo } from '@craft-agent/shared/agent'

export function sideTaskTitle(
  task: Pick<PiChildSessionInfo, 'name' | 'firstMessage'>,
  fallback: string,
): string {
  return task.name?.trim() || task.firstMessage.trim() || fallback
}
