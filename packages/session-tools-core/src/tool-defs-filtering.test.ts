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
    expect(normalizeSessionToolName('read_session')).toBe('read_session');
    expect(normalizeSessionToolName('get_session_info')).toBeNull();
    expect(normalizeSessionToolName('send_agent_message')).toBeNull();
    expect(normalizeSessionToolName('mcp__session__read_session')).toBeNull();
    expect(normalizeSessionToolName('session__read_session')).toBeNull();
    expect(isSessionToolName('mcp__session__read_session')).toBe(false);
    expect(isSessionToolName('session__read_session')).toBe(false);
  });

  it('emits canonical names without a compatibility namespace', () => {
    const names = getToolDefsAsJsonSchema().map(def => def.name);

    expect(names).toEqual(expect.arrayContaining([
      'list_sessions',
      'create_session',
      'read_session',
      'send_message_to_session',
    ]));
    expect(names.some(name => name.startsWith('mcp__session__'))).toBe(false);
    expect(names.some(name => name.startsWith('session__'))).toBe(false);
  });
});
