import { describe, expect, it } from 'bun:test'
import { PiAgent } from '../pi-agent.ts'
import type { BackendConfig } from '../backend/types.ts'

function createConfig(overrides: Partial<BackendConfig> = {}): BackendConfig {
  return {
    provider: 'pi',
    workspace: {
      id: 'ws-test',
      name: 'Test Workspace',
      rootPath: '/tmp/mortise-test',
    } as any,
    session: {
      id: 'session-test',
      workspaceRootPath: '/tmp/mortise-test',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    } as any,
    isHeadless: true,
    ...overrides,
  }
}

describe('PiAgent Bedrock env handling', () => {
  it('buildAwsEnv uses only AWS credential env and no Pi private runtime toggles', () => {
    const agent = new PiAgent(createConfig())

    const env = (agent as any).buildAwsEnv(
      {
        credential: {
          type: 'iam',
          accessKeyId: 'AKIA_TEST',
          secretAccessKey: 'secret',
          sessionToken: 'session',
          region: 'eu-central-1',
        },
      },
      { piAuthProvider: 'amazon-bedrock' },
    ) as Record<string, string>

    expect(env.AWS_ACCESS_KEY_ID).toBe('AKIA_TEST')
    expect(env.AWS_SECRET_ACCESS_KEY).toBe('secret')
    expect(env.AWS_SESSION_TOKEN).toBe('session')
    expect(env.AWS_REGION).toBe('eu-central-1')
    expect(env.AWS_BEDROCK_FORCE_HTTP1).toBeUndefined()
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined()

    agent.destroy()
  })

  it('buildAwsEnv returns empty env for non-Bedrock Pi providers', () => {
    const agent = new PiAgent(createConfig())

    const env = (agent as any).buildAwsEnv(
      {
        credential: {
          type: 'iam',
          accessKeyId: 'AKIA_TEST',
          secretAccessKey: 'secret',
          region: 'eu-central-1',
        },
      },
      { piAuthProvider: 'anthropic' },
    ) as Record<string, string>

    expect(env).toEqual({})

    agent.destroy()
  })

  it('buildAwsEnv re-adds AWS credential chain only for explicit environment auth', () => {
    const previous = {
      AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
      AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
      AWS_SESSION_TOKEN: process.env.AWS_SESSION_TOKEN,
      AWS_REGION: process.env.AWS_REGION,
    }
    process.env.AWS_ACCESS_KEY_ID = 'AKIA_ENV'
    process.env.AWS_SECRET_ACCESS_KEY = 'env-secret'
    process.env.AWS_SESSION_TOKEN = 'env-session'
    process.env.AWS_REGION = 'us-west-2'

    const agent = new PiAgent(createConfig({ authType: 'environment' }))
    try {
      const env = (agent as any).buildAwsEnv(null, { piAuthProvider: 'amazon-bedrock' }) as Record<string, string>

      expect(env.AWS_ACCESS_KEY_ID).toBe('AKIA_ENV')
      expect(env.AWS_SECRET_ACCESS_KEY).toBe('env-secret')
      expect(env.AWS_SESSION_TOKEN).toBe('env-session')
      expect(env.AWS_REGION).toBe('us-west-2')
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key]
        } else {
          process.env[key] = value
        }
      }
      agent.destroy()
    }
  })
})
