import { describe, expect, it } from 'bun:test'
import { workspaceRouteKey } from '../workspace-runtime-registry'
import { WorkspaceRuntimeGenerationTracker, WorkspaceRuntimeUpdateQueue } from '../workspace-runtime-generation'

describe('WorkspaceRuntimeGenerationTracker', () => {
  it('rotates the opaque generation when token or TLS policy changes at the same URL', () => {
    const tracker = new WorkspaceRuntimeGenerationTracker()
    const base = {
      url: 'wss://remote.example.test',
      token: 'secret-token-one',
      remoteWorkspaceId: 'remote-workspace',
    }
    const initial = tracker.forRemote('local-workspace', base)

    expect(tracker.forRemote('local-workspace', { ...base })).toBe(initial)
    const tokenChanged = tracker.forRemote('local-workspace', { ...base, token: 'secret-token-two' })
    const tlsChanged = tracker.forRemote('local-workspace', {
      ...base,
      token: 'secret-token-two',
      allowInsecureTls: true,
    })

    expect(tokenChanged).not.toBe(initial)
    expect(tlsChanged).not.toBe(tokenChanged)
    expect(initial).not.toContain(base.token)
    expect(tokenChanged).not.toContain('secret-token-two')
  })

  it('does not place credentials in the stable workspace route key', () => {
    const route = { serverId: 'wss://remote.example.test', workspaceId: 'local-workspace' }
    expect(workspaceRouteKey(route)).toBe('wss%3A%2F%2Fremote.example.test::local-workspace')
    expect(workspaceRouteKey(route)).not.toContain('token')
  })

  it('serializes rapid URL rotations by workspace and reads the latest config at execution', async () => {
    const queue = new WorkspaceRuntimeUpdateQueue()
    let releaseBlocker: (() => void) | undefined
    const blocker = queue.run('workspace-a', () => new Promise<void>(resolve => {
      releaseBlocker = resolve
    }))
    await new Promise(resolve => setTimeout(resolve, 0))

    let latestUrl = 'wss://first.example.test'
    const applied: string[] = []
    const firstRotation = queue.run('workspace-a', async () => { applied.push(latestUrl) })
    latestUrl = 'wss://second.example.test'
    const secondRotation = queue.run('workspace-a', async () => { applied.push(latestUrl) })

    releaseBlocker!()
    await Promise.all([blocker, firstRotation, secondRotation])
    expect(applied).toEqual(['wss://second.example.test', 'wss://second.example.test'])
  })
})
