import { describe, expect, it } from 'bun:test'
import { createSanitizedEnv } from './env'

describe('createSanitizedEnv', () => {
  it('removes stale capsule runtime state while preserving ordinary process state', () => {
    const env = createSanitizedEnv({
      PATH: 'fixture-path',
      MORTISE_RUNTIME_IMMUTABLE: '1',
      MORTISE_RUNTIME_APP_ROOT: 'stale-app',
      MORTISE_WORKSPACE_SERVER_ENTRY: 'stale-server',
      MORTISE_BUILD_DIR: 'stale-build',
      OPENAI_API_KEY: 'secret',
    })

    expect(env).toEqual({ PATH: 'fixture-path', MORTISE_BUILD_DIR: 'stale-build' })
  })
})
