import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  UI_COVERAGE_SCHEMA,
  buildPlaygroundUiInventory,
  checkPlaygroundUiCoverage,
  type PlaygroundUiCoverageManifest,
} from './playground-ui-inventory'
import { execute } from './playground-ui-inventory-cli'
import { bootstrapPlaygroundUiCoverage, generatePlaygroundUiCatalog } from './generate-playground-ui-catalog'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'playground-ui-inventory-'))
  roots.push(root)
  for (const directory of [
    'apps/electron/src/renderer/components',
    'apps/electron/src/renderer/pages',
    'packages/ui/src/components',
  ]) mkdirSync(join(root, directory), { recursive: true })
  return root
}

function source(root: string, path: string, content: string): void {
  const target = join(root, path)
  mkdirSync(join(target, '..'), { recursive: true })
  writeFileSync(target, content)
}

describe('Playground UI inventory', () => {
  test('discovers exported React UI components and pages while ignoring helpers, contexts, and tests', async () => {
    const root = fixture()
    source(root, 'apps/electron/src/renderer/components/Panel.tsx', [
      'export function Panel() { return <section /> }',
      'export function formatLabel() { return "label" }',
      'const Wrapped = React.memo(() => <div />)',
      'export { Wrapped }',
    ].join('\n'))
    source(root, 'apps/electron/src/renderer/pages/SettingsPage.tsx', 'export default function SettingsPage() { return <main /> }')
    source(root, 'packages/ui/src/components/Button.tsx', 'export const Button = () => <button />')
    source(root, 'apps/electron/src/renderer/components/context/AppContext.tsx', 'export function AppContext() { return <div /> }')
    source(root, 'apps/electron/src/renderer/components/__tests__/Panel.test.tsx', 'export function TestPanel() { return <div /> }')

    const inventory = await buildPlaygroundUiInventory(root)
    expect(inventory.candidates).toEqual([
      { sourcePath: 'apps/electron/src/renderer/components/Panel.tsx', exportName: 'Panel', kind: 'component' },
      { sourcePath: 'apps/electron/src/renderer/components/Panel.tsx', exportName: 'Wrapped', kind: 'component' },
      { sourcePath: 'apps/electron/src/renderer/pages/SettingsPage.tsx', exportName: 'default', kind: 'page' },
      { sourcePath: 'packages/ui/src/components/Button.tsx', exportName: 'Button', kind: 'component' },
    ])
  })

  test('requires every candidate to have one preview entry or a reasoned exemption', async () => {
    const root = fixture()
    source(root, 'packages/ui/src/components/Button.tsx', 'export function Button() { return <button /> }')
    source(root, 'packages/ui/src/components/Icon.tsx', 'export function Icon() { return <svg /> }')
    const inventory = await buildPlaygroundUiInventory(root)
    const manifest: PlaygroundUiCoverageManifest = {
      schema: UI_COVERAGE_SCHEMA,
      entries: [{ sourcePath: 'packages/ui/src/components/Button.tsx', exportName: 'Button', entryId: 'button' }],
    }

    const missing = checkPlaygroundUiCoverage(inventory, manifest)
    expect(missing.valid).toBe(false)
    expect(missing.diagnostics).toContainEqual(expect.objectContaining({ code: 'UNCOVERED_CANDIDATE', exportName: 'Icon' }))

    manifest.entries.push({ sourcePath: 'packages/ui/src/components/Icon.tsx', exportName: 'Icon', exemption: { reason: 'Rendered by the Button scene.' } })
    expect(checkPlaygroundUiCoverage(inventory, manifest)).toEqual(expect.objectContaining({ valid: true, covered: 1, exempted: 1 }))
  })

  test('rejects duplicate, unknown, and ambiguous coverage mappings', async () => {
    const root = fixture()
    source(root, 'packages/ui/src/components/Button.tsx', 'export function Button() { return <button /> }')
    const inventory = await buildPlaygroundUiInventory(root)
    const result = checkPlaygroundUiCoverage(inventory, {
      schema: UI_COVERAGE_SCHEMA,
      entries: [
        { sourcePath: 'packages/ui/src/components/Button.tsx', exportName: 'Button', entryId: 'button' },
        { sourcePath: 'packages/ui/src/components/Button.tsx', exportName: 'Button', exemption: { reason: 'duplicate' } },
        { sourcePath: 'packages/ui/src/components/Missing.tsx', exportName: 'Missing', entryId: 'missing' },
        { sourcePath: 'packages/ui/src/components/Button.tsx', exportName: 'Button', entryId: 'button-again', exemption: { reason: 'ambiguous' } },
      ],
    })
    expect(result.diagnostics.map(diagnostic => diagnostic.code).sort()).toEqual(['DUPLICATE_COVERAGE', 'INVALID_ENTRY', 'UNKNOWN_CANDIDATE'])
  })

  test('reports malformed manifests as a check result', async () => {
    const result = checkPlaygroundUiCoverage({ schema: 'playground-ui-inventory/v1', candidates: [] }, {} as PlaygroundUiCoverageManifest)
    expect(result).toEqual(expect.objectContaining({ valid: false }))
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'INVALID_MANIFEST' }))
  })

  test('exposes machine-readable inventory and check commands', async () => {
    const root = fixture()
    source(root, 'packages/ui/src/components/Button.tsx', 'export function Button() { return <button /> }')
    const inventory = await execute(['inventory', '--root', root])
    expect(inventory.code).toBe(0)
    expect(JSON.parse(inventory.output).candidates).toHaveLength(1)

    writeFileSync(join(root, 'coverage.json'), JSON.stringify({
      schema: UI_COVERAGE_SCHEMA,
      entries: [{ sourcePath: 'packages/ui/src/components/Button.tsx', exportName: 'Button', entryId: 'button' }],
    }))
    const checked = await execute(['check', '--root', root, '--manifest', 'coverage.json'])
    expect(checked.code).toBe(0)
    expect(JSON.parse(checked.output)).toEqual(expect.objectContaining({ valid: true, candidates: 1 }))
  })

  test('does not silently cover new source UI while regenerating the catalog', async () => {
    const root = fixture()
    source(root, 'packages/ui/src/components/Button.tsx', 'export function Button() { return <button /> }')

    await generatePlaygroundUiCatalog(root)
    expect(existsSync(join(root, 'apps/electron/src/renderer/playground/ui-coverage.json'))).toBe(false)

    await bootstrapPlaygroundUiCoverage(root)
    source(root, 'packages/ui/src/components/Icon.tsx', 'export function Icon() { return <svg /> }')
    const checked = await execute(['check', '--root', root, '--manifest', 'apps/electron/src/renderer/playground/ui-coverage.json'])
    expect(checked.code).not.toBe(0)
    expect(JSON.parse(checked.output).diagnostics).toContainEqual(expect.objectContaining({ code: 'UNCOVERED_CANDIDATE', exportName: 'Icon' }))
  })
})
