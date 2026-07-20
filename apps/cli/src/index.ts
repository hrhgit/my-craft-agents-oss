#!/usr/bin/env bun
/**
 * mortise-cli — Terminal client for Mortise Agent server.
 *
 * Connects over WebSocket (ws:// or wss://) to a running Mortise Agent server
 * and provides commands for listing resources, managing sessions, sending
 * messages with real-time streaming, and validating server health.
 */

import { resolve } from 'path'
import { resolveCustomEndpointSetup } from '@mortise/server-core/domain'
import { RPC_CHANNELS } from '@mortise/shared/protocol'
import { CliRpcClient } from './client.ts'
import { invokeAutomationIngressToken, invokeAutomationWorkspace } from './automation-client.ts'
import { subscribeToConversationStream } from './conversation-stream.ts'
import {
  asExtensionInteractionRequest,
  asRemoteUIRequest,
  handleExtensionInteractionInteractive,
  handleExtensionInteractionNonInteractive,
  handleRemoteUIInteractive,
  handleRemoteUINonInteractive,
  type RemoteUIResponder,
} from './remote-ui.ts'

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

export interface CliArgs {
  url: string
  token: string
  workspace?: string
  timeout: number
  json: boolean
  tlsCa?: string
  sendTimeout: number
  command: string
  rest: string[]
  // run-specific flags
  mode: string
  outputFormat: string
  noCleanup: boolean
  noSpinner: boolean
  verbose: boolean
  serverEntry?: string
  workspaceDir?: string
  // LLM configuration
  provider: string
  model: string
  apiKey: string
  baseUrl: string
  // RemoteUI 交互模式：false=自动取消（默认），true=终端渲染对话框
  interactive: boolean
}

export function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2) // skip bun + script path
  let url = ''
  let token = ''
  let workspace: string | undefined
  let timeout = 10_000
  let json = false
  let tlsCa: string | undefined
  let sendTimeout = 300_000 // 5 min
  const rest: string[] = []
  let command = ''
  let mode = ''
  let outputFormat = 'text'
  let noCleanup = false
  let noSpinner = false
  let verbose = false
  let serverEntry: string | undefined
  let workspaceDir: string | undefined
  let provider = ''
  let model = ''
  let apiKey = ''
  let baseUrl = ''
  let interactive = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    switch (arg) {
      case '--url':
        url = args[++i] ?? ''
        break
      case '--token':
        token = args[++i] ?? ''
        break
      case '--workspace':
        workspace = args[++i]
        break
      case '--timeout':
        timeout = parseInt(args[++i] ?? '10000', 10)
        break
      case '--json':
        json = true
        break
      case '--tls-ca':
        tlsCa = args[++i]
        break
      case '--send-timeout':
        sendTimeout = parseInt(args[++i] ?? '300000', 10)
        break
      case '--mode':
        mode = args[++i] ?? ''
        break
      case '--output-format':
        outputFormat = args[++i] ?? 'text'
        break
      case '--no-cleanup':
        noCleanup = true
        break
      case '--disable-spinner':
      case '--no-spinner':
        noSpinner = true
        break
      case '--verbose':
      case '-v':
        verbose = true
        break
      case '--server-entry':
        serverEntry = args[++i]
        break
      case '--workspace-dir':
        workspaceDir = args[++i]
        break
      case '--provider':
        provider = args[++i] ?? ''
        break
      case '--model':
        model = args[++i] ?? ''
        break
      case '--api-key':
        apiKey = args[++i] ?? ''
        break
      case '--base-url':
        baseUrl = args[++i] ?? ''
        break
      case '--interactive':
        interactive = true
        break
      case '--help':
      case '-h':
        command = 'help'
        break
      case '--version':
        command = 'version'
        break
      case '--validate-server':
        command = 'validate'
        break
      default:
        if (!command && !arg.startsWith('-')) {
          command = arg
        } else {
          rest.push(arg)
        }
    }
  }

  // Env var fallbacks
  if (!url) url = process.env.MORTISE_SERVER_URL ?? ''
  if (!token) token = process.env.MORTISE_SERVER_TOKEN ?? ''
  if (!tlsCa) tlsCa = process.env.MORTISE_TLS_CA
  if (!provider) provider = process.env.LLM_PROVIDER ?? 'anthropic'
  if (!model) model = process.env.LLM_MODEL ?? ''
  if (!apiKey) apiKey = process.env.LLM_API_KEY ?? ''
  if (!baseUrl) baseUrl = process.env.LLM_BASE_URL ?? ''

  return { url, token, workspace, timeout, json, tlsCa, sendTimeout, command, rest, mode, outputFormat, noCleanup, noSpinner, verbose, serverEntry, workspaceDir, provider, model, apiKey, baseUrl, interactive }
}

// ---------------------------------------------------------------------------
// Auto workspace resolution
// ---------------------------------------------------------------------------

