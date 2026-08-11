import * as React from 'react'
import { Extension, Node, mergeAttributes, type Editor as TiptapEditor } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Fragment, Slice, type Node as ProseMirrorNode } from '@tiptap/pm/model'
import { EditorContent, NodeViewWrapper, ReactNodeViewRenderer, useEditor, type ReactNodeViewProps } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import Suggestion from '@tiptap/suggestion'
import { FileText, FolderOpen, Sparkles } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { findMentionMatches, type MentionMatch } from '@/lib/mentions'
import type { LoadedSkill } from '../../../../shared/types'
import { cn } from '@/lib/utils'
import { coerceInputText } from '@/lib/input-text'
import { EMOJI_ICON_PREFIX, getEntityIconSync, loadEntityIcon } from '@/lib/icon-cache'
import { findSmartTypographyReplacement } from '@/lib/smart-typography'
import {
  markComposerInputFrame,
  measureComposerPerformance,
} from '@/lib/composer-performance'

const LONG_TEXT_LINE_THRESHOLD = 100

export interface ComposerEditorHandle {
  focus: () => void
  blur: () => void
  readonly value: string
  readonly isEmpty: boolean
  readonly selectionStart: number
  setValue: (value: string) => void
  replaceTextRange?: (start: number, end: number, text: string) => void
  setSelectionRange: (start: number, end: number) => void
  getBoundingClientRect: () => DOMRect
  getCaretRect: () => DOMRect | null
  readonly element: HTMLElement | null
}

export interface ComposerEditorProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'onChange' | 'onInput' | 'onPaste'> {
  value: string
  onChange?: (value: string) => void
  onTransaction?: (state: { isEmpty: boolean }) => void
  onInput?: (value: string, cursorPosition: number) => void
  onSuggestionChange?: (kind: 'slash' | 'mention', value: string, cursorPosition: number) => void
  onSuggestionExit?: (kind: 'slash' | 'mention') => void
  onPaste?: (event: React.ClipboardEvent) => void
  onLongTextPaste?: (text: string) => void
  placeholder?: string | string[]
  skills?: LoadedSkill[]
  workspaceId?: string
  disabled?: boolean
  autoCapitalisation?: boolean
  semanticId?: string
  onFocus?: (event: React.FocusEvent<HTMLDivElement>) => void
  onBlur?: (event: React.FocusEvent<HTMLDivElement>) => void
  onKeyDown?: (event: React.KeyboardEvent<HTMLDivElement>) => void
}

type MentionAttrs = {
  kind: 'skill' | 'file' | 'folder'
  id: string
  rawText: string
  label: string
  iconUrl?: string
  tooltip?: string
}

function mentionAttrs(match: MentionMatch, skills: LoadedSkill[], workspaceId?: string): MentionAttrs {
  const skill = match.type === 'skill' ? skills.find(item => item.slug === match.id) : undefined
  return {
    kind: match.type,
    id: match.id,
    rawText: match.fullMatch,
    label: match.type === 'skill' ? (skill?.metadata.name || match.id) : (match.id.split('/').pop() || match.id),
    iconUrl: match.type === 'skill' && skill && workspaceId
      ? getEntityIconSync({ entityType: 'skill', workspaceId, identifier: skill.slug }) ?? undefined
      : undefined,
    tooltip: match.type === 'skill' ? undefined : match.id,
  }
}

function MentionNodeView({ node }: ReactNodeViewProps) {
  const attrs = node.attrs as MentionAttrs
  const Icon = attrs.kind === 'skill' ? Sparkles : attrs.kind === 'folder' ? FolderOpen : FileText
  const emoji = attrs.iconUrl?.startsWith(EMOJI_ICON_PREFIX)
    ? attrs.iconUrl.slice(EMOJI_ICON_PREFIX.length)
    : undefined
  return (
    <NodeViewWrapper
      as="span"
      contentEditable={false}
      data-mention="true"
      data-mention-text={attrs.rawText}
      title={attrs.tooltip}
      className="mention-badge inline-flex h-[22px] select-none items-center gap-1 rounded-[5px] bg-background px-1.5 mx-1 text-[12px] text-foreground shadow-minimal"
      style={{ verticalAlign: 'middle', transform: 'translateY(-1px)' }}
    >
      {emoji ? (
        <span className="flex h-3 w-3 shrink-0 items-center justify-center text-[10px] leading-none">{emoji}</span>
      ) : attrs.iconUrl ? (
        <img src={attrs.iconUrl} className="h-3 w-3 shrink-0 rounded-[2px]" alt="" />
      ) : (
        <Icon className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
      )}
      <span className="max-w-[200px] truncate">{attrs.label}</span>
    </NodeViewWrapper>
  )
}

