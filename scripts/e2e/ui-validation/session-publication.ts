import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { requestMortiseUiHost } from '../../mortise-ui/client.ts'
import { restartMortiseUiRun, startMortiseUiRun, stopMortiseUiRun } from '../../mortise-ui/controller.ts'
import type { MortiseUiRunManifest } from '../../mortise-ui/protocol.ts'

interface Node { ref: string; role: string; name: string; semanticId?: string; actions: string[]; state?: { disabled?: boolean; readonly?: boolean; busy?: boolean } }
interface Snapshot { revision: number; regions: Record<string, Node[]> }

const workspaceId = 'publication-workspace'
const existingSessionId = 'existing-publication-session'
const draftComposerScope = `draft:${workspaceId}:default`
const fixedAnswer = 'Deterministic first assistant answer.'
const existingInitialUser = 'Existing canonical user turn.'
const existingInitialAssistant = 'Existing canonical assistant answer.'
const existingRetryText = 'Preserve this exact ordinary Session payload across rejection and retry.'
const existingRetryAnswer = 'Deterministic accepted retry answer.'
const settlementText = 'Accept this turn once and recover only its pending settlement.'
const settlementAnswer = 'Deterministic accepted settlement answer.'
const fixtureSpec = {
  version: 1 as const,
  active: { workspaceId, sessionId: null },
  workspaces: [{
    id: workspaceId,
    name: 'Publication Acceptance',
    sessions: [{
      id: existingSessionId,
      name: 'Existing publication acceptance Session',
      messages: [
        { role: 'user' as const, content: existingInitialUser },
        { role: 'assistant' as const, content: existingInitialAssistant },
      ],
    }],
  }],
}
const runs: MortiseUiRunManifest[] = []
const evidence: string[] = []
let current: MortiseUiRunManifest | undefined

