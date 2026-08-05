import { defineExtensionUI } from '@mortise/extension-ui'

export const definition = defineExtensionUI({
  mount() {
    throw new Error('Intentional V2 lab mount failure')
  },
})

export const mount = definition.mount
