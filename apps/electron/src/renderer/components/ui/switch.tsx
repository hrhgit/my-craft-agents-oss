"use client"

import * as React from "react"
import * as SwitchPrimitive from "@radix-ui/react-switch"

import { cn } from "@/lib/utils"
import { uiValidationAttributes, type UiValidationPrimitiveProps } from "./ui-validation"

function Switch({
  className,
  semanticId,
  uiInteractions,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root> & UiValidationPrimitiveProps) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      {...uiValidationAttributes(semanticId, uiInteractions)}
      className={cn(
        "peer data-[state=checked]:bg-foreground data-[state=unchecked]:bg-foreground/20 focus-visible:border-foreground/40 focus-visible:ring-foreground/20 dark:data-[state=unchecked]:bg-foreground/18 inline-flex h-[1.45rem] w-9 shrink-0 items-center rounded-full border border-[var(--surface-border)] shadow-xs transition-all outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "bg-background dark:data-[state=unchecked]:bg-foreground dark:data-[state=checked]:bg-background pointer-events-none block size-[1.1rem] rounded-full ring-0 transition-transform data-[state=checked]:translate-x-[calc(100%-1px)] data-[state=unchecked]:translate-x-[1px]"
        )}
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
