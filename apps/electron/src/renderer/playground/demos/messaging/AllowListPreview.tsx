/**
 * AllowListPreview (playground only)
 *
 * Self-contained preview of the new Telegram allow-list / access-control UI.
 * Mounts the same shared components (`AccessModeBanner`, `OwnersListEditor`,
 * `PendingSendersList`, `BindingAllowListPopover`) that Phase 3 will wire
 * into the real `MessagingSettingsPage`. Backed entirely by playground mock
 * state via `__playgroundMessaging` so designers can flip variants without
 * any backend running.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { motion, AnimatePresence } from 'motion/react'
import { toast } from 'sonner'
import {
  ChevronDown,
  ChevronRight,
  Hash,
  MessageSquare,
  MessagesSquare,
  MoreHorizontal,
  Users,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SettingsCard, SettingsSection } from '@/components/settings'
import { MessagingPlatformIcon } from '@/components/messaging/MessagingPlatformIcon'
import {
  AccessModeBanner,
  BindingAllowListPopover,
  OwnersListEditor,
  PendingSendersList,
  type BindingAccess,
  type PendingSender,
  type PlatformAccessMode,
  type PlatformOwner,
} from '@/components/messaging/access'
import { playgroundAllowListHandle } from '../../mock-utils'

type AccessModePreset = 'open' | 'owner-only-empty' | 'owner-only-with-owner'
type PendingPreset = 'none' | 'one' | 'three'
type BindingPreset = 'inherit' | 'allow-list' | 'open'

const ROW_ICON_SIZE = 22

const CURRENT_USER_ID = '7654321' // matches PRIMARY_OWNER below

const PRIMARY_OWNER: PlatformOwner = {
  userId: '7654321',
  displayName: 'Gyula',
  username: 'gyula',
  addedAt: Date.now() - 12 * 60 * 60 * 1000,
}

function buildSamplePending(t: TFunction): PendingSender[] {
  return [
    {
      platform: 'telegram',
      userId: '111222333',
      displayName: 'Alex Müller',
      username: 'alex_m',
      lastAttemptAt: Date.now() - 2 * 60 * 1000,
      attemptCount: 3,
    },
    {
      platform: 'telegram',
      userId: '444555666',
      displayName: 'Sara Park',
      username: 'sarap',
      lastAttemptAt: Date.now() - 30 * 60 * 1000,
      attemptCount: 1,
    },
    {
      platform: 'telegram',
      userId: '777888999',
      displayName: t('playground.messaging.fixtures.randomSpammer'),
      lastAttemptAt: Date.now() - 4 * 60 * 60 * 1000,
      attemptCount: 14,
    },
  ]
}

function buildOwners(preset: AccessModePreset): PlatformOwner[] {
  switch (preset) {
    case 'open':
    case 'owner-only-empty':
      return []
    case 'owner-only-with-owner':
      return [PRIMARY_OWNER]
  }
}

function buildPending(preset: PendingPreset, t: TFunction): PendingSender[] {
  const sample = buildSamplePending(t)
  switch (preset) {
    case 'none':
      return []
    case 'one':
      return sample.slice(0, 1)
    case 'three':
      return sample
  }
}

function buildBindingAccess(preset: BindingPreset): BindingAccess {
  switch (preset) {
    case 'inherit':
      return { mode: 'inherit', allowedSenderIds: [] }
    case 'allow-list':
      return { mode: 'allow-list', allowedSenderIds: [PRIMARY_OWNER.userId] }
    case 'open':
      return { mode: 'open', allowedSenderIds: [] }
  }
}

function presetToAccessMode(preset: AccessModePreset): PlatformAccessMode {
  return preset === 'open' ? 'open' : 'owner-only'
}

export interface AllowListPreviewProps {
  accessMode: AccessModePreset
  pending: PendingPreset
  dmBindingAccess: BindingPreset
  topicBindingAccess: BindingPreset
}

export function AllowListPreview({
  accessMode,
  pending,
  dmBindingAccess,
  topicBindingAccess,
}: AllowListPreviewProps) {
  const { t } = useTranslation()
  const initialOwners = React.useMemo(() => buildOwners(accessMode), [accessMode])
  const initialPending = React.useMemo(() => buildPending(pending, t), [pending, t])
  const platformAccessMode = presetToAccessMode(accessMode)

  const [owners, setOwners] = React.useState<PlatformOwner[]>(initialOwners)
  const [pendingList, setPendingList] = React.useState<PendingSender[]>(initialPending)
  const [mode, setMode] = React.useState<PlatformAccessMode>(platformAccessMode)
  const [dmAccess, setDmAccess] = React.useState<BindingAccess>(() =>
    buildBindingAccess(dmBindingAccess),
  )
  const [topicAccess, setTopicAccess] = React.useState<BindingAccess>(() =>
    buildBindingAccess(topicBindingAccess),
  )

  // Keep state in sync with variant prop changes (so users can flip presets
  // from the playground sidebar without remounting the component).
  React.useEffect(() => setOwners(initialOwners), [initialOwners])
  React.useEffect(() => setPendingList(initialPending), [initialPending])
  React.useEffect(() => setMode(platformAccessMode), [platformAccessMode])
  React.useEffect(
    () => setDmAccess(buildBindingAccess(dmBindingAccess)),
    [dmBindingAccess],
  )
  React.useEffect(
    () => setTopicAccess(buildBindingAccess(topicBindingAccess)),
    [topicBindingAccess],
  )

  // Sync mock state for any IPC consumers (Phase 3 wiring will read these).
  React.useEffect(() => {
    playgroundAllowListHandle.setOwners('telegram', owners)
  }, [owners])
  React.useEffect(() => {
    playgroundAllowListHandle.setPending('telegram', pendingList)
  }, [pendingList])
  React.useEffect(() => {
    playgroundAllowListHandle.setAccessMode('telegram', mode)
  }, [mode])

  const handleLockDown = () => {
    setMode('owner-only')
    if (owners.length === 0) {
      // Best-effort seed with the current user (the most common case).
      setOwners([PRIMARY_OWNER])
    }
    toast.success(t('playground.messaging.toast.lockedDown'))
  }

  const handleRemoveOwner = (userId: string) => {
    setOwners((prev) => prev.filter((o) => o.userId !== userId))
    toast.info(t('playground.messaging.toast.ownerRemoved'))
  }

  const handleAllow = (sender: PendingSender) => {
    setOwners((prev) => [
      ...prev,
      {
        userId: sender.userId,
        displayName: sender.displayName,
        username: sender.username,
        addedAt: Date.now(),
      },
    ])
    setPendingList((prev) => prev.filter((s) => s.userId !== sender.userId))
    toast.success(
      t('playground.messaging.toast.senderAllowed', {
        name: sender.displayName || sender.username || sender.userId,
      }),
    )
  }

  const handleIgnore = (sender: PendingSender) => {
    setPendingList((prev) =>
      prev.filter(
        (s) =>
          !(
            s.userId === sender.userId &&
            (s.reason ?? 'not-owner') === (sender.reason ?? 'not-owner') &&
            (s.bindingId ?? null) === (sender.bindingId ?? null)
          ),
      ),
    )
  }

  return (
    <div className="space-y-6 p-6">
      <SettingsSection title={t('settings.messaging.title')}>
        <SettingsCard>
          <BotHeader />

          {mode === 'open' && <AccessModeBanner onLockDown={handleLockDown} />}

          <CardSeparator />
          <AllowedUsersCollapsible
            owners={owners}
            mode={mode}
            currentUserId={CURRENT_USER_ID}
            onRemove={handleRemoveOwner}
          />

          {pendingList.length > 0 && (
            <>
              <CardSeparator />
              <SectionHeader
                title={t('settings.messaging.telegram.access.pendingRequestsTitle')}
                subtitle={t('settings.messaging.telegram.access.pendingRequestsSubtitle', {
                  count: pendingList.length,
                })}
              />
              <PendingSendersList
                pending={pendingList}
                onAllow={handleAllow}
                onIgnore={handleIgnore}
              />
            </>
          )}

          <CardSeparator />
          <BindingRow
            icon={MessageSquare}
            title={t('settings.messaging.telegram.directSessionSubtitle')}
            subtitle={t('playground.messaging.fixtures.gyulaDmChat')}
            access={dmAccess}
            workspaceOwners={owners}
            onChange={setDmAccess}
          />
          <CardSeparator />
          <SupergroupHeader />
          <BindingRow
            icon={Hash}
            indent
            title={t('playground.messaging.fixtures.githubIssueTriage')}
            subtitle={`GithubIssues · ${t('playground.messaging.topicWithId', { id: 16 })}`}
            access={topicAccess}
            workspaceOwners={owners}
            onChange={setTopicAccess}
          />
        </SettingsCard>
      </SettingsSection>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function CardSeparator() {
  return <div className="mx-4 h-px bg-border/50" />
}

function SectionHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="px-4 pt-3 pb-1">
      <div className="text-xs font-medium uppercase tracking-wide text-foreground/50">
        {title}
      </div>
      <div className="mt-0.5 text-xs text-foreground/50">{subtitle}</div>
    </div>
  )
}

function BotHeader() {
  const { t } = useTranslation()
  return (
    <div className="flex items-center gap-3 px-4 py-3.5">
      <MessagingPlatformIcon platform="telegram" size={ROW_ICON_SIZE} />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{t('settings.messaging.telegram.title')}</div>
        <div className="mt-0.5 truncate text-xs text-foreground/50">
          {t('settings.messaging.telegram.apiType')} ·{' '}
          {t('settings.messaging.telegram.validBot', { username: 'MortiseBot' })}
        </div>
      </div>
      <button
        type="button"
        className="rounded-md p-1.5 transition-colors hover:bg-foreground/[0.05]"
        aria-label={t('common.more')}
      >
        <MoreHorizontal className="h-4 w-4 text-foreground/50" />
      </button>
    </div>
  )
}

function SupergroupHeader() {
  const { t } = useTranslation()
  return (
    <div className="flex items-center gap-3 px-4 py-2.5">
      <div
        className="shrink-0 flex items-center justify-center"
        style={{ width: ROW_ICON_SIZE, height: ROW_ICON_SIZE }}
      >
        <MessagesSquare className="h-4 w-4 text-foreground/50" strokeWidth={1.5} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <div className="truncate text-sm font-medium">Mortise</div>
          <div className="truncate text-xs text-foreground/50">(-1003783993623)</div>
        </div>
        <div className="mt-0.5 truncate text-xs text-foreground/50">
          {t('settings.messaging.telegram.supergroup.topicsBound', { count: 1 })}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// AllowedUsersCollapsible — mirrors TelegramAccessSection's collapsible row
// so the playground demo and production stay visually identical.
// ---------------------------------------------------------------------------

function AllowedUsersCollapsible({
  owners,
  mode,
  currentUserId,
  onRemove,
}: {
  owners: PlatformOwner[]
  mode: PlatformAccessMode
  currentUserId: string
  onRemove: (userId: string) => void
}) {
  const { t } = useTranslation()
  const [isExpanded, setIsExpanded] = React.useState(owners.length > 0)

  const subtitle =
    mode === 'open'
      ? t('settings.messaging.telegram.access.allowedUsersSubtitleOpen')
      : owners.length === 0
        ? t('settings.messaging.telegram.access.allowedUsersSubtitleEmpty')
        : t('settings.messaging.telegram.access.allowedUsersSubtitle', { count: owners.length })

  return (
    <div>
      <button
        type="button"
        onClick={() => setIsExpanded((v) => !v)}
        className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-foreground/[0.02]"
      >
        <div
          className="shrink-0 flex items-center justify-center"
          style={{ width: ROW_ICON_SIZE, height: ROW_ICON_SIZE }}
        >
          <Users className="h-4 w-4 text-foreground/50" strokeWidth={1.5} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">{t('settings.messaging.telegram.access.allowedUsersTitle')}</div>
          <div className="mt-0.5 truncate text-xs text-foreground/50">{subtitle}</div>
        </div>
        {isExpanded ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-foreground/50" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-foreground/50" />
        )}
      </button>

      <AnimatePresence initial={false}>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
            className="overflow-hidden"
          >
            <div className="border-t border-border/50">
              <OwnersListEditor
                owners={owners}
                enforced={mode === 'owner-only'}
                currentUserId={currentUserId}
                onRemove={onRemove}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function BindingRow({
  icon: Icon,
  indent,
  title,
  subtitle,
  access,
  workspaceOwners,
  onChange,
}: {
  icon: typeof MessageSquare
  indent?: boolean
  title: string
  subtitle: string
  access: BindingAccess
  workspaceOwners: PlatformOwner[]
  onChange: (next: BindingAccess) => void
}) {
  const { t } = useTranslation()
  return (
    <div className="flex items-center gap-3 px-4 py-2.5">
      <div
        className="shrink-0 flex items-center justify-center"
        style={{ width: ROW_ICON_SIZE, height: ROW_ICON_SIZE }}
      >
        {indent ? null : (
          <Icon className="h-4 w-4 text-foreground/50" strokeWidth={1.5} />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm">{title}</div>
        <div className="mt-0.5 truncate text-xs text-foreground/50">{subtitle}</div>
      </div>
      <BindingAllowListPopover
        access={access}
        workspaceOwners={workspaceOwners}
        onChange={onChange}
      />
      <Button variant="ghost" size="sm">{t('common.open')}</Button>
    </div>
  )
}
