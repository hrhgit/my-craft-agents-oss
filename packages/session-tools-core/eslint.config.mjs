import tsParser from '@typescript-eslint/parser'
import noRawPiFileIo from '../shared/eslint-rules/no-raw-pi-file-io.cjs'

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
      },
    },
    plugins: {
      'mortise-shared': {
        rules: {
          'no-raw-pi-file-io': noRawPiFileIo,
        },
      },
    },
    rules: {
      'mortise-shared/no-raw-pi-file-io': 'error',
    },
  },
]
