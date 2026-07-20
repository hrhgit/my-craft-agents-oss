/**
 * Config Validate Handler
 *
 * Validates Mortise Agent configuration files.
 * Uses full validators if available (Claude), otherwise basic validation (Codex).
 */

import { join } from 'node:path';
import { homedir } from 'node:os';

const AUTOMATIONS_CONFIG_FILE = 'automations.json';
import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { successResponse, errorResponse } from '../response.ts';
import {
  formatValidationResult,
  validateJsonFileHasFields,
  mergeResults,
} from '../validation.ts';

export interface ConfigValidateArgs {
  target: 'config' | 'preferences' | 'permissions' | 'automations' | 'tool-icons' | 'all';
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
        case 'permissions':
          result = ctx.validators.validatePermissions(ctx.workspacePath);
          break;
        case 'automations':
          result = ctx.validators.validateAutomations(ctx.workspacePath);
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

  // Fallback: basic validation (Codex path)
  switch (target) {
    case 'config': {
      const result = validateJsonFileHasFields(
        join(mortiseAgentRoot, 'config.json'),
        ['workspaces']
      );
      return successResponse(formatValidationResult(result));
    }

    case 'preferences': {
      const result = validateJsonFileHasFields(
        join(mortiseAgentRoot, 'preferences.json'),
        []
      );
      return successResponse(formatValidationResult(result));
    }

    case 'permissions': {
      // Check workspace-level permissions.json
      const workspacePermsPath = join(ctx.workspacePath, 'permissions.json');
      if (!ctx.fs.exists(workspacePermsPath)) {
        return successResponse('✓ No workspace permissions.json (using defaults)');
      }
      const result = validateJsonFileHasFields(workspacePermsPath, []);
      return successResponse(formatValidationResult(result));
    }

    case 'automations': {
      const automationsPath = join(ctx.workspacePath, AUTOMATIONS_CONFIG_FILE);
      if (ctx.fs.exists(automationsPath)) {
        const result = validateJsonFileHasFields(automationsPath, []);
        return successResponse(formatValidationResult(result));
      }
      return successResponse(`✓ No ${AUTOMATIONS_CONFIG_FILE} (no automations configured)`);
    }

    case 'tool-icons': {
      const result = validateJsonFileHasFields(
        join(mortiseAgentRoot, 'tool-icons', 'tool-icons.json'),
        ['version', 'tools']
      );
      return successResponse(formatValidationResult(result));
    }

    case 'all': {
      const configResult = validateJsonFileHasFields(
        join(mortiseAgentRoot, 'config.json'),
        ['workspaces']
      );
      const prefsResult = validateJsonFileHasFields(
        join(mortiseAgentRoot, 'preferences.json'),
        []
      );
      const merged = mergeResults(configResult, prefsResult);
      return successResponse(formatValidationResult(merged));
    }

    default:
      return errorResponse(
        `Unknown validation target: ${target}. Valid targets: config, preferences, permissions, automations, tool-icons, all`
      );
  }
}
