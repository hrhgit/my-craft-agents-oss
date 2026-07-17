import { describe, expect, it, mock } from 'bun:test'
import { createInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { renderToStaticMarkup } from 'react-dom/server'

mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: 'pdf.worker.js' }))
mock.module('react-pdf', () => ({
  Document: () => null,
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: {} },
}))

const { WorkbenchToolPicker } = await import('./RightWorkbench')
type WorkbenchTool = import('./RightWorkbench').WorkbenchTool

const i18n = createInstance()
await i18n.use(initReactI18next).init({
  lng: 'en',
  resources: { en: { translation: { 'workbench.tools': 'Tools' } } },
})

const tools: WorkbenchTool[] = [{
  id: 'files',
  label: 'Files',
  icon: () => null,
}]

function renderPicker(scope: string): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <WorkbenchToolPicker
        tools={tools}
        onSelect={() => {}}
        semanticId="workspace.empty-page"
        semanticScope={scope}
        onCreateSession={() => {}}
      />
    </I18nextProvider>,
  )
}

describe('WorkbenchToolPicker semantic identity', () => {
  it('scopes repeated empty-page targets to their owning tab', () => {
    const first = renderPicker('dock:content-picker:first')
    const second = renderPicker('dock:content-picker:second')

    expect(first).toContain('workspace.empty-page.dock%3Acontent-picker%3Afirst')
    expect(first).toContain('workspace.empty-page.new-session.dock%3Acontent-picker%3Afirst')
    expect(first).toContain('workspace.content.choose.files.dock%3Acontent-picker%3Afirst')
    expect(second).toContain('workspace.content.choose.files.dock%3Acontent-picker%3Asecond')
    expect(second).not.toContain('workspace.content.choose.files.dock%3Acontent-picker%3Afirst')
  })
})
