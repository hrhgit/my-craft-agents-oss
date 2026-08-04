import type { RpcHostUICapabilities } from '@mortise/pi-coding-agent/rpc';

export function createMortiseRpcUiCapabilities(
  env: NodeJS.ProcessEnv = process.env,
): RpcHostUICapabilities {
  const validationEnabled = env.MORTISE_UI_VALIDATION_BUILD === '1'
    && env.MORTISE_UI_TEST_HOST === '1'
    && env.NODE_ENV !== 'production';

  return {
    kind: 'mortise',
    dialogs: true,
    contributions: true,
    ...(validationEnabled ? { validation: true } : {}),
    interactionSchemas: [1],
  };
}
