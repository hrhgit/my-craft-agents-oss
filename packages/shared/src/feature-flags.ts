/**
 * Feature flags for controlling experimental or in-development features.
 */

/** Safe accessor for process.env — returns undefined in browser/renderer contexts. */
function getEnv(key: string): string | undefined {
  if (typeof process !== 'undefined' && process.env) return process.env[key];
  return undefined;
}

function parseBooleanEnv(value: string | undefined): boolean | undefined {
  if (value == null) return undefined;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return undefined;
}

/**
 * Shared runtime detector for development/debug environments.
 *
 * Use this instead of app-specific debug flags (e.g., Electron main isDebugMode)
 * so behavior stays consistent across shared code and subprocess backends.
 */
export function isDevRuntime(): boolean {
  const nodeEnv = (getEnv('NODE_ENV') || '').toLowerCase();
  return nodeEnv === 'development' || nodeEnv === 'dev' || getEnv('MORTISE_DEBUG') === '1';
}

/**
 * Runtime-evaluated check for mortise-cli integration.
 *
 * Defaults to disabled. Override with MORTISE_FEATURE_CLI=1|0.
 */
export function isMortiseCliEnabled(): boolean {
  const override = parseBooleanEnv(getEnv('MORTISE_FEATURE_CLI'));
  if (override !== undefined) return override;
  return false;
}

/**
 * Runtime-evaluated check for embedded server settings page.
 *
 * Defaults to disabled. Override with MORTISE_FEATURE_EMBEDDED_SERVER=1|0.
 */
export function isEmbeddedServerEnabled(): boolean {
  const override = parseBooleanEnv(getEnv('MORTISE_FEATURE_EMBEDDED_SERVER'));
  if (override !== undefined) return override;
  return false;
}

export const FEATURE_FLAGS = {
  /**
   * Enable mortise CLI guidance and guardrails.
   *
   * Defaults to disabled. Override with MORTISE_FEATURE_CLI=1|0.
   */
  get mortiseCli(): boolean {
    return isMortiseCliEnabled();
  },
  /**
   * Enable embedded server settings page.
   *
   * Defaults to disabled. Override with MORTISE_FEATURE_EMBEDDED_SERVER=1|0.
   */
  get embeddedServer(): boolean {
    return isEmbeddedServerEnabled();
  },
} as const;
