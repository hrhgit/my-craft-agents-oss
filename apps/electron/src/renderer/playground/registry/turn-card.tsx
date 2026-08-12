import type { ComponentEntry, PlaygroundLocale } from './types'
import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  TurnCard,
  DocumentFormattedMarkdownOverlay,
  CodePreviewOverlay,
  MultiDiffPreviewOverlay,
  TerminalPreviewOverlay,
  JSONPreviewOverlay,
  GenericOverlay,
  DataTableOverlay,
  type ActivityItem,
  type ResponseContent,
  type TodoItem,
  type FileChange,
} from '@mortise/ui'

/** Wrapper with padding for playground preview */
function PaddedWrapper({ children }: { children: ReactNode }) {
  return <div className="p-8">{children}</div>
}

// ============================================================================
// Streaming Simulation Components
// ============================================================================

const streamingTextSample = `I've analyzed the authentication system and here's what I found:

## Authentication Architecture

The authentication system is built around three main components:

### 1. AuthHandler (\`src/auth/index.ts\`)
- Manages the OAuth 2.0 flow
- Handles token validation and refresh
- Provides session management

\`\`\`typescript
export class AuthHandler {
  async authenticate(credentials: Credentials): Promise<Session> {
    const token = await this.oauth.getToken(credentials);
    return this.createSession(token);
  }
}
\`\`\`

### 2. TokenManager
- Stores tokens securely using encryption
- Handles automatic token refresh before expiry

### 3. SessionStore
- Maintains active user sessions
- Handles session timeout and cleanup

Would you like me to implement any improvements?`

/** TurnCard wrapper whose content is projected by the shared scene timeline. */
function StreamingSimulationTurnCard({
  activities,
  intent,
  streamedText = '',
  isComplete = false,
}: {
  activities: ActivityItem[]
  intent?: string
  streamedText?: string
  isComplete?: boolean
}) {
  const response: ResponseContent = {
    text: streamedText,
    isStreaming: !isComplete,
  }

  return (
    <TurnCard
      sessionId="playground-session"
      turnId="playground-turn"
      activities={activities}
      response={response}
      intent={intent}
      isStreaming={!isComplete}
      isComplete={isComplete}
      onOpenFile={(path) => console.log('[Playground] Open file:', path)}
      onOpenUrl={(url) => console.log('[Playground] Open URL:', url)}
    />
  )
}

// ============================================================================
// Sample Data
// ============================================================================

const now = 1_735_603_200_000

// Completed tool activities
const completedGrepActivity: ActivityItem = {
  id: 'tool-1',
  type: 'tool',
  status: 'completed',
  toolName: 'Grep',
  toolInput: { pattern: 'AuthHandler', path: 'src/' },
  intent: 'Searching for authentication handlers',
  timestamp: now - 5000,
}

const completedReadActivity1: ActivityItem = {
  id: 'tool-2',
  type: 'tool',
  status: 'completed',
  toolName: 'Read',
  toolInput: { file_path: '/src/auth/index.ts' },
  timestamp: now - 4000,
}

const completedReadActivity2: ActivityItem = {
  id: 'tool-3',
  type: 'tool',
  status: 'completed',
  toolName: 'Read',
  toolInput: { file_path: '/src/auth/oauth.ts' },
  timestamp: now - 3000,
}

const completedBashActivity: ActivityItem = {
  id: 'tool-4',
  type: 'tool',
  status: 'completed',
  toolName: 'Bash',
  toolInput: { command: 'npm test', description: 'Running tests' },
  intent: 'Running the test suite',
  timestamp: now - 2000,
}

// Running tool activities
const runningGrepActivity: ActivityItem = {
  id: 'tool-running-1',
  type: 'tool',
  status: 'running',
  toolName: 'Grep',
  toolInput: { pattern: 'handleError', path: 'src/' },
  intent: 'Finding error handling patterns',
  timestamp: now - 1000,
}

const runningReadActivity: ActivityItem = {
  id: 'tool-running-2',
  type: 'tool',
  status: 'running',
  toolName: 'Read',
  toolInput: { file_path: '/src/lib/errors.ts' },
  timestamp: now - 500,
}

// Error activity
const errorActivity: ActivityItem = {
  id: 'tool-error-1',
  type: 'tool',
  status: 'error',
  toolName: 'Bash',
  toolInput: { command: 'npm run deploy' },
  error: 'Permission denied',
  timestamp: now - 1000,
}

// Pending activities
const pendingActivity: ActivityItem = {
  id: 'tool-pending-1',
  type: 'tool',
  status: 'pending',
  toolName: 'Write',
  toolInput: { file_path: '/src/auth/new-handler.ts' },
  timestamp: now,
}

// Intermediate messages (LLM commentary between tool calls)
const intermediateMessage1: ActivityItem = {
  id: 'intermediate-1',
  type: 'intermediate',
  status: 'completed',
  content: "Let me search for the authentication handlers in your codebase...",
  timestamp: now - 6000,
}

const intermediateMessage2: ActivityItem = {
  id: 'intermediate-2',
  type: 'intermediate',
  status: 'completed',
  content: "Found some matches. Now let me read the main auth file to understand the implementation.",
  timestamp: now - 3500,
}

const intermediateMessage3: ActivityItem = {
  id: 'intermediate-3',
  type: 'intermediate',
  status: 'completed',
  content: "I see this uses OAuth 2.0. Let me also check how tokens are managed.",
  timestamp: now - 2500,
}

const intermediateMessageRunning: ActivityItem = {
  id: 'intermediate-running',
  type: 'intermediate',
  status: 'completed',
  content: "Let me run the tests to make sure everything works correctly...",
  timestamp: now - 1500,
}

const intermediateMessageStreaming: ActivityItem = {
  id: 'intermediate-streaming',
  type: 'intermediate',
  status: 'running',  // Still streaming - will show "Thinking..."
  content: "",  // Content not shown while streaming
  timestamp: now,
}

// Sample responses
const shortResponse: ResponseContent = {
  text: "I found the authentication handlers in `src/auth/`. The main handler is `AuthHandler` which manages OAuth flows and token validation.",
  isStreaming: false,
}

const longResponse: ResponseContent = {
  text: `I've analyzed the authentication system and here's what I found:

## Authentication Architecture

The authentication system is built around three main components:

### 1. AuthHandler (\`src/auth/index.ts\`)
- Manages the OAuth 2.0 flow
- Handles token validation and refresh
- Provides session management

\`\`\`typescript
export class AuthHandler {
  async authenticate(credentials: Credentials): Promise<Session> {
    // OAuth flow implementation
    const token = await this.oauth.getToken(credentials);
    return this.createSession(token);
  }
}
\`\`\`

### 2. TokenManager (\`src/auth/tokens.ts\`)
- Stores tokens securely using encryption
- Handles automatic token refresh before expiry
- Provides token revocation

### 3. SessionStore (\`src/auth/sessions.ts\`)
- Maintains active user sessions
- Handles session timeout and cleanup
- Provides session restoration on app restart

## Recommendations

1. **Add refresh token rotation** - Currently tokens are reused until expiry
2. **Implement PKCE** - For better security in public clients
3. **Add audit logging** - Track authentication events for security monitoring

Would you like me to implement any of these improvements?`,
  isStreaming: false,
}

const streamingResponse: ResponseContent = {
  text: "I'm analyzing the codebase and looking for",
  isStreaming: true,
  streamStartTime: now - 500,
}

const emptyStreamingResponse: ResponseContent = {
  text: '',
  isStreaming: true,
  streamStartTime: now,
}

// ============================================================================
// Chinese sample data (localized variants used by mockData for zh-CN)
// ============================================================================

const zhCompletedGrepActivity: ActivityItem = {
  id: 'tool-1',
  type: 'tool',
  status: 'completed',
  toolName: 'Grep',
  toolInput: { pattern: 'AuthHandler', path: 'src/' },
  intent: '正在搜索认证处理器',
  timestamp: now - 5000,
}

const zhCompletedReadActivity1: ActivityItem = {
  id: 'tool-2',
  type: 'tool',
  status: 'completed',
  toolName: 'Read',
  toolInput: { file_path: '/src/auth/index.ts' },
  timestamp: now - 4000,
}

const zhCompletedReadActivity2: ActivityItem = {
  id: 'tool-3',
  type: 'tool',
  status: 'completed',
  toolName: 'Read',
  toolInput: { file_path: '/src/auth/oauth.ts' },
  timestamp: now - 3000,
}

const zhShortResponse: ResponseContent = {
  text: '我在 `src/auth/` 中找到了认证处理器。主要的处理器是 `AuthHandler`，它管理 OAuth 流程和令牌验证。',
  isStreaming: false,
}

/** Pick the localized sample data for the given playground locale. */
function pickLocale<T>(locale: PlaygroundLocale, en: T, zh: T): T {
  return locale === 'zh-CN' ? zh : en
}

// ============================================================================
// Helper: Generate many activities for stress testing
// ============================================================================

/** Tool names and file paths for realistic variety */
const toolVariety = [
  { tool: 'Read', getInput: (i: number) => ({ file_path: `/src/components/feature-${i}.tsx` }) },
  { tool: 'Grep', getInput: (i: number) => ({ pattern: `pattern${i}`, path: 'src/' }) },
  { tool: 'Glob', getInput: (i: number) => ({ pattern: `**/*${i}*.ts` }) },
  { tool: 'Bash', getInput: (i: number) => ({ command: `npm test -- file${i}` }) },
  { tool: 'Write', getInput: (i: number) => ({ file_path: `/src/utils/helper-${i}.ts` }) },
  { tool: 'Edit', getInput: (i: number) => ({ file_path: `/src/lib/module-${i}.ts` }) },
]

