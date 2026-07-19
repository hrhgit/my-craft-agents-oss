/**
 * DocumentFormattedMarkdownOverlay - Fullscreen view for reading AI responses and plans
 *
 * Renders markdown content in a document-like format with:
 * - Centered content card with max-width
 * - Copy button via FullscreenOverlayBase's built-in copyContent prop
 * - Optional "Plan" header variant
 * - Optional filePath badge with dual-trigger menu (Open / Reveal in {file manager})
 *
 * Background and scenic blur are provided by FullscreenOverlayBase.
 * Uses FullscreenOverlayBase for portal, traffic lights, ESC handling, and header.
 */

import { useEffect, useState, type ReactNode } from 'react'
import { ListTodo } from 'lucide-react'
import { Markdown } from '../markdown'
import type { AnnotationV1 } from '@mortise/core'
import type { ExternalOpenAnnotationRequest } from '../annotations/use-annotation-interaction-controller'
import { FullscreenOverlayBase } from './FullscreenOverlayBase'
import type { OverlayTypeBadge } from './FullscreenOverlayBaseHeader'
import { AnnotatableMarkdownDocument } from './AnnotatableMarkdownDocument'

export interface DocumentFormattedMarkdownOverlayProps {
  /** The content to display (markdown) */
  content: string
  /** Whether the overlay is open */
  isOpen: boolean
  /** Called when overlay should close */
  onClose: () => void
  /** Variant: 'response' (default) or 'plan' (shows header) */
  variant?: 'response' | 'plan'
  /** Callback for URL clicks */
  onOpenUrl?: (url: string) => void
  /** Callback for file path clicks */
  onOpenFile?: (path: string) => void
  /** Optional file path — shows badge with "Open" / "Reveal in {file manager}" menu */
  filePath?: string
  /** Optional type badge — tool/format indicator (e.g. "Write") shown in header */
  typeBadge?: OverlayTypeBadge
  /** Optional error message — renders a tinted error banner above the content card */
  error?: string
  /** Optional session id used for annotation payload source metadata */
  sessionId?: string
  /** Optional message id; when present with callbacks, overlay becomes annotatable */
  messageId?: string
  /** Persisted annotations for the message */
  annotations?: AnnotationV1[]
  /** Callback to add annotation */
  onAddAnnotation?: (messageId: string, annotation: AnnotationV1) => void
  /** Callback to remove annotation */
  onRemoveAnnotation?: (messageId: string, annotationId: string) => void
  /** Callback to update annotation */
  onUpdateAnnotation?: (messageId: string, annotationId: string, patch: Partial<AnnotationV1>) => void
  /** Input send key behavior used by follow-up editor */
  sendMessageKey?: 'enter' | 'cmd-enter'
  /** Whether source content is currently streaming (affects annotation eligibility parity) */
  isStreaming?: boolean
  /** Optional external request to open a specific annotation */
  openAnnotationRequest?: ExternalOpenAnnotationRequest | null
  /** Optional host-rendered companion pane, such as an artifact review. */
  aside?: ReactNode
  /** User-facing title for the companion pane. */
  asideTitle?: string
}

