import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { recordArtifact, readArtifactManifest } from './artifacts.ts'
import { redactText } from './redaction.ts'
import type { MortiseUiRunManifest } from './protocol.ts'

export function registerReturnedArtifacts(manifest: MortiseUiRunManifest, result: unknown): void {
  const artifacts = returnedArtifacts(result)
  if (artifacts.length === 0) return
  for (const artifact of artifacts) {
    if (typeof artifact.path !== 'string') continue
    const sourceKind = String(artifact.kind ?? 'other')
    const kind = sourceKind === 'screenshot' || sourceKind.endsWith('-screenshot') ? 'screenshot'
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
      secrets: [readToken(manifest)],
    })
  }
}

export function collectLocalEvidence(manifest: MortiseUiRunManifest): ReturnType<typeof readArtifactManifest> {
  const token = readToken(manifest)
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

function returnedArtifacts(value: unknown, seen = new Set<unknown>()): Array<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || seen.has(value)) return []
  seen.add(value)
  if (Array.isArray(value)) return value.flatMap(item => returnedArtifacts(item, seen))
  const record = value as Record<string, unknown>
  const direct = Array.isArray(record.artifacts)
    ? record.artifacts.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item))
    : []
  return [...direct, ...Object.entries(record).filter(([key]) => key !== 'artifacts').flatMap(([, item]) => returnedArtifacts(item, seen))]
}

function readToken(manifest: MortiseUiRunManifest): string {
  try { return readFileSync(manifest.tokenPath, 'utf8').trim() } catch { return '' }
}
