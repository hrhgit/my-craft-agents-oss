import { describe, expect, it } from 'bun:test';
import { buildPiMessageSearchPattern, extractPiSessionIdFromPath } from './search';

describe('extractPiSessionIdFromPath', () => {
  it('extracts ids from flat Pi session files on Windows and POSIX paths', () => {
    expect(extractPiSessionIdFromPath('C:\\Users\\me\\.pi\\agent\\sessions\\--work--\\2026-07-12T00-00-00-000Z_260712-fast-task.jsonl'))
      .toBe('260712-fast-task');
    expect(extractPiSessionIdFromPath('/home/me/.pi/agent/sessions/--work--/plain-id.jsonl'))
      .toBe('plain-id');
  });

  it('preserves underscores in the Craft session id', () => {
    expect(extractPiSessionIdFromPath('/sessions/2026-07-12T00-00-00-000Z_session_with_parts.jsonl'))
      .toBe('session_with_parts');
  });

  it('rejects the retired nested session filename and non-JSONL files', () => {
    expect(extractPiSessionIdFromPath('/sessions/legacy/session.jsonl')).toBeNull();
    expect(extractPiSessionIdFromPath('/sessions/session.txt')).toBeNull();
  });
});

describe('buildPiMessageSearchPattern', () => {
  it('matches real Pi user and assistant message entries but excludes tool results', () => {
    const pattern = new RegExp(buildPiMessageSearchPattern('needle'), 'i');
    const user = JSON.stringify({
      type: 'message',
      id: 'entry-user',
      parentId: null,
      timestamp: '2026-07-12T00:00:00.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'find needle here' }], timestamp: 1 },
    });
    const assistant = JSON.stringify({
      type: 'message',
      id: 'entry-assistant',
      parentId: 'entry-user',
      timestamp: '2026-07-12T00:00:01.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'needle found' }], timestamp: 2 },
    });
    const tool = JSON.stringify({
      type: 'message',
      id: 'entry-tool',
      parentId: 'entry-assistant',
      timestamp: '2026-07-12T00:00:02.000Z',
      message: { role: 'toolResult', content: [{ type: 'text', text: 'needle noise' }] },
    });

    expect(pattern.test(user)).toBe(true);
    expect(pattern.test(assistant)).toBe(true);
    expect(pattern.test(tool)).toBe(false);
  });

  it('escapes literal regex characters in the query', () => {
    const pattern = new RegExp(buildPiMessageSearchPattern('a+b?'));
    expect(pattern.test(JSON.stringify({
      type: 'message',
      message: { role: 'user', content: 'literal a+b?' },
    }))).toBe(true);
  });
});
