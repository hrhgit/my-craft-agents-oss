import { useEffect, useState } from 'react'
import type { WorkspaceInfo } from '../../../shared/types'

const iconCache = new Map<string, { dataUrl: string; sourceUrl: string }>()

export function useWorkspaceInfoIcons(workspaces: WorkspaceInfo[]): Map<string, string> {
  const [iconMap, setIconMap] = useState<Map<string, string>>(new Map())

  useEffect(() => {
    let cancelled = false

    async function loadIcons() {
      const next = new Map<string, string>()
      for (const workspace of workspaces) {
        const sourceUrl = workspace.iconUrl
        if (!sourceUrl) continue
        if (sourceUrl.startsWith('http://') || sourceUrl.startsWith('https://')) {
          next.set(workspace.id, sourceUrl)
          continue
        }
        if (!sourceUrl.startsWith('file://')) continue

        const cached = iconCache.get(workspace.id)
        if (cached?.sourceUrl === sourceUrl) {
          next.set(workspace.id, cached.dataUrl)
          continue
        }

        const filename = sourceUrl.split('?')[0]?.split('/').pop()
        if (!filename) continue
        try {
          const content = await window.electronAPI.readWorkspaceImage(workspace.id, filename)
          if (cancelled) return
          if (!content) continue
          const dataUrl = filename.endsWith('.svg')
            ? `data:image/svg+xml;base64,${btoa(content)}`
            : content
          iconCache.set(workspace.id, { dataUrl, sourceUrl })
          next.set(workspace.id, dataUrl)
        } catch (error) {
          console.error(`Failed to load icon for Workspace ${workspace.id}:`, error)
        }
      }
      if (!cancelled) setIconMap(next)
    }

    void loadIcons()
    return () => { cancelled = true }
  }, [workspaces])

  return iconMap
}
