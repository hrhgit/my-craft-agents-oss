/**
 * Documentation links and summaries for contextual help throughout the UI.
 * Summaries provide quick context; "Learn more" opens the full docs.
 */

import { MORTISE_REPOSITORY_URL } from '../branding'

const DOC_BASE_URL = `${MORTISE_REPOSITORY_URL}/blob/main`

export type DocFeature =
  | 'sources'
  | 'sources-api'
  | 'sources-mcp'
  | 'sources-local'
  | 'skills'
  | 'permissions'
  | 'workspaces'
  | 'themes'
  | 'app-settings'
  | 'preferences'
  | 'automations'
  | 'messaging'

export interface DocInfo {
  /** Path relative to DOC_BASE_URL */
  path: string
  /** Display title for the help popover */
  title: string
  /** 1-2 sentence summary for quick context */
  summary: string
}

export const DOCS: Record<DocFeature, DocInfo> = {
  sources: {
    path: '/apps/electron/resources/docs/sources.md',
    title: 'Sources',
    summary:
      'Connect external data like MCP servers, REST APIs, and local filesystems. Sources give your agent tools to access services like GitHub, Linear, or your Obsidian vault.',
  },
  'sources-api': {
    path: '/apps/electron/resources/docs/sources.md',
    title: 'APIs',
    summary:
      'Connect to any REST API with flexible authentication. Make HTTP requests to external services directly from your conversations.',
  },
  'sources-mcp': {
    path: '/apps/electron/resources/docs/sources.md',
    title: 'MCP Servers',
    summary:
      'Connect to Model Context Protocol servers for rich tool integrations. MCP servers provide structured access to services like GitHub, Linear, and Notion.',
  },
  'sources-local': {
    path: '/apps/electron/resources/docs/sources.md',
    title: 'Local Folders',
    summary:
      'Give your agent access to local directories like Obsidian vaults, code repositories, or data folders on your machine.',
  },
  skills: {
    path: '/apps/electron/resources/docs/skills.md',
    title: 'Skills',
    summary:
      'Reusable instruction sets that teach your agent specialized behaviors. Create a SKILL.md file and invoke it with @mention in your messages.',
  },
  permissions: {
    path: '/apps/electron/resources/docs/permissions.md',
    title: 'Permissions',
    summary:
      'Control how much autonomy your agent has. Explore mode is read-only, Ask to Edit prompts before changes, and Execute mode runs without prompts.',
  },
  workspaces: {
    path: '/README.md',
    title: 'Workspaces',
    summary:
      'Separate configurations for different contexts like personal projects or work. Each workspace has its own sources, skills, and session history.',
  },
  themes: {
    path: '/apps/electron/resources/docs/themes.md',
    title: 'Themes',
    summary:
      'Customize the visual appearance with a 6-color system. Override specific colors in theme.json or install preset themes for complete visual styles.',
  },
  'app-settings': {
    path: '/README.md',
    title: 'App Settings',
    summary:
      'Configure global app settings like your default model, authentication method, and workspace list. Settings are stored in ~/.mortise/config.json.',
  },
  preferences: {
    path: '/README.md',
    title: 'Preferences',
    summary:
      'Personal preferences like your name, timezone, and language that help the agent personalize responses. Stored in ~/.mortise/preferences.json.',
  },
  automations: {
    path: '/apps/electron/resources/docs/automations.md',
    title: 'Automations',
    summary:
      'Automate actions when events occur — run commands on schedules, react to runtime events, or trigger prompts. Configured in automations.json.',
  },
  messaging: {
    path: '/README.md',
    title: 'Messaging',
    summary:
      'Connect a session to a chat platform — Telegram, WhatsApp, or Lark / Feishu — and reach your agent from anywhere. Pair workspace supergroups, route automations to forum topics, and send rich replies natively.',
  },
}

/**
 * Get the full documentation URL for a feature
 */
export function getDocUrl(feature: DocFeature): string {
  return `${DOC_BASE_URL}${DOCS[feature].path}`
}

/**
 * Get the doc info (title, summary, path) for a feature
 */
export function getDocInfo(feature: DocFeature): DocInfo {
  return DOCS[feature]
}
