import { describe, expect, it } from 'bun:test'
import { CLIENT_ROUTE_WORKSPACE_MARKER_DETACH } from '@mortise/server-core/transport'
import { CLIENT_WORKSPACE_EXECUTE_TRANSFER } from '@mortise/shared/protocol'
import { getElectronClientCapabilities } from './client-capabilities'

describe('Electron client capability publication', () => {
  it('publishes transfer orchestration only when the preload registers it', () => {
    expect(getElectronClientCapabilities(false)).toContain(CLIENT_WORKSPACE_EXECUTE_TRANSFER)
    expect(getElectronClientCapabilities(false)).toContain(CLIENT_ROUTE_WORKSPACE_MARKER_DETACH)
    expect(getElectronClientCapabilities(true)).not.toContain(CLIENT_WORKSPACE_EXECUTE_TRANSFER)
    expect(getElectronClientCapabilities(true)).not.toContain(CLIENT_ROUTE_WORKSPACE_MARKER_DETACH)
  })
})
