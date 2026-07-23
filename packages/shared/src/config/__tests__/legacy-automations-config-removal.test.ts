import { describe, expect, it } from 'bun:test';
import {
  CLI_DOMAIN_POLICIES,
  MORTISE_AGENTS_CLI_OWNED_BASH_GUARD_PATH_SCOPES,
  MORTISE_AGENTS_CLI_OWNED_WORKSPACE_PATH_SCOPES,
} from '../cli-domains.ts';
import { detectConfigFileType } from '../validators.ts';

describe('legacy automations config removal', () => {
  it('does not recognize automations.json as a workspace config file', () => {
    expect(detectConfigFileType('C:/workspace/automations.json', 'C:/workspace')).toBeNull();
  });

  it('does not claim or guard retired automation JSON files', () => {
    expect(CLI_DOMAIN_POLICIES.automation.workspacePathScopes).toEqual([]);
    expect(MORTISE_AGENTS_CLI_OWNED_WORKSPACE_PATH_SCOPES).not.toContain('automations.json');
    expect(MORTISE_AGENTS_CLI_OWNED_WORKSPACE_PATH_SCOPES).not.toContain('automations-history.jsonl');
    expect(MORTISE_AGENTS_CLI_OWNED_BASH_GUARD_PATH_SCOPES).not.toContain('automations.json');
    expect(MORTISE_AGENTS_CLI_OWNED_BASH_GUARD_PATH_SCOPES).not.toContain('automations-history.jsonl');
  });
});