const commentaryVariety = [
  "Let me check this file for relevant code...",
  "I found some interesting patterns here.",
  "This looks like what we need.",
  "Searching for related implementations...",
  "Found a match, examining the details.",
  "This module handles the core logic.",
  "Let me verify this works correctly.",
  "Checking for any edge cases...",
]

/**
 * Generate a realistic sequence of activities with mixed tools and commentary.
 * Alternates between tool calls and intermediate messages for realism.
 */
function generateManyActivities(count: number): ActivityItem[] {
  const activities: ActivityItem[] = []
  let timestamp = now - (count * 100)

  for (let i = 0; i < count; i++) {
    // Every 3rd item is an intermediate message
    if (i % 3 === 0 && i > 0) {
      activities.push({
        id: `intermediate-${i}`,
        type: 'intermediate',
        status: 'completed',
        content: commentaryVariety[i % commentaryVariety.length],
        timestamp: timestamp,
      })
    } else {
      const toolInfo = toolVariety[i % toolVariety.length]
      activities.push({
        id: `tool-${i}`,
        type: 'tool',
        status: 'completed',
        toolName: toolInfo.tool,
        toolInput: toolInfo.getInput(i),
        timestamp: timestamp,
      })
    }
    timestamp += 100
  }

  return activities
}

/** Pre-generated 75 activities for playground */
const manyActivities75 = generateManyActivities(75)

// ============================================================================
// Sample Todos (for TodoWrite visualization)
// ============================================================================

/** Empty state - no todos */
const todosEmpty: TodoItem[] = []

/** All pending - just started planning */
const todosAllPending: TodoItem[] = [
  { content: 'Analyze authentication system', status: 'pending', activeForm: 'Analyzing authentication system' },
  { content: 'Implement token refresh logic', status: 'pending', activeForm: 'Implementing token refresh' },
  { content: 'Add unit tests for auth flow', status: 'pending', activeForm: 'Adding unit tests' },
  { content: 'Update API documentation', status: 'pending', activeForm: 'Updating documentation' },
]

/** In progress - currently working */
const todosInProgress: TodoItem[] = [
  { content: 'Analyze authentication system', status: 'completed', activeForm: 'Analyzing authentication system' },
  { content: 'Implement token refresh logic', status: 'in_progress', activeForm: 'Implementing token refresh' },
  { content: 'Add unit tests for auth flow', status: 'pending', activeForm: 'Adding unit tests' },
  { content: 'Update API documentation', status: 'pending', activeForm: 'Updating documentation' },
]

/** Mixed progress */
const todosMixed: TodoItem[] = [
  { content: 'Fix critical security bug', status: 'completed', activeForm: 'Fixing security bug' },
  { content: 'Implement OAuth 2.0 flow', status: 'in_progress', activeForm: 'Implementing OAuth flow' },
  { content: 'Add session timeout handling', status: 'pending', activeForm: 'Adding timeout handling' },
  { content: 'Improve error messages', status: 'pending', activeForm: 'Improving error messages' },
  { content: 'Add telemetry events', status: 'pending', activeForm: 'Adding telemetry' },
]

/** Almost done - 1 remaining */
const todosAlmostDone: TodoItem[] = [
  { content: 'Research authentication patterns', status: 'completed', activeForm: 'Researching patterns' },
  { content: 'Implement token validation', status: 'completed', activeForm: 'Implementing validation' },
  { content: 'Add refresh token rotation', status: 'completed', activeForm: 'Adding token rotation' },
  { content: 'Run test suite and verify', status: 'in_progress', activeForm: 'Running tests' },
]

/** All completed - task done */
const todosAllCompleted: TodoItem[] = [
  { content: 'Analyze current implementation', status: 'completed', activeForm: 'Analyzing implementation' },
  { content: 'Implement improvements', status: 'completed', activeForm: 'Implementing improvements' },
  { content: 'Add comprehensive tests', status: 'completed', activeForm: 'Adding tests' },
  { content: 'Update documentation', status: 'completed', activeForm: 'Updating docs' },
]

/** Long task list (stress test) */
const todosLong: TodoItem[] = [
  { content: 'Set up project structure', status: 'completed', activeForm: 'Setting up project' },
  { content: 'Configure build system', status: 'completed', activeForm: 'Configuring build' },
  { content: 'Install dependencies', status: 'completed', activeForm: 'Installing deps' },
  { content: 'Create database schema', status: 'completed', activeForm: 'Creating schema' },
  { content: 'Implement user model', status: 'completed', activeForm: 'Implementing model' },
  { content: 'Add authentication middleware', status: 'in_progress', activeForm: 'Adding auth middleware' },
  { content: 'Create API endpoints', status: 'pending', activeForm: 'Creating endpoints' },
  { content: 'Add input validation', status: 'pending', activeForm: 'Adding validation' },
  { content: 'Implement error handling', status: 'pending', activeForm: 'Implementing errors' },
  { content: 'Add rate limiting', status: 'pending', activeForm: 'Adding rate limits' },
  { content: 'Set up logging', status: 'pending', activeForm: 'Setting up logging' },
  { content: 'Write unit tests', status: 'pending', activeForm: 'Writing tests' },
]

// ============================================================================
// Component Entry
// ============================================================================

