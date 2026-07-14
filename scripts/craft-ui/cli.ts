#!/usr/bin/env bun
import { randomUUID } from 'node:crypto'
import { UiValidationError, type UiValidationErrorCode, type UiValidationResponseEnvelope } from '@craft-agent/shared/ui-validation'
import { DEFAULT_CRAFT_UI_RUN_ROOT, getCraftUiRunStatus, readRunManifest, resolveRunDir, startCraftUiRun, stopCraftUiRunDetailed, updateRunManifest } from './controller.ts'
import { CraftUiClientError, requestCraftUiHost } from './client.ts'
import { CRAFT_UI_PROTOCOL_VERSION, type CraftUiProfileMode, type CraftUiRunManifest, type CraftUiSurface } from './protocol.ts'
import { redactValue } from './redaction.ts'
import { collectLocalEvidence, registerReturnedArtifacts } from './evidence.ts'

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

function has(args: string[], name: string): boolean { return args.includes(name) }

function output(value: unknown): void { process.stdout.write(`${JSON.stringify(value)}\n`) }

function help(): void {
  process.stdout.write(`craft-ui - deterministic Craft UI validation controller\n\nUsage:\n  craft-ui start [--surface electron|webui] [--adapter-command-json '["bun","..."]'] [--profile isolated|clone]\n                 [--scenario <id>] [--scenario-params <json>]\n                 [--source-craft-profile <path> --source-pi-profile <path>] [--json]\n  craft-ui status [--run <id>] [--run-root <path>] [--json]\n  craft-ui capabilities list [--kind route|scenario|action] [--run <id>] [--json]\n  craft-ui capabilities describe --kind route|scenario|action --id <id> [--run <id>] [--json]\n  craft-ui open|snapshot|action|wait|assert [--params <json>] [--run <id>] [--json]\n  craft-ui scenario apply [--id <id>] [--params <json>] [--run <id>] [--json]\n  craft-ui scenario reset [--params <json>] [--run <id>] [--json]\n  craft-ui clock advance --ms <milliseconds> [--run <id>] [--json]\n  craft-ui fault set|clear|status [--params <json>] [--run <id>] [--json]\n  craft-ui evidence [--params <json>] [--run <id>] [--json]\n  craft-ui request <command> [--params <json>] [--run <id>] [--json]\n  craft-ui stop [--run <id>] [--json]\n\nAll commands emit one V1 JSON response envelope; --json is accepted for explicit caller intent. Host requests accept --timeout-ms <1..300000>.\n\nElectron and WebUI use source-development adapters by default. Other adapters receive CRAFT_UI_* environment variables and must write the versioned endpoint manifest.\n`)
}

