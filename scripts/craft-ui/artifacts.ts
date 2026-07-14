import { existsSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { CRAFT_UI_PROTOCOL_VERSION, type CraftUiArtifact, type CraftUiArtifactManifest } from './protocol.ts'
import { writeJsonAtomic } from './files.ts'
import { redactValue } from './redaction.ts'

export function readArtifactManifest(path: string, runId: string): CraftUiArtifactManifest {
  if (!existsSync(path)) {
    return { protocolVersion: CRAFT_UI_PROTOCOL_VERSION, runId, updatedAt: new Date().toISOString(), artifacts: [] }
  }
  return JSON.parse(readFileSync(path, 'utf8')) as CraftUiArtifactManifest
}

export function recordArtifact(args: {
  manifestPath: string
  runId: string
  artifactsDir: string
  artifact: Omit<CraftUiArtifact, 'id' | 'createdAt' | 'path'> & { path: string }
  secrets?: readonly string[]
}): CraftUiArtifact {
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
  }, args.secrets) as CraftUiArtifact
  const manifest = readArtifactManifest(args.manifestPath, args.runId)
  manifest.updatedAt = new Date().toISOString()
  manifest.artifacts = manifest.artifacts.filter(item => item.path !== artifact.path)
  manifest.artifacts.push(artifact)
  writeJsonAtomic(args.manifestPath, manifest)
  return artifact
}
