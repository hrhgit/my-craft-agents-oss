import { describe, expect, it } from 'bun:test'
import { sideTaskTitle } from './side-tasks-workbench-state'

describe('side tasks workbench', () => {
  it('uses stable user-facing title fallbacks without inventing task state', () => {
    expect(sideTaskTitle({ name: '  Review  ', firstMessage: 'Inspect files' }, 'Untitled')).toBe('Review')
    expect(sideTaskTitle({ name: ' ', firstMessage: '  Inspect files  ' }, 'Untitled')).toBe('Inspect files')
    expect(sideTaskTitle({ firstMessage: '  ' }, 'Untitled')).toBe('Untitled')
  })
})
