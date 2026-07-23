import { describe, expect, it } from 'bun:test';

import type { SessionToolContext } from '../context.ts';
import { handleConfigValidate } from './config-validate.ts';

const contextWithoutValidators = {
  workspacePath: 'C:/workspace',
} as SessionToolContext;

describe('config validation authority', () => {
  it.each(['config', 'all'] as const)(
    'does not fall back to retired JSON storage for %s',
    async target => {
      const result = await handleConfigValidate(contextWithoutValidators, { target });
      const content = result.content[0];

      expect(result.isError).toBe(true);
      expect(content?.type).toBe('text');
      if (content?.type !== 'text') throw new Error('Expected a text error response');
      expect(content.text).toContain('SQLite configuration validation is unavailable');
      expect(content.text).not.toContain('config.json');
    },
  );
});
