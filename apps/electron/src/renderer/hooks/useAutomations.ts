/**
 * useAutomations
 *
 * Encapsulates all automations state management:
 * - Loading automations from automations.json
 * - Subscribing to live updates
 * - Test, toggle, duplicate, delete handlers
 * - Delete confirmation state
 * - Syncing automations to Jotai atom for cross-component access
 */

import { useState, useCallback, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useSetAtom } from 'jotai'
import { toast } from 'sonner'
import { automationsAtom } from '@/atoms/automations'
import { parseAutomationDefinitionsV3, type AutomationDefinitionV3UI, type AutomationListItem, type TestResult, type ExecutionEntry } from '@/components/automations/types'

interface AutomationCommandResult {
  status: 'ok' | 'accepted' | 'duplicate' | 'conflict' | 'invalid' | 'denied' | 'unsupported'
  revision?: number
  data?: unknown
  error?: { message?: string }
}

async function automationCommand(input: Record<string, unknown>): Promise<AutomationCommandResult> {
  const result = await window.electronAPI.automationCommand({ schemaVersion: 1, ...input }) as AutomationCommandResult
  if (!result || !['ok', 'accepted', 'duplicate'].includes(result.status)) {
    throw new Error(result?.error?.message ?? `Automation operation failed: ${result?.status ?? 'invalid response'}`)
  }
  return result
}

export interface UseAutomationsResult {
  automations: AutomationListItem[]
  automationTestResults: Record<string, TestResult>
  automationPendingDelete: string | null
  pendingDeleteAutomation: AutomationListItem | undefined
  setAutomationPendingDelete: (id: string | null) => void
  handleTestAutomation: (automationId: string) => void
  handleToggleAutomation: (automationId: string) => void
  handleDuplicateAutomation: (automationId: string) => void
  handleDeleteAutomation: (automationId: string) => void
  confirmDeleteAutomation: () => void
  getAutomationHistory: (automationId: string) => Promise<ExecutionEntry[]>
  handleReplayAutomation: (automationId: string, event: string) => void
}

