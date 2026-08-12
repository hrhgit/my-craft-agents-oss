import * as React from 'react'
import { useState, useCallback, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { ComponentEntry, PlaygroundLocale } from './types'
import type { Session } from '../../../shared/types'
import type { Message } from '@mortise/core/types'
import { ChatDisplay } from '../../components/app-shell/ChatDisplay'
import { EditPopover, type EditContext } from '../../components/ui/EditPopover'
import { FocusProvider } from '../../context/FocusContext'
import { EscapeInterruptProvider } from '../../context/EscapeInterruptContext'
import { AppShellProvider } from '../../context/AppShellContext'
import { ensureMockElectronAPI } from '../mock-utils'
import { GripHorizontal, Pencil } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import type { ComposerSubmissionAttempt } from '../../components/app-shell/input/composer-submission'

// Ensure mock electronAPI is available before any component renders
ensureMockElectronAPI()

// ============================================================================
// Sample Message Data
// ============================================================================

const createMessage = (
  id: string,
  role: 'user' | 'assistant',
  content: string,
  isIntermediate = false
): Message => ({
  id,
  role: role,
  content,
  isIntermediate,
  timestamp: Date.now(),
})

// Empty session - initial state before any messages
const emptyMessages: Message[] = []

// User just sent a message
const userMessageOnly = (locale: PlaygroundLocale): Message[] => {
  const zh = locale === 'zh-CN'
  return [
    createMessage('msg-1', 'user', zh ? '添加一个橙色的 "Blocked" 状态' : 'Add a "Blocked" status with orange color'),
  ]
}

// Agent is thinking/processing
const processingMessages = (locale: PlaygroundLocale): Message[] => {
  const zh = locale === 'zh-CN'
  return [
    createMessage('msg-1', 'user', zh ? '添加一个橙色的 "Blocked" 状态' : 'Add a "Blocked" status with orange color'),
    createMessage('msg-2', 'assistant', zh
      ? '我将把 "Blocked" 状态添加到你的状态配置中…'
      : 'I\'ll add a "Blocked" status to your statuses configuration...', true),
  ]
}

// Short conversation - completed
const completedMessages = (locale: PlaygroundLocale): Message[] => {
  const zh = locale === 'zh-CN'
  return [
    createMessage('msg-1', 'user', zh ? '添加一个红色的 "Bug" 标签' : 'Add a "Bug" label with red color'),
    createMessage('msg-2', 'assistant', zh
      ? '已将 **Bug** 标签以红色添加到你的标签配置中。\n\n该标签现在可在 # 菜单中使用，并会在会话上显示为红色圆形徽章。'
      : 'Added the **Bug** label with red color to your labels configuration.\n\nThe label is now available in the # menu and will appear as a red circle badge on sessions.'),
  ]
}

// Longer conversation with follow-up
const conversationMessages = (locale: PlaygroundLocale): Message[] => {
  const zh = locale === 'zh-CN'
  return [
    createMessage('msg-1', 'user', zh ? '添加一个 "Blocked" 状态' : 'Add a "Blocked" status'),
    createMessage('msg-2', 'assistant', zh
      ? '我已将 "Blocked" 状态添加到你的配置中。你想用什么颜色？'
      : 'I\'ve added a "Blocked" status to your configuration. What color would you like for it?'),
    createMessage('msg-3', 'user', zh ? '改成橙色' : 'Make it orange'),
    createMessage('msg-4', 'assistant', zh
      ? '已将 **Blocked** 状态更新为橙色。现在它会以橙色指示符显示在你的状态菜单中。'
      : 'Updated the **Blocked** status with orange color. It will now appear in your status menu with an orange indicator.'),
  ]
}

// Error scenario
const errorMessages = (locale: PlaygroundLocale): Message[] => {
  const zh = locale === 'zh-CN'
  return [
    createMessage('msg-1', 'user', zh ? '添加一个名为 "bug" 的标签' : 'Add a label called "bug"'),
    createMessage('msg-2', 'assistant', zh
      ? '我尝试添加该标签，但遇到了错误：\n\n**标签 ID "bug" 已存在**\n\n你希望我改用 "bug-report" 这样的不同 ID 吗？'
      : 'I attempted to add the label, but encountered an error:\n\n**Label ID "bug" already exists**\n\nWould you like me to use a different ID like "bug-report" instead?'),
  ]
}

// ============================================================================
// Helper to create Session from messages
// ============================================================================

const createSession = (messages: Message[], isProcessing = false): Session => ({
  id: 'playground-session',
  workspaceId: 'playground-workspace',
  workspaceName: 'Playground',
  messages,
  isProcessing,
  lastMessageAt: Date.now(),
})

// ============================================================================
// Compact ChatDisplay Preview Wrapper
// ============================================================================

interface CompactChatPreviewProps {
  messages?: Message[]
  isProcessing?: boolean
  placeholder?: string
}

/**
 * Wrapper that renders ChatDisplay in compact mode with a popover-like container
 * to simulate how it appears in the EditPopover.
 */
function CompactChatPreview({
  messages,
  isProcessing = false,
  placeholder,
}: CompactChatPreviewProps) {
  const { t } = useTranslation()
  const [model, setModel] = useState('haiku')
  const session = createSession(messages ?? completedMessages('en'), isProcessing)
  const resolvedPlaceholder = placeholder || t('playground.editPopover.placeholder')

  // Drag state for movable preview
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 })
  const [isDragging, setIsDragging] = useState(false)
  const dragStartRef = useRef({ x: 0, y: 0, offsetX: 0, offsetY: 0 })

  // Resize state
  const [size, setSize] = useState({ width: 400, height: 400 })
  const [isResizing, setIsResizing] = useState(false)
  const resizeStartRef = useRef({ x: 0, y: 0, width: 0, height: 0 })

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setIsDragging(true)
    dragStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      offsetX: dragOffset.x,
      offsetY: dragOffset.y,
    }
  }, [dragOffset])

  useEffect(() => {
    if (!isDragging) return

    const handleMouseMove = (e: MouseEvent) => {
      const deltaX = e.clientX - dragStartRef.current.x
      const deltaY = e.clientY - dragStartRef.current.y
      setDragOffset({
        x: dragStartRef.current.offsetX + deltaX,
        y: dragStartRef.current.offsetY + deltaY,
      })
    }

    const handleMouseUp = () => {
      setIsDragging(false)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isDragging])

  // Resize handlers
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsResizing(true)
    resizeStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      width: size.width,
      height: size.height,
    }
  }, [size])

  useEffect(() => {
    if (!isResizing) return

    const handleMouseMove = (e: MouseEvent) => {
      const deltaX = e.clientX - resizeStartRef.current.x
      const deltaY = e.clientY - resizeStartRef.current.y
      setSize({
        width: Math.max(300, resizeStartRef.current.width + deltaX),
        height: Math.max(250, resizeStartRef.current.height + deltaY),
      })
    }

    const handleMouseUp = () => {
      setIsResizing(false)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isResizing])

  const handleSendMessage = async (attempt: ComposerSubmissionAttempt) => {
    console.log('[Playground] Send message:', attempt)
    return true
  }

  const handleOpenFile = (path: string) => {
    console.log('[Playground] Open file:', path)
  }

  const handleOpenUrl = (url: string) => {
    console.log('[Playground] Open URL:', url)
  }

  return (
    <FocusProvider>
      <EscapeInterruptProvider>
        <div
          className="popover-styled p-0 overflow-hidden relative"
          style={{
            width: size.width,
            height: size.height,
            borderRadius: 16,
            transform: `translate(${dragOffset.x}px, ${dragOffset.y}px)`,
          }}
        >
          {/* Drag handle - 4px lower with asymmetric padding */}
          <div
            onMouseDown={handleDragStart}
            className={cn(
              "flex items-center justify-center pt-2.5 pb-1.5 border-b border-border/30 cursor-grab",
              isDragging && "cursor-grabbing"
            )}
          >
            <GripHorizontal className="w-4 h-4 text-muted-foreground/50" />
          </div>

          {/* Content - compact ChatDisplay */}
          <div className="flex-1 flex flex-col" style={{ height: 'calc(100% - 34px)' }}>
            <ChatDisplay
              session={session}
              onSendMessage={handleSendMessage}
              onOpenFile={handleOpenFile}
              onOpenUrl={handleOpenUrl}
              currentModel={model}
              onModelChange={setModel}
              compactMode={true}
              placeholder={resolvedPlaceholder}
            />
          </div>

          {/* Bottom-right resize handle - invisible hit area */}
          <div
            onMouseDown={handleResizeStart}
            className="absolute -bottom-2 -right-2 w-6 h-6 cursor-nwse-resize"
          />
        </div>
      </EscapeInterruptProvider>
    </FocusProvider>
  )
}

