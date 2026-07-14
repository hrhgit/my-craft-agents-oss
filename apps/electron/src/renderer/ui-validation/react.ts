import * as React from 'react'
import { uiSemanticRegistry } from './semantic-registry'
import type { UiSemanticDefinition } from './types'

export function useUiSemanticNode(definition: UiSemanticDefinition | null): Record<string, string> {
  const latest = React.useRef(definition)
  latest.current = definition
  const registration = React.useRef<ReturnType<typeof uiSemanticRegistry.register> | null>(null)
  const registeredId = React.useRef<string | null>(null)

  React.useLayoutEffect(() => {
    if (!definition) return
    registration.current = uiSemanticRegistry.register({ ...definition, invoke: (...args) => latest.current?.invoke?.(...args) })
    registeredId.current = definition.id
    return () => {
      registration.current?.dispose()
      registration.current = null
      registeredId.current = null
    }
  }, [definition?.id])

  React.useLayoutEffect(() => {
    if (!definition || registeredId.current !== definition.id) return
    registration.current?.update({ ...definition, invoke: (...args) => latest.current?.invoke?.(...args) })
  })

  return definition ? { 'data-craft-semantic-id': definition.id } : {}
}

