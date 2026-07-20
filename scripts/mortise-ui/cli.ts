#!/usr/bin/env bun
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  UI_VALIDATION_DEFAULT_TIMEOUT_MS,
  UI_VALIDATION_EXTENDED_TIMEOUT_MS,
  UI_VALIDATION_MAX_WAIT_MS,
  UiValidationError,
  type UiValidationErrorCode,
  type UiValidationErrorPayload,
  type UiValidationResponseEnvelope,
} from '@mortise/shared/ui-validation'
import { MortiseUiStartError, DEFAULT_MORTISE_UI_RUN_ROOT, DEFAULT_MORTISE_UI_START_WAIT_MS, appendRunHistory, getMortiseUiRunStatus, isMortiseUiRunProcessAlive, listMortiseUiRuns, pruneMortiseUiRuns, readRunManifest, recordMortiseUiStartFailure, resolveRunDir, startMortiseUiRun, stopMortiseUiRunDetailed, updateRunManifest } from './controller.ts'
import { MortiseUiClientError, requestMortiseUiHost } from './client.ts'
import { MORTISE_UI_PROTOCOL_VERSION, type MortiseUiArtifactManifest, type MortiseUiProfileMode, type MortiseUiRunManifest, type MortiseUiSurface, type MortiseUiWindowMode } from './protocol.ts'
import { redactValue } from './redaction.ts'
import { collectLocalEvidence, registerReturnedArtifacts } from './evidence.ts'
import { MORTISE_UI_FIXTURE_SCHEMA, loadMortiseUiFixtureSpec } from './fixture.ts'
import { readArtifactManifest } from './artifacts.ts'
import { createActionObservation, createRunBriefing, createSnapshotBriefing, historyEntry, selectRelevantCapabilities } from './ai-assistant.ts'

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  if (index === -1) return undefined
  const value = args[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`)
  return value
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
  process.stdout.write('AI workflow additions:\n  mortise-ui capabilities relevant [--run <id-or-label>] [--json]\n  Default responses disclose only information needed for the current decision and point to exact detail commands. Pass --full-observation for raw semantic state, --full-evidence for complete evidence manifests, or use runs inspect for lifecycle internals.\n\n')
  process.stdout.write(`mortise-ui - AI-facing Mortise UI validation assistant\n\nUsage:\n  mortise-ui fixture schema [--json]\n  mortise-ui start [--label <semantic-label>] [--surface electron|webui] [--adapter-command-json '["bun","..."]'] [--profile fixture|isolated|clone]\n                 [--window-mode foreground|background] [--fixture <fixture.json>] [--extension <directory>]...\n                 [--scenario <id>] [--scenario-params <json>] [--wait-ms <1..600000>] [--no-wait] [--full]\n                 [--source-mortise-profile <path> --source-pi-profile <path>] [--json]\n  mortise-ui runs list [--limit <count> | --all] [--run-root <path>] [--json]\n  mortise-ui runs inspect|resume|history --run <id-or-label> [--run-root <path>] [--json]\n  mortise-ui runs prune [--older-than-hours <hours>] [--keep <count>] [--apply] [--run-root <path>] [--json]\n  mortise-ui resume [--run <id-or-label>] [--run-root <path>] [--json]\n  mortise-ui status [--run <id-or-label>] [--run-root <path>] [--full] [--json]\n  mortise-ui capabilities list [--kind route|scenario|action] [--run <id-or-label>] [--json]\n  mortise-ui capabilities describe --kind route|scenario|action --id <id> [--run <id-or-label>] [--json]\n  mortise-ui open|snapshot|action|wait|assert|windows|screenshot|logs|resize|native|window|browser-key\n                 [--params <json> | --params-file <path>] [--run <id-or-label>] [--json]\n  mortise-ui scenario apply|reset [--id <id>] [--params <json>] [--run <id-or-label>] [--json]\n  mortise-ui clock advance --ms <milliseconds> [--run <id-or-label>] [--json]\n  mortise-ui fault set|clear|status [--params <json>] [--run <id-or-label>] [--json]\n  mortise-ui evidence [--params <json>] [--run <id-or-label>] [--json]\n  mortise-ui request <command> [--params <json>] [--run <id-or-label>] [--json]\n  mortise-ui stop [--run <id-or-label>] [--full] [--json]\n\nSnapshot and action commands include an AI briefing, immediately actionable targets, and contextual next actions. Action automatically observes the settled UI. Runs retain a bounded activity history so another AI context can resume the workflow. All commands emit one V1 JSON response envelope. Host requests accept --timeout-ms <1..600000>.\n`)
}

function jsonOption(args: string[], name: string, fallback: Record<string, unknown> = {}): Record<string, unknown> {
  const inline = option(args, name)
  const file = option(args, '--params-file')
  if (inline !== undefined && file !== undefined) throw new Error(`${name} and --params-file are mutually exclusive`)
  const parsed = JSON.parse(file ? readFileSync(resolve(file), 'utf8') : inline ?? JSON.stringify(fallback))
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
    if (command === 'runs' || command === 'resume') {
      const operation = command === 'resume' ? 'resume' : (args[1] ?? 'list')
      if (!['list', 'inspect', 'resume', 'history', 'prune'].includes(operation)) throw new Error('runs requires list, inspect, resume, history, or prune')
      if (operation === 'list') {
        const allRuns = listMortiseUiRuns(runRoot).map(manifest => {
          const processAlive = isMortiseUiRunProcessAlive(manifest)
          const evidence = readRunEvidenceForBriefing(manifest)
          return { manifest, processAlive, briefing: createRunBriefing({ manifest, processAlive, ...evidence }) }
        })
        const requestedLimit = numericOption(args, '--limit')
        if (requestedLimit !== undefined && (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1)) throw new Error('--limit must be a positive integer')
        if (has(args, '--all') && requestedLimit !== undefined) throw new Error('--all and --limit are mutually exclusive')
        const selectedRuns = has(args, '--all')
          ? allRuns
          : requestedLimit !== undefined
            ? prioritizeRuns(allRuns).slice(0, requestedLimit)
            : selectDecisionRelevantRuns(allRuns, 8)
        const runs = selectedRuns.map(run => run.briefing)
        const omitted = Math.max(0, allRuns.length - runs.length)
        output(localUnassignedSuccess(localRequestId, {
          runRoot: resolve(runRoot),
          summary: allRuns.length === 0
            ? 'No Mortise UI validation runs exist.'
            : `${runs.length} decision-relevant validation run${runs.length === 1 ? '' : 's'} shown from ${allRuns.length} total.`,
          runs,
          disclosure: {
            shown: runs.length,
            total: allRuns.length,
            omitted,
            selection: 'Live, failed, incompletely cleaned, and then most recent runs are shown first.',
            ...(omitted > 0 ? { details: { command: 'runs list', argv: ['--all'], purpose: 'Inspect older inactive runs.' } } : {}),
          },
          nextActions: runs.length === 0
            ? [{ label: 'Start a fixture run', reason: 'No resumable validation context exists.', command: 'start', argv: ['--label', 'ui-check', '--surface', 'electron', '--profile', 'fixture'] }]
            : [],
        }))
        return 0
      }
      if (operation === 'prune') {
        const result = pruneMortiseUiRuns({
          runRoot,
          olderThanHours: numericOption(args, '--older-than-hours'),
          keep: numericOption(args, '--keep'),
          apply: has(args, '--apply'),
        })
        output(localUnassignedSuccess(localRequestId, {
          ...result,
          summary: result.applied
            ? `Removed ${result.removedRunIds.length} inactive validation run${result.removedRunIds.length === 1 ? '' : 's'}.`
            : `${result.candidateRunIds.length} inactive validation run${result.candidateRunIds.length === 1 ? '' : 's'} would be removed; pass --apply after reviewing the candidates.`,
        }))
        return 0
      }
      const runDir = resolveRunDir(runRoot, option(args, '--run'))
      activeManifest = readRunManifest(runDir)
      if (operation === 'history') {
        output(localSuccess(localRequestId, activeManifest, {
          manifest: activeManifest,
          history: activeManifest.history ?? [],
          summary: `${activeManifest.history?.length ?? 0} recent activities are retained for this run.`,
          nextActions: [{ label: 'Resume from the current UI', reason: 'Inspect live state and combine it with this activity history.', command: 'runs resume', argv: runArgs(runRoot, activeManifest) }],
        }))
        return 0
      }
      const status = await getMortiseUiRunStatus(runDir)
      const manifest = status.manifest as MortiseUiRunManifest
      const evidence = readRunEvidenceForBriefing(manifest)
      const briefing = createRunBriefing({ manifest, processAlive: status.processAlive as boolean, host: status.host, ...evidence })
      if (operation === 'inspect') {
        output(localSuccess(localRequestId, manifest, {
          manifest,
          host: status.host,
          briefing: createRunBriefing(
            { manifest, processAlive: status.processAlive as boolean, host: status.host, ...evidence },
            { includeRecentActivity: true, recentActivityLimit: 8 },
          ),
          history: manifest.history ?? [],
          artifactManifest: evidence.artifacts,
          artifactError: evidence.artifactError,
        }))
      } else {
        const history = manifest.history ?? []
        output(localSuccess(localRequestId, manifest, {
          briefing,
          resume: {
            recentActivity: history.slice(-5),
            evidence: { artifactCount: evidence.artifacts?.artifacts.length ?? 0, manifestPath: join(manifest.artifactsDir, 'manifest.json') },
            exactRunArgs: runArgs(runRoot, manifest),
          },
          disclosure: {
            omitted: ['raw host status', 'run manifest internals', `${Math.max(0, history.length - 5)} older history entries`, 'artifact path list'],
            reason: 'These details are not required to choose the next validation action.',
            details: [
              { command: 'runs inspect', argv: runArgs(runRoot, manifest), purpose: 'Inspect host and manifest internals.' },
              { command: 'runs history', argv: runArgs(runRoot, manifest), purpose: 'Read the complete retained activity history.' },
              { command: 'evidence', argv: runArgs(runRoot, manifest), purpose: 'Inspect retained evidence by category.' },
            ],
          },
        }))
      }
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
        const nextActions = recoveryActions(runRoot, manifest, ['status', 'runs resume', 'stop'])
        output(localSuccess(localRequestId, manifest, {
          run: compactRunIdentity(manifest),
          accepted: true,
          ready: false,
          briefing: createRunBriefing({ manifest, processAlive: true }),
          nextActions,
          disclosure: lifecycleDisclosure(runRoot, manifest),
          ...(has(args, '--full') ? { manifest } : {}),
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
      appendRunHistory(manifest.runDir, historyEntry('start', response))
      const currentManifest = readRunManifest(manifest.runDir)
      output(withResult(response, {
        run: compactRunIdentity(currentManifest),
        briefing: createRunBriefing({ manifest: currentManifest, processAlive: true, host: response }),
        disclosure: lifecycleDisclosure(runRoot, currentManifest),
        ...(has(args, '--full') ? { manifest: currentManifest, host: response.result } : {}),
      }))
      return 0
    }
    if (command === 'status') {
      const runDir = resolveRunDir(runRoot, option(args, '--run'))
      activeManifest = readRunManifest(runDir)
      const status = await getMortiseUiRunStatus(runDir)
      const manifest = status.manifest as MortiseUiRunManifest
      const host = status.host
      const evidence = readRunEvidenceForBriefing(manifest)
      appendRunHistory(runDir, {
        at: new Date().toISOString(), command: 'status', outcome: 'succeeded', revision: manifest.lastRevision, seq: manifest.lastResponseSeq,
        summary: status.processAlive ? 'Run status inspected while its process was alive.' : 'Run status inspected without a live process.',
      })
      const currentManifest = readRunManifest(runDir)
      output(localSuccess(localRequestId, currentManifest, {
        processAlive: status.processAlive,
        healthy: isResponseEnvelope(host) ? host.ok : status.processAlive,
        briefing: createRunBriefing({ manifest: currentManifest, processAlive: status.processAlive as boolean, host, ...evidence }),
        disclosure: lifecycleDisclosure(runRoot, currentManifest),
        ...(has(args, '--full') ? { manifest: currentManifest, host } : {}),
      }))
      return 0
    }
    if (command === 'stop') {
      const runDir = resolveRunDir(runRoot, option(args, '--run'))
      activeManifest = readRunManifest(runDir)
      const stopped = await stopMortiseUiRunDetailed(runDir)
      appendRunHistory(runDir, {
        at: new Date().toISOString(), command: 'stop', outcome: stopped.manifest.status === 'stopped' ? 'succeeded' : 'failed',
        revision: stopped.manifest.lastRevision, seq: stopped.manifest.lastResponseSeq,
        summary: stopped.manifest.status === 'stopped' ? 'Run stopped and its disposable profile was removed.' : stopped.manifest.error,
      })
      const manifest = readRunManifest(runDir)
      if (manifest.status !== 'stopped') {
        output(localFailure(localRequestId, manifest, 'INTERNAL_ERROR', manifest.error ?? 'Mortise UI did not stop cleanly.', {
          manifest,
          hostShutdown: stopped.response,
          nextActions: recoveryActions(runRoot, manifest, ['status', 'evidence', 'stop']),
        }))
        return 2
      }
      output(localSuccess(localRequestId, manifest, {
        cleanup: { profileRemoved: Boolean(manifest.profileCleanedAt), cleanupError: manifest.cleanupError },
        briefing: createRunBriefing({ manifest, processAlive: false, ...readRunEvidenceForBriefing(manifest) }),
        disclosure: lifecycleDisclosure(runRoot, manifest),
        ...(has(args, '--full') ? { manifest, hostShutdown: stopped.response } : {}),
      }))
      return 0
    }
    const directCommands = new Set(['capabilities', 'open', 'scenario', 'snapshot', 'action', 'wait', 'assert', 'evidence', 'clock', 'fault', 'windows', 'screenshot', 'logs', 'resize', 'native', 'window', 'browser-key'])
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
      if (command === 'capabilities' && !['list', 'relevant', 'describe'].includes(String(capabilitiesOperation))) throw new Error('capabilities requires list, relevant, or describe')
      const methodMap: Record<string, string> = {
        capabilities: 'ui.capabilities', open: 'app.open', scenario: scenarioOperation === 'reset' ? 'scenario.reset' : 'scenario.apply', snapshot: 'ui.snapshot', action: 'ui.action',
        wait: 'ui.wait', assert: 'ui.assert', evidence: 'evidence.capture', clock: 'clock.advance', fault: `fault.${faultOperation}`,
        windows: 'ui.windows', screenshot: 'ui.screenshot', logs: 'ui.logs', resize: 'ui.resize', native: 'ui.native', window: 'ui.window', 'browser-key': 'ui.browserKey',
      }
      const hostCommand = command === 'request' ? args[1] : methodMap[command]
      if (!hostCommand || hostCommand.startsWith('--')) throw new Error('request requires a command')
      const defaultParams = command === 'evidence'
        ? { label: 'mortise-ui-evidence', include: ['screenshot', 'semantic-snapshot', 'events', 'console', 'page-errors', 'network-summary', 'driver-info', 'runtime-log', 'state-manifest'], redact: true }
        : {}
      const params = jsonOption(args, '--params', defaultParams)
      if (command === 'capabilities') {
        params.operation = capabilitiesOperation === 'relevant' ? 'list' : capabilitiesOperation
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
        appendRunHistory(runDir, { at: new Date().toISOString(), command: 'evidence', outcome: 'succeeded', summary: `Collected ${artifactManifest.artifacts.length} retained artifacts offline.` })
        output(localSuccess(localRequestId, manifest, {
          manifest: readRunManifest(runDir),
          hostAvailable: false,
          evidence: { artifactManifestPath: join(manifest.artifactsDir, 'manifest.json') },
          briefing: evidenceBriefing(artifactManifest),
          ...(has(args, '--full-evidence') ? { artifactManifest } : {}),
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
      registerReturnedArtifacts(manifest, response.ok ? response.result : response.error.details)
      let outputResponse: UiValidationResponseEnvelope = response
      if (response.ok && command === 'snapshot') {
        const includeFullObservation = has(args, '--full-observation')
        outputResponse = { ...response, result: {
          briefing: createSnapshotBriefing(response.result, { expanded: includeFullObservation }),
          ...(includeFullObservation ? { snapshot: response.result } : {}),
          ...(!includeFullObservation ? { disclosure: {
            omitted: ['raw semantic regions', 'embedded surface node lists', 'snapshot artifacts'],
            reason: 'The briefing contains the state and targets needed to choose the next action.',
            details: { command: 'snapshot', argv: ['--full-observation'], purpose: 'Inspect raw semantic nodes or diagnose a missing target.' },
          } } : {}),
        } }
      }
      if (response.ok && command === 'capabilities' && capabilitiesOperation === 'relevant') {
        const observation = await requestMortiseUiHost({
          ...readRunManifest(runDir), command: 'ui.snapshot', params: {}, timeoutMs: requestTimeoutMs, minimumSeqExclusive: response.seq,
        })
        updateRunManifest(runDir, { lastResponseSeq: observation.seq, lastRevision: observation.revision, verificationLevel: observation.verificationLevel })
        const briefing = observation.ok ? createSnapshotBriefing(observation.result) : undefined
        outputResponse = observation.ok
          ? { ...response, seq: observation.seq, revision: observation.revision, result: { capabilities: selectRelevantCapabilities(response.result, briefing!), briefing } }
          : { ...response, result: { capabilities: response.result, observationError: observation.error } }
      }
      if (response.ok && command === 'action') {
        const observation = await requestMortiseUiHost({
          ...readRunManifest(runDir),
          command: 'ui.snapshot',
          params: {},
          timeoutMs: requestTimeoutMs,
          minimumSeqExclusive: response.seq,
        })
        updateRunManifest(runDir, { lastResponseSeq: observation.seq, lastRevision: observation.revision, verificationLevel: observation.verificationLevel })
        if (observation.ok) {
          registerReturnedArtifacts(readRunManifest(runDir), observation.result)
          outputResponse = {
            ...response,
            seq: observation.seq,
            revision: observation.revision,
            verificationLevel: maxVerificationLevel(response.verificationLevel, observation.verificationLevel),
            result: createActionObservation(response.result, observation.result, has(args, '--full-observation')),
          }
        } else {
          outputResponse = { ...response, result: { action: response.result, observationError: observation.error } }
        }
      }
      appendRunHistory(runDir, historyEntry(command, outputResponse))
      if (command === 'evidence' && response.ok) {
        const artifactManifest = collectLocalEvidence(readRunManifest(runDir))
        const hostEvidence = response.result && typeof response.result === 'object' && !Array.isArray(response.result)
          ? response.result as Record<string, unknown>
          : {}
        outputResponse = { ...response, result: {
          evidence: {
            bundleDir: hostEvidence.bundleDir,
            revision: hostEvidence.revision,
            seqRange: hostEvidence.seqRange,
            artifactManifestPath: join(manifest.artifactsDir, 'manifest.json'),
          },
          briefing: evidenceBriefing(artifactManifest),
          ...(has(args, '--full-evidence') ? { host: response.result, artifactManifest } : {}),
        } }
      }
      output(outputResponse)
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
            nextActions: recoveryActions(runRoot, manifest, ['status', 'evidence', 'stop']),
          },
        } : {}),
      }) as UiValidationErrorPayload,
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

function localFailure(
  requestId: string,
  manifest: MortiseUiRunManifest,
  code: UiValidationErrorCode,
  message: string,
  details?: Record<string, unknown>,
): UiValidationResponseEnvelope {
  return {
    v: MORTISE_UI_PROTOCOL_VERSION,
    kind: 'response',
    id: requestId,
    requestId,
    runId: manifest.runId,
    seq: manifest.lastResponseSeq ?? 0,
    revision: manifest.lastRevision ?? 0,
    verificationLevel: manifest.verificationLevel ?? 'scenario-verified',
    ok: false,
    error: { code, message, ...(details ? { details } : {}) },
  }
}

function isResponseEnvelope(value: unknown): value is UiValidationResponseEnvelope {
  return !!value && typeof value === 'object' && (value as { kind?: unknown }).kind === 'response'
}

function tryReadManifest(runRoot: string, runId?: string): MortiseUiRunManifest | undefined {
  if (!runId) return undefined
  try { return readRunManifest(resolveRunDir(runRoot, runId)) } catch { return undefined }
}

function readRunEvidenceForBriefing(manifest: MortiseUiRunManifest): {
  artifacts?: MortiseUiArtifactManifest
  artifactError?: string
} {
  try {
    return { artifacts: readArtifactManifest(join(manifest.artifactsDir, 'manifest.json'), manifest.runId) }
  } catch (error) {
    return { artifactError: error instanceof Error ? error.message : String(error) }
  }
}

function numericOption(args: string[], name: string): number | undefined {
  const value = option(args, name)
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative number`)
  return parsed
}

