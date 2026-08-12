import type { ComponentEntry, PlaygroundLocale } from './types'
import { useState, useEffect, useRef, useCallback, useMemo, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Play, RotateCcw } from 'lucide-react'
import {
  TurnCard,
  UserMessageBubble,
  ActivityCardsOverlay,
  extractOverlayCards,
  type ActivityItem,
  type ResponseContent,
} from '@mortise/ui'

// Import sample workflows
import {
  incidentResponseActivities,
  incidentResponseResponse,
} from './samples/incident-response'
import {
  deploymentActivities,
  deploymentResponse,
} from './samples/deployment'
import {
  customerSupportActivities,
  customerSupportResponse,
} from './samples/customer-support'

// Import icons for simple samples
import { nativeToolIcons, mcpToolIcons, createCircleIcon } from './sample-icons'

/** Wrapper with padding for playground preview */
function PaddedWrapper({ children }: { children: ReactNode }) {
  return <div className="p-8">{children}</div>
}

// ============================================================================
// Simple Sample Data (for quick demos) — localized via locale factories
// ============================================================================

const now = Date.now()

// Simple native tool samples (no user-visible text — shared across locales)
const simpleRead: ActivityItem = {
  id: 'simple-read-1',
  type: 'tool',
  status: 'completed',
  toolName: 'Read',
  toolInput: { file_path: '/src/components/Button.tsx' },
  timestamp: now - 5000,
}

const simpleEdit: ActivityItem = {
  id: 'simple-edit-1',
  type: 'tool',
  status: 'completed',
  toolName: 'Edit',
  toolInput: { file_path: '/src/auth/index.ts', old_string: '...', new_string: '...' },
  timestamp: now - 4000,
}

// Windows shell tool sample (real pi session shape: toolName 'pwsh', displayName 'Run Command')
function simplePwshActivity(locale: PlaygroundLocale): ActivityItem {
  return {
    id: 'simple-pwsh',
    type: 'tool',
    status: 'completed',
    toolName: 'pwsh',
    toolInput: {
      command: 'Get-ChildItem "$env:USERPROFILE\\.mortise\\logs" | Select-Object Name, Length, LastWriteTime',
      timeout: 120,
    },
    displayName: locale === 'zh-CN' ? '运行命令' : 'Run Command',
    content: [
      'Name                 Length LastWriteTime',
      '----                 ------ --------------',
      'runtime.log           4271750 8/11/2026 10:04:18 PM',
      'runtime.log.1         5226772 8/10/2026  3:53:46 PM',
    ].join('\n'),
    timestamp: now - 1500,
  }
}

function simpleBashGitActivity(locale: PlaygroundLocale): ActivityItem {
  const description = locale === 'zh-CN' ? '检查仓库状态' : 'Checking repository status'
  return {
    id: 'simple-bash-git',
    type: 'tool',
    status: 'completed',
    toolName: 'Bash',
    toolInput: { command: 'git status', description },
    intent: description,
    toolDisplayMeta: {
      displayName: 'Git',
      category: 'native',
      iconDataUrl: nativeToolIcons.git,
    },
    timestamp: now - 3000,
  }
}

function simpleBashNpmActivity(locale: PlaygroundLocale): ActivityItem {
  const description = locale === 'zh-CN' ? '运行测试套件' : 'Running the test suite'
  return {
    id: 'simple-bash-npm',
    type: 'tool',
    status: 'completed',
    toolName: 'Bash',
    toolInput: { command: 'npm test', description },
    intent: description,
    toolDisplayMeta: {
      displayName: 'npm',
      category: 'native',
      iconDataUrl: nativeToolIcons.npm,
    },
    timestamp: now - 2000,
  }
}

// Simple MCP tool samples
function simpleSlackActivity(locale: PlaygroundLocale): ActivityItem {
  const intent = locale === 'zh-CN' ? '向团队发送消息' : 'Sending a message to the team'
  const displayName = locale === 'zh-CN' ? '发送消息' : 'Send Message'
  return {
    id: 'simple-slack',
    type: 'tool',
    status: 'completed',
    toolName: 'mcp__slack__slack_send_message',
    toolInput: {
      channel: '#general',
      text: locale === 'zh-CN' ? '大家好！' : 'Hello team!',
      _intent: intent,
      _displayName: displayName,
    },
    intent,
    displayName,
    toolDisplayMeta: {
      displayName: 'Slack',
      category: 'mcp',
      iconDataUrl: mcpToolIcons.slack,
    },
    timestamp: now - 1000,
  }
}

