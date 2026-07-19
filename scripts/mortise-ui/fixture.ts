import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export const MORTISE_UI_FIXTURE_VERSION = 1 as const

const LIMITS = {
  workspaces: 32,
  sessionsPerWorkspace: 200,
  messagesPerSession: 1_000,
  messages: 10_000,
  files: 2_000,
  fileBytes: 1_048_576,
  totalFileBytes: 16_777_216,
  messageBytes: 262_144,
  totalMessageBytes: 16_777_216,
} as const

const IDENTIFIER_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
const IDENTIFIER_RE = new RegExp(IDENTIFIER_PATTERN)
const SESSION_FILE_ROOTS = new Set(['attachments', 'data', 'downloads', 'long_responses', 'plans'])
const MESSAGE_ROLES = new Set(['user', 'assistant', 'tool', 'error', 'info', 'plan'])
const PERMISSION_MODES = new Set(['safe', 'ask', 'allow-all'])

export interface MortiseUiFixtureFile {
  path: string
  content: string
}

export interface MortiseUiFixtureMessage {
  id?: string
  role: 'user' | 'assistant' | 'tool' | 'error' | 'info' | 'plan'
  content: string
  timestamp?: number
  toolName?: string
  toolUseId?: string
  toolInput?: Record<string, unknown>
  toolResult?: string
  toolStatus?: 'pending' | 'running' | 'completed' | 'error'
  isError?: boolean
}

export interface MortiseUiFixtureSession {
  id: string
  parentSessionId?: string
  name?: string
  createdAt?: number
  lastUsedAt?: number
  permissionMode?: 'safe' | 'ask' | 'allow-all'
  hasUnread?: boolean
  hidden?: boolean
  messages?: MortiseUiFixtureMessage[]
  /** Paths are relative to the session sidecar and must start with a supported sidecar folder. */
  files?: MortiseUiFixtureFile[]
}

export interface MortiseUiFixtureWorkspace {
  id: string
  name: string
  slug?: string
  permissionMode?: 'safe' | 'ask' | 'allow-all'
  files?: MortiseUiFixtureFile[]
  sessions?: MortiseUiFixtureSession[]
}

export interface MortiseUiFixtureSpec {
  version: typeof MORTISE_UI_FIXTURE_VERSION
  active?: { workspaceId: string; sessionId?: string | null }
  workspaces: MortiseUiFixtureWorkspace[]
}

export interface MortiseUiFixtureSummary {
  version: typeof MORTISE_UI_FIXTURE_VERSION
  workspaceCount: number
  sessionCount: number
  messageCount: number
  fileCount: number
  activeWorkspaceId: string
  activeSessionId: string | null
}

const fileSchema = {
  type: 'object', additionalProperties: false, required: ['path', 'content'],
  properties: {
    path: { type: 'string', minLength: 1, maxLength: 240 },
    content: { type: 'string', maxLength: LIMITS.fileBytes },
  },
}

