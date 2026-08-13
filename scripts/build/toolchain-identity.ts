import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

let cachedCurrentExecutableSha256: string | undefined

export function buildToolchainExecutableSha256(executable = process.execPath): string {
  if (executable !== process.execPath) {
    return createHash('sha256').update(readFileSync(executable)).digest('hex')
  }
  cachedCurrentExecutableSha256 ??= createHash('sha256').update(readFileSync(executable)).digest('hex')
  return cachedCurrentExecutableSha256
}
