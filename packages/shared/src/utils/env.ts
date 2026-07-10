/**
 * Shared subprocess environment sanitization.
 *
 * Keep credential-bearing variables out of child processes unless a caller
 * explicitly re-adds the credentials it owns for that process.
 */

export const BLOCKED_ENV_VARS = [
  // Craft Agent auth (set by the app itself)
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',

  // AWS credentials
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',

  // Common API keys/tokens
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'OPENAI_API_KEY',
  'GOOGLE_API_KEY',
  'STRIPE_SECRET_KEY',
  'NPM_TOKEN',
] as const;

export type BlockedEnvVar = typeof BLOCKED_ENV_VARS[number];

/**
 * Return a shallow-copied environment with known credential variables removed.
 */
export function createSanitizedEnv(baseEnv: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  for (const key of BLOCKED_ENV_VARS) {
    delete env[key];
  }
  return env;
}

/**
 * Alias for call sites that want the operation name to emphasize filtering.
 */
export function stripBlockedEnv(baseEnv: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return createSanitizedEnv(baseEnv);
}
