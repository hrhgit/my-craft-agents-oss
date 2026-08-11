import { describe, it, expect } from 'bun:test';
import {
  getSessionToolDefs,
  getSessionToolNames,
  getSessionToolRegistry,
  getToolDefsAsJsonSchema,
  isSessionToolName,
  normalizeSessionToolName,
} from './tool-defs.ts';

describe('session tool registry helpers', () => {
  it('name set and registry stay aligned', () => {
    const names = getSessionToolNames();
    const registry = getSessionToolRegistry();

    for (const name of names) {
      expect(registry.has(name)).toBe(true);
    }
  });

  it('accepts only exact canonical session tool names', () => {
    expect(normalizeSessionToolName('get_session_info')).toBe('get_session_info');
    expect(normalizeSessionToolName('mcp__session__get_session_info')).toBeNull();
    expect(normalizeSessionToolName('session__get_session_info')).toBeNull();
    expect(normalizeSessionToolName('mcp__linear__get_session_info')).toBeNull();
    expect(isSessionToolName('mcp__session__get_session_info')).toBe(false);
    expect(isSessionToolName('session__get_session_info')).toBe(false);
  });

  it('emits canonical names without a compatibility namespace', () => {
    const names = getToolDefsAsJsonSchema().map(def => def.name);

    expect(names).toContain('get_session_info');
    expect(names.some(name => name.startsWith('mcp__session__'))).toBe(false);
    expect(names.some(name => name.startsWith('session__'))).toBe(false);
  });
});
