export type BuildInputKind = 'source' | 'generated' | 'runtime-resource'

export interface BuildInputSpec {
  path: string
  kind: BuildInputKind
  required: boolean
}

export const ELECTRON_BUILD_INPUTS: readonly BuildInputSpec[] = [
  { path: 'apps/electron/resources/pi-extensions', kind: 'runtime-resource', required: true },
]

export interface BuildBlockSpec {
  id: string
  inputPaths: readonly string[]
  dependencyIds: readonly string[]
  outputPaths: readonly string[]
  platformSensitive: boolean
  builder: string
}

export const ELECTRON_BUILD_BLOCK_SPECS: Readonly<Record<string, BuildBlockSpec>> = {
  'pi-workspace': {
    id: 'pi-workspace',
    inputPaths: [
      'pi/package.json',
      'pi/package-lock.json',
      'pi/packages/ai/package.json',
      'pi/packages/ai/src',
      'pi/packages/ai/tsconfig.build.json',
      'pi/packages/agent/package.json',
      'pi/packages/agent/src',
      'pi/packages/agent/tsconfig.build.json',
      'pi/packages/coding-agent/package.json',
      'pi/packages/coding-agent/src',
      'pi/packages/coding-agent/scripts',
      'pi/packages/coding-agent/tsconfig.build.json',
      'pi/scripts',
    ],
    dependencyIds: [],
    outputPaths: [
      'pi/packages/ai/dist',
      'pi/packages/agent/dist',
      'pi/packages/coding-agent/dist',
      'pi/.mortise-build-workspace.json',
    ],
    platformSensitive: false,
    builder: 'pi-workspace-v1',
  },
  'pi-binary': {
    id: 'pi-binary',
    inputPaths: [
      'pi/package-lock.json',
      'pi/packages/coding-agent/package.json',
      'pi/packages/coding-agent/src',
      'pi/packages/coding-agent/scripts',
      'pi/packages/coding-agent/sidecar',
      'pi/scripts',
    ],
    dependencyIds: ['pi-workspace'],
    outputPaths: [
      process.platform === 'win32'
        ? 'pi/packages/coding-agent/dist/pi.exe'
        : 'pi/packages/coding-agent/dist/pi',
      'pi/packages/coding-agent/dist/sidecar',
      'pi/packages/coding-agent/dist/photon_rs_bg.wasm',
      'pi/packages/coding-agent/dist/package.json',
      'pi/packages/coding-agent/dist/.mortise-build-binary.json',
    ],
    platformSensitive: true,
    builder: 'pi-binary-v1',
  },
  'electron-main': {
    id: 'electron-main',
    inputPaths: [
      'apps/electron/package.json',
      'apps/electron/src/main',
      'apps/electron/src/shared',
      'packages/core/src',
      'packages/shared/src',
      'packages/server-core/src',
      'packages/server/src',
      'packages/session-tools-core/src',
      'packages/session-mcp-server/src',
      'packages/messaging-whatsapp-worker/src',
      'scripts/electron-build-main.ts',
      'scripts/build/common.ts',
      'scripts/build/bundle-portability.ts',
      'scripts/build/ui-validation-boundary.ts',
    ],
    dependencyIds: ['pi-workspace'],
    outputPaths: [
      'apps/electron/dist/main.cjs',
      'apps/electron/dist/workspace-server.mjs',
      'apps/electron/dist/.developer-host-build.json',
      'packages/session-mcp-server/dist',
      'packages/messaging-whatsapp-worker/dist',
      'apps/electron/resources/session-mcp-server',
    ],
    platformSensitive: false,
    builder: 'electron-main-v1',
  },
  'electron-preload': {
    id: 'electron-preload',
    inputPaths: [
      'apps/electron/package.json',
      'apps/electron/src/preload',
      'apps/electron/src/shared',
      'packages/shared/src/protocol',
      'scripts/electron-build-preload.ts',
      'scripts/build/ui-validation-boundary.ts',
    ],
    dependencyIds: [],
    outputPaths: [
      'apps/electron/dist/bootstrap-preload.cjs',
      'apps/electron/dist/browser-toolbar-preload.cjs',
    ],
    platformSensitive: false,
    builder: 'electron-preload-v1',
  },
  'electron-renderer': {
    id: 'electron-renderer',
    inputPaths: [
      'apps/electron/package.json',
      'apps/electron/src/renderer',
      'apps/electron/src/shared',
      'apps/electron/vite.config.ts',
      'packages/core/src',
      'packages/shared/src',
      'packages/ui/src',
      'scripts/electron-build-renderer.ts',
    ],
    dependencyIds: [],
    outputPaths: ['apps/electron/dist/renderer'],
    platformSensitive: false,
    builder: 'electron-renderer-v1',
  },
  'electron-resources': {
    id: 'electron-resources',
    inputPaths: [
      'apps/electron/resources',
      'apps/electron/scripts/copy-assets.ts',
      'apps/electron/scripts/validate-assets.ts',
      'packages/shared/src/agent/powershell-parser.ps1',
      'scripts/electron-build-resources.ts',
    ],
    dependencyIds: ['pi-binary', 'electron-main'],
    outputPaths: ['apps/electron/dist/resources'],
    platformSensitive: true,
    builder: 'electron-resources-v1',
  },
  'electron-packaging-inputs': {
    id: 'electron-packaging-inputs',
    inputPaths: [
      'apps/electron/electron-builder.yml',
      'apps/electron/electron-builder.devhost.yml',
      'apps/electron/package.json',
      'apps/electron/scripts',
      'apps/electron/build',
      'scripts/build/stage-electron-packaging-inputs.ts',
      'scripts/build/common.ts',
    ],
    dependencyIds: ['electron-resources', 'electron-main'],
    outputPaths: [
      'apps/electron/dist/packaging-inputs',
      'apps/electron/resources/bin',
    ],
    platformSensitive: true,
    builder: 'electron-packaging-inputs-v1',
  },
  'electron-capsule-assembly': {
    id: 'electron-capsule-assembly',
    inputPaths: [],
    dependencyIds: [
      'pi-workspace',
      'pi-binary',
      'electron-main',
      'electron-preload',
      'electron-renderer',
      'electron-resources',
      'electron-packaging-inputs',
    ],
    outputPaths: [],
    platformSensitive: true,
    builder: 'electron-capsule-assembly-v1',
  },
} as const