try {
  current = await startMortiseUiRun({
    surface: 'electron', profileMode: 'fixture', waitMs: 600_000,
    fixtureSpec,
    ...(process.env.MORTISE_UI_SKIP_BUILD === '1' ? { extraEnv: { MORTISE_UI_SKIP_BUILD: '1' } } : {}),
  })
  runs.push(current)
  const baselineFiles = jsonlFiles(current.profileDir)
  const baselineSidebar = await sidebarIds(current)

  await ok(current, 'session-validation.arm', { workspaceId, mode: 'fail-before-assistant', message: 'Expected first-turn failure' })
  await submitDraft(current, 'This turn must fail before assistant output.')
  await ok(current, 'ui.wait', { predicate: { kind: 'rpc-idle' }, stableForMs: 250, timeoutMs: 60_000 })
  await ok(current, 'ui.wait', { predicate: { kind: 'render-idle' }, stableForMs: 250, timeoutMs: 60_000 })
  await assertDraftSurface(current)
  assertSameSet(jsonlFiles(current.profileDir), baselineFiles, 'failed first turn created canonical JSONL')
  assertSameSet(await sidebarIds(current), baselineSidebar, 'failed first turn created a sidebar Session')
  evidence.push((await ok<{ bundleDir: string }>(current, 'evidence.capture', { label: 'first-turn-failed' })).bundleDir)

  current = await restartMortiseUiRun(current.runDir, { waitMs: 600_000 }); runs.push(current)
  assertSameSet(jsonlFiles(current.profileDir), baselineFiles, 'failed first turn appeared after restart')
  assertSameSet(await sidebarIds(current), baselineSidebar, 'failed sidebar Session appeared after restart')
  evidence.push((await ok<{ bundleDir: string }>(current, 'evidence.capture', { label: 'first-turn-failed-restart' })).bundleDir)

  await ok(current, 'session-validation.arm', { workspaceId, mode: 'fail-publication-metadata', answer: fixedAnswer })
  await submitDraft(current, 'Fail this assistant-backed publication at metadata durability.')
  await ok(current, 'ui.wait', { predicate: { kind: 'rpc-idle' }, stableForMs: 250, timeoutMs: 60_000 })
  await ok(current, 'ui.wait', { predicate: { kind: 'render-idle' }, stableForMs: 250, timeoutMs: 60_000 })
  await assertDraftSurface(current)
  await assertPublicationRetry(current)
  assertSameSet(jsonlFiles(current.profileDir), baselineFiles, 'durability failure retained canonical JSONL')
  assertSameSet(await sidebarIds(current), baselineSidebar, 'durability failure created a sidebar Session')
  assertRejectedWithoutFalseSuccess(current)
  evidence.push((await ok<{ bundleDir: string }>(current, 'evidence.capture', { label: 'publication-durability-failed' })).bundleDir)

  await ok(current, 'session-validation.arm', { workspaceId, mode: 'succeed', answer: fixedAnswer })
  await actBySemanticId(current, 'workspace.empty-conversation.publication-failed.retry', 'click')
  await waitForSidebarSessionCount(current, 2)
  const createdFiles = jsonlFiles(current.profileDir).filter(path => !baselineFiles.includes(path))
  if (createdFiles.length !== 1) throw new Error(`Expected exactly one new canonical JSONL, found ${createdFiles.length}.`)
  const roles = readRoles(createdFiles[0]!)
  if (!roles.includes('user') || !roles.includes('assistant') || !readFileSync(createdFiles[0]!, 'utf8').includes(fixedAnswer)) throw new Error('Published JSONL is not assistant-backed.')
  const successfulSidebar = await sidebarIds(current)
  if (successfulSidebar.filter(id => !baselineSidebar.includes(id)).length !== 1) throw new Error('Expected exactly one published sidebar Session.')
  evidence.push((await ok<{ bundleDir: string }>(current, 'evidence.capture', { label: 'first-turn-succeeded' })).bundleDir)

  current = await restartMortiseUiRun(current.runDir, { waitMs: 600_000 }); runs.push(current)
  await waitForSidebarSessionCount(current, 2)
  assertSameSet(jsonlFiles(current.profileDir), [...baselineFiles, ...createdFiles], 'published JSONL changed after restart')
  assertSameSet(await sidebarIds(current), successfulSidebar, 'published sidebar Session changed after restart')
  evidence.push((await ok<{ bundleDir: string }>(current, 'evidence.capture', { label: 'first-turn-succeeded-restart' })).bundleDir)

  const existingFile = findSessionJsonl(current.profileDir, existingSessionId)
  const beforeExistingRetry = readCanonicalMessages(existingFile)
  await ok(current, 'session-validation.arm', {
    workspaceId,
    sessionId: existingSessionId,
    mode: 'fail-user-persistence-once',
    answer: existingRetryAnswer,
    message: 'Expected canonical user persistence rejection',
  })
  // Arm before navigation: opening the Session creates its backend, and the
  // validation lease must be claimed at that creation boundary.
  await actBySemanticId(current, `navigation.session_${workspaceId}_${existingSessionId}`, 'click')
  await ok(current, 'ui.wait', { predicate: { kind: 'state', scope: 'session', entityId: existingSessionId, phase: 'ready' }, timeoutMs: 60_000 })
  await submitExisting(current, existingRetryText)
  await assertExistingSubmissionFailure(current, existingRetryText)
  assertCanonicalMessages(existingFile, beforeExistingRetry, 'rejected ordinary send changed canonical JSONL')
  const rejectedAttemptId = assertExistingRejectedWithoutFalseSuccess(current)
  evidence.push((await ok<{ bundleDir: string }>(current, 'evidence.capture', { label: 'existing-send-rejected' })).bundleDir)

  await actBySemanticId(current, `composer.${existingSessionId}.submission-failed.retry`, 'click')
  await settle(current)
  assertExistingRetryAccepted(current, rejectedAttemptId)
  assertOneAcceptedRetry(existingFile, beforeExistingRetry)
  evidence.push((await ok<{ bundleDir: string }>(current, 'evidence.capture', { label: 'existing-send-retry-accepted' })).bundleDir)

  current = await restartMortiseUiRun(current.runDir, { waitMs: 600_000 }); runs.push(current)
  assertOneAcceptedRetry(findSessionJsonl(current.profileDir, existingSessionId), beforeExistingRetry)
  evidence.push((await ok<{ bundleDir: string }>(current, 'evidence.capture', { label: 'existing-send-retry-restart' })).bundleDir)

  await stopMortiseUiRun(current.runDir)
  current = await startMortiseUiRun({
    surface: 'electron', profileMode: 'fixture', waitMs: 600_000, fixtureSpec,
    ...(process.env.MORTISE_UI_SKIP_BUILD === '1' ? { extraEnv: { MORTISE_UI_SKIP_BUILD: '1' } } : {}),
  })
  runs.push(current)
  let settlementFile = findSessionJsonl(current.profileDir, existingSessionId)
  const beforeSettlement = readCanonicalMessages(settlementFile)
  await ok(current, 'session-validation.arm', {
    workspaceId,
    sessionId: existingSessionId,
    mode: 'fail-settlement-projection',
    answer: settlementAnswer,
  })
  await actBySemanticId(current, `navigation.session_${workspaceId}_${existingSessionId}`, 'click')
  await ok(current, 'ui.wait', { predicate: { kind: 'state', scope: 'session', entityId: existingSessionId, phase: 'ready' }, timeoutMs: 60_000 })
  await submitExisting(current, settlementText)
  await settle(current)
  await assertSettlementPending(current)
  assertOneSettlementTurn(settlementFile, beforeSettlement)
  assertSettlementRuntime(current)
  await assertSettlementController(current, 'settlement-blocked')
  evidence.push((await ok<{ bundleDir: string }>(current, 'evidence.capture', { label: 'settlement-failed' })).bundleDir)

  await actBySemanticId(current, `conversation.${existingSessionId}.settlement-failed.retry`, 'click')
  await settle(current)
  await assertSettlementPending(current)
  assertOneSettlementTurn(settlementFile, beforeSettlement)
  assertSettlementRuntime(current)
  await assertSettlementController(current, 'settlement-blocked')
  evidence.push((await ok<{ bundleDir: string }>(current, 'evidence.capture', { label: 'settlement-retry-still-blocked' })).bundleDir)

  await ok(current, 'session-validation.release-settlement')
  await actBySemanticId(current, `conversation.${existingSessionId}.settlement-failed.retry`, 'click')
  await ok(current, 'ui.wait', { predicate: { kind: 'state', scope: 'session', entityId: existingSessionId, phase: 'ready' }, stableForMs: 250, timeoutMs: 60_000 })
  await settle(current)
  await assertSettlementCleared(current)
  assertOneSettlementTurn(settlementFile, beforeSettlement)
  assertSettlementRuntime(current)
  await assertSettlementController(current, 'settlement-released')
  evidence.push((await ok<{ bundleDir: string }>(current, 'evidence.capture', { label: 'settlement-retry-succeeded' })).bundleDir)
  await ok(current, 'session-validation.clear')

  current = await restartMortiseUiRun(current.runDir, { waitMs: 600_000 }); runs.push(current)
  settlementFile = findSessionJsonl(current.profileDir, existingSessionId)
  assertOneSettlementTurn(settlementFile, beforeSettlement)
  await assertSettlementCleared(current)
  evidence.push((await ok<{ bundleDir: string }>(current, 'evidence.capture', { label: 'settlement-retry-restart' })).bundleDir)

  process.stdout.write(`${JSON.stringify({ ok: true, runIds: runs.map(run => run.runId), evidence, canonicalJsonl: createdFiles[0] })}\n`)
} catch (error) {
  if (current) evidence.push((await ok<{ bundleDir: string }>(current, 'evidence.capture', { label: 'session-publication-failure' }).catch(() => ({ bundleDir: '' }))).bundleDir)
  throw error
} finally {
  for (const run of [...runs].reverse()) await stopMortiseUiRun(run.runDir).catch(() => undefined)
}

