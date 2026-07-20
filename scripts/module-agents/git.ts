import { readFile, readlink } from 'node:fs/promises'
import { relative, resolve } from 'node:path'

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//, '')
}

export async function git(root: string, args: string[], stdin?: Uint8Array | string): Promise<Uint8Array> {
  const process = Bun.spawn(['git', ...args], {
    cwd: root,
    stdin: stdin === undefined ? undefined : 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (stdin !== undefined) {
    process.stdin.write(stdin)
    process.stdin.end()
  }
  const [code, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).arrayBuffer(),
    new Response(process.stderr).text(),
  ])
  if (code !== 0) throw new Error(`git ${args[0]} failed: ${stderr.trim()}`)
  return new Uint8Array(stdout)
}

function splitNull(bytes: Uint8Array): string[] {
  return new TextDecoder().decode(bytes).split('\0').filter(Boolean).map(normalizePath)
}

export async function repositoryFiles(root: string): Promise<string[]> {
  const output = await git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
  return [...new Set(splitNull(output))].sort()
}

interface IndexEntry {
  mode: string
  blob: string
}

async function repositoryIndex(root: string): Promise<Map<string, IndexEntry>> {
  const records = new TextDecoder().decode(await git(root, ['ls-files', '--stage', '-z'])).split('\0').filter(Boolean)
  const entries = new Map<string, IndexEntry>()
  for (const record of records) {
    const match = record.match(/^(\d+)\s+([0-9a-f]+)\s+\d+\t([\s\S]+)$/)
    if (match) entries.set(normalizePath(match[3]), { mode: match[1], blob: match[2] })
  }
  return entries
}

export async function repositoryFileModes(root: string): Promise<Map<string, string>> {
  return new Map([...await repositoryIndex(root)].map(([path, entry]) => [path, entry.mode]))
}

export async function repositoryFileBlobs(root: string): Promise<Map<string, string>> {
  return new Map([...await repositoryIndex(root)].map(([path, entry]) => [path, entry.blob]))
}

export async function repositoryDirtyFiles(root: string): Promise<Set<string>> {
  const [tracked, untracked] = await Promise.all([
    git(root, ['diff-files', '--name-only', '-z']),
    git(root, ['ls-files', '--others', '--exclude-standard', '-z']),
  ])
  return new Set([...splitNull(tracked), ...splitNull(untracked)])
}

export async function changedFiles(root: string, base: string): Promise<string[]> {
  const output = await git(root, ['diff', '--name-only', '--no-renames', '-z', base, '--'])
  const tracked = splitNull(output)
  const untracked = splitNull(await git(root, ['ls-files', '--others', '--exclude-standard', '-z']))
  return [...new Set([...tracked, ...untracked])].sort()
}

async function blobId(root: string, file: string, mode: string): Promise<string> {
  try {
    const raw = mode === '120000'
      ? new TextEncoder().encode(await readlink(resolve(root, file)))
      : new Uint8Array(await readFile(resolve(root, file)))
    return new TextDecoder().decode(await git(root, ['hash-object', `--path=${file}`, '--stdin'], raw)).trim()
  } catch (error: any) {
    if (error?.code === 'ENOENT') return 'deleted'
    throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export async function scopeDigest(
  root: string,
  patterns: string[],
  files: string[],
  knownModes?: Map<string, string>,
  knownBlobs?: Map<string, string>,
  dirtyFiles?: Set<string>,
): Promise<string> {
  const modes = knownModes ?? await repositoryFileModes(root)
  const lines = [`module-agent-scope-v1`, ...[...patterns].sort().map(pattern => `pattern\0${normalizePath(pattern)}`)]
  const sorted = [...files].sort()
  // A small batch keeps Windows process creation reliable on repositories with
  // thousands of files while still avoiding fully sequential hashing.
  for (let index = 0; index < sorted.length; index += 8) {
    const batch = sorted.slice(index, index + 8)
    const ids = await Promise.all(batch.map(file => {
      const normalized = normalizePath(file)
      const indexed = knownBlobs?.get(normalized)
      return indexed && !dirtyFiles?.has(normalized)
        ? indexed
        : blobId(root, file, modes.get(normalized) ?? '100644')
    }))
    for (let offset = 0; offset < batch.length; offset += 1) {
      const file = normalizePath(batch[offset])
      lines.push(`file\0${file}\0${modes.get(file) ?? '100644'}\0${ids[offset]}`)
    }
  }
  return new TextDecoder().decode(await git(root, ['hash-object', '--stdin'], `${lines.join('\n')}\n`)).trim()
}

export function repoRelative(root: string, path: string): string {
  return normalizePath(relative(root, resolve(root, path)))
}
