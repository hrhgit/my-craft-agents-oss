import { build, type BuildOptions } from 'esbuild'
import { resolve } from 'node:path'

const repositoryRoot = resolve(import.meta.dir, '../..')
const productionProtocolEntry = resolve(repositoryRoot, 'packages/shared/src/protocol/production.ts')

export interface ProductionNodeBundleTarget {
  label: string
  options: BuildOptions
}

export function createProductionNodeBundleTargets(root = repositoryRoot): ProductionNodeBundleTarget[] {
  const protocolEntry = resolve(root, 'packages/shared/src/protocol/production.ts')
  const productionDefines = {
    'process.env.MORTISE_UI_VALIDATION_BUILD': '"0"',
  }

  return [
    {
      label: 'workspace server',
      options: {
        absWorkingDir: root,
        entryPoints: ['packages/server/src/index.ts'],
        bundle: true,
        platform: 'node',
        format: 'esm',
        target: 'node20',
        external: ['electron'],
        alias: { '@mortise/shared/protocol': protocolEntry },
        define: productionDefines,
        banner: {
          js: "import { createRequire as __mortiseCreateRequire } from 'node:module'; import { fileURLToPath as __mortiseFileURLToPath } from 'node:url'; import { dirname as __mortiseDirname } from 'node:path'; var require = __mortiseCreateRequire(import.meta.url); var __filename = __mortiseFileURLToPath(import.meta.url); var __dirname = __mortiseDirname(__filename);",
        },
        minifySyntax: true,
        write: false,
        logLevel: 'silent',
      },
    },
    {
      label: 'Electron main',
      options: {
        absWorkingDir: root,
        entryPoints: ['apps/electron/src/main/index.ts'],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        external: ['electron'],
        alias: {
          '@mortise/shared/protocol': protocolEntry,
          'node-fetch': resolve(root, 'apps/electron/src/main/shims/node-fetch.cjs'),
          'abort-controller': resolve(root, 'apps/electron/src/main/shims/abort-controller.cjs'),
        },
        define: {
          ...productionDefines,
          '__MORTISE_UI_VALIDATION_BUILD__': 'false',
          '__MORTISE_DEV_HOST_BUILD__': 'false',
          'process.env.SENTRY_ELECTRON_INGEST_URL': '""',
          'process.env.MORTISE_DEV_RUNTIME': '""',
          'import.meta.url': '__mortise_import_meta_url',
          'import.meta.resolve': '__mortise_import_meta_resolve',
        },
        banner: {
          js: "const __mortise_import_meta_url = require('url').pathToFileURL(__filename).href; const __mortise_import_meta_resolve = (specifier) => require('url').pathToFileURL(require.resolve(specifier)).href;",
        },
        minifySyntax: true,
        write: false,
        logLevel: 'silent',
      },
    },
    {
      label: 'Electron preload',
      options: {
        absWorkingDir: root,
        entryPoints: [
          'apps/electron/src/preload/bootstrap.ts',
          'apps/electron/src/preload/browser-toolbar.ts',
        ],
        outdir: resolve(root, '.production-node-bundle-validation'),
        bundle: true,
        platform: 'node',
        format: 'cjs',
        external: ['electron'],
        alias: { '@mortise/shared/protocol': protocolEntry },
        define: {
          ...productionDefines,
          '__MORTISE_UI_VALIDATION_BUILD__': 'false',
        },
        minifySyntax: true,
        write: false,
        logLevel: 'silent',
      },
    },
  ]
}

export async function validateProductionNodeBundles(): Promise<void> {
  const startedAt = performance.now()
  console.log(`Compiling production Node bundles in memory with protocol entry ${productionProtocolEntry}...`)
  await Promise.all(createProductionNodeBundleTargets().map(async target => {
    const targetStartedAt = performance.now()
    await build(target.options)
    console.log(`  ${target.label}: ${Math.round(performance.now() - targetStartedAt)}ms`)
  }))
  console.log(`Production Node bundle validation passed in ${Math.round(performance.now() - startedAt)}ms.`)
}

if (import.meta.main) {
  await validateProductionNodeBundles()
}
