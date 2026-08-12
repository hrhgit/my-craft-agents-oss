import * as React from 'react'
import type { ComponentEntry } from './types'
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
import { cn } from '@/lib/utils'

// ============================================================================
// Message Components - Demo components for playground preview
// Uses shared components from @mortise/ui where available
// ============================================================================

/** Assistant message bubble - left aligned white card (playground demo version) */
function AssistantMessage({ content }: { content: string }) {
  return (
    <div className="flex justify-start group">
      <div className="relative max-w-[80%] bg-white shadow-minimal rounded-[8px] pl-6 pr-4 py-3 break-words min-w-0">
        <button
          className="absolute top-2 right-2 p-1.5 rounded-md opacity-0 group-hover:opacity-100 transition-opacity hover:bg-foreground/5"
          title="Open in new window"
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
function CompactionDivider({ label = 'Conversation Compacted' }: { label?: string }) {
  return (
    <div className="flex items-center gap-3 my-12 px-3">
      <div className="flex-1 h-px bg-border" />
      <span className="text-sm text-muted-foreground/70 select-none">
        {label}
      </span>
      <div className="flex-1 h-px bg-border" />
    </div>
  )
}

/** Processing indicator driven by the Playground scene timeline. */
const PROCESSING_MESSAGES = [
  'Thinking…',
  'Pondering…',
  'Contemplating…',
  'Reasoning…',
  'Processing…',
  'Computing…',
  'Considering…',
  'Reflecting…',
  'Deliberating…',
  'Cogitating…',
  'Ruminating…',
  'Musing…',
  'Working on it…',
  'On it…',
  'Crunching…',
  'Brewing…',
  'Connecting dots…',
  'Mulling it over…',
  'Deep in thought…',
  'Hmm…',
  'Let me see…',
  'One moment…',
  'Hold on…',
  'Bear with me…',
  'Just a sec…',
  'Hang tight…',
  'Getting there…',
  'Almost…',
  'Working…',
  'Busy busy…',
  'Whirring…',
  'Churning…',
  'Percolating…',
  'Simmering…',
  'Cooking…',
  'Baking…',
  'Stirring…',
  'Spinning up…',
  'Warming up…',
  'Revving…',
  'Buzzing…',
  'Humming…',
  'Ticking…',
  'Clicking…',
  'Whizzing…',
  'Zooming…',
  'Zipping…',
  'Chugging…',
  'Trucking…',
  'Rolling…',
]

interface ProcessingIndicatorProps {
  phaseIndex?: number
  elapsed?: number
}

function ProcessingIndicator({ phaseIndex = 0, elapsed = 0 }: ProcessingIndicatorProps) {
  const currentMessage = PROCESSING_MESSAGES[phaseIndex % PROCESSING_MESSAGES.length]

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
  const now = 1_735_603_200_000

  // Sample tool activities for TurnCard
  const completedGrepActivity: ActivityItem = {
    id: 'tool-1',
    type: 'tool',
    status: 'completed',
    toolName: 'Grep',
    toolInput: { pattern: 'AuthHandler', path: 'src/' },
    intent: 'Searching for authentication handlers',
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
    intent: 'Finding error handling patterns',
    timestamp: now - 1000,
  }

  const shortResponse: ResponseContent = {
    text: "I found the authentication handlers in `src/auth/`. The main handler is `AuthHandler` which manages OAuth flows and token validation.",
    isStreaming: false,
  }

  const streamingResponse: ResponseContent = {
    text: "I'm analyzing the codebase and looking for patterns that match your query. Let me check a few more files...",
    isStreaming: true,
    streamStartTime: now - 500,
  }

  return (
    <div className="max-w-[960px] mx-auto p-8 space-y-8">
      {/* Section: Status & Dividers (playground demo components) */}
      <section>
        <h2 className="text-lg font-semibold mb-4 text-foreground/80">Status & Dividers</h2>
        <div className="bg-muted/20 rounded-lg">
          <StatusMessage content="Compacting conversation..." />
          <CompactionDivider />
          <StatusMessage content="Connecting to server..." />
        </div>
      </section>

      {/* Section: Processing States */}
      <section>
        <h2 className="text-lg font-semibold mb-4 text-foreground/80">Processing States</h2>
        <div className="bg-muted/20 rounded-lg ">
          <ProcessingIndicator />
        </div>
      </section>

      {/* Section: User Messages */}
      <section>
        <h2 className="text-lg font-semibold mb-4 text-foreground/80">User Messages</h2>
        <div className="space-y-3">
          <UserMessageBubble content="How do I authenticate with the API?" />
          <UserMessageBubble content="Can you search for all files that contain 'handleError' and show me how they work?" />
        </div>
      </section>

      {/* Section: Assistant Messages */}
      <section>
        <h2 className="text-lg font-semibold mb-4 text-foreground/80">Assistant Messages</h2>
        <div className="space-y-3">
          <AssistantMessage content="I found the authentication handlers in `src/auth/`. The main handler is `AuthHandler` which manages OAuth flows and token validation." />
          <AssistantMessage content={`Here's a more detailed response with **markdown** formatting:

1. First, check the \`config.ts\` file
2. Then update the environment variables
3. Finally, restart the server

\`\`\`typescript
const config = {
  apiKey: process.env.API_KEY,
  secret: process.env.SECRET
};
\`\`\`
`} />
        </div>
      </section>

      {/* Section: SystemMessage (from @mortise/ui) */}
      <section>
        <h2 className="text-lg font-semibold mb-4 text-foreground/80">SystemMessage (Shared)</h2>
        <div className="bg-muted/20 rounded-lg">
          <SystemMessage content="This is a system message." type="system" />
          <SystemMessage content="This is an info message." type="info" />
          <SystemMessage content="This is a warning message." type="warning" />
          <SystemMessage content="This is an error message." type="error" />
        </div>
      </section>

      {/* Section: TurnCard - Complete Turn */}
      <section>
        <h2 className="text-lg font-semibold mb-4 text-foreground/80">TurnCard - Complete Turn</h2>
        <TurnCard
          sessionId="playground-session"
          turnId="turn-1"
          activities={[completedGrepActivity, completedReadActivity]}
          response={shortResponse}
          intent="Analyzing authentication system"
          isStreaming={false}
          isComplete={true}
          onOpenFile={(path) => console.log('Open file:', path)}
          onOpenUrl={(url) => console.log('Open URL:', url)}
        />
      </section>

      {/* Section: TurnCard - Streaming */}
      <section>
        <h2 className="text-lg font-semibold mb-4 text-foreground/80">TurnCard - Streaming Response</h2>
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
        <h2 className="text-lg font-semibold mb-4 text-foreground/80">TurnCard - Tool Running</h2>
        <TurnCard
          sessionId="playground-session"
          turnId="turn-3"
          activities={[runningGrepActivity]}
          response={undefined}
          intent="Finding error handling patterns"
          isStreaming={true}
          isComplete={false}
          onOpenFile={(path) => console.log('Open file:', path)}
          onOpenUrl={(url) => console.log('Open URL:', url)}
        />
      </section>

      {/* Section: TurnCard - Response Only */}
      <section>
        <h2 className="text-lg font-semibold mb-4 text-foreground/80">TurnCard - Response Only (No Tools)</h2>
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
    category: 'Chat Messages',
    description: 'All message types displayed together for easy design comparison',
    component: MessageGallery,
    layout: 'top',
    props: [],
    variants: [],
    mockData: () => ({}),
  },
  {
    id: 'user-message-bubble',
    name: 'UserMessageBubble',
    category: 'Chat Messages',
    description: 'Right-aligned user message bubble (from @mortise/ui)',
    component: UserMessageBubble,
    props: [
      {
        name: 'content',
        description: 'Message text content',
        control: { type: 'textarea', placeholder: 'Enter message...', rows: 2 },
        defaultValue: 'How do I authenticate with the API?',
      },
    ],
    variants: [
      { name: 'Short', props: { content: 'Hello!' } },
      { name: 'Medium', props: { content: 'How do I authenticate with the API?' } },
      { name: 'Long', props: { content: 'Can you search for all files that contain "handleError" and show me how they work? I need to understand the error handling patterns in this codebase.' } },
    ],
    mockData: () => ({}),
  },
  {
    id: 'assistant-message',
    name: 'AssistantMessage',
    category: 'Chat Messages',
    description: 'Left-aligned assistant response with markdown support',
    component: AssistantMessage,
    props: [
      {
        name: 'content',
        description: 'Message text content (supports markdown)',
        control: { type: 'textarea', placeholder: 'Enter message...', rows: 4 },
        defaultValue: 'I found the authentication handlers in `src/auth/`. The main handler is `AuthHandler` which manages OAuth flows.',
      },
    ],
    variants: [
      { name: 'Short', props: { content: 'The file is located at `src/config.ts`.' } },
      { name: 'With Code', props: { content: 'Here\'s the code:\n\n```typescript\nconst x = 1;\n```' } },
      { name: 'With List', props: { content: '**Steps:**\n1. First step\n2. Second step\n3. Third step' } },
    ],
    mockData: () => ({}),
  },
  {
    id: 'status-message',
    name: 'StatusMessage',
    category: 'Chat Messages',
    description: 'System status with spinner (compaction, connecting, etc)',
    component: StatusMessage,
    props: [
      {
        name: 'content',
        description: 'Status message text',
        control: { type: 'string', placeholder: 'Status message...' },
        defaultValue: 'Compacting conversation...',
      },
    ],
    variants: [
      { name: 'Compacting', props: { content: 'Compacting conversation...' } },
      { name: 'Compacted', props: { content: 'Compacted conversation (was 180000 tokens)' } },
      { name: 'Connecting', props: { content: 'Connecting to server...' } },
    ],
    mockData: () => ({}),
  },
  {
    id: 'system-message',
    name: 'SystemMessage',
    category: 'Chat Messages',
    description: 'System/info/warning/error message (from @mortise/ui)',
    component: SystemMessage,
    props: [
      {
        name: 'content',
        description: 'Message text content',
        control: { type: 'textarea', placeholder: 'Message content...', rows: 2 },
        defaultValue: 'This is a system message.',
      },
      {
        name: 'type',
        description: 'Message type determining visual style',
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
      { name: 'System', props: { content: 'Session restored from 5 minutes ago.', type: 'system' } },
      { name: 'Info', props: { content: 'Agent activated successfully.', type: 'info' } },
      { name: 'Warning', props: { content: 'Rate limit approaching.', type: 'warning' } },
      { name: 'Error', props: { content: 'Connection lost.', type: 'error' } },
    ],
    mockData: () => ({}),
  },
  {
    id: 'compaction-divider',
    name: 'CompactionDivider',
    category: 'Chat Messages',
    description: 'Horizontal rule with centered label shown after context compaction',
    component: CompactionDivider,
    props: [
      {
        name: 'label',
        description: 'Label text shown in the center',
        control: { type: 'string', placeholder: 'Label...' },
        defaultValue: 'Conversation Compacted',
      },
    ],
    variants: [
      { name: 'Default', props: { label: 'Conversation Compacted' } },
      { name: 'Custom Label', props: { label: 'Context Reset' } },
    ],
    mockData: () => ({}),
  },
  {
    id: 'processing-indicator',
    name: 'ProcessingIndicator',
    category: 'Chat Messages',
    description: 'Deterministic processing indicator driven by the shared Playground timeline',
    component: ProcessingIndicator,
    props: [
      {
        name: 'phaseIndex',
        description: 'Deterministic scene phase',
        control: { type: 'number', min: 0, max: PROCESSING_MESSAGES.length - 1, step: 1 },
        defaultValue: 0,
      },
      {
        name: 'elapsed',
        description: 'Initial elapsed time in seconds (only used when counting is false)',
        control: { type: 'number', min: 0, max: 120, step: 1 },
        defaultValue: 0,
      },
    ],
    variants: [
      { name: 'Thinking', props: { phaseIndex: 0, elapsed: 0 } },
      { name: 'Reasoning', props: { phaseIndex: 3, elapsed: 5 } },
      { name: 'Working', props: { phaseIndex: 28, elapsed: 30 } },
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
      frameDurationMs: 1_200,
      phases: [
        { id: 'thinking', label: 'Thinking started', props: { phaseIndex: 0, elapsed: 0 } },
        { id: 'reasoning', label: 'Reasoning stream', props: { phaseIndex: 3, elapsed: 5 } },
        { id: 'tools', label: 'Tool activity', props: { phaseIndex: 12, elapsed: 12 } },
        { id: 'response', label: 'Response preparation', props: { phaseIndex: 28, elapsed: 30 } },
      ],
    },
  },
]
