import { describe, expect, it } from 'bun:test'
import { parseAutomationInitializationWarnings } from '../system-warnings.ts'

describe('system warnings', () => {
  it('parses validated automation initialization failures', () => {
    expect(parseAutomationInitializationWarnings(JSON.stringify([
      { workspaceId: 'workspace-1', workspaceName: 'Project', message: 'database identity mismatch' },
      { workspaceId: '', workspaceName: 'Ignored', message: 'invalid' },
    ]))).toEqual([
      { workspaceId: 'workspace-1', workspaceName: 'Project', message: 'database identity mismatch' },
    ])
  })

  it('ignores malformed values', () => {
    expect(parseAutomationInitializationWarnings(undefined)).toEqual([])
    expect(parseAutomationInitializationWarnings('{')).toEqual([])
    expect(parseAutomationInitializationWarnings('{}')).toEqual([])
  })
})
