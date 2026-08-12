import * as React from 'react'
import { useTranslation } from 'react-i18next'
import type { ComponentEntry, PlaygroundLocale } from './types'
import {
  TurnCard,
  type ActivityItem,
  type ResponseContent,
  Markdown,
  CollapsibleMarkdownProvider,
  Spinner,
  UserMessageBubble,
  SystemMessage,
} from '@mortise/ui'
import { ExternalLink } from 'lucide-react'

// ============================================================================
// Message Components - Demo components for playground preview
// Uses shared components from @mortise/ui where available
// ============================================================================

/** Pick the localized sample text for the given playground locale. */
function pickLocale(locale: PlaygroundLocale, en: string, zh: string): string {
  return locale === 'zh-CN' ? zh : en
}

/** Assistant message bubble - left aligned white card (playground demo version) */
function AssistantMessage({ content }: { content: string }) {
  const { t } = useTranslation()
  return (
    <div className="flex justify-start group">
      <div className="relative max-w-[80%] bg-white shadow-minimal rounded-[8px] pl-6 pr-4 py-3 break-words min-w-0">
        <button
          className="absolute top-2 right-2 p-1.5 rounded-md opacity-0 group-hover:opacity-100 transition-opacity hover:bg-foreground/5"
          title={t('playground.messages.openInNewWindow')}
        >
          <ExternalLink className="w-4 h-4 text-muted-foreground hover:text-foreground" />
        </button>
        <CollapsibleMarkdownProvider>
          <Markdown
            mode="minimal"
            className="text-sm"
            collapsible
          >
            {content}
          </Markdown>
        </CollapsibleMarkdownProvider>
      </div>
    </div>
  )
}

/** Status message - spinner with text, used during compaction etc (playground demo) */
function StatusMessage({ content }: { content: string }) {
  return (
    <div className="flex items-center gap-2 px-3 py-1 text-[13px] text-muted-foreground">
      <div className="w-3 h-3 flex items-center justify-center shrink-0">
        <Spinner className="text-[10px]" />
      </div>
      <span>{content}</span>
    </div>
  )
}

/** Compaction divider - horizontal rule with centered label shown after context compaction (playground demo) */
function CompactionDivider({ label }: { label?: string }) {
  const { t } = useTranslation()
  const resolvedLabel = label ?? t('playground.messages.compactionDefault')
  return (
    <div className="flex items-center gap-3 my-12 px-3">
      <div className="flex-1 h-px bg-border" />
      <span className="text-sm text-muted-foreground/70 select-none">
        {resolvedLabel}
      </span>
      <div className="flex-1 h-px bg-border" />
    </div>
  )
}

/**
 * Processing indicator driven by the Playground scene timeline.
 * Uses the shared `chat.processing.*` dictionary entries so the label
 * follows the global i18n language automatically.
 */
const PROCESSING_MESSAGE_KEYS = [
  'chat.processing.thinking',
  'chat.processing.pondering',
  'chat.processing.contemplating',
  'chat.processing.reasoning',
  'chat.processing.processing',
  'chat.processing.computing',
  'chat.processing.considering',
  'chat.processing.reflecting',
  'chat.processing.deliberating',
  'chat.processing.cogitating',
  'chat.processing.ruminating',
  'chat.processing.musing',
  'chat.processing.workingOnIt',
  'chat.processing.onIt',
  'chat.processing.crunching',
  'chat.processing.brewing',
  'chat.processing.connectingDots',
  'chat.processing.mullingItOver',
  'chat.processing.deepInThought',
  'chat.processing.hmm',
  'chat.processing.letMeSee',
  'chat.processing.oneMoment',
  'chat.processing.holdOn',
  'chat.processing.bearWithMe',
  'chat.processing.justASec',
  'chat.processing.hangTight',
  'chat.processing.gettingThere',
  'chat.processing.almost',
  'chat.processing.working',
  'chat.processing.busyBusy',
  'chat.processing.whirring',
  'chat.processing.churning',
  'chat.processing.percolating',
  'chat.processing.simmering',
  'chat.processing.cooking',
  'chat.processing.baking',
  'chat.processing.stirring',
  'chat.processing.spinningUp',
  'chat.processing.warmingUp',
  'chat.processing.revving',
  'chat.processing.buzzing',
  'chat.processing.humming',
  'chat.processing.ticking',
  'chat.processing.clicking',
  'chat.processing.whizzing',
  'chat.processing.zooming',
  'chat.processing.zipping',
  'chat.processing.chugging',
  'chat.processing.trucking',
  'chat.processing.rolling',
] as const

