/**
 * RemoteUIModal — 渲染 pi 扩展通过 `remoteui:request` 发起的交互式对话框。
 *
 * 处理两种 kind：
 *  - "select"：显示 title + options（title/description），支持 allowMultiple（多选）、
 *    allowFreeform（自由输入）、allowComment（附加评论）。
 *  - "editor"：弹出文本编辑框，预填 prefill 内容。
 *
 * 键盘操作：
 *  - Enter 确认（在 select 列表上直接生效；在 textarea 中需 Cmd/Ctrl+Enter 以便输入换行）
 *  - Esc / 关闭按钮 / 点击遮罩 取消
 *
 * 兼容性：与 ask_user 扩展（C:\Users\32858\.pi\agent\extensions\ask_user\index.ts）完全兼容——
 * ask_user 始终以 allowFreeform=true 发起 select 请求，并在响应中优先读取 freeformText
 * （非空时作为自由作答），否则读取 selections；取消时 payload=null + reason="cancelled"。
 * 本组件按此契约构造 payload。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, X } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

// ---------------------------------------------------------------------------
// 协议类型（镜像 plan-mode/remote-ui.ts，并与 ExtensionBridgeEvent 的 remoteui_request 对齐）
// ---------------------------------------------------------------------------

export interface RemoteUIOption {
  title: string
  description?: string
}

export interface RemoteUISelectRequest {
  type: 'remoteui_request'
  requestId: string
  kind: 'select'
  title: string
  message?: string
  options: RemoteUIOption[]
  allowMultiple?: boolean
  allowFreeform?: boolean
  allowComment?: boolean
  source: string
  sessionId: string
  extensionId: string
  runtimeId: string
  timeout?: number
}

export interface RemoteUIConfirmRequest {
  type: 'remoteui_request'
  requestId: string
  kind: 'confirm'
  title: string
  message: string
  source: string
  sessionId: string
  extensionId: string
  runtimeId: string
  timeout?: number
}

export interface RemoteUIEditorRequest {
  type: 'remoteui_request'
  requestId: string
  kind: 'editor'
  title: string
  prefill?: string
  source: string
  sessionId: string
  extensionId: string
  runtimeId: string
  timeout?: number
}

export type RemoteUIRequest = RemoteUISelectRequest | RemoteUIConfirmRequest | RemoteUIEditorRequest

export interface RemoteUISelectResult {
  selections: string[]
  freeformText?: string
  comment?: string
}

export interface RemoteUIEditorResult {
  text: string
}

export interface RemoteUIConfirmResult {
  confirmed: boolean
}

export type RemoteUIResult = RemoteUISelectResult | RemoteUIConfirmResult | RemoteUIEditorResult

export type RemoteUICancelReason = 'cancelled'

export interface RemoteUIModalProps {
  /** 当前活跃的 remoteui_request 事件 */
  request: RemoteUIRequest
  /** 用户确认时调用，payload 为结果；用户取消时 payload=null + reason="cancelled" */
  onRespond: (payload: RemoteUIResult | null, reason?: RemoteUICancelReason) => void
}

// ---------------------------------------------------------------------------
// 类型守卫
// ---------------------------------------------------------------------------

function isSelectRequest(req: RemoteUIRequest): req is RemoteUISelectRequest {
  return req.kind === 'select'
}

// ---------------------------------------------------------------------------
// 主组件
// ---------------------------------------------------------------------------

export function RemoteUIModal({ request, onRespond }: RemoteUIModalProps) {
  if (isSelectRequest(request)) {
    return <SelectModal request={request} onRespond={onRespond} />
  }
  if (request.kind === 'confirm') {
    return <ConfirmModal request={request} onRespond={onRespond} />
  }
  return <EditorModal request={request} onRespond={onRespond} />
}

function ConfirmModal({
  request,
  onRespond,
}: {
  request: RemoteUIConfirmRequest
  onRespond: (payload: RemoteUIResult | null, reason?: RemoteUICancelReason) => void
}) {
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onRespond(null, 'cancelled') }}>
      <DialogContent className="sm:max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{request.title}</DialogTitle>
          <DialogDescription className="whitespace-pre-wrap">{request.message}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onRespond({ confirmed: false })}>Cancel</Button>
          <Button onClick={() => onRespond({ confirmed: true })}>Confirm</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Select 模式
// ---------------------------------------------------------------------------

interface SelectModalProps {
  request: RemoteUISelectRequest
  onRespond: (payload: RemoteUIResult | null, reason?: RemoteUICancelReason) => void
}

