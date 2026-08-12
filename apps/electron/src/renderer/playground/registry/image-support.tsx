import * as React from 'react'
import { Check, Image as ImageIcon } from 'lucide-react'
import type { ComponentEntry } from './types'
import { ImageSupportWarningBanner } from '@/components/app-shell/input/ImageSupportWarningBanner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@mortise/ui'
import { cn } from '@/lib/utils'
import { useTranslation } from 'react-i18next'

// ============================================================================
// Pre-flight banner — pure visual demo of the warning shown above
// AttachmentPreview when the active model is text-only on a pi_custom
// connection. The banner is dumb: parent decides when to show it. These
// variants render it directly to verify copy and layout.
// ============================================================================

function BannerDemo({
  modelName,
  onClickEnable,
}: {
  modelName: string
  onClickEnable?: () => void
}) {
  const { t } = useTranslation()
  const [enabled, setEnabled] = React.useState(false)
  return (
    <div className="w-full max-w-[640px] mx-auto p-6">
      <div className="rounded-2xl border border-border/50 shadow-middle bg-background/40 backdrop-blur-sm">
        {!enabled && (
          <ImageSupportWarningBanner
            modelName={modelName}
            onEnable={() => {
              setEnabled(true)
              onClickEnable?.()
            }}
          />
        )}
        <div className="px-4 py-6 text-foreground/40 text-sm">
          {enabled
            ? t('playground.imageSupport.bannerDismissed')
            : t('playground.imageSupport.bannerPlaceholder')}
        </div>
      </div>
    </div>
  )
}

// ============================================================================
// Per-model picker row — renders the same JSX shape as the chat-input model
// picker uses. Variants cover the gate (pi_custom vs not), and the toggle
// states (vision-on, vision-off, currently selected).
// ============================================================================

interface PickerRowProps {
  modelName: string
  isSelected: boolean
  showVisionToggle: boolean
  visionOn: boolean
}

function PickerRow({
  modelName,
  isSelected,
  showVisionToggle,
  visionOn: initialVisionOn,
}: PickerRowProps) {
  const { t } = useTranslation()
  const [visionOn, setVisionOn] = React.useState(initialVisionOn)
  return (
    <div className="w-[260px] mx-auto rounded-md bg-background/80 border border-border/50 px-1 py-1">
      <div className="flex items-center justify-between px-2 py-2 rounded-lg cursor-pointer hover:bg-foreground/5">
        <div className="text-left">
          <div className="font-medium text-sm">{modelName}</div>
        </div>
        <div className="flex items-center gap-1 ml-3 shrink-0">
          {showVisionToggle && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  role="button"
                  tabIndex={0}
                  aria-label={visionOn
                    ? t('chat.modelPicker.supportsImagesOn')
                    : t('chat.modelPicker.supportsImagesOff')}
                  className="inline-flex items-center justify-center p-1 rounded hover:bg-foreground/5 cursor-pointer"
                  onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    setVisionOn(v => !v)
                  }}
                >
                  <ImageIcon className={cn(
                    'h-3.5 w-3.5',
                    visionOn ? 'text-foreground/70' : 'text-foreground/30',
                  )} />
                </span>
              </TooltipTrigger>
              <TooltipContent>
                {visionOn
                  ? t('chat.modelPicker.supportsImagesOn')
                  : t('chat.modelPicker.supportsImagesOff')}
              </TooltipContent>
            </Tooltip>
          )}
          {isSelected && (
            <Check className="h-3 w-3 text-foreground" />
          )}
        </div>
      </div>
    </div>
  )
}

