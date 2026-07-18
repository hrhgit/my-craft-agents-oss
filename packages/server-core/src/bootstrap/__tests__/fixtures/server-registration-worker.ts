import { acquireServerLock, releaseServerLock } from '../../headless-start'

const lockFile = process.argv[2]
if (!lockFile) throw new Error('Expected lock file path')

const logger = { warn: () => {} }
acquireServerLock(logger as never, lockFile)
process.stdout.write('READY\n')

const shutdown = (): void => {
  releaseServerLock(lockFile)
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
process.stdin.setEncoding('utf8')
process.stdin.on('data', data => {
  if (data.includes('STOP')) shutdown()
})
process.stdin.resume()
setInterval(() => {}, 60_000)
