import { useCallback, useEffect, useMemo, useState } from 'react'
import { Cloud, FolderOpen, Pencil, RefreshCw, Star, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import type { WorkspaceInfo, WorkspaceLocationInfo } from '@mortise/core/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ServerDirectoryBrowser } from '@/components/ServerDirectoryBrowser'
import { useDirectoryPicker } from '@/hooks/useDirectoryPicker'
import { SettingsCard, SettingsCardContent, SettingsSection } from '@/components/settings'
import {
  normalizeSecureWebSocketOrigin,
  reconcileInsecureTlsConsentOrigin,
} from '../../../shared/remote-tls'
import {
  buildWorkspaceLocationSettingsRows,
  createWorkspaceLocationId,
  createWorkspaceRemoteCredentialRef,
  createWorkspaceTopologyCommand,
  hasProjectedRemoteWorkspaceLocation,
  isWorkspaceLocationNameAvailable,
  WORKSPACE_LOCATION_SEMANTIC_IDS,
  workspaceLocationConsequence,
} from './workspace-location-settings-model'
import {
  resolveWorkspaceLocationSettingsApi,
  type WorkspaceLocationSettingsApi,
} from './workspace-location-settings-api'

interface WorkspaceLocationsSectionProps {
  workspace: WorkspaceInfo
  api?: WorkspaceLocationSettingsApi | null
  onWorkspaceChanged?: (workspace: WorkspaceInfo) => void
}

interface LocalEditorState {
  mode: 'attach' | 'replace'
  locationId?: string
  name: string
  path: string
}

interface RemoteEditorState {
  mode: 'attach' | 'replace'
  locationId?: string
  name: string
  url: string
  token: string
  remoteWorkspaceId: string
  insecureTlsConsentOrigin: string | null
}

interface RenameState {
  locationId: string
  name: string
}

interface ConfirmState {
  action: 'detach' | 'set-primary'
  locationId: string
  name: string
}

interface ReplaceChoiceState {
  locationId: string
  name: string
}

function locationById(workspace: WorkspaceInfo, locationId: string): WorkspaceLocationInfo | undefined {
  return workspace.locations.find(location => location.id === locationId)
}

export function WorkspaceLocationsSection({
  workspace: initialWorkspace,
  api: injectedApi,
  onWorkspaceChanged,
}: WorkspaceLocationsSectionProps) {
  const api = useMemo(
    () => injectedApi === undefined
      ? resolveWorkspaceLocationSettingsApi(window.electronAPI)
      : injectedApi,
    [injectedApi],
  )
  const [workspace, setWorkspace] = useState(initialWorkspace)
  const [pending, setPending] = useState(false)
  const [localEditor, setLocalEditor] = useState<LocalEditorState | null>(null)
  const [remoteEditor, setRemoteEditor] = useState<RemoteEditorState | null>(null)
  const [rename, setRename] = useState<RenameState | null>(null)
  const [confirmation, setConfirmation] = useState<ConfirmState | null>(null)
  const [replaceChoice, setReplaceChoice] = useState<ReplaceChoiceState | null>(null)

  const updateWorkspace = useCallback((next: WorkspaceInfo) => {
    setWorkspace(current => (
      current.id !== next.id || next.revision >= current.revision ? next : current
    ))
    onWorkspaceChanged?.(next)
  }, [onWorkspaceChanged])

  useEffect(() => {
    setWorkspace(current => (
      current.id !== initialWorkspace.id || initialWorkspace.revision >= current.revision
        ? initialWorkspace
        : current
    ))
  }, [initialWorkspace])

  useEffect(() => {
    if (!api) return
    let active = true
    void api.getWorkspaceTopology(initialWorkspace.id).then(next => {
      if (active && next) updateWorkspace(next)
    }).catch(() => {})
    const unsubscribe = api.onWorkspaceTopologyChanged(change => {
      if (change.workspaceId === initialWorkspace.id) updateWorkspace(change.workspace)
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [api, initialWorkspace.id, updateWorkspace])

  const runCommand = useCallback(async (
    command: Parameters<WorkspaceLocationSettingsApi['workspaceTopologyCommand']>[0],
  ): Promise<boolean> => {
    if (!api) return false
    setPending(true)
    try {
      const result = await api.workspaceTopologyCommand(command)
      updateWorkspace(result.workspace)
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      toast.error('Could not update Workspace locations', { description: message })
      try {
        const current = await api.getWorkspaceTopology(workspace.id)
        if (current) updateWorkspace(current)
      } catch {
        // Keep the last confirmed topology if refresh also fails.
      }
      return false
    } finally {
      setPending(false)
    }
  }, [api, updateWorkspace, workspace.id])

  const handleDirectorySelected = useCallback((path: string) => {
    setLocalEditor(current => current ? { ...current, path } : current)
  }, [])
  const directoryPicker = useDirectoryPicker(handleDirectorySelected, { host: 'client' })

  const rows = useMemo(() => buildWorkspaceLocationSettingsRows(workspace), [workspace])
  const topologyAvailable = api !== null

  const openRemoteEditor = useCallback((mode: 'attach' | 'replace', locationId?: string) => {
    const current = locationId ? locationById(workspace, locationId) : undefined
    const url = current?.endpoint.kind === 'remote' ? current.endpoint.url : ''
    setRemoteEditor({
      mode,
      locationId,
      name: current?.name ?? '',
      url,
      token: '',
      remoteWorkspaceId: current?.endpoint.kind === 'remote' ? current.endpoint.remoteWorkspaceId : '',
      insecureTlsConsentOrigin: current?.endpoint.kind === 'remote' && current.endpoint.allowInsecureTls === true
        ? normalizeSecureWebSocketOrigin(url)
        : null,
    })
  }, [workspace])

  const submitLocalEditor = useCallback(async () => {
    if (!localEditor || !localEditor.path.trim()) return
    const name = localEditor.name.trim()
    if (
      localEditor.mode === 'attach'
      && !isWorkspaceLocationNameAvailable(workspace, name)
    ) return
    const operationId = crypto.randomUUID()
    const command = localEditor.mode === 'attach'
      ? createWorkspaceTopologyCommand(workspace, operationId, {
          operation: 'attach-local',
          locationId: createWorkspaceLocationId(operationId),
          name,
          rootPath: localEditor.path.trim(),
        })
      : createWorkspaceTopologyCommand(workspace, operationId, {
          operation: 'replace-endpoint',
          locationId: localEditor.locationId!,
          endpoint: { kind: 'local', rootPath: localEditor.path.trim() },
        })
    if (await runCommand(command)) setLocalEditor(null)
  }, [localEditor, runCommand, workspace])

  const submitRemoteEditor = useCallback(async () => {
    if (!api || !remoteEditor) return
    const name = remoteEditor.name.trim()
    const url = remoteEditor.url.trim()
    const remoteWorkspaceId = remoteEditor.remoteWorkspaceId.trim()
    const secureWebSocketOrigin = normalizeSecureWebSocketOrigin(url)
    const allowInsecureTls = secureWebSocketOrigin !== null
      && remoteEditor.insecureTlsConsentOrigin === secureWebSocketOrigin
    if (
      !url || !remoteEditor.token || !remoteWorkspaceId
      || (
        remoteEditor.mode === 'attach'
        && !isWorkspaceLocationNameAvailable(workspace, name)
      )
    ) return

    const operationId = crypto.randomUUID()
    const locationId = remoteEditor.locationId ?? createWorkspaceLocationId(operationId)
    const credentialRef = createWorkspaceRemoteCredentialRef(operationId)
    let credentialStored = false
    setPending(true)
    try {
      await api.setWorkspaceRemoteCredential({
        workspaceId: workspace.id,
        credentialRef,
        token: remoteEditor.token,
      })
      credentialStored = true
      const command = remoteEditor.mode === 'attach'
        ? createWorkspaceTopologyCommand(workspace, operationId, {
            operation: 'attach-remote',
            locationId,
            name,
            url,
            remoteWorkspaceId,
            credentialRef,
            ...(allowInsecureTls ? { allowInsecureTls: true } : {}),
          })
        : createWorkspaceTopologyCommand(workspace, operationId, {
            operation: 'replace-endpoint',
            locationId,
            endpoint: {
              kind: 'remote',
              url,
              remoteWorkspaceId,
              credentialRef,
              ...(allowInsecureTls ? { allowInsecureTls: true } : {}),
            },
          })
      const result = await api.workspaceTopologyCommand(command)
      updateWorkspace(result.workspace)
      setRemoteEditor(null)
    } catch (error) {
      let credentialCanBeDeleted = false
      try {
        const current = await api.getWorkspaceTopology(workspace.id)
        if (current) {
          updateWorkspace(current)
          credentialCanBeDeleted = !hasProjectedRemoteWorkspaceLocation(
            current,
            locationId,
            remoteWorkspaceId,
          )
        }
      } catch {
        // Preserve the credential while command outcome is unknown.
      }
      if (credentialStored && credentialCanBeDeleted) {
        try {
          await api.deleteWorkspaceRemoteCredential({ workspaceId: workspace.id, credentialRef })
        } catch {
          // The credential authority remains responsible for orphan reclamation.
        }
      }
      const message = error instanceof Error ? error.message : 'Unknown error'
      toast.error('Could not update the remote location', { description: message })
    } finally {
      setPending(false)
    }
  }, [api, remoteEditor, updateWorkspace, workspace])

  const submitRename = useCallback(async () => {
    if (!rename) return
    const name = rename.name.trim()
    if (!isWorkspaceLocationNameAvailable(workspace, name, rename.locationId)) return
    const command = createWorkspaceTopologyCommand(workspace, crypto.randomUUID(), {
      operation: 'rename',
      locationId: rename.locationId,
      name,
    })
    if (await runCommand(command)) setRename(null)
  }, [rename, runCommand, workspace])

  const submitConfirmation = useCallback(async () => {
    if (!confirmation) return
    const command = createWorkspaceTopologyCommand(workspace, crypto.randomUUID(), {
      operation: confirmation.action,
      locationId: confirmation.locationId,
    })
    if (await runCommand(command)) setConfirmation(null)
  }, [confirmation, runCommand, workspace])

  const secureWebSocketOrigin = normalizeSecureWebSocketOrigin(remoteEditor?.url)
  const allowInsecureTls = secureWebSocketOrigin !== null
    && remoteEditor?.insecureTlsConsentOrigin === secureWebSocketOrigin
  const localNameValid = localEditor?.mode === 'replace'
    || isWorkspaceLocationNameAvailable(workspace, localEditor?.name ?? '')
  const remoteNameValid = remoteEditor?.mode === 'replace'
    || isWorkspaceLocationNameAvailable(workspace, remoteEditor?.name ?? '')

  return (
    <>
      <SettingsSection
        title="Locations"
        description="The primary location supplies the default command directory. Attached locations keep their own execution endpoint."
      >
        <div data-mortise-semantic-id={WORKSPACE_LOCATION_SEMANTIC_IDS.section}>
          <SettingsCard>
            {rows.map(row => (
              <div key={row.id} data-mortise-semantic-id={row.semanticId}>
                <SettingsCardContent className="grid min-h-16 grid-cols-[2.25rem_minmax(0,1fr)] items-center gap-3 sm:grid-cols-[2.25rem_minmax(0,1fr)_auto]">
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-foreground/5 text-muted-foreground">
                    {row.kind === 'local' ? <FolderOpen aria-hidden /> : <Cloud aria-hidden />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-foreground">{row.name}</span>
                      {row.role === 'primary' && (
                        <span className="rounded border border-foreground/10 bg-foreground/5 px-1.5 py-0.5 text-[10px] font-medium uppercase text-muted-foreground">
                          Primary
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 flex min-w-0 flex-wrap gap-x-2 text-xs text-muted-foreground">
                      <span className="truncate">{row.endpointLabel}</span>
                      <span aria-label="Availability not reported">Availability not reported</span>
                    </div>
                  </div>
                  <div className="col-span-2 flex shrink-0 items-center justify-end gap-1 sm:col-span-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      semanticId={row.actionSemanticIds.rename}
                      aria-label={`Rename ${row.name}`}
                      title="Rename location"
                      disabled={pending || !topologyAvailable}
                      onClick={() => setRename({ locationId: row.id, name: row.name })}
                    ><Pencil /></Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      semanticId={row.actionSemanticIds.replace}
                      aria-label={`Replace ${row.name}`}
                      title="Replace endpoint"
                      disabled={pending || !topologyAvailable}
                      onClick={() => setReplaceChoice({ locationId: row.id, name: row.name })}
                    ><RefreshCw /></Button>
                    {row.role !== 'primary' && (
                      <Button
                        variant="ghost"
                        size="icon"
                        semanticId={row.actionSemanticIds['set-primary']}
                        aria-label={`Make ${row.name} primary`}
                        title="Make primary"
                        disabled={pending || !topologyAvailable}
                        onClick={() => setConfirmation({ action: 'set-primary', locationId: row.id, name: row.name })}
                      ><Star /></Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      semanticId={row.actionSemanticIds.detach}
                      aria-label={`Remove ${row.name}`}
                      title={row.role === 'primary' ? 'Choose another primary location first' : 'Remove location'}
                      disabled={pending || !topologyAvailable || row.role === 'primary'}
                      onClick={() => setConfirmation({ action: 'detach', locationId: row.id, name: row.name })}
                    ><Trash2 /></Button>
                  </div>
                </SettingsCardContent>
              </div>
            ))}
          </SettingsCard>
          <div className="mt-3 flex flex-wrap items-center justify-end gap-3">
            {!topologyAvailable && (
              <p className="mr-auto text-xs text-muted-foreground">
                Location editing is unavailable in this build.
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                semanticId={WORKSPACE_LOCATION_SEMANTIC_IDS.addLocal}
                disabled={pending || !topologyAvailable}
                onClick={() => setLocalEditor({ mode: 'attach', name: '', path: '' })}
              ><FolderOpen />Add local</Button>
              <Button
                variant="outline"
                size="sm"
                semanticId={WORKSPACE_LOCATION_SEMANTIC_IDS.addRemote}
                disabled={pending || !topologyAvailable}
                onClick={() => openRemoteEditor('attach')}
              ><Cloud />Add remote</Button>
            </div>
          </div>
        </div>
      </SettingsSection>

      <Dialog open={localEditor !== null} onOpenChange={open => { if (!open && !pending) setLocalEditor(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{localEditor?.mode === 'replace' ? 'Replace with a local endpoint' : 'Attach a local location'}</DialogTitle>
            <DialogDescription>
              {localEditor?.mode === 'replace'
                ? workspaceLocationConsequence('replace')
                : `Attach a local folder to ${workspace.name}.`}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <Input
              semanticId={WORKSPACE_LOCATION_SEMANTIC_IDS.localName}
              value={localEditor?.name ?? ''}
              placeholder="Location name"
              aria-label="Location name"
              disabled={pending || localEditor?.mode === 'replace'}
              onChange={event => setLocalEditor(current => current ? { ...current, name: event.target.value } : current)}
            />
            <div className="flex items-center gap-2">
              <Input value={localEditor?.path ?? ''} readOnly placeholder="No folder selected" aria-label="Local folder" className="font-mono text-xs" />
              <Button
                variant="outline"
                semanticId={WORKSPACE_LOCATION_SEMANTIC_IDS.localBrowse}
                onClick={directoryPicker.pickDirectory}
                disabled={pending}
              ><FolderOpen />Browse</Button>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setLocalEditor(null)} disabled={pending}>Cancel</Button>
            <Button
              semanticId={WORKSPACE_LOCATION_SEMANTIC_IDS.localSubmit}
              onClick={() => void submitLocalEditor()}
              disabled={pending || !localEditor?.path.trim() || !localNameValid}
            >{localEditor?.mode === 'replace' ? 'Replace location' : 'Attach location'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={remoteEditor !== null} onOpenChange={open => { if (!open && !pending) setRemoteEditor(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{remoteEditor?.mode === 'replace' ? 'Replace with a remote endpoint' : 'Attach a remote location'}</DialogTitle>
            <DialogDescription>
              {remoteEditor?.mode === 'replace'
                ? workspaceLocationConsequence('replace')
                : `Attach a remote file root to ${workspace.name}.`}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <Input
              semanticId={WORKSPACE_LOCATION_SEMANTIC_IDS.remoteName}
              value={remoteEditor?.name ?? ''}
              placeholder="Location name"
              aria-label="Location name"
              disabled={pending || remoteEditor?.mode === 'replace'}
              onChange={event => setRemoteEditor(current => current ? { ...current, name: event.target.value } : current)}
            />
            <Input
              semanticId={WORKSPACE_LOCATION_SEMANTIC_IDS.remoteUrl}
              value={remoteEditor?.url ?? ''}
              placeholder="wss://agent.example.com"
              aria-label="Remote server URL"
              disabled={pending}
              onChange={event => {
                const url = event.target.value
                setRemoteEditor(current => current ? {
                  ...current,
                  url,
                  insecureTlsConsentOrigin: reconcileInsecureTlsConsentOrigin(
                    url,
                    current.insecureTlsConsentOrigin,
                  ),
                } : current)
              }}
            />
            <Input
              semanticId={WORKSPACE_LOCATION_SEMANTIC_IDS.remoteToken}
              type="password"
              value={remoteEditor?.token ?? ''}
              placeholder="Server token"
              aria-label="Server token"
              autoComplete="off"
              disabled={pending}
              onChange={event => {
                setRemoteEditor(current => current ? { ...current, token: event.target.value } : current)
              }}
            />
            {secureWebSocketOrigin && (
              <label className="flex items-center justify-between gap-4 text-sm">
                <span>Allow untrusted certificates</span>
                <Switch
                  semanticId={WORKSPACE_LOCATION_SEMANTIC_IDS.remoteAllowInsecureTls}
                  checked={allowInsecureTls}
                  disabled={pending}
                  aria-label="Allow untrusted TLS certificates for this server"
                  onCheckedChange={checked => {
                    setRemoteEditor(current => current ? {
                      ...current,
                      insecureTlsConsentOrigin: checked ? secureWebSocketOrigin : null,
                    } : current)
                  }}
                />
              </label>
            )}
            <Input
              semanticId={WORKSPACE_LOCATION_SEMANTIC_IDS.remoteWorkspace}
              value={remoteEditor?.remoteWorkspaceId ?? ''}
              placeholder="Remote Workspace ID"
              aria-label="Remote Workspace ID"
              disabled={pending}
              onChange={event => setRemoteEditor(current => current ? { ...current, remoteWorkspaceId: event.target.value } : current)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoteEditor(null)} disabled={pending}>Cancel</Button>
            <Button
              semanticId={WORKSPACE_LOCATION_SEMANTIC_IDS.remoteSubmit}
              onClick={() => void submitRemoteEditor()}
              disabled={pending || !remoteEditor?.url.trim() || !remoteEditor?.token || !remoteEditor?.remoteWorkspaceId.trim() || !remoteNameValid}
            >{remoteEditor?.mode === 'replace' ? 'Replace location' : 'Attach location'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={rename !== null} onOpenChange={open => { if (!open && !pending) setRename(null) }}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader><DialogTitle>Rename location</DialogTitle></DialogHeader>
          <Input
            semanticId={WORKSPACE_LOCATION_SEMANTIC_IDS.renameName}
            value={rename?.name ?? ''}
            aria-label="Location name"
            onChange={event => setRename(current => current ? { ...current, name: event.target.value } : current)}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRename(null)} disabled={pending}>Cancel</Button>
            <Button
              semanticId={WORKSPACE_LOCATION_SEMANTIC_IDS.renameSubmit}
              onClick={() => void submitRename()}
              disabled={pending || !isWorkspaceLocationNameAvailable(workspace, rename?.name ?? '', rename?.locationId)}
            >Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmation !== null} onOpenChange={open => { if (!open && !pending) setConfirmation(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{confirmation?.action === 'detach' ? `Remove ${confirmation.name}?` : `Make ${confirmation?.name ?? ''} primary?`}</DialogTitle>
            <DialogDescription>{confirmation ? workspaceLocationConsequence(confirmation.action) : ''}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" semanticId={WORKSPACE_LOCATION_SEMANTIC_IDS.confirmCancel} onClick={() => setConfirmation(null)} disabled={pending}>Cancel</Button>
            <Button
              variant={confirmation?.action === 'detach' ? 'destructive' : 'default'}
              semanticId={WORKSPACE_LOCATION_SEMANTIC_IDS.confirmSubmit}
              onClick={() => void submitConfirmation()}
              disabled={pending}
            >{confirmation?.action === 'detach' ? 'Remove location' : 'Change primary'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={replaceChoice !== null} onOpenChange={open => { if (!open) setReplaceChoice(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Replace {replaceChoice?.name ?? 'location'}</DialogTitle>
            <DialogDescription>{workspaceLocationConsequence('replace')}</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-1 gap-3 py-2 sm:grid-cols-2">
            <Button
              variant="outline"
              semanticId={WORKSPACE_LOCATION_SEMANTIC_IDS.replaceLocal}
              onClick={() => {
                const current = replaceChoice
                setReplaceChoice(null)
                if (current) setLocalEditor({ mode: 'replace', locationId: current.locationId, name: current.name, path: '' })
              }}
            ><FolderOpen />Local endpoint</Button>
            <Button
              variant="outline"
              semanticId={WORKSPACE_LOCATION_SEMANTIC_IDS.replaceRemote}
              onClick={() => {
                const current = replaceChoice
                setReplaceChoice(null)
                if (current) openRemoteEditor('replace', current.locationId)
              }}
            ><Cloud />Remote endpoint</Button>
          </div>
        </DialogContent>
      </Dialog>

      <ServerDirectoryBrowser
        open={directoryPicker.showServerBrowser}
        mode={directoryPicker.serverBrowserMode}
        onSelect={directoryPicker.confirmServerBrowser}
        onCancel={directoryPicker.cancelServerBrowser}
      />
    </>
  )
}