async function submitDraft(run: MortiseUiRunManifest, message: string): Promise<void> {
  let snapshot = await ok<Snapshot>(run, 'ui.snapshot')
  const nodes = Object.values(snapshot.regions).flat()
  const newSession = nodes.find(node => node.semanticId === 'app.new-session')
  if (newSession) {
    await actBySemanticId(run, 'app.new-session', 'click')
    snapshot = await ok<Snapshot>(run, 'ui.snapshot')
  }
  const draftNodes = Object.values(snapshot.regions).flat()
  if (!draftNodes.some(node => node.semanticId === 'workspace.empty-conversation')) throw new Error('New Session draft surface is not visible.')
  const input = draftNodes.find(node => node.semanticId === `composer.${draftComposerScope}.input` && node.actions.includes('fill'))
  if (!input) throw new Error('New Session composer textbox is unavailable.')
  await actBySemanticId(run, `composer.${draftComposerScope}.input`, 'fill', message)
  await actBySemanticId(run, `composer.${draftComposerScope}.send`, 'click')
}

async function submitExisting(run: MortiseUiRunManifest, message: string): Promise<void> {
  await actBySemanticId(run, `composer.${existingSessionId}.input`, 'fill', message)
  await actBySemanticId(run, `composer.${existingSessionId}.send`, 'click')
}

