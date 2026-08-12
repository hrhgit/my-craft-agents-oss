import * as React from 'react'
import { useTranslation } from 'react-i18next'
import type { ComponentEntry, ComponentVariant, PlaygroundLocale } from './types'
import { TransportConnectionBanner } from '@/components/app-shell/TransportConnectionBanner'
import type { TransportConnectionState } from '../../../shared/types'
import { HelpCircle, Plus } from 'lucide-react'

// =============================================================================
// TransportConnectionBanner Playground
// Demonstrates the banner in context with a mock TopBar to verify no overlap.
// =============================================================================

type BannerStatus = 'reconnecting' | 'connecting' | 'failed-auth' | 'failed-network' | 'disconnected'

const MOCK_URL = 'wss://remote.example.com'

// Mock states — localized fixtures keyed by status so registry variants only
// carry a status selector while mockData delivers the playground locale.
function buildMockState(status: BannerStatus, locale: PlaygroundLocale): TransportConnectionState {
  const zh = locale === 'zh-CN'
  switch (status) {
    case 'reconnecting':
      return {
        mode: 'remote',
        status: 'reconnecting',
        url: MOCK_URL,
        attempt: 31,
        lastClose: { code: 1006 },
        updatedAt: Date.now(),
      }
    case 'connecting':
      return {
        mode: 'remote',
        status: 'connecting',
        url: MOCK_URL,
        attempt: 0,
        updatedAt: Date.now(),
      }
    case 'failed-auth':
      return {
        mode: 'remote',
        status: 'failed',
        url: MOCK_URL,
        attempt: 5,
        lastError: {
          kind: 'auth',
          message: zh
            ? '认证失败。请检查 MORTISE_SERVER_TOKEN。'
            : 'Authentication failed. Verify MORTISE_SERVER_TOKEN.',
        },
        updatedAt: Date.now(),
      }
    case 'failed-network':
      return {
        mode: 'remote',
        status: 'failed',
        url: MOCK_URL,
        attempt: 3,
        lastError: {
          kind: 'network',
          message: zh
            ? '无法连接到 wss://remote.example.com。远程服务器是否在运行？'
            : 'Could not connect to wss://remote.example.com. Is the remote server running?',
        },
        updatedAt: Date.now(),
      }
    case 'disconnected':
      return {
        mode: 'remote',
        status: 'disconnected',
        url: MOCK_URL,
        attempt: 1,
        lastClose: { code: 1001, reason: zh ? '正在离开' : 'Going away' },
        updatedAt: Date.now(),
      }
  }
}

/** Mock TopBar strip — just the right-side buttons that caused the overlap. */
function MockTopBar() {
  const { t } = useTranslation()
  return (
    <div className="absolute top-0 left-0 right-0 h-[48px] z-[50] flex items-center justify-between px-3 border-b border-border/30 bg-background/80 backdrop-blur-sm">
      <span className="text-xs text-muted-foreground">{t('playground.transportBanner.mockTopBar')}</span>
      <div className="flex items-center gap-1" style={{ paddingRight: 12 }}>
        <button className="h-[26px] w-[26px] flex items-center justify-center rounded-lg hover:bg-foreground/5">
          <Plus className="h-4 w-4 text-foreground/50" strokeWidth={1.5} />
        </button>
        <button className="h-[26px] w-[26px] flex items-center justify-center rounded-lg hover:bg-foreground/5">
          <HelpCircle className="h-4 w-4 text-foreground/50" strokeWidth={1.5} />
        </button>
      </div>
    </div>
  )
}

/** Wrapper that provides the mock TopBar + pt-[48px] layout (matching the real App.tsx structure). */
function LayoutWrapper({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation()
  return (
    <div className="relative w-full h-[320px] border border-border rounded-lg overflow-hidden bg-background">
      <MockTopBar />
      <div className="h-full flex flex-col pt-[48px]">
        {children}
        <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground">
          {t('playground.transportBanner.mainContent')}
        </div>
      </div>
    </div>
  )
}

/** Standalone banner (no layout context) */
function BannerStandalone({
  status = 'reconnecting',
  locale = 'en',
}: {
  status?: BannerStatus
  locale?: PlaygroundLocale
}) {
  const state = React.useMemo(() => buildMockState(status, locale), [status, locale])
  return <TransportConnectionBanner state={state} onRetry={() => console.log('[Playground] Retry clicked')} />
}

/** Banner inside the full mock layout (TopBar + offset) */
function BannerInLayout({
  status = 'reconnecting',
  locale = 'en',
}: {
  status?: BannerStatus
  locale?: PlaygroundLocale
}) {
  const state = React.useMemo(() => buildMockState(status, locale), [status, locale])
  return (
    <LayoutWrapper>
      <TransportConnectionBanner state={state} onRetry={() => console.log('[Playground] Retry clicked')} />
    </LayoutWrapper>
  )
}

const TRANSPORT_BANNER_VARIANTS = [
  { name: 'Reconnecting (code 1006)', nameZh: '重连中（代码 1006）', props: { status: 'reconnecting' } },
  { name: 'Connecting', nameZh: '连接中', props: { status: 'connecting' } },
  { name: 'Failed (auth)', nameZh: '连接失败（认证）', props: { status: 'failed-auth' } },
  { name: 'Failed (network)', nameZh: '连接失败（网络）', props: { status: 'failed-network' } },
  { name: 'Disconnected', nameZh: '已断开', props: { status: 'disconnected' } },
] satisfies ComponentVariant[]

export const transportBannerComponents: ComponentEntry[] = [
  {
    id: 'transport-banner-layout',
    name: 'TransportConnectionBanner (Layout)',
    nameZh: 'TransportConnectionBanner（布局）',
    category: 'Chat',
    description: 'Banner with mock TopBar — verifies Retry button does not overlap help button',
    descriptionZh: '带模拟 TopBar 的横幅——验证重试按钮不与帮助按钮重叠',
    component: BannerInLayout,
    layout: 'centered',
    props: [],
    variants: TRANSPORT_BANNER_VARIANTS,
    mockData: (locale) => ({ locale }),
  },
  {
    id: 'transport-banner',
    name: 'TransportConnectionBanner',
    nameZh: 'TransportConnectionBanner',
    category: 'Chat',
    description: 'Remote server connection status banner with retry action',
    descriptionZh: '带重试操作的远程服务器连接状态横幅',
    component: BannerStandalone,
    props: [],
    variants: TRANSPORT_BANNER_VARIANTS,
    mockData: (locale) => ({ locale }),
  },
]
