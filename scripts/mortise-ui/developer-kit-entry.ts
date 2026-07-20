#!/usr/bin/env bun
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'

const kitRoot = resolve(dirname(process.execPath), '..')
process.env.PI_PACKAGE_DIR ??= join(kitRoot, 'dev-host', 'resources', 'pi-runtime')
process.env.MORTISE_UI_RUN_ROOT ??= process.platform === 'win32'
  ? join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Mortise', 'Developer Kit', 'runs')
  : join(homedir(), '.mortise', 'developer-kit', 'runs')

const { main } = await import('./cli.ts')
process.exit(await main(process.argv))
