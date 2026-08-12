import { describe, expect, it } from 'bun:test';
import { SubagentSchema, getToolDefsAsJsonSchema } from './tool-defs.ts';

const CURRENT_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const RETIRED_LEVELS = ['think'] as const;

function getExportedThinkingLevels(): unknown {
  const subagent = getToolDefsAsJsonSchema().find(def => def.name === 'subagent');
  const properties = subagent?.inputSchema.properties;
  if (!properties || typeof properties !== 'object') return undefined;

  const thinkingLevel = (properties as Record<string, unknown>).thinkingLevel;
  if (!thinkingLevel || typeof thinkingLevel !== 'object') return undefined;

  return (thinkingLevel as Record<string, unknown>).enum;
}

describe('SubagentSchema.thinkingLevel', () => {
  it('accepts every current thinking level', () => {
    for (const level of CURRENT_LEVELS) {
      expect(SubagentSchema.safeParse({ thinkingLevel: level }).success).toBe(true);
    }
  });

  it('rejects every retired thinking level', () => {
    for (const level of RETIRED_LEVELS) {
      expect(SubagentSchema.safeParse({ thinkingLevel: level }).success).toBe(false);
    }
  });

  it('keeps thinkingLevel optional', () => {
    expect(SubagentSchema.safeParse({}).success).toBe(true);
  });

  it('declares exactly the current values in the canonical Zod schema', () => {
    expect(SubagentSchema.shape.thinkingLevel.unwrap().options).toEqual([...CURRENT_LEVELS]);
  });
});

describe('subagent exported JSON schema', () => {
  it('declares exactly the current values', () => {
    expect(getExportedThinkingLevels()).toEqual([...CURRENT_LEVELS]);
  });

  it('contains no retired value', () => {
    const levels = getExportedThinkingLevels();
    expect(Array.isArray(levels)).toBe(true);
    for (const level of RETIRED_LEVELS) {
      expect(levels).not.toContain(level);
    }
  });
});
