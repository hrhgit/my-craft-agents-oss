#!/usr/bin/env bun
import { randomUUID } from 'node:crypto'
import {
  UI_VALIDATION_DEFAULT_TIMEOUT_MS,
  UI_VALIDATION_EXTENDED_TIMEOUT_MS,
  UI_VALIDATION_MAX_WAIT_MS,
  UiValidationError,
  type UiValidationErrorCode,
  type UiValidationResponseEnvelope,
} from '@mortise/shared/ui-validation'
import { MortiseUiStartError, DEFAULT_MORTISE_UI_RUN_ROOT, DEFAULT_MORTISE_UI_START_WAIT_MS, getMortiseUiRunStatus, readRunManifest, recordMortiseUiStartFailure, resolveRunDir, startMortiseUiRun, stopMortiseUiRunDetailed, updateRunManifest } from './controller.ts'
import { MortiseUiClientError, requestMortiseUiHost } from './client.ts'
import { MORTISE_UI_PROTOCOL_VERSION, type MortiseUiProfileMode, type MortiseUiRunManifest, type MortiseUiSurface, type MortiseUiWindowMode } from './protocol.ts'
import { redactValue } from './redaction.ts'
import { collectLocalEvidence, registerReturnedArtifacts } from './evidence.ts'
import { MORTISE_UI_FIXTURE_SCHEMA, loadMortiseUiFixtureSpec } from './fixture.ts'

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

function has(args: string[], name: string): boolean { return args.includes(name) }

