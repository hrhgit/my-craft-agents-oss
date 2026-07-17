import { useEffect, useRef } from "react"
import { useTranslation } from "react-i18next"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { useRegisterModal } from "@/context/ModalContext"

interface RenameDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  value: string
  onValueChange: (value: string) => void
  onSubmit: () => void
  placeholder?: string
  submitLabel?: string
  submitting?: boolean
  error?: string | null
}

export function RenameDialog({
  open,
  onOpenChange,
  title,
  value,
  onValueChange,
  onSubmit,
  placeholder,
  submitLabel,
  submitting = false,
  error,
}: RenameDialogProps) {
  const { t } = useTranslation()
  const effectivePlaceholder = placeholder ?? t("common.enterName")
  const inputRef = useRef<HTMLInputElement>(null)

  // Register with modal context so X button / Cmd+W closes this dialog first
  useRegisterModal(open, () => onOpenChange(false))

  // Focus input after dialog opens (avoids Radix Dialog focus race condition)
  useEffect(() => {
    if (open) {
      const timer = setTimeout(() => {
        inputRef.current?.focus()
      }, 0)
      return () => clearTimeout(timer)
    }
  }, [open])

  const handleSubmit = () => {
    if (value.trim()) {
      onSubmit()
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[400px]" onOpenAutoFocus={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="py-4">
          <Input
            ref={inputRef}
            value={value}
            onChange={(e) => onValueChange(e.target.value)}
            placeholder={effectivePlaceholder}
            disabled={submitting}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                handleSubmit()
              }
            }}
          />
          {error && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            {t("common.cancel")}
          </Button>
          <Button onClick={handleSubmit} disabled={!value.trim() || submitting}>
            {submitLabel ?? t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
