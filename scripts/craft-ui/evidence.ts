import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { recordArtifact, readArtifactManifest } from './artifacts.ts'
import { redactText } from './redaction.ts'
import type { CraftUiRunManifest } from './protocol.ts'

export function registerReturnedArtifacts(manifest: CraftUiRunManifest, result: unknown): void {
  if (!result || typeof result !== 'object' || !Array.isArray((result as { artifacts?: unknown }).artifacts)) return
  for (const artifact of (result as { artifacts: Array<Record<string, unknown>> }).artifacts) {
    if (typeof artifact.path !== 'string') continue
    const sourceKind = String(artifact.kind ?? 'other')
    const kind = sourceKind === 'screenshot' ? 'screenshot'
      : sourceKind === 'trace' ? 'trace'
      : sourceKind === 'semantic-snapshot' ? 'snapshot'
      : ['log', 'events', 'console', 'page-errors', 'network-summary', 'driver-info', 'runtime-log', 'state-manifest'].includes(sourceKind) ? 'log'
      : 'other'
    recordArtifact({
      manifestPath: join(manifest.artifactsDir, 'manifest.json'),
      runId: manifest.runId,
      artifactsDir: manifest.artifactsDir,
      artifact: {
        kind,
        path: artifact.path,
        mimeType: typeof artifact.mimeType === 'string' ? artifact.mimeType : undefined,
        description: sourceKind,
        metadata: {
          ...(typeof artifact.sha256 === 'string' ? { sha256: artifact.sha256 } : {}),
          ...(typeof artifact.sizeBytes === 'number' ? { sizeBytes: artifact.sizeBytes } : {}),
        },
      },
      secrets: [readFileSync(manifest.tokenPath, 'utf8').trim()],
    })
  }
}

export function collectLocalEvidence(manifest: CraftUiRunManifest): ReturnType<typeof readArtifactManifest> {
  const token = readFileSync(manifest.tokenPath, 'utf8').trim()
  for (const [sourcePath, targetName, description] of [
    [manifest.stdoutPath, 'host.stdout.redacted.log', 'Redacted host standard output'],
    [manifest.stderrPath, 'host.stderr.redacted.log', 'Redacted host standard error'],
  ] as const) {
    if (!existsSync(sourcePath)) continue
    const targetPath = join(manifest.artifactsDir, targetName)
    writeFileSync(targetPath, redactText(readFileSync(sourcePath, 'utf8'), [token]), 'utf8')
    const current = readArtifactManifest(join(manifest.artifactsDir, 'manifest.json'), manifest.runId)
    if (!current.artifacts.some(item => item.path === targetPath)) {
      recordArtifact({
        manifestPath: join(manifest.artifactsDir, 'manifest.json'),
        runId: manifest.runId,
        artifactsDir: manifest.artifactsDir,
        artifact: { kind: 'log', path: targetPath, mimeType: 'text/plain', description },
        secrets: [token],
      })
    }
  }
  return readArtifactManifest(join(manifest.artifactsDir, 'manifest.json'), manifest.runId)
}
