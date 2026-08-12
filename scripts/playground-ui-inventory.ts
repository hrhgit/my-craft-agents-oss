import { readdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, extname, join, relative, resolve } from 'node:path'
import ts from 'typescript'

export const UI_INVENTORY_SCHEMA = 'playground-ui-inventory/v1' as const
export const UI_COVERAGE_SCHEMA = 'playground-ui-coverage/v1' as const
export const UI_COVERAGE_CHECK_SCHEMA = 'playground-ui-coverage-check/v1' as const

export type UiCandidateKind = 'component' | 'page'

export interface UiCandidate {
  sourcePath: string
  exportName: string
  kind: UiCandidateKind
}

export interface PlaygroundUiInventory {
  schema: typeof UI_INVENTORY_SCHEMA
  candidates: UiCandidate[]
}

export interface PlaygroundUiCoverageEntry {
  sourcePath: string
  exportName: string
  entryId?: string
  exemption?: {
    reason: string
  }
}

export interface PlaygroundUiCoverageManifest {
  schema: typeof UI_COVERAGE_SCHEMA
  entries: PlaygroundUiCoverageEntry[]
}

export type PlaygroundUiCoverageDiagnosticCode =
  | 'INVALID_MANIFEST'
  | 'UNKNOWN_CANDIDATE'
  | 'DUPLICATE_COVERAGE'
  | 'UNCOVERED_CANDIDATE'
  | 'INVALID_ENTRY'

export interface PlaygroundUiCoverageDiagnostic {
  code: PlaygroundUiCoverageDiagnosticCode
  message: string
  sourcePath?: string
  exportName?: string
}

export interface PlaygroundUiCoverageCheck {
  schema: typeof UI_COVERAGE_CHECK_SCHEMA
  valid: boolean
  candidates: number
  covered: number
  exempted: number
  diagnostics: PlaygroundUiCoverageDiagnostic[]
}

const scanRoots = [
  { path: 'apps/electron/src/renderer/components', kind: 'component' as const },
  { path: 'apps/electron/src/renderer/pages', kind: 'page' as const },
  { path: 'packages/ui/src/components', kind: 'component' as const },
]

const sourceExtensions = new Set(['.tsx', '.jsx'])

function repositoryPath(root: string, absolutePath: string): string {
  return relative(root, absolutePath).replaceAll('\\', '/')
}

function isIgnoredPath(path: string): boolean {
  const normalized = path.replaceAll('\\', '/')
  const fileName = normalized.split('/').at(-1) ?? ''
  return normalized.includes('/__tests__/')
    || normalized.includes('/__mocks__/')
    || /\.(?:test|spec|stories)\.[^.]+$/i.test(fileName)
    || /(?:^|\/)(?:context|contexts|hooks|utils|helpers)(?:\/|$)/i.test(normalized)
}

async function collectSourceFiles(directory: string): Promise<string[]> {
  if (!existsSync(directory)) return []
  const entries = await readdir(directory, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const target = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === '__mocks__') continue
      files.push(...await collectSourceFiles(target))
    } else if (entry.isFile() && sourceExtensions.has(extname(entry.name))) {
      files.push(target)
    }
  }
  return files
}

function isComponentName(name: string): boolean {
  return /^[A-Z]/.test(name)
}

function containsUiExpression(node: ts.Node): boolean {
  let found = false
  const visit = (child: ts.Node): void => {
    if (found) return
    if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child) || ts.isJsxFragment(child)) {
      found = true
      return
    }
    if (ts.isCallExpression(child)
      && ((ts.isIdentifier(child.expression) && child.expression.text === 'createElement')
        || (ts.isPropertyAccessExpression(child.expression)
          && child.expression.name.text === 'createElement'))) {
      found = true
      return
    }
    ts.forEachChild(child, visit)
  }
  visit(node)
  return found
}

function unwrapComponentExpression(expression: ts.Expression): ts.Expression {
  let current = expression
  while (ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isSatisfiesExpression(current)) {
    current = current.expression
  }
  return current
}