export function DocumentFormattedMarkdownOverlay({
  content,
  isOpen,
  onClose,
  variant = 'response',
  onOpenUrl,
  onOpenFile,
  filePath,
  typeBadge,
  error,
  sessionId,
  messageId,
  annotations,
  onAddAnnotation,
  onRemoveAnnotation,
  onUpdateAnnotation,
  sendMessageKey = 'enter',
  isStreaming = false,
  openAnnotationRequest,
  aside,
  asideTitle = 'Review',
}: DocumentFormattedMarkdownOverlayProps) {
  const [activePane, setActivePane] = useState<'primary' | 'aside'>('primary')

  useEffect(() => {
    if (isOpen) setActivePane('primary')
  }, [isOpen])

  const documentContent = (
    <div className="px-6 py-6 @2xl/document-overlay:px-10 @2xl/document-overlay:py-8">
      <div className="text-sm">
        {messageId && onAddAnnotation ? (
          <AnnotatableMarkdownDocument
            content={content}
            sessionId={sessionId}
            messageId={messageId}
            annotations={annotations}
            onAddAnnotation={onAddAnnotation}
            onRemoveAnnotation={onRemoveAnnotation}
            onUpdateAnnotation={onUpdateAnnotation}
            onOpenUrl={onOpenUrl}
            onOpenFile={onOpenFile}
            sendMessageKey={sendMessageKey}
            islandZIndex={420}
            openAnnotationRequest={openAnnotationRequest}
            isStreaming={isStreaming}
          />
        ) : (
          <Markdown mode="minimal" onUrlClick={onOpenUrl} onFileClick={onOpenFile} hideFirstMermaidExpand={false}>
            {content}
          </Markdown>
        )}
      </div>
    </div>
  )

  return (
    <FullscreenOverlayBase
      isOpen={isOpen}
      onClose={onClose}
      dismissOnOutsideClick
      filePath={filePath}
      typeBadge={typeBadge}
      copyContent={content}
      error={error ? { label: 'Write Failed', message: error } : undefined}
    >
      {/* Content wrapper — min-h-full for vertical centering within FullscreenOverlayBase's scroll container.
          Scrolling and gradient fade mask are handled by FullscreenOverlayBase. */}
      <div className="min-h-full flex flex-col justify-center px-6 py-16">
        {/* Content card - my-auto centers vertically when content is small, flows naturally when large */}
        <div
          className="@container/document-overlay bg-background rounded-[16px] shadow-strong w-full max-w-[960px] h-fit mx-auto my-auto overflow-hidden"
          data-fullscreen-overlay-dismiss-boundary
        >
          {/* Plan header (variant="plan" only) */}
          {variant === 'plan' && (
            <div className="px-4 py-2 border-b border-border/30 flex items-center gap-2 bg-success/5 rounded-t-[16px]">
              <ListTodo className="w-3 h-3 text-success" />
              <span className="text-[13px] font-medium text-success">Plan</span>
            </div>
          )}

          {aside ? (
            <>
              <div className="flex border-b border-border/30 bg-muted/15 p-1 @2xl/document-overlay:hidden" role="tablist" aria-label="Document views">
                <button type="button" role="tab" aria-selected={activePane === 'primary'} onClick={() => setActivePane('primary')} className={`min-h-9 flex-1 rounded-[6px] px-3 text-xs font-medium ${activePane === 'primary' ? 'bg-background text-foreground shadow-minimal' : 'text-muted-foreground'}`}>Plan</button>
                <button type="button" role="tab" aria-selected={activePane === 'aside'} onClick={() => setActivePane('aside')} className={`min-h-9 flex-1 rounded-[6px] px-3 text-xs font-medium ${activePane === 'aside' ? 'bg-background text-foreground shadow-minimal' : 'text-muted-foreground'}`}>{asideTitle}</button>
              </div>
              <div className="@2xl/document-overlay:grid @2xl/document-overlay:grid-cols-2">
                <div className={activePane === 'primary' ? 'min-w-0' : 'hidden min-w-0 @2xl/document-overlay:block'} role="tabpanel">{documentContent}</div>
                <aside className={`${activePane === 'aside' ? 'min-w-0' : 'hidden min-w-0 @2xl/document-overlay:block'} border-border/30 @2xl/document-overlay:border-l`} role="tabpanel" aria-label={asideTitle}>
                  <div className="hidden h-10 items-center border-b border-border/30 bg-muted/15 px-5 text-xs font-medium text-muted-foreground @2xl/document-overlay:flex">{asideTitle}</div>
                  <div className="px-6 py-6 text-sm @2xl/document-overlay:px-8 @2xl/document-overlay:py-8">{aside}</div>
                </aside>
              </div>
            </>
          ) : documentContent}
        </div>
      </div>
    </FullscreenOverlayBase>
  )
}
