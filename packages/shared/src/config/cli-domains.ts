export type CliDomainNamespace = 'source' | 'skill' | 'automation' | 'permission' | 'theme'

export interface CliDomainPolicy {
  namespace: CliDomainNamespace
  helpCommand: string
  workspacePathScopes: string[]
  readActions: string[]
  quickExamples: string[]
  /** Optional workspace-relative paths guarded for direct Bash operations */
  bashGuardPaths?: string[]
}

const POLICIES: Record<CliDomainNamespace, CliDomainPolicy> = {
  source: {
    namespace: 'source',
    helpCommand: 'mortise source --help',
    workspacePathScopes: ['sources/**'],
    readActions: ['list', 'get', 'validate', 'test', 'auth-help'],
    quickExamples: [
      'mortise source list',
      'mortise source get <slug>',
      'mortise source update <slug> --json "{...}"',
      'mortise source validate <slug>',
    ],
  },
  skill: {
    namespace: 'skill',
    helpCommand: 'mortise skill --help',
    workspacePathScopes: ['.pi/skills/**'],
    readActions: ['list', 'get', 'validate', 'where'],
    quickExamples: [
      'mortise skill list',
      'mortise skill get <slug>',
      'mortise skill update <slug> --json "{...}"',
      'mortise skill validate <slug>',
    ],
  },
  automation: {
    namespace: 'automation',
    helpCommand: 'mortise automation --help',
    workspacePathScopes: ['automations.json', 'automations-history.jsonl'],
    readActions: ['list', 'get', 'validate', 'history', 'last-executed', 'test', 'lint'],
    quickExamples: [
      'mortise automation list',
      'mortise automation create --event UserPromptSubmit --prompt "Summarize this prompt"',
      'mortise automation update <id> --json "{\"enabled\":false}"',
      'mortise automation history <id> --limit 20',
      'mortise automation validate',
    ],
    bashGuardPaths: ['automations.json', 'automations-history.jsonl'],
  },
  permission: {
    namespace: 'permission',
    helpCommand: 'mortise permission --help',
    workspacePathScopes: ['permissions.json', 'sources/*/permissions.json'],
    readActions: ['list', 'get', 'validate'],
    quickExamples: [
      'mortise permission list',
      'mortise permission get --source linear',
      'mortise permission add-mcp-pattern "list" --comment "All list ops" --source linear',
      'mortise permission validate',
    ],
    bashGuardPaths: ['permissions.json', 'sources/*/permissions.json'],
  },
  theme: {
    namespace: 'theme',
    helpCommand: 'mortise theme --help',
    workspacePathScopes: ['config.json', 'theme.json', 'themes/*.json'],
    readActions: ['get', 'validate', 'list-presets', 'get-preset'],
    quickExamples: [
      'mortise theme get',
      'mortise theme list-presets',
      'mortise theme set-color-theme nord',
      'mortise theme set-workspace-color-theme default',
      'mortise theme set-override --json "{\"accent\":\"#3b82f6\"}"',
    ],
    bashGuardPaths: ['config.json', 'theme.json', 'themes/*.json'],
  },
}

export const CLI_DOMAIN_POLICIES = POLICIES

export interface CliDomainScopeEntry {
  namespace: CliDomainNamespace
  scope: string
}

function dedupeScopes(scopes: string[]): string[] {
  return [...new Set(scopes)]
}

/**
 * Canonical workspace-relative path scopes owned by mortise CLI domains.
 * Use these for file-path ownership checks to avoid drift across call sites.
 */
export const MORTISE_AGENTS_CLI_OWNED_WORKSPACE_PATH_SCOPES = dedupeScopes(
  Object.values(POLICIES).flatMap(policy => policy.workspacePathScopes)
)

/**
 * Canonical workspace-relative path scopes guarded for direct Bash operations.
 */
export const MORTISE_AGENTS_CLI_OWNED_BASH_GUARD_PATH_SCOPES = dedupeScopes(
  Object.values(POLICIES).flatMap(policy => policy.bashGuardPaths ?? [])
)

/**
 * Namespace-aware workspace scope entries for mortise CLI owned paths.
 */
export const MORTISE_AGENTS_CLI_WORKSPACE_SCOPE_ENTRIES: CliDomainScopeEntry[] = Object.values(POLICIES)
  .flatMap(policy => policy.workspacePathScopes.map(scope => ({ namespace: policy.namespace, scope })))

/**
 * Namespace-aware Bash guard scope entries.
 */
export const MORTISE_AGENTS_CLI_BASH_GUARD_SCOPE_ENTRIES: CliDomainScopeEntry[] = Object.values(POLICIES)
  .flatMap(policy => (policy.bashGuardPaths ?? []).map(scope => ({ namespace: policy.namespace, scope })))

export interface BashPatternRule {
  pattern: string
  comment: string
}

/**
 * Derive the canonical Explore-mode read-only mortise bash patterns from
 * CLI domain policies. Keeps permissions regexes aligned with command metadata.
 */
export function getMortiseReadOnlyBashPatterns(): BashPatternRule[] {
  const namespaces = Object.keys(POLICIES) as CliDomainNamespace[]
  const namespaceAlternation = namespaces.join('|')

  const rules: BashPatternRule[] = namespaces.map((namespace) => {
    const policy = POLICIES[namespace]
    const actions = policy.readActions.join('|')
    return {
      pattern: `^mortise\\s+${namespace}\\s+(${actions})\\b`,
      comment: `mortise ${namespace} read-only operations`,
    }
  })

  rules.push(
    { pattern: '^mortise\\s*$', comment: 'mortise bare invocation (prints help)' },
    { pattern: `^mortise\\s+(${namespaceAlternation})\\s*$`, comment: 'mortise entity help' },
    { pattern: `^mortise\\s+(${namespaceAlternation})\\s+--help\\b`, comment: 'mortise entity help flags' },
    { pattern: '^mortise\\s+--(help|version|discover)\\b', comment: 'mortise global flags' },
  )

  return rules
}

export function getCliDomainPolicy(namespace: CliDomainNamespace): CliDomainPolicy {
  return POLICIES[namespace]
}
