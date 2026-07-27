import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, CheckCircle, XCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Input } from '../ui/input'
import { Switch } from '../ui/switch'
import {
  AddWorkspaceContainer,
  AddWorkspacePrimaryButton,
  AddWorkspaceSecondaryButton,
  AddWorkspaceStepHeader,
} from './primitives'
import type { RemoteWorkspaceLocationInfo } from './workspace-remote-reconnect'
import {
  normalizeSecureWebSocketOrigin,
  reconcileInsecureTlsConsentOrigin,
} from '../../../shared/remote-tls'

const INSECURE_TLS_LABEL_ID = 'workspace-remote-allow-insecure-tls-label'
const INSECURE_TLS_DESCRIPTION_ID = 'workspace-remote-allow-insecure-tls-description'

export interface WorkspaceRemoteReconnectFormValue {
  url: string
  token: string
  allowInsecureTls?: boolean
}

interface AddWorkspaceStepConnectRemoteProps {
  onBack: () => void
  onReconnect: (value: WorkspaceRemoteReconnectFormValue) => Promise<void>
  isCreating: boolean
  workspaceName: string
  location: RemoteWorkspaceLocationInfo
}

export function AddWorkspaceStep_ConnectRemote({
  onBack,
  onReconnect,
  isCreating,
  workspaceName,
  location,
}: AddWorkspaceStepConnectRemoteProps) {
  const { t } = useTranslation()
  const [serverUrl, setServerUrl] = useState(location.endpoint.url)
  // Credential material is intentionally not projected back into the renderer.
  const [token, setToken] = useState('')
  const [insecureTlsConsentOrigin, setInsecureTlsConsentOrigin] = useState<string | null>(() => (
    location.endpoint.allowInsecureTls === true
      ? normalizeSecureWebSocketOrigin(location.endpoint.url)
      : null
  ))
  const [testState, setTestState] = useState<'idle' | 'testing' | 'ok' | 'error'>('idle')
  const [testError, setTestError] = useState<string | null>(null)
  const [serverVersion, setServerVersion] = useState<string | null>(null)

  const secureWebSocketOrigin = normalizeSecureWebSocketOrigin(serverUrl)
  const allowInsecureTls = secureWebSocketOrigin !== null
    && insecureTlsConsentOrigin === secureWebSocketOrigin
  const isSecureWebSocket = secureWebSocketOrigin !== null

  const handleServerUrlChange = useCallback((nextUrl: string) => {
    setServerUrl(nextUrl)
    setInsecureTlsConsentOrigin(current => reconcileInsecureTlsConsentOrigin(nextUrl, current))
  }, [])

  useEffect(() => {
    setTestState('idle')
    setTestError(null)
    setServerVersion(null)
  }, [serverUrl, token, allowInsecureTls])

  const handleTestConnection = useCallback(async () => {
    if (!serverUrl || !token) return
    setTestState('testing')
    setTestError(null)
    try {
      const result = await window.electronAPI.testRemoteConnection(
        serverUrl,
        token,
        allowInsecureTls,
      )
      if (!result.ok) {
        setTestState('error')
        setTestError(result.error || 'Connection failed')
        return
      }
      const targetExists = result.remoteWorkspaces?.some(
        workspace => workspace.id === location.endpoint.remoteWorkspaceId,
      ) === true
      if (!targetExists) {
        setTestState('error')
        setTestError('The remote Workspace is not available on this server')
        return
      }
      setServerVersion(result.serverVersion ?? null)
      setTestState('ok')
    } catch (error) {
      setTestState('error')
      setTestError(error instanceof Error ? error.message : 'Connection failed')
    }
  }, [allowInsecureTls, location.endpoint.remoteWorkspaceId, serverUrl, token])

  const handleReconnect = useCallback(async () => {
    if (testState !== 'ok' || !serverUrl || !token) return
    try {
      await onReconnect({
        url: serverUrl,
        token,
        ...(allowInsecureTls ? { allowInsecureTls: true } : {}),
      })
    } catch (error) {
      setTestState('error')
      setTestError(error instanceof Error ? error.message : 'Failed to reconnect Workspace')
    }
  }, [allowInsecureTls, onReconnect, serverUrl, testState, token])

  return (
    <AddWorkspaceContainer>
      <button
        type="button"
        onClick={onBack}
        disabled={isCreating}
        className={cn(
          'mb-4 flex items-center gap-1 self-start text-sm text-muted-foreground',
          'transition-colors hover:text-foreground',
          isCreating && 'cursor-not-allowed opacity-50',
        )}
      >
        <ArrowLeft className="h-4 w-4" />
        {t('common.back')}
      </button>

      <AddWorkspaceStepHeader
        title={t('workspace.reconnect', { name: workspaceName })}
        description="Update the server URL and provide a new token to restore this Workspace location."
      />

      <div className="mt-6 w-full space-y-5">
        <div className="space-y-2">
          <label className="block text-sm font-medium text-foreground" htmlFor="workspace-remote-server-url">
            Server URL
          </label>
          <div className="rounded-lg bg-background shadow-minimal">
            <Input
              id="workspace-remote-server-url"
              value={serverUrl}
              onChange={event => handleServerUrlChange(event.target.value)}
              placeholder="ws://192.168.1.100:9100"
              disabled={isCreating}
              autoFocus
              className="border-0 bg-transparent font-mono text-sm shadow-none"
            />
          </div>
        </div>

        {isSecureWebSocket && (
          <div className="flex items-center justify-between gap-4 border-y border-border/60 py-3">
            <span className="min-w-0">
              <span id={INSECURE_TLS_LABEL_ID} className="block text-sm font-medium text-foreground">
                {t('workspace.allowUntrustedCertificates')}
              </span>
              <span id={INSECURE_TLS_DESCRIPTION_ID} className="block text-xs text-muted-foreground">
                {t('workspace.allowUntrustedCertificatesDescription')}
              </span>
            </span>
            <Switch
              semanticId="workspace.remote.allow-insecure-tls"
              checked={allowInsecureTls}
              onCheckedChange={checked => {
                setInsecureTlsConsentOrigin(checked ? secureWebSocketOrigin : null)
              }}
              disabled={isCreating}
              aria-labelledby={INSECURE_TLS_LABEL_ID}
              aria-describedby={INSECURE_TLS_DESCRIPTION_ID}
            />
          </div>
        )}

        <div className="space-y-2">
          <label className="block text-sm font-medium text-foreground" htmlFor="workspace-remote-token">
            Token
          </label>
          <div className="rounded-lg bg-background shadow-minimal">
            <Input
              id="workspace-remote-token"
              type="password"
              value={token}
              onChange={event => setToken(event.target.value)}
              placeholder={t('workspace.serverAuthToken')}
              disabled={isCreating}
              className="border-0 bg-transparent shadow-none"
            />
          </div>
        </div>

        <div className="flex items-center gap-3">
          <AddWorkspaceSecondaryButton
            onClick={handleTestConnection}
            disabled={!serverUrl || !token || testState === 'testing' || isCreating}
          >
            {testState === 'testing' ? 'Testing...' : 'Test Connection'}
          </AddWorkspaceSecondaryButton>
          {testState === 'ok' && (
            <span className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
              <CheckCircle className="h-3.5 w-3.5" />
              Connected{serverVersion ? ` - v${serverVersion}` : ''}
            </span>
          )}
          {testState === 'error' && (
            <span className="flex items-center gap-1 text-xs text-destructive">
              <XCircle className="h-3.5 w-3.5" />
              {testError || 'Failed'}
            </span>
          )}
        </div>

        <AddWorkspacePrimaryButton
          onClick={handleReconnect}
          disabled={testState !== 'ok' || isCreating}
          loading={isCreating}
          loadingText="Reconnecting..."
        >
          Reconnect
        </AddWorkspacePrimaryButton>
      </div>
    </AddWorkspaceContainer>
  )
}