async function settle(run: MortiseUiRunManifest): Promise<void> {
  await ok(run, 'ui.wait', { predicate: { kind: 'rpc-idle' }, stableForMs: 250, timeoutMs: 60_000 })
  await ok(run, 'ui.wait', { predicate: { kind: 'render-idle' }, stableForMs: 250, timeoutMs: 60_000 })
}

async function actBySemanticId(run: MortiseUiRunManifest, semanticId: string, action: string, value?: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const snapshot = await ok<Snapshot>(run, 'ui.snapshot')
    const node = Object.values(snapshot.regions).flat().find(candidate => (
      candidate.semanticId === semanticId && candidate.actions.includes(action)
    ))
    if (!node) throw new Error(`Semantic action target is unavailable: ${semanticId} (${action}).`)
    try {
      await ok(run, 'ui.action', {
        revision: snapshot.revision,
        target: { ref: node.ref },
        action,
        mode: 'physical',
        ...(value === undefined ? {} : { value }),
      })
      return
    } catch (error) {
      if (!String(error).includes('STALE_REF') || attempt === 2) throw error
    }
  }
}

async function sidebarIds(run: MortiseUiRunManifest): Promise<string[]> {
  const snapshot = await ok<Snapshot>(run, 'ui.snapshot')
  return Object.values(snapshot.regions).flat().flatMap(node => (
    node.semanticId?.startsWith('navigation.session_') && !node.semanticId.endsWith('.menu')
      ? [node.semanticId]
      : []
  )).sort()
}

async function waitForSidebarSessionCount(run: MortiseUiRunManifest, expected: number): Promise<void> {
  const deadline = Date.now() + 60_000
  let actual: string[] = []
  while (Date.now() < deadline) {
    actual = await sidebarIds(run)
    if (actual.length === expected) return
    await Bun.sleep(100)
  }
  throw new Error(`Expected ${expected} sidebar Sessions, found ${JSON.stringify(actual)}.`)
}

async function assertDraftSurface(run: MortiseUiRunManifest): Promise<void> {
  const snapshot = await ok<Snapshot>(run, 'ui.snapshot')
  if (!Object.values(snapshot.regions).flat().some(node => node.semanticId === 'workspace.empty-conversation')) {
    throw new Error('Failed first turn did not return to the workspace draft surface.')
  }
}

async function assertPublicationRetry(run: MortiseUiRunManifest): Promise<void> {
  const snapshot = await ok<Snapshot>(run, 'ui.snapshot')
  const nodes = Object.values(snapshot.regions).flat()
  if (!nodes.some(node => node.semanticId === 'workspace.empty-conversation.publication-failed')) {
    throw new Error('Publication durability failure did not expose a persistent terminal state.')
  }
  const retry = nodes.find(node => node.semanticId === 'workspace.empty-conversation.publication-failed.retry')
  if (!retry?.actions.includes('click')) throw new Error('Retryable publication failure did not expose its retry action.')
}

function assertRejectedWithoutFalseSuccess(run: MortiseUiRunManifest): void {
  const path = join(run.profileDir, 'mortise-config', 'logs', 'runtime.log')
  if (!existsSync(path)) throw new Error('Publication durability failure did not produce runtime.log evidence.')
  const entries = readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as {
    scope?: string
    event?: string
    data?: { error?: { code?: string; data?: { outcome?: string; terminal?: boolean; retryable?: boolean } } }
  })
  const rejected = entries.filter(entry => entry.scope === 'session' && entry.event === 'first_turn.rejected')
  if (!rejected.some(entry => (
    entry.data?.error?.code === 'SESSION_PUBLICATION_DURABILITY_FAILED'
    && entry.data.error.data?.outcome === 'unpublished'
    && entry.data.error.data.terminal === true
    && entry.data.error.data.retryable === true
  ))) throw new Error('runtime.log did not retain the typed publication durability rejection.')
  if (entries.some(entry => entry.scope === 'session' && entry.event === 'first_turn.published')) {
    throw new Error('Failed publication produced a false first_turn.published receipt.')
  }
  if (entries.some(entry => entry.scope === 'session' && entry.event === 'send_message.accepted')) {
    throw new Error('Failed publication produced a false send_message.accepted receipt.')
  }
}

