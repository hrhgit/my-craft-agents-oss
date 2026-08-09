import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { debug } from '../utils/debug.ts'

interface AstNode {
  Type: string
  Text: string
}

interface ScriptBlockAst extends AstNode {
  Type: 'ScriptBlockAst'
  BeginBlock?: NamedBlockAst
  ProcessBlock?: NamedBlockAst
  EndBlock?: NamedBlockAst
}

interface NamedBlockAst extends AstNode {
  Type: 'NamedBlockAst'
  Statements: AstNode[]
}

interface PipelineAst extends AstNode {
  Type: 'PipelineAst'
  PipelineElements: AstNode[]
}

interface CommandAst extends AstNode {
  Type: 'CommandAst'
  CommandElements: AstNode[]
}

interface StringConstantExpressionAst extends AstNode {
  Type: 'StringConstantExpressionAst'
  Value: string
}

interface ExpandableStringExpressionAst extends AstNode {
  Type: 'ExpandableStringExpressionAst'
  Value: string
}

interface CommandParameterAst extends AstNode {
  Type: 'CommandParameterAst'
  ParameterName: string
  Argument?: AstNode
}

interface ParseResult {
  success: boolean
  ast?: ScriptBlockAst
  error?: string
}

let parserRoot: string | undefined
let powershellAvailable: boolean | null = null
let powershellPath: string | null = null

export function setPowerShellValidatorRoot(dir: string): void {
  parserRoot = dir
  debug('[PowerShellReadPatterns] Root set to:', dir)
}

export function isPowerShellAvailable(): boolean {
  if (powershellAvailable !== null) return powershellAvailable

  const candidates = ['pwsh', 'powershell']
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows'
    candidates.push(join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'))
  }

  for (const command of candidates) {
    try {
      const result = spawnSync(command, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 5000,
        encoding: 'utf8',
        shell: true,
      })
      if (result.status === 0) {
        powershellPath = command
        powershellAvailable = true
        return true
      }
    } catch {
      // Try the next executable.
    }
  }

  powershellAvailable = false
  return false
}

export function looksLikePowerShell(command: string): boolean {
  const patterns = [
    /\b(Get|Set|New|Remove|Add|Clear|Write|Read|Out|ConvertTo|ConvertFrom|Test|Select|Where|ForEach|Sort|Group|Measure|Compare|Format|Export|Import|Start|Stop|Invoke|Enable|Disable|Register|Unregister|Update|Find|Install|Uninstall|Save|Publish|Push|Pop)-\w+/i,
    /\$\w+\s*\|/,
    /\s-(?:eq|ne|gt|lt|ge|le|like|notlike|match|notmatch|contains|notcontains|in|notin|replace|split|join)\s/i,
    /@\([^)]*\)/,
    /@\{[^}]*\}/,
    /\b(Where-Object|Select-Object|ForEach-Object|Sort-Object|Group-Object|Measure-Object)\b/i,
    /\b(gci|gcm|gps|gsv|gjb)\b/i,
  ]
  return patterns.some(pattern => pattern.test(command))
}

export function unwrapPowerShellCommand(command: string): string | null {
  const match = command.match(
    /^(?:"[^"]*[/\\]?(?:powershell|pwsh)(?:\.exe)?"\s+|(?:powershell|pwsh)(?:\.exe)?\s+)(?:-(?!Command)\w+\s+)*-Command\s+"((?:[^"\\]|\\.)*)"\s*$/i,
  )
  return match?.[1]?.replace(/\\"/g, '"') ?? null
}

export function extractPowerShellReadTarget(command: string): string | null {
  if (!isPowerShellAvailable()) return null

  const innerCommand = unwrapPowerShellCommand(command)
  if (innerCommand) return extractPowerShellReadTarget(innerCommand)

  const parsed = parseCommand(command)
  if (!parsed.success || !parsed.ast) return null

  const firstCommand = findFirstPipelineCommand(parsed.ast)
  const commandName = firstCommand ? getCommandName(firstCommand) : null
  if (!firstCommand || !commandName || !['get-content', 'gc', 'type'].includes(commandName.toLowerCase())) {
    return null
  }

  return extractParameterValue(firstCommand, ['Path', 'LiteralPath'])
    ?? extractFirstPositionalArg(firstCommand)
}

function parseCommand(command: string): ParseResult {
  if (!powershellPath || !parserRoot) return { success: false, error: 'PowerShell parser unavailable' }

  try {
    const result = spawnSync(
      powershellPath,
      ['-NoProfile', '-NonInteractive', '-File', join(parserRoot, 'powershell-parser.ps1'), '-Command', command],
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
    )
    if (result.error) return { success: false, error: result.error.message }
    const stdout = result.stdout || ''
    if (result.status !== 0 && !stdout) return { success: false, error: result.stderr || `PowerShell exited with code ${result.status}` }
    return JSON.parse(stdout) as ParseResult
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function findFirstPipelineCommand(ast: AstNode): CommandAst | null {
  const pipeline = findFirstPipeline(ast)
  const first = pipeline?.PipelineElements?.[0]
  return first?.Type === 'CommandAst' ? first as CommandAst : null
}

function findFirstPipeline(node: AstNode): PipelineAst | null {
  if (node.Type === 'PipelineAst') return node as PipelineAst
  if (node.Type === 'ScriptBlockAst') {
    const script = node as ScriptBlockAst
    for (const block of [script.EndBlock, script.ProcessBlock, script.BeginBlock]) {
      if (block) {
        const result = findFirstPipeline(block)
        if (result) return result
      }
    }
  }
  if (node.Type === 'NamedBlockAst') {
    for (const statement of (node as NamedBlockAst).Statements || []) {
      const result = findFirstPipeline(statement)
      if (result) return result
    }
  }
  return null
}

function getCommandName(command: CommandAst): string | null {
  const first = command.CommandElements?.[0]
  return first?.Type === 'StringConstantExpressionAst'
    ? (first as StringConstantExpressionAst).Value || null
    : null
}

function extractParameterValue(command: CommandAst, names: string[]): string | null {
  const expected = names.map(name => name.toLowerCase())
  for (let index = 0; index < command.CommandElements.length; index += 1) {
    const element = command.CommandElements[index]
    if (element?.Type !== 'CommandParameterAst') continue
    const parameter = element as CommandParameterAst
    if (!expected.includes(parameter.ParameterName?.toLowerCase())) continue
    if (parameter.Argument) return extractStringValue(parameter.Argument)
    const next = command.CommandElements[index + 1]
    if (next?.Type !== 'CommandParameterAst') return next ? extractStringValue(next) : null
  }
  return null
}

function extractFirstPositionalArg(command: CommandAst): string | null {
  let index = 1
  while (index < command.CommandElements.length) {
    const element = command.CommandElements[index]
    if (element?.Type === 'CommandParameterAst') {
      index += 2
      continue
    }
    return element ? extractStringValue(element) : null
  }
  return null
}

function extractStringValue(node: AstNode): string | null {
  if (node.Type === 'StringConstantExpressionAst') return (node as StringConstantExpressionAst).Value || null
  if (node.Type === 'ExpandableStringExpressionAst') return (node as ExpandableStringExpressionAst).Value || null
  return node.Text?.replace(/^['"]|['"]$/g, '') || null
}
