import { SessionValidationController } from '../session-validation-backend'

const fallback = {}
const backend = new SessionValidationController().backendFactory({
  coreConfig: {
    workspace: {
      schemaVersion: 2,
      id: 'ws-a',
      revision: 0,
      name: 'Workspace A',
      nameSource: 'custom',
      slug: 'workspace-a',
      primaryLocationId: 'primary',
      locations: [{
        id: 'primary',
        name: 'Primary',
        rootName: 'workspace',
        endpoint: { kind: 'local', rootPath: 'C:/workspace' },
      }],
      createdAt: 0,
    },
    session: { mortiseId: process.argv[2] ?? 'session' },
  },
  provisional: true,
  createDefaultBackend: () => fallback as never,
})

process.stdout.write(backend === fallback ? 'fallback\n' : 'claimed\n')
