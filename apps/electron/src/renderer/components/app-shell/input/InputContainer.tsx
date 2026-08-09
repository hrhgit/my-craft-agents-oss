import * as React from 'react'
import { motion, AnimatePresence, useMotionValue, useMotionValueEvent, animate } from 'motion/react'
import { cn } from '@/lib/utils'
import { FreeFormInput, type FreeFormInputProps } from './FreeFormInput'
import type { RichTextInputHandle } from '@/components/ui/rich-text-input'
import { useOptionalAppShellContext } from '@/context/AppShellContext'

interface InputContainerProps extends Omit<FreeFormInputProps, 'inputRef'> {
  /** External ref for the input (for focus control) */
  textareaRef?: React.RefObject<RichTextInputHandle>
  /** Per-frame callback during height animation (for scroll sync) */
  onAnimatedHeightChange?: (delta: number) => void
  /** Removes the top rounding when a pending-message strip is attached above. */
  attachedTop?: boolean
}

// Animation timing - synced across height and opacity
const TRANSITION_DURATION = 0.25
const TRANSITION_EASE = [0.4, 0, 0.2, 1] as const

// Fallback heights (used on first render before measurement)
const FALLBACK_HEIGHTS = { freeform: 98, 'freeform-compact': 70 } as const

/**
 * InputContainer - Main orchestrator for the extension-safe freeform composer.
 *
 * Animation approach:
 * - Uses a hidden measuring div to get the natural height of content
 * - Container animates to measured height
 * - Content crossfades inside using AnimatePresence mode="sync"
 * - All visible children use absolute positioning to stack during transition
 */