function options(args: string[], name: string): string[] {
  const values: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== name) continue
    const value = args[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`)
    values.push(value)
  }
  return values
}

function output(value: unknown): void { process.stdout.write(`${JSON.stringify(value)}\n`) }

function help(): void {
  process.stdout.write(`mortise-ui - deterministic Mortise UI validation controller\n\nUsage:\n  mortise-ui fixture schema [--json]\n  mortise-ui start [--label <semantic-label>] [--surface electron|webui] [--adapter-command-json '["bun","..."]'] [--profile fixture|isolated|clone]\n                 [--window-mode foreground|background] [--fixture <fixture.json>] [--extension <directory>]...\n                 [--scenario <id>] [--scenario-params <json>] [--wait-ms <1..600000>] [--no-wait]\n                 [--source-mortise-profile <path> --source-pi-profile <path>] [--json]\n  mortise-ui status [--run <id-or-label>] [--run-root <path>] [--json]\n  mortise-ui capabilities list [--kind route|scenario|action] [--run <id-or-label>] [--json]\n  mortise-ui capabilities describe --kind route|scenario|action --id <id> [--run <id-or-label>] [--json]\n  mortise-ui open|snapshot|action|wait|assert [--params <json>] [--run <id-or-label>] [--json]\n  mortise-ui scenario apply [--id <id>] [--params <json>] [--run <id-or-label>] [--json]\n  mortise-ui scenario reset [--params <json>] [--run <id-or-label>] [--json]\n  mortise-ui clock advance --ms <milliseconds> [--run <id-or-label>] [--json]\n  mortise-ui fault set|clear|status [--params <json>] [--run <id-or-label>] [--json]\n  mortise-ui evidence [--params <json>] [--run <id-or-label>] [--json]\n  mortise-ui request <command> [--params <json>] [--run <id-or-label>] [--json]\n  mortise-ui stop [--run <id-or-label>] [--json]\n\nAll commands emit one V1 JSON response envelope; --json is accepted for explicit caller intent. Host requests accept --timeout-ms <1..600000>.\n\nUse a short --label to give AI-operated runs a stable semantic reference; the immutable run ID remains the protocol identity and exact fallback. Electron uses the bundled Developer Host when launched from a Developer Kit, and otherwise uses the source-development adapter. WebUI remains a source-development surface. The default fixture profile opens the disposable test workspace; pass --fixture to build bounded real workspace, file, session, and history data. Repeat --extension to mount Manifest V1 extension packages from development directories into the disposable Pi profile without copying their source. Electron runs in background mode by default; pass --window-mode foreground only for validation that requires a visible native window, menu, or system dialog. --no-wait returns after the adapter process is accepted without contacting the host. Isolated is the empty onboarding profile; clone copies explicitly selected user configuration. Other adapters receive MORTISE_UI_* environment variables and must write the versioned endpoint manifest.\n`)
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
  const runRoot = option(args, '--run-root') ?? DEFAULT_MORTISE_UI_RUN_ROOT
  const localRequestId = randomUUID()
  let activeManifest: MortiseUiRunManifest | undefined
  try {
    if (command === 'fixture') {
      if ((args[1] ?? 'schema') !== 'schema') throw new Error('fixture requires schema')
      output(localUnassignedSuccess(localRequestId, { schema: MORTISE_UI_FIXTURE_SCHEMA }))
      return 0
    }
    if (command === 'start') {
      const labels = options(args, '--label')
      if (labels.length > 1) throw new Error('--label may be provided only once')
      const label = labels[0]
      const requestedSurface = option(args, '--surface') ?? 'electron'
      const surface = (requestedSurface === 'web' ? 'webui' : requestedSurface) as MortiseUiSurface
      const profileMode = (option(args, '--profile') ?? 'fixture') as MortiseUiProfileMode
      const windowMode = (option(args, '--window-mode') ?? (surface === 'electron' ? 'background' : 'foreground')) as MortiseUiWindowMode
      if (!['electron', 'webui'].includes(surface)) throw new Error('--surface must be electron or webui')
      if (!['fixture', 'isolated', 'clone'].includes(profileMode)) throw new Error('--profile must be fixture, isolated, or clone')
      if (!['foreground', 'background'].includes(windowMode)) throw new Error('--window-mode must be foreground or background')
      if (surface !== 'electron' && windowMode === 'background') throw new Error('--window-mode background requires --surface electron')
      const fixturePath = option(args, '--fixture')
      if (fixturePath && profileMode !== 'fixture') throw new Error('--fixture requires --profile fixture')
      const fixtureSpec = fixturePath ? loadMortiseUiFixtureSpec(fixturePath) : undefined
      const rawAdapter = option(args, '--adapter-command-json')
      const adapterCommand = rawAdapter ? JSON.parse(rawAdapter) : undefined
      if (adapterCommand !== undefined && (!Array.isArray(adapterCommand) || adapterCommand.some(part => typeof part !== 'string'))) throw new Error('--adapter-command-json must be a JSON string array')
      const waitMs = Number(option(args, '--wait-ms') ?? DEFAULT_MORTISE_UI_START_WAIT_MS)
      if (!Number.isSafeInteger(waitMs) || waitMs < 1 || waitMs > UI_VALIDATION_MAX_WAIT_MS) throw new Error(`--wait-ms must be between 1 and ${UI_VALIDATION_MAX_WAIT_MS}`)
      const scenarioId = option(args, '--scenario')
      const scenario = scenarioId
        ? { ...jsonOption(args, '--scenario-params'), name: scenarioId }
        : undefined
      let manifest = await startMortiseUiRun({
        surface, label, profileMode, windowMode, adapterCommand, runRoot,
        sourceMortiseConfigDir: option(args, '--source-mortise-profile'),
        sourcePiAgentDir: option(args, '--source-pi-profile'),
        extensionPaths: options(args, '--extension'),
        waitForReady: !has(args, '--no-wait'),
        waitMs,
        scenario,
        fixtureSpec,
      })
      activeManifest = manifest
      if (has(args, '--no-wait')) {
        output(localSuccess(localRequestId, manifest, {
          manifest,
          accepted: true,
          ready: false,
          next: `mortise-ui status --run ${runReference(manifest)}`,
        }))
        return 0
      }
      let response: Awaited<ReturnType<typeof requestMortiseUiHost>>
      try {
        response = await requestMortiseUiHost({
          ...manifest,
          command: 'app.status',
          timeoutMs: UI_VALIDATION_DEFAULT_TIMEOUT_MS,
          minimumSeqExclusive: manifest.lastResponseSeq,
        })
      } catch (error) {
        const message = `Mortise UI became ready but final status failed: ${error instanceof Error ? error.message : String(error)}`
        const failed = await recordMortiseUiStartFailure(manifest.runDir, 'app-readiness', message)
        throw new MortiseUiStartError(message, failed)
      }
      if (!response.ok) {
        const message = `Mortise UI final status failed: ${response.error.code}: ${response.error.message}`
        const failed = await recordMortiseUiStartFailure(manifest.runDir, 'app-readiness', message)
        throw new MortiseUiStartError(message, failed)
      }
      manifest = updateRunManifest(manifest.runDir, {
        lastResponseSeq: response.seq,
        lastRevision: response.revision,
        verificationLevel: response.verificationLevel,
      })
      activeManifest = manifest
      output(withResult(response, { manifest, host: response.result }))
      return 0
    }
    if (command === 'status') {
      const runDir = resolveRunDir(runRoot, option(args, '--run'))
      activeManifest = readRunManifest(runDir)
      const status = await getMortiseUiRunStatus(runDir)
      const manifest = status.manifest as MortiseUiRunManifest
      const host = status.host
      output(isResponseEnvelope(host)
        ? withResult(host, { manifest, processAlive: status.processAlive, host: host.ok ? host.result : undefined })
        : localSuccess(localRequestId, manifest, { manifest, processAlive: status.processAlive, host }))
      return 0
    }
    if (command === 'stop') {
      const runDir = resolveRunDir(runRoot, option(args, '--run'))
      activeManifest = readRunManifest(runDir)
      const stopped = await stopMortiseUiRunDetailed(runDir)
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
        ? { label: 'mortise-ui-evidence', include: ['screenshot', 'semantic-snapshot', 'events', 'console', 'page-errors', 'network-summary', 'driver-info', 'runtime-log', 'state-manifest'], redact: true }
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
      const runDir = resolveRunDir(runRoot, option(args, '--run'))
      const manifest = (await import('./controller.ts')).readRunManifest(runDir)
      activeManifest = manifest
      if (command === 'evidence' && (manifest.status === 'failed' || manifest.status === 'stopped')) {
        const artifactManifest = collectLocalEvidence(manifest)
        output(localSuccess(localRequestId, manifest, {
          manifest,
          artifactManifest,
          hostAvailable: false,
        }))
        return 0
      }
      const requestTimeoutMs = Number(option(args, '--timeout-ms') ?? params.timeoutMs ?? UI_VALIDATION_EXTENDED_TIMEOUT_MS)
      if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0 || requestTimeoutMs > UI_VALIDATION_MAX_WAIT_MS) throw new Error(`--timeout-ms must be between 1 and ${UI_VALIDATION_MAX_WAIT_MS}`)
      const response = await requestMortiseUiHost({ ...manifest, command: hostCommand, params, timeoutMs: requestTimeoutMs, minimumSeqExclusive: manifest.lastResponseSeq })
      updateRunManifest(runDir, {
        lastResponseSeq: response.seq,
        lastRevision: response.revision,
        verificationLevel: response.verificationLevel,
      })
      registerReturnedArtifacts(manifest, response.ok ? response.result : undefined)
      output(command === 'evidence' ? { ...response, artifactManifest: collectLocalEvidence(manifest) } : response)
      return response.ok ? 0 : 2
    }
    throw new Error(`Unknown command: ${command}`)
  } catch (error) {
    const manifest = error instanceof MortiseUiStartError
      ? error.manifest
      : activeManifest ?? tryReadManifest(runRoot, option(args, '--run'))
    const code = cliErrorCode(error)
    const diagnostics = manifest?.failure
    output({
      v: MORTISE_UI_PROTOCOL_VERSION,
      kind: 'response',
      id: localRequestId,
      requestId: localRequestId,
      runId: manifest?.runId ?? option(args, '--run') ?? 'unassigned',
      seq: manifest?.lastResponseSeq ?? 0,
      revision: manifest?.lastRevision ?? 0,
      verificationLevel: manifest?.verificationLevel ?? 'scenario-verified',
      ok: false,
      error: redactValue({
        code,
        message: error instanceof Error ? error.message : String(error),
        ...(diagnostics ? {
          details: {
            diagnostics,
            nextCommands: [
              `mortise-ui status --run ${runReference(manifest)}`,
              `mortise-ui evidence --run ${runReference(manifest)}`,
              `mortise-ui stop --run ${runReference(manifest)}`,
            ],
          },
        } : {}),
      }),
    } satisfies UiValidationResponseEnvelope)
    return 1
  }
}

function withResult(response: UiValidationResponseEnvelope, result: Record<string, unknown>): UiValidationResponseEnvelope {
  return response.ok ? { ...response, result } : response
}

function localSuccess(requestId: string, manifest: MortiseUiRunManifest, result: Record<string, unknown>): UiValidationResponseEnvelope {
  return {
    v: MORTISE_UI_PROTOCOL_VERSION,
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

function localUnassignedSuccess(requestId: string, result: Record<string, unknown>): UiValidationResponseEnvelope {
  return {
    v: MORTISE_UI_PROTOCOL_VERSION,
    kind: 'response',
    id: requestId,
    requestId,
    runId: 'unassigned',
    seq: 0,
    revision: 0,
    verificationLevel: 'scenario-verified',
    ok: true,
    result,
  }
}

function isResponseEnvelope(value: unknown): value is UiValidationResponseEnvelope {
  return !!value && typeof value === 'object' && (value as { kind?: unknown }).kind === 'response'
}

function tryReadManifest(runRoot: string, runId?: string): MortiseUiRunManifest | undefined {
  if (!runId) return undefined
  try { return readRunManifest(resolveRunDir(runRoot, runId)) } catch { return undefined }
}

function runReference(manifest: MortiseUiRunManifest): string {
  return manifest.label ?? manifest.runId
}

function cliErrorCode(error: unknown): UiValidationErrorCode {
  if (error instanceof UiValidationError) return error.code
  if (error instanceof MortiseUiClientError) {
    if (['HOST_UNREACHABLE', 'ENDPOINT_NOT_READY'].includes(error.code)) return 'DRIVER_DISCONNECTED'
    if (error.code === 'PROTOCOL_MISMATCH') return 'UNSUPPORTED_VERSION'
  }
  return error instanceof SyntaxError || (error instanceof Error && /must|require(?:d|s)?|unknown|not found|escapes|provide --run|no active|ambiguous|may be provided/i.test(error.message))
    ? 'INVALID_REQUEST'
    : 'INTERNAL_ERROR'
}

if (import.meta.main) process.exit(await main())
