import { resolve } from 'node:path'
import { updateRunManifest } from '../controller.ts'

const runDir = process.env.MORTISE_UI_RUN_DIR
if (!runDir) throw new Error('MORTISE_UI_RUN_DIR is required')
updateRunManifest(resolve(runDir), { buildError: 'source changed during build' })
process.exit(9)
