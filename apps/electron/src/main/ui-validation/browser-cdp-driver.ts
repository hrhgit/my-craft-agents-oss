import type { WebContents } from 'electron'
import { UI_VALIDATION_DEFAULT_TIMEOUT_MS } from '@craft-agent/shared/ui-validation'
import { mainLog } from '../logger'
import {
  BrowserCDP,
  type ElementGeometry,
  type SemanticInteractionCheck,
  type UiBusinessSemanticSnapshot,
} from '../browser-cdp'

/** Source-only CDP capabilities used by the authenticated UI Test Host. */
export class UiValidationBrowserCDP extends BrowserCDP {
  private readonly childTargetRefs = new Map<string, {
    backendNodeId: number
    sessionId: string
    frameId: string
    ownerBackendNodeId?: number
  }>()
  private readonly childTargetSessions = new Map<string, string>()
  private readonly childTargetStableRefs = new Map<string, string>()
  private dragQueue: Promise<void> = Promise.resolve()

  constructor(
    webContents: WebContents,
    private readonly dragInterceptTimeoutMs = 1_000,
  ) {
    super(webContents)
  }

  override async getAccessibilitySnapshot() {
    this.childTargetRefs.clear()
    const snapshot = await super.getAccessibilitySnapshot()
    await this.appendChildFrameAccessibility(snapshot)
    try {
      const dom = await this.send('DOMSnapshot.captureSnapshot', {
        computedStyles: ['display', 'visibility', 'opacity', 'pointer-events'],
        includePaintOrder: true,
        includeDOMRects: true,
      })
      const document = dom?.documents?.[0]
      if (!document?.nodes || !document?.layout || !Array.isArray(dom?.strings)) return snapshot
      const strings = dom.strings as string[]
      const backendIds = document.nodes.backendNodeId as number[]
      const parentIndexes = document.nodes.parentIndex as number[]
      const nodeNames = document.nodes.nodeName as number[]
      const attributes = document.nodes.attributes as number[][]
      const layoutNodeIndexes = document.layout.nodeIndex as number[]
      const bounds = document.layout.bounds as Array<[number, number, number, number]>
      const nodeIndexByBackend = new Map<number, number>()
      const boundsByBackend = new Map<number, { x: number; y: number; width: number; height: number }>()
      for (let index = 0; index < backendIds.length; index += 1) nodeIndexByBackend.set(backendIds[index]!, index)
      for (let index = 0; index < layoutNodeIndexes.length; index += 1) {
        const nodeIndex = layoutNodeIndexes[index]!
        const backendNodeId = backendIds[nodeIndex]
        const box = bounds[index]
        if (backendNodeId === undefined || !box || box.length < 4) continue
        boundsByBackend.set(backendNodeId, { x: box[0], y: box[1], width: box[2], height: box[3] })
      }
      const enriched = snapshot.nodes.map(node => {
        if (this.childTargetRefs.has(node.ref)) return node
        const backendNodeId = this.backendNodeIdForRef(node.ref)
        const box = backendNodeId === undefined ? undefined : boundsByBackend.get(backendNodeId)
        return box ? { ...node, bounds: box } : node
      })
      const candidates = enriched.filter(node => node.bounds && node.bounds.width > 0 && node.bounds.height > 0).slice(0, 200)
      await mapWithConcurrency(candidates, 16, async (node) => {
        const backendNodeId = this.backendNodeIdForRef(node.ref)
        if (backendNodeId === undefined || !node.bounds) return
        const x = Math.max(0, Math.round(node.bounds.x + node.bounds.width / 2))
        const y = Math.max(0, Math.round(node.bounds.y + node.bounds.height / 2))
        const top = await this.send('DOM.getNodeForLocation', {
          x, y, includeUserAgentShadowDOM: true, ignorePointerEventsNone: true,
        }).catch(() => undefined)
        const topBackendNodeId = typeof top?.backendNodeId === 'number' ? top.backendNodeId : undefined
        if (topBackendNodeId === undefined) return
        node.hit = isSameOrDescendant(topBackendNodeId, backendNodeId, nodeIndexByBackend, parentIndexes, backendIds)
        if (!node.hit) node.obscuredBy = describeSnapshotNode(topBackendNodeId, nodeIndexByBackend, nodeNames, attributes, strings)
      })
      return { ...snapshot, nodes: enriched }
    } catch {
      return snapshot
    }
  }

