import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildProjectModuleCatalog, lintProjectModules, renderProjectModuleCatalog } from '../catalog'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'project-modules-'))
  roots.push(root)
  mkdirSync(join(root, '.agents', 'modules'), { recursive: true })
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'alpha.ts'), 'export const alpha = true\n')
  return root
}

function writeModule(root: string, name: string, frontmatter: string): void {
  writeFileSync(join(root, '.agents', 'modules', `${name}.md`), `---\n${frontmatter}---\n\n# Boundary\n\nFixture.\n`)
}

describe('project module catalog', () => {
  test('renders a compact progressive-disclosure catalog and derives consumers', async () => {
    const root = fixture()
    writeModule(root, 'alpha', [
      'schema: project-module/v1',
      'id: alpha',
      'name: Alpha',
      'summary: Alpha capability.',
      'when_to_read: [alpha work]',
      'tags: [alpha]',
      'entrypoints: [src/alpha.ts]',
      'depends_on: []',
      'related: []',
      'validation: []',
    ].join('\n') + '\n')
    writeModule(root, 'beta', [
      'schema: project-module/v1',
      'id: beta',
      'name: Beta',
      'summary: Beta capability.',
      'when_to_read: [beta work]',
      'tags: [beta]',
      'entrypoints: [src/alpha.ts]',
      'depends_on: [alpha]',
      'related: []',
      'validation: []',
    ].join('\n') + '\n')

    const catalog = await buildProjectModuleCatalog(root)
    expect(catalog.consumers.alpha).toEqual(['beta'])
    expect(renderProjectModuleCatalog(catalog)).toContain('Select the smallest relevant set')
    expect(renderProjectModuleCatalog(catalog)).toContain('Used by: `beta`')
  })

  test('reports broken references and missing entrypoints without checking repository ownership coverage', async () => {
    const root = fixture()
    writeFileSync(join(root, 'unmapped.ts'), 'unmapped\n')
    writeModule(root, 'alpha', [
      'schema: project-module/v1',
      'id: alpha',
      'name: Alpha',
      'summary: Alpha capability.',
      'when_to_read: [alpha work]',
      'tags: []',
      'entrypoints: [src/missing.ts]',
      'depends_on: [missing]',
      'related: []',
      'validation: []',
    ].join('\n') + '\n')

    const result = await lintProjectModules(root)
    expect(result.valid).toBe(false)
    expect(result.diagnostics.map(item => item.code).sort()).toEqual(['INVALID_REFERENCE', 'MISSING_ENTRYPOINT'])
    expect(result.diagnostics.some(item => item.message.includes('unmapped.ts'))).toBe(false)
  })

  test('rejects dependency files as module entrypoints', async () => {
    const root = fixture()
    mkdirSync(join(root, 'node_modules', 'dependency'), { recursive: true })
    writeFileSync(join(root, 'node_modules', 'dependency', 'index.ts'), 'dependency\n')
    writeModule(root, 'alpha', [
      'schema: project-module/v1',
      'id: alpha',
      'name: Alpha',
      'summary: Alpha capability.',
      'when_to_read: [alpha work]',
      'tags: []',
      'entrypoints: [node_modules/dependency/index.ts]',
      'depends_on: []',
      'related: []',
      'validation: []',
    ].join('\n') + '\n')

    const result = await lintProjectModules(root)
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'INVALID_ENTRYPOINT' }))
  })
})
