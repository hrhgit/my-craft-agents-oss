import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { motion } from 'motion/react'
import { Check, CornerDownRight, GripHorizontal, MessageCircleMore, RefreshCcw, Trash2, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  Island,
  IslandContentView,
  IslandFollowUpContentView,
  useIslandNavigation,
  type IslandActiveViewSize,
  type IslandMorphTarget,
  type IslandNavigation,
} from '@mortise/ui'
import type { ComponentEntry } from './types'

type IslandViewId = 'compact' | 'confirm-follow-up' | 'confirm-ask-inline'
type AskScope = 'selection' | 'full'

// ============================================================================
// Demo implementation using generic Island + IslandContentView
// ============================================================================

interface IslandOptionsProps {
  view: IslandViewId
  navigation: IslandNavigation<IslandViewId>
  activeViewSize: IslandActiveViewSize | null
  useMorph: boolean
  onToggleMorph: () => void
  angleDeg: number
  distancePx: number
  startScale: number
  onAngleChange: (value: number) => void
  onDistanceChange: (value: number) => void
  onStartScaleChange: (value: number) => void
  isIslandMounted: boolean
  onClearIsland: () => void
}

function IslandOptions({
  view,
  navigation,
  activeViewSize,
  useMorph,
  onToggleMorph,
  angleDeg,
  distancePx,
  startScale,
  onAngleChange,
  onDistanceChange,
  onStartScaleChange,
  isIslandMounted,
  onClearIsland,
}: IslandOptionsProps) {
  const { t } = useTranslation()
  return (
    <motion.div className="flex w-[280px] shrink-0 flex-col gap-3 rounded-2xl border border-border/50 bg-background/90 p-3 shadow-middle backdrop-blur-sm">
      <div className="flex items-center justify-between">
        <span className="size-4 text-foreground/50">
          <GripHorizontal className="size-4" />
        </span>
        <button
          type="button"
          onClick={() => navigation.reset('compact')}
          className="group inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-foreground/60 hover:bg-foreground/5 hover:text-foreground"
        >
          {t('playground.containerTransitions.reset')}
          <RefreshCcw className="size-3.5 transition-transform duration-300 group-hover:rotate-90" />
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => navigation.replace('compact')}
          className={cn('rounded-lg px-2.5 py-1.5 text-xs', view === 'compact' ? 'bg-foreground/10' : 'bg-foreground/5 hover:bg-foreground/10')}
        >
          {t('playground.containerTransitions.compact')}
        </button>
        <button
          type="button"
          onClick={() => navigation.replace('confirm-follow-up')}
          className={cn('rounded-lg px-2.5 py-1.5 text-xs', view === 'confirm-follow-up' ? 'bg-foreground/10' : 'bg-foreground/5 hover:bg-foreground/10')}
        >
          {t('playground.containerTransitions.followUp')}
        </button>
        <button
          type="button"
          onClick={() => navigation.replace('confirm-ask-inline')}
          className={cn('rounded-lg px-2.5 py-1.5 text-xs col-span-2', view === 'confirm-ask-inline' ? 'bg-foreground/10' : 'bg-foreground/5 hover:bg-foreground/10')}
        >
          {t('playground.containerTransitions.askInline')}
        </button>
      </div>

      <button
        type="button"
        onClick={onToggleMorph}
        className={cn(
          'rounded-lg px-2.5 py-1.5 text-xs text-left',
          useMorph ? 'bg-foreground/10' : 'bg-foreground/5 hover:bg-foreground/10'
        )}
      >
        {t('playground.containerTransitions.morph', {
          state: useMorph
            ? t('playground.containerTransitions.on')
            : t('playground.containerTransitions.off'),
        })}
      </button>

      <div className="rounded-xl border border-border/40 bg-foreground/3 p-2.5 text-[11px] text-foreground/70 space-y-2">
        <div className="flex items-center justify-between">
          <span>{t('playground.containerTransitions.angle')}</span>
          <span className="tabular-nums">{Math.round(angleDeg)}°</span>
        </div>
        <input
          type="range"
          min={0}
          max={360}
          step={1}
          value={angleDeg}
          onChange={(event) => onAngleChange(Number(event.target.value))}
          className="w-full"
        />

        <div className="flex items-center justify-between pt-1">
          <span>{t('playground.containerTransitions.distance')}</span>
          <span className="tabular-nums">{Math.round(distancePx)} px</span>
        </div>
        <input
          type="range"
          min={0}
          max={240}
          step={1}
          value={distancePx}
          onChange={(event) => onDistanceChange(Number(event.target.value))}
          className="w-full"
        />

        <div className="flex items-center justify-between pt-1">
          <span>{t('playground.containerTransitions.startScale')}</span>
          <span className="tabular-nums">{startScale.toFixed(2)}x</span>
        </div>
        <input
          type="range"
          min={0.06}
          max={1}
          step={0.01}
          value={startScale}
          onChange={(event) => onStartScaleChange(Number(event.target.value))}
          className="w-full"
        />
      </div>

      <button
        type="button"
        onClick={onClearIsland}
        disabled={!isIslandMounted}
        className={cn(
          'inline-flex items-center justify-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs',
          isIslandMounted
            ? 'bg-foreground/5 hover:bg-foreground/10 text-foreground/75'
            : 'bg-foreground/3 text-foreground/35 cursor-not-allowed'
        )}
      >
        <Trash2 className="size-3.5" />
        {t('playground.containerTransitions.clearIsland')}
      </button>

      <div className="rounded-xl border border-border/40 bg-foreground/3 p-2 text-[11px] text-foreground/65">
        {t('playground.containerTransitions.backstack', { stack: navigation.stack.join(' → ') })}
      </div>

      <div className="rounded-xl border border-border/40 bg-foreground/3 p-2 text-[11px] text-foreground/65">
        {t('playground.containerTransitions.activeViewSize')}{' '}
        {activeViewSize
          ? `${activeViewSize.width}px × ${activeViewSize.height}px`
          : t('playground.containerTransitions.measuring')}
      </div>
    </motion.div>
  )
}