// ============================================================================
// EditPopover Preview Wrapper
// ============================================================================

// Mock AppShell context for playground
const mockAppShellContext = {
  sessions: [],
  workspaces: [{ id: 'playground-workspace', name: 'Playground', path: '/playground', rootPath: '/playground' }],
  activeWorkspaceId: 'playground-workspace',
  activeSessionId: null,
  pendingCredentials: new Map(),
  currentModel: 'haiku',
  providerDefaultModel: null,
  sessionOptions: new Map(),
  getDraft: () => '',
  onSelectSession: () => {},
  onSelectWorkspace: () => {},
  onOpenSettings: () => {},
  onOpenKeyboardShortcuts: () => {},
  onOpenStoredUserPreferences: () => {},
  onSessionOptionsChange: () => {},
  onInputChange: () => {},
  onOpenFile: () => {},
  onOpenUrl: () => {},
  onModelChange: () => {},
  onRefreshWorkspaces: () => {},
  // Session callbacks required by EditPopover
  onCreateSession: async (workspaceId: string) => ({
    id: 'mock-session-' + Date.now(),
    workspaceId,
    workspaceName: 'Playground',
    messages: [],
    isProcessing: false,
    lastMessageAt: Date.now(),
  }),
  onSendMessage: (sessionId: string, message: string) => {
    console.log('[Playground] Send message to session:', sessionId, message)
  },
  onRenameSession: () => {},
  onMarkSessionRead: () => {},
  onMarkSessionUnread: () => {},
  onSetActiveViewingSession: () => {},
  onDeleteSession: async () => true,
}

