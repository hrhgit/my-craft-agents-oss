/**
 * Session utility functions
 */

import {
  MORTISE_SESSION_METADATA_FIELDS,
  type MortiseSessionMetadataField,
} from './types.js';

/**
 * Pick Mortise-owned persistent metadata from a session-like object.
 * Pi header fields and computed/list cache fields are intentionally excluded.
 *
 * @param source - Object containing session fields
 * @returns Object with only Mortise metadata fields that exist in source
 */
export function pickMortiseSessionMetadata<T extends object>(
  source: T
): Partial<Record<MortiseSessionMetadataField, unknown>> {
  const result: Partial<Record<MortiseSessionMetadataField, unknown>> = {};
  for (const field of MORTISE_SESSION_METADATA_FIELDS) {
    if (field in source && (source as Record<string, unknown>)[field] !== undefined) {
      result[field] = (source as Record<string, unknown>)[field];
    }
  }
  return result;
}
