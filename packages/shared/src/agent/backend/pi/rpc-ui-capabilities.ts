import type { RpcHostUICapabilities } from '@mortise/pi-coding-agent/internal/rpc';

declare const __MORTISE_PRODUCTION_BUILD__: boolean | undefined;

export function createMortiseRpcUiCapabilities(
  env: NodeJS.ProcessEnv = process.env,
): RpcHostUICapabilities {
  // Production builds define this symbol so the validation branch is removed
  // entirely; source-level tests leave it undefined and can inject an env.
  const productionBuild = typeof __MORTISE_PRODUCTION_BUILD__ !== 'undefined'
    && __MORTISE_PRODUCTION_BUILD__ === true;
  const validationEnabled = !productionBuild
    && env.MORTISE_UI_VALIDATION_BUILD === '1'
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