  private async appendChildFrameAccessibility(snapshot: Awaited<ReturnType<BrowserCDP['getAccessibilitySnapshot']>>): Promise<void> {
    const frameTree = await this.send('Page.getFrameTree').catch(() => undefined)
    const root = frameTree?.frameTree
    if (!root) return
    const frameIds: string[] = []
    const visit = (node: { frame?: { id?: unknown }; childFrames?: unknown[] }, isRoot = false) => {
      const id = typeof node.frame?.id === 'string' ? node.frame.id : undefined
      if (!isRoot && id) frameIds.push(id)
      for (const child of Array.isArray(node.childFrames) ? node.childFrames : []) visit(child as typeof node)
    }
    visit(root, true)
    const domDocument = await this.send('DOM.getDocument', { depth: -1, pierce: true }).catch(() => undefined)
    const visitDom = (node: Record<string, unknown> | undefined) => {
      if (!node) return
      const frameId = typeof node.frameId === 'string' ? node.frameId : undefined
      if (frameId && frameId !== root.frame?.id && !frameIds.includes(frameId)) frameIds.push(frameId)
      for (const key of ['children', 'shadowRoots', 'distributedNodes']) {
        for (const child of Array.isArray(node[key]) ? node[key] as Record<string, unknown>[] : []) visitDom(child)
      }
      if (node.contentDocument && typeof node.contentDocument === 'object') visitDom(node.contentDocument as Record<string, unknown>)
    }
    visitDom(domDocument?.root)
    const seen = new Set(snapshot.nodes.map(node => this.backendNodeIdForRef(node.ref)).filter((id): id is number => id !== undefined))
    for (const frameId of frameIds.slice(0, 32)) {
      let sessionId: string | undefined
      let rootError: unknown
      let tree = await this.send('Accessibility.getFullAXTree', { frameId }).catch((error) => {
        rootError = error
        return undefined
      })
      if (!hasAccessibilityNodes(tree)) {
        sessionId = await this.sessionForChildTarget(frameId)
        if (sessionId) tree = await this.send('Accessibility.getFullAXTree', {}, sessionId).catch(async () => {
          this.childTargetSessions.delete(frameId)
          const replacement = await this.sessionForChildTarget(frameId)
          sessionId = replacement
          return replacement ? await this.send('Accessibility.getFullAXTree', {}, replacement).catch(() => undefined) : undefined
        })
      }
      if (!hasAccessibilityNodes(tree)) {
        mainLog.warn('[ui-validation] Child frame accessibility tree unavailable', {
          frameId,
          rootError: rootError instanceof Error ? rootError.message : String(rootError ?? ''),
          attached: Boolean(sessionId),
        })
      }
      const owner = sessionId
        ? await this.send('DOM.getFrameOwner', { frameId }).catch(() => undefined)
        : undefined
      const ownerBackendNodeId = typeof owner?.backendNodeId === 'number' ? owner.backendNodeId : undefined
      for (const node of Array.isArray(tree?.nodes) ? tree.nodes : []) {
        if (snapshot.nodes.length >= 1_000) return
        const backendDOMNodeId = typeof node?.backendDOMNodeId === 'number' ? node.backendDOMNodeId : undefined
        if (backendDOMNodeId === undefined || (!sessionId && seen.has(backendDOMNodeId))) continue
        const role = String(node?.role?.value ?? '').trim().toLowerCase()
        const name = String(node?.name?.value ?? '').trim()
        const rawValue = node?.value?.value
        if ((!role || role === 'generic' || role === 'none') && !name && rawValue === undefined) continue
        if (!name && rawValue === undefined && !['textbox', 'checkbox', 'radio', 'combobox', 'button', 'link'].includes(role)) continue
        let focused = false
        let checked = false
        let disabled = false
        for (const property of Array.isArray(node?.properties) ? node.properties : []) {
          if (property?.name === 'focused' && property.value?.value === true) focused = true
          if (property?.name === 'checked' && property.value?.value !== 'false') checked = property.value?.value === true || property.value?.value === 'true'
          if (property?.name === 'disabled' && property.value?.value === true) disabled = true
        }
        const childStableKey = `${frameId}:${backendDOMNodeId}`
        const ref = sessionId
          ? (this.childTargetStableRefs.get(childStableKey) ?? this.allocateRef())
          : this.allocateRef(backendDOMNodeId)
        if (sessionId) {
          this.childTargetStableRefs.set(childStableKey, ref)
          this.childTargetRefs.set(ref, { backendNodeId: backendDOMNodeId, sessionId, frameId, ...(ownerBackendNodeId === undefined ? {} : { ownerBackendNodeId }) })
        } else {
          this.refMap.set(ref, backendDOMNodeId)
        }
        this.refDetails.set(ref, { role, name })
        snapshot.nodes.push({
          ref,
          role,
          name,
          ...(rawValue === undefined || rawValue === '' ? {} : { value: String(rawValue) }),
          ...(focused ? { focused: true } : {}),
          ...(checked ? { checked: true } : {}),
          ...(disabled ? { disabled: true } : {}),
        })
        if (!sessionId) seen.add(backendDOMNodeId)
      }
    }
  }

