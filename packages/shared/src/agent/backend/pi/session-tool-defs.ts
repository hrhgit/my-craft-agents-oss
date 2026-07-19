/**
 * Pi Session Host Tool Definitions
 *
 * Thin wrapper around the canonical tool definitions in @mortise/session-tools-core.
 * Host tools retain their canonical names. Ownership and execution transport
 * are runtime metadata rather than part of the model-facing name.
 */

import {
  getToolDefsAsJsonSchema,
  SESSION_TOOL_NAMES,
  type JsonSchemaToolDef,
} from '@mortise/session-tools-core';
import { FEATURE_FLAGS } from '../../../feature-flags.ts';

export type SessionHostToolDef = JsonSchemaToolDef;

export { SESSION_TOOL_NAMES };

/** Canonical session tools implemented by bundled Pi extensions instead of Host RPC. */
export const PI_EXTENSION_OWNED_SESSION_TOOL_NAMES = new Set<string>([
  'browser_tool',
  'list_messaging_channels',
  'unbind_messaging_channel',
]);

export function getSessionHostToolDefs(): SessionHostToolDef[] {
  return getToolDefsAsJsonSchema({
    includeDeveloperFeedback: FEATURE_FLAGS.developerFeedback,
  });
}