interface ProcessingIndicatorProps {
  phaseIndex?: number
  elapsed?: number
}

function ProcessingIndicator({ phaseIndex = 0, elapsed = 0 }: ProcessingIndicatorProps) {
  const { t } = useTranslation()
  const currentMessage = t(PROCESSING_MESSAGE_KEYS[phaseIndex % PROCESSING_MESSAGE_KEYS.length])

  return (
    <div className="flex items-center gap-2 px-3 py-1 text-[13px] text-muted-foreground">
      {/* Spinner */}
      <div className="w-3 h-3 flex items-center justify-center shrink-0">
        <Spinner className="text-[10px]" />
      </div>
      {/* Label container */}
      <span className="inline-flex h-5 items-center">
        <span className="whitespace-nowrap">{currentMessage}</span>
        {elapsed >= 1 && (
          <span className="text-muted-foreground/60 ml-1 tabular-nums">
            {elapsed}s
          </span>
        )}
      </span>
    </div>
  )
}

// ============================================================================
// Message Gallery - All message types in one scrollable view
// ============================================================================

function MessageGallery() {
  const { t } = useTranslation()
  const now = 1_735_603_200_000

  // Sample tool activities for TurnCard
  const completedGrepActivity: ActivityItem = {
    id: 'tool-1',
    type: 'tool',
    status: 'completed',
    toolName: 'Grep',
    toolInput: { pattern: 'AuthHandler', path: 'src/' },
    intent: t('playground.messages.activityIntentSearchingAuth'),
    timestamp: now - 5000,
  }

  const completedReadActivity: ActivityItem = {
    id: 'tool-2',
    type: 'tool',
    status: 'completed',
    toolName: 'Read',
    toolInput: { file_path: '/src/auth/index.ts' },
    timestamp: now - 4000,
  }

  const runningGrepActivity: ActivityItem = {
    id: 'tool-running-1',
    type: 'tool',
    status: 'running',
    toolName: 'Grep',
    toolInput: { pattern: 'handleError', path: 'src/' },
    intent: t('playground.messages.activityIntentFindingErrorHandling'),
    timestamp: now - 1000,
  }

  const shortResponse: ResponseContent = {
    text: t('playground.messages.assistantAuthAnswer'),
    isStreaming: false,
  }

  const streamingResponse: ResponseContent = {
    text: t('playground.messages.responseStreaming'),
    isStreaming: true,
    streamStartTime: now - 500,
  }

  return (
    <div className="max-w-[960px] mx-auto p-8 space-y-8">
      {/* Section: Status & Dividers (playground demo components) */}
      <section>
        <h2 className="text-lg font-semibold mb-4 text-foreground/80">{t('playground.messages.sectionStatusDividers')}</h2>
        <div className="bg-muted/20 rounded-lg">
          <StatusMessage content={t('playground.messages.statusCompacting')} />
          <CompactionDivider />
          <StatusMessage content={t('playground.messages.statusConnecting')} />
        </div>
      </section>

      {/* Section: Processing States */}
      <section>
        <h2 className="text-lg font-semibold mb-4 text-foreground/80">{t('playground.messages.sectionProcessingStates')}</h2>
        <div className="bg-muted/20 rounded-lg ">
          <ProcessingIndicator />
        </div>
      </section>

      {/* Section: User Messages */}
      <section>
        <h2 className="text-lg font-semibold mb-4 text-foreground/80">{t('playground.messages.sectionUserMessages')}</h2>
        <div className="space-y-3">
          <UserMessageBubble content={t('playground.messages.userAuthQuestion')} />
          <UserMessageBubble content={t('playground.messages.userSearchQuestion')} />
        </div>
      </section>

      {/* Section: Assistant Messages */}
      <section>
        <h2 className="text-lg font-semibold mb-4 text-foreground/80">{t('playground.messages.sectionAssistantMessages')}</h2>
        <div className="space-y-3">
          <AssistantMessage content={t('playground.messages.assistantAuthAnswer')} />
          <AssistantMessage content={t('playground.messages.assistantDetailed')} />
        </div>
      </section>

      {/* Section: SystemMessage (from @mortise/ui) */}
      <section>
        <h2 className="text-lg font-semibold mb-4 text-foreground/80">{t('playground.messages.sectionSystemMessage')}</h2>
        <div className="bg-muted/20 rounded-lg">
          <SystemMessage content={t('playground.messages.systemMessageDefault')} type="system" />
          <SystemMessage content={t('playground.messages.infoMessageDefault')} type="info" />
          <SystemMessage content={t('playground.messages.warningMessageDefault')} type="warning" />
          <SystemMessage content={t('playground.messages.errorMessageDefault')} type="error" />
        </div>
      </section>

      {/* Section: TurnCard - Complete Turn */}
      <section>
        <h2 className="text-lg font-semibold mb-4 text-foreground/80">{t('playground.messages.sectionTurnCardComplete')}</h2>
        <TurnCard
          sessionId="playground-session"
          turnId="turn-1"
          activities={[completedGrepActivity, completedReadActivity]}
          response={shortResponse}
          intent={t('playground.messages.intentAnalyzingAuth')}
          isStreaming={false}
          isComplete={true}
          onOpenFile={(path) => console.log('Open file:', path)}
          onOpenUrl={(url) => console.log('Open URL:', url)}
        />
      </section>

      {/* Section: TurnCard - Streaming */}
      <section>
        <h2 className="text-lg font-semibold mb-4 text-foreground/80">{t('playground.messages.sectionTurnCardStreaming')}</h2>
        <TurnCard
          sessionId="playground-session"
          turnId="turn-2"
          activities={[completedGrepActivity]}
          response={streamingResponse}
          isStreaming={true}
          isComplete={false}
          onOpenFile={(path) => console.log('Open file:', path)}
          onOpenUrl={(url) => console.log('Open URL:', url)}
        />
      </section>

      {/* Section: TurnCard - Tool Running */}
      <section>
        <h2 className="text-lg font-semibold mb-4 text-foreground/80">{t('playground.messages.sectionTurnCardToolRunning')}</h2>
        <TurnCard
          sessionId="playground-session"
          turnId="turn-3"
          activities={[runningGrepActivity]}
          response={undefined}
          intent={t('playground.messages.activityIntentFindingErrorHandling')}
          isStreaming={true}
          isComplete={false}
          onOpenFile={(path) => console.log('Open file:', path)}
          onOpenUrl={(url) => console.log('Open URL:', url)}
        />
      </section>

      {/* Section: TurnCard - Response Only */}
      <section>
        <h2 className="text-lg font-semibold mb-4 text-foreground/80">{t('playground.messages.sectionTurnCardResponseOnly')}</h2>
        <TurnCard
          sessionId="playground-session"
          turnId="turn-4"
          activities={[]}
          response={shortResponse}
          isStreaming={false}
          isComplete={true}
          onOpenFile={(path) => console.log('Open file:', path)}
          onOpenUrl={(url) => console.log('Open URL:', url)}
        />
      </section>

    </div>
  )
}