export const turnCardComponents: ComponentEntry[] = [
  {
    id: 'turn-card',
    name: 'TurnCard',
    category: 'Turn Cards',
    description: 'Email-like batched display for one assistant turn with activities and response',
    descriptionZh: '类似邮件的批量展示，用于呈现一次助手回合中的活动与响应',
    component: TurnCard,
    wrapper: PaddedWrapper,
    layout: 'top',
    props: [
      {
        name: 'isStreaming',
        description: 'Whether content is still being received',
        descriptionZh: '内容是否仍在接收中',
        control: { type: 'boolean' },
        defaultValue: false,
      },
      {
        name: 'isComplete',
        description: 'Whether this turn is fully complete',
        descriptionZh: '该回合是否已完全完成',
        control: { type: 'boolean' },
        defaultValue: true,
      },
      {
        name: 'defaultExpanded',
        description: 'Start with activities expanded',
        descriptionZh: '初始以展开状态显示活动',
        control: { type: 'boolean' },
        defaultValue: false,
      },
      {
        name: 'intent',
        description: 'Primary intent/goal for preview text',
        descriptionZh: '预览文本的主要意图或目标',
        control: { type: 'string', placeholder: 'e.g., Searching for auth handlers...' },
        defaultValue: '',
      },
    ],
    variants: [
      // Initial / Empty state
      {
        name: 'Initial (Starting)',
        nameZh: '初始（启动中）',
        description: 'No activities yet, just starting',
        descriptionZh: '还没有任何活动，刚刚开始',
        props: {
          activities: [],
          response: undefined,
          isStreaming: true,
          isComplete: false,
        },
      },
      // Single tool running
      {
        name: 'Single Tool Running',
        nameZh: '单个工具运行中',
        description: 'One tool currently executing',
        descriptionZh: '当前正在执行一个工具',
        props: {
          activities: [runningGrepActivity],
          response: undefined,
          isStreaming: true,
          isComplete: false,
          intent: 'Finding error handling patterns',
        },
      },
      // Multiple tools running
      {
        name: 'Multiple Tools Running',
        nameZh: '多个工具运行中',
        description: 'Several tools executing in parallel',
        descriptionZh: '多个工具正在并行执行',
        props: {
          activities: [
            { ...completedGrepActivity, status: 'completed' },
            runningReadActivity,
            pendingActivity,
          ],
          response: undefined,
          isStreaming: true,
          isComplete: false,
        },
      },
      // All tools completed (collapsed)
      {
        name: 'Tools Completed (Collapsed)',
        nameZh: '工具已完成（折叠）',
        description: 'Multiple tools finished, collapsed by default',
        descriptionZh: '多个工具已完成，默认折叠显示',
        props: {
          activities: [
            completedGrepActivity,
            completedReadActivity1,
            completedReadActivity2,
          ],
          response: undefined,
          isStreaming: false,
          isComplete: false,
        },
      },
      // Tools completed, now streaming response
      {
        name: 'Streaming Response',
        nameZh: '流式响应',
        description: 'Tools done, response is streaming',
        descriptionZh: '工具已完成，响应正在流式输出',
        props: {
          activities: [
            completedGrepActivity,
            completedReadActivity1,
          ],
          response: streamingResponse,
          isStreaming: true,
          isComplete: false,
        },
      },
      // Waiting for response (empty streaming)
      {
        name: 'Waiting for Response',
        nameZh: '等待响应',
        description: 'Tools done, waiting for response to start',
        descriptionZh: '工具已完成，正在等待响应开始',
        props: {
          activities: [
            completedGrepActivity,
            completedReadActivity1,
          ],
          response: emptyStreamingResponse,
          isStreaming: true,
          isComplete: false,
        },
      },
      // Complete turn with short response
      {
        name: 'Complete (Short)',
        nameZh: '已完成（简短）',
        description: 'Finished turn with brief response',
        descriptionZh: '已完成回合，带有简短回复',
        props: {
          activities: [
            completedGrepActivity,
            completedReadActivity1,
            completedReadActivity2,
          ],
          response: shortResponse,
          isStreaming: false,
          isComplete: true,
        },
      },
      // Complete turn with long response
      {
        name: 'Complete (Long)',
        nameZh: '已完成（详细）',
        description: 'Finished turn with detailed response',
        descriptionZh: '已完成回合，带有详细回复',
        props: {
          activities: [
            completedGrepActivity,
            completedReadActivity1,
            completedReadActivity2,
            completedBashActivity,
          ],
          response: longResponse,
          isStreaming: false,
          isComplete: true,
          intent: 'Analyzing authentication system',
        },
      },
      // Error state
      {
        name: 'Error State',
        nameZh: '错误状态',
        description: 'A tool failed during execution',
        descriptionZh: '某个工具在执行期间失败',
        props: {
          activities: [
            completedGrepActivity,
            completedReadActivity1,
            errorActivity,
          ],
          response: undefined,
          isStreaming: false,
          isComplete: false,
          defaultExpanded: true,
        },
      },
      // Response only (no tools)
      {
        name: 'Response Only',
        nameZh: '仅响应',
        description: 'Direct response without tool usage',
        descriptionZh: '不使用工具的直接回复',
        props: {
          activities: [],
          response: shortResponse,
          isStreaming: false,
          isComplete: true,
        },
      },
      // Many tools
      {
        name: 'Many Tools (5+)',
        nameZh: '大量工具（5+）',
        description: 'Large number of completed tools',
        descriptionZh: '大量已完成的工具',
        props: {
          activities: [
            completedGrepActivity,
            completedReadActivity1,
            completedReadActivity2,
            completedBashActivity,
            { ...completedReadActivity1, id: 'tool-5', toolInput: { file_path: '/src/config.ts' } },
            { ...completedReadActivity1, id: 'tool-6', toolInput: { file_path: '/src/utils.ts' } },
          ],
          response: shortResponse,
          isStreaming: false,
          isComplete: true,
        },
      },
      // Extreme: 75 steps (real-world stress test)
      {
        name: 'Extreme: 75 Steps',
        nameZh: '极限：75 个步骤',
        description: 'Stress test with 75 activities - tests scrolling, animation limits, and performance',
        descriptionZh: '包含 75 个活动的压力测试 - 检验滚动、动画上限与性能',
        props: {
          activities: manyActivities75,
          response: longResponse,
          isStreaming: false,
          isComplete: true,
          defaultExpanded: true,
          intent: 'Comprehensive codebase analysis',
        },
      },
      // Expanded by default
      {
        name: 'Expanded (Default)',
        nameZh: '默认展开',
        description: 'Activities shown expanded initially',
        descriptionZh: '活动默认以展开状态显示',
        props: {
          activities: [
            completedGrepActivity,
            completedReadActivity1,
            completedReadActivity2,
          ],
          response: shortResponse,
          isStreaming: false,
          isComplete: true,
          defaultExpanded: true,
        },
      },
      // Mixed: Tools with intermediate messages (completed)
      {
        name: 'Mixed: Tools + Commentary',
        nameZh: '混合：工具 + 评述',
        description: 'Tools interleaved with LLM intermediate messages',
        descriptionZh: '工具与 LLM 中间消息交错出现',
        props: {
          activities: [
            intermediateMessage1,
            completedGrepActivity,
            intermediateMessage2,
            completedReadActivity1,
            intermediateMessage3,
            completedReadActivity2,
          ],
          response: shortResponse,
          isStreaming: false,
          isComplete: true,
          defaultExpanded: true,
        },
      },
      // Mixed: In progress with commentary
      {
        name: 'Mixed: In Progress',
        nameZh: '混合：进行中',
        description: 'Tool running after intermediate message',
        descriptionZh: '中间消息之后工具仍在运行',
        props: {
          activities: [
            intermediateMessage1,
            completedGrepActivity,
            intermediateMessage2,
            completedReadActivity1,
            intermediateMessageRunning,
            runningReadActivity,
          ],
          response: undefined,
          isStreaming: true,
          isComplete: false,
        },
      },
      // Mixed: Many steps
      {
        name: 'Mixed: Long Chain',
        nameZh: '混合：长链路',
        description: 'Extended conversation with multiple tool/message pairs',
        descriptionZh: '包含多组工具/消息对的扩展对话',
        props: {
          activities: [
            intermediateMessage1,
            completedGrepActivity,
            intermediateMessage2,
            completedReadActivity1,
            intermediateMessage3,
            completedReadActivity2,
            intermediateMessageRunning,
            completedBashActivity,
          ],
          response: longResponse,
          isStreaming: false,
          isComplete: true,
          defaultExpanded: true,
        },
      },
      // Mixed: Commentary only (no tools yet)
      {
        name: 'Mixed: Thinking Start',
        nameZh: '混合：思考开始',
        description: 'LLM thinking before first tool call',
        descriptionZh: '首次调用工具前的 LLM 思考',
        props: {
          activities: [
            intermediateMessage1,
          ],
          response: undefined,
          isStreaming: true,
          isComplete: false,
        },
      },
      // Mixed: Currently thinking (streaming intermediate)
      {
        name: 'Mixed: Currently Thinking',
        nameZh: '混合：正在思考',
        description: 'LLM is streaming an intermediate message',
        descriptionZh: 'LLM 正在流式输出中间消息',
        props: {
          activities: [
            intermediateMessage1,
            completedGrepActivity,
            intermediateMessage2,
            completedReadActivity1,
            intermediateMessageStreaming,
          ],
          response: undefined,
          isStreaming: true,
          isComplete: false,
          defaultExpanded: true,
        },
      },
      // ========== TodoWrite Variants ==========
      // Todo: Just started (all pending)
      {
        name: 'Todo: Just Started',
        nameZh: '待办：刚开始',
        description: 'TodoWrite with all items pending - just created the plan',
        descriptionZh: 'TodoWrite 所有条目均为待处理 - 刚创建计划',
        props: {
          activities: [completedGrepActivity],
          response: undefined,
          isStreaming: false,
          isComplete: false,
          defaultExpanded: true,
          todos: todosAllPending,
        },
      },
      // Todo: In progress
      {
        name: 'Todo: In Progress',
        nameZh: '待办：进行中',
        description: 'TodoWrite with one item in progress',
        descriptionZh: 'TodoWrite 有一个条目正在处理',
        props: {
          activities: [completedGrepActivity, completedReadActivity1],
          response: undefined,
          isStreaming: true,
          isComplete: false,
          defaultExpanded: true,
          todos: todosInProgress,
        },
      },
      // Todo: Mixed progress
      {
        name: 'Todo: Mixed Progress',
        nameZh: '待办：混合进度',
        description: 'TodoWrite with mixed completed/in_progress/pending items',
        descriptionZh: 'TodoWrite 包含已完成/进行中/待处理混合条目',
        props: {
          activities: [completedGrepActivity, completedReadActivity1, completedBashActivity],
          response: shortResponse,
          isStreaming: false,
          isComplete: true,
          defaultExpanded: true,
          todos: todosMixed,
        },
      },
      // Todo: Almost done
      {
        name: 'Todo: Almost Done',
        nameZh: '待办：即将完成',
        description: 'TodoWrite with most items completed, one in progress',
        descriptionZh: 'TodoWrite 大部分条目已完成，一个正在处理',
        props: {
          activities: [completedGrepActivity, completedReadActivity1],
          response: undefined,
          isStreaming: true,
          isComplete: false,
          defaultExpanded: true,
          todos: todosAlmostDone,
        },
      },
      // Todo: All completed
      {
        name: 'Todo: All Completed',
        nameZh: '待办：全部完成',
        description: 'TodoWrite with all items done - task complete',
        descriptionZh: 'TodoWrite 所有条目均已完成 - 任务完成',
        props: {
          activities: [completedGrepActivity, completedReadActivity1, completedBashActivity],
          response: longResponse,
          isStreaming: false,
          isComplete: true,
          defaultExpanded: true,
          todos: todosAllCompleted,
        },
      },
      // Todo: Long list (stress test)
      {
        name: 'Todo: Long List (12 items)',
        nameZh: '待办：长列表（12 项）',
        description: 'TodoWrite stress test with many items',
        descriptionZh: 'TodoWrite 多条目压力测试',
        props: {
          activities: [completedGrepActivity, completedReadActivity1],
          response: shortResponse,
          isStreaming: false,
          isComplete: true,
          defaultExpanded: true,
          todos: todosLong,
        },
      },
      // Todo: Only (no activities/response)
      {
        name: 'Todo: Standalone',
        nameZh: '待办：独立',
        description: 'TodoWrite without activities or response - planning phase only',
        descriptionZh: '无活动与响应的 TodoWrite - 仅规划阶段',
        props: {
          activities: [],
          response: undefined,
          isStreaming: false,
          isComplete: false,
          defaultExpanded: true,
          todos: todosMixed,
        },
      },
    ],
    mockData: (locale) => ({
      activities: [
        pickLocale(locale, completedGrepActivity, zhCompletedGrepActivity),
        pickLocale(locale, completedReadActivity1, zhCompletedReadActivity1),
        pickLocale(locale, completedReadActivity2, zhCompletedReadActivity2),
      ],
      response: pickLocale(locale, shortResponse, zhShortResponse),
      onOpenFile: (path: string) => console.log('[Playground] Open file:', path),
      onOpenUrl: (url: string) => console.log('[Playground] Open URL:', url),
    }),
  },
  // Streaming Simulation - Live demo of streaming response
  {
    id: 'turn-card-streaming-sim',
    name: 'TurnCard (Streaming Sim)',
    nameZh: 'TurnCard（流式模拟）',
    category: 'Turn Cards',
    description: 'Deterministic document-style streaming preview driven by the shared scene timeline',
    descriptionZh: '由共享场景时间线驱动的确定性文档式流式预览',
    component: StreamingSimulationTurnCard,
    wrapper: PaddedWrapper,
    layout: 'top',
    props: [
      {
        name: 'intent',
        description: 'Intent text shown in header',
        descriptionZh: '显示在头部区域的意图文本',
        control: { type: 'string', placeholder: 'e.g., Analyzing auth system...' },
        defaultValue: 'Analyzing the authentication system',
      },
    ],
    variants: [
      {
        name: 'Response Only (Slow)',
        nameZh: '仅响应（慢速）',
        description: 'Document preview with gradient and toggle - slow to observe cross-fade',
        descriptionZh: '带渐变与切换的文档预览 - 慢速以便观察交叉淡化',
        props: {
          activities: [],
          streamedText: streamingTextSample.slice(0, 180),
        },
      },
      {
        name: 'After Tools (Normal)',
        nameZh: '工具之后（常规）',
        description: 'Shows last few lines in large card with batched updates',
        descriptionZh: '在大卡片中显示最后几行，分批更新',
        props: {
          activities: [
            completedGrepActivity,
            completedReadActivity1,
            completedReadActivity2,
          ],
          streamedText: streamingTextSample.slice(0, 420),
          intent: 'Analyzing authentication handlers',
        },
      },
      {
        name: 'Long Content (Slow)',
        nameZh: '长内容（慢速）',
        description: 'Best for observing gradient at top and cross-fade effect',
        descriptionZh: '最适合观察顶部渐变与交叉淡化效果',
        props: {
          activities: [
            completedGrepActivity,
            completedReadActivity1,
          ],
          streamedText: streamingTextSample.slice(0, 620),
        },
      },
      {
        name: 'After Mixed (Fast)',
        nameZh: '混合之后（快速）',
        description: 'Fast streaming after tools + commentary',
        descriptionZh: '工具 + 评述之后的快速流式输出',
        props: {
          activities: [
            intermediateMessage1,
            completedGrepActivity,
            intermediateMessage2,
            completedReadActivity1,
          ],
          streamedText: streamingTextSample,
          isComplete: true,
          intent: 'Searching for patterns',
        },
      },
    ],
    mockData: (locale) => ({
      activities: [
        pickLocale(locale, completedGrepActivity, zhCompletedGrepActivity),
        pickLocale(locale, completedReadActivity1, zhCompletedReadActivity1),
      ],
      intent: locale === 'zh-CN' ? '正在分析认证系统' : 'Analyzing the authentication system',
    }),
    source: {
      file: 'packages/ui/src/components/chat/TurnCard.tsx',
      symbol: 'TurnCard',
      coverage: 'standalone',
    },
    scene: {
      kind: 'timeline',
      label: 'Agent response stream',
      labelZh: 'Agent 响应流',
      frameDurationMs: 1_500,
      phases: [
        { id: 'request', label: 'Request accepted', labelZh: '已接受请求', props: { streamedText: '', isComplete: false } },
        { id: 'opening', label: 'First response chunk', labelZh: '首个响应片段', props: { streamedText: streamingTextSample.slice(0, 180), isComplete: false } },
        { id: 'analysis', label: 'Response in progress', labelZh: '响应进行中', props: { streamedText: streamingTextSample.slice(0, 420), isComplete: false } },
        { id: 'complete', label: 'Response complete', labelZh: '响应完成', props: { streamedText: streamingTextSample, isComplete: true } },
      ],
    },
  },
]

