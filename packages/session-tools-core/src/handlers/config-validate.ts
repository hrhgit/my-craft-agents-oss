/**
 * Config Validate Handler
 *
 * Validates Mortise Agent configuration files.
 * Uses full validators if available (Claude), otherwise basic validation (Codex).
 */

import { join } from 'node:path';
import { homedir } from 'node:os';

import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { successResponse, errorResponse } from '../response.ts';
import {
  formatValidationResult,
  validateJsonFileHasFields,
} from '../validation.ts';

export interface ConfigValidateArgs {
  target: 'config' | 'preferences' | 'tool-icons' | 'all';
}

/**
 * Handle the config_validate tool call.
 *
 * If ctx.validators is available, uses full Zod validators.
 * Otherwise falls back to basic JSON field checking.
 */
export async function handleConfigValidate(
  ctx: SessionToolContext,
  args: ConfigValidateArgs
): Promise<ToolResult> {
  const { target } = args;
  const mortiseAgentRoot = process.env.MORTISE_CONFIG_DIR || join(homedir(), '.mortise');

  // If full validators available (Claude), use them
  if (ctx.validators) {
    try {
      let result;

      switch (target) {
        case 'config':
          result = ctx.validators.validateConfig();
          break;
        case 'preferences':
          result = ctx.validators.validatePreferences();
          break;
        case 'tool-icons':
          result = ctx.validators.validateToolIcons();
          break;
        case 'all':
          result = ctx.validators.validateAll(ctx.workspacePath);
          break;
      }

      return successResponse(formatValidationResult(result!));
    } catch (error) {
      return errorResponse(
        `Config validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  if (target === 'config' || target === 'all') {
    return errorResponse(
      'SQLite configuration validation is unavailable in this runtime. Use a host that provides the Mortise configuration validator.'
    );
  }

  // Fallback: basic validation (Codex path)
  switch (target) {
    case 'preferences': {
      const result = validateJsonFileHasFields(
        join(mortiseAgentRoot, 'preferences.json'),
        []
      );
      return successResponse(formatValidationResult(result));
    }

    case 'tool-icons': {
      const result = validateJsonFileHasFields(
        join(mortiseAgentRoot, 'tool-icons', 'tool-icons.json'),
        ['version', 'tools']
      );
      return successResponse(formatValidationResult(result));
    }

    default:
      return errorResponse(
        `Unknown validation target: ${target}. Valid targets: config, preferences, tool-icons, all`
      );
  }
}
