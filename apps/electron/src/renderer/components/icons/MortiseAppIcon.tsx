import mortiseLogo from "@/assets/mortise_app_icon.svg"

interface MortiseAppIconProps {
  className?: string
  size?: number
}

/**
 * MortiseAppIcon - Displays the packaged Mortise app icon.
 */
export function MortiseAppIcon({ className, size = 64 }: MortiseAppIconProps) {
  return (
    <img
      src={mortiseLogo}
      alt="Mortise"
      width={size}
      height={size}
      className={className}
    />
  )
}
