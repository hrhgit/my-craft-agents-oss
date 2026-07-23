import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const electronSourceRoot = join(import.meta.dir, '..')
const preloadSource = readFileSync(join(electronSourceRoot, 'preload/bootstrap.ts'), 'utf8')

describe('Electron preload platform capability publication', () => {
  it('publishes the snapshot after API construction and before contextBridge exposure', () => {
    const apiConstruction = preloadSource.indexOf('const api = buildClientApi(')
    const capabilityPublication = preloadSource.indexOf('publishElectronPlatformCapabilities(api)')
    const bridgeExposure = preloadSource.indexOf("contextBridge.exposeInMainWorld('electronAPI', api)")

    expect(apiConstruction).toBeGreaterThan(-1)
    expect(capabilityPublication).toBeGreaterThan(apiConstruction)
    expect(bridgeExposure).toBeGreaterThan(capabilityPublication)
    expect(preloadSource.match(/publishElectronPlatformCapabilities\(api\)/g)).toHaveLength(1)
  })
})
