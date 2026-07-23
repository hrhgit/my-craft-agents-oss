import { SessionValidationController } from '../session-validation-backend'

const fallback = {}
const backend = new SessionValidationController().backendFactory({
  coreConfig: {
    workspace: { id: 'ws-a', rootPath: 'C:/workspace' },
    session: { mortiseId: process.argv[2] ?? 'session' },
  },
  provisional: true,
  createDefaultBackend: () => fallback as never,
})

process.stdout.write(backend === fallback ? 'fallback\n' : 'claimed\n')
