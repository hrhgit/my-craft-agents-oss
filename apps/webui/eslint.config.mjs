/**
 * ESLint configuration for the Mortise WebUI browser entry.
 *
 * WebUI is a maintained Mortise shell for headless/server use. It intentionally
 * reuses the Electron renderer through aliases, while its own source stays
 * browser-only and talks to the server through the web API adapter.
 */

import tsParser from '@typescript-eslint/parser'
import tsPlugin from '@typescript-eslint/eslint-plugin'
import reactPlugin from 'eslint-plugin-react'
import reactHooksPlugin from 'eslint-plugin-react-hooks'

const nodeBuiltinImports = [
  'assert',
  'buffer',
  'child_process',
  'crypto',
  'events',
  'fs',
  'fs/promises',
  'http',
  'https',
  'net',
  'node:assert',
  'node:buffer',
  'node:child_process',
  'node:crypto',
  'node:events',
  'node:fs',
  'node:fs/promises',
  'node:http',
  'node:https',
  'node:net',
  'node:os',
  'node:path',
  'node:process',
  'node:stream',
  'node:tls',
  'node:url',
  'node:util',
  'node:zlib',
  'open',
  'os',
  'path',
  'process',
  'stream',
  'tls',
  'url',
  'util',
  'ws',
  'zlib',
]

export default [
  {
    ignores: [
      'dist/**',
      'node_modules/**',
    ],
  },

  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      react: reactPlugin,
      'react-hooks': reactHooksPlugin,
    },
    settings: {
      react: {
        version: 'detect',
      },
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',

      'no-restricted-imports': ['error', {
        paths: [
          {
            name: 'electron',
            message: 'WebUI must use the browser API adapter or a shim instead of Electron APIs.',
          },
          {
            name: 'electron-log',
            message: 'Use the WebUI shim or server logging path instead of importing electron-log directly.',
          },
          {
            name: 'electron-log/renderer',
            message: 'Use the WebUI shim or server logging path instead of importing electron-log directly.',
          },
          {
            name: '@sentry/electron',
            message: 'Use browser-safe Sentry wiring for WebUI instead of @sentry/electron.',
          },
          {
            name: '@sentry/electron/renderer',
            message: 'Use browser-safe Sentry wiring for WebUI instead of @sentry/electron.',
          },
          {
            name: '@mortise/shared/config/models-pi',
            message: 'Pi model/provider catalog touches the Pi SDK and must stay server-side. Use WebUI RPC instead.',
          },
          ...nodeBuiltinImports.map((name) => ({
            name,
            message: 'WebUI source must stay browser-safe. Add a Vite shim or route this through the web API adapter.',
          })),
        ],
      }],

      'no-restricted-syntax': ['error',
        {
          selector: 'ImportDeclaration[source.value=/^@mortise\\/pi-/]',
          message: 'Pi SDK (@mortise/pi-*) is bottom-layer. WebUI must talk to Mortise/Pi through server RPC.',
        },
      ],
    },
  },

  {
    files: ['src/shims/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },
]