function expressionRendersUi(expression: ts.Expression): boolean {
  const unwrapped = unwrapComponentExpression(expression)
  if (ts.isArrowFunction(unwrapped) || ts.isFunctionExpression(unwrapped)) return containsUiExpression(unwrapped.body)
  if (ts.isCallExpression(unwrapped)) {
    const argumentsToCheck = unwrapped.arguments.filter(ts.isExpression)
    return argumentsToCheck.some(argument => expressionRendersUi(argument))
  }
  return false
}

function declarationRendersUi(declaration: ts.Declaration): boolean {
  if (ts.isFunctionDeclaration(declaration)) return Boolean(declaration.body && containsUiExpression(declaration.body))
  if (ts.isVariableDeclaration(declaration)) return Boolean(declaration.initializer && expressionRendersUi(declaration.initializer))
  return false
}

function exportedNames(sourceFile: ts.SourceFile): Map<string, boolean> {
  const names = new Map<string, boolean>()
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && hasExportModifier(statement)) {
      if (hasDefaultModifier(statement)) names.set('default', declarationRendersUi(statement))
      else names.set(statement.name.text, declarationRendersUi(statement))
    }
    if (ts.isVariableStatement(statement) && hasExportModifier(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) names.set(declaration.name.text, declarationRendersUi(declaration))
      }
    }
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      const expression = statement.expression
      if (ts.isIdentifier(expression)) {
        const local = sourceFile.statements.find(candidate => declarationName(candidate) === expression.text)
        if (local && (ts.isFunctionDeclaration(local) || ts.isVariableStatement(local))) {
          names.set('default', statementRendersUi(local))
        }
      } else {
        names.set('default', expressionRendersUi(statement.expression))
      }
    }
    if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause) && !statement.moduleSpecifier) {
      for (const element of statement.exportClause.elements) {
        const localName = element.propertyName?.getText(sourceFile) ?? element.name.text
        const local = sourceFile.statements.find(candidate => declarationName(candidate) === localName)
        if (local && (ts.isFunctionDeclaration(local) || ts.isVariableStatement(local))) {
          names.set(element.name.text, statementRendersUi(local))
        }
      }
    }
  }
  return names
}

function declarationName(statement: ts.Statement): string | undefined {
  if (ts.isFunctionDeclaration(statement)) return statement.name?.text
  if (ts.isVariableStatement(statement)) {
    const declaration = statement.declarationList.declarations.find(item => ts.isIdentifier(item.name))
    return declaration && ts.isIdentifier(declaration.name) ? declaration.name.text : undefined
  }
  return undefined
}

function statementRendersUi(statement: ts.FunctionDeclaration | ts.VariableStatement): boolean {
  if (ts.isFunctionDeclaration(statement)) return declarationRendersUi(statement)
  return statement.declarationList.declarations.some(declaration => declarationRendersUi(declaration))
}

function hasExportModifier(node: ts.Node): boolean {
  return (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export) !== 0
}

function hasDefaultModifier(node: ts.Node): boolean {
  return (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Default) !== 0
}

export async function buildPlaygroundUiInventory(root: string): Promise<PlaygroundUiInventory> {
  const candidates: UiCandidate[] = []
  for (const scanRoot of scanRoots) {
    const directory = resolve(root, scanRoot.path)
    const files = await collectSourceFiles(directory)
    for (const file of files) {
      const sourcePath = repositoryPath(root, file)
      if (isIgnoredPath(sourcePath)) continue
      const sourceFile = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
      for (const [exportName, rendersUi] of exportedNames(sourceFile)) {
        if (!rendersUi) continue
        const displayName = exportName === 'default' ? basename(file, extname(file)) : exportName
        if (!isComponentName(displayName)) continue
        candidates.push({ sourcePath, exportName, kind: scanRoot.kind })
      }
    }
  }
  candidates.sort((left, right) => left.sourcePath.localeCompare(right.sourcePath) || left.exportName.localeCompare(right.exportName))
  return { schema: UI_INVENTORY_SCHEMA, candidates }
}

