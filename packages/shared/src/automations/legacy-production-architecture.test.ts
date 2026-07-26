import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { build } from 'esbuild'
import ts from 'typescript'
import { createProductionNodeBundleTargets } from '../../../../scripts/build/validate-production-node-bundles.ts'

const repositoryRoot = resolve(import.meta.dir, '../../../..')
const productionRoots = [
  'packages/shared/src',
  'packages/server-core/src',
  'packages/server/src',
  'packages/messaging-gateway/src',
  'apps/electron/src/main',
  'apps/electron/src/preload',
  'apps/electron/src/renderer',
] as const
const retiredTokens = new Set([
  'executePromptAutomation',
  'ExecutePromptAutomationInput',
  'AutomationSystem',
  'AUTOMATIONS_CONFIG_FILE',
  'automations.json',
  'SchedulerTick',
])
const architectureTokens = [...retiredTokens, 'AutomationV3Store', 'AutomationV3Runtime']

function isProductionSource(path: string): boolean {
  const normalized = path.replaceAll('\\', '/')
  return /\.(?:ts|tsx)$/.test(normalized)
    && !normalized.includes('/__tests__/')
    && !/\.(?:test|spec|isolated)\.(?:ts|tsx)$/.test(normalized)
    && !normalized.endsWith('/legacy-production-architecture.test.ts')
}

function enumerate(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name)
    return entry.isDirectory() ? enumerate(path) : isProductionSource(path) ? [path] : []
  })
}

function sourceViolations(path: string, source: string): string[] {
  if (!architectureTokens.some(token => source.includes(token))) return []

  const violations: string[] = []
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && retiredTokens.has(node.text)) {
      violations.push(`${path}: retired identifier ${node.text}`)
    }
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      && retiredTokens.has(node.text)) {
      violations.push(`${path}: retired literal ${node.text}`)
    }
    if (ts.isNewExpression(node)) {
      const constructor = node.expression.getText(ast)
      if ((constructor === 'AutomationV3Store' || constructor === 'AutomationV3Runtime')
        && !path.replaceAll('\\', '/').endsWith('/automations/v3-host-runtime.ts')) {
        violations.push(`${path}: dispatcher-owned ${constructor}`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return violations
}

describe('Automations V3 production architecture', () => {
  it('contains no retired scheduler, store, filename, or dispatcher fallback in production source', () => {
    const violations = productionRoots.flatMap(root => enumerate(resolve(repositoryRoot, root)))
      .flatMap(path => sourceViolations(relative(repositoryRoot, path), readFileSync(path, 'utf8')))
    expect(violations).toEqual([])
  }, 60_000)

  it('detects a mutation in every retired architecture category', () => {
    const mutations = [
      'executePromptAutomation(input)',
      'const value: ExecutePromptAutomationInput = input',
      'new AutomationSystem()',
      'console.log(AUTOMATIONS_CONFIG_FILE)',
      'readFile("automations.json")',
      'emit("SchedulerTick")',
      'new AutomationV3Store(options)',
      'new AutomationV3Runtime(options)',
    ]
    for (const mutation of mutations) {
      expect(sourceViolations('packages/probe/src/mutation.ts', mutation)).not.toEqual([])
    }
  })

  it('contains no retired automation surface in production bundles or their source closure', async () => {
    for (const target of createProductionNodeBundleTargets(repositoryRoot)) {
      const result = await build({ ...target.options, metafile: true, write: false })
      const output = result.outputFiles?.map(file => file.text).join('\n') ?? ''
      const bundleHits = [...retiredTokens].filter(token => output.includes(token))
      expect(bundleHits, `${target.label} bundle`).toEqual([])
      const sourceHits = Object.keys(result.metafile?.inputs ?? {}).filter(path =>
        /(?:legacy-automations|automations\/types)\.(?:ts|tsx|js)$/.test(path.replaceAll('\\', '/')))
      expect(sourceHits, `${target.label} metafile`).toEqual([])
    }
  }, 120_000)
})