// ============================================================================
// Component Registry Entries
// ============================================================================

export const messagesComponents: ComponentEntry[] = [
  {
    id: 'message-gallery',
    name: 'Message Gallery',
    nameZh: '消息画廊',
    category: 'Chat Messages',
    description: 'All message types displayed together for easy design comparison',
    descriptionZh: '所有消息类型集中展示，便于进行设计对比',
    component: MessageGallery,
    layout: 'top',
    props: [],
    variants: [],
    mockData: () => ({}),
  },
  {
    id: 'user-message-bubble',
    name: 'UserMessageBubble',
    nameZh: '用户消息气泡',
    category: 'Chat Messages',
    description: 'Right-aligned user message bubble (from @mortise/ui)',
    descriptionZh: '右对齐的用户消息气泡（来自 @mortise/ui）',
    component: UserMessageBubble,
    props: [
      {
        name: 'content',
        nameZh: '内容',
        description: 'Message text content',
        descriptionZh: '消息文本内容',
        control: { type: 'textarea', placeholder: 'Enter message...', rows: 2 },
        defaultValue: 'How do I authenticate with the API?',
      },
    ],
    variants: [
      { name: 'Short', nameZh: '短消息', props: { content: 'Hello!' } },
      { name: 'Medium', nameZh: '中等长度', props: { content: 'How do I authenticate with the API?' } },
      { name: 'Long', nameZh: '长消息', props: { content: 'Can you search for all files that contain "handleError" and show me how they work? I need to understand the error handling patterns in this codebase.' } },
    ],
    mockData: (locale) => ({
      content: pickLocale(locale, 'How do I authenticate with the API?', '如何通过 API 进行身份验证？'),
    }),
  },
  {
    id: 'assistant-message',
    name: 'AssistantMessage',
    nameZh: '助手消息',
    category: 'Chat Messages',
    description: 'Left-aligned assistant response with markdown support',
    descriptionZh: '左对齐的助手回复，支持 markdown 渲染',
    component: AssistantMessage,
    props: [
      {
        name: 'content',
        nameZh: '内容',
        description: 'Message text content (supports markdown)',
        descriptionZh: '消息文本内容（支持 markdown）',
        control: { type: 'textarea', placeholder: 'Enter message...', rows: 4 },
        defaultValue: 'I found the authentication handlers in `src/auth/`. The main handler is `AuthHandler` which manages OAuth flows.',
      },
    ],
    variants: [
      { name: 'Short', nameZh: '短消息', props: { content: 'The file is located at `src/config.ts`.' } },
      { name: 'With Code', nameZh: '带代码', props: { content: 'Here\'s the code:\n\n```typescript\nconst x = 1;\n```' } },
      { name: 'With List', nameZh: '带列表', props: { content: '**Steps:**\n1. First step\n2. Second step\n3. Third step' } },
    ],
    mockData: (locale) => ({
      content: pickLocale(
        locale,
        'I found the authentication handlers in `src/auth/`. The main handler is `AuthHandler` which manages OAuth flows.',
        '我在 `src/auth/` 中找到了身份验证处理器。主要处理器是 `AuthHandler`，它管理 OAuth 流程。',
      ),
    }),
  },
  {
    id: 'status-message',
    name: 'StatusMessage',
    nameZh: '状态消息',
    category: 'Chat Messages',
    description: 'System status with spinner (compaction, connecting, etc)',
    descriptionZh: '带旋转指示器的系统状态消息（压缩、连接等场景）',
    component: StatusMessage,
    props: [
      {
        name: 'content',
        nameZh: '内容',
        description: 'Status message text',
        descriptionZh: '状态消息文本',
        control: { type: 'string', placeholder: 'Status message...' },
        defaultValue: 'Compacting conversation...',
      },
    ],
    variants: [
      { name: 'Compacting', nameZh: '压缩中', props: { content: 'Compacting conversation...' } },
      { name: 'Compacted', nameZh: '已压缩', props: { content: 'Compacted conversation (was 180000 tokens)' } },
      { name: 'Connecting', nameZh: '连接中', props: { content: 'Connecting to server...' } },
    ],
    mockData: (locale) => ({
      content: pickLocale(locale, 'Compacting conversation...', '正在压缩会话...'),
    }),
  },
  {
    id: 'system-message',
    name: 'SystemMessage',
    nameZh: '系统消息',
    category: 'Chat Messages',
    description: 'System/info/warning/error message (from @mortise/ui)',
    descriptionZh: '系统/信息/警告/错误消息（来自 @mortise/ui）',
    component: SystemMessage,
    props: [
      {
        name: 'content',
        nameZh: '内容',
        description: 'Message text content',
        descriptionZh: '消息文本内容',
        control: { type: 'textarea', placeholder: 'Message content...', rows: 2 },
        defaultValue: 'This is a system message.',
      },
      {
        name: 'type',
        nameZh: '类型',
        description: 'Message type determining visual style',
        descriptionZh: '决定视觉样式的消息类型',
        control: {
          type: 'select',
          options: [
            { label: 'System', value: 'system' },
            { label: 'Info', value: 'info' },
            { label: 'Warning', value: 'warning' },
            { label: 'Error', value: 'error' },
          ],
        },
        defaultValue: 'system',
      },
    ],
    variants: [
      { name: 'System', nameZh: '系统', props: { content: 'Session restored from 5 minutes ago.', type: 'system' } },
      { name: 'Info', nameZh: '信息', props: { content: 'Agent activated successfully.', type: 'info' } },
      { name: 'Warning', nameZh: '警告', props: { content: 'Rate limit approaching.', type: 'warning' } },
      { name: 'Error', nameZh: '错误', props: { content: 'Connection lost.', type: 'error' } },
    ],
    mockData: (locale) => ({
      content: pickLocale(locale, 'This is a system message.', '这是一条系统消息。'),
    }),
  },
  {
    id: 'compaction-divider',
    name: 'CompactionDivider',
    nameZh: '压缩分隔线',
    category: 'Chat Messages',
    description: 'Horizontal rule with centered label shown after context compaction',
    descriptionZh: '上下文压缩后显示的居中标签分隔线',
    component: CompactionDivider,
    props: [
      {
        name: 'label',
        nameZh: '标签',
        description: 'Label text shown in the center',
        descriptionZh: '显示在中间的标签文本',
        control: { type: 'string', placeholder: 'Label...' },
        defaultValue: 'Conversation Compacted',
      },
    ],
    variants: [
      { name: 'Default', nameZh: '默认', props: { label: 'Conversation Compacted' } },
      { name: 'Custom Label', nameZh: '自定义标签', props: { label: 'Context Reset' } },
    ],
    mockData: (locale) => ({
      label: pickLocale(locale, 'Conversation Compacted', '会话已压缩'),
    }),
  },
  {
    id: 'processing-indicator',
    name: 'ProcessingIndicator',
    nameZh: '处理指示器',
    category: 'Chat Messages',
    description: 'Deterministic processing indicator driven by the shared Playground timeline',
    descriptionZh: '由共享 Playground 时间轴驱动的确定性处理指示器',
    component: ProcessingIndicator,
    props: [
      {
        name: 'phaseIndex',
        nameZh: '阶段索引',
        description: 'Deterministic scene phase',
        descriptionZh: '确定性场景阶段',
        control: { type: 'number', min: 0, max: PROCESSING_MESSAGE_KEYS.length - 1, step: 1 },
        defaultValue: 0,
      },
      {
        name: 'elapsed',
        nameZh: '已用时间',
        description: 'Initial elapsed time in seconds (only used when counting is false)',
        descriptionZh: '初始已用时间（秒），仅在非计数模式下使用',
        control: { type: 'number', min: 0, max: 120, step: 1 },
        defaultValue: 0,
      },
    ],
    variants: [
      { name: 'Thinking', nameZh: '思考中', props: { phaseIndex: 0, elapsed: 0 } },
      { name: 'Reasoning', nameZh: '推理中', props: { phaseIndex: 3, elapsed: 5 } },
      { name: 'Working', nameZh: '处理中', props: { phaseIndex: 28, elapsed: 30 } },
    ],
    mockData: () => ({}),
    source: {
      file: 'apps/electron/src/renderer/playground/registry/messages.tsx',
      symbol: 'ProcessingIndicator',
      coverage: 'standalone',
    },
    scene: {
      kind: 'timeline',
      label: 'Agent event flow',
      labelZh: '智能体事件流',
      frameDurationMs: 1_200,
      phases: [
        { id: 'thinking', label: 'Thinking started', labelZh: '思考已开始', props: { phaseIndex: 0, elapsed: 0 } },
        { id: 'reasoning', label: 'Reasoning stream', labelZh: '推理流', props: { phaseIndex: 3, elapsed: 5 } },
        { id: 'tools', label: 'Tool activity', labelZh: '工具活动', props: { phaseIndex: 12, elapsed: 12 } },
        { id: 'response', label: 'Response preparation', labelZh: '响应准备中', props: { phaseIndex: 28, elapsed: 30 } },
      ],
    },
  },
]
