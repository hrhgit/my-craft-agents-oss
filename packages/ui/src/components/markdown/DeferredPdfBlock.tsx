import * as React from 'react'
import { CodeBlock } from './CodeBlock'
import { PDF_INLINE_BLOCK_HEIGHT } from './preview-layout'

type PdfBlockModule = typeof import('./MarkdownPdfBlock')
type PdfBlockLoader = () => Promise<PdfBlockModule>

class DeferredPdfErrorBoundary extends React.Component<
  { children: React.ReactNode; code: string },
  { hasError: boolean }
> {
  state = { hasError: false }

  static getDerivedStateFromError() {
    return { hasError: true }
  }

  componentDidCatch(error: Error) {
    console.warn('[DeferredPdfBlock] PDF preview chunk failed to load:', error)
  }

  render() {
    if (this.state.hasError) {
      return <CodeBlock code={this.props.code} language="json" mode="full" className="my-2" />
    }
    return this.props.children
  }
}

export function createDeferredPdfBlock(
  loadPdfBlock: PdfBlockLoader,
): React.ComponentType<{ code: string }> {
  const LazyPdfBlock = React.lazy(() =>
    loadPdfBlock().then(module => ({ default: module.MarkdownPdfBlock })),
  )

  return function DeferredPdfBlock({ code }: { code: string }) {
    return (
      <DeferredPdfErrorBoundary code={code}>
        <React.Suspense
          fallback={(
            <div
              className="my-2 rounded-[8px] bg-muted/20"
              style={{ height: `${PDF_INLINE_BLOCK_HEIGHT}px` }}
              aria-busy="true"
            />
          )}
        >
          <LazyPdfBlock code={code} className="my-2" />
        </React.Suspense>
      </DeferredPdfErrorBoundary>
    )
  }
}

export const DeferredPdfBlock = createDeferredPdfBlock(() => import('./MarkdownPdfBlock'))

