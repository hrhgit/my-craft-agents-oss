export const BROWSER_CREATE_SEMANTIC_ID = 'workspace.browser.create'

export type BrowserWorkbenchSemanticControl =
  | 'select'
  | 'show-window'
  | 'destroy'
  | 'list'
  | 'back'
  | 'forward'
  | 'reload'
  | 'address'
  | 'viewport'

export function browserWorkbenchSemanticId(
  control: BrowserWorkbenchSemanticControl,
  instanceId: string,
): string {
  return `workspace.browser.${control}.${encodeURIComponent(instanceId)}`
}