const ComposerMention = Node.create({
  name: 'composerMention',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      kind: { default: 'file' },
      id: { default: '' },
      rawText: { default: '' },
      label: { default: '' },
      iconUrl: { default: null },
      tooltip: { default: null },
    }
  },
  parseHTML() {
    return [{ tag: 'span[data-mention="true"]' }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { 'data-mention': 'true' }), HTMLAttributes.label || HTMLAttributes.rawText || '']
  },
  renderText({ node }) {
    return node.attrs.rawText
  },
  addNodeView() {
    return ReactNodeViewRenderer(MentionNodeView)
  },
})

const ComposerMentionInputRules = Extension.create<{
  getSkills: () => LoadedSkill[]
  getWorkspaceId: () => string | undefined
}>({
  name: 'composerMentionInputRules',
  addOptions() {
    return {
      getSkills: () => [],
      getWorkspaceId: () => undefined,
    }
  },
  addProseMirrorPlugins() {
    return [new Plugin({
      appendTransaction: (transactions, _oldState, newState) => {
        if (!transactions.some(transaction => transaction.docChanged)) return null
        const { $from } = newState.selection
        const parent = $from.parent
        if (!parent.isTextblock) return null
        const mentionType = newState.schema.nodes.composerMention
        if (!mentionType) return null
        const paragraphStart = $from.start()
        const transaction = newState.tr
        const replacements: Array<{ from: number; to: number; match: MentionMatch }> = []
        let offset = 0
        parent.forEach(node => {
          if (node.isText && node.text) {
            for (const match of findMentionMatches(node.text, this.options.getSkills().map(skill => skill.slug))) {
              replacements.push({
                from: paragraphStart + offset + match.startIndex,
                to: paragraphStart + offset + match.startIndex + match.fullMatch.length,
                match,
              })
            }
          }
          offset += node.nodeSize
        })
        for (const replacement of replacements.reverse()) {
          transaction.replaceWith(
            replacement.from,
            replacement.to,
            mentionType.create(mentionAttrs(replacement.match, this.options.getSkills(), this.options.getWorkspaceId())),
          )
        }
        return transaction.docChanged ? transaction : null
      },
    })]
  },
})

const slashSuggestionKey = new PluginKey('composerSlashSuggestion')
const mentionSuggestionKey = new PluginKey('composerMentionSuggestion')

