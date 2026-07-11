import type { BrowserPaneFns, BrowserLifecycleActionResult } from '@craft-agent/shared/agent'
import type { BrowserPaneManager } from './browser-pane-manager'

export function createBrowserCapabilityAdapter(
  bpm: BrowserPaneManager,
  sessionId: string,
  workspaceId: string,
): BrowserPaneFns {
  const instance = async (show = false) => bpm.createForSessionAsync(sessionId, { show, workspaceId })
  const ownedWindows = async () => (await bpm.listInstancesAsync()).filter(window =>
    window.boundSessionId === sessionId || window.ownerSessionId === sessionId,
  )
  const target = async (requested?: string) => {
    const windows = await ownedWindows()
    const found = requested ? windows.find(window => window.id === requested) : windows[0]
    if (!found) throw new Error(requested ? `Browser window "${requested}" is not owned by this session.` : 'No browser window is owned by this session. Use "open" first.')
    return found
  }
  const lifecycle = async (action: 'release' | 'close' | 'hide', requested?: string): Promise<BrowserLifecycleActionResult> => {
    if (requested === 'all') {
      const windows = await ownedWindows()
      for (const window of windows) {
        if (action === 'release') bpm.clearAgentControlForInstance(window.id, sessionId)
        else if (action === 'close') bpm.destroyInstance(window.id)
        else bpm.hide(window.id)
      }
      return { action: action === 'release' ? 'released' : action === 'close' ? 'closed' : 'hidden', requestedInstanceId: requested, affectedIds: windows.map(window => window.id) }
    }
    const window = await target(requested)
    if (action === 'release') bpm.clearAgentControlForInstance(window.id, sessionId)
    else if (action === 'close') bpm.destroyInstance(window.id)
    else bpm.hide(window.id)
    return { action: action === 'release' ? 'released' : action === 'close' ? 'closed' : 'hidden', requestedInstanceId: requested, resolvedInstanceId: window.id, affectedIds: [window.id] }
  }
  return {
    openPanel: async options => ({ instanceId: options?.background ? await instance(false) : await bpm.focusBoundForSessionAsync(sessionId, { workspaceId }) }),
    navigate: async url => bpm.navigate(await instance(), url),
    snapshot: async () => bpm.getAccessibilitySnapshot(await instance()),
    click: async (ref, options) => bpm.clickElement(await instance(), ref, options),
    clickAt: async (x, y) => bpm.clickAtCoordinates(await instance(), x, y),
    drag: async (x1, y1, x2, y2) => bpm.drag(await instance(), x1, y1, x2, y2),
    fill: async (ref, value) => bpm.fillElement(await instance(), ref, value),
    type: async text => bpm.typeText(await instance(), text),
    select: async (ref, value) => bpm.selectOption(await instance(), ref, value),
    setClipboard: async text => bpm.setClipboard(await instance(), text),
    getClipboard: async () => bpm.getClipboard(await instance()),
    screenshot: async args => bpm.screenshot(await instance(), args),
    screenshotRegion: async args => bpm.screenshotRegion(await instance(), args),
    getConsoleLogs: async args => bpm.getConsoleLogs(await instance(), args),
    windowResize: async args => bpm.windowResize(await instance(), args.width, args.height),
    getNetworkLogs: async args => bpm.getNetworkLogs(await instance(), args),
    waitFor: async args => bpm.waitFor(await instance(), args),
    sendKey: async args => bpm.sendKey(await instance(), args),
    getDownloads: async args => bpm.getDownloads(await instance(), args),
    upload: async (ref, paths) => { await bpm.uploadFile(await instance(), ref, paths) },
    scroll: async (direction, amount) => bpm.scroll(await instance(), direction, amount),
    goBack: async () => bpm.goBack(await instance()),
    goForward: async () => bpm.goForward(await instance()),
    evaluate: async expression => bpm.evaluate(await instance(), expression),
    focusWindow: async requested => {
      const window = await target(requested)
      bpm.bindSession(window.id, sessionId, { workspaceId })
      bpm.focus(window.id)
      const current = await bpm.getInstanceAsync(window.id)
      return { instanceId: window.id, title: current?.title ?? window.title, url: current?.currentUrl ?? window.url }
    },
    releaseControl: requested => lifecycle('release', requested),
    closeWindow: requested => lifecycle('close', requested),
    hideWindow: requested => lifecycle('hide', requested),
    listWindows: async () => bpm.listInstancesAsync(),
    detectChallenge: async () => bpm.detectSecurityChallenge(await instance()),
  }
}
