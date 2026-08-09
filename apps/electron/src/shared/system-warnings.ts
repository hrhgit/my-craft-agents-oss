export interface AutomationInitializationWarning {
  workspaceId: string
  workspaceName: string
  message: string
}

export function parseAutomationInitializationWarnings(
  value: string | undefined,
): AutomationInitializationWarning[] {
  if (!value) return []
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []
      const candidate = entry as Record<string, unknown>
      if (typeof candidate.workspaceId !== 'string' || candidate.workspaceId.length === 0
        || typeof candidate.workspaceName !== 'string' || candidate.workspaceName.length === 0
        || typeof candidate.message !== 'string' || candidate.message.length === 0) return []
      return [{
        workspaceId: candidate.workspaceId,
        workspaceName: candidate.workspaceName,
        message: candidate.message,
      }]
    })
  } catch {
    return []
  }
}