// Sample edit context is resolved inside EditPopoverPreview so it can follow
// the playground language via t().

interface EditPopoverPreviewProps {
  inlineExecution?: boolean
  example?: string
  triggerLabel?: string
}

/**
 * Wrapper that renders the actual EditPopover component with a trigger button
 */
function EditPopoverPreview({
  inlineExecution = true,
  example,
  triggerLabel,
}: EditPopoverPreviewProps) {
  const { t } = useTranslation()
  const context: EditContext = {
    label: t('playground.editPopover.contextLabel'),
    filePath: 'automation.workspace',
    context: t('playground.editPopover.contextDescription'),
  }

  return (
    <AppShellProvider value={mockAppShellContext as any}>
      <FocusProvider>
        <EscapeInterruptProvider>
          <div className="flex flex-col items-center gap-4">
            <EditPopover
              trigger={
                <Button variant="outline" size="sm">
                  <Pencil className="w-4 h-4 mr-2" />
                  {triggerLabel || t('playground.editPopover.triggerLabel')}
                </Button>
              }
              context={context}
              example={example || t('playground.editPopover.example')}
              inlineExecution={inlineExecution}
            />
            <p className="text-xs text-muted-foreground">{t('playground.editPopover.clickToOpen')}</p>
          </div>
        </EscapeInterruptProvider>
      </FocusProvider>
    </AppShellProvider>
  )
}

// ============================================================================
// Registry Entries
// ============================================================================

