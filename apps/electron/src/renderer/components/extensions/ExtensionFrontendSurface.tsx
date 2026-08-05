import * as React from 'react'
import type { ExtensionFrontendDescriptorV2 } from '@mortise/shared/protocol'
import { ExtensionFrontendHost, type ExtensionFrontendRuntimeContext } from './extension-frontend-runtime'

export interface ExtensionFrontendSurfaceProps {
  descriptor: ExtensionFrontendDescriptorV2
  runtime: ExtensionFrontendRuntimeContext
  className?: string
  children?: React.ReactNode
}

export function ExtensionFrontendSurface({ descriptor, runtime, className, children }: ExtensionFrontendSurfaceProps) {
  const parentRef = React.useRef<HTMLDivElement>(null)
  const hostRef = React.useRef<ExtensionFrontendHost>()
  const [error, setError] = React.useState<Error | null>(null)
  const [mounted, setMounted] = React.useState(false)
  const [hotRevision, setHotRevision] = React.useState(0)

  React.useEffect(() => {
    const reload = (event: Event) => {
      const detail = (event as CustomEvent<{ extensionId?: string; frontendId?: string }>).detail
      if (detail?.extensionId === descriptor.extensionId && detail.frontendId === descriptor.frontendId) {
        setHotRevision((revision) => revision + 1)
      }
    }
    window.addEventListener('mortise:extension-ui-reload', reload)
    return () => window.removeEventListener('mortise:extension-ui-reload', reload)
  }, [descriptor.extensionId, descriptor.frontendId])

  React.useEffect(() => {
    const parent = parentRef.current
    if (!parent) return
    const host = hostRef.current ?? new ExtensionFrontendHost()
    hostRef.current = host
    let active = true
    setError(null)
    setMounted(false)
    void host.mount({ ...descriptor, revision: descriptor.revision + hotRevision }, parent, runtime).then(() => {
      if (active) setMounted(true)
    }).catch((reason) => {
      if (active) setError(reason instanceof Error ? reason : new Error(String(reason)))
    })
    return () => {
      active = false
      void host.dispose()
    }
  }, [descriptor, hotRevision, runtime])

  return (
    <div ref={parentRef} className={[descriptor.mode === 'overlay' ? 'relative' : '', className ?? ''].filter(Boolean).join(' ')} data-mortise-extension-surface={descriptor.surface}>
      {descriptor.mode === 'overlay' && children}
      {!mounted && descriptor.mode === 'replace' && children}
      {error && descriptor.mode === 'append' && children}
      {error && <span role="status" data-mortise-extension-error="true" hidden>{error.message}</span>}
    </div>
  )
}
