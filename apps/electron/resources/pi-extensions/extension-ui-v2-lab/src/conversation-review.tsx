import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { Bot, Highlighter, ListFilter, MessageSquare, PanelRightOpen, Pin, Search, UserRound, X } from 'lucide-react'
import { defineExtensionUI, type ExtensionUIMountContext } from '@mortise/extension-ui'

type ReviewRole = 'user' | 'assistant'
type ReviewFilter = 'all' | ReviewRole

interface ReviewTurn {
  index: number
  role: ReviewRole
  excerpt: string
  pinned: boolean
}

interface OriginalTurnState {
  classPresent: boolean
  display: string
  position: string
  role: string | null
  index: string | null
  visible: string | null
  highlighted: string | null
  pinned: string | null
}

class HostConversationBridge {
  private readonly originals = new Map<HTMLElement, OriginalTurnState>()
  private readonly pinned = new Set<number>()
  private observer?: MutationObserver
  private scheduled = false
  private signature = ''
  private filter: ReviewFilter = 'all'
  private query = ''
  private highlighted = false

  constructor(
    private readonly timeline: HTMLElement,
    private readonly onChange: (turns: ReviewTurn[]) => void,
  ) {}

  start(): void {
    this.observer = new MutationObserver(() => this.scheduleScan())
    this.observer.observe(this.timeline, { childList: true, subtree: true })
    this.scan()
  }

  configure(filter: ReviewFilter, query: string, highlighted: boolean): void {
    this.filter = filter
    this.query = query.trim().toLocaleLowerCase()
    this.highlighted = highlighted
    this.apply()
  }

  togglePinned(index: number): void {
    if (this.pinned.has(index)) this.pinned.delete(index)
    else this.pinned.add(index)
    this.apply()
  }

  focus(index: number): void {
    const target = this.turnElements()[index]
    if (!target) return
    target.scrollIntoView({ behavior: 'smooth', block: 'center' })
    target.animate(
      [{ opacity: 0.55 }, { opacity: 1 }],
      { duration: 420, easing: 'ease-out' },
    )
  }

  dispose(): void {
    this.observer?.disconnect()
    for (const [element, original] of this.originals) {
      if (!original.classPresent) element.classList.remove('mortise-v2-lab-host-turn')
      element.style.display = original.display
      element.style.position = original.position
      restoreAttribute(element, 'data-mortise-v2-lab-role', original.role)
      restoreAttribute(element, 'data-mortise-v2-lab-index', original.index)
      restoreAttribute(element, 'data-mortise-v2-lab-visible', original.visible)
      restoreAttribute(element, 'data-mortise-v2-lab-highlighted', original.highlighted)
      restoreAttribute(element, 'data-mortise-v2-lab-pinned', original.pinned)
    }
    this.originals.clear()
  }

  private scheduleScan(): void {
    if (this.scheduled) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      this.scan()
    })
  }

  private scan(): void {
    const live = new Set(this.turnElements())
    for (const [element, original] of this.originals) {
      if (live.has(element)) continue
      if (!original.classPresent) element.classList.remove('mortise-v2-lab-host-turn')
      this.originals.delete(element)
    }
    for (const element of live) {
      if (this.originals.has(element)) continue
      this.originals.set(element, {
        classPresent: element.classList.contains('mortise-v2-lab-host-turn'),
        display: element.style.display,
        position: element.style.position,
        role: element.getAttribute('data-mortise-v2-lab-role'),
        index: element.getAttribute('data-mortise-v2-lab-index'),
        visible: element.getAttribute('data-mortise-v2-lab-visible'),
        highlighted: element.getAttribute('data-mortise-v2-lab-highlighted'),
        pinned: element.getAttribute('data-mortise-v2-lab-pinned'),
      })
      element.classList.add('mortise-v2-lab-host-turn')
      if (getComputedStyle(element).position === 'static') element.style.position = 'relative'
    }
    this.apply()
  }

  private apply(): void {
    const turns = this.turnElements().map((element, index): ReviewTurn => {
      const role = element.querySelector('.justify-end') ? 'user' : 'assistant'
      const excerpt = normalizeExcerpt(element.textContent ?? '')
      const visible = (this.filter === 'all' || role === this.filter)
        && (!this.query || excerpt.toLocaleLowerCase().includes(this.query))
      const original = this.originals.get(element)
      element.style.display = visible ? original?.display ?? '' : 'none'
      element.dataset.mortiseV2LabRole = role
      element.dataset.mortiseV2LabIndex = String(index)
      element.dataset.mortiseV2LabVisible = String(visible)
      element.dataset.mortiseV2LabHighlighted = String(this.highlighted && visible)
      element.dataset.mortiseV2LabPinned = String(this.pinned.has(index))
      return { index, role, excerpt, pinned: this.pinned.has(index) }
    })
    const nextSignature = JSON.stringify(turns)
    if (nextSignature === this.signature) return
    this.signature = nextSignature
    this.onChange(turns)
  }

  private turnElements(): HTMLElement[] {
    return Array.from(this.timeline.querySelectorAll<HTMLElement>('.rounded-lg.transition-all.duration-200'))
      .filter((element) => !element.closest('[data-mortise-extension-frontend-zone]'))
  }
}

function restoreAttribute(element: HTMLElement, name: string, value: string | null): void {
  if (value === null) element.removeAttribute(name)
  else element.setAttribute(name, value)
}

function normalizeExcerpt(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim()
  return compact.length > 120 ? `${compact.slice(0, 117)}...` : compact || 'Empty message'
}