export const editPopoverComponents: ComponentEntry[] = [
  {
    id: 'edit-popover',
    name: 'EditPopover',
    nameZh: 'EditPopover',
    category: 'Edit Popover',
    description: 'The actual EditPopover component with trigger button',
    descriptionZh: '带触发按钮的真实 EditPopover 组件',
    component: EditPopoverPreview,
    props: [
      {
        name: 'inlineExecution',
        description: 'Use inline execution mode (compact ChatDisplay)',
        descriptionZh: '使用内联执行模式（紧凑 ChatDisplay）',
        control: { type: 'boolean' },
        defaultValue: true,
      },
      {
        name: 'example',
        description: 'Example text shown in placeholder',
        descriptionZh: '占位符中显示的示例文本',
        control: { type: 'string', placeholder: 'Enter example...' },
        defaultValue: '',
      },
      {
        name: 'triggerLabel',
        description: 'Label for the trigger button',
        descriptionZh: '触发按钮的标签',
        control: { type: 'string', placeholder: 'Button label...' },
        defaultValue: '',
      },
    ],
    variants: [
      {
        name: 'Inline Execution (Default)',
        nameZh: '内联执行（默认）',
        description: 'Uses compact ChatDisplay for inline agent execution',
        descriptionZh: '使用紧凑 ChatDisplay 进行内联 Agent 执行',
        props: {
          inlineExecution: true,
          example: 'Add a "Bug" label with red color',
          triggerLabel: 'Edit with AI',
        },
      },
      {
        name: 'Legacy Mode',
        nameZh: '旧版模式',
        description: 'Opens new window instead of inline execution',
        descriptionZh: '打开新窗口而不是内联执行',
        props: {
          inlineExecution: false,
          example: 'Update the status colors',
          triggerLabel: 'Quick Edit',
        },
      },
      {
        name: 'Add Integration',
        nameZh: '添加集成',
        description: 'Styled for adding a new integration',
        descriptionZh: '为添加新集成而设计的样式',
        props: {
          inlineExecution: true,
          example: 'Connect to my GitHub repo',
          triggerLabel: 'Add Integration',
        },
      },
      {
        name: 'Add Skill',
        nameZh: '添加技能',
        description: 'Styled for adding a new skill',
        descriptionZh: '为添加新技能而设计的样式',
        props: {
          inlineExecution: true,
          example: 'Review PRs following our code standards',
          triggerLabel: 'Add Skill',
        },
      },
    ],
  },
  {
    id: 'compact-chat-display',
    name: 'Compact ChatDisplay',
    nameZh: '紧凑 ChatDisplay',
    category: 'Edit Popover',
    description: 'Full chat experience in compact mode for inline editing in popovers',
    descriptionZh: '以紧凑模式提供完整聊天体验，用于弹层中的内联编辑',
    component: CompactChatPreview,
    props: [
      {
        name: 'isProcessing',
        description: 'Whether the agent is currently processing',
        descriptionZh: 'Agent 当前是否正在处理',
        control: { type: 'boolean' },
        defaultValue: false,
      },
      {
        name: 'placeholder',
        description: 'Placeholder text for the input',
        descriptionZh: '输入框的占位符文本',
        control: { type: 'string', placeholder: 'Enter placeholder...' },
        defaultValue: '',
      },
    ],
    variants: [
      {
        name: 'Empty (Initial State)',
        nameZh: '空（初始状态）',
        description: 'No messages yet, ready for user input',
        descriptionZh: '还没有消息，等待用户输入',
        props: {
          messages: emptyMessages,
          isProcessing: false,
          placeholder: "Describe what you'd like to change, e.g., \"Add a Blocked status\"",
        },
      },
      {
        name: 'User Message Sent',
        nameZh: '已发送用户消息',
        description: 'User just sent a message, waiting for response',
        descriptionZh: '用户刚发送消息，等待回复',
        props: {
          messages: userMessageOnly('en'),
          isProcessing: true,
        },
      },
      {
        name: 'Processing (Thinking)',
        nameZh: '处理中（思考）',
        description: 'Agent is thinking with intermediate message',
        descriptionZh: 'Agent 正在思考并显示中间消息',
        props: {
          messages: processingMessages('en'),
          isProcessing: true,
        },
      },
      {
        name: 'Completed (Short)',
        nameZh: '已完成（简短）',
        description: 'Single turn completed successfully',
        descriptionZh: '单轮对话成功完成',
        props: {
          messages: completedMessages('en'),
          isProcessing: false,
        },
      },
      {
        name: 'Conversation (Multi-turn)',
        nameZh: '对话（多轮）',
        description: 'Back-and-forth conversation with follow-ups',
        descriptionZh: '带追问的来回对话',
        props: {
          messages: conversationMessages('en'),
          isProcessing: false,
        },
      },
      {
        name: 'Error Response',
        nameZh: '错误响应',
        description: 'Agent encountered an issue and is asking for clarification',
        descriptionZh: 'Agent 遇到问题并向用户确认',
        props: {
          messages: errorMessages('en'),
          isProcessing: false,
        },
      },
      {
        name: 'Add Integration Context',
        nameZh: '添加集成上下文',
        description: 'Using the add-integration placeholder style',
        descriptionZh: '使用 add-integration 占位符样式',
        props: {
          messages: emptyMessages,
          isProcessing: false,
          placeholder: 'What would you like to connect?',
        },
      },
      {
        name: 'Add Skill Context',
        nameZh: '添加技能上下文',
        description: 'Using "add skill" placeholder style',
        descriptionZh: '使用“add skill”占位符样式',
        props: {
          messages: emptyMessages,
          isProcessing: false,
          placeholder: 'What should I learn to do?',
        },
      },
    ],
    mockData: (locale) => ({
      messages: completedMessages(locale),
    }),
  },
]
