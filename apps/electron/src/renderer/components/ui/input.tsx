import * as React from "react"
import { cn } from "@/lib/utils"

export interface InputProps extends React.ComponentPropsWithoutRef<"input"> { semanticId?: string }

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, semanticId, ...props }, ref) => {
    const textInteractions = !type || ['text', 'search', 'email', 'url', 'tel', 'password'].includes(type)
      ? 'shortcut clipboard ime'
      : undefined
    return (
      <input
        type={type}
        ref={ref}
        data-slot="input"
        data-craft-semantic-id={semanticId}
        data-craft-ui-interactions={textInteractions}
        className={cn(
          "flex h-9 w-full rounded-md border border-foreground/15 bg-transparent px-3 py-1 text-base transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-foreground/30 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
          className
        )}
        {...props}
      />
    )
  }
)
Input.displayName = "Input"

export { Input }