function ConversationReview({ context, timeline, portal }: {
  context: ExtensionUIMountContext
  timeline: HTMLElement
  portal: HTMLElement
}) {
  const bridgeRef = useRef<HostConversationBridge>()
  const [turns, setTurns] = useState<ReviewTurn[]>([])
  const [filter, setFilter] = useState<ReviewFilter>('all')
  const [query, setQuery] = useState('')
  const [highlighted, setHighlighted] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)

  useEffect(() => {
    const bridge = new HostConversationBridge(timeline, setTurns)
    bridgeRef.current = bridge
    bridge.start()
    return () => {
      bridge.dispose()
      bridgeRef.current = undefined
    }
  }, [timeline])

  useEffect(() => bridgeRef.current?.configure(filter, query, highlighted), [filter, highlighted, query])

  const visibleTurns = useMemo(() => turns.filter((turn) => {
    if (filter !== 'all' && turn.role !== filter) return false
    return !query.trim() || turn.excerpt.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
  }), [filter, query, turns])

  return (
    <>
      <section
        className="mortise-v2-lab-review"
        data-mortise-semantic-id="extension-v2-lab.conversation-review"
        aria-label="Extension conversation review controls"
      >
        <div className="mortise-v2-lab-review-summary">
          <MessageSquare size={15} aria-hidden="true" />
          <strong>Conversation review</strong>
          <span>{visibleTurns.length}/{turns.length}</span>
        </div>
        <label className="mortise-v2-lab-review-search">
          <Search size={14} aria-hidden="true" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter messages"
            aria-label="Filter conversation messages"
            data-mortise-semantic-id="extension-v2-lab.conversation-search"
          />
        </label>
        <div className="mortise-v2-lab-review-segments" role="group" aria-label="Message role filter">
          {(['all', 'user', 'assistant'] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
              data-mortise-semantic-id={`extension-v2-lab.conversation-filter-${value}`}
            >
              {value === 'all' ? <ListFilter size={13} /> : value === 'user' ? <UserRound size={13} /> : <Bot size={13} />}
              <span>{value === 'all' ? 'All' : value === 'user' ? 'You' : 'Agent'}</span>
            </button>
          ))}
        </div>
        <button
          type="button"
          className="mortise-v2-lab-review-icon-button"
          aria-label="Highlight visible host messages"
          title="Highlight visible host messages"
          aria-pressed={highlighted}
          onClick={() => setHighlighted((value) => !value)}
          data-mortise-semantic-id="extension-v2-lab.conversation-highlight"
        >
          <Highlighter size={15} />
        </button>
        <button
          type="button"
          className="mortise-v2-lab-review-icon-button"
          aria-label="Open conversation map"
          title="Open conversation map"
          onClick={() => setDrawerOpen(true)}
          data-mortise-semantic-id="extension-v2-lab.conversation-map-open"
        >
          <PanelRightOpen size={15} />
        </button>
      </section>
      {drawerOpen && createPortal(
        <div className="mortise-v2-lab-review-layer" role="presentation">
          <button className="mortise-v2-lab-review-backdrop" type="button" aria-label="Close conversation map" onClick={() => setDrawerOpen(false)} />
          <aside className="mortise-v2-lab-review-drawer" role="dialog" aria-modal="true" aria-label="Conversation map">
            <header>
              <div>
                <p>Direct host DOM integration</p>
                <h3>Conversation map</h3>
              </div>
              <button
                type="button"
                aria-label="Close conversation map"
                title="Close"
                onClick={() => setDrawerOpen(false)}
                data-mortise-semantic-id="extension-v2-lab.conversation-map-close"
              ><X size={16} /></button>
            </header>
            <div className="mortise-v2-lab-review-list">
              {visibleTurns.map((turn) => (
                <article key={turn.index} data-role={turn.role}>
                  <button type="button" className="mortise-v2-lab-review-jump" onClick={() => bridgeRef.current?.focus(turn.index)}>
                    {turn.role === 'user' ? <UserRound size={14} /> : <Bot size={14} />}
                    <span>{turn.excerpt}</span>
                  </button>
                  <button
                    type="button"
                    className="mortise-v2-lab-review-pin"
                    aria-label={`${turn.pinned ? 'Unpin' : 'Pin'} message ${turn.index + 1}`}
                    title={turn.pinned ? 'Unpin message' : 'Pin message'}
                    aria-pressed={turn.pinned}
                    onClick={() => bridgeRef.current?.togglePinned(turn.index)}
                  ><Pin size={13} /></button>
                </article>
              ))}
              {visibleTurns.length === 0 && <p className="mortise-v2-lab-review-empty">No host messages match this view.</p>}
            </div>
            <footer>{turns.length} host message nodes observed in session {context.route.sessionId ?? 'unknown'}.</footer>
          </aside>
        </div>,
        portal,
      )}
    </>
  )
}

export const definition = defineExtensionUI({
  mount(context: ExtensionUIMountContext) {
    const zone = context.root.closest<HTMLElement>('[data-mortise-extension-frontend-zone="conversation.timeline.before"]')
    const timeline = zone?.parentElement
    if (!timeline) throw new Error('Conversation timeline host was not found')

    context.root.className = 'mortise-v2-lab-review-root'
    context.root.lang = context.locale
    const portal = document.createElement('div')
    portal.className = 'mortise-v2-lab-review-portal'
    portal.dataset.theme = context.theme.mode
    const hostStyle = getComputedStyle(context.root)
    for (const token of ['--background', '--foreground', '--card', '--muted', '--muted-foreground', '--accent', '--border', '--primary', '--primary-foreground', '--ring']) {
      portal.style.setProperty(token, hostStyle.getPropertyValue(token))
    }
    document.body.append(portal)

    const root = createRoot(context.root)
    root.render(<ConversationReview context={context} timeline={timeline} portal={portal} />)
    return () => {
      root.unmount()
      portal.remove()
      context.root.removeAttribute('class')
      context.root.removeAttribute('lang')
    }
  },
})

export const mount = definition.mount
