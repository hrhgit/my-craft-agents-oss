#!/usr/bin/env bun
import { dirname, join, resolve } from 'node:path'

const kitRoot = resolve(dirname(process.execPath), '..')
process.env.PI_PACKAGE_DIR ??= join(kitRoot, 'dev-host', 'resources', 'pi-runtime')

const { main } = await import('./cli.ts')
process.exit(await main(process.argv))
