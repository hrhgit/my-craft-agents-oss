import { existsSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { withFileLock } from '../build/file-lock.ts'
import { writeJsonAtomic } from '../build/files.ts'
import { MORTISE_UI_PROTOCOL_VERSION, type MortiseUiArtifact, type MortiseUiArtifactManifest } from './protocol.ts'
import { redactValue } from './redaction.ts'

export function readArtifactManifest(path: string, runId: string): MortiseUiArtifactManifest {
  if (!existsSync(path)) {
    return { protocolVersion: MORTISE_UI_PROTOCOL_VERSION, runId, updatedAt: new Date().toISOString(), artifacts: [] }
  }
  return JSON.parse(readFileSync(path, 'utf8')) as MortiseUiArtifactManifest
}

export function recordArtifact(args: {
  manifestPath: string
  runId: string
  artifactsDir: string
  artifact: Omit<MortiseUiArtifact, 'id' | 'createdAt' | 'path'> & { path: string }
  secrets?: readonly string[]
}): MortiseUiArtifact {
  const absolutePath = resolve(args.artifact.path)
  const artifactsRoot = resolve(args.artifactsDir)
  if (absolutePath !== artifactsRoot && !absolutePath.startsWith(`${artifactsRoot}\\`) && !absolutePath.startsWith(`${artifactsRoot}/`)) {
    throw new Error('Artifact path must stay inside the run artifacts directory')
  }
  const artifact = redactValue({
    ...args.artifact,
    id: randomUUID(),
    path: absolutePath,
    createdAt: new Date().toISOString(),
  }, args.secrets) as MortiseUiArtifact
  withFileLock(args.manifestPath, () => {
    const manifest = readArtifactManifest(args.manifestPath, args.runId)
    manifest.updatedAt = new Date().toISOString()
    manifest.artifacts = manifest.artifacts.filter(item => item.path !== artifact.path)
    manifest.artifacts.push(artifact)
    writeJsonAtomic(args.manifestPath, manifest)
  })
  return artifact
}
