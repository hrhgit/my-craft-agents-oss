import { resolve } from 'node:path'
import { writeElectronBuildProvenance, type ElectronBuildMode } from './electron-build-cache.ts'

const sourceId = process.env.MORTISE_BUILD_SOURCE_ID ?? ''
const mode: ElectronBuildMode = process.env.MORTISE_UI_VALIDATION_BUILD === '1'
  ? 'ui-validation'
  : process.env.MORTISE_DEV_RUNTIME === '1'
    ? 'development'
    : 'production'
const appDir = resolve(import.meta.dir, '..', '..', 'apps', 'electron')
const provenancePath = writeElectronBuildProvenance({ appDir, sourceId, mode })
process.stdout.write(`Electron build provenance: ${provenancePath}\n`)
