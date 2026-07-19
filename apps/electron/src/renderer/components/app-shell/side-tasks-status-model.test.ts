import { describe, expect, it } from 'bun:test'
import type { PiChildSessionInfo } from '@mortise/shared/agent'
import type { SessionEvent } from '@mortise/shared/protocol'
import {
  applySideTaskSessionNames,
  partitionSideTasks,
  shouldRefreshSideTasks,
  shouldShowSideTasksTrigger,
  sideTaskSemanticPart,
  sideTaskTitle,
} from './side-tasks-status-model'

function task(sessionId: string): PiChildSessionInfo {
  return {
    sessionId,
    sessionPath: `${sessionId}.jsonl`,
    cwd: '/workspace',
    created: '2026-07-18T00:00:00.000Z',
    modified: '2026-07-18T00:00:00.000Z',
    messageCount: 1,
    firstMessage: `Prompt for ${sessionId}`,
  }
}

describe('side tasks status model', () => {
  it('uses Mortise session names when Pi child metadata has no explicit name', () => {
    const unnamed = { ...task('child-a'), name: undefined, firstMessage: 'Long first prompt' }
    const explicit = { ...task('child-b'), name: 'Explicit name', firstMessage: 'Prompt' }

    expect(applySideTaskSessionNames(
      [unnamed, explicit],
      new Map([['child-a', 'Short Mortise name'], ['child-b', 'Ignored Mortise name']]),
    )).toMatchObject([
      { sessionId: 'child-a', name: 'Short Mortise name' },
      { sessionId: 'child-b', name: 'Explicit name' },
    ])
  })

  it('uses the explicit name, prompt, and fallback title in that order', () => {
    expect(sideTaskTitle({ name: '  Review  ', firstMessage: 'Inspect files' }, 'Untitled')).toBe('Review')
    expect(sideTaskTitle({ name: ' ', firstMessage: '  Inspect files  ' }, 'Untitled')).toBe('Inspect files')
    expect(sideTaskTitle({ firstMessage: '  ' }, 'Untitled')).toBe('Untitled')
  })

  it('partitions child sessions from live session processing state without reordering them', () => {
    const tasks = [task('done-a'), task('running-a'), task('done-b'), task('running-b')]
    const sections = partitionSideTasks(tasks, new Set(['running-a', 'running-b']))

    expect(sections.running.map(item => item.sessionId)).toEqual(['running-a', 'running-b'])
    expect(sections.completed.map(item => item.sessionId)).toEqual(['done-a', 'done-b'])
  })

  it('creates bounded registry-safe semantic identity parts without path collisions', () => {
    const pathId = sideTaskSemanticPart('parent/session 1')
    const underscoreId = sideTaskSemanticPart('parent_session 1')
    expect(pathId).toMatch(/^parent_session_1\.[a-f0-9]{8}$/)
    expect(underscoreId).toMatch(/^parent_session_1\.[a-f0-9]{8}$/)
    expect(pathId).not.toBe(underscoreId)
    expect(pathId).toMatch(/^[A-Za-z0-9._:-]+$/)
  })

  it('refreshes from generic parent and known-child lifecycle events only', () => {
    const event = (type: SessionEvent['type'], sessionId: string): SessionEvent => ({ type, sessionId } as SessionEvent)
    const children = new Set(['child-1'])

    for (const type of ['tool_result', 'complete', 'title_generated', 'name_changed'] as const) {
      expect(shouldRefreshSideTasks(event(type, 'parent'), 'parent', children)).toBe(true)
    }
    for (const type of ['complete', 'interrupted', 'error', 'typed_error', 'title_generated', 'name_changed', 'async_operation'] as const) {
      expect(shouldRefreshSideTasks(event(type, 'child-1'), 'parent', children)).toBe(true)
    }
    expect(shouldRefreshSideTasks(event('text_delta', 'parent'), 'parent', children)).toBe(false)
    expect(shouldRefreshSideTasks(event('complete', 'unknown-child'), 'parent', children)).toBe(false)
  })

  it('hides only the settled empty trigger while retaining loading and error access', () => {
    expect(shouldShowSideTasksTrigger(0, false, null)).toBe(false)
    expect(shouldShowSideTasksTrigger(0, true, null)).toBe(true)
    expect(shouldShowSideTasksTrigger(0, false, 'offline')).toBe(true)
    expect(shouldShowSideTasksTrigger(1, false, null)).toBe(true)
  })
})