interface ToolbarToConfirmTransitionDemoProps {
  initialView?: IslandViewId
}

function ToolbarToConfirmTransitionDemo({ initialView = 'compact' }: ToolbarToConfirmTransitionDemoProps) {
  const { t } = useTranslation()
  const navigation = useIslandNavigation<IslandViewId>(initialView)
  const [note, setNote] = React.useState('')
  const [askScope, setAskScope] = React.useState<AskScope>('selection')
  const [lastConfirmed, setLastConfirmed] = React.useState<string | null>(null)
  const [activeViewSize, setActiveViewSize] = React.useState<IslandActiveViewSize | null>(null)
  const [useMorph, setUseMorph] = React.useState(false)
  const [angleDeg, setAngleDeg] = React.useState(220)
  const [distancePx, setDistancePx] = React.useState(60)
  const [startScale, setStartScale] = React.useState(0.25)
  const [isIslandMounted, setIsIslandMounted] = React.useState(true)
  const [isIslandVisible, setIsIslandVisible] = React.useState(true)
  const [islandInstanceKey, setIslandInstanceKey] = React.useState(0)

  const morphFrom = React.useMemo<IslandMorphTarget | null>(() => {
    if (!useMorph) return null

    return {
      x: 340,
      y: 540,
      width: 24,
      height: 24,
    }
  }, [useMorph])

  const onConfirm = (intent: 'Follow up' | 'Ask inline', value: string) => {
    const payload = value.trim()
    const label = intent === 'Follow up'
      ? t('playground.containerTransitions.followUp')
      : t('playground.containerTransitions.askInline')
    setLastConfirmed(payload ? `${label}: ${payload}` : label)
    setNote('')
    navigation.reset('compact')
  }

  const dismissIsland = React.useCallback(() => {
    if (!isIslandMounted) return
    setIsIslandVisible(false)
    setActiveViewSize(null)
  }, [isIslandMounted])

  const clearIsland = React.useCallback(() => {
    dismissIsland()
  }, [dismissIsland])

  const restoreIsland = React.useCallback(() => {
    setIslandInstanceKey((prev) => prev + 1)
    setIsIslandMounted(true)
    setIsIslandVisible(true)
    navigation.reset('compact')
    setNote('')
  }, [navigation])

  return (
    <div className="w-full max-w-[920px] p-6 space-y-4">
      <div>
        <h2 className="text-lg font-semibold">{t('playground.containerTransitions.title')}</h2>
        <p className="text-sm text-foreground/70 mt-1">
          {t('playground.containerTransitions.description')}
        </p>
      </div>

      <div className="flex items-start gap-4">
        <div className="relative flex-1 rounded-[12px] border border-border/50 bg-foreground/2 p-5 min-h-[320px] overflow-hidden">
          <div className="absolute left-1/2 bottom-5 -translate-x-1/2">
            {isIslandMounted ? (
              <Island
                key={islandInstanceKey}
                activeViewId={navigation.current}
                onActiveViewSizeChange={setActiveViewSize}
                isVisible={isIslandVisible}
                onExitComplete={() => setIsIslandMounted(false)}
                dismissOnPointerDownOutside
                onRequestClose={dismissIsland}
                transitionConfig={{
                  entryAngleDeg: angleDeg,
                  entryDistancePx: distancePx,
                  entryStartScale: startScale,
                }}
              >
                <IslandContentView id="compact" anchorX="center" anchorY="bottom" morphFrom={morphFrom}>
                  <div className="p-1 flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => navigation.push('confirm-follow-up')}
                      className={cn(
                        'h-[30px] px-2.5 rounded-[6px] text-[13px] font-medium inline-flex items-center gap-1.5',
                        'text-foreground/85 hover:text-foreground hover:bg-foreground/5',
                        'focus:outline-none focus-visible:ring-1 focus-visible:ring-ring'
                      )}
                    >
                      <CornerDownRight className="h-3.5 w-3.5" />
                      <span>{t('playground.containerTransitions.followUp')}</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => navigation.push('confirm-ask-inline')}
                      className={cn(
                        'h-[30px] px-2.5 rounded-[6px] text-[13px] font-medium inline-flex items-center gap-1.5',
                        'text-foreground/85 hover:text-foreground hover:bg-foreground/5',
                        'focus:outline-none focus-visible:ring-1 focus-visible:ring-ring'
                      )}
                    >
                      <MessageCircleMore className="h-3.5 w-3.5" />
                      <span>{t('playground.containerTransitions.askInline')}</span>
                    </button>
                  </div>
                </IslandContentView>

                <IslandFollowUpContentView
                  id="confirm-follow-up"
                  value={note}
                  morphFrom={morphFrom}
                  onValueChange={setNote}
                  onCancel={navigation.pop}
                  onSubmit={(value) => onConfirm('Follow up', value)}
                  maxInputHeight={400}
                />

                <IslandContentView id="confirm-ask-inline" anchorX="center" anchorY="top" morphFrom={morphFrom}>
                  <div className="w-[500px] p-3 space-y-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-sm font-medium">{t('playground.containerTransitions.askInline')}</div>
                        <div className="text-xs text-foreground/60 mt-0.5">{t('playground.containerTransitions.askInlineDesc')}</div>
                      </div>
                      <button
                        type="button"
                        onClick={navigation.pop}
                        className="h-7 w-7 inline-flex items-center justify-center rounded-[6px] text-foreground/70 hover:bg-foreground/5 hover:text-foreground"
                        aria-label={t('playground.containerTransitions.backAria')}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>

                    <div className="rounded-[8px] border border-border/70 bg-foreground/3 px-3 py-2">
                      <div className="text-[11px] uppercase tracking-wide text-foreground/50 mb-1">{t('playground.containerTransitions.selectionPreview')}</div>
                      <div className="text-xs text-foreground/75 line-clamp-2">
                        “...requestAnimationFrame + intersectsNode checks with diff-style add/remove...”
                      </div>
                    </div>

                    <div className="flex items-center gap-1 rounded-[8px] bg-foreground/3 p-1 w-fit">
                      <button
                        type="button"
                        onClick={() => setAskScope('selection')}
                        className={cn(
                          'h-7 px-2.5 rounded-[6px] text-xs font-medium transition-colors',
                          askScope === 'selection' ? 'bg-background text-foreground shadow-minimal' : 'text-foreground/65 hover:bg-foreground/5'
                        )}
                      >
                        {t('playground.containerTransitions.selectionOnly')}
                      </button>
                      <button
                        type="button"
                        onClick={() => setAskScope('full')}
                        className={cn(
                          'h-7 px-2.5 rounded-[6px] text-xs font-medium transition-colors',
                          askScope === 'full' ? 'bg-background text-foreground shadow-minimal' : 'text-foreground/65 hover:bg-foreground/5'
                        )}
                      >
                        {t('playground.containerTransitions.fullResponse')}
                      </button>
                    </div>

                    <div className="rounded-[8px] border border-border/70 px-3 py-2 bg-background shadow-minimal">
                      <input
                        value={note}
                        onChange={(event) => setNote(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault()
                            onConfirm('Ask inline', note)
                          }
                          if (event.key === 'Escape') {
                            event.preventDefault()
                            navigation.pop()
                          }
                        }}
                        placeholder={t('playground.containerTransitions.askPlaceholder')}
                        className="w-full bg-transparent outline-none text-sm"
                      />
                    </div>

                    <div className="flex justify-end gap-2 pt-1">
                      <button
                        type="button"
                        onClick={navigation.pop}
                        className="h-8 px-3 rounded-[8px] text-sm text-foreground/75 hover:bg-foreground/5"
                      >
                        {t('playground.containerTransitions.cancel')}
                      </button>
                      <button
                        type="button"
                        onClick={() => onConfirm('Ask inline', note)}
                        className="h-8 px-3 rounded-[8px] text-sm bg-foreground text-background inline-flex items-center gap-1.5"
                      >
                        <Check className="h-3.5 w-3.5" />
                        {t('playground.containerTransitions.ask')}
                      </button>
                    </div>
                  </div>
                </IslandContentView>
              </Island>
            ) : (
              <div className="min-w-[280px] rounded-[10px] border border-border/50 bg-background/80 px-4 py-3 text-xs text-foreground/65 text-center">
                {t('playground.containerTransitions.islandCleared')}
                <button
                  type="button"
                  onClick={restoreIsland}
                  className="ml-2 underline underline-offset-2 text-foreground/80 hover:text-foreground"
                >
                  {t('playground.containerTransitions.spawnFresh')}
                </button>
              </div>
            )}
          </div>
        </div>

        <IslandOptions
          view={navigation.current}
          navigation={navigation}
          activeViewSize={activeViewSize}
          useMorph={useMorph}
          onToggleMorph={() => setUseMorph((prev) => !prev)}
          angleDeg={angleDeg}
          distancePx={distancePx}
          startScale={startScale}
          onAngleChange={setAngleDeg}
          onDistanceChange={setDistancePx}
          onStartScaleChange={setStartScale}
          isIslandMounted={isIslandMounted && isIslandVisible}
          onClearIsland={clearIsland}
        />
      </div>

      <div className="rounded-[10px] bg-foreground/3 border border-border/40 px-3 py-2 text-xs text-foreground/70">
        {lastConfirmed
          ? t('playground.containerTransitions.lastConfirmed', { value: lastConfirmed })
          : t('playground.containerTransitions.noConfirmation')}
      </div>
    </div>
  )
}

