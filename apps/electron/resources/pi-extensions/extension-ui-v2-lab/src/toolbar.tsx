import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { defineExtensionUI, registerExtensionUIHotReload } from '@mortise/extension-ui'

registerExtensionUIHotReload((import.meta as ImportMeta & { hot?: Parameters<typeof registerExtensionUIHotReload>[0] }).hot, {
  extensionId: 'extension-ui-v2-lab',
  frontendId: 'toolbar',
})

function Toolbar({ context }: { context: Parameters<NonNullable<ReturnType<typeof defineExtensionUI>['mount']>>[0] }) {
  const channel = context.backend.channel<{ count: number }, { action: string }>('session-counter')
  const [count, setCount] = useState(channel.getSnapshot()?.state.count ?? 0)
  useEffect(() => channel.subscribe((snapshot) => setCount(snapshot.state.count)), [channel])
  return <button type="button" className="mortise-v2-lab-button" data-mortise-semantic-id="extension-ui-v2-lab.toolbar" onClick={() => void channel.send({ action: 'increment' })} aria-label={`Session counter: ${count}`}>Lab {count}</button>
}

export function mount(context: Parameters<NonNullable<ReturnType<typeof defineExtensionUI>['mount']>>[0]) {
  const root = createRoot(context.root)
  root.render(<Toolbar context={context} />)
  const marker = document.createElement('span')
  marker.dataset.mortiseV2LabDom = 'toolbar'
  context.root.parentElement?.appendChild(marker)
  return () => { marker.remove(); root.unmount() }
}
