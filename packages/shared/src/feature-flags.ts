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
  return nodeEnv === 'development' || nodeEnv === 'dev' || getEnv('CRAFT_DEBUG') === '1';
}

/**
 * Runtime-evaluated check for developer feedback feature.
 * Explicit env override has precedence over dev-runtime defaults.
 */
export function isDeveloperFeedbackEnabled(): boolean {
  const override = parseBooleanEnv(getEnv('CRAFT_FEATURE_DEVELOPER_FEEDBACK'));
  if (override !== undefined) return override;
  return isDevRuntime();
}

/**
 * Runtime-evaluated check for craft-agents-cli integration.
 *
 * Defaults to disabled. Override with CRAFT_FEATURE_CRAFT_AGENTS_CLI=1|0.
 */
export function isCraftAgentsCliEnabled(): boolean {
  const override = parseBooleanEnv(getEnv('CRAFT_FEATURE_CRAFT_AGENTS_CLI'));
  if (override !== undefined) return override;
  return false;
}

/**
 * Runtime-evaluated check for embedded server settings page.
 *
 * Defaults to disabled. Override with CRAFT_FEATURE_EMBEDDED_SERVER=1|0.
 */
export function isEmbeddedServerEnabled(): boolean {
  const override = parseBooleanEnv(getEnv('CRAFT_FEATURE_EMBEDDED_SERVER'));
  if (override !== undefined) return override;
  return false;
}

/**
 * 运行时判断是否将 prompt automation 委托给 pi prompt-automation 扩展执行。
 *
 * 对应配置项 `piExtensions.delegatePromptAutomation`，默认关闭（由 craft 的
 * PromptHandler 自行创建会话）。启用后 prompt action 走 pi prompt-automation
 * 扩展（通过 extension_command_invoke RPC，由 Task 2 桥接层实现）。
 * 覆盖方式：CRAFT_FEATURE_DELEGATE_PROMPT_AUTOMATION=1|0
 */
export function isDelegatePromptAutomationEnabled(): boolean {
  const override = parseBooleanEnv(getEnv('CRAFT_FEATURE_DELEGATE_PROMPT_AUTOMATION'));
  if (override !== undefined) return override;
  return false;
}

export const FEATURE_FLAGS = {
  /**
   * Enable agent developer feedback tool.
   *
   * Defaults to enabled in explicit development runtimes; disabled otherwise.
   * Override with CRAFT_FEATURE_DEVELOPER_FEEDBACK=1|0.
   */
  get developerFeedback(): boolean {
    return isDeveloperFeedbackEnabled();
  },
  /**
   * Enable craft-agent CLI guidance and guardrails.
   *
   * Defaults to disabled. Override with CRAFT_FEATURE_CRAFT_AGENTS_CLI=1|0.
   */
  get craftAgentsCli(): boolean {
    return isCraftAgentsCliEnabled();
  },
  /**
   * Enable embedded server settings page.
   *
   * Defaults to disabled. Override with CRAFT_FEATURE_EMBEDDED_SERVER=1|0.
   */
  get embeddedServer(): boolean {
    return isEmbeddedServerEnabled();
  },
  /**
   * 将 prompt automation 委托给 pi prompt-automation 扩展执行。
   *
   * 对应配置项 `piExtensions.delegatePromptAutomation`，默认关闭。
   * 启用后 prompt action 由 pi 扩展处理（通过 extension_command_invoke RPC）。
   * 覆盖方式：CRAFT_FEATURE_DELEGATE_PROMPT_AUTOMATION=1|0
   */
  get delegatePromptAutomation(): boolean {
    return isDelegatePromptAutomationEnabled();
  },
} as const;
