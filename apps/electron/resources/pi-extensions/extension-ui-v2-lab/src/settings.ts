import { defineExtensionUI, type ExtensionUIMountContext } from '@mortise/extension-ui'

interface LabItem {
  id: string
  title: string
  owner: string
  status: 'Ready' | 'Running' | 'Blocked'
  complete: boolean
}

const items: LabItem[] = [
  { id: 'runtime', title: 'Frontend runtime contract', owner: 'Desktop', status: 'Ready', complete: true },
  { id: 'channels', title: 'Workspace channel handshake', owner: 'Pi host', status: 'Running', complete: false },
  { id: 'cleanup', title: 'Dispose and DOM restoration', owner: 'Extension', status: 'Blocked', complete: false },
  { id: 'fallback', title: 'Replace failure fallback', owner: 'Renderer', status: 'Ready', complete: true },
]

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function labeledControl(labelText: string, control: HTMLElement): HTMLLabelElement {
  const label = element('label', 'mortise-v2-lab-field')
  label.append(element('span', 'mortise-v2-lab-label', labelText), control)
  return label
}

export const definition = defineExtensionUI({
  mount(context: ExtensionUIMountContext) {
    const previousBodyMarker = document.body.dataset.mortiseV2Lab
    document.body.dataset.mortiseV2Lab = 'mounted'
    context.root.dataset.theme = context.theme.mode
    context.root.lang = context.locale
    context.root.className = 'mortise-v2-lab-settings'

    const localItems = items.map(item => ({ ...item }))
    let activeView: 'pipeline' | 'rules' = 'pipeline'
    let drawer: HTMLDialogElement | undefined

    const header = element('header', 'mortise-v2-lab-header')
    const headingGroup = element('div')
    headingGroup.append(
      element('p', 'mortise-v2-lab-eyebrow', 'Extension-owned workspace'),
      element('h2', 'mortise-v2-lab-title', 'Release control center'),
      element('p', 'mortise-v2-lab-subtitle', 'A multi-component interface rendered entirely by the V2 extension frontend.'),
    )
    const openDrawer = element('button', 'mortise-v2-lab-button mortise-v2-lab-button-primary', 'Open command drawer')
    openDrawer.type = 'button'
    header.append(headingGroup, openDrawer)

    const stats = element('section', 'mortise-v2-lab-stats')
    const statDefinitions = [
      ['Active checks', '4', 'Across this workspace'],
      ['Completed', '2', 'No host component used'],
      ['Runtime', 'Mounted', context.route.workspaceId ?? 'Workspace route'],
    ] as const
    for (const [label, value, detail] of statDefinitions) {
      const card = element('article', 'mortise-v2-lab-stat')
      card.append(
        element('span', 'mortise-v2-lab-stat-label', label),
        element('strong', 'mortise-v2-lab-stat-value', value),
        element('span', 'mortise-v2-lab-stat-detail', detail),
      )
      stats.append(card)
    }

    const tabs = element('div', 'mortise-v2-lab-tabs')
    tabs.setAttribute('role', 'tablist')
    tabs.setAttribute('aria-label', 'Control center views')
    const pipelineTab = element('button', 'mortise-v2-lab-tab', 'Pipeline')
    const rulesTab = element('button', 'mortise-v2-lab-tab', 'Rules')
    for (const [button, view] of [[pipelineTab, 'pipeline'], [rulesTab, 'rules']] as const) {
      button.type = 'button'
      button.setAttribute('role', 'tab')
      button.dataset.view = view
      tabs.append(button)
    }

    const content = element('section', 'mortise-v2-lab-content')
    const listPanel = element('div', 'mortise-v2-lab-panel')
    const listHeader = element('div', 'mortise-v2-lab-panel-header')
    const listHeading = element('h3', 'mortise-v2-lab-panel-title', 'Readiness pipeline')
    const search = element('input', 'mortise-v2-lab-search')
    search.type = 'search'
    search.placeholder = 'Filter checks'
    search.setAttribute('aria-label', 'Filter checks')
    listHeader.append(listHeading, search)
    const list = element('div', 'mortise-v2-lab-list')
    list.setAttribute('aria-live', 'polite')
    listPanel.append(listHeader, list)

    const details = element('aside', 'mortise-v2-lab-panel mortise-v2-lab-details')
    const detailsHeading = element('h3', 'mortise-v2-lab-panel-title', 'Workspace controls')
    const noteInput = element('input', 'mortise-v2-lab-input')
    noteInput.type = 'text'
    noteInput.value = 'Release candidate'
    noteInput.placeholder = 'Workspace note'
    const priority = element('select', 'mortise-v2-lab-select')
    priority.setAttribute('aria-label', 'Release priority')
    for (const value of ['Normal', 'High', 'Critical']) {
      const option = element('option', undefined, value)
      option.value = value.toLowerCase()
      priority.append(option)
    }
    const automation = element('input')
    automation.type = 'checkbox'
    automation.checked = true
    const automationRow = element('label', 'mortise-v2-lab-check-row')
    automationRow.append(automation, element('span', undefined, 'Run checks automatically'))
    const threshold = element('input', 'mortise-v2-lab-range')
    threshold.type = 'range'
    threshold.min = '1'
    threshold.max = '5'
    threshold.value = '3'
    const thresholdOutput = element('output', 'mortise-v2-lab-range-value', '3 of 5')
    const rangeRow = element('div', 'mortise-v2-lab-range-row')
    rangeRow.append(threshold, thresholdOutput)
    const save = element('button', 'mortise-v2-lab-button mortise-v2-lab-button-primary', 'Apply extension settings')
    save.type = 'button'
    const localState = element('p', 'mortise-v2-lab-local-state', 'Local extension state has not been applied yet.')
    details.append(
      detailsHeading,
      labeledControl('Workspace note', noteInput),
      labeledControl('Release priority', priority),
      automationRow,
      labeledControl('Approval threshold', rangeRow),
      save,
      localState,
    )
    content.append(listPanel, details)

    const footer = element('footer', 'mortise-v2-lab-footer')
    footer.append(
      element('span', undefined, `Locale ${context.locale}`),
      element('span', undefined, `Theme ${context.theme.mode}`),
      element('span', undefined, new Intl.DateTimeFormat(context.locale, { dateStyle: 'medium' }).format(new Date())),
    )

    const renderList = () => {
      list.replaceChildren()
      const query = search.value.trim().toLocaleLowerCase(context.locale)
      const visible = localItems.filter(item => `${item.title} ${item.owner} ${item.status}`.toLocaleLowerCase(context.locale).includes(query))
      if (visible.length === 0) {
        list.append(element('p', 'mortise-v2-lab-empty', 'No checks match this filter.'))
        return
      }
      for (const item of visible) {
        const row = element('article', 'mortise-v2-lab-list-row')
        row.dataset.itemId = item.id
        const checkbox = element('input')
        checkbox.type = 'checkbox'
        checkbox.checked = item.complete
        checkbox.setAttribute('aria-label', `Mark ${item.title} complete`)
        const copy = element('div', 'mortise-v2-lab-list-copy')
        copy.append(element('strong', undefined, item.title), element('span', undefined, item.owner))
        const status = element('span', `mortise-v2-lab-status mortise-v2-lab-status-${item.status.toLowerCase()}`, item.status)
        checkbox.addEventListener('change', () => {
          item.complete = checkbox.checked
          status.textContent = checkbox.checked ? 'Ready' : item.status
          status.className = `mortise-v2-lab-status mortise-v2-lab-status-${(checkbox.checked ? 'ready' : item.status.toLowerCase())}`
        }, { signal: context.signal })
        row.append(checkbox, copy, status)
        list.append(row)
      }
    }

    const renderView = () => {
      const pipeline = activeView === 'pipeline'
      pipelineTab.setAttribute('aria-selected', String(pipeline))
      rulesTab.setAttribute('aria-selected', String(!pipeline))
      listHeading.textContent = pipeline ? 'Readiness pipeline' : 'Policy preview'
      search.placeholder = pipeline ? 'Filter checks' : 'Filter policies'
      search.setAttribute('aria-label', search.placeholder)
      list.dataset.view = activeView
    }

    const closeDrawer = () => {
      if (drawer?.open) drawer.close()
      drawer?.remove()
      drawer = undefined
      openDrawer.focus()
    }

    const showDrawer = () => {
      if (drawer) return
      drawer = element('dialog', 'mortise-v2-lab-drawer-layer')
      drawer.dataset.mortiseV2LabPortal = 'true'
      drawer.setAttribute('aria-label', 'Extension command drawer')
      const hostStyle = getComputedStyle(context.root)
      for (const token of ['--background', '--foreground', '--card', '--muted', '--muted-foreground', '--accent', '--border', '--primary', '--primary-foreground']) {
        drawer.style.setProperty(token, hostStyle.getPropertyValue(token))
      }
      const backdrop = element('button', 'mortise-v2-lab-drawer-backdrop')
      backdrop.type = 'button'
      backdrop.setAttribute('aria-label', 'Close command drawer')
      const panel = element('section', 'mortise-v2-lab-drawer')
      const close = element('button', 'mortise-v2-lab-icon-button', 'Close')
      close.type = 'button'
      const run = element('button', 'mortise-v2-lab-command', 'Run all readiness checks')
      run.type = 'button'
      const exportState = element('button', 'mortise-v2-lab-command', 'Export workspace snapshot')
      exportState.type = 'button'
      panel.append(
        element('p', 'mortise-v2-lab-eyebrow', 'Direct host DOM portal'),
        element('h3', 'mortise-v2-lab-drawer-title', 'Commands'),
        element('p', 'mortise-v2-lab-subtitle', 'This drawer is mounted under document.body and removed by the extension disposer.'),
        run,
        exportState,
        close,
      )
      drawer.append(backdrop, panel)
      document.body.append(drawer)
      drawer.showModal()
      drawer.addEventListener('cancel', (event) => { event.preventDefault(); closeDrawer() }, { signal: context.signal })
      backdrop.addEventListener('click', closeDrawer, { signal: context.signal })
      close.addEventListener('click', closeDrawer, { signal: context.signal })
      run.addEventListener('click', () => {
        for (const item of localItems) item.complete = true
        renderList()
        context.notify('All extension-owned checks completed', 'success')
      }, { signal: context.signal })
      exportState.addEventListener('click', () => context.notify('Workspace snapshot exported by the extension', 'info'), { signal: context.signal })
      close.focus()
    }

    pipelineTab.addEventListener('click', () => { activeView = 'pipeline'; renderView() }, { signal: context.signal })
    rulesTab.addEventListener('click', () => { activeView = 'rules'; renderView() }, { signal: context.signal })
    search.addEventListener('input', renderList, { signal: context.signal })
    threshold.addEventListener('input', () => { thresholdOutput.textContent = `${threshold.value} of 5` }, { signal: context.signal })
    save.addEventListener('click', () => {
      const note = `${noteInput.value.trim() || 'Ready'} | ${priority.value} | threshold ${threshold.value}`
      localState.textContent = `Applied locally: ${note}`
      context.notify('Extension-owned settings applied', 'success')
    }, { signal: context.signal })
    openDrawer.addEventListener('click', showDrawer, { signal: context.signal })

    const unregisterSemantics = [
      context.semantics.register('lab.control-center', context.root),
      context.semantics.register('lab.pipeline', listPanel),
      context.semantics.register('lab.workspace-controls', details),
    ]
    renderList()
    renderView()
    context.root.append(header, stats, tabs, content, footer)

    return () => {
      for (const unregister of unregisterSemantics) unregister()
      drawer?.remove()
      context.root.replaceChildren()
      context.root.removeAttribute('class')
      context.root.removeAttribute('data-theme')
      context.root.removeAttribute('lang')
      if (previousBodyMarker === undefined) delete document.body.dataset.mortiseV2Lab
      else document.body.dataset.mortiseV2Lab = previousBodyMarker
    }
  },
})

export const mount = definition.mount
