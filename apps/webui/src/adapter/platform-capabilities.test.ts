import { describe, expect, it } from 'bun:test'
import {
  isCapabilityUnavailableErrorDataV1,
  isPlatformCapabilitySnapshotV1,
  type PlatformCapabilityDescriptorV1,
} from '@mortise/shared/protocol'
import {
  WEBUI_PLATFORM_CAPABILITIES,
  WEBUI_UNSUPPORTED_OPERATION_CAPABILITIES,
  WebCapabilityUnavailableError,
  attachWebPlatformCapabilities,
  createUnsupportedWebApiOverrides,
  unsupportedWebCapability,
  type WebPlatformCapabilityName,
} from './platform-capabilities'

describe('WebUI platform capability contract', () => {
  it('publishes a stable versioned web capability snapshot', () => {
    expect(WEBUI_PLATFORM_CAPABILITIES.schemaVersion).toBe(1)
    expect(WEBUI_PLATFORM_CAPABILITIES.platform).toBe('web')
    expect(WEBUI_PLATFORM_CAPABILITIES.capabilities.externalUrls.status).toBe('supported')
    expect(WEBUI_PLATFORM_CAPABILITIES.capabilities.fileSystemShell.status).toBe('unavailable')
    expect(Object.isFrozen(WEBUI_PLATFORM_CAPABILITIES)).toBe(true)
    expect(Object.isFrozen(WEBUI_PLATFORM_CAPABILITIES.capabilities)).toBe(true)
    expect(isPlatformCapabilitySnapshotV1(WEBUI_PLATFORM_CAPABILITIES)).toBe(true)
  })

  it('uses a typed stable error for every unavailable capability', async () => {
    const unavailable = (Object.entries(WEBUI_PLATFORM_CAPABILITIES.capabilities) as Array<[
      WebPlatformCapabilityName,
      PlatformCapabilityDescriptorV1,
    ]>)
      .filter(([, value]) => value.status === 'unavailable')
      .map(([name]) => name)

    expect(unavailable.length).toBeGreaterThan(0)
    for (const capability of unavailable) {
      try {
        await unsupportedWebCapability(capability)
        throw new Error('Expected capability rejection')
      } catch (error) {
        expect(error).toBeInstanceOf(WebCapabilityUnavailableError)
        expect((error as WebCapabilityUnavailableError).code).toBe('CAPABILITY_UNAVAILABLE')
        expect((error as WebCapabilityUnavailableError).capability).toBe(capability)
        expect((error as WebCapabilityUnavailableError).platform).toBe('web')
        expect(isCapabilityUnavailableErrorDataV1((error as WebCapabilityUnavailableError).data)).toBe(true)
      }
    }
  })

  it('maps every unsupported adapter operation to an unavailable capability', () => {
    expect(Object.keys(WEBUI_UNSUPPORTED_OPERATION_CAPABILITIES).length).toBeGreaterThan(0)
    for (const capability of Object.values(WEBUI_UNSUPPORTED_OPERATION_CAPABILITIES)) {
      expect(WEBUI_PLATFORM_CAPABILITIES.capabilities[capability].status).toBe('unavailable')
    }
  })

  it('generates a rejecting adapter override for every mapped operation', async () => {
    const overrides = createUnsupportedWebApiOverrides() as Record<string, () => Promise<never>>

    expect(Object.keys(overrides).sort()).toEqual(
      Object.keys(WEBUI_UNSUPPORTED_OPERATION_CAPABILITIES).sort(),
    )
    for (const [operation, capability] of Object.entries(WEBUI_UNSUPPORTED_OPERATION_CAPABILITIES)) {
      expect(overrides[operation]).toBeFunction()
      await expect(overrides[operation]()).rejects.toMatchObject({
        code: 'CAPABILITY_UNAVAILABLE',
        platform: 'web',
        capability,
      })
    }
  })

  it('attaches the capability snapshot as an immutable API property', () => {
    const api = attachWebPlatformCapabilities({})

    expect(api.platformCapabilities).toBe(WEBUI_PLATFORM_CAPABILITIES)
    expect(Object.getOwnPropertyDescriptor(api, 'platformCapabilities')).toMatchObject({
      enumerable: true,
      configurable: false,
      writable: false,
    })
    expect(() => {
      ;(api as { platformCapabilities: unknown }).platformCapabilities = null
    }).toThrow()
  })
})
