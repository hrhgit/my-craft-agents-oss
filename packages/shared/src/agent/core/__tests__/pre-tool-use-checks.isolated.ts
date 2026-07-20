/**
 * Tests for the centralized PreToolUse pipeline.
 *
 * Tests `runPreToolUseChecks()` (6-step pipeline) and `shouldPromptInAskMode()`
 * which are shared by both agent backends (ClaudeAgent, PiAgent).
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';

// ============================================================
// Module mocks (must be before imports of the module under test)
// ============================================================

let mockShouldAllowToolInMode = mock(
  (_toolName: string, _input: Record<string, unknown>, _mode: string, _opts?: any) =>
    ({ allowed: true, reason: '' })
);

let mockIsReadOnlyBashCommandWithConfig = mock(
  (_command: string, _config: any) => false
);

let mockEffectivePermissionMode: 'safe' | 'ask' | 'allow-all' = 'safe';

// Paths resolve from THIS file's location (core/__tests__/)
mock.module('../../mode-manager.ts', () => ({
  shouldAllowToolInMode: (a: any, b: any, c: any, d?: any) => mockShouldAllowToolInMode(a, b, c, d),
  isReadOnlyBashCommandWithConfig: (a: any, b: any) => mockIsReadOnlyBashCommandWithConfig(a, b),
  getPermissionModeDiagnostics: () => ({
    permissionMode: mockEffectivePermissionMode,
    modeVersion: 7,
    lastChangedAt: '2026-02-28T18:00:00.000Z',
    lastChangedBy: 'user',
  }),
}));

// Mock permissionsConfigCache for read-only bash pattern checks
let mockReadOnlyBashPatterns: Array<{ regex: RegExp }> = [];

mock.module('../../permissions-config.ts', () => ({
  permissionsConfigCache: {
    getMergedConfig: () => ({
      readOnlyBashPatterns: mockReadOnlyBashPatterns,
    }),
  },
}));

// Mock expandPath to avoid real home directory resolution
mock.module('../../../utils/paths.ts', () => ({
  expandPath: (p: string) => p.replace(/^~/, '/Users/test'),
}));

// Mock filesystem for config validation and skill qualification
let mockExistsSync = mock((_path: string) => false);
mock.module('node:fs', () => ({
  existsSync: (path: string) => mockExistsSync(path),
  readFileSync: (_path: string) => '',
}));

// Mock config validators (used by validateConfigWrite + CLI redirect)
let mockDetectConfigFileType = mock((_path: string, _workspaceRootPath?: string) => null as any);
let mockDetectAppConfigFileType = mock((_path: string) => null as any);
let mockValidateConfigFileContent = mock((_type: any, _content: string) => null as any);

mock.module('../../../config/validators.ts', () => ({
  detectConfigFileType: (a: any, b: any) => mockDetectConfigFileType(a, b),
  detectAppConfigFileType: (a: any) => mockDetectAppConfigFileType(a),
  validateConfigFileContent: (a: any, b: any) => mockValidateConfigFileContent(a, b),
  formatValidationResult: () => '',
}));

// Mock skill constants
mock.module('../../../skills/types.ts', () => ({
  AGENTS_PLUGIN_NAME: '.agents',
}));

mock.module('../../../skills/storage.ts', () => ({
  validateSkillSlug: (slug: unknown) => {
    if (!slug || typeof slug !== 'string') return null;
    if (slug.includes('/') || slug.includes('\\')) return null;
    return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) ? slug : null;
  },
}));

mock.module('../../../config/paths.ts', () => ({
  PI_SKILLS_DIR: '/Users/test/.pi/agent/skills',
  PI_PROJECT_SKILLS_DIR: '.pi/skills',
}));

let mockMortiseCliFlag = false;
mock.module('../../../feature-flags.ts', () => ({
  FEATURE_FLAGS: {
    get mortiseCli() {
      return mockMortiseCliFlag;
    },
    get developerFeedback() {
      return false;
    },
  },
}));

// ============================================================
// Import module under test (after mocks)
// ============================================================

import {
  runPreToolUseChecks,
  shouldPromptInAskMode,
  type PreToolUseInput,
  type PermissionManagerLike,
  type PrerequisiteManagerLike,
} from '../pre-tool-use.ts';

// ============================================================
// Test helpers
// ============================================================

function createMockPermissionManager(overrides?: Partial<PermissionManagerLike>): PermissionManagerLike {
  return {
    isCommandWhitelisted: () => false,
    isDangerousCommand: () => false,
    getBaseCommand: (cmd: string) => cmd.split(/\s+/)[0] || cmd,
    extractDomainFromNetworkCommand: () => null,
    isDomainWhitelisted: () => false,
    ...overrides,
  };
}

function createMockPrerequisiteManager(overrides?: Partial<PrerequisiteManagerLike>): PrerequisiteManagerLike {
  return {
    checkPrerequisites: () => ({ allowed: true }),
    trackBashSkillRead: () => false,
    ...overrides,
  };
}

function createInput(overrides?: Partial<PreToolUseInput>): PreToolUseInput {
  return {
    toolName: 'Read',
    input: { file_path: '/test/file.ts' },
    sessionId: 'test-session',
    permissionMode: 'allow-all',
    workspaceRootPath: '/test/workspace',
    workspaceId: 'test-ws',
    permissionManager: createMockPermissionManager(),
    ...overrides,
  };
}

// ============================================================
// Tests
// ============================================================

describe('runPreToolUseChecks', () => {
  beforeEach(() => {
    mockEffectivePermissionMode = 'safe';
    mockShouldAllowToolInMode.mockReset();
    mockShouldAllowToolInMode.mockImplementation(() => ({ allowed: true, reason: '' }));
    mockIsReadOnlyBashCommandWithConfig.mockReset();
    mockIsReadOnlyBashCommandWithConfig.mockImplementation(() => false);
    mockDetectConfigFileType.mockReset();
    mockDetectConfigFileType.mockImplementation(() => null);
    mockDetectAppConfigFileType.mockReset();
    mockDetectAppConfigFileType.mockImplementation(() => null);
    mockValidateConfigFileContent.mockReset();
    mockValidateConfigFileContent.mockImplementation(() => null);
    mockExistsSync.mockReset();
    mockExistsSync.mockImplementation(() => false);
    mockReadOnlyBashPatterns = [];
    mockMortiseCliFlag = false;
  });

  // ============================================================
  // Step 1: Permission mode check
  // ============================================================

  describe('step 1: permission mode check', () => {
    it('blocks when shouldAllowToolInMode returns not allowed', () => {
      mockShouldAllowToolInMode.mockImplementation(() => ({
        allowed: false,
        reason: 'Bash is not allowed in Explore mode',
      }));

      const result = runPreToolUseChecks(createInput({
        toolName: 'Bash',
        input: { command: 'rm -rf /' },
        permissionMode: 'safe',
      }));

      expect(result.type).toBe('block');
      if (result.type === 'block') {
        expect(result.reason).toContain('Bash is not allowed in Explore mode');
        expect(result.reason).toContain('Effective mode: Explore');
        expect(result.reason).toContain('Last mode change: user at 2026-02-28T18:00:00.000Z (modeVersion=7)');
      }
    });

    it('passes through when shouldAllowToolInMode allows', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'Read',
        input: { file_path: '/test/file.ts' },
      }));

      expect(result.type).toBe('allow');
    });

    it('passes correct args to shouldAllowToolInMode', () => {
      runPreToolUseChecks(createInput({
        toolName: 'Bash',
        input: { command: 'ls' },
        permissionMode: 'safe',
        plansFolderPath: '/test/plans',
        dataFolderPath: '/test/data',
        workspaceRootPath: '/test/workspace',
      }));

      expect(mockShouldAllowToolInMode).toHaveBeenCalledWith(
        'Bash',
        { command: 'ls' },
        'safe',
        {
          plansFolderPath: '/test/plans',
          dataFolderPath: '/test/data',
          permissionsContext: {
            workspaceRootPath: '/test/workspace',
          },
        }
      );
    });

    it('uses effective mode from mode-manager diagnostics when incoming mode is stale', () => {
      runPreToolUseChecks(createInput({
        toolName: 'Bash',
        input: { command: 'ls' },
        permissionMode: 'allow-all', // stale incoming value
      }));

      // Mocked diagnostics returns permissionMode='safe', which must be authoritative.
      expect(mockShouldAllowToolInMode).toHaveBeenCalledWith(
        'Bash',
        { command: 'ls' },
        'safe',
        expect.any(Object)
      );
    });
  });

  // ============================================================
  // Step 3: Prerequisite check
  // ============================================================

  describe('step 3: prerequisite check', () => {
    it('blocks when prerequisites are not met', () => {
      const prereqManager = createMockPrerequisiteManager({
        checkPrerequisites: () => ({
          allowed: false,
          blockReason: 'Please read the guide.md for linear before using its tools.',
        }),
      });

      const result = runPreToolUseChecks(createInput({
        toolName: 'WebSearch',
        input: {},
        prerequisiteManager: prereqManager,
      }));

      expect(result.type).toBe('block');
      if (result.type === 'block') {
        expect(result.reason).toContain('guide.md');
      }
    });

    it('passes when prerequisites are met', () => {
      const prereqManager = createMockPrerequisiteManager({
        checkPrerequisites: () => ({ allowed: true }),
      });

      const result = runPreToolUseChecks(createInput({
        toolName: 'WebSearch',
        input: {},
        prerequisiteManager: prereqManager,
      }));

      expect(result.type).toBe('allow');
    });

    it('skips when no prerequisiteManager provided', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'WebSearch',
        input: {},
        // No prerequisiteManager
      }));

      expect(result.type).toBe('allow');
    });
  });

  // ============================================================
  // Step 4: spawn_session interception
  // ============================================================

  describe('step 4: spawn_session interception', () => {
    it('intercepts canonical spawn_session', () => {
      const input = { prompt: 'do something' };
      const result = runPreToolUseChecks(createInput({
        toolName: 'spawn_session',
        input,
      }));

      expect(result.type).toBe('spawn_session_intercept');
      if (result.type === 'spawn_session_intercept') {
        expect(result.input).toEqual(input);
      }
    });

    it('does not intercept other session tools', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'config_validate',
        input: {},
      }));

      expect(result.type).toBe('allow');
    });
  });

  it('accepts persisted legacy spawn_session names', () => {
    const result = runPreToolUseChecks(createInput({
      toolName: 'mcp__session__spawn_session',
      input: { prompt: 'legacy history' },
    }));
    expect(result.type).toBe('spawn_session_intercept');
  });

  // ============================================================
  // Step 5: Input transforms
  // ============================================================

  describe('step 5: input transforms', () => {
    beforeEach(() => {
      mockMortiseCliFlag = true;
    });

    it('expands tilde paths and returns modify', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'Read',
        input: { file_path: '~/Documents/file.ts' },
      }));

      expect(result.type).toBe('modify');
      if (result.type === 'modify') {
        expect(result.input.file_path).toBe('/Users/test/Documents/file.ts');
      }
    });

    it('does not modify non-tilde paths', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'Read',
        input: { file_path: '/absolute/path/file.ts' },
      }));

      expect(result.type).toBe('allow');
    });

    it('strips _intent and _displayName metadata', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'mcp__linear__createIssue',
        input: { title: 'Bug fix', _intent: 'create issue', _displayName: 'Create Issue' },
      }));

      expect(result.type).toBe('modify');
      if (result.type === 'modify') {
        expect(result.input.title).toBe('Bug fix');
        expect(result.input._intent).toBeUndefined();
        expect(result.input._displayName).toBeUndefined();
      }
    });

    it('combines path expansion and metadata stripping', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'Read',
        input: { file_path: '~/test.ts', _intent: 'reading a file' },
      }));

      expect(result.type).toBe('modify');
      if (result.type === 'modify') {
        expect(result.input.file_path).toBe('/Users/test/test.ts');
        expect(result.input._intent).toBeUndefined();
      }
    });

    it('does not probe skill paths for unsafe skill slugs', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'Skill',
        input: { skill: '../../../../tmp/evil' },
        workingDirectory: '/repo',
      }));

      expect(result.type).toBe('allow');
      expect(mockExistsSync).not.toHaveBeenCalled();
    });

    it('does not block bash commands touching automations files when feature is disabled', () => {
      mockMortiseCliFlag = false;

      const result = runPreToolUseChecks(createInput({
        toolName: 'Bash',
        input: { command: 'python3 scripts/update.py automations.json' },
        permissionMode: 'allow-all',
      }));

      expect(result.type).toBe('allow');
    });

    it('blocks direct automations config edits and suggests mortise automation commands when feature is enabled', () => {
      mockMortiseCliFlag = true;
      mockDetectConfigFileType.mockImplementation(() => ({ type: 'automations', displayFile: 'automations.json' }));

      const result = runPreToolUseChecks(createInput({
        toolName: 'Edit',
        input: {
          file_path: '/test/workspace/automations.json',
          old_string: 'A',
          new_string: 'B',
        },
      }));

      expect(result.type).toBe('block');
      if (result.type === 'block') {
        expect(result.reason).toContain('mortise automation');
        expect(result.reason).toContain('automations.json');
      }
    });

    it('blocks direct skill file edits and suggests mortise skill commands when feature is enabled', () => {
      mockMortiseCliFlag = true;
      mockDetectConfigFileType.mockImplementation(() => ({
        type: 'skill',
        slug: 'commit-helper',
        displayFile: '.pi/skills/commit-helper/SKILL.md',
      }));

      const result = runPreToolUseChecks(createInput({
        toolName: 'Edit',
        input: {
          file_path: '/test/workspace/.pi/skills/commit-helper/SKILL.md',
          old_string: 'A',
          new_string: 'B',
        },
      }));

      expect(result.type).toBe('block');
      if (result.type === 'block') {
        expect(result.reason).toContain('mortise skill');
        expect(result.reason).toContain('.pi/skills/commit-helper/SKILL.md');
      }
    });

    it('blocks bash commands touching automations files and points to mortise automation --help when feature is enabled', () => {
      mockMortiseCliFlag = true;

      const result = runPreToolUseChecks(createInput({
        toolName: 'Bash',
        input: { command: 'python3 scripts/update.py automations.json' },
        permissionMode: 'allow-all',
      }));

      expect(result.type).toBe('block');
      if (result.type === 'block') {
        expect(result.reason).toContain('mortise automation --help');
        expect(result.reason).toContain('mortise automation');
      }
    });

    it('allows bash mortise automation commands through config-domain bash guard', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'Bash',
        input: { command: 'mortise automation list' },
        permissionMode: 'allow-all',
      }));

      expect(result.type).toBe('allow');
    });

    it('does not apply config-domain bash guard when feature is disabled', () => {
      mockMortiseCliFlag = false;

      const result = runPreToolUseChecks(createInput({
        toolName: 'Bash',
        input: { command: 'python3 scripts/update.py automations.json' },
        permissionMode: 'allow-all',
      }));

      expect(result.type).toBe('allow');
    });

  });

  // ============================================================
  // Step 6: Ask-mode prompt decision
  // ============================================================

  describe('step 6: ask-mode prompt decision', () => {
    beforeEach(() => {
      mockEffectivePermissionMode = 'ask';
    });

    it('prompts for bash commands in ask mode', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'Bash',
        input: { command: 'npm install express' },
        permissionMode: 'ask',
      }));

      expect(result.type).toBe('prompt');
      if (result.type === 'prompt') {
        expect(result.promptType).toBe('bash');
        expect(result.command).toBe('npm install express');
      }
    });

    it('prompts for file write tools in ask mode', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'Write',
        input: { file_path: '/test/file.ts', content: 'hello' },
        permissionMode: 'ask',
      }));

      expect(result.type).toBe('prompt');
      if (result.type === 'prompt') {
        expect(result.promptType).toBe('file_write');
        expect(result.description).toContain('/test/file.ts');
      }
    });

    it('prompts for Edit in ask mode', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'Edit',
        input: { file_path: '/test/file.ts', old_string: 'a', new_string: 'b' },
        permissionMode: 'ask',
      }));

      expect(result.type).toBe('prompt');
      if (result.type === 'prompt') {
        expect(result.promptType).toBe('file_write');
      }
    });

    it('does not prompt in allow-all mode', () => {
      mockEffectivePermissionMode = 'allow-all';

      const result = runPreToolUseChecks(createInput({
        toolName: 'Bash',
        input: { command: 'rm -rf /' },
        permissionMode: 'allow-all',
      }));

      expect(result.type).toBe('allow');
    });

    it('does not prompt in safe mode (blocked at step 1 instead)', () => {
      mockShouldAllowToolInMode.mockImplementation(() => ({
        allowed: false,
        reason: 'Blocked in safe mode',
      }));

      const result = runPreToolUseChecks(createInput({
        toolName: 'Bash',
        input: { command: 'rm -rf /' },
        permissionMode: 'safe',
      }));

      expect(result.type).toBe('block');
    });

    it('includes modifiedInput in prompt when transforms changed the input', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'Write',
        input: { file_path: '~/test.ts', content: 'hello', _intent: 'write file' },
        permissionMode: 'ask',
      }));

      expect(result.type).toBe('prompt');
      if (result.type === 'prompt') {
        expect(result.modifiedInput).toBeDefined();
        expect(result.modifiedInput!.file_path).toBe('/Users/test/test.ts');
        expect(result.modifiedInput!._intent).toBeUndefined();
      }
    });

    it('omits modifiedInput in prompt when no transforms applied', () => {
      const result = runPreToolUseChecks(createInput({
        toolName: 'Bash',
        input: { command: 'npm test' },
        permissionMode: 'ask',
      }));

      expect(result.type).toBe('prompt');
      if (result.type === 'prompt') {
        expect(result.modifiedInput).toBeUndefined();
      }
    });
  });

  // ============================================================
  // Pipeline ordering
  // ============================================================

  describe('pipeline ordering', () => {
    it('permission check runs before prerequisite checks', () => {
      mockShouldAllowToolInMode.mockImplementation(() => ({
        allowed: false,
        reason: 'Not allowed',
      }));

      const result = runPreToolUseChecks(createInput({
        toolName: 'mcp__calendar__createEvent',
        input: {},
        permissionMode: 'safe',
      }));

      expect(result.type).toBe('block');
      if (result.type === 'block') {
        expect(result.reason).toContain('Not allowed');
        expect(result.reason).toContain('Effective mode: Explore');
      }
    });

    it('prerequisite check runs before spawn_session interception', () => {
      // This scenario is contrived (spawn_session is from session server which is exempt
      // from prerequisites), but validates pipeline order for other session tools
      const prereqManager = createMockPrerequisiteManager({
        checkPrerequisites: (toolName: string) => {
          if (toolName === 'mcp__custom__some_tool') {
            return { allowed: false, blockReason: 'blocked' };
          }
          return { allowed: true };
        },
      });

      const result = runPreToolUseChecks(createInput({
        toolName: 'mcp__custom__some_tool',
        input: {},
        prerequisiteManager: prereqManager,
      }));

      expect(result.type).toBe('block');
    });

    it('spawn_session interception runs before transforms', () => {
      // spawn_session should be intercepted even if input has metadata
      const result = runPreToolUseChecks(createInput({
        toolName: 'spawn_session',
        input: { prompt: 'do something', _intent: 'summarize' },
      }));

      expect(result.type).toBe('spawn_session_intercept');
      if (result.type === 'spawn_session_intercept') {
        // Input should be passed through unmodified (no stripping)
        expect(result.input._intent).toBe('summarize');
      }
    });
  });

  // ============================================================
  // Debug callback
  // ============================================================

  describe('debug callback', () => {
    it('calls onDebug when tool is blocked by mode', () => {
      const debugMessages: string[] = [];
      mockShouldAllowToolInMode.mockImplementation(() => ({
        allowed: false,
        reason: 'Not allowed in safe mode',
      }));

      runPreToolUseChecks(createInput({
        toolName: 'Bash',
        input: { command: 'rm -rf /' },
        permissionMode: 'safe',
        onDebug: (msg) => debugMessages.push(msg),
      }));

      expect(debugMessages.length).toBeGreaterThan(0);
      expect(debugMessages[0]).toContain('safe');
      expect(debugMessages[0]).toContain('Bash');
    });

  });
});

// ============================================================
// shouldPromptInAskMode
// ============================================================

describe('shouldPromptInAskMode', () => {
  let pm: PermissionManagerLike;

  beforeEach(() => {
    pm = createMockPermissionManager();
    mockShouldAllowToolInMode.mockReset();
    mockIsReadOnlyBashCommandWithConfig.mockReset();
    mockIsReadOnlyBashCommandWithConfig.mockImplementation(() => false);
    mockDetectConfigFileType.mockReset();
    mockDetectConfigFileType.mockImplementation(() => null);
    mockDetectAppConfigFileType.mockReset();
    mockDetectAppConfigFileType.mockImplementation(() => null);
    mockValidateConfigFileContent.mockReset();
    mockValidateConfigFileContent.mockImplementation(() => null);
    mockReadOnlyBashPatterns = [];
    mockMortiseCliFlag = false;
  });

  // --- File writes ---

  describe('file write tools', () => {
    it('prompts for Write tool', () => {
      const result = shouldPromptInAskMode('Write', { file_path: '/test/file.ts', content: 'x' }, pm, {
        workspaceRootPath: '/test',
      });

      expect(result).not.toBeNull();
      expect(result!.promptType).toBe('file_write');
      expect(result!.description).toContain('/test/file.ts');
    });

    it('prompts for Edit tool', () => {
      const result = shouldPromptInAskMode('Edit', { file_path: '/test/a.ts' }, pm, {
        workspaceRootPath: '/test',
      });

      expect(result).not.toBeNull();
      expect(result!.promptType).toBe('file_write');
    });

    it('prompts for MultiEdit tool', () => {
      const result = shouldPromptInAskMode('MultiEdit', { file_path: '/test/a.ts' }, pm, {
        workspaceRootPath: '/test',
      });

      expect(result).not.toBeNull();
      expect(result!.promptType).toBe('file_write');
    });

    it('prompts for NotebookEdit with notebook_path', () => {
      const result = shouldPromptInAskMode('NotebookEdit', { notebook_path: '/test/nb.ipynb' }, pm, {
        workspaceRootPath: '/test',
      });

      expect(result).not.toBeNull();
      expect(result!.promptType).toBe('file_write');
      expect(result!.description).toContain('/test/nb.ipynb');
    });

    it('auto-allows whitelisted file write tools', () => {
      pm = createMockPermissionManager({
        isCommandWhitelisted: (cmd) => cmd === 'Write',
      });

      const result = shouldPromptInAskMode('Write', { file_path: '/test/a.ts' }, pm, {
        workspaceRootPath: '/test',
      });

      expect(result).toBeNull();
    });
  });

  // --- Bash ---

  describe('bash commands', () => {
    it('prompts for bash commands', () => {
      const result = shouldPromptInAskMode('Bash', { command: 'npm install express' }, pm, {
        workspaceRootPath: '/test',
      });

      expect(result).not.toBeNull();
      expect(result!.promptType).toBe('bash');
      expect(result!.command).toBe('npm install express');
    });

    it('auto-allows read-only bash commands (AST-validated)', () => {
      mockIsReadOnlyBashCommandWithConfig.mockImplementation(() => true);

      const result = shouldPromptInAskMode('Bash', { command: 'ls -la' }, pm, {
        workspaceRootPath: '/test',
      });

      expect(result).toBeNull();
    });

    it('does NOT auto-allow bash commands with redirects (e.g. cat > file)', () => {
      // isReadOnlyBashCommandWithConfig uses AST validation which catches redirects
      mockIsReadOnlyBashCommandWithConfig.mockImplementation(() => false);

      const result = shouldPromptInAskMode('Bash', { command: 'cat /etc/hosts > /tmp/test' }, pm, {
        workspaceRootPath: '/test',
      });

      expect(result).not.toBeNull();
      expect(result!.promptType).toBe('bash');
      expect(result!.command).toBe('cat /etc/hosts > /tmp/test');
    });

    it('auto-allows whitelisted non-dangerous commands', () => {
      pm = createMockPermissionManager({
        isCommandWhitelisted: (cmd) => cmd === 'npm',
        isDangerousCommand: () => false,
        getBaseCommand: (cmd) => cmd.split(/\s+/)[0] || cmd,
      });

      const result = shouldPromptInAskMode('Bash', { command: 'npm test' }, pm, {
        workspaceRootPath: '/test',
      });

      expect(result).toBeNull();
    });

    it('still prompts for whitelisted dangerous commands', () => {
      pm = createMockPermissionManager({
        isCommandWhitelisted: (cmd) => cmd === 'rm',
        isDangerousCommand: (cmd) => cmd === 'rm',
        getBaseCommand: (cmd) => cmd.split(/\s+/)[0] || cmd,
      });

      const result = shouldPromptInAskMode('Bash', { command: 'rm -rf /important' }, pm, {
        workspaceRootPath: '/test',
      });

      expect(result).not.toBeNull();
      expect(result!.promptType).toBe('bash');
    });

    it('auto-allows curl to whitelisted domain', () => {
      pm = createMockPermissionManager({
        getBaseCommand: (cmd) => cmd.split(/\s+/)[0] || cmd,
        extractDomainFromNetworkCommand: () => 'api.example.com',
        isDomainWhitelisted: (domain) => domain === 'api.example.com',
      });

      const result = shouldPromptInAskMode('Bash', { command: 'curl https://api.example.com/data' }, pm, {
        workspaceRootPath: '/test',
      });

      expect(result).toBeNull();
    });

    it('prompts for curl to non-whitelisted domain', () => {
      pm = createMockPermissionManager({
        getBaseCommand: (cmd) => cmd.split(/\s+/)[0] || cmd,
        extractDomainFromNetworkCommand: () => 'evil.com',
        isDomainWhitelisted: () => false,
      });

      const result = shouldPromptInAskMode('Bash', { command: 'curl https://evil.com/data' }, pm, {
        workspaceRootPath: '/test',
      });

      expect(result).not.toBeNull();
      expect(result!.promptType).toBe('bash');
    });
  });

  // --- Mortise host-tool mutations ---

  describe('Mortise host-tool mutations', () => {
    it('auto-allows canonical read-only session tools', () => {
      const result = shouldPromptInAskMode('config_validate', {}, pm, {
        workspaceRootPath: '/test',
      });

      expect(result).toBeNull();
    });
  });

  // --- MCP mutations ---

  describe('MCP mutations', () => {
    it('prompts for MCP mutations (blocked in safe mode)', () => {
      mockShouldAllowToolInMode.mockImplementation(
        (_tool: string, _input: Record<string, unknown>, mode: string) =>
          mode === 'safe' ? { allowed: false, reason: 'mutation' } : { allowed: true, reason: '' }
      );

      const result = shouldPromptInAskMode('mcp__linear__createIssue', { title: 'Bug' }, pm, {
        workspaceRootPath: '/test',
      });

      expect(result).not.toBeNull();
      expect(result!.promptType).toBe('mcp_mutation');
      expect(result!.description).toContain('linear');
    });

    it('auto-allows MCP read-only tools (not blocked in safe mode)', () => {
      mockShouldAllowToolInMode.mockImplementation(() => ({ allowed: true, reason: '' }));

      const result = shouldPromptInAskMode('mcp__linear__listIssues', {}, pm, {
        workspaceRootPath: '/test',
      });

      expect(result).toBeNull();
    });

    it('auto-allows whitelisted MCP mutations', () => {
      mockShouldAllowToolInMode.mockImplementation(
        (_tool: string, _input: Record<string, unknown>, mode: string) =>
          mode === 'safe' ? { allowed: false, reason: 'mutation' } : { allowed: true, reason: '' }
      );

      pm = createMockPermissionManager({
        isCommandWhitelisted: (cmd) => cmd === 'mcp__linear__createIssue',
      });

      const result = shouldPromptInAskMode('mcp__linear__createIssue', { title: 'Bug' }, pm, {
        workspaceRootPath: '/test',
      });

      expect(result).toBeNull();
    });
  });

  // --- Non-prompting tools ---

  describe('non-prompting tools', () => {
    it('returns null for Read tool', () => {
      const result = shouldPromptInAskMode('Read', { file_path: '/test/file.ts' }, pm, {
        workspaceRootPath: '/test',
      });

      expect(result).toBeNull();
    });

    it('returns null for Glob tool', () => {
      const result = shouldPromptInAskMode('Glob', { pattern: '**/*.ts' }, pm, {
        workspaceRootPath: '/test',
      });

      expect(result).toBeNull();
    });

    it('returns null for Grep tool', () => {
      const result = shouldPromptInAskMode('Grep', { pattern: 'TODO' }, pm, {
        workspaceRootPath: '/test',
      });

      expect(result).toBeNull();
    });

    it('returns null for Task tool', () => {
      const result = shouldPromptInAskMode('Task', {}, pm, {
        workspaceRootPath: '/test',
      });

      expect(result).toBeNull();
    });
  });
});
