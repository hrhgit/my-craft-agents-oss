import { describe, expect, it } from 'bun:test'
import { runPreToolUseChecks } from '../pre-tool-use.ts'

const base = {
  workspaceRootPath: 'C:\\workspace',
  workspaceId: 'workspace',
}

describe('runPreToolUseChecks', () => {
  it('allows an ordinary tool after host normalization', () => {
    expect(runPreToolUseChecks({
      ...base,
      toolName: 'Read',
      input: { file_path: 'README.md' },
    })).toEqual({ type: 'allow' })
  })

  it('intercepts the canonical subagent host tool', () => {
    expect(runPreToolUseChecks({
      ...base,
      toolName: 'subagent',
      input: { prompt: 'Inspect the module' },
    })).toEqual({ type: 'subagent_intercept', input: { prompt: 'Inspect the module' } })
  })

  it('blocks when a selected skill prerequisite is unresolved', () => {
    expect(runPreToolUseChecks({
      ...base,
      toolName: 'Write',
      input: { file_path: 'output.txt', content: 'data' },
      prerequisiteManager: {
        checkPrerequisites: () => ({ allowed: false, blockReason: 'Read the selected skill first.' }),
        trackBashSkillRead: () => false,
      },
    })).toEqual({ type: 'block', reason: 'Read the selected skill first.', source: 'prerequisite' })
  })

  it('strips host-only metadata before tool execution', () => {
    expect(runPreToolUseChecks({
      ...base,
      toolName: 'custom_tool',
      input: { value: 1, _intent: 'Inspect', _displayName: 'Inspector' },
    })).toEqual({ type: 'modify', input: { value: 1 } })
  })
})
