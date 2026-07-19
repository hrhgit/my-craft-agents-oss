import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'
import { isUiValidationBuildEnabled, uiValidationProductionBoundaryPlugin } from '../../scripts/build/ui-validation-boundary'

const requestedPort = Number.parseInt(process.env.MORTISE_VITE_PORT ?? process.env.PORT ?? '', 10)
const electronVitePort = Number.isInteger(requestedPort) && requestedPort > 0 && requestedPort <= 65535
  ? requestedPort
  : 5173

// NOTE: Source map upload to Sentry is intentionally disabled.
// To re-enable, uncomment the sentryVitePlugin below and add SENTRY_AUTH_TOKEN,
// SENTRY_ORG, SENTRY_PROJECT to CI secrets. See CLAUDE.md "Sentry Error Tracking" section.
// import { sentryVitePlugin } from '@sentry/vite-plugin'

export default defineConfig(({ command }) => {
  const uiValidationBuild = isUiValidationBuildEnabled(command)
  const disabledValidationDir = resolve(__dirname, 'src/renderer/ui-validation-disabled')

  return {
  plugins: [
    react({
      babel: {
        plugins: [
          // Jotai HMR support: caches atom instances in globalThis.jotaiAtomCache
          // so that HMR module re-execution returns stable atom references
          // instead of creating new (empty) atoms that orphan existing data.
          'jotai/babel/plugin-debug-label',
          ['jotai/babel/plugin-react-refresh', { customAtomNames: ['atomFamily'] }],
        ],
      },
    }),
    tailwindcss(),
    uiValidationProductionBoundaryPlugin(uiValidationBuild),
    // Sentry source map upload — intentionally disabled. See CLAUDE.md for re-enabling instructions.
    // sentryVitePlugin({
    //   org: process.env.SENTRY_ORG,
    //   project: process.env.SENTRY_PROJECT,
    //   authToken: process.env.SENTRY_AUTH_TOKEN,
    //   disable: !process.env.SENTRY_AUTH_TOKEN,
    //   sourcemaps: {
    //     filesToDeleteAfterUpload: ['**/*.map'],
    //   },
    // }),
  ],
  root: resolve(__dirname, 'src/renderer'),
  base: './',
  build: {
    outDir: resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
    sourcemap: true,  // Source maps generated for debugging. Not uploaded to Sentry (see CLAUDE.md).
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'src/renderer/index.html'),
        playground: resolve(__dirname, 'src/renderer/playground.html'),
        'browser-toolbar': resolve(__dirname, 'src/renderer/browser-toolbar.html'),
        'browser-empty-state': resolve(__dirname, 'src/renderer/browser-empty-state.html'),
      }
    }
  },
  resolve: {
    alias: {
      ...(!uiValidationBuild ? {
        '@mortise/shared/protocol': resolve(__dirname, '../../packages/shared/src/protocol/production.ts'),
        '@/ui-validation/bridge': resolve(disabledValidationDir, 'bridge.ts'),
        '@/ui-validation/state-bridge': resolve(disabledValidationDir, 'state-bridge.ts'),
        '@/ui-validation/react': resolve(disabledValidationDir, 'react.ts'),
        '@/ui-validation/app-shell-scenario-service': resolve(disabledValidationDir, 'app-shell-scenario-service.tsx'),
        '@/components/extensions/extension-validation-store': resolve(disabledValidationDir, 'extension-validation-store.ts'),
        './extension-validation-store': resolve(disabledValidationDir, 'extension-validation-store.ts'),
      } : {}),
      '@': resolve(__dirname, 'src/renderer'),
      '@config': resolve(__dirname, '../../packages/shared/src/config'),
      // Force all React imports to use the root node_modules React
      // Bun hoists deps to root. This prevents "multiple React copies" error from @mortise/ui
      'react': resolve(__dirname, '../../node_modules/react'),
      'react-dom': resolve(__dirname, '../../node_modules/react-dom'),
    },
    dedupe: ['react', 'react-dom']
  },
  optimizeDeps: {
    include: ['react', 'react-dom', 'jotai', 'pdfjs-dist'],
    exclude: ['@mortise/ui'],
    esbuildOptions: {
      supported: { 'top-level-await': true },
      target: 'esnext'
    }
  },
  define: {
    __MORTISE_UI_VALIDATION_BUILD__: JSON.stringify(uiValidationBuild),
  },
  server: {
    port: electronVitePort,
    strictPort: true,
    open: false
  }
  }
})
