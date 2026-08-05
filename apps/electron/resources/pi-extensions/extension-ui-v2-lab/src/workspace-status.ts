import { defineExtensionUI, type ExtensionUIMountContext } from '@mortise/extension-ui'

export const definition = defineExtensionUI({
  mount(context: ExtensionUIMountContext) {
    const channel = context.backend.channel<{ note: string }, { note: string }>('workspace-note')
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'mortise-v2-lab-button'
    button.dataset.mortiseSemanticId = 'extension-ui-v2-lab.workspace-status'
    button.textContent = channel.getSnapshot()?.state.note ?? 'Workspace ready'
    const unsubscribe = channel.subscribe((snapshot) => { button.textContent = snapshot.state.note })
    button.onclick = () => void channel.send({ note: `Updated ${new Date().toLocaleTimeString(context.locale)}` })
    context.root.append(button)
    return () => { unsubscribe(); button.remove() }
  },
})

export const mount = definition.mount
