import { existsSync, writeFileSync } from 'node:fs'
import { recordArtifact } from '../artifacts.ts'

const [manifestPath, runId, artifactsDir, artifactPath, startSignal, readySignal] = process.argv.slice(2)
if (!manifestPath || !runId || !artifactsDir || !artifactPath || !startSignal || !readySignal) {
  throw new Error('artifact writer fixture requires manifest, run, artifact, and barrier paths')
}

writeFileSync(artifactPath, artifactPath, 'utf8')
writeFileSync(readySignal, '', 'utf8')
while (!existsSync(startSignal)) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
}
writeFileSync(`${readySignal}.recording`, '', 'utf8')

recordArtifact({
  manifestPath,
  runId,
  artifactsDir,
  artifact: { kind: 'other', path: artifactPath, description: 'concurrent fixture' },
})
