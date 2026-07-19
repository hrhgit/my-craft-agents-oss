import { describe, expect, it, mock } from 'bun:test'
import type * as React from 'react'
import { createInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { renderToStaticMarkup } from 'react-dom/server'
import type { WorkspaceCoordinationStatusV1 } from '@mortise/shared/protocol'

mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: 'pdf.worker.js' }))
mock.module('react-pdf', () => ({ Document: () => null, Page: () => null, pdfjs: { GlobalWorkerOptions: {} } }))

const [{ TooltipProvider }, { WorkspaceCoordinationStatusContent }] = await Promise.all([
  import('@mortise/ui'),
  import('./WorkspaceCoordinationStatusPopover'),
])

const i18n = createInstance()
await i18n.use(initReactI18next).init({
  lng: 'en',
  resources: { en: { translation: {
    'common.loading': 'Loading...',
    'workspace.coordination': 'Workspace activity',
    'workspace.coordinationActiveWork': 'Active work',
    'workspace.coordinationConflicts': 'Conflicts',
    'workspace.coordinationLoadFailed': 'Could not load workspace activity',
    'workspace.coordinationRecentChanges': 'Recent changes',
    'workspace.coordinationSeverity.advisory': 'Advisory',
    'workspace.coordinationSeverity.blocking': 'Blocking',
    'workspace.refreshCoordination': 'Refresh workspace activity',
  } } },
})

const status: WorkspaceCoordinationStatusV1 = {
  schemaVersion: 1,
  workspaceId: 'ws',
  revision: 2,
  generatedAt: Date.now(),
  policy: 'protect',
  activities: [{
    activityId: 'activity/a', actorKind: 'agent', actorLabel: 'Parser task', sessionId: 'session-a',
    intent: 'Update parser', startedAt: 1, lastSeenAt: 2, leaseExpiresAt: 3,
    claims: [{ claimId: 'claim', resource: 'src/parser.ts', resourceKind: 'file', access: 'write', enforcement: 'advisory', leaseExpiresAt: 3 }],
  }],
  conflicts: [{
    conflictId: 'conflict/a', resource: 'src/parser.ts', activityIds: ['activity/a', 'activity/b'],
    severity: 'advisory', detectedAt: 2,
  }],
  recentChanges: [{
    changeId: 'change/a', actorKind: 'agent', actorLabel: 'Parser task', sessionId: 'session-a',
    resource: 'src/parser.ts', occurredAt: Date.now(), summary: 'Update parser',
  }],
}

function renderContent(overrides: Partial<React.ComponentProps<typeof WorkspaceCoordinationStatusContent>> = {}) {
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <TooltipProvider>
        <WorkspaceCoordinationStatusContent status={status} loading={false} error={null} onRefresh={() => {}} {...overrides} />
      </TooltipProvider>
    </I18nextProvider>,
  )
}

describe('WorkspaceCoordinationStatusContent', () => {
  it('exposes workspace conflicts, activities, changes, and refresh semantics', () => {
    const markup = renderContent()
    expect(markup).toContain('data-mortise-semantic-id="workspace.coordination.status"')
    expect(markup).toContain('data-mortise-semantic-id="workspace.coordination.refresh"')
    expect(markup).toContain('data-mortise-semantic-id="workspace.coordination.conflicts"')
    expect(markup).toContain('data-mortise-semantic-id="workspace.coordination.activities"')
    expect(markup).toContain('data-mortise-semantic-id="workspace.coordination.recent-changes"')
    expect(markup).toContain('src/parser.ts')
    expect(markup).toContain('Parser task')
  })

  it('renders bounded loading and error states', () => {
    expect(renderContent({ status: null, loading: true })).toContain('role="status"')
    expect(renderContent({ status: null, error: 'RPC unavailable' })).toContain('role="alert"')
  })
})