function runArgs(runRoot: string, manifest: MortiseUiRunManifest): string[] {
  return ['--run', manifest.runId, '--run-root', resolve(runRoot)]
}

function recoveryActions(runRoot: string, manifest: MortiseUiRunManifest, commands: string[]): Array<Record<string, unknown>> {
  return commands.map(command => ({
    label: command === 'runs resume' ? 'Resume this validation run' : `${command[0]!.toUpperCase()}${command.slice(1)} this run`,
    reason: command === 'evidence'
      ? 'Retained artifacts can explain the current state without a live host.'
      : command === 'stop'
        ? 'Stop and clean the disposable profile when the run is no longer needed.'
        : 'Continue with the exact immutable run identity.',
    command,
    argv: runArgs(runRoot, manifest),
  }))
}

function evidenceBriefing(manifest: MortiseUiArtifactManifest): Record<string, unknown> {
  const counts = Object.fromEntries(['screenshot', 'snapshot', 'log', 'trace', 'other'].map(kind => [
    kind,
    manifest.artifacts.filter(artifact => artifact.kind === kind).length,
  ]))
  const highlights = representativeArtifacts(manifest)
  const omitted = Math.max(0, manifest.artifacts.length - highlights.length)
  return {
    summary: `${manifest.artifacts.length} validation artifacts are available.`,
    counts,
    attention: manifest.artifacts.length === 0 ? ['No evidence artifact has been recorded yet.'] : [],
    highlights,
    disclosure: {
      shown: highlights.length,
      total: manifest.artifacts.length,
      omitted,
      selection: 'The newest representative artifact from each evidence category is shown.',
      ...(omitted > 0 ? { details: { command: 'evidence', argv: ['--full-evidence'], purpose: 'Inspect every retained artifact and the complete host evidence response.' } } : {}),
    },
  }
}

