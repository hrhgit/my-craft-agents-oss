import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { strToU8, zipSync } from 'fflate'
import { getPiExtensionCatalog, importPiExtension, uninstallPiExtension } from '../pi-global-config'

const tempRoots: string[] = []

async function createTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'mortise-extension-management-'))
  tempRoots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('managed Pi extensions', () => {
  it('imports a strict extension folder and uninstalls its managed package', async () => {
    const root = await createTempRoot()
    const cwd = join(root, 'workspace')
    const agentDir = join(root, 'agent')
    const source = join(root, 'sample-source')
    await Promise.all([mkdir(cwd, { recursive: true }), mkdir(source, { recursive: true })])
    await writeFile(join(source, 'package.json'), JSON.stringify({
      name: 'sample-package',
      pi: { extensions: [{ id: 'sample-extension', path: './index.ts' }] },
    }))
    await writeFile(join(source, 'index.ts'), 'export default function sample() {}\n')

    const imported = await importPiExtension(source, { cwd, agentDir })
    expect(imported.extensionIds).toEqual(['sample-extension'])

    const catalog = await getPiExtensionCatalog({ cwd, agentDir, bundledExtensionPaths: [] })
    const extension = catalog.extensions.find((entry) => entry.id === 'sample-extension')
    expect(extension?.uninstallable).toBe(true)
    expect(JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8')).extensions).toHaveLength(1)

    const uninstalled = await uninstallPiExtension('sample-extension', { cwd, agentDir })
    expect(uninstalled.extensionIds).toEqual(['sample-extension'])
    expect((await getPiExtensionCatalog({ cwd, agentDir, bundledExtensionPaths: [] })).extensions).toEqual([])
  })

  it('rejects ZIP entries that escape the managed package root', async () => {
    const root = await createTempRoot()
    const archive = join(root, 'unsafe.zip')
    await writeFile(archive, zipSync({ '../escape.ts': strToU8('unsafe') }))

    await expect(importPiExtension(archive, {
      cwd: join(root, 'workspace'),
      agentDir: join(root, 'agent'),
    })).rejects.toThrow('unsafe path')
  })

  it('does not recursively import the Mortise Agent directory', async () => {
    const root = await createTempRoot()
    const agentDir = join(root, 'agent')
    await mkdir(agentDir, { recursive: true })

    await expect(importPiExtension(agentDir, {
      cwd: join(root, 'workspace'),
      agentDir,
    })).rejects.toThrow('not the Mortise Agent')
  })
})
