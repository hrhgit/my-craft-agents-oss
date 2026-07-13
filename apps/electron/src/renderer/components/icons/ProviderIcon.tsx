import { Brain } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@craft-agent/ui'
import { getModelDisplayName } from '@config/models'
import { getProviderIcon } from '@/lib/provider-icons'
import type { PiGlobalProviderForDisplay } from '../../../shared/types'

interface ProviderIconProps {
  provider: PiGlobalProviderForDisplay
  size?: number
  className?: string
  showTooltip?: boolean
}

export function ProviderIcon({ provider, size = 16, className = '', showTooltip = false }: ProviderIconProps) {
  const source = getProviderIcon(
    'pi',
    provider.provider.baseUrl,
    provider.key,
  )
  const icon = source ? (
    <img src={source} alt="" width={size} height={size} className={`rounded-[3px] shrink-0 ${className}`} />
  ) : (
    <span
      className={`rounded-[3px] bg-foreground/10 flex items-center justify-center shrink-0 ${className}`}
      style={{ width: size, height: size }}
    >
      <Brain className="text-foreground/50" style={{ width: Math.round(size * 0.7), height: Math.round(size * 0.7) }} />
    </span>
  )

  if (!showTooltip) return icon
  return (
    <Tooltip>
      <TooltipTrigger asChild>{icon}</TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={4}>
        <div className="text-center">
          <div>{provider.key}</div>
          {provider.provider.models?.[0]?.id && <div className="text-[10px] opacity-60">{getModelDisplayName(provider.provider.models[0].id)}</div>}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}
