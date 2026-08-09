import * as React from 'react'
import { AlertCircle, ArrowUp, Paperclip, RefreshCw, Square, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import type { RichTextInputHandle } from '@/components/ui/rich-text-input'
import { coerceInputText } from '@/lib/input-text'
import { cn } from '@/lib/utils'
import type { FileAttachment } from '../../../../shared/types'
import type { FreeFormInputProps } from './FreeFormInput'
import { snapshotComposerSubmission } from './composer-submission'

interface BasicComposerTextareaProps {
  value: string
  onValueChange: (value: string) => void
  onSubmit?: () => void
  onPaste?: React.ClipboardEventHandler<HTMLTextAreaElement>
  onFocus?: () => void
  onBlur?: () => void
  placeholder?: string
  disabled?: boolean
  maxHeight?: number
  onRetry?: () => void
  className?: string
}

export const BasicComposerTextarea = React.forwardRef<RichTextInputHandle, BasicComposerTextareaProps>(
  function BasicComposerTextarea({
    value,
    onValueChange,
    onSubmit,
    onPaste,
    onFocus,
    onBlur,
    placeholder,
    disabled,
    maxHeight,
    onRetry,
    className,
  }, forwardedRef) {
    const { t } = useTranslation()
    const textareaRef = React.useRef<HTMLTextAreaElement>(null)
    const [internalValue, setInternalValue] = React.useState(value)

    React.useEffect(() => {
      setInternalValue(value)
    }, [value])

    React.useImperativeHandle(forwardedRef, () => ({
      focus: () => textareaRef.current?.focus(),
      blur: () => textareaRef.current?.blur(),
      get value() { return textareaRef.current?.value ?? internalValue },
      get isEmpty() { return (textareaRef.current?.value ?? internalValue).trim().length === 0 },
      get selectionStart() { return textareaRef.current?.selectionStart ?? internalValue.length },
      setValue: nextValue => {
        setInternalValue(nextValue)
        onValueChange(nextValue)
      },
      replaceTextRange: (start, end, text) => {
        const nextValue = internalValue.slice(0, start) + text + internalValue.slice(end)
        setInternalValue(nextValue)
        onValueChange(nextValue)
      },
      setSelectionRange: (start, end) => textareaRef.current?.setSelectionRange(start, end),
      getBoundingClientRect: () => textareaRef.current?.getBoundingClientRect() ?? new DOMRect(),
      getCaretRect: () => null,
      element: null,
    }), [internalValue, onValueChange])

    return (
      <div className="relative">
        <textarea
          ref={textareaRef}
          value={internalValue}
          onChange={event => {
            const nextValue = event.currentTarget.value
            setInternalValue(nextValue)
            onValueChange(nextValue)
          }}
          onKeyDown={event => {
            if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
            event.preventDefault()
            onSubmit?.()
          }}
          onPaste={onPaste}
          onFocus={onFocus}
          onBlur={onBlur}
          placeholder={placeholder}
          disabled={disabled}
          rows={3}
          className={cn(
            'block min-h-[72px] w-full resize-none bg-transparent pb-2 pl-5 pr-12 pt-3 text-sm text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50',
            className,
          )}
          style={maxHeight ? { maxHeight, overflowY: 'auto' } : undefined}
        />
        {onRetry && (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="absolute right-2 top-2 h-8 w-8"
            aria-label={t('common.retry')}
            title={t('common.retry')}
            onClick={onRetry}
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
        )}
      </div>
    )
  },
)

export function InputControlFallback({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation()
  return (
    <Button
      type="button"
      size="icon"
      variant="ghost"
      className="h-8 w-8 text-destructive"
      aria-label={t('chat.inputFailedTitle')}
      title={t('chat.inputFailedTitle')}
      onClick={onRetry}
    >
      <RefreshCw className="h-4 w-4" />
    </Button>
  )
}

export function createDegradedComposerSubmission(text: string, attachments: FileAttachment[]) {
  return snapshotComposerSubmission({
    composerText: text,
    message: text.trim(),
    attachments,
  })
}

interface DegradedComposerProps {
  sessionId: string
  inputProps: FreeFormInputProps
  onRetry: () => void
}

export function DegradedComposer({ sessionId, inputProps, onRetry }: DegradedComposerProps) {
  const { t } = useTranslation()
  const {
    attachmentsValue,
    disableSend,
    disabled,
    inputValue,
    isProcessing,
    onAttachmentsChange,
    onInputChange,
    onStop,
    onSubmit,
    placeholder: configuredPlaceholder,
  } = inputProps
  const externalValue = coerceInputText(inputValue)
  const [value, setValue] = React.useState(externalValue)
  const [submitting, setSubmitting] = React.useState(false)
  const attachments = React.useMemo(
    () => Array.isArray(attachmentsValue) ? attachmentsValue : [],
    [attachmentsValue],
  )
  const placeholder = Array.isArray(configuredPlaceholder)
    ? configuredPlaceholder[0]
    : configuredPlaceholder

  React.useEffect(() => {
    setValue(externalValue)
  }, [externalValue, sessionId])

  const updateValue = React.useCallback((nextValue: string) => {
    setValue(nextValue)
    onInputChange?.(nextValue)
  }, [onInputChange])

  const clearAttachments = React.useCallback(() => {
    onAttachmentsChange?.([])
  }, [onAttachmentsChange])

  const submit = React.useCallback(async () => {
    const message = value.trim()
    if (submitting || disabled || disableSend) return
    if (!message && attachments.length === 0) return

    setSubmitting(true)
    try {
      const accepted = await onSubmit(createDegradedComposerSubmission(value, attachments))
      if (!accepted) return
      updateValue('')
      clearAttachments()
    } catch (error) {
      console.error('[DegradedComposer] Submission failed:', error)
    } finally {
      setSubmitting(false)
    }
  }, [attachments, clearAttachments, disableSend, disabled, onSubmit, submitting, updateValue, value])

  const hasContent = value.trim().length > 0 || attachments.length > 0

  return (
    <form
      className="relative overflow-hidden rounded-[12px] bg-background shadow-middle"
      onSubmit={event => {
        event.preventDefault()
        void submit()
      }}
      data-mortise-semantic-id={`composer.${sessionId}.degraded`}
    >
      <div className="flex items-center gap-2 border-b border-border/50 px-3 py-2 text-xs text-muted-foreground">
        <AlertCircle className="h-4 w-4 text-destructive" />
        <span>{t('chat.inputFailedTitle')}</span>
      </div>
      <BasicComposerTextarea
        value={value}
        onValueChange={updateValue}
        onSubmit={() => void submit()}
        placeholder={placeholder ?? t('chatInput.placeholder.typeMessage')}
        disabled={disabled}
        onRetry={onRetry}
      />
      <div className="flex min-h-12 items-center gap-2 px-2 py-1.5">
        {attachments.length > 0 && (
          <>
            <div className="inline-flex items-center gap-1.5 px-2 text-xs text-muted-foreground">
              <Paperclip className="h-4 w-4" />
              {t('chat.filesCount', { count: attachments.length })}
            </div>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="h-8 w-8"
              aria-label={t('chat.clearDraft')}
              title={t('chat.clearDraft')}
              onClick={clearAttachments}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </>
        )}
        <div className="flex-1" />
        {isProcessing ? (
          <Button
            type="button"
            size="icon"
            variant="secondary"
            className="h-10 w-10 rounded-full"
            aria-label={t('chat.stopResponse')}
            onClick={() => onStop?.(false)}
          >
            <Square className="h-3 w-3 fill-current" />
          </Button>
        ) : (
          <Button
            type="submit"
            size="icon"
            className="h-10 w-10 rounded-full"
            aria-label={t('shortcuts.sendMessage')}
            disabled={!hasContent || submitting || disabled || disableSend}
          >
            <ArrowUp className="h-[18px] w-[18px]" />
          </Button>
        )}
      </div>
    </form>
  )
}