export function useAutomations(
  activeWorkspaceId: string | null | undefined,
): UseAutomationsResult {
  const { t } = useTranslation()
  const [automations, setAutomations] = useState<AutomationListItem[]>([])
  const [automationRevision, setAutomationRevision] = useState<number | null>(null)
  const [automationTestResults, setAutomationTestResults] = useState<Record<string, TestResult>>({})
  const [automationPendingDelete, setAutomationPendingDelete] = useState<string | null>(null)

  // Sync automations to Jotai atom for cross-component access (MainContentPanel)
  const setAutomationsAtom = useSetAtom(automationsAtom)
  useEffect(() => {
    setAutomationsAtom(automations)
  }, [automations, setAutomationsAtom])

  // Load automations from server and hydrate lastExecutedAt from history in one step.
  // This avoids the race where a config reload wipes timestamps before the
  // history effect can re-merge them.
  const loadAndHydrate = useCallback(async () => {
    if (!activeWorkspaceId) return
    try {
      const listed = await automationCommand({ operation: 'list' })
      const items = parseAutomationDefinitionsV3(listed.data)
      setAutomationRevision(listed.revision ?? null)
      const runs = await automationCommand({ operation: 'list-runs', limit: 500 })
      const lastByAutomation = new Map<string, number>()
      for (const run of Array.isArray(runs.data) ? runs.data as Array<Record<string, unknown>> : []) {
        if (typeof run.automationId !== 'string') continue
        const timestamp = Date.parse(String(run.completedAt ?? run.startedAt ?? run.createdAt ?? ''))
        if (Number.isFinite(timestamp) && timestamp > (lastByAutomation.get(run.automationId) ?? 0)) lastByAutomation.set(run.automationId, timestamp)
      }
      for (const item of items) item.lastExecutedAt = lastByAutomation.get(item.id)
      setAutomations(items)
    } catch {
      setAutomations([])
      setAutomationRevision(null)
    }
  }, [activeWorkspaceId])

  // Initial load
  useEffect(() => {
    loadAndHydrate()
  }, [loadAndHydrate])

  // Subscribe to live automations updates (when automations.json changes on disk)
  useEffect(() => {
    if (!activeWorkspaceId) return
    const cleanup = window.electronAPI.onAutomationsChanged(() => { loadAndHydrate() })
    return () => { cleanup() }
  }, [activeWorkspaceId, loadAndHydrate])

  // Shared lookup — avoids repeating automations.find() in every callback
  const findAutomation = useCallback((id: string) => automations.find(h => h.id === id), [automations])

  // Test automation — aggregate all action results
  const handleTestAutomation = useCallback((automationId: string) => {
    const automation = findAutomation(automationId)
    if (!automation || !activeWorkspaceId) return

    setAutomationTestResults(prev => ({ ...prev, [automationId]: { state: 'running' } }))

    void (async () => {
      try {
        const accepted = await automationCommand({ operation: 'run', operationId: crypto.randomUUID(), automationId })
        const runId = (accepted.data as { runId?: string } | undefined)?.runId
        if (!runId) throw new Error('Host did not return a run ID')
        for (let attempt = 0; attempt < 480; attempt++) {
          const response = await automationCommand({ operation: 'get-run', runId })
          const run = response.data as { state?: string; startedAt?: string; completedAt?: string; actions?: Array<{ error?: { message?: string } }> }
          if (run && !['queued', 'running'].includes(run.state ?? '')) {
            const succeeded = run.state === 'succeeded' || run.state === 'partial'
            const duration = run.startedAt && run.completedAt ? Date.parse(run.completedAt) - Date.parse(run.startedAt) : undefined
            const stderr = run.actions?.flatMap(action => action.error?.message ? [action.error.message] : []).join('\n')
            setAutomationTestResults(prev => ({ ...prev, [automationId]: { state: succeeded ? 'success' : 'error', ...(stderr ? { stderr } : {}), ...(duration !== undefined ? { duration } : {}) } }))
            await loadAndHydrate()
            return
          }
          await new Promise(resolve => setTimeout(resolve, 250))
        }
        throw new Error('Automation run did not finish before the UI timeout')
      } catch (error) {
        setAutomationTestResults(prev => ({ ...prev, [automationId]: { state: 'error', stderr: error instanceof Error ? error.message : String(error) } }))
      }
    })()
  }, [findAutomation, activeWorkspaceId, loadAndHydrate])

  const handleToggleAutomation = useCallback((automationId: string) => {
    const automation = findAutomation(automationId)
    if (!automation || !activeWorkspaceId || automationRevision === null) return
    void automationCommand({ operation: 'set-enabled', operationId: crypto.randomUUID(), expectedRevision: automationRevision, automationId, enabled: !automation.enabled })
      .then(loadAndHydrate)
      .catch(() => toast.error(t('toast.failedToToggleAutomation')))
  }, [findAutomation, activeWorkspaceId, automationRevision, loadAndHydrate])

  const handleDuplicateAutomation = useCallback((automationId: string) => {
    const automation = findAutomation(automationId)
    if (!automation?.definition || !activeWorkspaceId || automationRevision === null) return
    const now = new Date().toISOString()
    const duplicate: AutomationDefinitionV3UI = {
      ...automation.definition,
      id: `aut_${crypto.randomUUID().replaceAll('-', '')}`,
      name: `${automation.definition.name} Copy`,
      createdAt: now,
      updatedAt: now,
      triggers: automation.definition.triggers.map(trigger => ({ ...trigger, id: `trg_${crypto.randomUUID().replaceAll('-', '')}` })),
      actions: automation.definition.actions.map(action => ({ ...action, id: `act_${crypto.randomUUID().replaceAll('-', '')}` })),
    }
    void automationCommand({ operation: 'create', operationId: crypto.randomUUID(), expectedRevision: automationRevision, definition: duplicate })
      .then(loadAndHydrate)
      .catch(() => toast.error(t('toast.failedToDuplicateAutomation')))
  }, [findAutomation, activeWorkspaceId, automationRevision, loadAndHydrate])

  // Delete: show confirmation dialog
  const handleDeleteAutomation = useCallback((automationId: string) => {
    setAutomationPendingDelete(automationId)
  }, [])

  const pendingDeleteAutomation = automationPendingDelete ? findAutomation(automationPendingDelete) : undefined

  const confirmDeleteAutomation = useCallback(() => {
    if (!pendingDeleteAutomation || !activeWorkspaceId || automationRevision === null) return
    void automationCommand({ operation: 'delete', operationId: crypto.randomUUID(), expectedRevision: automationRevision, automationId: pendingDeleteAutomation.id })
      .then(loadAndHydrate)
      .catch(() => toast.error(t('toast.failedToDeleteAutomation')))
    setAutomationPendingDelete(null)
  }, [pendingDeleteAutomation, activeWorkspaceId, automationRevision, loadAndHydrate])

  // Fetch execution history for a specific automation
  const getAutomationHistory = useCallback(async (automationId: string): Promise<ExecutionEntry[]> => {
    if (!activeWorkspaceId) return []
    try {
      const response = await automationCommand({ operation: 'list-runs', automationId, limit: 20 })
      const entries = Array.isArray(response.data) ? response.data as Array<Record<string, any>> : []
      const automation = findAutomation(automationId)
      return entries.map(e => ({
        id: String(e.runId),
        automationId: String(e.automationId),
        event: automation?.event ?? 'SchedulerTick',
        status: e.state === 'succeeded' || e.state === 'partial' ? 'success' as const : e.state === 'skipped' ? 'blocked' as const : 'error' as const,
        duration: e.startedAt && e.completedAt ? Math.max(0, Date.parse(e.completedAt) - Date.parse(e.startedAt)) : 0,
        timestamp: Date.parse(e.completedAt ?? e.startedAt ?? e.createdAt),
        sessionId: e.actions?.find((action: any) => action.sessionId)?.sessionId,
        actionSummary: `${e.actions?.length ?? 0} action${e.actions?.length === 1 ? '' : 's'} - ${e.state}`,
        error: e.actions?.find((action: any) => action.error)?.error?.message ?? (e.reason ? String(e.reason) : undefined),
      }))
    } catch {
      return []
    }
  }, [activeWorkspaceId, findAutomation])

  const handleReplayAutomation = useCallback((automationId: string, _event: string) => {
    if (!activeWorkspaceId) return
    automationCommand({ operation: 'run', operationId: crypto.randomUUID(), automationId })
      .then(() => {
        toast.success(t('toast.webhookReplayCompleted'))
      })
      .catch((err: Error) => {
        toast.error(t("toast.replayFailed", { error: err.message }))
      })
  }, [activeWorkspaceId, t])

  return {
    automations,
    automationTestResults,
    automationPendingDelete,
    pendingDeleteAutomation,
    setAutomationPendingDelete,
    handleTestAutomation,
    handleToggleAutomation,
    handleDuplicateAutomation,
    handleDeleteAutomation,
    confirmDeleteAutomation,
    getAutomationHistory,
    handleReplayAutomation,
  }
}
