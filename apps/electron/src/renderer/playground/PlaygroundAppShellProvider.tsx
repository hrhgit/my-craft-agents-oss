/**
 * PlaygroundAppShellProvider
 *
 * Minimal stand-in for the real AppShellProvider so components that rely on
 * `useActiveWorkspace()` / `useAppShellContext()` (e.g. MessagingSettingsPage)
 * can render inside the playground without the full app shell wiring.
 *
 * All callbacks are no-op logging stubs — interactions just go to the console.
 */

import * as React from 'react'
import { AppShellProvider, type AppShellContextType } from '../context/AppShellContext'
import type { WorkspaceInfo } from '../../shared/types'

export const PLAYGROUND_WORKSPACE: WorkspaceInfo = {
  schemaVersion: 2,
  id: 'playground-workspace',
  revision: 0,
  name: 'Playground',
  nameSource: 'custom',
  slug: 'playground',
  primaryLocationId: 'primary',
  locations: [{
    id: 'primary',
    name: 'Primary',
    rootName: 'playground-workspace',
    endpoint: { kind: 'local' },
    availability: { status: 'available', observedAt: 0 },
    permissions: { read: true, write: true, search: true, runCommands: true },
  }],
}

function logCall(method: string) {
  return (...args: unknown[]) => {
    console.log(`[Playground AppShell] ${method} called`, args)
  }
}

// Build a minimal value that satisfies the type. Most callbacks are no-ops;
// only `workspaces` and `activeWorkspaceId` carry real data so
// `useActiveWorkspace()` resolves to the playground workspace.
export const playgroundAppShellContext: AppShellContextType = {
  workspaces: [PLAYGROUND_WORKSPACE],
  activeWorkspaceId: PLAYGROUND_WORKSPACE.id,
  workspaceTransition: null,
  sessionsLoaded: true,
  activeWorkspaceSlug: PLAYGROUND_WORKSPACE.slug,
  piProviders: [],
  piGlobalSettings: {},
  refreshPiGlobalConfig: async () => {},
  pendingPermissions: new Map(),
  getDraft: () => '',
  getDraftAttachmentRefs: () => [],
  hydrateDraftAttachments: async () => [],
  clearDraft: async () => undefined,
  sessionOptions: new Map(),
  onCreateSession: (async () => {
    throw new Error('[Playground] onCreateSession is not available')
  }) as AppShellContextType['onCreateSession'],
  onCreateAndSendFirstTurn: (async () => {
    throw new Error('[Playground] onCreateAndSendFirstTurn is not available')
  }) as AppShellContextType['onCreateAndSendFirstTurn'],
  onSendMessage: async (...args) => {
    logCall('onSendMessage')(...args)
    return true
  },
  onRenameSession: logCall('onRenameSession'),
  onMarkSessionRead: logCall('onMarkSessionRead'),
  onMarkSessionUnread: logCall('onMarkSessionUnread'),
  onSetActiveViewingSession: logCall('onSetActiveViewingSession'),
  onDeleteSession: async () => {
    console.log('[Playground AppShell] onDeleteSession called')
    return false
  },
  onOpenFile: logCall('onOpenFile'),
  onOpenUrl: logCall('onOpenUrl'),
  onSelectWorkspace: logCall('onSelectWorkspace'),
  onOpenSettings: logCall('onOpenSettings'),
  onOpenKeyboardShortcuts: logCall('onOpenKeyboardShortcuts'),
  onOpenStoredUserPreferences: logCall('onOpenStoredUserPreferences'),
  onSessionOptionsChange: logCall('onSessionOptionsChange'),
  onInputChange: logCall('onInputChange'),
  onAttachmentsChange: logCall('onAttachmentsChange'),
  // The mobile-webui demos rely on this signal to flip `AppMenu` into its
  // compact layout; harmless for other demos that don't read it.
  isCompactMode: true,
}

export function PlaygroundAppShellProvider({ children }: { children: React.ReactNode }) {
  return <AppShellProvider value={playgroundAppShellContext}>{children}</AppShellProvider>
}

export function createPlaygroundAppShellContext(overrides: Partial<AppShellContextType> = {}): AppShellContextType {
  return { ...playgroundAppShellContext, ...overrides }
}
