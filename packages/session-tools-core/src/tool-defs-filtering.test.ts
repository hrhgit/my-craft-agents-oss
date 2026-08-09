import { describe, it, expect } from 'bun:test';
import {
  getSessionToolDefs,
  getSessionToolNames,
  getSessionToolRegistry,
  getToolDefsAsJsonSchema,
  isSessionToolName,
  normalizeSessionToolName,
} from './tool-defs.ts';

describe('session tool filtering helpers', () => {
  it('excludes developer feedback tool when includeDeveloperFeedback is false', () => {
    const defs = getSessionToolDefs({ includeDeveloperFeedback: false });
    const names = defs.map(d => d.name);

    expect(names.includes('send_developer_feedback')).toBe(false);
  });

  it('includes developer feedback tool when includeDeveloperFeedback is true', () => {
    const defs = getSessionToolDefs({ includeDeveloperFeedback: true });
    const names = defs.map(d => d.name);

    expect(names.includes('send_developer_feedback')).toBe(true);
  });

  it('name set and registry stay aligned for filtered output', () => {
    const names = getSessionToolNames({ includeDeveloperFeedback: false });
    const registry = getSessionToolRegistry({ includeDeveloperFeedback: false });

    expect(registry.has('send_developer_feedback')).toBe(false);
    expect(names.has('send_developer_feedback')).toBe(false);

    for (const name of names) {
      expect(registry.has(name)).toBe(true);
    }
  });

  it('json schema conversion respects includeDeveloperFeedback filter', () => {
    const defs = getToolDefsAsJsonSchema({ includeDeveloperFeedback: false });
    const names = defs.map(d => d.name);

    expect(names.includes('send_developer_feedback')).toBe(false);
  });

  it('accepts only exact canonical session tool names', () => {
    expect(normalizeSessionToolName('config_validate')).toBe('config_validate');
    expect(normalizeSessionToolName('mcp__session__config_validate')).toBeNull();
    expect(normalizeSessionToolName('session__config_validate')).toBeNull();
    expect(normalizeSessionToolName('mcp__linear__config_validate')).toBeNull();
    expect(isSessionToolName('mcp__session__config_validate')).toBe(false);
    expect(isSessionToolName('session__config_validate')).toBe(false);
  });

  it('emits canonical names without a compatibility namespace', () => {
    const names = getToolDefsAsJsonSchema().map(def => def.name);

    expect(names).toContain('config_validate');
    expect(names.some(name => name.startsWith('mcp__session__'))).toBe(false);
    expect(names.some(name => name.startsWith('session__'))).toBe(false);
  });
});