async function resolveWorkspace(
  client: CliRpcClient,
  explicit?: string,
): Promise<string | undefined> {
  if (explicit) {
    // Bind client to the workspace so push events reach us
    await client.invoke('window:switchWorkspace', explicit).catch(() => {})
    return explicit
  }
  try {
    const workspaces = (await client.invoke('workspaces:get')) as any[]
    if (workspaces?.length > 0) {
      const id = workspaces[0].id
      await client.invoke('window:switchWorkspace', id).catch(() => {})
      return id
    }
  } catch {
    // Fall through — workspace may not be needed
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function out(data: unknown, jsonMode: boolean): void {
  if (jsonMode) {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n')
  } else if (typeof data === 'string') {
    process.stdout.write(data + '\n')
  } else {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n')
  }
}

function err(msg: string): void {
  process.stderr.write(`Error: ${msg}\n`)
}

// ---------------------------------------------------------------------------
// ANSI colors (disabled when NO_COLOR is set or stdout is not a TTY)
// ---------------------------------------------------------------------------

const _useColor = !process.env.NO_COLOR && process.stdout.isTTY !== false
const c = {
  dim: (s: string) => _useColor ? `\x1b[2m${s}\x1b[22m` : s,
  green: (s: string) => _useColor ? `\x1b[32m${s}\x1b[39m` : s,
  red: (s: string) => _useColor ? `\x1b[31m${s}\x1b[39m` : s,
  cyan: (s: string) => _useColor ? `\x1b[36m${s}\x1b[39m` : s,
  bold: (s: string) => _useColor ? `\x1b[1m${s}\x1b[22m` : s,
  yellow: (s: string) => _useColor ? `\x1b[33m${s}\x1b[39m` : s,
  blue: (s: string) => _useColor ? `\x1b[34m${s}\x1b[39m` : s,
}

// ---------------------------------------------------------------------------
// Spinner (TTY only — skipped when piped or NO_COLOR)
// ---------------------------------------------------------------------------

const _spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

function createSpinner(text: string): { stop(): void } {
  let i = 0
  let stopped = false
  // Render first frame immediately — setInterval alone misses fast steps
  process.stdout.write(`${text} ${c.dim(_spinnerFrames[i++ % _spinnerFrames.length])}`)
  const timer = setInterval(() => {
    process.stdout.write(`\r\x1b[2K${text} ${c.dim(_spinnerFrames[i++ % _spinnerFrames.length])}`)
  }, 80)
  return {
    stop() {
      if (stopped) return
      stopped = true
      clearInterval(timer)
      process.stdout.write('\r\x1b[2K')
    },
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdPing(client: CliRpcClient, args: CliArgs): Promise<void> {
  const start = performance.now()
  const clientId = await client.connect()
  const latency = Math.round(performance.now() - start)
  out(
    args.json
      ? { clientId, latencyMs: latency }
      : `Connected: clientId=${clientId} latency=${latency}ms`,
    args.json,
  )
}

async function cmdHealth(client: CliRpcClient, args: CliArgs): Promise<void> {
  await client.connect()
  const result = await client.invoke('credentials:healthCheck')
  out(result, args.json)
}

async function cmdVersions(client: CliRpcClient, args: CliArgs): Promise<void> {
  await client.connect()
  const result = await client.invoke('system:versions')
  out(result, args.json)
}

async function cmdWorkspaces(client: CliRpcClient, args: CliArgs): Promise<void> {
  await client.connect()
  const result = (await client.invoke('workspaces:get')) as any[]
  if (args.json) {
    out(result, true)
  } else {
    if (!result?.length) {
      out('No workspaces found', false)
      return
    }
    for (const ws of result) {
      out(`${ws.id}  ${ws.name ?? '(unnamed)'}  ${ws.path ?? ''}`, false)
    }
  }
}

async function cmdSessions(client: CliRpcClient, args: CliArgs): Promise<void> {
  await client.connect()
  const workspaceId = await resolveWorkspace(client, args.workspace)
  if (!workspaceId) {
    err('No workspace available. Use --workspace <id>')
    process.exit(1)
  }
  const result = (await client.invoke('sessions:get', workspaceId)) as any[]
  if (args.json) {
    out(result, true)
  } else {
    if (!result?.length) {
      out('No sessions found', false)
      return
    }
    for (const s of result) {
      const name = s.name ?? '(unnamed)'
      const preview = s.preview ? `  ${s.preview.slice(0, 60)}` : ''
      const status = s.isProcessing ? ' [processing]' : ''
      out(`${s.id}  ${name}${preview}${status}`, false)
    }
  }
}

async function cmdProviders(client: CliRpcClient, args: CliArgs): Promise<void> {
  await client.connect()
  const result = await client.invoke('pi:getGlobalProviders')
  out(result, args.json)
}

async function cmdSessionCreate(client: CliRpcClient, args: CliArgs): Promise<void> {
  await client.connect()
  const workspaceId = await resolveWorkspace(client, args.workspace)
  if (!workspaceId) {
    err('No workspace available. Use --workspace <id>')
    process.exit(1)
  }

  // Parse sub-args: --name <n>
  let name: string | undefined
  for (let i = 0; i < args.rest.length; i++) {
    if (args.rest[i] === '--name') name = args.rest[++i]
  }

  const promptParts: string[] = []
  const opts: Record<string, unknown> = {}
  if (name) opts.name = name
  if (args.mode) opts.permissionMode = args.mode

  for (let i = 0; i < args.rest.length; i++) {
    if (args.rest[i] === '--name') {
      i++
      continue
    }
    promptParts.push(args.rest[i]!)
  }
  const message = await readPrompt(promptParts)
  if (!message.trim()) {
    err('Usage: session create [--name <name>] <first prompt>')
    process.exit(1)
  }

  const result = await client.invoke('sessions:createAndSendFirstTurn', {
    workspaceId,
    message,
    createOptions: opts,
  })
  out(result, args.json)
}

async function cmdSessionMessages(client: CliRpcClient, args: CliArgs): Promise<void> {
  const sessionId = args.rest[0]
  if (!sessionId) {
    err('Usage: session messages <session-id>')
    process.exit(1)
  }
  await client.connect()
  const result = await client.invoke('sessions:getMessages', sessionId)
  out(result, args.json)
}

async function cmdSessionDelete(client: CliRpcClient, args: CliArgs): Promise<void> {
  const sessionId = args.rest[0]
  if (!sessionId) {
    err('Usage: session delete <session-id>')
    process.exit(1)
  }
  await client.connect()
  await client.invoke('sessions:delete', sessionId)
  out(args.json ? { deleted: sessionId } : `Deleted session: ${sessionId}`, args.json)
}

/**
 * Read prompt text from positional args + stdin.
 * If there are positional words, they become the base message.
 * Reads stdin when: --stdin flag is present, or no message and stdin is piped (not a TTY).
 */
async function readPrompt(words: string[], restArgs?: string[]): Promise<string> {
  let message = words.join(' ')

  const wantsStdin = restArgs?.includes('--stdin')
  const isTTY = typeof process.stdin.isTTY === 'boolean' ? process.stdin.isTTY : false
  if (wantsStdin || (!message && !isTTY)) {
    const chunks: string[] = []
    const reader = Bun.stdin.stream().getReader()
    const decoder = new TextDecoder()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(decoder.decode(value, { stream: true }))
    }
    const stdinText = chunks.join('')
    message = message ? `${message}\n${stdinText}` : stdinText
  }

  return message
}

/**
 * Subscribe to session events, send the message, stream output, wait for completion.
 * Returns the exit code (0 = success, 1 = error, 130 = interrupted).
 */
async function sendAndStream(
  client: CliRpcClient,
  sessionId: string,
  message: string,
  args: CliArgs,
): Promise<number> {
  let exitCode = 0
  let finished = false
  let emittedAssistantText = ''
  const streamJson = args.outputFormat === 'stream-json'

  const unsub = subscribeToConversationStream(client, sessionId, (event) => {
    // F24: Wrap the entire handler body in try/catch so a thrown error in
    // event processing (e.g. malformed payload, stdout write failure) cannot
    // crash the streaming loop or leave `finished` unset, which would hang
    // the CLI until the send timeout. Errors are surfaced to stderr but do
    // not abort the subscription.
    try {
      const ev = event.payload

      if (streamJson) {
        process.stdout.write(JSON.stringify(event.raw) + '\n')
      }

      switch (event.kind) {
        case 'assistant_text_delta':
        case 'text_delta':
          if (!streamJson) {
            const delta = String(ev.delta ?? '')
            emittedAssistantText += delta
            process.stdout.write(delta)
          }
          break
        case 'assistant_text': {
          if (!streamJson) {
            const finalText = String(ev.text ?? '')
            const missing = finalText.startsWith(emittedAssistantText)
              ? finalText.slice(emittedAssistantText.length)
              : emittedAssistantText ? '' : finalText
            if (missing) process.stdout.write(missing)
            emittedAssistantText = finalText || emittedAssistantText
          }
          break
        }
        case 'tool_execution_start':
        case 'tool_start':
          if (!streamJson) process.stdout.write(`\n[tool: ${ev.toolName}${ev.intent || ev.toolIntent ? ` — ${ev.intent ?? ev.toolIntent}` : ''}]\n`)
          break
        case 'tool_execution_end':
        case 'tool_result': {
          if (!streamJson) {
            const result = String(ev.result ?? '')
            if (result.length > 200) {
              process.stdout.write(`${result.slice(0, 200)}...\n`)
            } else if (result) {
              process.stdout.write(`${result}\n`)
            }
          }
          break
        }
        case 'runtime_error':
        case 'error':
          if (!streamJson) err(String(ev.message ?? ev.error ?? 'Agent runtime error'))
          exitCode = 1
          finished = true
          break
        case 'agent_end': {
          const status = String(ev.status ?? 'completed')
          if (!streamJson && status === 'interrupted') process.stdout.write('\n[interrupted]\n')
          else if (!streamJson) process.stdout.write('\n')
          exitCode = status === 'interrupted' || status === 'cancelled' ? 130 : status === 'completed' ? exitCode : 1
          finished = true
          break
        }
        case 'complete':
          if (!streamJson) process.stdout.write('\n')
          finished = true
          break
        case 'interrupted':
          if (!streamJson) process.stdout.write('\n[interrupted]\n')
          exitCode = 130
          finished = true
          break
      }
    } catch (e) {
      err(`conversation stream handler error: ${e instanceof Error ? e.message : String(e)}`)
    }
  })

  await client.invoke('sessions:sendMessage', sessionId, message)

  const deadline = Date.now() + args.sendTimeout
  while (!finished && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100))
  }

  unsub()

  if (!finished) {
    err('Send timeout — no completion event received')
    exitCode = 1
  }

  return exitCode
}

async function cmdSend(client: CliRpcClient, args: CliArgs): Promise<void> {
  const sessionId = args.rest[0]
  if (!sessionId) {
    err('Usage: send <session-id> <message>')
    process.exit(1)
  }

  const message = await readPrompt(args.rest.slice(1), args.rest)
  if (!message.trim()) {
    err('No message provided')
    process.exit(1)
  }

  await client.connect()
  const exitCode = await sendAndStream(client, sessionId, message, args)
  client.destroy()
  process.exit(exitCode)
}

function automationFlag(tokens: string[], name: string): string | undefined {
  const index = tokens.indexOf(name)
  if (index < 0) return undefined
  const value = tokens[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`)
  return value
}

function automationPositionals(tokens: string[], valueFlags: string[]): string[] {
  const values = new Set(valueFlags)
  const result: string[] = []
  for (let index = 0; index < tokens.length; index++) {
    if (values.has(tokens[index]!)) {
      index += 1
      continue
    }
    if (!tokens[index]!.startsWith('--')) result.push(tokens[index]!)
  }
  return result
}

async function readAutomationJson(value: string | undefined, file: string | undefined): Promise<unknown> {
  const source = file ?? value
  if (!source) throw new Error('A JSON value or --file <path> is required')
  if (source === '-') {
    const chunks: Uint8Array[] = []
    for await (const chunk of Bun.stdin.stream()) chunks.push(chunk)
    return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)))
  }
  if (file || source.startsWith('@')) {
    const { readFile } = await import('node:fs/promises')
    return JSON.parse(await readFile(file ?? source.slice(1), 'utf8'))
  }
  return JSON.parse(source)
}

function expectedRevision(tokens: string[], required: boolean): number | null {
  const value = automationFlag(tokens, '--expected-revision')
  if (value === undefined) {
    if (required) throw new Error('--expected-revision <number|null> is required')
    return null
  }
  if (value === 'null') return null
  const revision = Number(value)
  if (!Number.isInteger(revision) || revision < 1) throw new Error('--expected-revision must be a positive integer or null')
  return revision
}

function operationId(tokens: string[]): string {
  return automationFlag(tokens, '--operation-id') ?? crypto.randomUUID()
}

export async function cmdAutomation(client: CliRpcClient, args: CliArgs): Promise<void> {
  await client.connect()
  const workspaceId = await resolveWorkspace(client, args.workspace)
  if (!workspaceId) throw new Error('No workspace available')
  const [subcommand, ...tokens] = args.rest
  const flags = ['--file', '--expected-revision', '--operation-id', '--trigger-id', '--automation-id', '--limit', '--match']
  const positionals = automationPositionals(tokens, flags)
  let result: unknown

  switch (subcommand) {
    case 'describe':
    case 'list':
      result = await invokeAutomationWorkspace(client, { schemaVersion: 1, operation: subcommand })
      break
    case 'get':
      result = await invokeAutomationWorkspace(client, { schemaVersion: 1, operation: 'get', automationId: positionals[0] })
      break
    case 'validate': {
      const definition = await readAutomationJson(positionals[0], automationFlag(tokens, '--file'))
      result = await invokeAutomationWorkspace(client, { schemaVersion: 1, operation: 'validate', definition })
      break
    }
    case 'create':
    case 'update': {
      const definition = await readAutomationJson(positionals[0], automationFlag(tokens, '--file'))
      result = await invokeAutomationWorkspace(client, {
        schemaVersion: 1,
        operation: subcommand,
        operationId: operationId(tokens),
        expectedRevision: expectedRevision(tokens, subcommand === 'update'),
        definition,
      })
      break
    }
    case 'delete':
      result = await invokeAutomationWorkspace(client, {
        schemaVersion: 1, operation: 'delete', operationId: operationId(tokens),
        expectedRevision: expectedRevision(tokens, true), automationId: positionals[0],
      })
      break
    case 'set-enabled': {
      if (positionals[1] !== 'true' && positionals[1] !== 'false') throw new Error('set-enabled requires <id> <true|false>')
      result = await invokeAutomationWorkspace(client, {
        schemaVersion: 1, operation: 'set-enabled', operationId: operationId(tokens),
        expectedRevision: expectedRevision(tokens, true), automationId: positionals[0], enabled: positionals[1] === 'true',
      })
      break
    }
    case 'run':
      result = await invokeAutomationWorkspace(client, {
        schemaVersion: 1, operation: 'run', operationId: operationId(tokens), automationId: positionals[0],
        ...(automationFlag(tokens, '--trigger-id') ? { triggerId: automationFlag(tokens, '--trigger-id') } : {}),
      })
      break
    case 'get-run':
      result = await invokeAutomationWorkspace(client, { schemaVersion: 1, operation: 'get-run', runId: positionals[0] })
      break
    case 'list-runs': {
      const limitValue = automationFlag(tokens, '--limit')
      const limit = limitValue === undefined ? undefined : Number(limitValue)
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 500)) throw new Error('--limit must be an integer from 1 to 500')
      result = await invokeAutomationWorkspace(client, {
        schemaVersion: 1, operation: 'list-runs',
        ...(automationFlag(tokens, '--automation-id') ? { automationId: automationFlag(tokens, '--automation-id') } : {}),
        ...(limit ? { limit } : {}),
      })
      break
    }
    case 'emit-event': {
      const event = await readAutomationJson(positionals[0], automationFlag(tokens, '--file'))
      result = await invokeAutomationWorkspace(client, {
        schemaVersion: 1, operation: 'emit-event', operationId: operationId(tokens), event,
        ...(automationFlag(tokens, '--match') ? { matchValue: automationFlag(tokens, '--match') } : {}),
      })
      break
    }
    case 'token': {
      const tokenOperation = positionals[0]
      if (tokenOperation !== 'path' && tokenOperation !== 'rotate') throw new Error('token requires path or rotate')
      result = await invokeAutomationIngressToken(client, tokenOperation === 'path' ? 'show-path' : 'rotate')
      break
    }
    default:
      throw new Error(`Unknown automation subcommand: ${subcommand ?? '(missing)'}`)
  }
  out(result, args.json)
}

interface LocalServer {
  client: CliRpcClient
  stop: () => Promise<void>
}

async function spawnLocalServer(args: CliArgs, opts?: { quiet?: boolean }): Promise<LocalServer> {
  const { spawnServer } = await import('./server-spawner.ts')
  process.stderr.write('Starting server...\n')
  const server = await spawnServer({
    serverEntry: args.serverEntry,
    startupTimeout: args.timeout > 30_000 ? args.timeout : 30_000,
    quiet: opts?.quiet,
  })
  process.stderr.write(`Server ready: ${server.url}\n`)
  const client = new CliRpcClient(server.url, {
    token: server.token,
    requestTimeout: args.timeout,
  })
  return { client, stop: server.stop }
}

// ---------------------------------------------------------------------------
// Provider setup helpers
// ---------------------------------------------------------------------------

const PROVIDER_ENV_KEYS: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  groq: 'GROQ_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  xai: 'XAI_API_KEY',
  cerebras: 'CEREBRAS_API_KEY',
  huggingface: 'HUGGINGFACE_API_KEY',
}

const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  openrouter: 'OpenRouter',
  groq: 'Groq',
  mistral: 'Mistral',
  deepseek: 'DeepSeek',
  xai: 'xAI',
  cerebras: 'Cerebras',
  huggingface: 'Hugging Face',
  'amazon-bedrock': 'Amazon Bedrock',
}

function getProviderDisplayName(provider: string): string {
  return PROVIDER_DISPLAY_NAMES[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1)
}

export function resolveApiKey(provider: string, explicit: string): string {
  if (explicit) return explicit
  if (provider === 'amazon-bedrock') return '' // IAM credentials, not API key
  const envKey = PROVIDER_ENV_KEYS[provider]
  if (envKey && process.env[envKey]) return process.env[envKey]!
  throw new Error(
    `No API key found. Use --api-key, set $LLM_API_KEY, or set $${envKey ?? `${provider.toUpperCase()}_API_KEY`}`,
  )
}

function resolveOptionalApiKey(provider: string, explicit: string): string | undefined {
  try {
    return resolveApiKey(provider, explicit)
  } catch {
    return undefined
  }
}

export function resolveCustomEndpointCliSetup(provider: string, baseUrl: string, explicitKey: string): {
  providerType: 'pi_compat'
  authType: 'none' | 'api_key_with_endpoint'
  customEndpoint: { api: 'anthropic-messages' | 'openai-completions' }
  defaultModel: string
  credential?: string
  displayName: string
} {
  const customEndpoint = {
    api: provider === 'anthropic' ? 'anthropic-messages' as const : 'openai-completions' as const,
  }
  const credential = resolveOptionalApiKey(provider, explicitKey)
  const branch = resolveCustomEndpointSetup({
    baseUrl,
    credential,
    customEndpointApi: customEndpoint.api,
  })
  if (branch.authType !== 'none' && !credential) {
    resolveApiKey(provider, explicitKey)
  }
  return {
    providerType: 'pi_compat',
    authType: branch.authType,
    customEndpoint,
    defaultModel: provider === 'anthropic' ? 'claude-sonnet-4-6' : 'gpt-4o',
    ...(credential && { credential }),
    displayName: branch.name ?? `${getProviderDisplayName(provider)} (Custom Endpoint)`,
  }
}

export function shouldSetupProvider(existingProviderCount: number, args: Pick<CliArgs, 'provider' | 'baseUrl'>): boolean {
  return existingProviderCount === 0 || !!args.baseUrl || args.provider !== 'anthropic'
}

async function setupProvider(
  client: CliRpcClient,
  args: CliArgs,
): Promise<{ provider: string; model: string }> {
  const { provider, baseUrl } = args
  if (provider === 'amazon-bedrock') throw new Error('Configure Amazon Bedrock through Pi before using mortise-cli')
  const custom = baseUrl ? resolveCustomEndpointCliSetup(provider, baseUrl, args.apiKey) : null
  const apiKey = custom?.credential ?? resolveApiKey(provider, args.apiKey)
  const catalog = await client.invoke('pi:getProviderModels', provider) as { models?: Array<{ id: string; name?: string }> }
  const models = (catalog.models ?? []).map(item => ({ id: item.id, name: item.name ?? item.id }))
  const model = models[0]?.id ?? custom?.defaultModel
  if (!model) throw new Error(`No models available for provider ${provider}`)
  const setupResult = await client.invoke('pi:saveGlobalProvider', {
    key: provider,
    provider: {
      name: custom?.displayName ?? getProviderDisplayName(provider),
      baseUrl: baseUrl || await client.invoke('pi:getProviderBaseUrl', provider),
      api: custom?.customEndpoint.api ?? (provider === 'anthropic' ? 'anthropic-messages' : 'openai-completions'),
      models,
    },
    apiKey,
  }) as { success: boolean; error?: string }
  if (!setupResult?.success) {
    throw new Error(`Provider setup failed: ${setupResult?.error ?? 'unknown error'}`)
  }
  await client.invoke('pi:setGlobalDefault', { provider, model })
  process.stderr.write(`Provider configured: ${provider}${baseUrl ? ` (${baseUrl})` : ''}\n`)
  return { provider, model }
}

async function cmdRun(args: CliArgs): Promise<void> {
  // Prompt = all positional args (no session ID needed, unlike send)
  const message = await readPrompt(args.rest, args.rest)
  if (!message.trim()) {
    err('No prompt provided. Usage: run <message>')
    process.exit(1)
  }

  const server = await spawnLocalServer(args)

  let client: CliRpcClient | undefined = server.client
  let sessionId: string | undefined
  // 交互对话框进行中时为 true — 此时 SIGINT 由 readline 处理（取消当前请求），
  // onSignal 应跳过，避免误取消整个会话并退出进程。
  let inInteractiveDialog = false
  // F6: 串行化 remoteui:request 处理——同一时刻只处理一个对话框，
  // 避免多个 readline 同时绑定 stdin 导致输入乱码。
  let dialogQueue: Promise<void> = Promise.resolve()
  // extensions:EVENT 订阅取消器（在 cleanup 中调用）
  let unsubExtensions: (() => void) | undefined
  // F29: idempotency guard — cleanup can be invoked concurrently by the
  // signal handler (SIGINT/SIGTERM) and by the normal finally block. Without
  // a guard, the second invocation would re-await server.stop() / destroy()
  // and could race with the first, producing unhandled rejections or
  // double-delete session errors.
  let cleaned = false

  const cleanup = async () => {
    if (cleaned) return
    cleaned = true
    unsubExtensions?.()
    if (sessionId && client?.isConnected && !args.noCleanup) {
      await client.invoke('sessions:delete', sessionId).catch(() => {})
    }
    client?.destroy()
    await server.stop()
  }

  // Signal handling — cancel + clean up on SIGINT/SIGTERM
  const onSignal = async () => {
    // 交互对话框期间由 readline 的 SIGINT handler 取消当前请求，不退出进程
    if (inInteractiveDialog) return
    if (sessionId && client?.isConnected) {
      await client.invoke('sessions:cancel', sessionId).catch(() => {})
    }
    await cleanup()
    process.exit(130)
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)

  try {
    await client.connect()

    // 订阅 pi 扩展事件频道（remoteui:request 等）。
    // 服务端通过 eventSink(extensions:event, { to: 'workspace' }, event) 广播，
    // 客户端经 window:switchWorkspace 绑定到工作区后即可接收。
    unsubExtensions = client.on(RPC_CHANNELS.extensions.EVENT, (event: unknown) => {
      const interactionRequest = asExtensionInteractionRequest(event)
      const remoteUIRequest = asRemoteUIRequest(event)
      const request = interactionRequest ?? remoteUIRequest
      if (!request) return

      // F6: 串行化处理——将每个 remoteui:request 排入 Promise 链，
      // 确保同一时刻只处理一个对话框，避免多个 readline 同时绑定 stdin。
      dialogQueue = dialogQueue
        .then(async () => {
          inInteractiveDialog = args.interactive
          try {
            const respond: RemoteUIResponder = async (sid, rid, payload, reason) => {
              await client!.invoke(
                RPC_CHANNELS.extensions.REMOTEUI_RESPONSE,
                sid,
                rid,
                payload,
                reason,
              )
            }
            const log = (m: string) => process.stderr.write(m + '\n')
            if (interactionRequest && args.interactive) {
              await handleExtensionInteractionInteractive(interactionRequest, respond, log)
            } else if (interactionRequest) {
              await handleExtensionInteractionNonInteractive(interactionRequest, respond, log)
            } else if (args.interactive) {
              await handleRemoteUIInteractive(remoteUIRequest!, respond, log)
            } else {
              await handleRemoteUINonInteractive(remoteUIRequest!, respond, log)
            }
          } catch (e) {
            process.stderr.write(
              `[RemoteUI] Handler error: ${e instanceof Error ? e.message : String(e)}\n`,
            )
          } finally {
            inInteractiveDialog = false
          }
        })
        .catch(() => {}) // 防止链断裂影响后续请求
    })

    // Bootstrap workspace from directory if specified
    let bootstrappedWorkspaceId: string | undefined
    if (args.workspaceDir) {
      const absPath = resolve(args.workspaceDir)
      const ws = (await client.invoke('workspaces:create', absPath, 'ci-workspace')) as { id: string }
      bootstrappedWorkspaceId = ws.id
      process.stderr.write(`Workspace registered: ${absPath}\n`)
    }

    // Auto-setup a provider from flags / environment variables.
    // A custom base URL always selects the requested provider endpoint.
    const providers = (await client.invoke('pi:getGlobalProviders')) as any[]
    let selectedProvider: string | undefined
    if (shouldSetupProvider(providers?.length ?? 0, args)) {
      const result = await setupProvider(client, args)
      selectedProvider = result.provider
    }

    const workspaceId = bootstrappedWorkspaceId
      ?? await resolveWorkspace(client, args.workspace)
    if (bootstrappedWorkspaceId) {
      await client.invoke('window:switchWorkspace', bootstrappedWorkspaceId).catch(() => {})
    }
    if (!workspaceId) {
      err('No workspace found on server')
      process.exit(1)
    }

    const firstTurn = (await client.invoke('sessions:createAndSendFirstTurn', {
      workspaceId,
      message,
      createOptions: {
        permissionMode: args.mode || 'allow-all',
        ...(args.model ? { model: args.model } : {}),
        ...(selectedProvider ? { provider: selectedProvider } : {}),
      },
    })) as { session: { id: string } }
    sessionId = firstTurn.session.id
    out(firstTurn, args.json)
    await cleanup()
    process.exit(0)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    err(msg)
    await cleanup()
    process.exit(1)
  } finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
  }
}

async function cmdValidate(args: CliArgs): Promise<void> {
  let server: LocalServer | undefined
  let client: CliRpcClient

  // Use a generous timeout because cold server startup can be slow on Windows.
  const validateArgs = { ...args, timeout: Math.max(args.timeout, 30_000) }

  if (args.url) {
    client = new CliRpcClient(args.url, {
      token: args.token || undefined,
      requestTimeout: validateArgs.timeout,
      connectTimeout: validateArgs.timeout,
    })
  } else {
    server = await spawnLocalServer(validateArgs, { quiet: !args.verbose })
    client = server.client
  }

  try {
    const exitCode = await runValidation(client, args.json, args.noSpinner, args.workspaceDir, {
      baseUrl: args.baseUrl,
      apiKey: args.apiKey,
      provider: args.provider,
    })
    client.destroy()
    if (server) await server.stop()
    process.exit(exitCode)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    err(msg)
    client.destroy()
    if (server) await server.stop()
    process.exit(1)
  }
}

async function cmdCancel(client: CliRpcClient, args: CliArgs): Promise<void> {
  const sessionId = args.rest[0]
  if (!sessionId) {
    err('Usage: cancel <session-id>')
    process.exit(1)
  }
  await client.connect()
  await client.invoke('sessions:cancel', sessionId)
  out(args.json ? { cancelled: sessionId } : `Cancelled: ${sessionId}`, args.json)
}

async function cmdInvoke(client: CliRpcClient, args: CliArgs): Promise<void> {
  const channel = args.rest[0]
  if (!channel) {
    err('Usage: invoke <channel> [json-args...]')
    process.exit(1)
  }
  await client.connect()

  // Parse remaining args as JSON
  const invokeArgs: unknown[] = []
  for (let i = 1; i < args.rest.length; i++) {
    try {
      invokeArgs.push(JSON.parse(args.rest[i]))
    } catch {
      invokeArgs.push(args.rest[i])
    }
  }

  const result = await client.invoke(channel, ...invokeArgs)
  out(result, args.json)
}

async function cmdListen(client: CliRpcClient, args: CliArgs): Promise<void> {
  const channel = args.rest[0]
  if (!channel) {
    err('Usage: listen <channel>')
    process.exit(1)
  }
  await client.connect()

  client.on(channel, (...eventArgs: unknown[]) => {
    out({ channel, args: eventArgs, timestamp: new Date().toISOString() }, true)
  })

  process.stdout.write(`Listening on ${channel} (Ctrl+C to stop)\n`)

  // Keep alive
  await new Promise(() => {
    // Never resolves — Ctrl+C exits
  })
}

// ---------------------------------------------------------------------------
// Validate server
// ---------------------------------------------------------------------------

export interface ValidateStep {
  name: string
  fn: (client: CliRpcClient, ctx: ValidateContext) => Promise<string>
}

export interface ValidateContext {
  /** Pre-existing workspace directory (from --workspace-dir) */
  workspaceDir?: string
  /** Custom endpoint URL (from --base-url) */
  baseUrl?: string
  /** API key override (from --api-key) */
  apiKey?: string
  /** Provider hint (from --provider, default 'anthropic') */
  provider?: string
  workspaceId?: string
  workspaceRootPath?: string
  createdWorkspace?: boolean
  createdSessionId?: string
  createdSkillSlug?: string
  branchedSessionId?: string
  onEvent?: (ev: { type: string; [key: string]: unknown }) => void
}

/** Minimal shapes for RPC responses used in validation steps. */
interface ValidateMessageBlock {
  type: string
  text?: string
}

interface ValidateMessage {
  role: string
  content: string | ValidateMessageBlock[]
}

interface ValidateMessagesResponse {
  messages?: ValidateMessage[]
  conversation?: ValidateMessage[]
}

/**
 * Send a message and wait for streaming events.
 * Returns a summary of received event types.
 * If expectTool is true, validates that tool_start + tool_result events arrived.
 */
async function waitForSendEvents(
  client: CliRpcClient,
  sessionId: string,
  message: string,
  timeoutMs: number,
  expectTool: boolean,
  sendOptions?: Record<string, unknown>,
  onEvent?: (ev: { type: string; [key: string]: unknown }) => void,
  expectToolName?: string,
): Promise<string> {
  const seen = new Set<string>()
  let textChunks = 0
  let toolName = ''
  let finished = false

  const unsub = subscribeToConversationStream(client, sessionId, (event) => {
    const ev = event.payload
    seen.add(event.kind)
    if (event.kind === 'assistant_text_delta' || event.kind === 'text_delta') textChunks++
    if (event.kind === 'tool_execution_start' || event.kind === 'tool_start') toolName = String(ev.toolName ?? '')
    if (event.kind === 'agent_end' || event.kind === 'runtime_error'
      || event.kind === 'complete' || event.kind === 'error' || event.kind === 'interrupted') {
      finished = true
    }
    onEvent?.({ type: event.kind, ...ev })
  })

  try {
    await client.invoke('sessions:sendMessage', sessionId, message,
      undefined, undefined, sendOptions)

    const deadline = Date.now() + timeoutMs
    while (!finished && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100))
    }

    if (!finished) throw new Error('Timed out waiting for completion')

    // Only treat as failure if error was the terminal event (no complete followed)
    if ((seen.has('runtime_error') || seen.has('error')) && !seen.has('agent_end') && !seen.has('complete')) throw new Error('Session returned an error event')

    if (expectTool) {
      if (!seen.has('tool_execution_start') && !seen.has('tool_start')) throw new Error('No tool start event received')
      if (!seen.has('tool_execution_end') && !seen.has('tool_result')) throw new Error('No tool result event received')
      if (expectToolName && !toolName.includes(expectToolName)) {
        throw new Error(`Expected tool containing "${expectToolName}", got "${toolName}"`)
      }
      return `tool=${toolName}, ${textChunks} text deltas, events: ${[...seen].join(', ')}`
    }

    if (!seen.has('assistant_text_delta') && !seen.has('text_delta')) throw new Error('No assistant text delta events received')
    return `${textChunks} text deltas, events: ${[...seen].join(', ')}`
  } finally {
    unsub()
  }
}

export function getValidateSteps(): ValidateStep[] {
  return [
    {
      name: 'Connect + handshake',
      fn: async (client) => {
        const start = performance.now()
        const clientId = await client.connect()
        const ms = Math.round(performance.now() - start)
        return `clientId: ${clientId}, ${ms}ms`
      },
    },
    {
      name: 'credentials:healthCheck',
      fn: async (client) => {
        const r = (await client.invoke('credentials:healthCheck')) as any
        return JSON.stringify(r)
      },
    },
    {
      name: 'system:versions',
      fn: async (client) => {
        const r = (await client.invoke('system:versions')) as any
        return r?.node ? `node=${r.node}` : JSON.stringify(r)
      },
    },
    {
      name: 'system:homeDir',
      fn: async (client) => {
        const r = await client.invoke('system:homeDir')
        return String(r)
      },
    },
    {
      name: 'workspaces:get',
      fn: async (client, ctx) => {
        // Register workspace from --workspace-dir if provided
        if (ctx.workspaceDir) {
          const { resolve } = await import('path')
          const absPath = resolve(ctx.workspaceDir)
          const ws = (await client.invoke('workspaces:create', absPath, 'ci-workspace')) as { id: string }
          ctx.workspaceId = ws.id
          ctx.workspaceRootPath = absPath
          await client.invoke('window:switchWorkspace', ws.id)
          return `registered: ${absPath}`
        }
        const r = (await client.invoke('workspaces:get')) as any[]
        if (r?.length > 0) {
          ctx.workspaceId = r[0].id
          ctx.workspaceRootPath = r[0].rootPath ?? r[0].path
          // Bind this client to the workspace so push events (e.g. session:event)
          // routed { to: 'workspace' } reach us.
          await client.invoke('window:switchWorkspace', r[0].id)
          return `${r.length} workspaces`
        }
        // Auto-bootstrap a temp workspace for CI environments
        const { mkdtemp } = await import('fs/promises')
        const { tmpdir } = await import('os')
        const tmpDir = await mkdtemp(`${tmpdir()}/mortise-validate-`)
        const ws = (await client.invoke('workspaces:create', tmpDir, 'validate-workspace')) as { id: string }
        ctx.workspaceId = ws.id
        ctx.workspaceRootPath = tmpDir
        ctx.createdWorkspace = true
        await client.invoke('window:switchWorkspace', ws.id)
        return `0 found → created temp workspace`
      },
    },
    {
      name: 'sessions:get',
      fn: async (client, ctx) => {
        if (!ctx.workspaceId) return 'skipped (no workspace)'
        const r = (await client.invoke('sessions:get', ctx.workspaceId)) as any[]
        return `${r?.length ?? 0} sessions`
      },
    },
    {
      name: 'pi:getGlobalProviders',
      fn: async (client) => {
        const providers = (await client.invoke('pi:getGlobalProviders')) as any[]
        return `${providers?.length ?? 0} providers`
      },
    },
    {
      name: 'sessions:createAndSendFirstTurn',
      fn: async (client, ctx) => {
        if (!ctx.workspaceId) return 'skipped (no workspace)'
        const name = `__cli-validate-${Date.now()}`
        const r = (await client.invoke('sessions:createAndSendFirstTurn', {
          workspaceId: ctx.workspaceId,
          message: 'Reply with exactly: SESSION_CREATED',
          createOptions: { name, permissionMode: 'allow-all' },
        })) as any
        ctx.createdSessionId = r?.session?.id
        return ctx.createdSessionId ?? 'created'
      },
    },
    {
      name: 'sessions:getMessages',
      fn: async (client, ctx) => {
        if (!ctx.createdSessionId) return 'skipped (no session)'
        await client.invoke('sessions:getMessages', ctx.createdSessionId)
        return 'session readable'
      },
    },
    {
      name: 'send message + stream',
      fn: async (client, ctx) => {
        if (!ctx.createdSessionId) return 'skipped (no session)'
        return await waitForSendEvents(client, ctx.createdSessionId,
          'Reply with exactly: VALIDATION_OK', 60_000, false, undefined, ctx.onEvent)
      },
    },
    {
      name: 'send message + tool use',
      fn: async (client, ctx) => {
        if (!ctx.createdSessionId) return 'skipped (no session)'
        return await waitForSendEvents(client, ctx.createdSessionId,
          'Use the Bash tool to run: echo TOOL_VALIDATION_OK', 90_000, true, undefined, ctx.onEvent)
      },
    },
    {
      name: 'session-tools:get_session_info',
      fn: async (client, ctx) => {
        if (!ctx.createdSessionId) return 'skipped (no session)'
        return await waitForSendEvents(client, ctx.createdSessionId,
          'Use the get_session_info tool to get info about the current session. Do NOT use any other tool.',
          90_000, true, undefined, ctx.onEvent, 'get_session_info')
      },
    },
    {
      name: 'session-tools:list_sessions',
      fn: async (client, ctx) => {
        if (!ctx.createdSessionId) return 'skipped (no session)'
        return await waitForSendEvents(client, ctx.createdSessionId,
          'Use the list_sessions tool to list all sessions. Do NOT use any other tool.',
          90_000, true, undefined, ctx.onEvent, 'list_sessions')
      },
    },
    // ----- Session branching -----
    {
      name: 'sessions:branch',
      fn: async (client, ctx) => {
        if (!ctx.createdSessionId || !ctx.workspaceId) return 'skipped (no session)'
        const r = (await client.invoke('sessions:getMessages', ctx.createdSessionId)) as ValidateMessagesResponse
        const messages = r?.messages ?? r?.conversation ?? []
        const firstAssistant = messages.find((m) => m.role === 'assistant') as any
        if (!firstAssistant?.id) throw new Error('No assistant message found to branch from')
        const branch = (await client.invoke('sessions:create', ctx.workspaceId, {
          name: `__cli-validate-branch-${Date.now()}`,
          permissionMode: 'allow-all',
          branchFromSessionId: ctx.createdSessionId,
          branchFromMessageId: firstAssistant.id,
        })) as any
        ctx.branchedSessionId = branch?.id
        return `branched at message ${firstAssistant.id} → session ${branch?.id}`
      },
    },
    {
      name: 'sessions:branch verify',
      fn: async (client, ctx) => {
        if (!ctx.branchedSessionId) return 'skipped (no branch)'
        const r = (await client.invoke('sessions:getMessages', ctx.branchedSessionId)) as ValidateMessagesResponse
        const messages = r?.messages ?? r?.conversation ?? []
        const hasAssistant = messages.some((m) => m.role === 'assistant')
        if (!hasAssistant) throw new Error('Branch missing assistant message')
        const origR = (await client.invoke('sessions:getMessages', ctx.createdSessionId!)) as ValidateMessagesResponse
        const origMessages = origR?.messages ?? origR?.conversation ?? []
        if (messages.length >= origMessages.length) {
          throw new Error(`Branch has ${messages.length} messages, expected fewer than original (${origMessages.length})`)
        }
        return `branch has ${messages.length} messages (original has ${origMessages.length})`
      },
    },
    {
      name: 'sessions:branch send',
      fn: async (client, ctx) => {
        if (!ctx.branchedSessionId) return 'skipped (no branch)'
        return await waitForSendEvents(client, ctx.branchedSessionId,
          'Reply with exactly: BRANCH_OK', 60_000, false, undefined, ctx.onEvent)
      },
    },
    // ----- Skill lifecycle -----
    {
      name: 'send + skill create',
      fn: async (client, ctx) => {
        if (!ctx.createdSessionId || !ctx.workspaceRootPath) return 'skipped (no session or workspace)'
        ctx.createdSkillSlug = '__cli-validate-skill'
        const skillDir = `${ctx.workspaceRootPath}/.pi/skills/${ctx.createdSkillSlug}`
        // Use bash to create the skill file deterministically
        return await waitForSendEvents(client, ctx.createdSessionId,
          `Use the Bash tool to run this exact command:
mkdir -p "${skillDir}" && cat > "${skillDir}/SKILL.md" << 'SKILLEOF'
---
name: "CLI Validate Skill"
description: "Validation skill created by mortise-cli"
---

Check the current water temperature of Lake Balaton by searching the web or estimating it from the season.
SKILLEOF`, 90_000, true, undefined, ctx.onEvent)
      },
    },
    {
      name: 'skills:get (verify)',
      fn: async (client, ctx) => {
        if (!ctx.workspaceId || !ctx.createdSkillSlug) return 'skipped (no skill)'
        const r = (await client.invoke('skills:get', ctx.workspaceId)) as any[]
        const found = r?.find((s: any) => s.slug === ctx.createdSkillSlug)
        if (!found) throw new Error(`Skill '${ctx.createdSkillSlug}' not found in skills list`)
        return `found: ${found.name ?? found.slug}`
      },
    },
    {
      name: 'send + skill mention',
      fn: async (client, ctx) => {
        if (!ctx.createdSessionId || !ctx.createdSkillSlug) return 'skipped (no session or skill)'
        return await waitForSendEvents(client, ctx.createdSessionId,
          `[skill:${ctx.createdSkillSlug}] Run the skill`, 120_000, false,
          { skillSlugs: [ctx.createdSkillSlug] }, ctx.onEvent)
      },
    },
    {
      name: 'skills:delete',
      fn: async (client, ctx) => {
        if (!ctx.workspaceId || !ctx.createdSkillSlug) return 'skipped (no skill)'
        await client.invoke('skills:delete', ctx.workspaceId, ctx.createdSkillSlug)
        return `deleted skill: ${ctx.createdSkillSlug}`
      },
    },
    // ----- Webhook validation -----
    {
      name: 'webhook:test (RPC)',
      fn: async (client, ctx) => {
        if (!ctx.workspaceId) return 'skipped (no workspace)'
        const r = (await client.invoke('automations:test', {
          workspaceId: ctx.workspaceId,
          actions: [{
            type: 'webhook',
            url: 'http://127.0.0.1:19999/validate-test',
            method: 'GET',
          }],
        })) as any
        const result = r?.actions?.[0]
        if (result?.success) throw new Error('Expected webhook to fail (nothing listening)')
        if (!result?.error && result?.statusCode !== 0) throw new Error('Expected error or statusCode 0 in result')
        return `correctly failed: ${(result.error ?? `statusCode=${result.statusCode}`).slice(0, 80)}`
      },
    },
    {
      name: 'webhook:verify failure',
      fn: async (client, ctx) => {
        if (!ctx.workspaceRootPath) return 'skipped (no workspace root)'
        const { readFile } = await import('fs/promises')
        const historyPath = `${ctx.workspaceRootPath}/automations-history.jsonl`

        const start = Date.now()
        const deadline = start + 15_000
        let delay = 200

        let lastLineCount = 0
        let lastWebhookCount = 0
        let lastSummary = 'no entries'

        while (Date.now() < deadline) {
          const content = await readFile(historyPath, 'utf-8').catch(() => '')
          const lines = content.trim().split('\n').filter(Boolean)
          lastLineCount = lines.length

          const entries = lines
            .map((l) => {
              try {
                return JSON.parse(l)
              } catch {
                return null
              }
            })
            .filter(Boolean) as Array<Record<string, unknown>>

          const webhookEntries = entries.filter((e) => !!e.webhook)
          lastWebhookCount = webhookEntries.length

          if (webhookEntries.length > 0) {
            const recentThreshold = Date.now() - 120_000
            const recentFailed = webhookEntries.find((e: any) =>
              !e.ok && e.ts > recentThreshold && e.webhook?.method === 'POST'
            ) as any
            if (recentFailed) {
              return `webhook failure recorded: method=${recentFailed.webhook.method}, url=${recentFailed.webhook.url?.slice(0, 50)}`
            }

            const latest = webhookEntries[webhookEntries.length - 1] as any
            lastSummary = `latest: ok=${String(latest?.ok)} method=${String(latest?.webhook?.method ?? 'n/a')} ts=${String(latest?.ts ?? 'n/a')}`
          }

          await new Promise((r) => setTimeout(r, delay))
          delay = Math.min(Math.round(delay * 1.8), 1500)
        }

        const waitedMs = Date.now() - start
        throw new Error(
          `No recent failed POST webhook history entry after ${waitedMs}ms (lines=${lastLineCount}, webhookEntries=${lastWebhookCount}, ${lastSummary})`,
        )
      },
    },
    {
      name: 'automation:cleanup',
      fn: async (client) => {
        const result = await client.invoke(RPC_CHANNELS.automations.COMMAND, { schemaVersion: 1, operation: 'list' }) as { data?: unknown[] }
        return `canonical automations checked: ${Array.isArray(result?.data) ? result.data.length : 0}`
      },
    },
    {
      name: 'sessions:branch delete',
      fn: async (client, ctx) => {
        if (!ctx.branchedSessionId) return 'skipped (no branch)'
        await client.invoke('sessions:delete', ctx.branchedSessionId)
        const id = ctx.branchedSessionId
        ctx.branchedSessionId = undefined
        return `deleted branch session: ${id}`
      },
    },
    {
      name: 'sessions:delete',
      fn: async (client, ctx) => {
        if (!ctx.createdSessionId) return 'skipped (no session)'
        await client.invoke('sessions:delete', ctx.createdSessionId)
        return `deleted session: ${ctx.createdSessionId}`
      },
    },
    {
      name: 'Disconnect',
      fn: async (client) => {
        client.destroy()
        return 'OK'
      },
    },
  ]
}

export async function runValidation(
  client: CliRpcClient,
  jsonMode: boolean,
  noSpinner?: boolean,
  workspaceDir?: string,
  validateOptions?: { baseUrl?: string; apiKey?: string; provider?: string },
): Promise<number> {
  const steps = getValidateSteps()
  const total = steps.length
  const ctx: ValidateContext = {
    workspaceDir,
    baseUrl: validateOptions?.baseUrl,
    apiKey: validateOptions?.apiKey,
    provider: validateOptions?.provider,
  }
  let passed = 0
  let failed = 0
  const results: Array<{ step: string; status: string; detail: string; elapsed: number }> = []
  const totalStart = performance.now()

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    const num = `[${i + 1}/${total}]`
    const plainLen = num.length + 1 + step.name.length

    // Spinner + live event printer
    // Spinner keeps running until the agent produces real output.
    // Early events (user_message, provider_changed, usage_update) are buffered or ignored
    // so the spinner stays visible while the agent is thinking.
    let spinner: { stop(): void } | undefined
    if (!jsonMode) {
      let headerPrinted = false
      let accText = ''
      let textFlushed = false
      let bufferedPrompt = ''

      if (_useColor && !noSpinner) {
        spinner = createSpinner(`${c.cyan(num)} ${step.name}`)
      }

      const flushText = () => {
        if (textFlushed || !accText) return
        const clean = accText.replace(/\n/g, ' ').trim()
        if (!clean) return
        const display = clean.length > 120 ? clean.slice(0, 120) + '…' : clean
        process.stdout.write(`    ${c.dim('↳')} ${c.yellow(display)}\n`)
        textFlushed = true
      }

      const ensureHeader = () => {
        if (headerPrinted) return
        spinner?.stop()
        process.stdout.write(`${c.cyan(num)} ${step.name}\n`)
        if (bufferedPrompt) {
          process.stdout.write(`    ${c.dim('→')} ${c.blue(`"${bufferedPrompt}"`)}\n`)
        }
        headerPrinted = true
      }

      ctx.onEvent = (ev) => {
        switch (ev.type) {
          // Buffer prompt — shown when agent starts responding
          case 'user_text':
          case 'user_message': {
            if (ev.type === 'user_text') {
              const clean = String(ev.text ?? '').replace(/\n/g, ' ').trim()
              bufferedPrompt = clean.length > 100 ? clean.slice(0, 100) + '…' : clean
              break
            }
            const msg = ev.message as any
            let text = ''
            if (typeof msg?.content === 'string') {
              text = msg.content
            } else if (Array.isArray(msg?.content)) {
              text = msg.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join(' ')
            }
            const clean = text.replace(/\n/g, ' ').trim()
            bufferedPrompt = clean.length > 100 ? clean.slice(0, 100) + '…' : clean
            break
          }
          // Agent text — stop spinner, show header + prompt + text
          case 'assistant_text_delta':
          case 'text_delta':
            ensureHeader()
            accText += String(ev.delta ?? '')
            if (!textFlushed && accText.length > 40) flushText()
            break
          case 'assistant_text':
          case 'text_complete':
            ensureHeader()
            flushText()
            break
          // Tool use — stop spinner, show header + prompt + tool
          case 'tool_execution_start':
          case 'tool_start': {
            ensureHeader()
            flushText()
            const name = String(ev.toolName ?? '?')
            const toolIntent = ev.intent ?? ev.toolIntent
            const intent = toolIntent ? ` — "${toolIntent}"` : ''
            process.stdout.write(`    ${c.dim('↳')} ${c.dim(`tool: ${name}${intent}`)}\n`)
            accText = ''
            textFlushed = false
            break
          }
          // Ignore internal events (provider_changed, usage_update, etc.)
        }
      }
    } else {
      ctx.onEvent = undefined
    }

    const stepStart = performance.now()
    try {
      const detail = await step.fn(client, ctx)
      const elapsed = (performance.now() - stepStart) / 1000
      passed++
      results.push({ step: step.name, status: 'OK', detail, elapsed })
      spinner?.stop()
      if (!jsonMode) {
        const dots = c.dim('.'.repeat(Math.max(1, 50 - plainLen)))
        const time = c.dim(elapsed < 1 ? `(${Math.round(elapsed * 1000)}ms)` : `(${elapsed.toFixed(1)}s)`)
        process.stdout.write(`${c.cyan(num)} ${step.name} ${dots} ${c.green('✓')}  ${detail}  ${time}\n`)
      }
    } catch (e) {
      const elapsed = (performance.now() - stepStart) / 1000
      failed++
      const msg = e instanceof Error ? e.message : String(e)
      results.push({ step: step.name, status: 'FAIL', detail: msg, elapsed })
      spinner?.stop()
      if (!jsonMode) {
        const dots = c.dim('.'.repeat(Math.max(1, 50 - plainLen)))
        const time = c.dim(elapsed < 1 ? `(${Math.round(elapsed * 1000)}ms)` : `(${elapsed.toFixed(1)}s)`)
        process.stderr.write(`${c.cyan(num)} ${step.name} ${dots} ${c.red('✗')}  ${msg}  ${time}\n`)
      }
    }
  }

  // Cleanup: branched session
  if (ctx.branchedSessionId && client.isConnected) {
    try {
      await client.invoke('sessions:delete', ctx.branchedSessionId)
    } catch {
      // best effort
    }
  }

  // Cleanup: if a session was created but delete step hasn't run or failed
  if (ctx.createdSessionId && client.isConnected) {
    try {
      await client.invoke('sessions:delete', ctx.createdSessionId)
    } catch {
      // best effort
    }
  }

  // Cleanup: if we auto-created a temp workspace, remove it
  if (ctx.createdWorkspace && ctx.workspaceId && client.isConnected) {
    try {
      await client.invoke('workspaces:delete', ctx.workspaceId)
    } catch {
      // best effort
    }
    if (ctx.workspaceRootPath) {
      try {
        const { rm } = await import('fs/promises')
        await rm(ctx.workspaceRootPath, { recursive: true, force: true })
      } catch {
        // best effort
      }
    }
  }

  const totalSec = ((performance.now() - totalStart) / 1000).toFixed(1)

  if (jsonMode) {
    out({ total, passed, failed, results, elapsedSeconds: parseFloat(totalSec) }, true)
  } else {
    if (failed === 0) {
      process.stdout.write(`\n${c.green(`✓ ${passed}/${total} passed`)} ${c.dim(`in ${totalSec}s`)}\n`)
    } else {
      process.stdout.write(`\n${c.red(`✗ ${passed}/${total} passed, ${failed} failed`)} ${c.dim(`in ${totalSec}s`)}\n`)
    }
  }

  return failed > 0 ? 1 : 0
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function printHelp(): void {
  process.stdout.write(`mortise-cli — Terminal client for Mortise Agent server

Usage: mortise-cli [options] <command> [args...]

Connection:
  --url <ws[s]://...>    Server URL (default: $MORTISE_SERVER_URL)
  --token <secret>       Auth token (default: $MORTISE_SERVER_TOKEN)
  --workspace <id>       Workspace ID (auto-detected if omitted)
  --timeout <ms>         Request timeout (default: 10000)
  --tls-ca <path>        Custom CA cert for self-signed TLS
  --json                 Raw JSON output for scripting

LLM Configuration (for 'run' command):
  --provider <name>      LLM provider (default: anthropic alias, or $LLM_PROVIDER)
                         Supported: anthropic, openai, google, openrouter, groq, mistral, deepseek, xai, ...
  --model <id>           Model to use (or $LLM_MODEL)
  --api-key <key>        API key (or $LLM_API_KEY, or provider-specific e.g. $OPENAI_API_KEY)
  --base-url <url>       Custom API endpoint (or $LLM_BASE_URL)

Commands:
  run <message>          Spawn server, send message, stream response, exit
                         --workspace-dir <path>  Use directory as workspace (creates if needed)
                         --mode <mode>       Permission mode (default: allow-all)
                         --output-format     text or stream-json (default: text)
                         --no-cleanup        Keep session after completion
                         --server-entry      Path to server/index.ts
                         --interactive       Render pi extension remoteui:request dialogs
                                             in the terminal (select/editor). Default:
                                             auto-cancel with reason "non-interactive".
  ping                   Verify connectivity (clientId + latency)
  health                 Check credential store health
  versions               Show server runtime versions
  workspaces             List workspaces
  sessions               List sessions in workspace
  providers              List AI providers
  session create <prompt>  Start and send the first turn (--name, --mode)
  session messages <id>  Print session message history
  session delete <id>    Delete a session
  send <id> <message>    Send message and stream AI response
  cancel <id>            Cancel in-progress processing
  automation <command>   Manage canonical workspace automations
    describe | list | get <id> | validate <json|@file>
    create <json|@file> [--expected-revision <n|null>]
    update <json|@file> --expected-revision <n>
    delete <id> --expected-revision <n>
    set-enabled <id> <true|false> --expected-revision <n>
    run <id> [--trigger-id <id>] | get-run <id> | list-runs
    emit-event <json|@file> | token path | token rotate
  invoke <channel> [...] Raw RPC call with JSON args
  listen <channel>       Subscribe to push events (Ctrl+C to stop)
  --validate-server      Multi-step server integration test
                         --verbose, -v       Show server stderr output

Examples:
  mortise-cli run "What files are in the current directory?"
  mortise-cli run --provider openai --model gpt-4o "Summarize this repo"
  OPENAI_API_KEY=sk-... mortise-cli run --provider openai "Hello"
  GOOGLE_API_KEY=... mortise-cli run --provider google --model gemini-2.0-flash "Hello"
  DEEPSEEK_API_KEY=sk-... mortise-cli run --provider deepseek --model deepseek-v4-flash "Hello"
  echo "Analyze this code" | mortise-cli run
  mortise-cli ping
  mortise-cli sessions
  mortise-cli send abc-123 "What files are in the current directory?"
  mortise-cli --workspace ws-1 automation list
  mortise-cli --workspace ws-1 automation emit-event @event.json
  mortise-cli --workspace ws-1 automation token path
  echo "Summarize this" | mortise-cli send abc-123
  mortise-cli --validate-server
  mortise-cli invoke system:homeDir
  mortise-cli --json workspaces | jq '.[].name'
`)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function main(argv: string[] = process.argv): Promise<void> {
  const args = parseArgs(argv)

  // F14: 标记 CLI 模式——子进程（spawnLocalServer）继承此环境变量，
  // pi-agent.ts 据此跳过 browser_tool 注册（CLI 无浏览器窗口，调用只会返回运行时错误）。
  process.env.MORTISE_CLI_MODE = '1'

  // Set custom CA before any WS connections
  if (args.tlsCa) {
    process.env.NODE_EXTRA_CA_CERTS = args.tlsCa
  }

  if (args.command === 'help' || args.command === '') {
    printHelp()
    return
  }

  if (args.command === 'version') {
    const pkg = await import('../package.json')
    out(pkg.version ?? pkg.default?.version ?? 'unknown', false)
    return
  }

  // run is self-contained — spawns its own server
  if (args.command === 'run') {
    await cmdRun(args)
    return
  }

  // validate can spawn its own server or use --url
  if (args.command === 'validate') {
    await cmdValidate(args)
    return
  }

  // All other commands need a server URL
  if (!args.url) {
    err('No server URL. Use --url <ws://...> or set $MORTISE_SERVER_URL')
    process.exit(1)
  }

  const client = new CliRpcClient(args.url, {
    token: args.token || undefined,
    workspaceId: args.workspace,
    requestTimeout: args.timeout,
    connectTimeout: args.timeout,
  })

  try {
    switch (args.command) {
      case 'ping':
        await cmdPing(client, args)
        break
      case 'health':
        await cmdHealth(client, args)
        break
      case 'versions':
        await cmdVersions(client, args)
        break
      case 'workspaces':
        await cmdWorkspaces(client, args)
        break
      case 'sessions':
        await cmdSessions(client, args)
        break
      case 'providers':
        await cmdProviders(client, args)
        break
      case 'session': {
        const subCmd = args.rest.shift()
        switch (subCmd) {
          case 'create':
            await cmdSessionCreate(client, args)
            break
          case 'messages':
            await cmdSessionMessages(client, args)
            break
          case 'delete':
            await cmdSessionDelete(client, args)
            break
          default:
            err(`Unknown session subcommand: ${subCmd}`)
            process.exit(1)
        }
        break
      }
      case 'send':
        await cmdSend(client, args)
        break // cmdSend calls process.exit
      case 'cancel':
        await cmdCancel(client, args)
        break
      case 'automation':
        await cmdAutomation(client, args)
        break
      case 'invoke':
        await cmdInvoke(client, args)
        break
      case 'listen':
        await cmdListen(client, args)
        break // never returns
      default:
        err(`Unknown command: ${args.command}`)
        printHelp()
        process.exit(1)
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    err(msg)
    process.exit(1)
  } finally {
    client.destroy()
  }
}

// Run if executed directly (not when imported by tests)
if (import.meta.main) {
  main()
}
