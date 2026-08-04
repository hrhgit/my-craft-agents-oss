import { describe, expect, it } from 'bun:test';
import { createMortiseRpcUiCapabilities } from './rpc-ui-capabilities.ts';

describe('Mortise RPC UI capabilities', () => {
  it('declares only capabilities supported by the current Pi contract', () => {
    expect(createMortiseRpcUiCapabilities({})).toEqual({
      kind: 'mortise',
      dialogs: true,
      contributions: true,
      interactionSchemas: [1],
    });
  });

  it('exposes validation only to a non-production validation host', () => {
    expect(createMortiseRpcUiCapabilities({
      MORTISE_UI_VALIDATION_BUILD: '1',
      MORTISE_UI_TEST_HOST: '1',
      NODE_ENV: 'test',
    })).toEqual({
      kind: 'mortise',
      dialogs: true,
      contributions: true,
      validation: true,
      interactionSchemas: [1],
    });

    expect(createMortiseRpcUiCapabilities({
      MORTISE_UI_VALIDATION_BUILD: '1',
      MORTISE_UI_TEST_HOST: '1',
      NODE_ENV: 'production',
    })).not.toHaveProperty('validation');
  });
});