function representativeArtifacts(manifest: MortiseUiArtifactManifest): Array<Record<string, unknown>> {
  const selected = new Map<string, MortiseUiArtifactManifest['artifacts'][number]>()
  for (const artifact of [...manifest.artifacts].sort((left, right) => right.createdAt.localeCompare(left.createdAt))) {
    if (!selected.has(artifact.kind)) selected.set(artifact.kind, artifact)
  }
  return [...selected.values()].map(artifact => ({
    kind: artifact.kind,
    description: artifact.description,
    path: artifact.path,
    createdAt: artifact.createdAt,
  }))
}

function selectDecisionRelevantRuns<T extends { manifest: MortiseUiRunManifest; processAlive: boolean }>(runs: T[], recentLimit: number): T[] {
  const prioritized = prioritizeRuns(runs)
  const needsAttention = prioritized.filter(run => runNeedsAttention(run))
  const attentionIds = new Set(needsAttention.map(run => run.manifest.runId))
  const recent = prioritized.filter(run => !attentionIds.has(run.manifest.runId)).slice(0, Math.max(0, recentLimit - needsAttention.length))
  return [...needsAttention, ...recent]
}

function prioritizeRuns<T extends { manifest: MortiseUiRunManifest; processAlive: boolean }>(runs: T[]): T[] {
  return [...runs].sort((left, right) => Number(runNeedsAttention(right)) - Number(runNeedsAttention(left)))
}