  private async sessionForChildTarget(frameId: string): Promise<string | undefined> {
    const cached = this.childTargetSessions.get(frameId)
    if (cached) return cached
    await this.send('Target.setDiscoverTargets', { discover: true }).catch(() => undefined)
    const targets = await this.send('Target.getTargets').catch(() => undefined)
    const targetInfos = Array.isArray(targets?.targetInfos) ? targets.targetInfos : []
    const target = targetInfos
      .find((candidate: { targetId?: unknown; type?: unknown }) => candidate.targetId === frameId && candidate.type === 'iframe')
    if (!target?.targetId) {
      mainLog.warn('[ui-validation] No child target matched frame', {
        frameId,
        targets: targetInfos.slice(0, 32).map((candidate: { targetId?: unknown; type?: unknown }) => ({
          targetId: String(candidate.targetId ?? ''),
          type: String(candidate.type ?? ''),
        })),
      })
      return undefined
    }
    const attached = await this.send('Target.attachToTarget', { targetId: target.targetId, flatten: true }).catch(() => undefined)
    const sessionId = typeof attached?.sessionId === 'string' ? attached.sessionId : undefined
    if (sessionId) this.childTargetSessions.set(frameId, sessionId)
    return sessionId
  }

  protected override targetForRef(ref: string): { backendNodeId: number; sessionId?: string } | undefined {
    const child = this.childTargetRefs.get(ref)
    return child ? { backendNodeId: child.backendNodeId, sessionId: child.sessionId } : super.targetForRef(ref)
  }

  async focusElement(ref: string): Promise<void> {
    const target = this.targetForRef(ref)
    if (!target) throw new Error(`Element ${ref} not found. Run ui.snapshot first.`)
    await this.send('DOM.focus', { backendNodeId: target.backendNodeId }, target.sessionId)
  }