export const imageSupportComponents: ComponentEntry[] = [
  {
    id: 'image-support-banner',
    name: 'Image Support — Pre-flight Banner',
    nameZh: '图片支持 — 前置横幅',
    category: 'Chat Inputs',
    description:
      'Inline warning rendered above the chat input when the user has staged images on a custom-endpoint model that is configured as text-only. One-click action toggles the per-model supportsImages override.',
    descriptionZh:
      '当用户在文本专用的自定义端点模型上暂存了图片时，显示在聊天输入框上方的内联警告。一键操作可切换该模型的 supportsImages 覆盖。',
    component: BannerDemo,
    layout: 'centered',
    props: [
      {
        name: 'modelName',
        description: 'Display name of the active text-only model',
        descriptionZh: '当前文本专用模型的显示名称',
        control: { type: 'string' },
        defaultValue: 'qwen3-coder',
      },
    ],
    variants: [
      {
        name: 'Default',
        nameZh: '默认',
        description: 'Generic text-only custom-endpoint model with images staged',
        descriptionZh: '通用文本专用自定义端点模型，已暂存图片',
        props: { modelName: 'qwen3-coder' },
      },
      {
        name: 'Long model name',
        nameZh: '长模型名称',
        description: 'Verifies wrapping behaviour for long names',
        descriptionZh: '验证长名称的换行表现',
        props: { modelName: 'minimax-text-01-very-long-id-no-images-here' },
      },
    ],
    mockData: () => ({}),
  },
  {
    id: 'image-support-picker-row',
    name: 'Image Support — Picker Row',
    nameZh: '图片支持 — 选择行',
    category: 'Chat Inputs',
    description:
      'A single chat-input model picker row with the per-model image-support toggle. The icon is gated to pi_custom connections — built-in providers (anthropic / pi) hide it because their catalogs are SDK-owned.',
    descriptionZh:
      '带单模型图片支持切换的聊天输入模型选择行。图标仅在 pi_custom 连接下显示——内置提供商（anthropic / pi）因目录由 SDK 管理而隐藏。',
    component: PickerRow,
    layout: 'centered',
    props: [
      {
        name: 'modelName',
        control: { type: 'string' },
        defaultValue: 'qwen3-coder',
      },
      {
        name: 'isSelected',
        control: { type: 'boolean' },
        defaultValue: false,
      },
      {
        name: 'showVisionToggle',
        description: 'true for pi_custom (custom endpoints), false for built-in providers',
        descriptionZh: 'pi_custom（自定义端点）为 true，内置提供商为 false',
        control: { type: 'boolean' },
        defaultValue: true,
      },
      {
        name: 'visionOn',
        description: 'Per-model supportsImages override resolution',
        descriptionZh: '单模型 supportsImages 覆盖解析结果',
        control: { type: 'boolean' },
        defaultValue: false,
      },
    ],
    variants: [
      {
        name: 'pi_custom — text-only (default)',
        nameZh: 'pi_custom — 仅文本（默认）',
        description: 'Toggle visible, dim icon — image support disabled',
        descriptionZh: '切换可见，图标变暗——图片支持已禁用',
        props: { modelName: 'qwen3-coder', isSelected: false, showVisionToggle: true, visionOn: false },
      },
      {
        name: 'pi_custom — vision-on',
        nameZh: 'pi_custom — 视觉开启',
        description: 'Toggle visible, bright icon — per-model override true',
        descriptionZh: '切换可见，图标明亮——单模型覆盖为 true',
        props: { modelName: 'minimax-vision', isSelected: false, showVisionToggle: true, visionOn: true },
      },
      {
        name: 'pi_custom — selected, vision-on',
        nameZh: 'pi_custom — 已选中且视觉开启',
        description: 'Both Check and bright icon visible',
        descriptionZh: '对勾和明亮图标同时可见',
        props: { modelName: 'minimax-vision', isSelected: true, showVisionToggle: true, visionOn: true },
      },
      {
        name: 'Built-in provider (no toggle)',
        nameZh: '内置提供商（无切换）',
        description: 'Anthropic or pi — no toggle rendered',
        descriptionZh: 'Anthropic 或 pi——不渲染切换',
        props: { modelName: 'claude-haiku-4-5', isSelected: true, showVisionToggle: false, visionOn: false },
      },
    ],
    mockData: () => ({}),
  },
]
