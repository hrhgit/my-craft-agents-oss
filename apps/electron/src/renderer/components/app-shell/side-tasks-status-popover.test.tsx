import { describe, expect, it, mock } from 'bun:test'
import type * as React from 'react'
import { createInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { renderToStaticMarkup } from 'react-dom/server'
import type { PiChildSessionInfo } from '@mortise/shared/agent'
import { sideTaskSemanticPart } from './side-tasks-status-model'

mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: 'pdf.worker.js' }))
mock.module('react-pdf', () => ({
  Document: () => null,
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: {} },
}))

const [{ TooltipProvider }, { SideTasksStatusContent }] = await Promise.all([
  import('@mortise/ui'),
  import('./SideTasksStatusPopover'),
])

const i18n = createInstance()
await i18n.use(initReactI18next).init({
  lng: 'en',
  resources: {
    en: {
      translation: {
        'common.loading': 'Loading...',
        'workbench.noSideTasks': 'No side tasks',
        'workbench.openSideTask': 'Open side task "{{title}}"',
        'workbench.refreshSideTasks': 'Refresh side tasks',
        'workbench.sideTaskCount': 'Side tasks - {{count}}',
        'workbench.sideTaskMessages': '{{count}} messages',
        'workbench.sideTasks': 'Side tasks',
        'workbench.sideTasksCompleted': 'Completed',
        'workbench.sideTasksLoadFailed': 'Could not load side tasks',
        'workbench.sideTasksRunning': 'Running',
        'workbench.untitledSideTask': 'Untitled side task',
      },
    },
  },
})

function task(sessionId: string, name: string): PiChildSessionInfo {
  return {
    sessionId,
    sessionPath: `${sessionId}.jsonl`,
    name,
    cwd: '/workspace',
    created: '2026-07-18T00:00:00.000Z',
    modified: '2026-07-18T00:00:00.000Z',
    messageCount: 3,
    firstMessage: `Prompt for ${sessionId}`,
  }
}

function renderContent(overrides: Partial<React.ComponentProps<typeof SideTasksStatusContent>> = {}): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <TooltipProvider>
        <SideTasksStatusContent
          parentSessionId="parent/session"
          sections={{ running: [], completed: [] }}
          loading={false}
          error={null}
          onRefresh={() => {}}
          onOpenTask={() => {}}
          {...overrides}
        />
      </TooltipProvider>
    </I18nextProvider>,
  )
}

describe('SideTasksStatusContent', () => {
  it('exposes session-scoped status, actions, state, and both task groups', () => {
    const markup = renderContent({
      sections: {
        running: [task('running/session', 'Running task')],
        completed: [task('completed/session', 'Completed task')],
      },
    })
    const parentId = sideTaskSemanticPart('parent/session')
    const runningId = sideTaskSemanticPart('running/session')
    const completedId = sideTaskSemanticPart('completed/session')

    expect(markup).toContain(`data-mortise-semantic-id="session.side-tasks.${parentId}"`)
    expect(markup).toContain(`data-mortise-semantic-id="session.side-tasks.refresh.${parentId}"`)
    expect(markup).toContain(`data-mortise-semantic-id="session.side-tasks.running.${parentId}"`)
    expect(markup).toContain(`data-mortise-semantic-id="session.side-tasks.completed.${parentId}"`)
    expect(markup).toContain(`data-mortise-semantic-id="session.side-task.${runningId}"`)
    expect(markup).toContain(`data-mortise-semantic-id="session.side-task.${completedId}"`)
    expect(markup).toMatch(/aria-label="Open side task &quot;Running task&quot;, Running"[^>]*aria-busy="true"/)
    expect(markup).toContain('overscroll-contain')
  })

  it('renders bounded loading, error, and empty states', () => {
    expect(renderContent({ loading: true })).toContain('role="status"')
    expect(renderContent({ loading: true })).toContain('Loading...')

    const error = renderContent({ error: 'RPC unavailable' })
    expect(error).toContain('role="alert"')
    expect(error).toContain('RPC unavailable')

    expect(renderContent()).toContain('No side tasks')
  })
})
