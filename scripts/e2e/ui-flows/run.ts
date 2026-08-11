import { runInteractionFlowBatch } from '../../mortise-ui/flow-batch.ts'
import type { MortiseUiSurface } from '../../mortise-ui/protocol.ts'

const argv = process.argv.slice(2)
function option(name: string): string | undefined {
  const index = argv.indexOf(name)
  return index < 0 ? undefined : argv[index + 1]
}

const surface = (option('--surface') ?? 'electron') as MortiseUiSurface
if (!['electron', 'webui'].includes(surface)) throw new Error('--surface must be electron or webui')
const batch = await runInteractionFlowBatch({
  surface,
  moduleIds: option('--module') ? [option('--module')!] : [],
  flowIds: option('--flow') ? [option('--flow')!] : [],
  windowMode: argv.includes('--foreground') ? 'foreground' : surface === 'electron' ? 'background' : 'foreground',
  skipBuild: process.env.MORTISE_UI_SKIP_BUILD === '1',
  keep: argv.includes('--keep'),
})
process.stdout.write(`${JSON.stringify({ ok: true, runId: batch.run.runId, surface, flows: batch.flows, lifecycle: batch.lifecycle }, null, 2)}\n`)
