import * as React from 'react'
import {
  InlineSlashCommand,
  useInlineSlashCommand,
  type SlashCommandId,
  type SlashSection,
} from '@/components/ui/slash-command-menu'
import {
  InlineMentionMenu,
  useInlineMention,
  type MentionItem,
} from '@/components/ui/mention-menu'
import type { RichTextInputHandle } from '@/components/ui/rich-text-input'
import type { LoadedSkill } from '../../../../shared/types'

export type ComposerSuggestionKind = 'slash' | 'mention'

export interface ComposerSuggestionMenusHandle {
  update: (kind: ComposerSuggestionKind, value: string, cursorPosition: number) => void
  exit: (kind: ComposerSuggestionKind) => void
  handleKeyDown: (event: React.KeyboardEvent) => boolean
}

interface ComposerSuggestionMenusProps {
  inputRef: React.RefObject<RichTextInputHandle | null>
  skills: LoadedSkill[]
  workspaceRoot?: string
  workspaceId?: string
  activeCommands: SlashCommandId[]
  extensionSections: SlashSection[]
  onRefreshExtensionCommands: () => void
  onSelectSlashCommand: (commandId: SlashCommandId) => void
  onApplyEditorValue: (value: string, cursorPosition?: number) => void
}

export const ComposerSuggestionMenus = React.memo(React.forwardRef<
  ComposerSuggestionMenusHandle,
  ComposerSuggestionMenusProps
>(function ComposerSuggestionMenus({
  inputRef,
  skills,
  workspaceRoot,
  workspaceId,
  activeCommands,
  extensionSections,
  onRefreshExtensionCommands,
  onSelectSlashCommand,
  onApplyEditorValue,
}, forwardedRef) {
  const inlineSlash = useInlineSlashCommand({
    inputRef,
    onSelectCommand: onSelectSlashCommand,
    onSelectFolder: () => undefined,
    activeCommands,
    extraSections: extensionSections,
  })

  const inlineMention = useInlineMention({
    inputRef,
    skills,
    basePath: workspaceRoot,
    onSelect: () => undefined,
    workspaceId,
  })

  const handleSlashSelect = React.useCallback((commandId: SlashCommandId) => {
    const nextValue = inlineSlash.handleSelectCommand(commandId)
    onApplyEditorValue(nextValue)
    inputRef.current?.focus()
  }, [inlineSlash, inputRef, onApplyEditorValue])

  const handleFolderSelect = React.useCallback((path: string) => {
    const nextValue = inlineSlash.handleSelectFolder(path)
    onApplyEditorValue(nextValue)
    inputRef.current?.focus()
  }, [inlineSlash, inputRef, onApplyEditorValue])

  const handleMentionSelect = React.useCallback((item: MentionItem) => {
    const { value, cursorPosition } = inlineMention.handleSelect(item)
    onApplyEditorValue(value, cursorPosition)
    requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.setSelectionRange(cursorPosition, cursorPosition)
    })
  }, [inlineMention, inputRef, onApplyEditorValue])

  React.useImperativeHandle(forwardedRef, () => ({
    update: (kind, value, cursorPosition) => {
      if (kind === 'slash') {
        onRefreshExtensionCommands()
        inlineMention.close()
        inlineSlash.handleInputChange(value, cursorPosition)
        return
      }
      inlineSlash.close()
      inlineMention.handleInputChange(value, cursorPosition)
    },
    exit: kind => {
      if (kind === 'slash') inlineSlash.close()
      else inlineMention.close()
    },
    handleKeyDown: event => {
      if (event.key === 'Escape' && event.nativeEvent.isComposing) return false

      if (inlineMention.isOpen) {
        const hasVisibleContent = inlineMention.sections.some(section => section.items.length > 0)
          || inlineMention.isSearching
        if (hasVisibleContent && ['Enter', 'Tab', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
          return true
        }
        if (event.key === 'Escape') {
          event.preventDefault()
          inlineMention.close()
          return true
        }
      }

      if (inlineSlash.isOpen) {
        if (['Enter', 'Tab', 'ArrowUp', 'ArrowDown'].includes(event.key)) return true
        if (event.key === 'Escape') {
          event.preventDefault()
          inlineSlash.close()
          return true
        }
      }

      return false
    },
  }), [inlineMention, inlineSlash, onRefreshExtensionCommands])

  return (
    <>
      <InlineSlashCommand
        open={inlineSlash.isOpen}
        onOpenChange={open => !open && inlineSlash.close()}
        sections={inlineSlash.sections}
        activeCommands={activeCommands}
        onSelectCommand={handleSlashSelect}
        onSelectFolder={handleFolderSelect}
        filter={inlineSlash.filter}
        position={inlineSlash.position}
      />
      <InlineMentionMenu
        open={inlineMention.isOpen}
        onOpenChange={open => !open && inlineMention.close()}
        sections={inlineMention.sections}
        onSelect={handleMentionSelect}
        filter={inlineMention.filter}
        position={inlineMention.position}
        workspaceId={workspaceId}
        maxWidth={280}
        isSearching={inlineMention.isSearching}
      />
    </>
  )
}))
