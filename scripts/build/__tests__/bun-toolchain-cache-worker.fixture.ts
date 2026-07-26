import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { publishBuildBunToolchain } from '../electron-build-cache.ts'

const [buildRootArg, sourceExecutableArg, resultPathArg] = process.argv.slice(2)
if (!buildRootArg || !sourceExecutableArg || !resultPathArg) {
  throw new Error('Bun toolchain worker requires buildRoot, sourceExecutable, and resultPath')
}

const binary = publishBuildBunToolchain(resolve(buildRootArg), resolve(sourceExecutableArg))
writeFileSync(resolve(resultPathArg), JSON.stringify({ binary }), 'utf8')