async function assertExistingSubmissionFailure(run: MortiseUiRunManifest, expectedText: string): Promise<void> {
  const failureSemanticId = `composer.${existingSessionId}.submission-failed`
  await ok(run, 'ui.wait', {
    predicate: { kind: 'node', target: { semanticId: failureSemanticId } },
    timeoutMs: 60_000,
  })
  await waitForComposerFingerprint(run, `composer.${existingSessionId}.input`, expectedText)
  const snapshot = await ok<Snapshot>(run, 'ui.snapshot')
  const nodes = Object.values(snapshot.regions).flat()
  const input = nodes.find(node => node.semanticId === `composer.${existingSessionId}.input`)
  if (input?.value !== '[REDACTED]') throw new Error('Composer semantic value did not preserve its sensitive-value redaction boundary.')
  const failure = nodes.find(node => node.semanticId === failureSemanticId)
  if (!failure || !failure.name.includes('could not be saved')) {
    throw new Error('Rejected ordinary send did not expose a persistent semantic failure.')
  }
  const retry = nodes.find(node => node.semanticId === `composer.${existingSessionId}.submission-failed.retry`)
  if (!retry?.actions.includes('click')) throw new Error('Rejected ordinary send did not expose a physical retry action.')
}

async function waitForComposerFingerprint(
  run: MortiseUiRunManifest,
  semanticId: string,
  expectedText: string,
): Promise<void> {
  const expectedHash = createHash('sha256').update(expectedText).digest('hex')
  const deadline = Date.now() + 60_000
  let fingerprint: { length: number; sha256: string } | undefined
  while (Date.now() < deadline) {
    fingerprint = await ok<{ length: number; sha256: string }>(run, 'ui.valueFingerprint', { semanticId })
    if (fingerprint.length === expectedText.length && fingerprint.sha256 === expectedHash) return
    await Bun.sleep(50)
  }
  throw new Error(`Rejected ordinary send did not restore the exact composer payload fingerprint: ${JSON.stringify(fingerprint)}.`)
}

interface RuntimeEntry {
  scope?: string
  event?: string
  data?: {
    sessionId?: string
    messageId?: string
    optimisticMessageId?: string
    error?: { code?: string; data?: { messageId?: string; outcome?: string; terminal?: boolean; retryable?: boolean } }
  }
}

interface SessionValidationStatusResponse {
  status?: {
    phase: string
    diagnostics: { chatAttempts: number }
    settlement?: { blockerCreated: boolean }
  }
}

async function assertSettlementPending(run: MortiseUiRunManifest): Promise<void> {
  const snapshot = await ok<Snapshot>(run, 'ui.snapshot')
  const nodes = Object.values(snapshot.regions).flat()
  const failure = nodes.find(node => node.semanticId === `conversation.${existingSessionId}.settlement-failed`)
  const retry = nodes.find(node => node.semanticId === `conversation.${existingSessionId}.settlement-failed.retry`)
  const input = nodes.find(node => node.semanticId === `composer.${existingSessionId}.input`)
  const send = nodes.find(node => node.semanticId === `composer.${existingSessionId}.send`)
  const stop = nodes.find(node => node.semanticId === `composer.${existingSessionId}.stop`)
  if (!failure || !retry?.actions.includes('click')) throw new Error('Pending settlement did not expose its persistent retry banner.')
  if (input?.state?.disabled !== true || input.actions.length !== 0) throw new Error('Pending settlement did not disable the composer input.')
  if (send?.state?.disabled !== true) throw new Error('Pending settlement did not disable the send action.')
  if (stop) throw new Error('Pending settlement incorrectly exposed Stop instead of settlement retry.')
}