export const MORTISE_UI_FIXTURE_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://mortise.local/schemas/mortise-ui-fixture-v1.json',
  title: 'Mortise UI fixture',
  description: 'A bounded source-development profile containing real workspaces, files, sessions, and conversation history.',
  type: 'object',
  additionalProperties: false,
  required: ['version', 'workspaces'],
  properties: {
    version: { const: MORTISE_UI_FIXTURE_VERSION },
    active: {
      type: 'object', additionalProperties: false, required: ['workspaceId'],
      properties: {
        workspaceId: { type: 'string', pattern: IDENTIFIER_PATTERN },
        sessionId: { type: ['string', 'null'], pattern: IDENTIFIER_PATTERN },
      },
    },
    workspaces: {
      type: 'array', minItems: 1, maxItems: LIMITS.workspaces,
      items: {
        type: 'object', additionalProperties: false, required: ['id', 'name'],
        properties: {
          id: { type: 'string', pattern: IDENTIFIER_PATTERN },
          name: { type: 'string', minLength: 1, maxLength: 120 },
          slug: { type: 'string', pattern: IDENTIFIER_PATTERN },
          permissionMode: { enum: [...PERMISSION_MODES] },
          files: { type: 'array', maxItems: LIMITS.files, items: fileSchema },
          sessions: {
            type: 'array', maxItems: LIMITS.sessionsPerWorkspace,
            items: {
              type: 'object', additionalProperties: false, required: ['id'],
              properties: {
                id: { type: 'string', pattern: IDENTIFIER_PATTERN },
                parentSessionId: { type: 'string', pattern: IDENTIFIER_PATTERN },
                name: { type: 'string', minLength: 1, maxLength: 160 },
                createdAt: { type: 'number', minimum: 0 },
                lastUsedAt: { type: 'number', minimum: 0 },
                permissionMode: { enum: [...PERMISSION_MODES] },
                hasUnread: { type: 'boolean' },
                hidden: { type: 'boolean' },
                files: { type: 'array', maxItems: LIMITS.files, items: fileSchema },
                messages: {
                  type: 'array', maxItems: LIMITS.messagesPerSession,
                  items: {
                    type: 'object', additionalProperties: false, required: ['role', 'content'],
                    properties: {
                      id: { type: 'string', pattern: IDENTIFIER_PATTERN },
                      role: { enum: [...MESSAGE_ROLES] },
                      content: { type: 'string', maxLength: LIMITS.messageBytes },
                      timestamp: { type: 'number', minimum: 0 },
                      toolName: { type: 'string', minLength: 1, maxLength: 120 },
                      toolUseId: { type: 'string', pattern: IDENTIFIER_PATTERN },
                      toolInput: { type: 'object' },
                      toolResult: { type: 'string', maxLength: LIMITS.messageBytes },
                      toolStatus: { enum: ['pending', 'running', 'completed', 'error'] },
                      isError: { type: 'boolean' },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  examples: [{
    version: 1,
    active: { workspaceId: 'docs', sessionId: 'review-readme' },
    workspaces: [{
      id: 'docs', name: 'Documentation', permissionMode: 'safe',
      files: [{ path: 'README.md', content: '# Documentation\n' }],
      sessions: [{
        id: 'review-readme', name: 'Review README', hasUnread: true,
        messages: [
          { role: 'user', content: 'Review the README structure.' },
          { role: 'assistant', content: 'The structure is clear; the setup section needs an example.' },
        ],
        files: [{ path: 'plans/readme-review.md', content: '# Review plan\n' }],
      }],
    }],
  }],
} as const

const DEFAULT_FIXTURE_STARTED_AT = Date.UTC(2026, 0, 5, 9, 0, 0)
const fixtureMinute = (minutes: number): number => DEFAULT_FIXTURE_STARTED_AT + minutes * 60_000

export const DEFAULT_MORTISE_UI_FIXTURE: MortiseUiFixtureSpec = {
  version: MORTISE_UI_FIXTURE_VERSION,
  active: { workspaceId: 'product-launch', sessionId: 'release-readiness' },
  workspaces: [
    {
      id: 'product-launch', name: 'Mercury Launch', permissionMode: 'ask',
      files: [
        { path: 'README.md', content: '# Mercury Launch\n\nRelease workspace for the Mercury desktop update.\n' },
        { path: 'package.json', content: '{\n  "name": "mercury-desktop",\n  "version": "2.4.0",\n  "private": true\n}\n' },
        { path: 'src/search.ts', content: 'export function rankResults(query: string, titles: string[]): string[] {\n  return titles.filter(title => title.toLowerCase().includes(query.toLowerCase()))\n}\n' },
        { path: 'docs/release-checklist.md', content: '# Release checklist\n\n- [x] Freeze strings\n- [ ] Verify search regression\n- [ ] Publish release notes\n' },
        { path: 'data/issues.csv', content: 'id,area,severity,status\nM-142,search,high,investigating\nM-155,onboarding,medium,ready\n' },
      ],
      sessions: [
        {
          id: 'release-readiness', name: 'Release readiness review', createdAt: fixtureMinute(160), lastUsedAt: fixtureMinute(180),
          messages: [
            { role: 'user', content: 'Review the current release materials and identify the remaining risks.', timestamp: fixtureMinute(162) },
            { role: 'assistant', content: 'The main risks are the open search regression, the unchecked publication step, and incomplete release notes.', timestamp: fixtureMinute(163) },
            { role: 'user', content: 'Turn that into a short execution plan for the release owner.', timestamp: fixtureMinute(165) },
            { role: 'assistant', content: 'I prepared a three-step plan: verify search, finish the release notes, then run the publication checklist.', timestamp: fixtureMinute(166) },
          ],
          files: [
            { path: 'plans/release-readiness.md', content: '# Release readiness\n\n1. Reproduce and verify M-142.\n2. Finish release notes.\n3. Complete publication checks.\n' },
            { path: 'data/risk-register.json', content: '{\n  "high": ["M-142"],\n  "medium": ["M-155"]\n}\n' },
          ],
        },
        {
          id: 'verify-search-child', parentSessionId: 'release-readiness', name: 'Verify search behavior', createdAt: fixtureMinute(167),
          messages: [
            { role: 'user', content: 'Reproduce M-142 and verify exact-title search behavior.', timestamp: fixtureMinute(168) },
            { role: 'assistant', content: 'Exact-title matching works in rankResults; the remaining check is upstream query normalization.', timestamp: fixtureMinute(169) },
          ],
        },
        {
          id: 'search-regression', name: 'Fix search regression', createdAt: fixtureMinute(20), hasUnread: true,
          messages: [
            { role: 'user', content: 'Find why exact-title searches stopped returning results.', timestamp: fixtureMinute(21) },
            { role: 'tool', content: 'Read src/search.ts', timestamp: fixtureMinute(22), toolName: 'read', toolUseId: 'read-search-source', toolInput: { path: 'src/search.ts' }, toolStatus: 'completed' },
            { role: 'tool', content: 'Loaded src/search.ts', timestamp: fixtureMinute(23), toolName: 'read', toolUseId: 'read-search-source', toolResult: 'rankResults performs a case-insensitive substring filter.', toolStatus: 'completed' },
            { role: 'assistant', content: 'The current filter handles exact titles. The likely regression is upstream normalization; the next check should compare the submitted query before rankResults is called.', timestamp: fixtureMinute(24) },
          ],
        },
        {
          id: 'onboarding-copy', name: 'Tighten onboarding copy', createdAt: fixtureMinute(40),
          messages: [
            { role: 'user', content: 'Make the first-run copy shorter without removing the privacy explanation.', timestamp: fixtureMinute(41) },
            { role: 'assistant', content: 'Suggested copy: Choose a workspace to begin. Mortise keeps project files local unless you explicitly connect a remote service.', timestamp: fixtureMinute(42) },
          ],
        },
      ],
    },
    {
      id: 'customer-research', name: 'Customer Research', permissionMode: 'safe',
      files: [
        { path: 'README.md', content: '# Customer Research\n\nInterview synthesis and market comparison workspace.\n' },
        { path: 'research/interview-notes.md', content: '# Interview notes\n\nUsers value fast workspace switching and predictable local file access.\n' },
        { path: 'data/interviews.csv', content: 'participant,segment,top_need\nP01,developer,workspace switching\nP02,designer,file previews\nP03,lead,session history\n' },
        { path: 'data/segments.json', content: '{\n  "developer": 8,\n  "designer": 5,\n  "lead": 4\n}\n' },
      ],
      sessions: [
        {
          id: 'synthesize-interviews', name: 'Synthesize interviews', createdAt: fixtureMinute(60),
          messages: [
            { role: 'user', content: 'Summarize the strongest pattern across the interview notes and CSV.', timestamp: fixtureMinute(61) },
            { role: 'assistant', content: 'The strongest pattern is continuity: participants want to switch workspaces, reopen files, and resume prior sessions without rebuilding context.', timestamp: fixtureMinute(62) },
          ],
        },
        {
          id: 'pricing-comparison', name: 'Compare pricing feedback', createdAt: fixtureMinute(80),
          messages: [
            { role: 'user', content: 'Prepare a compact comparison matrix for the pricing discussion.', timestamp: fixtureMinute(81) },
            { role: 'assistant', content: 'I grouped feedback by individual, team, and enterprise expectations and saved the matrix with this session.', timestamp: fixtureMinute(82) },
          ],
          files: [
            { path: 'data/pricing-matrix.json', content: '{\n  "individual": "simple monthly plan",\n  "team": "shared administration",\n  "enterprise": "audit and policy controls"\n}\n' },
          ],
        },
      ],
    },
    {
      id: 'support-operations', name: 'Support Operations', permissionMode: 'ask',
      files: [
        { path: 'README.md', content: '# Support Operations\n\nRunbooks, incidents, and weekly support triage.\n' },
        { path: 'runbooks/login-loop.md', content: '# Login loop\n\n1. Confirm system clock.\n2. Clear the expired local callback.\n3. Retry authentication once.\n' },
        { path: 'incidents/INC-1042.md', content: '# INC-1042\n\nIntermittent login callback loop affecting Windows clients.\n' },
        { path: 'data/tickets.csv', content: 'ticket,topic,priority,state\nT-801,login loop,urgent,open\nT-804,export format,normal,waiting\n' },
      ],
      sessions: [
        {
          id: 'login-loop-follow-up', name: 'Login loop follow-up', createdAt: fixtureMinute(100), hasUnread: true,
          messages: [
            { role: 'user', content: 'Check whether the login-loop runbook covers the latest incident report.', timestamp: fixtureMinute(101) },
            { role: 'assistant', content: 'It covers the recovery path, but INC-1042 also needs a step to capture callback diagnostics before clearing local state.', timestamp: fixtureMinute(102) },
          ],
        },
        {
          id: 'weekly-triage', name: 'Weekly support triage', createdAt: fixtureMinute(120),
          messages: [
            { role: 'user', content: 'Prioritize the open tickets and prepare the weekly triage order.', timestamp: fixtureMinute(121) },
            { role: 'assistant', content: 'T-801 is first because it blocks authentication. T-804 can wait for product clarification on export formats.', timestamp: fixtureMinute(122) },
          ],
          files: [
            { path: 'plans/weekly-triage.md', content: '# Weekly triage\n\n1. Investigate T-801.\n2. Request product guidance for T-804.\n' },
          ],
        },
      ],
    },
  ],
}

export function loadMortiseUiFixtureSpec(path: string): MortiseUiFixtureSpec {
  const resolved = resolve(path)
  let parsed: unknown
  try { parsed = JSON.parse(readFileSync(resolved, 'utf8')) }
  catch (error) { throw new Error(`Fixture ${resolved} must be readable valid JSON: ${error instanceof Error ? error.message : String(error)}`) }
  return validateMortiseUiFixtureSpec(parsed)
}

export function validateMortiseUiFixtureSpec(value: unknown): MortiseUiFixtureSpec {
  const root = record(value, 'fixture')
  exactKeys(root, ['version', 'active', 'workspaces'], 'fixture')
  if (root.version !== MORTISE_UI_FIXTURE_VERSION) fail('fixture.version', `must equal ${MORTISE_UI_FIXTURE_VERSION}`)
  const rawWorkspaces = array(root.workspaces, 'fixture.workspaces', 1, LIMITS.workspaces)
  const workspaceIds = new Set<string>()
  const workspaceSlugs = new Set<string>()
  const sessionOwners = new Map<string, string>()
  let fileCount = 0
  let fileBytes = 0
  let messageCount = 0
  let messageBytes = 0

  const workspaces = rawWorkspaces.map((raw, workspaceIndex): MortiseUiFixtureWorkspace => {
    const path = `fixture.workspaces[${workspaceIndex}]`
    const item = record(raw, path)
    exactKeys(item, ['id', 'name', 'slug', 'permissionMode', 'files', 'sessions'], path)
    const id = identifier(item.id, `${path}.id`)
    if (workspaceIds.has(id)) fail(`${path}.id`, `duplicates workspace ${id}`)
    workspaceIds.add(id)
    const slug = item.slug === undefined ? id : identifier(item.slug, `${path}.slug`)
    if (workspaceSlugs.has(slug.toLowerCase())) fail(`${path}.slug`, `duplicates workspace slug ${slug}`)
    workspaceSlugs.add(slug.toLowerCase())
    const workspaceFiles = validateFiles(item.files, `${path}.files`, 'workspace')
    fileCount += workspaceFiles.length
    fileBytes += bytesOfFiles(workspaceFiles)
    const rawSessions = item.sessions === undefined ? [] : array(item.sessions, `${path}.sessions`, 0, LIMITS.sessionsPerWorkspace)
    const sessions = rawSessions.map((rawSession, sessionIndex): MortiseUiFixtureSession => {
      const sessionPath = `${path}.sessions[${sessionIndex}]`
      const session = record(rawSession, sessionPath)
      exactKeys(session, ['id', 'parentSessionId', 'name', 'createdAt', 'lastUsedAt', 'permissionMode', 'hasUnread', 'hidden', 'messages', 'files'], sessionPath)
      const sessionId = identifier(session.id, `${sessionPath}.id`)
      if (sessionOwners.has(sessionId)) fail(`${sessionPath}.id`, `duplicates session ${sessionId}`)
      sessionOwners.set(sessionId, id)
      const messages = validateMessages(session.messages, `${sessionPath}.messages`)
      messageCount += messages.length
      messageBytes += messages.reduce((sum, message) => sum
        + Buffer.byteLength(message.content, 'utf8')
        + Buffer.byteLength(message.toolResult ?? '', 'utf8')
        + (message.toolInput === undefined ? 0 : Buffer.byteLength(JSON.stringify(message.toolInput), 'utf8')), 0)
      const sessionFiles = validateFiles(session.files, `${sessionPath}.files`, 'session')
      fileCount += sessionFiles.length
      fileBytes += bytesOfFiles(sessionFiles)
      return compact({
        id: sessionId,
        parentSessionId: session.parentSessionId === undefined ? undefined : identifier(session.parentSessionId, `${sessionPath}.parentSessionId`),
        name: optionalText(session.name, `${sessionPath}.name`, 160),
        createdAt: optionalNumber(session.createdAt, `${sessionPath}.createdAt`),
        lastUsedAt: optionalNumber(session.lastUsedAt, `${sessionPath}.lastUsedAt`),
        permissionMode: optionalPermissionMode(session.permissionMode, `${sessionPath}.permissionMode`),
        hasUnread: optionalBoolean(session.hasUnread, `${sessionPath}.hasUnread`),
        hidden: optionalBoolean(session.hidden, `${sessionPath}.hidden`),
        messages: messages.length ? messages : undefined,
        files: sessionFiles.length ? sessionFiles : undefined,
      })
    })
    return compact({
      id,
      name: text(item.name, `${path}.name`, 120),
      slug,
      permissionMode: optionalPermissionMode(item.permissionMode, `${path}.permissionMode`),
      files: workspaceFiles.length ? workspaceFiles : undefined,
      sessions: sessions.length ? sessions : undefined,
    })
  })

  for (const [workspaceIndex, workspace] of workspaces.entries()) {
    for (const [sessionIndex, session] of (workspace.sessions ?? []).entries()) {
      if (!session.parentSessionId) continue
      const path = `fixture.workspaces[${workspaceIndex}].sessions[${sessionIndex}].parentSessionId`
      if (session.parentSessionId === session.id) fail(path, 'must reference a different session')
      if (sessionOwners.get(session.parentSessionId) !== workspace.id) fail(path, `must reference a session in workspace ${workspace.id}`)
    }
  }

  if (fileCount > LIMITS.files) fail('fixture', `contains ${fileCount} files; maximum is ${LIMITS.files}`)
  if (fileBytes > LIMITS.totalFileBytes) fail('fixture', `contains ${fileBytes} file bytes; maximum is ${LIMITS.totalFileBytes}`)
  if (messageCount > LIMITS.messages) fail('fixture', `contains ${messageCount} messages; maximum is ${LIMITS.messages}`)
  if (messageBytes > LIMITS.totalMessageBytes) fail('fixture', `contains ${messageBytes} message bytes; maximum is ${LIMITS.totalMessageBytes}`)
  const active = validateActive(root.active, workspaceIds, sessionOwners, workspaces[0]!.id)
  return { version: MORTISE_UI_FIXTURE_VERSION, active, workspaces }
}

export function summarizeMortiseUiFixture(spec: MortiseUiFixtureSpec): MortiseUiFixtureSummary {
  return {
    version: spec.version,
    workspaceCount: spec.workspaces.length,
    sessionCount: spec.workspaces.reduce((sum, workspace) => sum + (workspace.sessions?.length ?? 0), 0),
    messageCount: spec.workspaces.reduce((sum, workspace) => sum + (workspace.sessions ?? []).reduce((sessionSum, session) => sessionSum + (session.messages?.length ?? 0), 0), 0),
    fileCount: spec.workspaces.reduce((sum, workspace) => sum + (workspace.files?.length ?? 0) + (workspace.sessions ?? []).reduce((sessionSum, session) => sessionSum + (session.files?.length ?? 0), 0), 0),
    activeWorkspaceId: spec.active?.workspaceId ?? spec.workspaces[0]!.id,
    activeSessionId: spec.active?.sessionId ?? null,
  }
}

function validateActive(value: unknown, workspaces: Set<string>, sessions: Map<string, string>, fallbackWorkspaceId: string): MortiseUiFixtureSpec['active'] {
  if (value === undefined) return { workspaceId: fallbackWorkspaceId, sessionId: null }
  const active = record(value, 'fixture.active')
  exactKeys(active, ['workspaceId', 'sessionId'], 'fixture.active')
  const workspaceId = identifier(active.workspaceId, 'fixture.active.workspaceId')
  if (!workspaces.has(workspaceId)) fail('fixture.active.workspaceId', `references unknown workspace ${workspaceId}`)
  if (active.sessionId === undefined || active.sessionId === null) return { workspaceId, sessionId: null }
  const sessionId = identifier(active.sessionId, 'fixture.active.sessionId')
  if (sessions.get(sessionId) !== workspaceId) fail('fixture.active.sessionId', `must belong to workspace ${workspaceId}`)
  return { workspaceId, sessionId }
}

function validateFiles(value: unknown, path: string, scope: 'workspace' | 'session'): MortiseUiFixtureFile[] {
  if (value === undefined) return []
  const paths = new Set<string>()
  return array(value, path, 0, LIMITS.files).map((raw, index) => {
    const itemPath = `${path}[${index}]`
    const item = record(raw, itemPath)
    exactKeys(item, ['path', 'content'], itemPath)
    const relativePath = safeRelativePath(item.path, `${itemPath}.path`)
    const comparisonPath = relativePath.toLowerCase()
    if (paths.has(comparisonPath)) fail(`${itemPath}.path`, `duplicates file ${relativePath}`)
    paths.add(comparisonPath)
    if (scope === 'workspace' && (comparisonPath === 'config.json' || comparisonPath.startsWith('.mortise/'))) {
      fail(`${itemPath}.path`, 'targets reserved workspace metadata')
    }
    if (scope === 'session' && !SESSION_FILE_ROOTS.has(relativePath.split('/')[0]!)) {
      fail(`${itemPath}.path`, `must start with one of ${[...SESSION_FILE_ROOTS].join(', ')}`)
    }
    const content = text(item.content, `${itemPath}.content`, LIMITS.fileBytes)
    return { path: relativePath, content }
  })
}

function validateMessages(value: unknown, path: string): MortiseUiFixtureMessage[] {
  if (value === undefined) return []
  const ids = new Set<string>()
  return array(value, path, 0, LIMITS.messagesPerSession).map((raw, index) => {
    const itemPath = `${path}[${index}]`
    const item = record(raw, itemPath)
    exactKeys(item, ['id', 'role', 'content', 'timestamp', 'toolName', 'toolUseId', 'toolInput', 'toolResult', 'toolStatus', 'isError'], itemPath)
    if (typeof item.role !== 'string' || !MESSAGE_ROLES.has(item.role)) fail(`${itemPath}.role`, 'is not a supported message role')
    const id = item.id === undefined ? undefined : identifier(item.id, `${itemPath}.id`)
    if (id && ids.has(id)) fail(`${itemPath}.id`, `duplicates message ${id}`)
    if (id) ids.add(id)
    if (item.toolInput !== undefined) record(item.toolInput, `${itemPath}.toolInput`)
    return compact({
      id,
      role: item.role as MortiseUiFixtureMessage['role'],
      content: text(item.content, `${itemPath}.content`, LIMITS.messageBytes),
      timestamp: optionalNumber(item.timestamp, `${itemPath}.timestamp`),
      toolName: optionalText(item.toolName, `${itemPath}.toolName`, 120),
      toolUseId: item.toolUseId === undefined ? undefined : identifier(item.toolUseId, `${itemPath}.toolUseId`),
      toolInput: item.toolInput as Record<string, unknown> | undefined,
      toolResult: optionalText(item.toolResult, `${itemPath}.toolResult`, LIMITS.messageBytes, true),
      toolStatus: optionalEnum(item.toolStatus, `${itemPath}.toolStatus`, ['pending', 'running', 'completed', 'error'] as const),
      isError: optionalBoolean(item.isError, `${itemPath}.isError`),
    })
  })
}

function safeRelativePath(value: unknown, path: string): string {
  const raw = text(value, path, 240).replace(/\\/g, '/')
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) fail(path, 'must be relative')
  const segments = raw.split('/')
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) fail(path, 'contains an empty, dot, or parent segment')
  if (segments.some(segment => segment.includes(':') || /[. ]$/.test(segment))) fail(path, 'contains a Windows-unsafe segment')
  if (segments.some(segment => /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(segment))) fail(path, 'contains a reserved Windows device name')
  return segments.join('/')
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, 'must be an object')
  return value as Record<string, unknown>
}

function array(value: unknown, path: string, min: number, max: number): unknown[] {
  if (!Array.isArray(value)) fail(path, 'must be an array')
  if (value.length < min || value.length > max) fail(path, `must contain between ${min} and ${max} items`)
  return value
}

function exactKeys(value: Record<string, unknown>, allowed: string[], path: string): void {
  const extra = Object.keys(value).find(key => !allowed.includes(key))
  if (extra) fail(`${path}.${extra}`, 'is not supported')
}

function identifier(value: unknown, path: string): string {
  if (typeof value !== 'string' || !IDENTIFIER_RE.test(value)) fail(path, `must match ${IDENTIFIER_PATTERN}`)
  return value
}

function text(value: unknown, path: string, max: number, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || Buffer.byteLength(value, 'utf8') > max) {
    fail(path, `must be ${allowEmpty ? 'a' : 'a non-empty'} string no larger than ${max} UTF-8 bytes`)
  }
  return value
}

function optionalText(value: unknown, path: string, max: number, allowEmpty = false): string | undefined {
  return value === undefined ? undefined : text(value, path, max, allowEmpty)
}

function optionalNumber(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail(path, 'must be a finite non-negative number')
  return value
}

function optionalBoolean(value: unknown, path: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') fail(path, 'must be a boolean')
  return value
}

function optionalPermissionMode(value: unknown, path: string): MortiseUiFixtureWorkspace['permissionMode'] {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !PERMISSION_MODES.has(value)) fail(path, 'must be safe, ask, or allow-all')
  return value as MortiseUiFixtureWorkspace['permissionMode']
}

function optionalEnum<const T extends readonly string[]>(value: unknown, path: string, values: T): T[number] | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !values.includes(value)) fail(path, `must be one of ${values.join(', ')}`)
  return value
}

function bytesOfFiles(files: MortiseUiFixtureFile[]): number {
  return files.reduce((sum, file) => sum + Buffer.byteLength(file.content, 'utf8'), 0)
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T
}

function fail(path: string, message: string): never {
  throw new Error(`${path} ${message}`)
}
