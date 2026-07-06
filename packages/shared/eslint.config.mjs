/**
 * ESLint Configuration for Shared Package
 *
 * Uses flat config format (ESLint 9+).
 * Includes custom rules for enforcing best practices in shared code.
 */

import tsParser from '@typescript-eslint/parser'
import tsPlugin from '@typescript-eslint/eslint-plugin'
import noDirectOpenImport from './eslint-rules/no-direct-open-import.cjs'
import noInlineSourceAuthCheck from './eslint-rules/no-inline-source-auth-check.cjs'
import noRawPiFileIo from './eslint-rules/no-raw-pi-file-io.cjs'

export default [
  // Ignore patterns
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      '*.cjs',
      'eslint-rules/**',
    ],
  },

  // TypeScript files
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      // Custom plugin for shared package rules
      'craft-shared': {
        rules: {
          'no-direct-open-import': noDirectOpenImport,
          'no-inline-source-auth-check': noInlineSourceAuthCheck,
          'no-raw-pi-file-io': noRawPiFileIo,
        },
      },
    },
    rules: {
      // Prevent direct imports of 'open' package — use openUrl() from utils instead
      'craft-shared/no-direct-open-import': 'error',
      // Prevent inline source.config.isAuthenticated checks — use isSourceUsable() instead
      'craft-shared/no-inline-source-auth-check': 'error',
      // Prevent new raw ~/.pi/agent file access outside documented seams
      'craft-shared/no-raw-pi-file-io': 'error',

      // Red line: Pi SDK (@earendil-works/pi-*) is bottom-layer. Shared/host code must
      // talk to Pi via RpcClient through the sanctioned backend area only. See
      // docs/architecture/red-line.md.
      'no-restricted-syntax': ['error',
        {
          selector: 'ImportDeclaration[source.value=/^@earendil-works\\/pi-/]',
          message: 'Pi SDK (@earendil-works/pi-*) is bottom-layer. Talk to Pi via RpcClient through packages/shared/src/agent/backend only. See docs/architecture/red-line.md.',
        },
      ],
    },
  },

  // Sanctioned backend area: the only place in shared/ that may import Pi SDK types
  // (typed event adapter, thinking-level constants). This seam shrinks as Pi exposes
  // typed public APIs (RpcClient events, etc.).
  {
    files: ['src/agent/backend/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },

  // Sanctioned seam extensions — files that consume Pi's typed PUBLIC API and are
  // the single place for their domain. These are the goal state, not violations:
  //   - secure-storage.ts: thin wrapper over Pi AuthStorage's craft.<slug> credential
  //     namespace (setCraftCredential/getCraftCredential — purpose-built public API).
  //     Reimplementing auth.json I/O + locking in craft would violate the red line's
  //     deeper principle (Pi owns credential storage).
  //   - models-pi.ts: static model/provider catalog (getModels/getProviders) used for
  //     PRE-AUTH provider listing in connection setup. RpcClient.getAvailableModels()
  //     requires a live authenticated session and cannot serve this path.
  //   - pi-agent.ts: the Craft backend adapter over Pi's PUBLIC RpcClient.
  {
    files: [
      'src/credentials/backends/secure-storage.ts',
      'src/config/models-pi.ts',
      'src/config/pi-global-config.ts',
      'src/sessions/tree-jsonl.ts',
      'src/agent/pi-agent.ts',
    ],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },
]
