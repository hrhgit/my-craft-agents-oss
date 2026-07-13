const BEDROCK_ROUTING_KEYS = [
  'CLAUDE_CODE_USE_BEDROCK',
  'AWS_BEARER_TOKEN_BEDROCK',
  'ANTHROPIC_BEDROCK_BASE_URL',
] as const;

const MANAGED_AUTH_KEYS = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  ...BEDROCK_ROUTING_KEYS,
  'AWS_REGION',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
] as const;

const bedrockKeys = new Set<string>(BEDROCK_ROUTING_KEYS);
const baseline = Object.fromEntries(MANAGED_AUTH_KEYS.map(key => [
  key,
  bedrockKeys.has(key) ? undefined : process.env[key],
])) as Record<string, string | undefined>;

export function resetManagedAnthropicAuthEnvVars(): void {
  for (const key of MANAGED_AUTH_KEYS) {
    const value = baseline[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
