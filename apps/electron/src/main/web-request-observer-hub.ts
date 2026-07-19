import type {
  OnBeforeRequestListenerDetails,
  OnCompletedListenerDetails,
  OnErrorOccurredListenerDetails,
  Session,
} from 'electron'

export interface WebRequestObservation {
  beforeRequest?(details: OnBeforeRequestListenerDetails): void
  completed?(details: OnCompletedListenerDetails): void
  errorOccurred?(details: OnErrorOccurredListenerDetails): void
}

interface HubState {
  subscribers: Set<WebRequestObservation>
}

const hubs = new WeakMap<Session, HubState>()

/**
 * Electron WebRequest is last-listener-wins rather than additive. All Mortise
 * observers use this hub so diagnostics cannot replace application observers.
 */
export function observeWebRequests(session: Session, observer: WebRequestObservation): () => void {
  let hub = hubs.get(session)
  if (!hub) {
    hub = { subscribers: new Set() }
    hubs.set(session, hub)
    const current = hub
    session.webRequest.onBeforeRequest((details, callback) => {
      notify(current, 'beforeRequest', details)
      callback({})
    })
    session.webRequest.onCompleted(details => notify(current, 'completed', details))
    session.webRequest.onErrorOccurred(details => notify(current, 'errorOccurred', details))
  }
  hub.subscribers.add(observer)
  return () => hub?.subscribers.delete(observer)
}

function notify<K extends keyof WebRequestObservation>(
  hub: HubState,
  kind: K,
  details: Parameters<NonNullable<WebRequestObservation[K]>>[0],
): void {
  for (const subscriber of hub.subscribers) {
    try {
      const listener = subscriber[kind] as ((value: typeof details) => void) | undefined
      listener?.(details)
    } catch {
      // One diagnostic observer must not disrupt the request or other observers.
    }
  }
}