function simpleStripeActivity(locale: PlaygroundLocale): ActivityItem {
  const intent = locale === 'zh-CN' ? '获取客户列表' : 'Fetching customer list'
  const displayName = locale === 'zh-CN' ? '列出客户' : 'List Customers'
  return {
    id: 'simple-stripe',
    type: 'tool',
    status: 'completed',
    toolName: 'mcp__stripe__list_customers',
    toolInput: {
      limit: 25,
      _intent: intent,
      _displayName: displayName,
    },
    intent,
    displayName,
    toolDisplayMeta: {
      displayName: 'Stripe',
      category: 'mcp',
      iconDataUrl: mcpToolIcons.stripe,
    },
    timestamp: now,
  }
}

function simpleActivities(locale: PlaygroundLocale): ActivityItem[] {
  return [
    simpleRead,
    simpleEdit,
    simpleBashGitActivity(locale),
    simpleBashNpmActivity(locale),
    simplePwshActivity(locale),
    simpleSlackActivity(locale),
    simpleStripeActivity(locale),
  ]
}

// Simple response
function shortResponse(locale: PlaygroundLocale): ResponseContent {
  return {
    text: locale === 'zh-CN'
      ? '已完成的请求已全部成功处理。'
      : "I've completed the requested operations. All tasks have been processed successfully.",
    isStreaming: false,
  }
}

// ============================================================================
// Playground Component with Mode Toggle
// ============================================================================

type DisplayMode = 'informative' | 'detailed'

/** Demo selectors used by registry variants — each builds a localized fixture. */
type TurnCardDemoId = 'incident' | 'deployment' | 'support' | 'simple' | 'pwsh'

interface TurnCardDemoContent {
  userMessage: string
  activities: ActivityItem[]
  response: ResponseContent
}

const DEMO_USER_MESSAGES: Record<TurnCardDemoId, { zh: string; en: string }> = {
  incident: {
    en: "There's a spike in errors on the dashboard. Can you investigate and fix the issue?",
    zh: '仪表盘出现错误激增，请调查并修复问题。',
  },
  deployment: {
    en: 'Deploy the new user authentication feature to production with full CI/CD pipeline.',
    zh: '通过完整的 CI/CD 流水线将新的用户认证功能部署到生产环境。',
  },
  support: {
    en: 'I got an email from a customer about a billing issue. Can you help resolve it?',
    zh: '我收到客户关于账单问题的邮件，能帮忙解决吗？',
  },
  simple: {
    en: 'Read the Button component, check git status, and post to Slack.',
    zh: '读取 Button 组件、检查 git 状态并发送消息到 Slack。',
  },
  pwsh: {
    en: 'List the recently modified files in the log directory.',
    zh: '列出日志目录里最近修改的文件',
  },
}

function buildTurnCardDemoContent(demo: TurnCardDemoId, locale: PlaygroundLocale): TurnCardDemoContent {
  const userMessage = DEMO_USER_MESSAGES[demo][locale === 'zh-CN' ? 'zh' : 'en']
  switch (demo) {
    case 'incident':
      return { userMessage, activities: incidentResponseActivities, response: incidentResponseResponse }
    case 'deployment':
      return { userMessage, activities: deploymentActivities, response: deploymentResponse }
    case 'support':
      return { userMessage, activities: customerSupportActivities, response: customerSupportResponse }
    case 'pwsh':
      return { userMessage, activities: [simplePwshActivity(locale)], response: shortResponse(locale) }
    default:
      return { userMessage, activities: simpleActivities(locale), response: shortResponse(locale) }
  }
}