// ============================================================================
// Fullscreen Overlay Components
// ============================================================================

/** Sample markdown content for fullscreen testing */
const sampleMarkdownContent = `# Authentication System Analysis

I've completed my analysis of the authentication system. Here's what I found:

## Overview

The authentication system is built around three main components that work together to provide secure user authentication.

### 1. AuthHandler (\`src/auth/index.ts\`)

This is the main entry point for all authentication operations:

- Manages the OAuth 2.0 flow
- Handles token validation and refresh
- Provides session management
- Supports multiple identity providers (Google, GitHub, Microsoft)

\`\`\`typescript
export class AuthHandler {
  private oauth: OAuthClient;
  private tokenManager: TokenManager;
  private sessionStore: SessionStore;

  async authenticate(credentials: Credentials): Promise<Session> {
    // Validate credentials format
    this.validateCredentials(credentials);

    // Get OAuth token from provider
    const token = await this.oauth.getToken(credentials);

    // Create and store session
    return this.createSession(token);
  }

  async refreshToken(session: Session): Promise<Session> {
    const newToken = await this.oauth.refresh(session.refreshToken);
    return this.updateSession(session.id, newToken);
  }
}
\`\`\`

### 2. TokenManager (\`src/auth/tokens.ts\`)

Handles secure token storage and lifecycle:

- Stores tokens securely using AES-256 encryption
- Handles automatic token refresh before expiry (5 minute buffer)
- Provides token revocation and cleanup
- Supports both access tokens and refresh tokens

### 3. SessionStore (\`src/auth/sessions.ts\`)

Maintains active user sessions with the following features:

- In-memory session cache for fast lookups
- Persistent storage backed by Redis
- Automatic session timeout and cleanup
- Session restoration on app restart

## Security Considerations

The current implementation has several security strengths:

1. **Token encryption** - All tokens are encrypted at rest
2. **Short-lived tokens** - Access tokens expire in 15 minutes
3. **Secure refresh** - Refresh tokens are rotated on each use
4. **Session binding** - Sessions are bound to device fingerprint

However, I noticed a few areas that could be improved:

- **PKCE support** - Not currently implemented for public clients
- **Rate limiting** - Auth endpoints lack rate limiting
- **Audit logging** - Authentication events aren't logged

## Recommendations

Based on my analysis, here are my recommendations:

1. **Implement PKCE** for all OAuth flows to prevent authorization code interception
2. **Add rate limiting** to prevent brute force attacks (suggest: 5 attempts per minute)
3. **Enable audit logging** for security monitoring and compliance
4. **Add MFA support** for sensitive operations

Would you like me to implement any of these improvements?`

/** Sample markdown content (Chinese) for fullscreen testing */
const zhSampleMarkdownContent = `# 认证系统分析

我已经完成了对认证系统的分析。以下是我的发现：

## 概述

认证系统由三个协同工作的核心组件构成，用于提供安全的用户认证。

### 1. AuthHandler（\`src/auth/index.ts\`）

这是所有认证操作的主要入口：

- 管理 OAuth 2.0 流程
- 处理令牌验证与刷新
- 提供会话管理
- 支持多个身份提供商（Google、GitHub、Microsoft）

\`\`\`typescript
export class AuthHandler {
  private oauth: OAuthClient;
  private tokenManager: TokenManager;
  private sessionStore: SessionStore;

  async authenticate(credentials: Credentials): Promise<Session> {
    // Validate credentials format
    this.validateCredentials(credentials);

    // Get OAuth token from provider
    const token = await this.oauth.getToken(credentials);

    // Create and store session
    return this.createSession(token);
  }

  async refreshToken(session: Session): Promise<Session> {
    const newToken = await this.oauth.refresh(session.refreshToken);
    return this.updateSession(session.id, newToken);
  }
}
\`\`\`

### 2. TokenManager（\`src/auth/tokens.ts\`）

负责令牌的安全存储与生命周期管理：

- 使用 AES-256 加密安全存储令牌
- 在过期前自动刷新令牌（提前 5 分钟）
- 提供令牌吊销与清理
- 同时支持访问令牌与刷新令牌

### 3. SessionStore（\`src/auth/sessions.ts\`）

维护活跃的用户会话，具备以下特性：

- 内存会话缓存，实现快速查找
- 基于 Redis 的持久化存储
- 自动会话超时与清理
- 应用重启后恢复会话

## 安全考量

当前实现具备多项安全优势：

1. **令牌加密** - 所有令牌在静态存储时均加密
2. **短时令牌** - 访问令牌 15 分钟过期
3. **安全刷新** - 刷新令牌每次使用后轮换
4. **会话绑定** - 会话绑定到设备指纹

不过，我注意到一些可以改进的地方：

- **PKCE 支持** - 尚未为公共客户端实现
- **速率限制** - 认证端点缺少速率限制
- **审计日志** - 认证事件未被记录

## 建议

基于我的分析，以下是我的建议：

1. 为所有 OAuth 流程**实现 PKCE**，防止授权码被拦截
2. **添加速率限制**，防止暴力破解攻击（建议：每分钟 5 次尝试）
3. **启用审计日志**，用于安全监控与合规
4. 为敏感操作**添加 MFA 支持**

需要我实施其中任何一项改进吗？`

/** Plan-style content for testing plan variant */
const samplePlanContent = `# Implement Authentication Improvements

## Summary

This plan outlines the implementation of security improvements to the authentication system based on the analysis findings.

## Steps

### 1. Implement PKCE Support

Add PKCE (Proof Key for Code Exchange) to all OAuth flows:

- Generate code verifier and challenge on auth start
- Include code_challenge in authorization request
- Verify code_verifier on token exchange

**Files to modify:**
- \`src/auth/oauth.ts\`
- \`src/auth/index.ts\`

### 2. Add Rate Limiting

Implement rate limiting on authentication endpoints:

- Configure limits: 5 attempts per minute per IP
- Use sliding window algorithm
- Add Redis-backed rate limiter

**New files:**
- \`src/middleware/rate-limiter.ts\`

### 3. Enable Audit Logging

Add comprehensive audit logging for auth events:

- Log successful/failed login attempts
- Track token refresh and revocation
- Include metadata (IP, user agent, timestamp)

**Files to modify:**
- \`src/auth/index.ts\`
- \`src/lib/logger.ts\`

### 4. Add MFA Support

Implement multi-factor authentication:

- Support TOTP (Google Authenticator, Authy)
- Add SMS fallback option
- Implement backup codes

**New files:**
- \`src/auth/mfa.ts\`
- \`src/auth/totp.ts\`

## Testing

After implementation, we'll need to:

1. Update existing auth tests
2. Add PKCE verification tests
3. Add rate limiting tests
4. Add MFA enrollment/verification tests

## Timeline

Estimated completion: 3-4 days`

/** Wrapper that provides controlled open state for playground */
function DocumentFormattedMarkdownOverlayPlayground({
  content,
  variant,
}: {
  content: string
  variant?: 'response' | 'plan'
}) {
  const { t } = useTranslation()
  const [isOpen, setIsOpen] = useState(true)

  return (
    <div className="p-8">
      <button
        onClick={() => setIsOpen(true)}
        className="px-4 py-2 bg-accent text-accent-foreground rounded-lg text-sm font-medium hover:bg-accent/90"
      >
        {t('playground.turnCard.documentOverlay.open')}
      </button>
      <DocumentFormattedMarkdownOverlay
        content={content}
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        variant={variant}
        onOpenUrl={(url) => console.log('[Playground] Open URL:', url)}
        onOpenFile={(path) => console.log('[Playground] Open file:', path)}
      />
    </div>
  )
}

