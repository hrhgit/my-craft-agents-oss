import { describe, test, expect } from 'bun:test'
import { getAllChannelValues, RPC_CHANNELS } from '../channels'
import {
  CAPABILITY_UNAVAILABLE_ERROR_CODE,
  createCapabilityUnavailableErrorDataV1,
  createPlatformCapabilitySnapshotV1,
  isCapabilityUnavailableErrorDataV1,
  isPlatformCapabilitySnapshotV1,
} from '../capabilities'
import { LOCAL_ONLY_CHANNELS, REMOTE_ELIGIBLE_CHANNELS } from '../routing'

describe('channel routing exhaustiveness', () => {
  const all = getAllChannelValues()

  test('every channel is classified exactly once', () => {
    for (const ch of all) {
      const inLocal = LOCAL_ONLY_CHANNELS.has(ch)
      const inRemote = REMOTE_ELIGIBLE_CHANNELS.has(ch)

      if (!inLocal && !inRemote) {
        throw new Error(`Channel "${ch}" is not classified in LOCAL_ONLY or REMOTE_ELIGIBLE. Add it to one set in routing.ts.`)
      }
      if (inLocal && inRemote) {
        throw new Error(`Channel "${ch}" is in BOTH LOCAL_ONLY and REMOTE_ELIGIBLE. It must be in exactly one.`)
      }
    }
  })

  test('no extra channels in LOCAL_ONLY', () => {
    for (const ch of LOCAL_ONLY_CHANNELS) {
      expect(all).toContain(ch)
    }
  })

  test('no extra channels in REMOTE_ELIGIBLE', () => {
    for (const ch of REMOTE_ELIGIBLE_CHANNELS) {
      expect(all).toContain(ch)
    }
  })

  test('sets are non-empty', () => {
    expect(LOCAL_ONLY_CHANNELS.size).toBeGreaterThan(0)
    expect(REMOTE_ELIGIBLE_CHANNELS.size).toBeGreaterThan(0)
  })

  test('total classified equals total channels', () => {
    expect(LOCAL_ONLY_CHANNELS.size + REMOTE_ELIGIBLE_CHANNELS.size).toBe(all.length)
  })
})

describe('channel routing behavior', () => {
  test('LOCAL_ONLY and REMOTE_ELIGIBLE have zero intersection', () => {
    const intersection: string[] = []
    for (const ch of LOCAL_ONLY_CHANNELS) {
      if (REMOTE_ELIGIBLE_CHANNELS.has(ch)) {
        intersection.push(ch)
      }
    }
    expect(intersection).toEqual([])
  })

  test('all server:* channels are REMOTE_ELIGIBLE', () => {
    const serverChannels = Object.values(RPC_CHANNELS.server)
    expect(serverChannels.length).toBeGreaterThan(0)

    for (const ch of serverChannels) {
      expect(REMOTE_ELIGIBLE_CHANNELS.has(ch)).toBe(true)
    }
  })

  test('no LOCAL_ONLY channel starts with server:', () => {
    for (const ch of LOCAL_ONLY_CHANNELS) {
      if (ch.startsWith('server:')) {
        throw new Error(`server:* channel "${ch}" must be REMOTE_ELIGIBLE, not LOCAL_ONLY`)
      }
    }
  })

  test('Workspace topology authority and broadcasts stay local', () => {
    expect(LOCAL_ONLY_CHANNELS.has(RPC_CHANNELS.workspaces.GET_TOPOLOGY)).toBe(true)
    expect(LOCAL_ONLY_CHANNELS.has(RPC_CHANNELS.workspaces.TOPOLOGY_COMMAND)).toBe(true)
    expect(LOCAL_ONLY_CHANNELS.has(RPC_CHANNELS.workspaces.TOPOLOGY_CHANGED)).toBe(true)
  })
})

describe('platform capability protocol', () => {
  test('creates an immutable versioned snapshot with JSON-safe descriptors', () => {
    const snapshot = createPlatformCapabilitySnapshotV1('web', {
      externalUrls: { status: 'supported' },
      nativeWindows: { status: 'unavailable', reason: 'Browser-owned lifecycle.' },
    })

    expect(snapshot.schemaVersion).toBe(1)
    expect(snapshot.platform).toBe('web')
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.capabilities)).toBe(true)
    expect(Object.isFrozen(snapshot.capabilities.nativeWindows)).toBe(true)
    expect(isPlatformCapabilitySnapshotV1(JSON.parse(JSON.stringify(snapshot)))).toBe(true)
  })

  test('rejects unknown capability states and malformed snapshots', () => {
    expect(isPlatformCapabilitySnapshotV1({
      schemaVersion: 1,
      platform: 'web',
      capabilities: { nativeWindows: { status: 'pretend-supported' } },
    })).toBe(false)
    expect(isPlatformCapabilitySnapshotV1({ schemaVersion: 2, platform: 'web', capabilities: {} })).toBe(false)
    expect(isPlatformCapabilitySnapshotV1({ schemaVersion: 1, platform: 'cli', capabilities: {} })).toBe(false)
  })

  test('creates stable serializable CAPABILITY_UNAVAILABLE error data', () => {
    const error = createCapabilityUnavailableErrorDataV1(
      'web',
      'nativeWindows',
      'Browser-owned lifecycle.',
    )
    const roundTrip = JSON.parse(JSON.stringify(error))

    expect(roundTrip).toEqual({
      schemaVersion: 1,
      code: CAPABILITY_UNAVAILABLE_ERROR_CODE,
      platform: 'web',
      capability: 'nativeWindows',
      message: 'Capability "nativeWindows" is unavailable on web: Browser-owned lifecycle.',
      retryable: false,
    })
    expect(isCapabilityUnavailableErrorDataV1(roundTrip)).toBe(true)
    expect(isCapabilityUnavailableErrorDataV1({ ...roundTrip, retryable: true })).toBe(false)
  })
})
