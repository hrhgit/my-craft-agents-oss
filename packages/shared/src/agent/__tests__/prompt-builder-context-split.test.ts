import { describe, expect, it } from 'bun:test'
import { TestAgent, createMockBackendConfig } from './test-utils.ts'

function makeBuilder() {
  return new TestAgent(createMockBackendConfig()).getPromptBuilder()
}

describe('PromptBuilder request context boundary', () => {
  it('does not prepend volatile or stable runtime context', () => {
    const builder = makeBuilder()
    const options = { plansFolderPath: '/tmp/plans', dataFolderPath: '/tmp/data' }

    expect(builder.buildVolatileContextParts(options)).toEqual([])
    expect(builder.buildStableContextParts()).toEqual([])
    expect(builder.buildContextParts(options)).toEqual([])
    expect(builder.getWorkingDirectoryContext()).toBeNull()
  })
})