// ============================================================================
// Code Preview Overlay - Playground Wrapper
// ============================================================================

const sampleTypeScriptCode = `import { useState, useEffect, useCallback } from 'react'
import type { Session, AuthToken } from '../types'
import { encryptToken, decryptToken } from '../lib/crypto'

/**
 * TokenManager - Handles secure token storage and lifecycle
 *
 * Features:
 * - AES-256 encryption for token storage
 * - Automatic refresh before expiry (5 min buffer)
 * - Token revocation and cleanup
 */
export class TokenManager {
  private readonly encryptionKey: CryptoKey
  private refreshTimers: Map<string, NodeJS.Timeout> = new Map()

  constructor(private readonly storage: TokenStorage) {
    this.encryptionKey = this.deriveKey()
  }

  /**
   * Store a new token pair securely.
   * Encrypts both access and refresh tokens before persisting.
   */
  async storeToken(sessionId: string, token: AuthToken): Promise<void> {
    const encrypted = await encryptToken(token, this.encryptionKey)
    await this.storage.set(sessionId, encrypted)

    // Schedule refresh before expiry
    this.scheduleRefresh(sessionId, token.expiresIn)
  }

  /**
   * Retrieve and decrypt a stored token.
   * Returns null if token doesn't exist or decryption fails.
   */
  async getToken(sessionId: string): Promise<AuthToken | null> {
    const encrypted = await this.storage.get(sessionId)
    if (!encrypted) return null

    try {
      return await decryptToken(encrypted, this.encryptionKey)
    } catch (error) {
      console.error('[TokenManager] Decryption failed:', error)
      await this.revokeToken(sessionId)
      return null
    }
  }

  /**
   * Revoke a token and clean up associated resources.
   */
  async revokeToken(sessionId: string): Promise<void> {
    const timer = this.refreshTimers.get(sessionId)
    if (timer) {
      clearTimeout(timer)
      this.refreshTimers.delete(sessionId)
    }
    await this.storage.delete(sessionId)
  }

  private scheduleRefresh(sessionId: string, expiresIn: number): void {
    // Refresh 5 minutes before expiry
    const refreshIn = Math.max(0, (expiresIn - 300) * 1000)
    const timer = setTimeout(() => this.refreshToken(sessionId), refreshIn)
    this.refreshTimers.set(sessionId, timer)
  }

  private async refreshToken(sessionId: string): Promise<void> {
    const token = await this.getToken(sessionId)
    if (!token?.refreshToken) return

    try {
      const newToken = await this.oauth.refresh(token.refreshToken)
      await this.storeToken(sessionId, newToken)
    } catch (error) {
      console.error('[TokenManager] Refresh failed:', error)
      await this.revokeToken(sessionId)
    }
  }

  private deriveKey(): CryptoKey {
    // Key derivation from environment secret
    return crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(process.env.TOKEN_SECRET),
      { name: 'AES-GCM' },
      false,
      ['encrypt', 'decrypt']
    ) as unknown as CryptoKey
  }
}

interface TokenStorage {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}
`

const samplePythonCode = `"""
Machine Learning Pipeline - Data preprocessing and model training

This module provides a complete ML pipeline for classification tasks,
including data loading, preprocessing, training, and evaluation.
"""

import numpy as np
import pandas as pd
from sklearn.model_selection import train_test_split, cross_val_score
from sklearn.preprocessing import StandardScaler, LabelEncoder
from sklearn.ensemble import RandomForestClassifier, GradientBoostingClassifier
from sklearn.metrics import classification_report, confusion_matrix
from typing import Optional, Tuple, Dict, Any
import logging

logger = logging.getLogger(__name__)


class MLPipeline:
    """End-to-end machine learning pipeline for classification."""

    def __init__(self, random_state: int = 42):
        self.random_state = random_state
        self.scaler = StandardScaler()
        self.label_encoder = LabelEncoder()
        self.model: Optional[Any] = None
        self._is_fitted = False

    def load_data(self, filepath: str) -> pd.DataFrame:
        """Load dataset from CSV with basic validation."""
        logger.info(f"Loading data from {filepath}")
        df = pd.read_csv(filepath)

        if df.empty:
            raise ValueError(f"Empty dataset: {filepath}")

        logger.info(f"Loaded {len(df)} rows, {len(df.columns)} columns")
        return df

    def preprocess(
        self,
        df: pd.DataFrame,
        target_col: str,
        drop_cols: Optional[list] = None,
    ) -> Tuple[np.ndarray, np.ndarray]:
        """Preprocess data: encode labels, scale features, handle missing values."""
        if drop_cols:
            df = df.drop(columns=drop_cols, errors='ignore')

        # Handle missing values
        numeric_cols = df.select_dtypes(include=[np.number]).columns
        df[numeric_cols] = df[numeric_cols].fillna(df[numeric_cols].median())

        # Encode target
        y = self.label_encoder.fit_transform(df[target_col])

        # Scale features
        X = df.drop(columns=[target_col])
        X = pd.get_dummies(X, drop_first=True)  # One-hot encode categoricals
        X_scaled = self.scaler.fit_transform(X)

        return X_scaled, y

    def train(
        self,
        X: np.ndarray,
        y: np.ndarray,
        model_type: str = "random_forest",
        **kwargs: Dict[str, Any],
    ) -> Dict[str, float]:
        """Train model and return cross-validation scores."""
        if model_type == "random_forest":
            self.model = RandomForestClassifier(
                random_state=self.random_state, **kwargs
            )
        elif model_type == "gradient_boosting":
            self.model = GradientBoostingClassifier(
                random_state=self.random_state, **kwargs
            )
        else:
            raise ValueError(f"Unknown model type: {model_type}")

        # Cross-validation
        scores = cross_val_score(self.model, X, y, cv=5, scoring="accuracy")
        logger.info(f"CV Accuracy: {scores.mean():.4f} (+/- {scores.std():.4f})")

        # Fit on full training data
        self.model.fit(X, y)
        self._is_fitted = True

        return {"mean_accuracy": scores.mean(), "std_accuracy": scores.std()}
`

/** Embedded preview of CodePreviewOverlay */
function CodePreviewOverlayPlayground({
  content,
  filePath,
  mode,
  startLine,
  totalLines,
  numLines,
  error,
}: {
  content: string
  filePath: string
  mode?: 'read' | 'write'
  startLine?: number
  totalLines?: number
  numLines?: number
  error?: string
}) {
  return (
    <div className="h-[500px]">
      <CodePreviewOverlay
        isOpen={true}
        onClose={() => {}}
        embedded
        content={content}
        filePath={filePath}
        mode={mode}
        startLine={startLine}
        totalLines={totalLines}
        numLines={numLines}
        error={error}
      />
    </div>
  )
}

// ============================================================================
// Multi-Diff Preview Overlay - Playground Wrapper
// ============================================================================

const sampleMultiDiffChanges: FileChange[] = [
  {
    id: 'change-1',
    filePath: '/src/auth/index.ts',
    toolType: 'Edit',
    original: `  async authenticate(credentials: Credentials): Promise<Session> {
    const token = await this.oauth.getToken(credentials);
    return this.createSession(token);
  }`,
    modified: `  async authenticate(credentials: Credentials): Promise<Session> {
    // Validate credentials before attempting OAuth flow
    this.validateCredentials(credentials);

    // Generate PKCE challenge for security
    const { verifier, challenge } = await generatePKCE();

    const token = await this.oauth.getToken(credentials, {
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
    });

    // Store verifier for token exchange verification
    await this.storeVerifier(token.authCode, verifier);

    return this.createSession(token);
  }`,
  },
  {
    id: 'change-2',
    filePath: '/src/auth/oauth.ts',
    toolType: 'Edit',
    original: `export interface OAuthOptions {
  clientId: string;
  redirectUri: string;
  scopes: string[];
}`,
    modified: `export interface OAuthOptions {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  /** PKCE code challenge for authorization request */
  codeChallenge?: string;
  /** PKCE challenge method (always S256) */
  codeChallengeMethod?: 'S256' | 'plain';
}`,
  },
  {
    id: 'change-3',
    filePath: '/src/middleware/rate-limiter.ts',
    toolType: 'Write',
    original: '',
    modified: `import { Redis } from 'ioredis'

/**
 * Sliding window rate limiter using Redis.
 * Limits authentication attempts to prevent brute force attacks.
 */
export class RateLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly windowMs: number = 60000,
    private readonly maxAttempts: number = 5,
  ) {}

  async isAllowed(key: string): Promise<boolean> {
    const now = Date.now()
    const windowStart = now - this.windowMs

    // Remove expired entries and count remaining
    await this.redis.zremrangebyscore(key, 0, windowStart)
    const count = await this.redis.zcard(key)

    if (count >= this.maxAttempts) {
      return false
    }

    // Add current attempt
    await this.redis.zadd(key, now, \`\${now}\`)
    await this.redis.expire(key, Math.ceil(this.windowMs / 1000))

    return true
  }
}
`,
  },
  {
    id: 'change-4',
    filePath: '/src/auth/index.ts',
    toolType: 'Edit',
    original: `import { OAuthClient } from './oauth'
import { TokenManager } from './tokens'`,
    modified: `import { OAuthClient } from './oauth'
import { TokenManager } from './tokens'
import { RateLimiter } from '../middleware/rate-limiter'
import { AuditLogger } from '../lib/audit'`,
  },
]

