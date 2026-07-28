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
    const initial = tracker.forRemote('local-workspace', 'remote-a', base)

    expect(tracker.forRemote('local-workspace', 'remote-a', { ...base })).toBe(initial)
    const otherLocation = tracker.forRemote('local-workspace', 'remote-b', { ...base })
    const tokenChanged = tracker.forRemote('local-workspace', 'remote-a', { ...base, token: 'secret-token-two' })
    const tlsChanged = tracker.forRemote('local-workspace', 'remote-a', {
      ...base,
      token: 'secret-token-two',
      allowInsecureTls: true,
    })

    expect(tokenChanged).not.toBe(initial)
    expect(otherLocation).not.toBe(initial)
    expect(tlsChanged).not.toBe(tokenChanged)
    expect(initial).not.toContain(base.token)
    expect(tokenChanged).not.toContain('secret-token-two')
  })

  it('does not place credentials in the stable workspace route key', () => {
    const route = { workspaceId: 'local-workspace', locationId: 'remote-a' }
    expect(workspaceRouteKey(route)).toBe('local-workspace::remote-a')
    expect(workspaceRouteKey(route)).not.toContain('token')
    expect(workspaceRouteKey(route)).not.toContain('remote.example.test')
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
