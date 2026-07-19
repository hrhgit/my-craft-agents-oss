/**
 * ESLint Rule: no-raw-pi-file-io
 *
 * Mortise is a GUI shell over Pi. Pi owns ~/.pi/agent storage. Host/shared code
 * must not casually read/write Pi's raw files by importing path constants like
 * PI_SETTINGS_FILE or PI_SESSIONS_DIR. Use Pi's public APIs (SettingsManager,
 * AuthStorage, SessionManager, RpcClient) or one of the documented seam helpers.
 *
 * This rule intentionally focuses on imports of the sensitive path constants:
 * those constants are the common footgun that lets code bypass Pi's typed APIs
 * without importing @mortise/pi-* (which the red-line import rule would
 * catch). Approved seam files are allowlisted below and documented in
 * docs/architecture/red-line.md.
 */

const path = require('node:path')

const SENSITIVE_PI_PATH_EXPORTS = new Set([
  'PI_AGENT_DIR',
  'PI_MODELS_FILE',
  'PI_SETTINGS_FILE',
  'PI_AUTH_FILE',
  'PI_SKILLS_DIR',
  'PI_SESSIONS_DIR',
])

const PRIVATE_PI_ENV_STRINGS = new Set([
  'PI_HOST_HOOKS_MODULE',
  'PI_FETCH_INTERCEPTOR_MODULE',
  'AWS_BEDROCK_FORCE_HTTP1',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
])

const ALLOW_ALL_SENSITIVE_EXPORTS = Symbol('allow-all-sensitive-pi-paths')

// Repo-relative endings, normalized to forward slashes. Keep this per-export so
// a seam cannot quietly grow from a watcher/helper into raw settings/auth I/O.
const ALLOWED_PATH_EXPORTS_BY_FILE_ENDING = new Map([
  ['src/config/paths.ts', ALLOW_ALL_SENSITIVE_EXPORTS],
  ['src/config/pi-global-config.ts', new Set(['PI_AGENT_DIR'])],
  ['src/sessions/storage.ts', new Set(['PI_SESSIONS_DIR'])],
  ['src/workspaces/storage.ts', new Set(['PI_SESSIONS_DIR'])],
])

function normalizeFilename(filename) {
  return filename.split(path.sep).join('/')
}

function isTestFile(filename) {
  return /(?:^|\/)(__tests__|tests)\//.test(filename) || /\.(?:test|spec)\.tsx?$/.test(filename)
}

function allowedPathExportsForFile(filename) {
  const normalized = normalizeFilename(filename)
  for (const [ending, allowedExports] of ALLOWED_PATH_EXPORTS_BY_FILE_ENDING) {
    if (normalized.endsWith(ending)) return allowedExports
  }
  return null
}

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow raw imports of Pi storage path constants outside sanctioned seams. Use Pi public APIs or documented helpers.',
      category: 'Best Practices',
      recommended: true,
    },
    messages: {
      noRawPiPath:
        'Do not import {{name}} outside the sanctioned Pi storage seams. Pi owns ~/.pi/agent storage; use Pi public APIs (SettingsManager/AuthStorage/SessionManager/RpcClient) or add a documented red-line allowlist entry.',
      noRawPiPathModule:
        'Do not load Pi storage path constants via {{kind}} outside the sanctioned Pi storage seams. Pi owns ~/.pi/agent storage; use Pi public APIs or documented helpers.',
      noPrivatePiEnv:
        'Do not reference Pi private env/hook string "{{name}}" from Mortise shared code. Expose a typed Pi API/RPC capability instead.',
    },
    schema: [],
  },

  create(context) {
    const filename = context.filename || context.getFilename()
    const normalizedFilename = normalizeFilename(filename)
    if (isTestFile(normalizedFilename)) return {}
    const allowedPathExports = allowedPathExportsForFile(normalizedFilename)

    function isPathConstantsModule(source) {
      const normalizedSource = source.split('\\').join('/')
      if (/(^|\/)config\/paths(?:\.ts)?$/.test(normalizedSource)) return true
      return (
        /(?:^|\/)src\/config\//.test(normalizedFilename) &&
        (normalizedSource === './paths' || normalizedSource === './paths.ts')
      )
    }

    function isStringLiteral(node) {
      return node && node.type === 'Literal' && typeof node.value === 'string'
    }

    function reportModuleLoad(node, kind) {
      context.report({
        node,
        messageId: 'noRawPiPathModule',
        data: { kind },
      })
    }

    function reportNamedSpecifier(specifier, importedName) {
      if (!SENSITIVE_PI_PATH_EXPORTS.has(importedName)) return
      if (
        allowedPathExports === ALLOW_ALL_SENSITIVE_EXPORTS ||
        allowedPathExports?.has(importedName)
      ) {
        return
      }
      context.report({
        node: specifier,
        messageId: 'noRawPiPath',
        data: { name: importedName },
      })
    }

    function reportWholeModuleLoad(node, kind) {
      if (allowedPathExports === ALLOW_ALL_SENSITIVE_EXPORTS) return
      reportModuleLoad(node, kind)
    }

    function reportPrivatePiEnv(node, value) {
      if (!PRIVATE_PI_ENV_STRINGS.has(value)) return
      context.report({
        node,
        messageId: 'noPrivatePiEnv',
        data: { name: value },
      })
    }

    return {
      Literal(node) {
        if (typeof node.value === 'string') {
          reportPrivatePiEnv(node, node.value)
        }
      },

      ImportDeclaration(node) {
        const source = node.source && node.source.value
        if (typeof source !== 'string') return
        if (!isPathConstantsModule(source)) return

        for (const specifier of node.specifiers || []) {
          if (specifier.type === 'ImportSpecifier') {
            const importedName = specifier.imported && specifier.imported.name
            reportNamedSpecifier(specifier, importedName)
          } else if (specifier.type === 'ImportNamespaceSpecifier') {
            reportWholeModuleLoad(specifier, 'namespace import')
          } else if (specifier.type === 'ImportDefaultSpecifier') {
            reportWholeModuleLoad(specifier, 'default import')
          }
        }
      },

      ExportNamedDeclaration(node) {
        const source = node.source && node.source.value
        if (typeof source !== 'string') return
        if (!isPathConstantsModule(source)) return

        for (const specifier of node.specifiers || []) {
          const exportedName = specifier.local && specifier.local.name
          reportNamedSpecifier(specifier, exportedName)
        }
      },

      ExportAllDeclaration(node) {
        const source = node.source && node.source.value
        if (typeof source !== 'string') return
        if (!isPathConstantsModule(source)) return
        reportWholeModuleLoad(node, 're-export')
      },

      ImportExpression(node) {
        if (!isStringLiteral(node.source)) return
        if (!isPathConstantsModule(node.source.value)) return

        reportWholeModuleLoad(node, 'dynamic import()')
      },

      CallExpression(node) {
        if (
          node.callee.type !== 'Identifier' ||
          node.callee.name !== 'require' ||
          node.arguments.length === 0
        ) {
          return
        }

        const source = node.arguments[0]
        if (!isStringLiteral(source)) return
        if (!isPathConstantsModule(source.value)) return

        reportWholeModuleLoad(node, 'require()')
      },
    }
  },
}