const sampleSingleChange: FileChange[] = [
  {
    id: 'single-1',
    filePath: '/src/components/Button.tsx',
    toolType: 'Edit',
    original: `export function Button({ children, onClick }: ButtonProps) {
  return (
    <button onClick={onClick} className="btn">
      {children}
    </button>
  )
}`,
    modified: `export function Button({ children, onClick, variant = 'primary', disabled }: ButtonProps) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn('btn', \`btn-\${variant}\`, disabled && 'btn-disabled')}
    >
      {children}
    </button>
  )
}`,
  },
]

/** Embedded preview of MultiDiffPreviewOverlay */
function MultiDiffPreviewOverlayPlayground({
  changes,
  consolidated,
  focusedChangeId,
}: {
  changes: FileChange[]
  consolidated?: boolean
  focusedChangeId?: string
}) {
  return (
    <div className="h-[500px]">
      <MultiDiffPreviewOverlay
        isOpen={true}
        onClose={() => {}}
        embedded
        changes={changes}
        consolidated={consolidated}
        focusedChangeId={focusedChangeId}
      />
    </div>
  )
}

// ============================================================================
// Terminal Preview Overlay - Playground Wrapper
// ============================================================================

const sampleBashOutput = `> npm test

 PASS  src/auth/__tests__/handler.test.ts (2.341s)
  AuthHandler
    ✓ should authenticate with valid credentials (45ms)
    ✓ should reject invalid credentials (12ms)
    ✓ should refresh expired tokens (23ms)
    ✓ should handle token revocation (8ms)
    ✓ should validate PKCE challenge (15ms)

 PASS  src/auth/__tests__/tokens.test.ts (1.892s)
  TokenManager
    ✓ should encrypt tokens at rest (34ms)
    ✓ should decrypt stored tokens (28ms)
    ✓ should schedule automatic refresh (5ms)
    ✓ should handle decryption failures gracefully (11ms)
    ✓ should revoke tokens and cleanup timers (7ms)

 PASS  src/middleware/__tests__/rate-limiter.test.ts (0.956s)
  RateLimiter
    ✓ should allow requests under limit (3ms)
    ✓ should block requests over limit (4ms)
    ✓ should reset after window expires (102ms)

Test Suites: 3 passed, 3 total
Tests:       13 passed, 13 total
Snapshots:   0 total
Time:        5.412s
Ran all test suites.`

const sampleGrepOutput = `src/auth/index.ts:15:export class AuthHandler {
src/auth/index.ts:42:  async authenticate(credentials: Credentials): Promise<Session> {
src/auth/index.ts:67:  async refreshToken(session: Session): Promise<Session> {
src/auth/oauth.ts:8:export class OAuthClient {
src/auth/oauth.ts:23:  async getToken(credentials: Credentials): Promise<AuthToken> {
src/auth/tokens.ts:12:export class TokenManager {
src/auth/tokens.ts:34:  async storeToken(sessionId: string, token: AuthToken): Promise<void> {
src/auth/tokens.ts:52:  async getToken(sessionId: string): Promise<AuthToken | null> {
src/middleware/rate-limiter.ts:9:export class RateLimiter {
src/middleware/rate-limiter.ts:18:  async isAllowed(key: string): Promise<boolean> {`

const sampleGlobOutput = `src/auth/index.ts
src/auth/oauth.ts
src/auth/tokens.ts
src/auth/sessions.ts
src/auth/types.ts
src/auth/__tests__/handler.test.ts
src/auth/__tests__/tokens.test.ts
src/auth/__tests__/sessions.test.ts
src/auth/mfa.ts
src/auth/totp.ts`

const sampleBashErrorOutput = `> npm run deploy

Error: Command failed with exit code 1
  at ChildProcess.exithandler (node:child_process:420:12)
  at ChildProcess.emit (node:events:519:28)

npm ERR! code ELIFECYCLE
npm ERR! errno 1
npm ERR! myapp@1.0.0 deploy: \`aws s3 sync ./dist s3://my-bucket\`
npm ERR! Exit status 1
npm ERR!
npm ERR! Failed at the myapp@1.0.0 deploy script.

An error occurred during deployment. Check your AWS credentials and permissions.`

/** Embedded preview of TerminalPreviewOverlay */
function TerminalPreviewOverlayPlayground({
  command,
  output,
  exitCode,
  toolType,
  description,
  error,
}: {
  command: string
  output: string
  exitCode?: number
  toolType?: 'bash' | 'grep' | 'glob'
  description?: string
  error?: string
}) {
  return (
    <div className="h-[500px]">
      <TerminalPreviewOverlay
        isOpen={true}
        onClose={() => {}}
        embedded
        command={command}
        output={output}
        exitCode={exitCode}
        toolType={toolType}
        description={description}
        error={error}
      />
    </div>
  )
}

// ============================================================================
// JSON Preview Overlay - Playground Wrapper
// ============================================================================

const sampleJsonData = {
  user: {
    id: 'usr_2x8kM9pQ',
    name: 'Jane Developer',
    email: 'jane@example.com',
    role: 'admin',
    permissions: ['read', 'write', 'delete', 'manage_users'],
    metadata: {
      created_at: '2024-01-15T10:30:00Z',
      last_login: '2025-01-24T14:22:00Z',
      login_count: 342,
      preferences: {
        theme: 'dark',
        language: 'en',
        notifications: {
          email: true,
          push: false,
          slack: true,
        },
      },
    },
  },
  organization: {
    id: 'org_4k2nR7wL',
    name: 'Acme Corp',
    plan: 'enterprise',
    members_count: 47,
    features: ['sso', 'audit_logs', 'custom_roles', 'api_access'],
    billing: {
      plan: 'enterprise',
      status: 'active',
      next_invoice: '2025-02-01',
      amount: 4999,
      currency: 'USD',
    },
  },
  api_keys: [
    { id: 'key_1', name: 'Production', prefix: 'sk_live_...', created: '2024-06-01' },
    { id: 'key_2', name: 'Staging', prefix: 'sk_test_...', created: '2024-08-15' },
    { id: 'key_3', name: 'Development', prefix: 'sk_dev_...', created: '2025-01-10' },
  ],
}

const sampleNestedJsonData = {
  status: 'success',
  data: {
    results: [
      { id: 1, title: 'First Result', score: 0.95, tags: ['important', 'reviewed'] },
      { id: 2, title: 'Second Result', score: 0.87, tags: ['pending'] },
      { id: 3, title: 'Third Result', score: 0.72, tags: ['archived'] },
    ],
    pagination: { page: 1, per_page: 10, total: 3, total_pages: 1 },
    meta: { request_id: 'req_abc123', duration_ms: 42, cache_hit: false },
  },
}

/** Embedded preview of JSONPreviewOverlay */
function JSONPreviewOverlayPlayground({
  data,
  title,
  error,
}: {
  data: unknown
  title?: string
  error?: string
}) {
  return (
    <div className="h-[500px]">
      <JSONPreviewOverlay
        isOpen={true}
        onClose={() => {}}
        embedded
        data={data}
        title={title}
        error={error}
      />
    </div>
  )
}

// ============================================================================
// Generic Overlay - Playground Wrapper
// ============================================================================

const sampleGenericContent = `# WebFetch Result

Fetched content from https://docs.example.com/api/authentication

## Authentication

All API requests require authentication using a Bearer token in the Authorization header:

\`\`\`
Authorization: Bearer YOUR_API_KEY
\`\`\`

### Rate Limits

| Plan       | Requests/min | Burst |
|-----------|-------------|-------|
| Free       | 60          | 10    |
| Pro        | 600         | 100   |
| Enterprise | 6000        | 1000  |

### Error Responses

When authentication fails, the API returns:

\`\`\`json
{
  "error": {
    "code": "unauthorized",
    "message": "Invalid or expired API key",
    "status": 401
  }
}
\`\`\`

For more details, see the [API Reference](https://docs.example.com/api).`

/** Sample generic content (Chinese) for fullscreen testing */
const zhSampleGenericContent = `# WebFetch 结果

已获取 https://docs.example.com/api/authentication 的内容

## 认证

所有 API 请求都需要在 Authorization 头中使用 Bearer 令牌进行认证：

\`\`\`
Authorization: Bearer YOUR_API_KEY
\`\`\`

### 速率限制

| 套餐       | 请求/分钟 | 突发 |
|-----------|----------|------|
| 免费       | 60       | 10   |
| 专业版     | 600      | 100  |
| 企业版     | 6000     | 1000 |

### 错误响应

当认证失败时，API 返回：

\`\`\`json
{
  "error": {
    "code": "unauthorized",
    "message": "Invalid or expired API key",
    "status": 401
  }
}
\`\`\`

更多详情，请参阅 [API 参考文档](https://docs.example.com/api)。`

/** Embedded preview of GenericOverlay */
function GenericOverlayPlayground({
  content,
  title,
}: {
  content: string
  title?: string
}) {
  return (
    <div className="h-[500px]">
      <GenericOverlay
        isOpen={true}
        onClose={() => {}}
        embedded
        content={content}
        title={title}
      />
    </div>
  )
}

// ============================================================================
// Data Table Overlay - Playground Wrapper
// ============================================================================