export function InputContainer({
  textareaRef,
  compactMode,
  isProcessing,
  onAnimatedHeightChange,
  attachedTop = false,
  ...freeFormProps
}: InputContainerProps) {
  const appShellContext = useOptionalAppShellContext()
  const isFocusedPanel = appShellContext?.isFocusedPanel ?? true
  const mode = 'freeform' as const
  const [freeformHeight, setFreeformHeight] = React.useState<number>(
    compactMode ? FALLBACK_HEIGHTS['freeform-compact'] : FALLBACK_HEIGHTS.freeform
  )
  const [isFocused, setIsFocused] = React.useState(false)
  const hasInitializedRef = React.useRef(false)

  // The business UI is supplied by V2 frontends around this fallback.
  const contentKey = 'freeform'

  // Track mode transitions - animate height for a short period after mode change
  const [isAnimating, setIsAnimating] = React.useState(false)
  const prevContentKeyRef = React.useRef(contentKey)

  // Detect transition synchronously during render
  const isTransitioning = prevContentKeyRef.current !== contentKey

  // Should animate if we're in a transition OR still in the animation window
  const shouldAnimateHeight = isTransitioning || isAnimating

  React.useEffect(() => {
    if (isTransitioning) {
      prevContentKeyRef.current = contentKey
      setIsAnimating(true)
      // Keep animating for the transition duration + a bit extra for measurement settle
      const timer = setTimeout(() => {
        setIsAnimating(false)
      }, TRANSITION_DURATION * 1000 + 100)
      return () => clearTimeout(timer)
    }
  }, [contentKey, isTransitioning])

  // Compact-mode collapse-during-thinking is escapable: the user can hover or
  // click the collapsed bar to bring the input back without waiting for the
  // agent to finish. State resets the moment processing ends so the next
  // thinking cycle starts collapsed again.
  const [expandedDuringProcessing, setExpandedDuringProcessing] = React.useState(false)

  React.useEffect(() => {
    if (!isProcessing && expandedDuringProcessing) {
      setExpandedDuringProcessing(false)
    }
  }, [isProcessing, expandedDuringProcessing])

  const handleRequestExpand = React.useCallback(() => {
    setExpandedDuringProcessing(true)
  }, [])

  const isCollapsedInCompact = compactMode && isProcessing && !expandedDuringProcessing

  // Animate height when either isProcessing flips OR the user manually expands
  // / re-collapses the input during a thinking cycle.
  const prevIsProcessingRef = React.useRef(isProcessing)
  const prevExpandedRef = React.useRef(expandedDuringProcessing)
  React.useEffect(() => {
    if (!compactMode) return
    const isProcessingChanged = prevIsProcessingRef.current !== isProcessing
    const expandedChanged = prevExpandedRef.current !== expandedDuringProcessing
    prevIsProcessingRef.current = isProcessing
    prevExpandedRef.current = expandedDuringProcessing
    if (!isProcessingChanged && !expandedChanged) return
    setIsAnimating(true)
    const timer = setTimeout(() => {
      setIsAnimating(false)
    }, TRANSITION_DURATION * 1000 + 100)
    return () => clearTimeout(timer)
  }, [compactMode, isProcessing, expandedDuringProcessing])

  // Handle height changes from FreeFormInput (synchronous, no measuring div needed)
  const handleFreeformHeightChange = React.useCallback((height: number) => {
    setFreeformHeight(height)
    if (!hasInitializedRef.current) {
      hasInitializedRef.current = true
    }
  }, [])

  // Handle focus changes from FreeFormInput
  const handleFocusChange = React.useCallback((focused: boolean) => {
    setIsFocused(focused)
  }, [])

  const targetHeight = freeformHeight

  // Motion value for frame-synchronized height animation
  const heightMotionValue = useMotionValue(targetHeight)
  const prevAnimatedHeightRef = React.useRef(targetHeight)

  // Emit delta on every animation frame for scroll sync
  useMotionValueEvent(heightMotionValue, "change", (latest) => {
    const delta = latest - prevAnimatedHeightRef.current
    prevAnimatedHeightRef.current = latest
    if (delta !== 0) {
      onAnimatedHeightChange?.(delta)
    }
  })

  // Animate height changes using motion value
  React.useEffect(() => {
    if (shouldAnimateHeight) {
      animate(heightMotionValue, targetHeight, {
        duration: TRANSITION_DURATION,
        ease: TRANSITION_EASE
      })
    } else {
      // Instant update - no animation
      heightMotionValue.set(targetHeight)
      prevAnimatedHeightRef.current = targetHeight
    }
  }, [targetHeight, shouldAnimateHeight, heightMotionValue])

  // Render the current content. V2 frontends own all business-specific UI.
  const renderContent = (forMeasuring: boolean) => {
    if (mode === 'freeform') {
      return (
        <FreeFormInput
          {...freeFormProps}
          compactMode={compactMode}
          isProcessing={isProcessing}
          isCollapsedInCompact={isCollapsedInCompact}
          onRequestExpand={handleRequestExpand}
          inputRef={forMeasuring ? undefined : textareaRef}
          onHeightChange={forMeasuring ? undefined : handleFreeformHeightChange}
          onFocusChange={forMeasuring ? undefined : handleFocusChange}
          unstyled
        />
      )
    }
    return null
  }

  return (
    <div className="relative">
      {/* Visible animated container */}
      <motion.div
        className={cn(
          "input-container relative transition-colors",
          isAnimating ? "overflow-hidden" : "overflow-visible",
          attachedTop ? "rounded-b-[12px] rounded-t-none" : "rounded-[12px]",
          isFocusedPanel ? "shadow-middle" : "shadow-minimal",
          "bg-background"
        )}
        style={{
          height: heightMotionValue,
        }}
      >
        {/* Crossfading content - freeform anchored to bottom (for auto-grow), others fill */}
        <AnimatePresence mode="sync" initial={false}>
          <motion.div
            key={contentKey}
            className={mode === 'freeform' ? "absolute bottom-0 left-0 right-0" : "absolute inset-0"}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: TRANSITION_DURATION, ease: TRANSITION_EASE }}
          >
            {renderContent(false)}
          </motion.div>
        </AnimatePresence>
      </motion.div>
    </div>
  )
}