async function assertSettlementCleared(run: MortiseUiRunManifest): Promise<void> {
  const snapshot = await ok<Snapshot>(run, 'ui.snapshot')
  const nodes = Object.values(snapshot.regions).flat()
  if (nodes.some(node => node.semanticId === `conversation.${existingSessionId}.settlement-failed`)) {
    throw new Error('Successful settlement retry left the failure banner visible.')
  }
  const input = nodes.find(node => node.semanticId === `composer.${existingSessionId}.input`)
  if (input && input.state?.disabled === true) throw new Error('Successful settlement retry left the composer disabled.')
}

async function assertSettlementController(run: MortiseUiRunManifest, phase: string): Promise<void> {
  const result = await ok<SessionValidationStatusResponse>(run, 'session-validation.status')
  if (result.status?.phase !== phase || result.status.diagnostics.chatAttempts !== 1) {
    throw new Error(`Settlement retry re-entered chat or lost its fault state: ${JSON.stringify(result.status)}.`)
  }
  if (phase === 'settlement-blocked' && result.status.settlement?.blockerCreated !== true) {
    throw new Error('Settlement validation blocker is not active.')
  }
}

function assertSettlementRuntime(run: MortiseUiRunManifest): void {
  const entries = runtimeEntries(run)
  const accepted = entries.filter(entry => entry.scope === 'session' && entry.event === 'send_message.accepted' && entry.data?.sessionId === existingSessionId)
  const postAccept = entries.filter(entry => entry.scope === 'session' && entry.event === 'send_message.post_accept_error' && entry.data?.sessionId === existingSessionId)
  const rejected = entries.filter(entry => entry.scope === 'session' && entry.event === 'send_message.rejected' && entry.data?.sessionId === existingSessionId)
  if (accepted.length !== 1) throw new Error(`Settlement flow accepted the message ${accepted.length} times.`)
  if (postAccept.length !== 1 || postAccept[0]?.data?.error?.code !== 'SESSION_SETTLEMENT_FAILED') {
    throw new Error('Settlement flow did not retain one typed post-accept failure.')
  }
  if (rejected.length !== 0) throw new Error('Accepted settlement failure was misclassified as an ordinary send rejection.')
}

function runtimeEntries(run: MortiseUiRunManifest): RuntimeEntry[] {
  const path = join(run.profileDir, 'mortise-config', 'logs', 'runtime.log')
  if (!existsSync(path)) throw new Error('Ordinary send failure did not produce runtime.log evidence.')
  return readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as RuntimeEntry)
}

function assertExistingRejectedWithoutFalseSuccess(run: MortiseUiRunManifest): string {
  const entries = runtimeEntries(run)
  const rejected = entries.filter(entry => (
    entry.scope === 'session'
    && entry.event === 'send_message.rejected'
    && entry.data?.sessionId === existingSessionId
  ))
  const receipt = rejected.find(entry => (
    entry.data?.error?.code === 'SESSION_PERSISTENCE_FAILED'
    && entry.data.error.data?.outcome === 'unaccepted'
    && entry.data.error.data.terminal === true
    && entry.data.error.data.retryable === true
    && typeof entry.data.error.data.messageId === 'string'
  ))
  if (!receipt?.data?.error?.data?.messageId) throw new Error('runtime.log did not retain the typed ordinary send rejection.')
  if (entries.some(entry => (
    entry.scope === 'session'
    && entry.event === 'send_message.accepted'
    && entry.data?.sessionId === existingSessionId
  ))) throw new Error('Rejected ordinary send produced a false send_message.accepted receipt.')
  return receipt.data.error.data.messageId
}

function assertExistingRetryAccepted(run: MortiseUiRunManifest, attemptId: string): void {
  const entries = runtimeEntries(run)
  const accepted = entries.find(entry => (
    entry.scope === 'session'
    && entry.event === 'send_message.accepted'
    && entry.data?.sessionId === existingSessionId
    && entry.data.messageId === attemptId
    && entry.data.optimisticMessageId === attemptId
  ))
  if (!accepted) throw new Error('Retry did not reuse the rejected attempt identity in its accepted receipt.')
  const rejectedIndex = entries.findIndex(entry => (
    entry.scope === 'session'
    && entry.event === 'send_message.rejected'
    && entry.data?.sessionId === existingSessionId
    && entry.data.error?.data?.messageId === attemptId
  ))
  const acceptedIndex = entries.indexOf(accepted)
  if (rejectedIndex < 0 || acceptedIndex <= rejectedIndex) throw new Error('runtime.log does not show rejection followed by acceptance for the same attempt.')
}

