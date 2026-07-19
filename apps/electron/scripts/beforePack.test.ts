import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const beforePack = require('./beforePack.cjs') as (context: unknown) => Promise<void>
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function createContext(productName: string, marker: { developerHostBuild: boolean; uiValidationBuild: boolean }) {
  const projectDir = mkdtempSync(join(tmpdir(), 'mortise-before-pack-'))
  roots.push(projectDir)
  mkdirSync(join(projectDir, 'dist'))
  writeFileSync(join(projectDir, 'dist', '.developer-host-build.json'), JSON.stringify({
    schemaVersion: 1,
    ...marker,
  }))
  return {
    electronPlatformName: 'linux',
    packager: {
      projectDir,
      appInfo: { productName },
    },
  }
}

describe('Electron package build identity', () => {
  it('accepts the matching Developer Host build', async () => {
    await expect(beforePack(createContext('Mortise Developer Host', {
      developerHostBuild: true,
      uiValidationBuild: true,
    }))).resolves.toBeUndefined()
  })

  it('accepts an ordinary production build without UI validation', async () => {
    await expect(beforePack(createContext('Mortise', {
      developerHostBuild: false,
      uiValidationBuild: false,
    }))).resolves.toBeUndefined()
  })

  it('rejects a Developer Host build packaged as ordinary Mortise', async () => {
    await expect(beforePack(createContext('Mortise', {
      developerHostBuild: true,
      uiValidationBuild: true,
    }))).rejects.toThrow('build identity does not match')
  })
})
