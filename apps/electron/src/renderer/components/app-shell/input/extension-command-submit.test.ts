import { describe, expect, it } from 'bun:test'
import { matchExactExtensionCommand } from './extension-command-submit'

const commands = [{ name: 'plan' }, { name: 'compact-session' }]

describe('matchExactExtensionCommand', () => {
  it('recognizes an exact registered slash command', () => {
    expect(matchExactExtensionCommand('/plan', commands)?.name).toBe('plan')
    expect(matchExactExtensionCommand('  /plan  ', commands)?.name).toBe('plan')
  })

  it('does not consume unknown commands, command arguments, or ordinary text', () => {
    expect(matchExactExtensionCommand('/unknown', commands)).toBeUndefined()
    expect(matchExactExtensionCommand('/plan later', commands)).toBeUndefined()
    expect(matchExactExtensionCommand('plan', commands)).toBeUndefined()
  })
})