  override async clickElement(ref: string): Promise<ElementGeometry> {
    const child = this.childTargetRefs.get(ref)
    if (!child) return await super.clickElement(ref)
    const { object } = await this.send('DOM.resolveNode', { backendNodeId: child.backendNodeId }, child.sessionId)
    await this.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: 'function() { this.scrollIntoViewIfNeeded(); }',
    }, child.sessionId)
    const childBox = await this.send('DOM.getBoxModel', { backendNodeId: child.backendNodeId }, child.sessionId)
    const content = childBox?.model?.content as number[] | undefined
    if (!content || content.length < 8) throw new Error(`Child-frame element ${ref} has no box model.`)
    const x = (content[0]! + content[2]! + content[4]! + content[6]!) / 4
    const y = (content[1]! + content[3]! + content[5]! + content[7]!) / 4
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, child.sessionId)
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, child.sessionId)
    return await this.getElementGeometry(ref)
  }

  override drag(x1: number, y1: number, x2: number, y2: number): Promise<void> {
    const operation = this.dragQueue.then(() => this.dragWithCdp(x1, y1, x2, y2))
    this.dragQueue = operation.catch(() => undefined)
    return operation
  }

  private async dragWithCdp(x1: number, y1: number, x2: number, y2: number): Promise<void> {
    type DragData = Record<string, unknown>

    let interceptedDragData: DragData | undefined
    let resolveInterceptedDrag!: (data: DragData) => void
    const interceptedDrag = new Promise<DragData>((resolve) => { resolveInterceptedDrag = resolve })
    const onDebuggerMessage = (_event: unknown, method: string, params: { data?: unknown }) => {
      if (method !== 'Input.dragIntercepted' || !params.data || typeof params.data !== 'object' || interceptedDragData) return
      interceptedDragData = params.data as DragData
      resolveInterceptedDrag(interceptedDragData)
    }

    const distance = Math.hypot(x2 - x1, y2 - y1)
    const steps = Math.max(5, Math.min(20, Math.round(distance / 20)))
    const points = Array.from({ length: steps }, (_, index) => {
      const progress = (index + 1) / steps
      return {
        x: Math.round(x1 + (x2 - x1) * progress),
        y: Math.round(y1 + (y2 - y1) * progress),
      }
    })

    let lastPoint = { x: Math.round(x1), y: Math.round(y1) }
    let dragEntered = false
    let htmlDragExpected = false
    let dropped = false
    let failure: unknown
    this.webContents.debugger.on('message', onDebuggerMessage)

    try {
      // Interception keeps HTML5 drags out of Electron's synchronous native
      // drag loop, while raw CDP mouse events still drive pointer-based DnD.
      await this.send('Input.setInterceptDrags', { enabled: true })
      await this.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: lastPoint.x,
        y: lastPoint.y,
        button: 'none',
        buttons: 0,
      })
      await this.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: lastPoint.x,
        y: lastPoint.y,
        button: 'left',
        buttons: 1,
        clickCount: 1,
      })

      for (const point of points) {
        lastPoint = point
        if (dragEntered && interceptedDragData) {
          await this.send('Input.dispatchDragEvent', {
            type: 'dragOver',
            x: point.x,
            y: point.y,
            data: interceptedDragData,
          })
          continue
        }

        await this.installHtmlDragProbe()
        await this.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: point.x,
          y: point.y,
          button: 'left',
          buttons: 1,
        })
        const htmlDragStarted = await this.readHtmlDragProbe()
        if (!htmlDragStarted) {
          if (interceptedDragData) {
            htmlDragExpected = true
            throw new Error('CDP intercepted a drag whose renderer dragstart was cancelled.')
          }
          continue
        }

        htmlDragExpected = true
        if (!interceptedDragData) {
          interceptedDragData = await withTimeout(
            interceptedDrag,
            this.dragInterceptTimeoutMs,
            `Input.dragIntercepted was not received within ${this.dragInterceptTimeoutMs}ms.`,
          )
        }
        if (interceptedDragData) {
          await this.send('Input.dispatchDragEvent', {
            type: 'dragEnter',
            x: point.x,
            y: point.y,
            data: interceptedDragData,
          })
          dragEntered = true
        }
      }

      if (interceptedDragData) {
        if (!dragEntered) {
          await this.send('Input.dispatchDragEvent', {
            type: 'dragEnter',
            x: lastPoint.x,
            y: lastPoint.y,
            data: interceptedDragData,
          })
        }
        await this.send('Input.dispatchDragEvent', {
          type: 'dragOver',
          x: Math.round(x2),
          y: Math.round(y2),
          data: interceptedDragData,
        })
        await this.send('Input.dispatchDragEvent', {
          type: 'drop',
          x: Math.round(x2),
          y: Math.round(y2),
          data: interceptedDragData,
        })
        dropped = true
      }
    } catch (error) {
      failure = error
    } finally {
      const recordCleanupFailure = (error: unknown) => {
        if (failure === undefined) failure = error
      }
      await this.cleanupHtmlDragProbe().catch(recordCleanupFailure)
      if ((htmlDragExpected || interceptedDragData) && !dropped) {
        await this.send('Input.dispatchDragEvent', {
          type: 'dragCancel',
          x: lastPoint.x,
          y: lastPoint.y,
          data: { items: [], dragOperationsMask: 65535 },
        }).catch(recordCleanupFailure)
      }
      await this.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: lastPoint.x,
        y: lastPoint.y,
        button: 'left',
        buttons: 0,
        clickCount: 1,
      }).catch(recordCleanupFailure)
      await this.send('Input.setInterceptDrags', { enabled: false }).catch(recordCleanupFailure)
      this.webContents.debugger.removeListener('message', onDebuggerMessage)
    }

    if (failure !== undefined) throw failure
  }

  private async installHtmlDragProbe(): Promise<void> {
    await this.send('Runtime.evaluate', {
      expression: `(() => {
        const key = '__craftUiValidationDragProbe';
        globalThis[key]?.cleanup?.();
        let dragEvent = null;
        let didStartDrag = Promise.resolve(false);
        const onDragStart = event => { dragEvent = event; };
        const onMouseMove = () => {
          didStartDrag = new Promise(resolve => {
            addEventListener('dragstart', onDragStart, { once: true, capture: true });
            setTimeout(() => resolve(Boolean(dragEvent && !dragEvent.defaultPrevented)), 0);
          });
        };
        const cleanup = () => {
          removeEventListener('mousemove', onMouseMove, { capture: true });
          removeEventListener('dragstart', onDragStart, { capture: true });
          if (globalThis[key]?.cleanup === cleanup) delete globalThis[key];
        };
        addEventListener('mousemove', onMouseMove, { once: true, capture: true });
        globalThis[key] = {
          read: async () => {
            const result = await didStartDrag;
            cleanup();
            return result;
          },
          cleanup,
        };
      })()`,
      returnByValue: true,
    })
  }

  private async readHtmlDragProbe(): Promise<boolean> {
    const result = await this.send('Runtime.evaluate', {
      expression: `(() => {
        const probe = globalThis.__craftUiValidationDragProbe;
        return probe ? probe.read() : false;
      })()`,
      awaitPromise: true,
      returnByValue: true,
    })
    return result?.result?.value === true
  }

  private async cleanupHtmlDragProbe(): Promise<void> {
    await this.send('Runtime.evaluate', {
      expression: `(() => {
        globalThis.__craftUiValidationDragProbe?.cleanup?.();
      })()`,
      returnByValue: true,
    })
  }

  override async getElementGeometry(ref: string): Promise<ElementGeometry> {
    const child = this.childTargetRefs.get(ref)
    if (!child) return await super.getElementGeometry(ref)
    const childBox = await this.send('DOM.getBoxModel', { backendNodeId: child.backendNodeId }, child.sessionId)
    const childContent = childBox?.model?.content as number[] | undefined
    if (!childContent || childContent.length < 8) throw new Error(`Child-frame element ${ref} has no box model.`)
    const rawXs = [childContent[0]!, childContent[2]!, childContent[4]!, childContent[6]!]
    const rawYs = [childContent[1]!, childContent[3]!, childContent[5]!, childContent[7]!]
    let xs = rawXs
    let ys = rawYs
    if (child.ownerBackendNodeId !== undefined) {
      const ownerBox = await this.send('DOM.getBoxModel', { backendNodeId: child.ownerBackendNodeId }).catch(() => undefined)
      const ownerContent = ownerBox?.model?.content as number[] | undefined
      if (ownerContent && ownerContent.length >= 8) {
        const offsetX = Math.min(ownerContent[0]!, ownerContent[2]!, ownerContent[4]!, ownerContent[6]!)
        const offsetY = Math.min(ownerContent[1]!, ownerContent[3]!, ownerContent[5]!, ownerContent[7]!)
        const offsetXs = rawXs.map(value => value + offsetX)
        const offsetYs = rawYs.map(value => value + offsetY)
        const hitsOwner = async (candidateXs: number[], candidateYs: number[]) => {
          const hit = await this.send('DOM.getNodeForLocation', {
            x: Math.round(candidateXs.reduce((sum, value) => sum + value, 0) / 4),
            y: Math.round(candidateYs.reduce((sum, value) => sum + value, 0) / 4),
            includeUserAgentShadowDOM: true,
            ignorePointerEventsNone: true,
          }).catch(() => undefined)
          return hit?.backendNodeId === child.ownerBackendNodeId || hit?.frameId === child.frameId
        }
        const rawHit = await hitsOwner(rawXs, rawYs)
        const offsetHit = await hitsOwner(offsetXs, offsetYs)
        if (!rawHit && offsetHit) {
          xs = offsetXs
          ys = offsetYs
        }
        mainLog.info('[ui-validation] Resolved child-frame interaction geometry', {
          frameId: child.frameId,
          rawHit,
          offsetHit,
          strategy: !rawHit && offsetHit ? 'parent-offset' : 'protocol-absolute',
        })
      }
    }
    const details = this.refDetails.get(ref)
    return {
      ref,
      role: details?.role,
      name: details?.name,
      box: { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) },
      clickPoint: { x: xs.reduce((sum, value) => sum + value, 0) / 4, y: ys.reduce((sum, value) => sum + value, 0) / 4 },
    }
  }

  async getUiBusinessSemanticSnapshot(): Promise<UiBusinessSemanticSnapshot | null> {
    const result = await this.send('Runtime.evaluate', {
      expression: `(() => {
        const bridge = globalThis.__craftUiValidation;
        if (!bridge || typeof bridge.snapshot !== 'function') return null;
        const snapshot = bridge.snapshot({ maxNodes: 1000, maxStringLength: 2048 });
        snapshot.nodes = snapshot.nodes.map(node => {
          const matches = Array.from(document.querySelectorAll(node.domSelector));
          if (matches.length !== 1) return node;
          const element = matches[0];
          const rect = element.getBoundingClientRect();
          const x = Math.max(0, Math.min(innerWidth - 1, rect.left + rect.width / 2));
          const y = Math.max(0, Math.min(innerHeight - 1, rect.top + rect.height / 2));
          const top = document.elementFromPoint(x, y);
          const hit = !!top && (top === element || element.contains(top));
          const focused = document.activeElement === element || (!!document.activeElement && element.contains(document.activeElement));
          return { ...node, state: { ...node.state, ...(focused ? { focused: true } : {}) },
            bounds: { x: rect.left, y: rect.top, width: rect.width, height: rect.height }, hit,
            ...(hit || !top ? {} : { obscuredBy: top.tagName.toLowerCase() + (top.id ? '#' + top.id : '') }) };
        });
        return snapshot;
      })()`,
      returnByValue: true,
    })
    return result?.result?.value ?? null
  }

  async waitForUiBusinessSemanticSnapshot(
    predicate: (snapshot: UiBusinessSemanticSnapshot | null) => boolean,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<UiBusinessSemanticSnapshot | null> {
    const current = await this.getUiBusinessSemanticSnapshot()
    if (predicate(current)) return current
    const timeoutMs = Math.max(1, options.timeoutMs ?? UI_VALIDATION_DEFAULT_TIMEOUT_MS)
    await this.send('Runtime.addBinding', { name: '__craftUiSemanticChanged' }).catch(() => undefined)
    await this.send('Runtime.evaluate', {
      expression: `(() => {
        if (globalThis.__craftUiSemanticBindingInstalled) return;
        globalThis.__craftUiSemanticBindingInstalled = true;
        addEventListener('craft:ui-validation:semantic-change', event => {
          globalThis.__craftUiSemanticChanged(JSON.stringify(event.detail || {}));
        });
      })()`,
    })
    return await new Promise<UiBusinessSemanticSnapshot | null>((resolve, reject) => {
      let reading = false
      const cleanup = () => {
        clearTimeout(timeout)
        this.webContents.debugger.removeListener('message', onMessage)
        options.signal?.removeEventListener('abort', onAbort)
      }
      const onAbort = () => { cleanup(); reject(new Error('Semantic snapshot wait aborted.')) }
      const onMessage = (_event: unknown, method: string, params: { name?: string }) => {
        if (method !== 'Runtime.bindingCalled' || params.name !== '__craftUiSemanticChanged' || reading) return
        reading = true
        void this.getUiBusinessSemanticSnapshot().then(snapshot => {
          if (predicate(snapshot)) { cleanup(); resolve(snapshot) }
        }).catch(error => { cleanup(); reject(error) }).finally(() => { reading = false })
      }
      const timeout = setTimeout(() => { cleanup(); reject(new Error(`Business semantic condition was not met within ${timeoutMs}ms.`)) }, timeoutMs)
      this.webContents.debugger.on('message', onMessage)
      if (options.signal?.aborted) onAbort()
      else options.signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  async invokeUiBusinessSemanticAction(request: { id: string; action: string; value?: string }): Promise<{ beforeRevision: number; afterRevision: number }> {
    const payload = JSON.stringify(request)
    const result = await this.send('Runtime.evaluate', {
      expression: `(() => {
        const bridge = globalThis.__craftUiValidation;
        if (!bridge || typeof bridge.action !== 'function') throw new Error('UI semantic bridge is unavailable');
        return bridge.action(${payload});
      })()`,
      awaitPromise: true,
      returnByValue: true,
    })
    if (result?.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Semantic action failed')
    return result?.result?.value
  }

  async inspectSemanticSelector(selector: string): Promise<SemanticInteractionCheck> {
    const result = await this.send('Runtime.evaluate', {
      expression: `(() => {
        const selector = ${JSON.stringify(selector)};
        const matches = Array.from(document.querySelectorAll(selector));
        if (matches.length !== 1) return { selector, count: matches.length, visible: false, focused: false, hit: false };
        const element = matches[0];
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        const visible = style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0
          && style.pointerEvents !== 'none' && rect.width > 0 && rect.height > 0
          && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
        const x = Math.max(0, Math.min(innerWidth - 1, rect.left + rect.width / 2));
        const y = Math.max(0, Math.min(innerHeight - 1, rect.top + rect.height / 2));
        const top = visible ? document.elementFromPoint(x, y) : null;
        const hit = !!top && (top === element || element.contains(top));
        const active = document.activeElement;
        return { selector, count: 1, visible,
          focused: active === element || (!!active && element.contains(active)), hit,
          ...(hit || !top ? {} : { obscuredBy: top.tagName.toLowerCase() + (top.id ? '#' + top.id : '') }),
          bounds: { x: rect.left, y: rect.top, width: rect.width, height: rect.height } };
      })()`,
      returnByValue: true,
    })
    return result?.result?.value
  }

  async resolveSemanticSelectorRef(selector: string): Promise<string> {
    const { root } = await this.send('DOM.getDocument', { depth: 0 })
    const queried = await this.send('DOM.querySelector', { nodeId: root.nodeId, selector })
    if (!queried?.nodeId) throw new Error(`Semantic selector no longer resolves: ${selector}`)
    const described = await this.send('DOM.describeNode', { nodeId: queried.nodeId })
    const backendNodeId = described?.node?.backendNodeId
    if (!backendNodeId) throw new Error(`Semantic selector has no backend node: ${selector}`)
    return this.allocateRef(backendNodeId)
  }
}

async function mapWithConcurrency<T>(items: T[], limit: number, visit: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor++
      await visit(items[index]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error(message)), timeoutMs) }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

function hasAccessibilityNodes(tree: unknown): boolean {
  const nodes = (tree as { nodes?: unknown[] } | undefined)?.nodes
  return Array.isArray(nodes) && nodes.some(node => typeof (node as { backendDOMNodeId?: unknown })?.backendDOMNodeId === 'number')
}

function isSameOrDescendant(
  candidateBackendId: number,
  targetBackendId: number,
  nodeIndexByBackend: Map<number, number>,
  parentIndexes: number[],
  backendIds: number[],
): boolean {
  let index = nodeIndexByBackend.get(candidateBackendId)
  while (index !== undefined && index >= 0) {
    if (backendIds[index] === targetBackendId) return true
    index = parentIndexes[index]
  }
  return false
}

function describeSnapshotNode(
  backendId: number,
  nodeIndexByBackend: Map<number, number>,
  nodeNames: number[],
  attributes: number[][],
  strings: string[],
): string {
  const index = nodeIndexByBackend.get(backendId)
  if (index === undefined) return 'unknown'
  const tag = strings[nodeNames[index]!] ?.toLocaleLowerCase() || 'unknown'
  const rawAttributes = attributes[index] ?? []
  let id = ''
  for (let offset = 0; offset + 1 < rawAttributes.length; offset += 2) {
    if (strings[rawAttributes[offset]!] === 'id') {
      id = strings[rawAttributes[offset + 1]!] ?? ''
      break
    }
  }
  return `${tag}${id ? `#${id.slice(0, 100)}` : ''}`
}
