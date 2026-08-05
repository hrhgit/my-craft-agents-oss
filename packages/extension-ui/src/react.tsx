import type { ComponentType } from 'react'
import { createRoot } from 'react-dom/client'
import { defineExtensionUI, type ExtensionUIMountContext, type ExtensionUIDefinition } from './index'

export interface ReactSurfaceProps {
  context: ExtensionUIMountContext
}

export interface ReactSurfaceDefinition {
  Component: ComponentType<ReactSurfaceProps>
}

export function defineReactSurface(definition: ReactSurfaceDefinition): ExtensionUIDefinition {
  if (!definition || typeof definition.Component !== 'function') {
    throw new TypeError('defineReactSurface requires a React Component')
  }
  return defineExtensionUI({
    mount(context) {
      const root = createRoot(context.root)
      root.render(<definition.Component context={context} />)
      return () => {
        root.unmount()
      }
    },
  })
}

export type { ExtensionUIMountContext }
