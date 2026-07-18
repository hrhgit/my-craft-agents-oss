import { existsSync } from 'node:fs'
import { updateRunManifest } from '../controller.ts'

const [runDir, barrier, key] = process.argv.slice(2)
if (!runDir || !barrier || !key) throw new Error('run manifest writer requires runDir, barrier, and key')
while (!existsSync(barrier)) await Bun.sleep(5)
updateRunManifest(runDir, { [key]: key } as never)
