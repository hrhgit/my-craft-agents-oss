import { describe, expect, test } from 'bun:test'
import * as agentApi from '../../index.ts'
import * as backendApi from '../index.ts'

describe('shared Agent public boundaries', () => {
  test('does not expose concrete Pi runtime implementations', () => {
    expect(agentApi).not.toHaveProperty('PiAgent')
    expect(agentApi).not.toHaveProperty('PiBackend')
    expect(agentApi).not.toHaveProperty('BaseAgent')
    expect(agentApi).not.toHaveProperty('createBackend')
    expect(backendApi).not.toHaveProperty('piHostManager')
    expect(backendApi).not.toHaveProperty('PiHostManager')
    expect(backendApi).not.toHaveProperty('PiHostProtocolError')
  })

  test('exposes only the narrow backend runtime invalidation operation', () => {
    expect(backendApi.invalidateBackendRuntimes).toBeFunction()
  })
})
