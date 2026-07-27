import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { scopeDigest } from './git.ts'
import type { ModuleRepository } from './repository.ts'
import type { ValidationEntryV1, ValidationRunV1 } from './types.ts'

interface ValidationReceiptV1 {
  schema: 'module-agent/validation-receipt/v1'
  key: string
  created_at: string
  input_tree: string
  command: string
  result: ValidationRunV1
}

const externalToolNames = ['git', 'npm', 'node', 'python', 'python3', 'py', 'bash', 'sh', 'pwsh', 'powershell'] as const

export interface ValidationIdentityContext {
  environment: Array<[string, string]>
  toolchain: Record<string, unknown>
}

function hash(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function environmentIdentity(environment: NodeJS.ProcessEnv): Array<[string, string]> {
  const canonical = new Map<string, string>()
  for (const [name, value] of Object.entries(environment)) canonical.set(name.toUpperCase(), hash(value ?? ''))
  return [...canonical.entries()].sort(([left], [right]) => left.localeCompare(right))
}

function executableFingerprint(candidate: string): Record<string, unknown> {
  const normalized = candidate.trim().replace(/^"|"$/g, '')
  let path: string | null = null
  try {
    path = isAbsolute(normalized) && existsSync(normalized) ? normalized : Bun.which(normalized)
  } catch { /* Missing or invalid tools remain explicit in the identity. */ }
  if (!path) return { candidate, path: null }
  const canonicalPath = realpathSync(path)
  const stats = statSync(canonicalPath)
  const fingerprint = {
    candidate,
    path: canonicalPath.replaceAll('\\', '/').toLocaleLowerCase('en-US'),
    size: stats.size,
    sha256: hash(readFileSync(canonicalPath)),
  }
  return fingerprint
}

function toolchainIdentity(environment: NodeJS.ProcessEnv): Record<string, unknown> {
  const candidates = new Set<string>([process.execPath, ...externalToolNames])
  for (const name of ['PYTHON', 'COMSPEC', 'SHELL']) {
    const configured = environment[name]
    if (configured?.trim()) candidates.add(configured)
  }
  return {
    bun: Bun.version,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    executables: [...candidates].sort().map(executableFingerprint),
  }
}

export function validationIdentityContext(environment: NodeJS.ProcessEnv = process.env): ValidationIdentityContext {
  return {
    environment: environmentIdentity(environment),
    toolchain: toolchainIdentity(environment),
  }
}

export async function validationInputTree(repo: ModuleRepository): Promise<string> {
  return scopeDigest(repo.root, ['validation-input', ...repo.config.include], repo.files, repo.fileModes, repo.fileBlobs, repo.dirtyFiles)
}

export function validationExecutionKey(
  repo: ModuleRepository,
  entry: ValidationEntryV1,
  inputTree: string,
  sourceId?: string,
  buildId?: string,
  identity = validationIdentityContext(),
): string {
  return hash(JSON.stringify({
    command: entry.command,
    cwd: repo.root.replaceAll('\\', '/').toLocaleLowerCase('en-US'),
    environment: identity.environment,
    input_tree: inputTree,
    toolchain: identity.toolchain,
    build_mode: process.env.NODE_ENV ?? 'development',
    source_id: sourceId ?? process.env.MORTISE_SOURCE_ID ?? '',
    build_id: buildId ?? process.env.MORTISE_BUILD_ID ?? '',
  }))
}

function receiptPath(repo: ModuleRepository, key: string): string {
  return join(resolve(repo.root, repo.config.state_dir), 'receipts', `${key}.json`)
}

export async function readValidationReceipt(repo: ModuleRepository, key: string): Promise<ValidationReceiptV1 | undefined> {
  if (repo.config.receipt_ttl_ms === 0) return undefined
  try {
    const receipt = JSON.parse(await readFile(receiptPath(repo, key), 'utf8')) as ValidationReceiptV1
    if (receipt.schema !== 'module-agent/validation-receipt/v1' || receipt.key !== key || receipt.result.status !== 'passed') return undefined
    const createdAt = Date.parse(receipt.created_at)
    if (!Number.isFinite(createdAt) || Date.now() - createdAt > repo.config.receipt_ttl_ms) return undefined
    return receipt
  } catch (error: any) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) return undefined
    throw error
  }
}

export async function writeValidationReceipt(
  repo: ModuleRepository,
  key: string,
  inputTree: string,
  entry: ValidationEntryV1,
  result: ValidationRunV1,
): Promise<ValidationReceiptV1 | undefined> {
  if (repo.config.receipt_ttl_ms === 0 || entry.kind === 'physical' || result.status !== 'passed') return undefined
  const receipt: ValidationReceiptV1 = {
    schema: 'module-agent/validation-receipt/v1',
    key,
    created_at: new Date().toISOString(),
    input_tree: inputTree,
    command: entry.command,
    result: { ...result, stdout: undefined, stderr: undefined, receipt_status: undefined, receipt_key: undefined },
  }
  const path = receiptPath(repo, key)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
  return receipt
}
