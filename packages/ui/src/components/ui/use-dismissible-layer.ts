import * as React from 'react'
import {
  getDismissibleLayerBridge,
  type DismissibleLayerType,
} from '../../lib/dismissible-layer-bridge'

export function useDismissibleLayerRegistration(
  open: boolean,
  onClose: () => void,
  type: DismissibleLayerType,
  priority: number,
): void {
  const id = React.useId()
  React.useLayoutEffect(() => {
    if (!open) return
    return getDismissibleLayerBridge()?.registerLayer({
      id: `shared-primitive-${id}`,
      type,
      priority,
      close: onClose,
    })
  }, [id, onClose, open, priority, type])
}

export function useDismissiblePrimitiveRootState(
  props: {
    open?: boolean
    defaultOpen?: boolean
    onOpenChange?: (open: boolean) => void
  },
  type: DismissibleLayerType,
  priority: number,
): { open: boolean; onOpenChange: (open: boolean) => void } {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(props.defaultOpen ?? false)
  const open = props.open ?? uncontrolledOpen
  const onOpenChange = React.useCallback((nextOpen: boolean) => {
    if (props.open === undefined) setUncontrolledOpen(nextOpen)
    props.onOpenChange?.(nextOpen)
  }, [props.onOpenChange, props.open])
  useDismissibleLayerRegistration(open, () => onOpenChange(false), type, priority)
  return { open, onOpenChange }
}