export const containerTransitionsComponents: ComponentEntry[] = [
  {
    id: 'container-transition-popover-confirm',
    name: 'Island Scratch (Toolbar → Confirm)',
    nameZh: 'Island 草图（工具栏 → 确认）',
    category: 'Island',
    description:
      'Generic Island + IslandContentView primitives with backstack navigation and unified transitions.',
    descriptionZh: '使用 Island + IslandContentView 原语、返回栈导航与统一过渡的演示。',
    component: ToolbarToConfirmTransitionDemo,
    props: [
      {
        name: 'initialView',
        nameZh: '初始视图',
        description: 'Initial island view',
        descriptionZh: 'Island 的初始视图',
        control: {
          type: 'select',
          options: [
            { label: 'Compact', value: 'compact' },
            { label: 'Confirm: Follow up', value: 'confirm-follow-up' },
            { label: 'Confirm: Ask inline', value: 'confirm-ask-inline' },
          ],
        },
        defaultValue: 'compact',
      },
    ],
    variants: [
      { name: 'Compact', nameZh: '紧凑', props: { initialView: 'compact' } },
      { name: 'Follow up Confirm', nameZh: '追问确认', props: { initialView: 'confirm-follow-up' } },
      { name: 'Ask Inline Confirm', nameZh: '行内提问确认', props: { initialView: 'confirm-ask-inline' } },
    ],
    mockData: () => ({}),
  },
]