function jsonOption(args: string[], name: string, fallback: Record<string, unknown> = {}): Record<string, unknown> {
  const parsed = JSON.parse(option(args, name) ?? JSON.stringify(fallback))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${name} must be a JSON object`)
  return parsed as Record<string, unknown>
}

export async function main(argv = process.argv): Promise<number> {
  const args = argv.slice(2)
  const command = args[0] ?? 'help'
  if (command === 'help' || command === '--help' || command === '-h') { help(); return 0 }
  const runRoot = option(args, '--run-root') ?? DEFAULT_CRAFT_UI_RUN_ROOT
  const localRequestId = randomUUID()
  try {
    if (command === 'start') {
      const requestedSurface = option(args, '--surface') ?? 'electron'
      const surface = (requestedSurface === 'web' ? 'webui' : requestedSurface) as CraftUiSurface
      const profileMode = (option(args, '--profile') ?? 'isolated') as CraftUiProfileMode
      if (!['electron', 'webui'].includes(surface)) throw new Error('--surface must be electron or webui')
      if (!['isolated', 'clone'].includes(profileMode)) throw new Error('--profile must be isolated or clone')
      const rawAdapter = option(args, '--adapter-command-json')
      const adapterCommand = rawAdapter ? JSON.parse(rawAdapter) : undefined
      if (adapterCommand !== undefined && (!Array.isArray(adapterCommand) || adapterCommand.some(part => typeof part !== 'string'))) throw new Error('--adapter-command-json must be a JSON string array')
      const scenarioId = option(args, '--scenario')
      const scenario = scenarioId
        ? { ...jsonOption(args, '--scenario-params'), name: scenarioId }
        : undefined
      let manifest = await startCraftUiRun({
        surface, profileMode, adapterCommand, runRoot,
        sourceCraftConfigDir: option(args, '--source-craft-profile'),
        sourcePiAgentDir: option(args, '--source-pi-profile'),
        waitForReady: !has(args, '--no-wait'),
        waitMs: Number(option(args, '--wait-ms') ?? 30_000),
        scenario,
      })
      const response = await requestCraftUiHost({
        ...manifest,
        command: 'app.status',
        timeoutMs: 10_000,
        minimumSeqExclusive: manifest.lastResponseSeq,
      })
      manifest = updateRunManifest(manifest.runDir, {
        lastResponseSeq: response.seq,
        lastRevision: response.revision,
        verificationLevel: response.verificationLevel,
      })
      output(withResult(response, { manifest, host: response.ok ? response.result : undefined }))
      return 0
    }
    const runDir = resolveRunDir(runRoot, option(args, '--run'))
    if (command === 'status') {
      const status = await getCraftUiRunStatus(runDir)
      const manifest = status.manifest as CraftUiRunManifest
      const host = status.host
      output(isResponseEnvelope(host)
        ? withResult(host, { manifest, processAlive: status.processAlive, host: host.ok ? host.result : undefined })
        : localSuccess(localRequestId, manifest, { manifest, processAlive: status.processAlive, host }))
      return 0
    }
    if (command === 'stop') {
      const stopped = await stopCraftUiRunDetailed(runDir)
      output(stopped.response
        ? withResult(stopped.response, { manifest: stopped.manifest, host: stopped.response.ok ? stopped.response.result : undefined })
        : localSuccess(localRequestId, stopped.manifest, { manifest: stopped.manifest }))
      return stopped.manifest.status === 'stopped' ? 0 : 2
    }
    const directCommands = new Set(['capabilities', 'open', 'scenario', 'snapshot', 'action', 'wait', 'assert', 'evidence', 'clock', 'fault'])
    if (command === 'request' || directCommands.has(command)) {
      const scenarioOperation = command === 'scenario' ? args[1] : undefined
      if (command === 'scenario' && !['apply', 'reset'].includes(String(scenarioOperation))) {
        throw new Error('scenario requires apply or reset')
      }
      const clockOperation = command === 'clock' ? args[1] : undefined
      if (command === 'clock' && clockOperation !== 'advance') throw new Error('clock requires advance')
      const faultOperation = command === 'fault' ? args[1] : undefined
      if (command === 'fault' && !['set', 'clear', 'status'].includes(String(faultOperation))) throw new Error('fault requires set, clear, or status')
      const capabilitiesOperation = command === 'capabilities' ? (args[1] ?? 'list') : undefined
      if (command === 'capabilities' && !['list', 'describe'].includes(String(capabilitiesOperation))) throw new Error('capabilities requires list or describe')
      const methodMap: Record<string, string> = {
        capabilities: 'ui.capabilities', open: 'app.open', scenario: scenarioOperation === 'reset' ? 'scenario.reset' : 'scenario.apply', snapshot: 'ui.snapshot', action: 'ui.action',
        wait: 'ui.wait', assert: 'ui.assert', evidence: 'evidence.capture', clock: 'clock.advance', fault: `fault.${faultOperation}`,
      }
      const hostCommand = command === 'request' ? args[1] : methodMap[command]
      if (!hostCommand || hostCommand.startsWith('--')) throw new Error('request requires a command')
      const defaultParams = command === 'evidence'
        ? { label: 'craft-ui-evidence', include: ['screenshot', 'semantic-snapshot', 'events', 'console', 'page-errors', 'network-summary', 'driver-info', 'runtime-log', 'state-manifest'], redact: true }
        : {}
      const params = jsonOption(args, '--params', defaultParams)
      if (command === 'capabilities') {
        params.operation = capabilitiesOperation
        const kind = option(args, '--kind')
        const id = option(args, '--id')
        if (kind !== undefined) params.kind = kind
        if (id !== undefined) params.id = id
        if (capabilitiesOperation === 'describe' && (kind === undefined || id === undefined)) throw new Error('capabilities describe requires --kind and --id')
      }
      if (command === 'scenario' && scenarioOperation === 'apply') {
        const id = option(args, '--id')
        if (id && params.name === undefined && params.id === undefined) params.name = id
      }
      if (command === 'clock' && params.ms === undefined) {
        const ms = option(args, '--ms')
        if (ms === undefined || !Number.isFinite(Number(ms))) throw new Error('clock advance requires --ms or params.ms')
        params.ms = Number(ms)
      }
      const manifest = (await import('./controller.ts')).readRunManifest(runDir)
      const requestTimeoutMs = Number(option(args, '--timeout-ms') ?? params.timeoutMs ?? 30_000)
      if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0 || requestTimeoutMs > 300_000) throw new Error('--timeout-ms must be between 1 and 300000')
      const response = await requestCraftUiHost({ ...manifest, command: hostCommand, params, timeoutMs: requestTimeoutMs, minimumSeqExclusive: manifest.lastResponseSeq })
      updateRunManifest(runDir, { lastResponseSeq: response.seq })
      registerReturnedArtifacts(manifest, response.ok ? response.result : undefined)
      output(command === 'evidence' ? { ...response, artifactManifest: collectLocalEvidence(manifest) } : response)
      return response.ok ? 0 : 2
    }
    throw new Error(`Unknown command: ${command}`)
  } catch (error) {
    const manifest = tryReadManifest(runRoot, option(args, '--run'))
    const code = cliErrorCode(error)
    output({
      v: CRAFT_UI_PROTOCOL_VERSION,
      kind: 'response',
      id: localRequestId,
      requestId: localRequestId,
      runId: manifest?.runId ?? option(args, '--run') ?? 'unassigned',
      seq: manifest?.lastResponseSeq ?? 0,
      revision: manifest?.lastRevision ?? 0,
      verificationLevel: manifest?.verificationLevel ?? 'scenario-verified',
      ok: false,
      error: redactValue({ code, message: error instanceof Error ? error.message : String(error) }),
    } satisfies UiValidationResponseEnvelope)
    return 1
  }
}

function withResult(response: UiValidationResponseEnvelope, result: Record<string, unknown>): UiValidationResponseEnvelope {
  return response.ok ? { ...response, result } : response
}

function localSuccess(requestId: string, manifest: CraftUiRunManifest, result: Record<string, unknown>): UiValidationResponseEnvelope {
  return {
    v: CRAFT_UI_PROTOCOL_VERSION,
    kind: 'response',
    id: requestId,
    requestId,
    runId: manifest.runId,
    seq: manifest.lastResponseSeq ?? 0,
    revision: manifest.lastRevision ?? 0,
    verificationLevel: manifest.verificationLevel ?? 'scenario-verified',
    ok: true,
    result,
  }
}

function isResponseEnvelope(value: unknown): value is UiValidationResponseEnvelope {
  return !!value && typeof value === 'object' && (value as { kind?: unknown }).kind === 'response'
}

function tryReadManifest(runRoot: string, runId?: string): CraftUiRunManifest | undefined {
  if (!runId) return undefined
  try { return readRunManifest(resolveRunDir(runRoot, runId)) } catch { return undefined }
}

function cliErrorCode(error: unknown): UiValidationErrorCode {
  if (error instanceof UiValidationError) return error.code
  if (error instanceof CraftUiClientError) {
    if (['HOST_UNREACHABLE', 'ENDPOINT_NOT_READY'].includes(error.code)) return 'DRIVER_DISCONNECTED'
    if (error.code === 'PROTOCOL_MISMATCH') return 'UNSUPPORTED_VERSION'
  }
  return error instanceof SyntaxError || (error instanceof Error && /must|require(?:d|s)?|unknown|not found|escapes/i.test(error.message))
    ? 'INVALID_REQUEST'
    : 'INTERNAL_ERROR'
}

if (import.meta.main) process.exit(await main())