/** Sample table component rendered inside DataTableOverlay */
function SampleDataTable() {
  const { t } = useTranslation()
  const rows = [
    { tool: 'Read', permission: 'allowed', permissionLabel: t('playground.turnCard.dataTable.permissionAllowed'), description: t('playground.turnCard.dataTable.readFiles') },
    { tool: 'Write', permission: 'ask', permissionLabel: t('playground.turnCard.dataTable.permissionAsk'), description: t('playground.turnCard.dataTable.writeFiles') },
    { tool: 'Edit', permission: 'ask', permissionLabel: t('playground.turnCard.dataTable.permissionAsk'), description: t('playground.turnCard.dataTable.editFiles') },
    { tool: 'Bash', permission: 'ask', permissionLabel: t('playground.turnCard.dataTable.permissionAsk'), description: t('playground.turnCard.dataTable.executeShell') },
    { tool: 'Grep', permission: 'allowed', permissionLabel: t('playground.turnCard.dataTable.permissionAllowed'), description: t('playground.turnCard.dataTable.searchContents') },
    { tool: 'Glob', permission: 'allowed', permissionLabel: t('playground.turnCard.dataTable.permissionAllowed'), description: t('playground.turnCard.dataTable.findByPattern') },
    { tool: 'WebFetch', permission: 'allowed', permissionLabel: t('playground.turnCard.dataTable.permissionAllowed'), description: t('playground.turnCard.dataTable.fetchUrl') },
    { tool: 'WebSearch', permission: 'blocked', permissionLabel: t('playground.turnCard.dataTable.permissionBlocked'), description: t('playground.turnCard.dataTable.searchWeb') },
  ]

  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-border">
          <th className="text-left py-2 px-4 font-medium text-muted-foreground">{t('playground.turnCard.dataTable.columnTool')}</th>
          <th className="text-left py-2 px-4 font-medium text-muted-foreground">{t('playground.turnCard.dataTable.columnPermission')}</th>
          <th className="text-left py-2 px-4 font-medium text-muted-foreground">{t('playground.turnCard.dataTable.columnDescription')}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.tool} className="border-b border-border/50">
            <td className="py-2 px-4 font-mono text-xs">{row.tool}</td>
            <td className="py-2 px-4">
              <span className={`text-xs px-2 py-0.5 rounded-full ${
                row.permission === 'allowed' ? 'bg-green-500/10 text-green-600' :
                row.permission === 'ask' ? 'bg-amber-500/10 text-amber-600' :
                'bg-red-500/10 text-red-600'
              }`}>
                {row.permissionLabel}
              </span>
            </td>
            <td className="py-2 px-4 text-muted-foreground">{row.description}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** Wrapper with button to open DataTableOverlay */
function DataTableOverlayPlayground({
  title,
  subtitle,
}: {
  title: string
  subtitle?: string
}) {
  const { t } = useTranslation()
  const [isOpen, setIsOpen] = useState(true)

  return (
    <div className="p-8">
      <button
        onClick={() => setIsOpen(true)}
        className="px-4 py-2 bg-accent text-accent-foreground rounded-lg text-sm font-medium hover:bg-accent/90"
      >
        {t('playground.turnCard.dataTable.open')}
      </button>
      <DataTableOverlay
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        title={title}
        subtitle={subtitle}
      >
        <SampleDataTable />
      </DataTableOverlay>
    </div>
  )
}

// ============================================================================
// Fullscreen Overlay Component Registry
// ============================================================================