function runNeedsAttention(run: { manifest: MortiseUiRunManifest; processAlive: boolean }): boolean {
  const { manifest, processAlive } = run
  return processAlive || manifest.status === 'failed' || Boolean(manifest.cleanupError) || manifest.status === 'starting' || manifest.status === 'stopping'
}

function compactRunIdentity(manifest: MortiseUiRunManifest): Record<string, unknown> {
  return {
    runId: manifest.runId,
    label: manifest.label,
    surface: manifest.surface,
    status: manifest.status,
    windowMode: manifest.windowMode,
    profileMode: manifest.profileMode,
  }
}

function lifecycleDisclosure(runRoot: string, manifest: MortiseUiRunManifest): Record<string, unknown> {
  return {
    omitted: ['run manifest internals', 'raw host response'],
    reason: 'Lifecycle internals are useful for diagnosis, not for the normal validation decision.',
    details: { command: 'runs inspect', argv: runArgs(runRoot, manifest), purpose: 'Inspect the complete run manifest, host status, history, and evidence manifest.' },
  }
}

function maxVerificationLevel<T extends 'scenario-verified' | 'renderer-verified' | 'native-verified'>(first: T, second: T): T {
  const order = { 'scenario-verified': 0, 'renderer-verified': 1, 'native-verified': 2 } as const
  return order[first] >= order[second] ? first : second
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
