import * as React from "react"

import { cn } from "@/lib/utils"

function Textarea({ className, semanticId, ...props }: React.ComponentProps<"textarea"> & { semanticId?: string }) {
  return (
    <textarea
      data-slot="textarea"
      data-craft-semantic-id={semanticId}
      data-craft-ui-interactions="shortcut clipboard ime rich-text"
      className={cn(
        "border-foreground/15 placeholder:text-muted-foreground focus-visible:border-foreground/30 focus-visible:ring-foreground/15 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:bg-foreground/5 flex field-sizing-content min-h-16 w-full rounded-md border bg-transparent px-3 py-2 text-base shadow-xs transition-[color,box-shadow] outline-none focus-visible:ring-1 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
