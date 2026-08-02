import { cn } from "@/lib/utils"
import { Button, type ButtonProps } from "@/components/ui/button"
import { Spinner } from "@mortise/ui"

interface AddWorkspaceContainerProps {
  children: React.ReactNode
  className?: string
}

export function AddWorkspaceContainer({ children, className }: AddWorkspaceContainerProps) {
  return (
    <div className={cn(
      "flex w-full flex-col items-stretch",
      className
    )}>
      {children}
    </div>
  )
}

interface AddWorkspaceStepHeaderProps {
  /** The main title */
  title: string
  className?: string
}

export function AddWorkspaceStepHeader({
  title,
  className
}: AddWorkspaceStepHeaderProps) {
  return (
    <div className={cn("pr-8", className)}>
      <h2 className="text-lg font-semibold">
        {title}
      </h2>
    </div>
  )
}

interface AddWorkspacePrimaryButtonProps extends Omit<ButtonProps, 'variant' | 'children'> {
  children?: React.ReactNode
  loading?: boolean
  loadingText?: string
}

export function AddWorkspacePrimaryButton({
  children = 'Continue',
  loading,
  loadingText,
  className,
  disabled,
  ...props
}: AddWorkspacePrimaryButtonProps) {
  return (
    <Button
      className={cn("w-full", className)}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? (
        <>
          <Spinner className="mr-2" />
          {loadingText || children}
        </>
      ) : (
        children
      )}
    </Button>
  )
}

interface AddWorkspaceSecondaryButtonProps extends Omit<ButtonProps, 'variant'> {
  children?: React.ReactNode
}

export function AddWorkspaceSecondaryButton({
  children,
  className,
  ...props
}: AddWorkspaceSecondaryButtonProps) {
  return (
    <Button
      variant="secondary"
      size="sm"
      className={cn("bg-background shadow-minimal", className)}
      {...props}
    >
      {children}
    </Button>
  )
}