function TurnCardModesDemo({
  demo = 'simple',
  initialMode = 'detailed',
  locale = 'en',
}: {
  demo?: TurnCardDemoId
  initialMode?: DisplayMode
  locale?: PlaygroundLocale
}) {
  const { t } = useTranslation()
  const [mode, setMode] = useState<DisplayMode>(initialMode)

  // Activity detail overlay (Input/Output cards) opened from tool rows
  const [detailActivity, setDetailActivity] = useState<ActivityItem | null>(null)

  // Playback state
  const [isPlaying, setIsPlaying] = useState(false)
  const [playbackActivities, setPlaybackActivities] = useState<ActivityItem[]>([])
  const [showResponse, setShowResponse] = useState(false)
  const playbackRef = useRef<{ cancel: boolean }>({ cancel: false })

  // Localized fixture for the selected demo
  const content = useMemo(() => buildTurnCardDemoContent(demo, locale), [demo, locale])
  const { userMessage, activities, response } = content

  // Sync mode when variant changes initialMode prop
  useEffect(() => {
    setMode(initialMode)
  }, [initialMode])

  // Reset playback when demo content changes (variant or locale switch)
  useEffect(() => {
    playbackRef.current.cancel = true
    setIsPlaying(false)
    setPlaybackActivities([])
    setShowResponse(false)
  }, [content])

  // Playback logic
  const startPlayback = useCallback(async () => {
    // Reset state
    playbackRef.current.cancel = false
    setIsPlaying(true)
    setPlaybackActivities([])
    setShowResponse(false)

    // Process each activity
    for (let i = 0; i < activities.length; i++) {
      if (playbackRef.current.cancel) return

      const activity = activities[i]

      // Add activity as "running"
      setPlaybackActivities(prev => [
        ...prev,
        { ...activity, status: 'running' }
      ])

      // Random "running" duration: 1000-2000ms
      await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 1000))
      if (playbackRef.current.cancel) return

      // Mark as "completed"
      setPlaybackActivities(prev =>
        prev.map((a, idx) => idx === prev.length - 1 ? { ...a, status: 'completed' } : a)
      )

      // No delay between activities - next one starts immediately after completion
    }

    // Show response after small delay
    if (!playbackRef.current.cancel) {
      await new Promise(resolve => setTimeout(resolve, 300))
      setShowResponse(true)
      setIsPlaying(false)
    }
  }, [activities])

  const resetPlayback = useCallback(() => {
    playbackRef.current.cancel = true
    setIsPlaying(false)
    setPlaybackActivities([])
    setShowResponse(false)
  }, [])

  // Determine what to show
  const hasPlaybackStarted = playbackActivities.length > 0 || isPlaying
  const displayActivities = hasPlaybackStarted ? playbackActivities : activities
  const displayResponse = hasPlaybackStarted ? (showResponse ? response : undefined) : response
  const isComplete = hasPlaybackStarted ? showResponse : true

  return (
    <div className="space-y-4">
      {/* Controls */}
      <div className="flex items-center gap-2 p-3 bg-muted/50 rounded-lg">
        {/* Playback Button */}
        <button
          onClick={hasPlaybackStarted ? resetPlayback : startPlayback}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md bg-background shadow-minimal text-foreground hover:bg-foreground/5 transition-colors"
        >
          {hasPlaybackStarted ? (
            <>
              <RotateCcw className="w-3.5 h-3.5" />
              {t('playground.turnCardModes.reset')}
            </>
          ) : (
            <>
              <Play className="w-3.5 h-3.5" />
              {t('playground.turnCardModes.play')}
            </>
          )}
        </button>

        <div className="w-px h-5 bg-border mx-2" />

        {/* Mode Toggle */}
        <span className="text-sm font-medium text-muted-foreground mr-2">{t('playground.turnCardModes.displayMode')}</span>
        <button
          onClick={() => setMode('informative')}
          className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
            mode === 'informative'
              ? 'bg-background shadow-minimal text-foreground'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          {t('playground.turnCardModes.modeInformative')}
        </button>
        <button
          onClick={() => setMode('detailed')}
          className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
            mode === 'detailed'
              ? 'bg-background shadow-minimal text-foreground'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          {t('playground.turnCardModes.modeDetailed')}
        </button>
        <span className="ml-4 text-xs text-muted-foreground">
          {mode === 'informative'
            ? t('playground.turnCardModes.informativeHint')
            : t('playground.turnCardModes.detailedHint')
          }
        </span>
      </div>

      {/* User Message (shows the user's request/intention) */}
      {userMessage && (
        <div className="pt-4">
          <UserMessageBubble content={userMessage} />
        </div>
      )}

      {/* TurnCard with mode and hover states enabled */}
      <TurnCard
        sessionId="playground-modes"
        turnId="playground-turn"
        activities={displayActivities}
        response={displayResponse}
        isStreaming={isPlaying}
        isComplete={isComplete}
        defaultExpanded={true}
        displayMode={mode}
        animateResponse={hasPlaybackStarted}
        onOpenFile={(path) => console.log('[Playground] Open file:', path)}
        onOpenUrl={(url) => console.log('[Playground] Open URL:', url)}
        onOpenActivityDetails={(activity) => setDetailActivity(activity)}
      />

      {/* Real detail overlay — same component the app uses when clicking a tool row */}
      {detailActivity && (
        <ActivityCardsOverlay
          isOpen={true}
          onClose={() => setDetailActivity(null)}
          cards={extractOverlayCards(detailActivity)}
          title={detailActivity.displayName || detailActivity.toolName || t('playground.turnCardModes.activity')}
        />
      )}
    </div>
  )
}

