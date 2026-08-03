import { DEFAULT_MORTISE_UI_START_WAIT_MS } from '../../mortise-ui/controller.ts'

// A source-development Electron run may need to prepare dependencies and build Pi before the host can publish its endpoint.
export const UI_FLOW_HOST_START_WAIT_MS = DEFAULT_MORTISE_UI_START_WAIT_MS
