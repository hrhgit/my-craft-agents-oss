import { describe, expect, it } from 'bun:test'
import { Linter } from 'eslint'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const rule = require('../no-raw-pi-file-io.cjs')

function runRule(code: string, filename = 'packages/shared/src/agent/unsafe.ts') {
  const linter = new Linter({ configType: 'eslintrc' })
  linter.defineRule('mortise-shared/no-raw-pi-file-io', rule)

  return linter.verify(
    code,
    {
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
      rules: {
        'mortise-shared/no-raw-pi-file-io': 'error',
      },
    },
    { filename },
  )
}

describe('no-raw-pi-file-io', () => {
  it('flags static imports of sensitive Pi path constants', () => {
    const messages = runRule("import { PI_SETTINGS_FILE } from '@mortise/shared/config/paths'")

    expect(messages).toHaveLength(1)
    expect(messages[0]?.message).toContain('PI_SETTINGS_FILE')
  })

  it('flags require() loading the path constants module', () => {
    const messages = runRule("const { PI_SETTINGS_FILE } = require('@mortise/shared/config/paths')")

    expect(messages).toHaveLength(1)
    expect(messages[0]?.message).toContain('require()')
  })

  it('flags namespace imports of the path constants module', () => {
    const messages = runRule("import * as paths from '@mortise/shared/config/paths'\nconsole.log(paths.PI_AUTH_FILE)")

    expect(messages).toHaveLength(1)
    expect(messages[0]?.message).toContain('namespace import')
  })

  it('flags default imports of the path constants module', () => {
    const messages = runRule("import paths from '@mortise/shared/config/paths'\nconsole.log(paths.PI_AUTH_FILE)")

    expect(messages).toHaveLength(1)
    expect(messages[0]?.message).toContain('default import')
  })

  it('flags re-exporting sensitive Pi path constants', () => {
    const messages = runRule("export { PI_AUTH_FILE } from '@mortise/shared/config/paths'")

    expect(messages).toHaveLength(1)
    expect(messages[0]?.message).toContain('PI_AUTH_FILE')
  })

  it('flags export-all re-exports of the path constants module', () => {
    const messages = runRule("export * from '@mortise/shared/config/paths'")

    expect(messages).toHaveLength(1)
    expect(messages[0]?.message).toContain('re-export')
  })

  it('flags dynamic import() loading the path constants module', () => {
    const messages = runRule("async function load() { return import('@mortise/shared/config/paths') }")

    expect(messages).toHaveLength(1)
    expect(messages[0]?.message).toContain('dynamic import()')
  })

  it('allows static imports of non-sensitive path constants', () => {
    const messages = runRule("import { CONFIG_DIR } from '@mortise/shared/config/paths'")

    expect(messages).toHaveLength(0)
  })

  it('allows dynamic imports of unrelated paths helpers', () => {
    const messages = runRule("async function load() { return import('../utils/paths.ts') }")

    expect(messages).toHaveLength(0)
  })

  it('allows sanctioned seam files to import sensitive Pi path constants', () => {
    const messages = runRule(
      "import { PI_SESSIONS_DIR } from '../config/paths.ts'",
      'packages/shared/src/sessions/storage.ts',
    )

    expect(messages).toHaveLength(0)
  })

  it('allows pi-global-config only the PI_AGENT_DIR watcher seam', () => {
    const messages = runRule(
      "import { PI_AGENT_DIR } from './paths'",
      'packages/shared/src/config/pi-global-config.ts',
    )

    expect(messages).toHaveLength(0)
  })

  it('blocks pi-global-config from reintroducing raw settings file access', () => {
    const messages = runRule(
      "import { PI_SETTINGS_FILE } from './paths'",
      'packages/shared/src/config/pi-global-config.ts',
    )

    expect(messages).toHaveLength(1)
    expect(messages[0]?.message).toContain('PI_SETTINGS_FILE')
  })

  it('flags raw global Pi skills paths outside the migration seam', () => {
    const messages = runRule("import { PI_SKILLS_DIR } from '@mortise/shared/config/paths'")

    expect(messages).toHaveLength(1)
    expect(messages[0]?.message).toContain('PI_SKILLS_DIR')
  })

  it('flags private Pi hook env strings', () => {
    const messages = runRule("const hook = 'PI_HOST_HOOKS_MODULE'")

    expect(messages).toHaveLength(1)
    expect(messages[0]?.message).toContain('PI_HOST_HOOKS_MODULE')
  })
})
