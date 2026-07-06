import { chmodSync, renameSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'

export function writeOwnerOnlyFileSync(filePath: string, contents: string): void {
  const tempPath = join(dirname(filePath), `.${randomUUID()}.tmp`)
  writeFileSync(tempPath, contents, { mode: 0o600 })
  if (process.platform !== 'win32') {
    chmodSync(tempPath, 0o600)
  }
  renameSync(tempPath, filePath)
  if (process.platform !== 'win32') {
    chmodSync(filePath, 0o600)
  }
}