function jsonlFiles(root: string): string[] {
  const result: string[] = []
  const walk = (dir: string) => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.jsonl')) result.push(path)
    }
  }
  walk(join(root, 'mortise-config', 'agent', 'sessions'))
  return result.sort()
}

function readRoles(path: string): string[] {
  return readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).flatMap(line => {
    const entry = JSON.parse(line) as { type?: string; message?: { role?: string } }
    return entry.type === 'message' && entry.message?.role ? [entry.message.role] : []
  })
}

interface CanonicalMessage { role: string; text: string }

function readCanonicalMessages(path: string): CanonicalMessage[] {
  return readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).flatMap(line => {
    const entry = JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown } }
    if (entry.type !== 'message' || !entry.message?.role) return []
    const content = entry.message.content
    const text = typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.flatMap(part => part && typeof part === 'object' && (part as { type?: string }).type === 'text'
          ? [String((part as { text?: unknown }).text ?? '')]
          : []).join('')
        : ''
    return [{ role: entry.message.role, text }]
  })
}

function assertCanonicalMessages(path: string, expected: CanonicalMessage[], message: string): void {
  if (JSON.stringify(readCanonicalMessages(path)) !== JSON.stringify(expected)) throw new Error(message)
}

function assertOneAcceptedRetry(path: string, baseline: CanonicalMessage[]): void {
  const messages = readCanonicalMessages(path)
  const appended = messages.slice(baseline.length)
  if (JSON.stringify(messages.slice(0, baseline.length)) !== JSON.stringify(baseline)) {
    throw new Error('Ordinary send retry changed the pre-existing canonical history.')
  }
  if (JSON.stringify(appended) !== JSON.stringify([
    { role: 'user', text: existingRetryText },
    { role: 'assistant', text: existingRetryAnswer },
  ])) throw new Error(`Expected one canonical retry turn, found ${JSON.stringify(appended)}.`)
}

function assertOneSettlementTurn(path: string, baseline: CanonicalMessage[]): void {
  const messages = readCanonicalMessages(path)
  if (JSON.stringify(messages.slice(0, baseline.length)) !== JSON.stringify(baseline)) {
    throw new Error('Settlement recovery changed the pre-existing canonical history.')
  }
  const appended = messages.slice(baseline.length)
  if (JSON.stringify(appended) !== JSON.stringify([
    { role: 'user', text: settlementText },
    { role: 'assistant', text: settlementAnswer },
  ])) throw new Error(`Settlement recovery did not preserve exactly one accepted turn: ${JSON.stringify(appended)}.`)
}

function findSessionJsonl(root: string, sessionId: string): string {
  const matches = jsonlFiles(root).filter(path => {
    const header = readFileSync(path, 'utf8').split(/\r?\n/, 1)[0]
    if (!header) return false
    const parsed = JSON.parse(header) as { id?: string; mortise?: { id?: string } }
    return parsed.id === sessionId || parsed.mortise?.id === sessionId
  })
  if (matches.length !== 1) throw new Error(`Expected one canonical JSONL for ${sessionId}, found ${matches.length}.`)
  return matches[0]!
}

function assertSameSet(actual: string[], expected: string[], message: string): void {
  if (JSON.stringify([...actual].sort()) !== JSON.stringify([...expected].sort())) throw new Error(message)
}

async function ok<T>(run: MortiseUiRunManifest, command: string, params: Record<string, unknown> = {}): Promise<T> {
  let response: Awaited<ReturnType<typeof requestMortiseUiHost<T>>>
  try {
    response = await requestMortiseUiHost<T>({ ...run, command, params, timeoutMs: 60_000 })
  } catch (error) {
    const predicate = command === 'ui.wait' && params.predicate
      ? ` ${JSON.stringify(params.predicate)}`
      : ''
    throw new Error(`${command}${predicate}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  if (!response.ok) throw new Error(`${command}: ${response.error.code}: ${response.error.message}`)
  return response.result
}
