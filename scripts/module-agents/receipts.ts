import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
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

const environmentKeys = [
  'NODE_ENV',
  'MORTISE_BUILD_MODE',
  'MORTISE_UI_VALIDATION_BUILD',
  'MORTISE_DEV_HOST_BUILD',
  'MORTISE_SOURCE_ID',
  'MORTISE_BUILD_ID',
] as const

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
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
): string {
  const environment = Object.fromEntries(environmentKeys.map(key => [key, process.env[key] ?? '']))
  return hash(JSON.stringify({
    command: entry.command,
    cwd: repo.root.replaceAll('\\', '/').toLocaleLowerCase('en-US'),
    environment,
    input_tree: inputTree,
    toolchain: { bun: Bun.version, node: process.versions.node, executable: process.execPath, platform: process.platform, arch: process.arch },
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
