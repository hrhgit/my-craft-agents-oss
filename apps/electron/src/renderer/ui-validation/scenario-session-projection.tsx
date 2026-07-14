import * as React from 'react'
import { useSetAtom } from 'jotai'
import type { Session } from '../../shared/types'
import { initializeSessionsAtom, replaceLoadedSessionAtom } from '@/atoms/sessions'

export interface ScenarioSessionProjection {
  sessions: readonly Session[]
  loadedSessionId?: string
}

/**
 * Controlled adapter into the production session projection boundary.
 * Scenario definitions provide typed sessions; they never receive a Jotai store
 * or atom setter and therefore cannot construct impossible renderer state.
 */
export function ScenarioSessionProjectionBoundary({ projection }: { projection: ScenarioSessionProjection }) {
  const initializeSessions = useSetAtom(initializeSessionsAtom)
  const replaceLoadedSession = useSetAtom(replaceLoadedSessionAtom)

  React.useLayoutEffect(() => {
    const sessions = [...projection.sessions]
    initializeSessions(sessions)
    const loaded = projection.loadedSessionId
      ? sessions.find(session => session.id === projection.loadedSessionId)
      : undefined
    if (loaded) replaceLoadedSession(loaded)
  }, [initializeSessions, projection, replaceLoadedSession])

  React.useLayoutEffect(() => () => initializeSessions([]), [initializeSessions])

  return null
}
