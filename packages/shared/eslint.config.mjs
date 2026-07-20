/**
 * ESLint Configuration for Shared Package
 *
 * Uses flat config format (ESLint 9+).
 * Includes custom rules for enforcing best practices in shared code.
 */

import tsParser from '@typescript-eslint/parser'
import tsPlugin from '@typescript-eslint/eslint-plugin'
import noDirectOpenImport from './eslint-rules/no-direct-open-import.cjs'
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
      'mortise-shared': {
        rules: {
          'no-direct-open-import': noDirectOpenImport,
          'no-raw-pi-file-io': noRawPiFileIo,
        },
      },
    },
    rules: {
      // Prevent direct imports of 'open' package — use openUrl() from utils instead
      'mortise-shared/no-direct-open-import': 'error',
      // Prevent new raw ~/.pi/agent file access outside documented seams
      'mortise-shared/no-raw-pi-file-io': 'error',

      // Red line: Pi SDK (@mortise/pi-*) is bottom-layer. Shared/host code must
      // talk to Pi via RpcClient through the sanctioned backend area only. See
      // docs/architecture/red-line.md.
      'no-restricted-syntax': ['error',
        {
          selector: 'ImportDeclaration[source.value=/^@mortise\\/pi-/]',
          message: 'Pi SDK (@mortise/pi-*) is bottom-layer. Talk to Pi via RpcClient through packages/shared/src/agent/backend only. See docs/architecture/red-line.md.',
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
  //   - secure-storage.ts: thin wrapper over Pi AuthStorage's mortise.<slug> credential
  //     namespace (setCraftCredential/getCraftCredential — purpose-built public API).
  //     Reimplementing auth.json I/O + locking in mortise would violate the red line's
  //     deeper principle (Pi owns credential storage).
  //   - models-pi.ts: static model/provider catalog (getModels/getProviders) used for
  //     PRE-AUTH provider listing in connection setup. RpcClient.getAvailableModels()
  //     requires a live authenticated session and cannot serve this path.
  //   - pi-skill-resolver.ts / skills/storage.ts: synchronous UI/server seams over
  //     Pi host facade skill listing.
  //   - sessions/storage.ts: session projection creation/lookup via Pi host facade.
  //   - pi-agent.ts: the Mortise backend adapter over Pi's PUBLIC RpcClient.
  {
    files: [
      'src/credentials/backends/secure-storage.ts',
      'src/config/models-pi.ts',
      'src/config/pi-global-config.ts',
      'src/pi/pi-skill-resolver.ts',
      'src/skills/storage.ts',
      'src/sessions/storage.ts',
      'src/sessions/tree-jsonl.ts',
      'src/agent/pi-agent.ts',
    ],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },
]