function candidateKey(sourcePath: string, exportName: string): string {
  return `${sourcePath}\u0000${exportName}`
}

function isValidCoverageEntry(entry: PlaygroundUiCoverageEntry): boolean {
  const hasPreview = typeof entry.entryId === 'string' && entry.entryId.trim().length > 0
  const hasExemption = typeof entry.exemption?.reason === 'string' && entry.exemption.reason.trim().length > 0
  return Boolean(entry.sourcePath && entry.exportName && (hasPreview !== hasExemption))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function coverageEntryFrom(value: unknown): PlaygroundUiCoverageEntry | undefined {
  if (!isRecord(value)) return undefined
  return value as unknown as PlaygroundUiCoverageEntry
}

export function checkPlaygroundUiCoverage(
  inventory: PlaygroundUiInventory,
  manifest: PlaygroundUiCoverageManifest,
): PlaygroundUiCoverageCheck {
  const diagnostics: PlaygroundUiCoverageDiagnostic[] = []
  const manifestRecord = manifest as unknown
  const entries = isRecord(manifestRecord) && Array.isArray(manifestRecord.entries) ? manifestRecord.entries : undefined
  if (!isRecord(manifestRecord) || manifestRecord.schema !== UI_COVERAGE_SCHEMA || !entries) {
    diagnostics.push({ code: 'INVALID_MANIFEST', message: `Expected schema ${UI_COVERAGE_SCHEMA}.` })
  }
  const candidates = new Map(inventory.candidates.map(candidate => [candidateKey(candidate.sourcePath, candidate.exportName), candidate]))
  const covered = new Set<string>()
  let exempted = 0
  for (const rawEntry of entries ?? []) {
    const entry = coverageEntryFrom(rawEntry)
    if (!entry) {
      diagnostics.push({ code: 'INVALID_ENTRY', message: 'A coverage entry must be an object.' })
      continue
    }
    const key = candidateKey(entry.sourcePath, entry.exportName)
    if (!isValidCoverageEntry(entry)) {
      diagnostics.push({ code: 'INVALID_ENTRY', message: 'A coverage entry must declare exactly one of entryId or exemption.reason.', sourcePath: entry.sourcePath, exportName: entry.exportName })
      continue
    }
    if (!candidates.has(key)) {
      diagnostics.push({ code: 'UNKNOWN_CANDIDATE', message: 'Coverage entry does not match an inventory candidate.', sourcePath: entry.sourcePath, exportName: entry.exportName })
      continue
    }
    if (covered.has(key)) {
      diagnostics.push({ code: 'DUPLICATE_COVERAGE', message: 'Inventory candidate is covered more than once.', sourcePath: entry.sourcePath, exportName: entry.exportName })
      continue
    }
    covered.add(key)
    if (entry.exemption) exempted += 1
  }
  for (const candidate of inventory.candidates) {
    const key = candidateKey(candidate.sourcePath, candidate.exportName)
    if (!covered.has(key)) {
      diagnostics.push({ code: 'UNCOVERED_CANDIDATE', message: 'Production UI candidate has no Playground preview or exemption.', sourcePath: candidate.sourcePath, exportName: candidate.exportName })
    }
  }
  return {
    schema: UI_COVERAGE_CHECK_SCHEMA,
    valid: diagnostics.length === 0,
    candidates: inventory.candidates.length,
    covered: covered.size - exempted,
    exempted,
    diagnostics,
  }
}

export async function loadPlaygroundUiCoverageManifest(path: string): Promise<PlaygroundUiCoverageManifest> {
  return JSON.parse(await readFile(path, 'utf8')) as PlaygroundUiCoverageManifest
}

export function coverageManifestPath(root: string, path: string): string {
  return resolve(root, path)
}
