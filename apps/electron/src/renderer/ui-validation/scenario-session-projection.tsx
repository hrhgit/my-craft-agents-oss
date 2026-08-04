import * as React from 'react'
import { useSetAtom } from 'jotai'
import type { Session } from '../../shared/types'
import type { PiProjectionSnapshotV1 } from '@mortise/shared/protocol'
import { initializeSessionsAtom, replaceLoadedSessionAtom } from '@/atoms/sessions'
import { applyPiProjectionSnapshot, createPiProjectionState, piProjectionAtomFamily } from '@/atoms/pi-projection'

export interface ScenarioSessionProjection {
  sessions: readonly Session[]
  loadedSessionId?: string
  piProjection?: PiProjectionSnapshotV1
}

/**
 * Controlled adapter into the production session projection boundary.
 * Scenario definitions provide typed sessions; they never receive a Jotai store
 * or atom setter and therefore cannot construct impossible renderer state.
 */
export function ScenarioSessionProjectionBoundary({ projection }: { projection: ScenarioSessionProjection }) {
  const initializeSessions = useSetAtom(initializeSessionsAtom)
  const replaceLoadedSession = useSetAtom(replaceLoadedSessionAtom)
  const projectionSessionId = projection.piProjection?.sessionId ?? '__ui-validation-empty-projection__'
  const setPiProjection = useSetAtom(piProjectionAtomFamily(projectionSessionId))

  React.useLayoutEffect(() => {
    const sessions = [...projection.sessions]
    initializeSessions(sessions)
    const loaded = projection.loadedSessionId
      ? sessions.find(session => session.id === projection.loadedSessionId)
      : undefined
    if (loaded) replaceLoadedSession(loaded)
  }, [initializeSessions, projection, replaceLoadedSession])

  React.useLayoutEffect(() => {
    if (!projection.piProjection) return
    setPiProjection(current => applyPiProjectionSnapshot(current, projection.piProjection!))
    return () => setPiProjection(createPiProjectionState(projectionSessionId))
  }, [projection.piProjection, projectionSessionId, setPiProjection])

  React.useLayoutEffect(() => () => initializeSessions([]), [initializeSessions])

  return null
}
