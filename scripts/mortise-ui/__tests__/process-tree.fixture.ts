import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const artifactsDir = process.env.MORTISE_UI_ARTIFACTS_DIR
if (!artifactsDir) throw new Error('MORTISE_UI_ARTIFACTS_DIR is required')
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  windowsHide: true,
  stdio: 'ignore',
})
writeFileSync(join(artifactsDir, 'descendant.pid'), String(child.pid), 'utf8')
setInterval(() => {}, 1000)
