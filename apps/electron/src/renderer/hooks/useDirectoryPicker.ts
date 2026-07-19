import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { RPC_CHANNELS } from '@mortise/shared/protocol'
import { useTransportConnectionState } from './useTransportConnectionState'
import { toast } from 'sonner'

type ServerBrowserMode = 'browse' | 'manual'
type DirectoryPickerHost = 'workspace' | 'client'

export function resolveDirectoryPickerTarget(
  connectionMode: 'local' | 'remote' | undefined,
  runtimeEnvironment: 'electron' | 'web',
  canBrowseServer: boolean,
  host: DirectoryPickerHost = 'workspace',
): { isRemote: boolean; serverBrowserMode: ServerBrowserMode } {
  const isRemote = host === 'client'
    ? runtimeEnvironment === 'web'
    : connectionMode === 'remote' ||
      (connectionMode === undefined && runtimeEnvironment === 'web')

  return {
    isRemote,
    serverBrowserMode: isRemote && canBrowseServer ? 'browse' : 'manual',
  }
}

interface DirectoryPickerResult {
  /** Open the picker (native dialog in local mode, ServerDirectoryBrowser in remote mode). */
  pickDirectory: () => void
  /** Whether the ServerDirectoryBrowser modal should be rendered. */
  showServerBrowser: boolean
  /** Which mode the ServerDirectoryBrowser should use. */
  serverBrowserMode: ServerBrowserMode
  /** Close the server browser without selecting. */
  cancelServerBrowser: () => void
  /** Called when a path is selected from the server browser. */
  confirmServerBrowser: (path: string) => void
  /** Whether we're in remote mode (informational). */
  isRemote: boolean
}

export function useDirectoryPicker(
  onSelect: (path: string) => void,
  options: { host?: DirectoryPickerHost } = {},
): DirectoryPickerResult {
  const { t } = useTranslation()
  const connectionState = useTransportConnectionState()
  const runtimeEnvironment = window.electronAPI.getRuntimeEnvironment()
  const canBrowseServer = window.electronAPI.isChannelAvailable(RPC_CHANNELS.fs.LIST_DIRECTORY)
  const initialTarget = resolveDirectoryPickerTarget(
    connectionState?.mode,
    runtimeEnvironment,
    canBrowseServer,
    options.host,
  )

  const [showServerBrowser, setShowServerBrowser] = useState(false)
  const [serverBrowserMode, setServerBrowserMode] = useState<ServerBrowserMode>(
    initialTarget.serverBrowserMode,
  )

  const pickDirectory = useCallback(async () => {
    // Read the state at click time. The hook's initial state is populated
    // asynchronously and can otherwise send early clicks down the local-dialog path.
    let connectionMode = connectionState?.mode
    try {
      connectionMode = (await window.electronAPI.getTransportConnectionState())?.mode
    } catch {
      // Use the latest observed state (or the runtime fallback) below.
    }

    const target = resolveDirectoryPickerTarget(
      connectionMode,
      runtimeEnvironment,
      window.electronAPI.isChannelAvailable(RPC_CHANNELS.fs.LIST_DIRECTORY),
      options.host,
    )

    if (target.isRemote) {
      // Remote mode — open ServerDirectoryBrowser (browse or manual depending on server support)
      setServerBrowserMode(target.serverBrowserMode)
      setShowServerBrowser(true)
      return
    }

    // Local mode — native OS dialog
    try {
      const path = await window.electronAPI.openFolderDialog()
      if (path) onSelect(path)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      toast.error(t('toast.failedToOpenFolderPicker'), {
        description: message,
      })
    }
  }, [connectionState?.mode, onSelect, options.host, runtimeEnvironment, t])

  const cancelServerBrowser = useCallback(() => {
    setShowServerBrowser(false)
  }, [])

  const confirmServerBrowser = useCallback((path: string) => {
    setShowServerBrowser(false)
    onSelect(path)
  }, [onSelect])

  return {
    pickDirectory,
    showServerBrowser,
    serverBrowserMode,
    cancelServerBrowser,
    confirmServerBrowser,
    isRemote: initialTarget.isRemote,
  }
}