/** Export all fullscreen overlay components */
export const fullscreenOverlayComponents: ComponentEntry[] = [
  {
    id: 'document-overlay',
    name: 'DocumentFormattedMarkdownOverlay',
    category: 'Fullscreen',
    description: 'Fullscreen document view for reading AI responses and plans',
    descriptionZh: '用于阅读 AI 响应与计划的全屏文档视图',
    component: DocumentFormattedMarkdownOverlayPlayground,
    layout: 'top',
    props: [
      {
        name: 'variant',
        description: 'Style variant: response (default) or plan (shows header)',
        descriptionZh: '样式变体：response（默认）或 plan（显示头部）',
        control: {
          type: 'select',
          options: [
            { label: 'Response', value: 'response' },
            { label: 'Plan', value: 'plan' },
          ],
        },
        defaultValue: 'response',
      },
    ],
    variants: [
      {
        name: 'Response (Default)',
        nameZh: '响应（默认）',
        description: 'Standard response view with commenting support',
        descriptionZh: '支持评论的标准响应视图',
        props: {
          content: sampleMarkdownContent,
          variant: 'response',
        },
      },
      {
        name: 'Plan Variant',
        nameZh: '计划变体',
        description: 'Plan view with green header badge',
        descriptionZh: '带绿色头部徽标的计划视图',
        props: {
          content: samplePlanContent,
          variant: 'plan',
        },
      },
      {
        name: 'Short Content',
        nameZh: '简短内容',
        description: 'Minimal content to test layout',
        descriptionZh: '用于测试布局的最简内容',
        props: {
          content: '# Quick Response\n\nThis is a short response to test the layout with minimal content.\n\nLooks good!',
          variant: 'response',
        },
      },
      {
        name: 'Code Heavy',
        nameZh: '大量代码',
        description: 'Content with lots of code blocks',
        descriptionZh: '包含大量代码块的内容',
        props: {
          content: `# Code Examples

Here are some code examples:

\`\`\`typescript
// TypeScript example
interface User {
  id: string;
  name: string;
  email: string;
}

async function getUser(id: string): Promise<User> {
  const response = await fetch(\`/api/users/\${id}\`);
  return response.json();
}
\`\`\`

\`\`\`python
# Python example
def fibonacci(n: int) -> int:
    if n <= 1:
        return n
    return fibonacci(n - 1) + fibonacci(n - 2)
\`\`\`

\`\`\`rust
// Rust example
fn main() {
    let numbers: Vec<i32> = (1..=10).collect();
    let sum: i32 = numbers.iter().sum();
    println!("Sum: {}", sum);
}
\`\`\`

These examples demonstrate different syntax highlighting.`,
          variant: 'response',
        },
      },
    ],
    mockData: (locale) => ({
      content: pickLocale(locale, sampleMarkdownContent, zhSampleMarkdownContent),
    }),
  },

  // Code Preview Overlay
  {
    id: 'code-preview-overlay',
    name: 'CodePreviewOverlay',
    category: 'Fullscreen',
    description: 'Syntax-highlighted code file preview (Read/Write tools)',
    descriptionZh: '带语法高亮的代码文件预览（Read/Write 工具）',
    component: CodePreviewOverlayPlayground,
    layout: 'top',
    props: [
      {
        name: 'mode',
        description: 'Display mode: read or write',
        descriptionZh: '显示模式：read 或 write',
        control: {
          type: 'select',
          options: [
            { label: 'Read', value: 'read' },
            { label: 'Write', value: 'write' },
          ],
        },
        defaultValue: 'read',
      },
    ],
    variants: [
      {
        name: 'TypeScript File (Read)',
        nameZh: 'TypeScript 文件（读取）',
        description: 'Reading a TypeScript source file',
        descriptionZh: '正在读取 TypeScript 源文件',
        props: {
          content: sampleTypeScriptCode,
          filePath: '/src/auth/tokens.ts',
          mode: 'read',
          startLine: 1,
          totalLines: 98,
          numLines: 98,
        },
      },
      {
        name: 'Python File (Read)',
        nameZh: 'Python 文件（读取）',
        description: 'Reading a Python ML pipeline',
        descriptionZh: '正在读取 Python 机器学习流水线',
        props: {
          content: samplePythonCode,
          filePath: '/src/ml/pipeline.py',
          mode: 'read',
          startLine: 1,
          totalLines: 85,
          numLines: 85,
        },
      },
      {
        name: 'Partial Read (Lines 15-45)',
        nameZh: '部分读取（第 15-45 行）',
        description: 'Reading a subset of lines from a large file',
        descriptionZh: '正在读取大文件中的部分行',
        props: {
          content: sampleTypeScriptCode.split('\n').slice(14, 45).join('\n'),
          filePath: '/src/auth/tokens.ts',
          mode: 'read',
          startLine: 15,
          totalLines: 98,
          numLines: 31,
        },
      },
      {
        name: 'Write Mode',
        nameZh: '写入模式',
        description: 'Showing a file being written',
        descriptionZh: '展示正在写入的文件',
        props: {
          content: sampleTypeScriptCode,
          filePath: '/src/auth/tokens.ts',
          mode: 'write',
        },
      },
      {
        name: 'Read Failed',
        nameZh: '读取失败',
        description: 'Error state when file read fails',
        descriptionZh: '文件读取失败时的错误状态',
        props: {
          content: '',
          filePath: './apps/electron/src/main/sessions.ts',
          mode: 'read',
          error: "Bash command `python3 -c import re; f=open('./src/runtime/agent-server.ts','r'); content=f.read(); f.close(); [print(m.group(),'---') for m in list(re.finditer(r'.{0,150}AbortError.{0,150}', content))[:5]]` is not in the read-only allowlist.\n\nMatched: `python3 -` (9 chars)\nFailed at: `c` (position 9)\n\nPattern: Python 3 version",
        },
      },
    ],
    mockData: () => ({
      content: sampleTypeScriptCode,
      filePath: '/src/auth/tokens.ts',
    }),
  },

  // Multi-Diff Preview Overlay
  {
    id: 'multi-diff-overlay',
    name: 'MultiDiffPreviewOverlay',
    category: 'Fullscreen',
    description: 'Multi-file diff preview with sidebar navigation (Edit/Write tools)',
    descriptionZh: '带侧边栏导航的多文件差异预览（Edit/Write 工具）',
    component: MultiDiffPreviewOverlayPlayground,
    layout: 'top',
    props: [
      {
        name: 'consolidated',
        description: 'Group changes by file path',
        descriptionZh: '按文件路径对更改分组',
        control: { type: 'boolean' },
        defaultValue: false,
      },
    ],
    variants: [
      {
        name: 'Multiple Files (Ungrouped)',
        nameZh: '多文件（未分组）',
        description: 'Several file changes shown individually',
        descriptionZh: '多个文件更改单独显示',
        props: {
          changes: sampleMultiDiffChanges,
          consolidated: false,
        },
      },
      {
        name: 'Multiple Files (Consolidated)',
        nameZh: '多文件（合并分组）',
        description: 'Changes grouped by file path',
        descriptionZh: '按文件路径分组的更改',
        props: {
          changes: sampleMultiDiffChanges,
          consolidated: true,
        },
      },
      {
        name: 'Single Edit',
        nameZh: '单个编辑',
        description: 'Single file change (no sidebar)',
        descriptionZh: '单个文件更改（无侧边栏）',
        props: {
          changes: sampleSingleChange,
          consolidated: false,
        },
      },
      {
        name: 'Focused Change',
        nameZh: '聚焦更改',
        description: 'Opens with a specific change focused',
        descriptionZh: '打开时聚焦到特定更改',
        props: {
          changes: sampleMultiDiffChanges,
          consolidated: false,
          focusedChangeId: 'change-3',
        },
      },
      {
        name: 'New File (Write)',
        nameZh: '新文件（写入）',
        description: 'A newly written file (no original)',
        descriptionZh: '新写入的文件（无原始版本）',
        props: {
          changes: [sampleMultiDiffChanges[2]], // The rate-limiter Write
          consolidated: false,
        },
      },
    ],
    mockData: () => ({
      changes: sampleMultiDiffChanges,
    }),
  },

  // Terminal Preview Overlay
  {
    id: 'terminal-preview-overlay',
    name: 'TerminalPreviewOverlay',
    category: 'Fullscreen',
    description: 'Terminal output preview (Bash/Grep/Glob tools)',
    descriptionZh: '终端输出预览（Bash/Grep/Glob 工具）',
    component: TerminalPreviewOverlayPlayground,
    layout: 'top',
    props: [
      {
        name: 'toolType',
        description: 'Tool type for display styling',
        descriptionZh: '用于显示样式的工具类型',
        control: {
          type: 'select',
          options: [
            { label: 'Bash', value: 'bash' },
            { label: 'Grep', value: 'grep' },
            { label: 'Glob', value: 'glob' },
          ],
        },
        defaultValue: 'bash',
      },
    ],
    variants: [
      {
        name: 'Bash: Test Suite',
        nameZh: 'Bash：测试套件',
        description: 'npm test output with passing tests',
        descriptionZh: 'npm test 输出，测试全部通过',
        props: {
          command: 'npm test',
          output: sampleBashOutput,
          exitCode: 0,
          toolType: 'bash',
          description: 'Running the test suite',
        },
      },
      {
        name: 'Bash: Error',
        nameZh: 'Bash：错误',
        description: 'Failed deployment command',
        descriptionZh: '失败的部署命令',
        props: {
          command: 'npm run deploy',
          output: sampleBashErrorOutput,
          exitCode: 1,
          toolType: 'bash',
          description: 'Deploy to production',
        },
      },
      {
        name: 'Grep: Search Results',
        nameZh: 'Grep：搜索结果',
        description: 'Searching for class/function definitions',
        descriptionZh: '搜索类/函数定义',
        props: {
          command: 'grep "export class" src/auth/',
          output: sampleGrepOutput,
          exitCode: 0,
          toolType: 'grep',
          description: 'Search for "export class" in src/auth/',
        },
      },
      {
        name: 'Glob: File Listing',
        nameZh: 'Glob：文件列表',
        description: 'Finding files matching a pattern',
        descriptionZh: '查找匹配模式的文件',
        props: {
          command: 'glob "src/auth/**/*.ts"',
          output: sampleGlobOutput,
          exitCode: 0,
          toolType: 'glob',
          description: 'Find files matching "src/auth/**/*.ts"',
        },
      },
      {
        name: 'Command Failed (Error Banner)',
        nameZh: '命令失败（错误横幅）',
        description: 'Command blocked by permission system',
        descriptionZh: '命令被权限系统拦截',
        props: {
          command: 'rm -rf /tmp/build-cache',
          output: '',
          exitCode: 1,
          toolType: 'bash',
          description: 'Clean build cache',
          error: "Bash command `rm -rf /tmp/build-cache` is not in the read-only allowlist.\n\nMatched: `rm` (2 chars)\nFailed at: ` ` (position 2)\n\nPattern: Remove files\n\nSwitch to Ask or Allow All mode (SHIFT+TAB) to run it.",
        },
      },
    ],
    mockData: () => ({
      command: 'npm test',
      output: sampleBashOutput,
      exitCode: 0,
      toolType: 'bash',
      description: 'Running tests',
    }),
  },

  // JSON Preview Overlay
  {
    id: 'json-preview-overlay',
    name: 'JSONPreviewOverlay',
    category: 'Fullscreen',
    description: 'Interactive JSON tree viewer with expand/collapse',
    descriptionZh: '支持展开/折叠的交互式 JSON 树查看器',
    component: JSONPreviewOverlayPlayground,
    layout: 'top',
    props: [
      {
        name: 'title',
        description: 'Title shown in header',
        descriptionZh: '显示在头部区域的标题',
        control: { type: 'string', placeholder: 'e.g., API Response' },
        defaultValue: 'JSON Result',
      },
    ],
    variants: [
      {
        name: 'Complex Object',
        nameZh: '复杂对象',
        description: 'Deeply nested user/org data',
        descriptionZh: '深层嵌套的用户/组织数据',
        props: {
          data: sampleJsonData,
          title: 'User Profile',
        },
      },
      {
        name: 'API Response',
        nameZh: 'API 响应',
        description: 'Typical paginated API response',
        descriptionZh: '典型的分页 API 响应',
        props: {
          data: sampleNestedJsonData,
          title: 'Search Results',
        },
      },
      {
        name: 'Simple Array',
        nameZh: '简单数组',
        description: 'Array of simple objects',
        descriptionZh: '简单对象数组',
        props: {
          data: [
            { id: 1, name: 'Alpha', status: 'active' },
            { id: 2, name: 'Beta', status: 'pending' },
            { id: 3, name: 'Gamma', status: 'inactive' },
          ],
          title: 'Items List',
        },
      },
      {
        name: 'Minimal',
        nameZh: '最小化',
        description: 'Small JSON payload',
        descriptionZh: '小型 JSON 数据',
        props: {
          data: { success: true, message: 'Operation completed', count: 42 },
          title: 'Status',
        },
      },
      {
        name: 'Parse Error',
        nameZh: '解析错误',
        description: 'Error state when JSON parsing fails',
        descriptionZh: 'JSON 解析失败时的错误状态',
        props: {
          data: {},
          title: 'API Response',
          error: "Unexpected token '<' at position 0. The server returned HTML instead of JSON.\n\nResponse starts with: <!DOCTYPE html><html><head><title>502 Bad Gateway</title>...",
        },
      },
    ],
    mockData: (locale) => ({
      data: sampleJsonData,
      title: locale === 'zh-CN' ? 'JSON 结果' : 'JSON Result',
    }),
  },

  // Generic Overlay
  {
    id: 'generic-overlay',
    name: 'GenericOverlay',
    category: 'Fullscreen',
    description: 'Fallback overlay for unknown tool content with auto-language detection',
    descriptionZh: '带自动语言检测的未知工具内容回退浮层',
    component: GenericOverlayPlayground,
    layout: 'top',
    props: [
      {
        name: 'title',
        description: 'Header title',
        descriptionZh: '头部标题',
        control: { type: 'string', placeholder: 'e.g., WebFetch Result' },
        defaultValue: 'Activity',
      },
    ],
    variants: [
      {
        name: 'Markdown Content',
        nameZh: 'Markdown 内容',
        description: 'Web-fetched documentation',
        descriptionZh: '从网络获取的文档',
        props: {
          content: sampleGenericContent,
          title: 'WebFetch Result',
        },
      },
      {
        name: 'Plain Text',
        nameZh: '纯文本',
        description: 'Simple text output',
        descriptionZh: '简单的文本输出',
        props: {
          content: 'Build completed successfully.\n\nOutput:\n  dist/index.js (245 KB)\n  dist/index.css (12 KB)\n  dist/assets/ (3 files)\n\nTotal size: 257 KB (gzipped: 62 KB)',
          title: 'Build Output',
        },
      },
      {
        name: 'JSON-like Content',
        nameZh: '类 JSON 内容',
        description: 'Content that looks like JSON',
        descriptionZh: '看起来像 JSON 的内容',
        props: {
          content: JSON.stringify({ status: 'ok', version: '2.1.0', uptime: '14d 3h 22m' }, null, 2),
          title: 'Health Check',
        },
      },
    ],
    mockData: (locale) => ({
      content: pickLocale(locale, sampleGenericContent, zhSampleGenericContent),
      title: locale === 'zh-CN' ? '活动' : 'Activity',
    }),
  },

  // Data Table Overlay
  {
    id: 'data-table-overlay',
    name: 'DataTableOverlay',
    category: 'Fullscreen',
    description: 'Fullscreen data table view with scrollable content',
    descriptionZh: '带可滚动内容的全屏数据表格视图',
    component: DataTableOverlayPlayground,
    layout: 'top',
    props: [
      {
        name: 'title',
        description: 'Table title in header',
        descriptionZh: '头部区域的表格标题',
        control: { type: 'string', placeholder: 'e.g., Permissions' },
        defaultValue: 'Permissions',
      },
      {
        name: 'subtitle',
        description: 'Optional subtitle (e.g., row count)',
        descriptionZh: '可选的副标题（例如行数）',
        control: { type: 'string', placeholder: 'e.g., 8 tools' },
        defaultValue: '8 tools',
      },
    ],
    variants: [
      {
        name: 'Tool Permissions',
        nameZh: '工具权限',
        description: 'Table showing tool permission levels',
        descriptionZh: '展示工具权限级别的表格',
        props: {
          title: 'Tool Permissions',
          subtitle: '8 tools configured',
        },
      },
      {
        name: 'No Subtitle',
        nameZh: '无副标题',
        description: 'Table without subtitle',
        descriptionZh: '没有副标题的表格',
        props: {
          title: 'Configuration',
        },
      },
    ],
    mockData: (locale) => ({
      title: locale === 'zh-CN' ? '权限' : 'Permissions',
      subtitle: locale === 'zh-CN' ? '8 个工具' : '8 tools',
    }),
  },
]