function suggestionPrefixAllowed(editor: TiptapEditor, from: number, kind: 'slash' | 'mention'): boolean {
  const $from = editor.state.doc.resolve(from)
  if (from === $from.start()) return true
  const previous = editor.state.doc.textBetween(from - 1, from, '', () => '')
  return kind === 'slash' ? /\s/.test(previous) : /[\s("']/.test(previous)
}

const ComposerSuggestions = Extension.create<{
  notify: (kind: 'slash' | 'mention', editor: TiptapEditor) => void
  exit: (kind: 'slash' | 'mention') => void
}>({
  name: 'composerSuggestions',
  addOptions() {
    return {
      notify: () => undefined,
      exit: () => undefined,
    }
  },
  addProseMirrorPlugins() {
    const createSuggestion = (kind: 'slash' | 'mention') => Suggestion({
      editor: this.editor,
      pluginKey: kind === 'slash' ? slashSuggestionKey : mentionSuggestionKey,
      char: kind === 'slash' ? '/' : '@',
      allowSpaces: kind === 'mention',
      allowedPrefixes: null,
      items: () => [],
      shouldShow: ({ editor, range, query }) => {
        const queryAllowed = kind === 'slash'
          ? /^[\w:-]*$/.test(query)
          : query.length <= 100 && /^[\w\-/\.\s]*$/.test(query)
        return queryAllowed && suggestionPrefixAllowed(editor, range.from, kind)
      },
      render: () => ({
        onStart: ({ editor }) => this.options.notify(kind, editor),
        onUpdate: ({ editor }) => this.options.notify(kind, editor),
        onExit: () => this.options.exit(kind),
      }),
    })

    return [createSuggestion('slash'), createSuggestion('mention')]
  },
})

const ComposerTextRules = Extension.create<{
  getAutoCapitalisation: () => boolean
  getComposing: () => boolean
}>({
  name: 'composerTextRules',
  addOptions() {
    return {
      getAutoCapitalisation: () => true,
      getComposing: () => false,
    }
  },
  addProseMirrorPlugins() {
    return [new Plugin({
      appendTransaction: (transactions, _oldState, newState) => {
        if (this.options.getComposing() || !transactions.some(transaction => transaction.docChanged)) return null
        const transaction = newState.tr

        if (this.options.getAutoCapitalisation()) {
          const firstInline = newState.doc.firstChild?.firstChild
          const firstCharacter = firstInline?.isText ? firstInline.text?.charAt(0) ?? '' : ''
          if (firstCharacter && !['/', '@', '#'].includes(firstCharacter)) {
            const capitalized = firstCharacter.toUpperCase()
            if (capitalized !== firstCharacter) transaction.insertText(capitalized, 1, 2)
          }
        }

        const { $from, empty } = newState.selection
        if (empty && $from.parent.isTextblock && $from.parentOffset > 0) {
          const serialized = newState.doc.textBetween(0, $from.pos, '\n', composerLeafText)
          const replacement = findSmartTypographyReplacement(serialized, serialized.length)
          if (replacement) {
            const replacedLength = replacement.to - replacement.from
            transaction.insertText(replacement.text, $from.pos - 1 - replacedLength, $from.pos - 1)
          }
        }

        return transaction.docChanged ? transaction : null
      },
    })]
  },
})

export function composerTextToDocument(value: string, skills: LoadedSkill[] = [], workspaceId?: string) {
  const text = coerceInputText(value)
  const paragraphs = text.split('\n')
  return {
    type: 'doc',
    content: paragraphs.map(paragraph => ({
      type: 'paragraph',
      content: paragraph.length > 0 ? tokensToContent(paragraph, skills, workspaceId) : undefined,
    })),
  }
}

function tokensToContent(text: string, skills: LoadedSkill[], workspaceId?: string) {
  if (text.length === 0) return []
  const matches = findMentionMatches(text, skills.map(skill => skill.slug))
  if (matches.length === 0) return [{ type: 'text', text }]
  const content: Array<Record<string, unknown>> = []
  let cursor = 0
  for (const match of matches) {
    if (match.startIndex > cursor) content.push({ type: 'text', text: text.slice(cursor, match.startIndex) })
    content.push({ type: 'composerMention', attrs: mentionAttrs(match, skills, workspaceId) })
    cursor = match.startIndex + match.fullMatch.length
  }
  if (cursor < text.length) content.push({ type: 'text', text: text.slice(cursor) })
  return content
}

export function composerDocumentToText(document: { content?: Array<{ type?: string; text?: string; attrs?: { rawText?: string }; content?: unknown[] }> }): string {
  return (document.content ?? []).map(block => {
    if (block.type !== 'paragraph') return ''
    return (block.content ?? []).map(child => {
      if (child && typeof child === 'object' && 'text' in child) return String((child as { text?: string }).text ?? '')
      if (child && typeof child === 'object' && 'attrs' in child) return String((child as { attrs?: { rawText?: string } }).attrs?.rawText ?? '')
      return ''
    }).join('')
  }).join('\n')
}

function composerLeafText(node: ProseMirrorNode): string {
  return node.type.name === 'composerMention' ? String(node.attrs.rawText ?? '') : ''
}

function documentText(editor: TiptapEditor): string {
  return editor.state.doc.textBetween(0, editor.state.doc.content.size, '\n', composerLeafText)
}

function documentCursorOffset(editor: TiptapEditor): number {
  const { from } = editor.state.selection
  return editor.state.doc.textBetween(0, from, '\n', composerLeafText).length
}

function positionForTextOffset(editor: TiptapEditor, target: number): number {
  let position = 1
  let offset = 0
  let result = editor.state.doc.content.size
  editor.state.doc.descendants((node, pos) => {
    if (result !== editor.state.doc.content.size) return false
    if (node.isText) {
      const length = node.text?.length ?? 0
      if (target <= offset + length) {
        result = pos + Math.max(0, target - offset)
        return false
      }
      offset += length
    } else if (node.type.name === 'composerMention') {
      const length = String(node.attrs.rawText ?? '').length
      if (target <= offset) {
        result = pos
        return false
      }
      if (target <= offset + length) {
        result = pos + node.nodeSize
        return false
      }
      offset += length
    } else if (node.type.name === 'paragraph' && pos > position) {
      offset += 1
    }
    return true
  })
  return result
}

function setEditorText(editor: TiptapEditor, value: string, skills: LoadedSkill[], workspaceId?: string, cursor?: number) {
  editor.commands.setContent(composerTextToDocument(value, skills, workspaceId), { emitUpdate: false })
  if (cursor !== undefined) {
    const position = positionForTextOffset(editor, cursor)
    editor.commands.setTextSelection(position)
  }
}

function isEscapeDuringComposition(
  event: { key?: string; isComposing?: boolean; nativeEvent?: { isComposing?: boolean } },
  composing: boolean,
): boolean {
  return event.key === 'Escape' && Boolean(composing || event.isComposing || event.nativeEvent?.isComposing)
}

function RotatingPlaceholder({ placeholders, placeholderPositionClass }: { placeholders: string[]; placeholderPositionClass?: string }) {
  const [index, setIndex] = React.useState(0)
  React.useEffect(() => {
    if (placeholders.length <= 1) return
    const timer = window.setInterval(() => setIndex(current => (current + 1) % placeholders.length), 5000)
    return () => window.clearInterval(timer)
  }, [placeholders.length])
  return <span className={cn('absolute inset-0 pointer-events-none select-none text-sm text-muted-foreground', placeholderPositionClass)}>{placeholders[index] ?? placeholders[0]}</span>
}

// Extract only the padding utilities from the editor className so the
// placeholder overlay starts at the same position as typed text (the editor's
// text box is padded by the caller, e.g. pl-5 pt-3).
const PADDING_CLASS_PATTERN = /\b(?:p|px|py|pt|pr|pb|pl|ps|pe)-(?:[0-9.]+|px|em|rem|\[[^\]]+\])\b/g

function extractPaddingClasses(className?: string): string | undefined {
  if (!className) return undefined
  const matches = className.match(PADDING_CLASS_PATTERN)
  return matches?.length ? matches.join(' ') : undefined
}

export const ComposerEditor = React.forwardRef<ComposerEditorHandle, ComposerEditorProps>(function ComposerEditor({
  value,
  onChange,
  onTransaction,
  onInput,
  onSuggestionChange,
  onSuggestionExit,
  onPaste,
  onLongTextPaste,
  placeholder,
  skills = [],
  workspaceId,
  disabled = false,
  autoCapitalisation = false,
  semanticId,
  className,
  style,
  spellCheck,
  onFocus,
  onBlur,
  onKeyDown,
  ...restProps
}, forwardedRef) {
  const { t } = useTranslation()
  const skillsRef = React.useRef(skills)
  skillsRef.current = skills
  const workspaceIdRef = React.useRef(workspaceId)
  workspaceIdRef.current = workspaceId
  const valueRef = React.useRef(coerceInputText(value))
  const valueDirtyRef = React.useRef(false)
  const composingRef = React.useRef(false)
  const autoCapitalisationRef = React.useRef(autoCapitalisation)
  autoCapitalisationRef.current = autoCapitalisation
  const pendingSelectionRef = React.useRef<number | null>(null)
  const [isEmpty, setIsEmpty] = React.useState(valueRef.current.trim().length === 0)
  const placeholders = React.useMemo(() => {
    if (!placeholder) return [t('chatInput.placeholder.typeMessage')]
    return Array.isArray(placeholder) ? placeholder : [placeholder]
  }, [placeholder, t])
  const mentionContextSignature = React.useMemo(
    () => `${workspaceId ?? ''}|${skills.map(skill => `${skill.slug}:${skill.metadata.name}:${skill.metadata.icon ?? ''}`).join('|')}`,
    [skills, workspaceId],
  )
  const appliedMentionContextRef = React.useRef(mentionContextSignature)
  const callbacksRef = React.useRef({
    onChange,
    onTransaction,
    onInput,
    onSuggestionChange,
    onSuggestionExit,
    onKeyDown,
    onFocus,
    onBlur,
    onPaste,
    onLongTextPaste,
  })
  callbacksRef.current = {
    onChange,
    onTransaction,
    onInput,
    onSuggestionChange,
    onSuggestionExit,
    onKeyDown,
    onFocus,
    onBlur,
    onPaste,
    onLongTextPaste,
  }
  const forwardedAttributesSignature = JSON.stringify(Object.fromEntries(
    Object.entries(restProps).filter(([key]) => key.startsWith('data-') || key === 'role' || key.startsWith('aria-')),
  ))
  const editorAttributes = React.useMemo(() => {
    const forwarded = JSON.parse(forwardedAttributesSignature) as Record<string, string>
    return {
      ...forwarded,
      'data-slot': 'rich-text-input',
      'data-mortise-semantic-id': forwarded['data-mortise-semantic-id'] ?? semanticId ?? '',
      'data-mortise-ui-interactions': 'shortcut clipboard ime rich-text',
      class: cn('outline-none text-sm whitespace-pre-wrap break-words min-h-[1.5em] overflow-y-auto', className),
      tabindex: disabled ? '-1' : '0',
      role: 'textbox',
      'aria-multiline': 'true',
      'aria-disabled': String(disabled),
      spellcheck: String(spellCheck ?? false),
    }
  }, [className, disabled, forwardedAttributesSignature, semanticId, spellCheck])

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ codeBlock: false, bulletList: false, orderedList: false, blockquote: false, heading: false, horizontalRule: false }),
      ComposerMention,
      ComposerMentionInputRules.configure({
        getSkills: () => skillsRef.current,
        getWorkspaceId: () => workspaceIdRef.current,
      }),
      ComposerTextRules.configure({
        getAutoCapitalisation: () => autoCapitalisationRef.current,
        getComposing: () => composingRef.current,
      }),
      ComposerSuggestions.configure({
        notify: (kind, suggestionEditor) => {
          const nextValue = documentText(suggestionEditor)
          valueRef.current = nextValue
          valueDirtyRef.current = false
          callbacksRef.current.onSuggestionChange?.(kind, nextValue, documentCursorOffset(suggestionEditor))
        },
        exit: kind => callbacksRef.current.onSuggestionExit?.(kind),
      }),
      Placeholder.configure({ placeholder: placeholders[0] ?? '' }),
    ],
    content: composerTextToDocument(value, skills, workspaceId),
    editable: !disabled,
    immediatelyRender: false,
    editorProps: {
      attributes: editorAttributes,
      handleDOMEvents: {
        beforeinput: () => { markComposerInputFrame(); return false },
        compositionstart: () => { composingRef.current = true; return false },
        compositionend: () => { composingRef.current = false; return false },
        keydown: (_view, event) => {
          if (isEscapeDuringComposition(event, composingRef.current)) {
            event.stopPropagation()
            return true
          }
          callbacksRef.current.onKeyDown?.(event as unknown as React.KeyboardEvent<HTMLDivElement>)
          return false
        },
        focus: (_view, event) => { callbacksRef.current.onFocus?.(event as unknown as React.FocusEvent<HTMLDivElement>); return false },
        blur: (_view, event) => { callbacksRef.current.onBlur?.(event as unknown as React.FocusEvent<HTMLDivElement>); return false },
      },
      handlePaste: (view, event) => {
        if (event.clipboardData?.files.length && callbacksRef.current.onPaste) {
          callbacksRef.current.onPaste(event as unknown as React.ClipboardEvent)
          return true
        }
        const text = event.clipboardData?.getData('text/plain') ?? ''
        if (!text) return false
        if (text.split('\n').length > LONG_TEXT_LINE_THRESHOLD && callbacksRef.current.onLongTextPaste) {
          event.preventDefault()
          callbacksRef.current.onLongTextPaste(text)
          return true
        }
        event.preventDefault()
        const content = composerTextToDocument(text, skillsRef.current, workspaceIdRef.current).content ?? []
        const inlineContent = content.length === 1 && content[0]?.type === 'paragraph'
          ? (content[0].content ?? [])
          : content
        const nodes = inlineContent.map(node => view.state.schema.nodeFromJSON(node))
        view.dispatch(view.state.tr.replaceSelection(new Slice(Fragment.fromArray(nodes), 0, 0)))
        return true
      },
    },
    onCreate: ({ editor: created }) => {
      valueRef.current = documentText(created)
      valueDirtyRef.current = false
    },
    onUpdate: ({ editor: updated }) => {
      measureComposerPerformance('editor-transaction', () => {
        valueDirtyRef.current = true
        const nextIsEmpty = updated.isEmpty
        setIsEmpty(previous => previous === nextIsEmpty ? previous : nextIsEmpty)
        callbacksRef.current.onTransaction?.({ isEmpty: nextIsEmpty })

        if (callbacksRef.current.onChange || callbacksRef.current.onInput) {
          const nextValue = documentText(updated)
          valueRef.current = nextValue
          valueDirtyRef.current = false
          callbacksRef.current.onChange?.(nextValue)
          callbacksRef.current.onInput?.(nextValue, documentCursorOffset(updated))
        }
      })
    },
  }, [])

  React.useImperativeHandle(forwardedRef, () => ({
    focus: () => editor?.commands.focus(),
    blur: () => editor?.commands.blur(),
    get value() {
      if (editor && valueDirtyRef.current) {
        valueRef.current = documentText(editor)
        valueDirtyRef.current = false
      }
      return valueRef.current
    },
    get isEmpty() { return editor?.isEmpty ?? valueRef.current.trim().length === 0 },
    get selectionStart() { return editor ? documentCursorOffset(editor) : valueRef.current.length },
    setValue: nextValue => {
      valueRef.current = coerceInputText(nextValue)
      valueDirtyRef.current = false
      setIsEmpty(valueRef.current.trim().length === 0)
      if (editor) setEditorText(editor, valueRef.current, skillsRef.current, workspaceIdRef.current, pendingSelectionRef.current ?? undefined)
    },
    replaceTextRange: (start, end, text) => {
      if (!editor) return
      const from = positionForTextOffset(editor, Math.max(0, start))
      const to = positionForTextOffset(editor, Math.max(start, end))
      const replacement = text.includes('\n')
        ? composerTextToDocument(text, skillsRef.current, workspaceIdRef.current).content
        : tokensToContent(text, skillsRef.current, workspaceIdRef.current)
      editor.commands.insertContentAt({ from, to }, replacement, { updateSelection: false })
    },
    setSelectionRange: (start, _end) => {
      pendingSelectionRef.current = start
      if (editor) editor.commands.setTextSelection(positionForTextOffset(editor, start))
    },
    getBoundingClientRect: () => editor?.view.dom.getBoundingClientRect() ?? new DOMRect(),
    getCaretRect: () => {
      if (!editor) return null
      const coords = editor.view.coordsAtPos(editor.state.selection.from)
      return new DOMRect(coords.left, coords.top, Math.max(1, coords.right - coords.left), coords.bottom - coords.top)
    },
    get element() { return editor?.view.dom ?? null },
  }), [editor])

  React.useEffect(() => {
    if (!workspaceId) return
    for (const skill of skills) {
      void loadEntityIcon({ entityType: 'skill', workspaceId, identifier: skill.slug, skillConfig: skill })
    }
  }, [skills, workspaceId])

  React.useEffect(() => {
    if (!editor) return
    editor.setEditable(!disabled)
  }, [editor, disabled])

  React.useEffect(() => {
    if (!editor) return
    editor.setOptions({
      editorProps: {
        ...editor.options.editorProps,
        attributes: editorAttributes,
      },
    })
  }, [editor, editorAttributes])

  React.useEffect(() => {
    if (!editor) return
    const nextValue = coerceInputText(value)
    const mentionContextChanged = appliedMentionContextRef.current !== mentionContextSignature
    if (nextValue === valueRef.current && !mentionContextChanged) return
    const cursor = pendingSelectionRef.current ?? documentCursorOffset(editor)
    valueRef.current = nextValue
    valueDirtyRef.current = false
    setIsEmpty(nextValue.trim().length === 0)
    setEditorText(editor, nextValue, skillsRef.current, workspaceIdRef.current, cursor)
    appliedMentionContextRef.current = mentionContextSignature
    pendingSelectionRef.current = null
  }, [editor, mentionContextSignature, value])

  if (!editor) {
    return (
      <div
        data-slot="rich-text-input"
        data-mortise-semantic-id={semanticId}
        data-mortise-ui-interactions="shortcut clipboard ime rich-text"
        className={cn('min-h-[1.5em]', className)}
        role="textbox"
        aria-multiline="true"
        aria-disabled={disabled}
      />
    )
  }
  return (
    <div className="relative overflow-y-auto" style={style}>
      <EditorContent editor={editor} />
      {isEmpty && <RotatingPlaceholder placeholders={placeholders} placeholderPositionClass={extractPaddingClasses(className)} />}
    </div>
  )
})

export function shouldShowPlaceholder(hasDomContent: boolean, modelValue: string): boolean {
  return !hasDomContent && modelValue.trim().length === 0
}

export { isEscapeDuringComposition }