function SelectModal({ request, onRespond }: SelectModalProps) {
  const { options = [], allowMultiple = false, allowFreeform = false, allowComment = false } = request
  const [selected, setSelected] = useState<string[]>([])
  const [freeformText, setFreeformText] = useState('')
  const [comment, setComment] = useState('')

  // 切换请求时重置内部状态
  useEffect(() => {
    setSelected([])
    setFreeformText('')
    setComment('')
  }, [request.requestId])

  const toggleOption = (title: string) => {
    setSelected((prev) => {
      if (allowMultiple) {
        return prev.includes(title) ? prev.filter((t) => t !== title) : [...prev, title]
      }
      // 单选：再次点击同一项取消选择
      return prev.includes(title) ? [] : [title]
    })
  }

  const trimmedFreeform = freeformText.trim()
  const trimmedComment = comment.trim()
  const canConfirm = selected.length > 0 || trimmedFreeform.length > 0

  const handleConfirm = () => {
    if (!canConfirm) return
    const payload: RemoteUISelectResult = {
      selections: selected,
      ...(trimmedFreeform ? { freeformText: trimmedFreeform } : {}),
      ...(trimmedComment ? { comment: trimmedComment } : {}),
    }
    onRespond(payload)
  }

  const handleCancel = () => {
    onRespond(null, 'cancelled')
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      handleCancel()
      return
    }
    if (e.key === 'Enter') {
      const target = e.target as HTMLElement
      const inTextarea = target.tagName === 'TEXTAREA'
      // 在 textarea 中需 Cmd/Ctrl+Enter 才确认，普通 Enter 用于换行
      if (inTextarea && !(e.metaKey || e.ctrlKey)) return
      e.preventDefault()
      handleConfirm()
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) handleCancel() }}>
      <DialogContent
        className="sm:max-w-lg"
        showCloseButton={false}
        onKeyDown={handleKeyDown}
      >
        <DialogHeader>
          <DialogTitle className="pr-6">{request.title}</DialogTitle>
          {request.message && (
            <DialogDescription className="whitespace-pre-wrap">
              {request.message}
            </DialogDescription>
          )}
        </DialogHeader>

        {/* 选项列表 */}
        <div className="flex max-h-[40vh] flex-col gap-1 overflow-y-auto">
          {options.map((option, index) => {
            const isSelected = selected.includes(option.title)
            return (
              <button
                key={`${option.title}-${index}`}
                type="button"
                onClick={() => toggleOption(option.title)}
                className={cn(
                  'flex w-full items-start gap-2 rounded-md border px-3 py-2 text-left transition-colors',
                  isSelected
                    ? 'border-foreground/40 bg-foreground/5'
                    : 'border-transparent hover:bg-foreground/3',
                )}
              >
                <span
                  className={cn(
                    'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                    isSelected
                      ? 'border-foreground bg-foreground text-background'
                      : 'border-foreground/30',
                  )}
                  aria-hidden
                >
                  {isSelected && <Check className="h-3 w-3" />}
                </span>
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-sm font-medium leading-tight">{option.title}</span>
                  {option.description && (
                    <span className="text-xs text-muted-foreground">{option.description}</span>
                  )}
                </span>
              </button>
            )
          })}
          {options.length === 0 && (
            <p className="py-2 text-xs text-muted-foreground">No options provided.</p>
          )}
        </div>

        {/* 自由输入 */}
        {allowFreeform && (
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              Write my own answer
            </label>
            <Textarea
              value={freeformText}
              onChange={(e) => setFreeformText(e.target.value)}
              placeholder="Type a custom response..."
              className="min-h-20 text-sm"
              rows={3}
            />
          </div>
        )}

        {/* 附加评论 */}
        {allowComment && (
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              Additional comment (optional)
            </label>
            <Textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Add extra context after selection..."
              className="min-h-16 text-sm"
              rows={2}
            />
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={handleCancel}>
            <X className="h-3.5 w-3.5" />
            Cancel
          </Button>
          <Button onClick={handleConfirm} disabled={!canConfirm}>
            <Check className="h-3.5 w-3.5" />
            Confirm
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Editor 模式
// ---------------------------------------------------------------------------

interface EditorModalProps {
  request: RemoteUIEditorRequest
  onRespond: (payload: RemoteUIResult | null, reason?: RemoteUICancelReason) => void
}

function EditorModal({ request, onRespond }: EditorModalProps) {
  const [text, setText] = useState(request.prefill ?? '')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // 切换请求时重置为 prefill 并聚焦
  useEffect(() => {
    setText(request.prefill ?? '')
    // 聚焦并将光标移到末尾
    const el = textareaRef.current
    if (el) {
      el.focus()
      const len = el.value.length
      el.setSelectionRange(len, len)
    }
  }, [request.requestId, request.prefill])

  const trimmedText = text.trim()
  const canConfirm = trimmedText.length > 0

  const handleConfirm = () => {
    if (!canConfirm) return
    onRespond({ text: trimmedText })
  }

  const handleCancel = () => {
    onRespond(null, 'cancelled')
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      handleCancel()
      return
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      handleConfirm()
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) handleCancel() }}>
      <DialogContent
        className="sm:max-w-lg"
        showCloseButton={false}
        onKeyDown={handleKeyDown}
      >
        <DialogHeader>
          <DialogTitle className="pr-6">{request.title}</DialogTitle>
        </DialogHeader>

        <Textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Type your answer..."
          className="min-h-32 text-sm"
          rows={8}
        />

        <DialogFooter>
          <Button variant="outline" onClick={handleCancel}>
            <X className="h-3.5 w-3.5" />
            Cancel
          </Button>
          <Button onClick={handleConfirm} disabled={!canConfirm}>
            <Check className="h-3.5 w-3.5" />
            Confirm
          </Button>
        </DialogFooter>

        <p className="text-[10px] text-muted-foreground">
          Press Cmd/Ctrl+Enter to confirm, Esc to cancel.
        </p>
      </DialogContent>
    </Dialog>
  )
}
