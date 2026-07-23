import { describe, it, expect } from 'bun:test';
import {
  normalizeCanonicalBrowserToolName,
  isCanonicalBrowserToolName,
} from '../browser-tool-names.ts';

describe('browser tool name normalization', () => {
  it('accepts only the exact canonical name', () => {
    expect(normalizeCanonicalBrowserToolName('browser_tool')).toBe('browser_tool');
    expect(isCanonicalBrowserToolName('browser_tool')).toBe(true);
  });

  it('rejects namespaces and retired split names', () => {
    expect(normalizeCanonicalBrowserToolName('mcp__session__browser_tool')).toBeNull();
    expect(normalizeCanonicalBrowserToolName('session__browser_tool')).toBeNull();
    expect(normalizeCanonicalBrowserToolName('mcp__workspace__browser_tool')).toBeNull();
    expect(normalizeCanonicalBrowserToolName('browser_open')).toBeNull();
    expect(normalizeCanonicalBrowserToolName('mcp__session__browser_snapshot')).toBeNull();
    expect(isCanonicalBrowserToolName('browser_open')).toBe(false);
    expect(isCanonicalBrowserToolName('Write')).toBe(false);
  });
});
