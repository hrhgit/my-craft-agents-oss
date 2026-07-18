import { readFile } from 'fs/promises'
import { join } from 'path'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { appendAutomationHistoryEntry } from '@craft-agent/shared/automations/history-store'
import { AUTOMATION_HISTORY_MAX_RUNS_PER_MATCHER } from '@craft-agent/shared/automations/constants'
import { withFileLock } from '@craft-agent/shared/storage'
import { atomicWriteFileSync } from '@craft-agent/shared/utils'
import type { RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import { getWorkspaceOrNull, getWorkspaceOrThrow, resolveWorkspaceId } from '../utils'

// History file name — matches AUTOMATIONS_HISTORY_FILE from @craft-agent/shared/automations/constants
const HISTORY_FILE = 'automations-history.jsonl'
interface HistoryEntry { id: string; ts: number; ok: boolean; sessionId?: string; prompt?: string; error?: string; webhook?: { method: string; url: string; statusCode: number; durationMs: number; attempts?: number; error?: string; responseBody?: string } }

// Per-workspace config mutex: serializes read-modify-write cycles on automations.json
// to prevent concurrent IPC calls from clobbering each other's changes.
const configMutexes = new Map<string, Promise<void>>()
function withConfigMutex<T>(workspaceRoot: string, fn: () => Promise<T>): Promise<T> {
  const prev = configMutexes.get(workspaceRoot) ?? Promise.resolve()
  const next = prev.then(fn, fn) // run fn regardless of previous result
  configMutexes.set(workspaceRoot, next.then(() => {}, () => {}))
  return next
}

// Shared helper: resolve workspace, read automations.json, validate matcher, mutate, write back
interface AutomationsConfigJson { automations?: Record<string, Record<string, unknown>[]>; [key: string]: unknown }

export interface AutomationCapabilityListItem {
  id: string
  event: string
  name?: string
  enabled: boolean
  actionTypes: string[]
}

export async function listWorkspaceAutomationsForCapability(workspaceRoot: string): Promise<AutomationCapabilityListItem[]> {
  const { resolveAutomationsConfigPath } = await import('@craft-agent/shared/automations/resolve-config-path')
  try {
    const config = JSON.parse(await readFile(resolveAutomationsConfigPath(workspaceRoot), 'utf-8')) as AutomationsConfigJson
    const result: AutomationCapabilityListItem[] = []
    for (const [event, matchers] of Object.entries(config.automations ?? {})) {
      if (!Array.isArray(matchers)) continue
      for (const matcher of matchers) {
        if (typeof matcher.id !== 'string' || !matcher.id) continue
        const actions = Array.isArray(matcher.actions) ? matcher.actions : []
        const actionTypes = [...new Set(actions.flatMap(action =>
          action && typeof action === 'object' && typeof (action as Record<string, unknown>).type === 'string'
            ? [(action as Record<string, unknown>).type as string]
            : []))]
        result.push({
          id: matcher.id,
          event,
          ...(typeof matcher.name === 'string' ? { name: matcher.name } : {}),
          enabled: matcher.enabled !== false,
          actionTypes,
        })
      }
    }
    return result
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

export async function setWorkspaceAutomationEnabledById(workspaceRoot: string, id: string, enabled: boolean): Promise<void> {
  await withConfigMutex(workspaceRoot, async () => {
    const { resolveAutomationsConfigPath } = await import('@craft-agent/shared/automations/resolve-config-path')
    const configPath = resolveAutomationsConfigPath(workspaceRoot)
    await withFileLock(configPath, async () => {
      const config = JSON.parse(await readFile(configPath, 'utf-8')) as AutomationsConfigJson
      let found = false
      for (const matchers of Object.values(config.automations ?? {})) {
        if (!Array.isArray(matchers)) continue
        const matcher = matchers.find(candidate => candidate.id === id)
        if (!matcher) continue
        if (found) throw new Error('Automation ID is not unique')
        found = true
        if (enabled) delete matcher.enabled
        else matcher.enabled = false
      }
      if (!found) throw new Error('Automation not found')
      atomicWriteFileSync(configPath, JSON.stringify(config, null, 2) + '\n')
    })
  })
}
async function withAutomationMatcher(workspaceId: string, eventName: string, matcherIndex: number, mutate: (matchers: Record<string, unknown>[], index: number, config: AutomationsConfigJson, genId: () => string) => void) {
  const workspace = getWorkspaceOrThrow(workspaceId)

  await withConfigMutex(workspace.rootPath, async () => {
    const { resolveAutomationsConfigPath, generateShortId } = await import('@craft-agent/shared/automations/resolve-config-path')
    const configPath = resolveAutomationsConfigPath(workspace.rootPath)

    await withFileLock(configPath, async () => {
      const raw = await readFile(configPath, 'utf-8')
      const config = JSON.parse(raw)

      const eventMap = config.automations ?? {}
      const matchers = eventMap[eventName]
      if (!Array.isArray(matchers) || matcherIndex < 0 || matcherIndex >= matchers.length) {
        throw new Error(`Invalid automation reference: ${eventName}[${matcherIndex}]`)
      }

      mutate(matchers, matcherIndex, config, generateShortId)

      // Backfill missing IDs on all matchers before writing
      for (const eventMatchers of Object.values(eventMap)) {
        if (!Array.isArray(eventMatchers)) continue
        for (const m of eventMatchers as Record<string, unknown>[]) {
          if (!m.id) m.id = generateShortId()
        }
      }

      atomicWriteFileSync(configPath, JSON.stringify(config, null, 2) + '\n')
    })
  })
}

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.automations.GET,
  RPC_CHANNELS.automations.TEST,
  RPC_CHANNELS.automations.SET_ENABLED,
  RPC_CHANNELS.automations.DUPLICATE,
  RPC_CHANNELS.automations.DELETE,
  RPC_CHANNELS.automations.GET_HISTORY,
  RPC_CHANNELS.automations.GET_LAST_EXECUTED,
  RPC_CHANNELS.automations.REPLAY,
] as const

export function registerAutomationsHandlers(server: RpcServer, deps: HandlerDeps): void {
  const log = deps.platform.logger

  // Get automations config for a workspace (read-only, resolves path server-side)
  server.handle(RPC_CHANNELS.automations.GET, async (ctx, workspaceId: string) => {
    const wid = resolveWorkspaceId(ctx.workspaceId, workspaceId)
    if (!wid) return null
    log.info(`AUTOMATIONS_GET: Loading automations for workspace: ${wid}`)
    const workspace = getWorkspaceOrNull(wid, log, 'AUTOMATIONS_GET')
    if (!workspace) return null
    try {
      const { resolveAutomationsConfigPath } = await import('@craft-agent/shared/automations/resolve-config-path')
      const configPath = resolveAutomationsConfigPath(workspace.rootPath)
      log.info(`AUTOMATIONS_GET: Reading config from: ${configPath}`)
      const content = await readFile(configPath, 'utf-8')
      const parsed = JSON.parse(content)
      const eventCount = parsed?.automations ? Object.keys(parsed.automations).length : 0
      log.info(`AUTOMATIONS_GET: Loaded ${eventCount} event type(s) from ${configPath}`)
      return parsed
    } catch (error) {
      if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        log.info(`AUTOMATIONS_GET: No automations.json found for workspace ${wid}`)
        return null // No automations configured yet
      }
      log.error(`AUTOMATIONS_GET: Error loading automations:`, error)
      throw error
    }
  })

  server.handle(RPC_CHANNELS.automations.TEST, async (ctx, payload: import('@craft-agent/shared/protocol').TestAutomationPayload) => {
    const wid = resolveWorkspaceId(ctx.workspaceId, payload.workspaceId)!
    payload.workspaceId = wid
    const workspace = getWorkspaceOrThrow(wid)

    const results: import('@craft-agent/shared/protocol').TestAutomationActionResult[] = []
    const { parsePromptReferences } = await import('@craft-agent/shared/automations')
    const { executeWebhookRequest, createWebhookHistoryEntry, createPromptHistoryEntry } = await import('@craft-agent/shared/automations/webhook-utils')

    for (const action of payload.actions) {
      const start = Date.now()

      if (action.type === 'webhook') {
        // Execute webhook action using shared utility (no env expansion for test — raw URLs)
        // Cast needed: protocol DTO uses loose `method?: string`, WebhookAction uses strict union
        const result = await executeWebhookRequest(action as import('@craft-agent/shared/automations').WebhookAction)
        const method = action.method ?? 'POST'

        results.push({
          ...result,
          duration: Date.now() - start,
        })

        if (payload.automationId) {
          const entry = createWebhookHistoryEntry({
            matcherId: payload.automationId,
            ok: result.success,
            method,
            url: action.url as string,
            statusCode: result.statusCode,
            durationMs: result.durationMs ?? 0,
            error: result.error,
            responseBody: result.responseBody,
          })
          try {
            await appendAutomationHistoryEntry(workspace.rootPath, entry)
          } catch (e) {
            log.warn('[Automations] Failed to write history:', e)
          }
        }
        continue
      }

      // Prompt action
      // Parse @mentions from the prompt to resolve source/skill references
      const references = parsePromptReferences(action.prompt)

      try {
        const { sessionId } = await deps.sessionManager.executePromptAutomation({
          workspaceId: payload.workspaceId,
          workspaceRootPath: workspace.rootPath,
          prompt: action.prompt,
          permissionMode: payload.permissionMode,
          mentions: references.mentions,
          provider: action.provider,
          model: action.model,
          thinkingLevel: action.thinkingLevel,
          automationName: payload.automationName,
          telegramTopic: payload.telegramTopic,
        })
        results.push({
          type: 'prompt',
          success: true,
          sessionId,
          duration: Date.now() - start,
        })

        // Write history entry for test runs
        if (payload.automationId) {
          const entry = createPromptHistoryEntry({ matcherId: payload.automationId, ok: true, sessionId, prompt: action.prompt })
          try {
            await appendAutomationHistoryEntry(workspace.rootPath, entry)
          } catch (e) {
            log.warn('[Automations] Failed to write history:', e)
          }
        }
      } catch (err: unknown) {
        results.push({
          type: 'prompt',
          success: false,
          stderr: (err as Error).message,
          duration: Date.now() - start,
        })

        // Write failed history entry
        if (payload.automationId) {
          const entry = createPromptHistoryEntry({ matcherId: payload.automationId, ok: false, error: (err as Error).message, prompt: action.prompt })
          try {
            await appendAutomationHistoryEntry(workspace.rootPath, entry)
          } catch (e) {
            log.warn('[Automations] Failed to write history:', e)
          }
        }
      }
    }

    return { actions: results } satisfies import('@craft-agent/shared/protocol').TestAutomationResult
  })

  // Automation enabled state management (toggle enabled/disabled in automations.json)
  server.handle(RPC_CHANNELS.automations.SET_ENABLED, async (ctx, workspaceId: string, eventName: string, matcherIndex: number, enabled: boolean) => {
    const wid = resolveWorkspaceId(ctx.workspaceId, workspaceId)!
    await withAutomationMatcher(wid, eventName, matcherIndex, (matchers, idx) => {
      if (enabled) {
        delete matchers[idx].enabled
      } else {
        matchers[idx].enabled = false
      }
    })
  })

  // Duplicate an automation matcher
  server.handle(RPC_CHANNELS.automations.DUPLICATE, async (ctx, workspaceId: string, eventName: string, matcherIndex: number) => {
    const wid = resolveWorkspaceId(ctx.workspaceId, workspaceId)!
    await withAutomationMatcher(wid, eventName, matcherIndex, (matchers, idx, _config, genId) => {
      const clone = JSON.parse(JSON.stringify(matchers[idx]))
      clone.id = genId()
      clone.name = clone.name ? `${clone.name} Copy` : 'Untitled Copy'
      matchers.splice(idx + 1, 0, clone)
    })
  })

  // Delete an automation matcher
  server.handle(RPC_CHANNELS.automations.DELETE, async (ctx, workspaceId: string, eventName: string, matcherIndex: number) => {
    const wid = resolveWorkspaceId(ctx.workspaceId, workspaceId)!
    await withAutomationMatcher(wid, eventName, matcherIndex, (matchers, idx, config) => {
      matchers.splice(idx, 1)
      if (matchers.length === 0) {
        const eventMap = config.automations
        if (eventMap) delete eventMap[eventName]
      }
    })
  })

  // Read execution history for a specific automation
  server.handle(RPC_CHANNELS.automations.GET_HISTORY, async (ctx, workspaceId: string, automationId: string, limit = AUTOMATION_HISTORY_MAX_RUNS_PER_MATCHER) => {
    const wid = resolveWorkspaceId(ctx.workspaceId, workspaceId)!
    const workspace = getWorkspaceOrThrow(wid)

    const clampedLimit = Math.max(1, Math.min(limit, AUTOMATION_HISTORY_MAX_RUNS_PER_MATCHER))
    const historyPath = join(workspace.rootPath, HISTORY_FILE)
    try {
      const content = await readFile(historyPath, 'utf-8')
      const lines = content.trim().split('\n').filter(Boolean)

      return lines
        .map(line => { try { return JSON.parse(line) } catch { return null } })
        .filter((e): e is HistoryEntry => e?.id === automationId)
        .slice(-clampedLimit)
        .reverse()
    } catch {
      return [] // File doesn't exist yet
    }
  })

  // Replay webhook actions for a specific automation matcher
  server.handle(RPC_CHANNELS.automations.REPLAY, async (ctx, workspaceId: string, automationId: string, eventName: string) => {
    const wid = resolveWorkspaceId(ctx.workspaceId, workspaceId)!
    const workspace = getWorkspaceOrThrow(wid)

    const { resolveAutomationsConfigPath } = await import('@craft-agent/shared/automations/resolve-config-path')
    const configPath = resolveAutomationsConfigPath(workspace.rootPath)
    const raw = await readFile(configPath, 'utf-8')
    const config = JSON.parse(raw) as { automations?: Record<string, Array<{ id?: string; actions?: Array<{ type: string; [key: string]: unknown }> }>> }

    const matchers = config.automations?.[eventName] ?? []
    const matcher = matchers.find(m => m.id === automationId)
    if (!matcher) throw new Error('Automation not found')

    const webhookActions = (matcher.actions ?? []).filter(a => a.type === 'webhook')
    if (webhookActions.length === 0) throw new Error('No webhook actions to replay')

    const { executeWebhookRequest, createWebhookHistoryEntry } = await import('@craft-agent/shared/automations/webhook-utils')
    const results = await Promise.all(
      webhookActions.map(a => executeWebhookRequest(a as unknown as import('@craft-agent/shared/automations').WebhookAction))
    )

    // Write history entries for replay — use index to correctly attribute method per action
    for (let i = 0; i < results.length; i++) {
      const result = results[i]!
      const action = webhookActions[i]!
      const entry = createWebhookHistoryEntry({
        matcherId: automationId,
        ok: result.success,
        method: (action as { method?: string }).method,
        url: result.url,
        statusCode: result.statusCode,
        durationMs: result.durationMs ?? 0,
        error: result.error,
      })
      try {
        await appendAutomationHistoryEntry(workspace.rootPath, entry)
      } catch (e) {
        log.warn('[Automations] Failed to write replay history:', e)
      }
    }

    return { results: results.map(r => ({ ...r, duration: r.durationMs ?? 0 })) }
  })

  // Return last execution timestamp for all automations
  server.handle(RPC_CHANNELS.automations.GET_LAST_EXECUTED, async (ctx, workspaceId: string) => {
    const wid = resolveWorkspaceId(ctx.workspaceId, workspaceId)!
    const workspace = getWorkspaceOrThrow(wid)

    const historyPath = join(workspace.rootPath, HISTORY_FILE)
    try {
      const content = await readFile(historyPath, 'utf-8')
      const result: Record<string, number> = {}
      for (const line of content.trim().split('\n')) {
        try {
          const entry = JSON.parse(line)
          if (entry.id && entry.ts) result[entry.id] = entry.ts
        } catch { /* skip malformed lines */ }
      }
      return result
    } catch {
      return {}
    }
  })
}
