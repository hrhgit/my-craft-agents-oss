/**
 * ESLint Rule: no-raw-pi-file-io
 *
 * Craft is a GUI shell over Pi. Pi owns ~/.pi/agent storage. Host/shared code
 * must not casually read/write Pi's raw files by importing path constants like
 * PI_SETTINGS_FILE or PI_SESSIONS_DIR. Use Pi's public APIs (SettingsManager,
 * AuthStorage, SessionManager, RpcClient) or one of the documented seam helpers.
 *
 * This rule intentionally focuses on imports of the sensitive path constants:
 * those constants are the common footgun that lets code bypass Pi's typed APIs
 * without importing @earendil-works/pi-* (which the red-line import rule would
 * catch). Approved seam files are allowlisted below and documented in
 * docs/architecture/red-line.md.
 */

const path = require('node:path')

const SENSITIVE_PI_PATH_EXPORTS = new Set([
  'PI_AGENT_DIR',
  'PI_MODELS_FILE',
  'PI_SETTINGS_FILE',
  'PI_AUTH_FILE',
  'PI_SESSIONS_DIR',
])

// Repo-relative endings, normalized to forward slashes.
const ALLOWED_FILE_ENDINGS = [
  // Source of truth for the path constants themselves.
  'src/config/paths.ts',

  // Sanctioned seams documented in red-line.md.
  'src/config/pi-global-config.ts',
  'src/credentials/backends/secure-storage.ts',
  'src/sessions/storage.ts',
  'src/sessions/tree-jsonl.ts',
  'src/config/unified-migration.ts',

  // Read-only projections over Pi session buckets; see red-line.md.
  'src/workspaces/storage.ts',
  'src/pi/pi-session-store.ts',
]

function normalizeFilename(filename) {
  return filename.split(path.sep).join('/')
}

function isTestFile(filename) {
  return /(?:^|\/)(__tests__|tests)\//.test(filename) || /\.(?:test|spec)\.tsx?$/.test(filename)
}

function isAllowedFile(filename) {
  const normalized = normalizeFilename(filename)
  if (isTestFile(normalized)) return true
  return ALLOWED_FILE_ENDINGS.some((ending) => normalized.endsWith(ending))
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
    },
    schema: [],
  },

  create(context) {
    const filename = context.filename || context.getFilename()
    if (isAllowedFile(filename)) return {}

    const normalizedFilename = normalizeFilename(filename)

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
      if (SENSITIVE_PI_PATH_EXPORTS.has(importedName)) {
        context.report({
          node: specifier,
          messageId: 'noRawPiPath',
          data: { name: importedName },
        })
      }
    }

    return {
      ImportDeclaration(node) {
        const source = node.source && node.source.value
        if (typeof source !== 'string') return
        if (!isPathConstantsModule(source)) return

        for (const specifier of node.specifiers || []) {
          if (specifier.type === 'ImportSpecifier') {
            const importedName = specifier.imported && specifier.imported.name
            reportNamedSpecifier(specifier, importedName)
          } else if (specifier.type === 'ImportNamespaceSpecifier') {
            reportModuleLoad(specifier, 'namespace import')
          } else if (specifier.type === 'ImportDefaultSpecifier') {
            reportModuleLoad(specifier, 'default import')
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
        reportModuleLoad(node, 're-export')
      },

      ImportExpression(node) {
        if (!isStringLiteral(node.source)) return
        if (!isPathConstantsModule(node.source.value)) return

        reportModuleLoad(node, 'dynamic import()')
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

        reportModuleLoad(node, 'require()')
      },
    }
  },
}
