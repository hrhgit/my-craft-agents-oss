/**
 * Session utility functions
 */

import {
  CRAFT_SESSION_METADATA_FIELDS,
  type CraftSessionMetadataField,
  type SessionPersistentField,
} from './types.js';

/**
 * Pick Craft-owned persistent metadata from a session-like object.
 * Pi header fields and computed/list cache fields are intentionally excluded.
 *
 * @param source - Object containing session fields
 * @returns Object with only Craft metadata fields that exist in source
 */
export function pickCraftSessionMetadata<T extends object>(
  source: T
): Partial<Record<CraftSessionMetadataField, unknown>> {
  const result: Partial<Record<CraftSessionMetadataField, unknown>> = {};
  for (const field of CRAFT_SESSION_METADATA_FIELDS) {
    if (field in source && (source as Record<string, unknown>)[field] !== undefined) {
      result[field] = (source as Record<string, unknown>)[field];
    }
  }
  return result;
}

/**
 * Compatibility alias for older call sites. New code should use
 * pickCraftSessionMetadata() to make the Pi/Craft boundary explicit.
 */
export function pickSessionFields<T extends object>(
  source: T
): Partial<Record<SessionPersistentField, unknown>> {
  return pickCraftSessionMetadata(source) as Partial<Record<SessionPersistentField, unknown>>;
}
