import { requestMortiseUiHost } from '../../mortise-ui/client.ts'
import { startMortiseUiRun, stopMortiseUiRun } from '../../mortise-ui/controller.ts'
import type { MortiseUiRunManifest, MortiseUiSurface } from '../../mortise-ui/protocol.ts'
import { INTERACTION_FLOWS } from './catalog.ts'
import { UI_FLOW_HOST_START_WAIT_MS } from './config.ts'
import { runInteractionFlows } from './runner.ts'

const argv = process.argv.slice(2)
function option(name: string): string | undefined {
  const index = argv.indexOf(name)
  return index < 0 ? undefined : argv[index + 1]
}

const surface = (option('--surface') ?? 'electron') as MortiseUiSurface
if (!['electron', 'webui'].includes(surface)) throw new Error('--surface must be electron or webui')
const moduleId = option('--module')
const flowId = option('--flow')
const selected = INTERACTION_FLOWS.filter(flow => (!moduleId || flow.moduleId === moduleId) && (!flowId || flow.id === flowId))
if (selected.length === 0) throw new Error('No interaction flows matched the requested filters')

let manifest: MortiseUiRunManifest | undefined
try {
  manifest = await startMortiseUiRun({
    surface,
    label: `flows-${surface}`,
    profileMode: 'fixture',
    windowMode: argv.includes('--foreground') ? 'foreground' : 'background',
    waitMs: UI_FLOW_HOST_START_WAIT_MS,
    ...(process.env.MORTISE_UI_SKIP_BUILD === '1' ? { extraEnv: { MORTISE_UI_SKIP_BUILD: '1' } } : {}),
  })
  const results = await runInteractionFlows({
    run: manifest,
    flows: selected,
    request: async <T>(run: MortiseUiRunManifest, command: string, params: Record<string, unknown> = {}) => {
      const response = await requestMortiseUiHost<T>({ ...run, command, params, timeoutMs: 60_000 })
      if (!response.ok) throw new Error(`${command}: ${response.error.code}: ${response.error.message}`)
      return command === 'ui.action'
        ? { ...(response.result as object), verificationLevel: response.verificationLevel } as T
        : response.result
    },
  })
  process.stdout.write(`${JSON.stringify({ ok: true, runId: manifest.runId, surface, flows: results }, null, 2)}\n`)
} finally {
  if (manifest && !argv.includes('--keep')) await stopMortiseUiRun(manifest.runDir)
}