// ============================================================================
// Component Registry
// ============================================================================

export const turnCardModesComponents: ComponentEntry[] = [
  {
    id: 'turn-card-modes-all',
    name: 'All Tool Types',
    nameZh: '全部工具类型',
    category: 'TurnCard Modes',
    description: 'Compare Informative vs Detailed mode with various tool types and workflows',
    descriptionZh: '用多种工具类型与工作流对比 Informative 与 Detailed 模式',
    component: TurnCardModesDemo,
    wrapper: PaddedWrapper,
    layout: 'top',
    props: [
      {
        name: 'initialMode',
        nameZh: '初始模式',
        description: 'Starting display mode',
        descriptionZh: '起始显示模式',
        control: {
          type: 'select',
          options: [
            { label: 'Informative', value: 'informative' },
            { label: 'Detailed', value: 'detailed' },
          ],
        },
        defaultValue: 'detailed',
      },
    ],
    variants: [
      {
        name: '🚨 Incident Response',
        nameZh: '🚨 故障应急响应',
        description: 'Production incident: Sentry → Slack → GitHub → Fix → Deploy (12 steps)',
        descriptionZh: '生产故障：Sentry → Slack → GitHub → 修复 → 部署（12 步）',
        props: { demo: 'incident', initialMode: 'detailed' },
      },
      {
        name: '🚀 Full-Stack Deployment',
        nameZh: '🚀 全栈部署',
        description: 'Feature development through CI/CD to production (16 steps)',
        descriptionZh: '功能开发经 CI/CD 到生产部署（16 步）',
        props: { demo: 'deployment', initialMode: 'detailed' },
      },
      {
        name: '💬 Customer Support',
        nameZh: '💬 客户支持',
        description: 'Cross-platform support: Gmail → Stripe → ClickUp → Slack (10 steps)',
        descriptionZh: '跨平台支持：Gmail → Stripe → ClickUp → Slack（10 步）',
        props: { demo: 'support', initialMode: 'detailed' },
      },
      {
        name: 'Simple: Native + MCP Mix',
        nameZh: '简单：原生 + MCP 混合',
        description: 'Quick demo with native tools and MCP servers',
        descriptionZh: '原生工具与 MCP 服务器的快速演示',
        props: { demo: 'simple', initialMode: 'detailed' },
      },
      {
        name: 'Informative Mode Preview',
        nameZh: 'Informative 模式预览',
        description: 'Same mix starting in Informative mode',
        descriptionZh: '同一混合内容以 Informative 模式启动',
        props: { demo: 'simple', initialMode: 'informative' },
      },
      {
        name: 'Windows: pwsh shell tool',
        nameZh: 'Windows：pwsh shell 工具',
        description: 'Pwsh (Windows shell tool) — click the row to open Command + Output',
        descriptionZh: 'Pwsh（Windows shell 工具）——点击行以打开命令与输出',
        props: { demo: 'pwsh', initialMode: 'detailed' },
      },
    ],
    mockData: (locale) => ({ locale }),
  },
]
