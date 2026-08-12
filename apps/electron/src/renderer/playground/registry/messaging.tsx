import type { ComponentEntry } from './types'
import { AllowListPreview } from '../demos/messaging/AllowListPreview'
import { MessagingSettingsPagePreview } from '../demos/messaging/MessagingSettingsPagePreview'
import { MessagingTelegramReworkedPreview } from '../demos/messaging/MessagingTelegramReworkedPreview'
import { PairingCodeDialogPreview } from '../demos/messaging/PairingCodeDialogPreview'
import { WhatsAppConnectDialogPreview } from '../demos/messaging/WhatsAppConnectDialogPreview'
import { MessagingSubmenuPreview } from '../demos/messaging/MessagingSubmenuPreview'

export const messagingComponents: ComponentEntry[] = [
  {
    id: 'messaging-allow-list',
    name: 'Telegram Allow-list (access control)',
    nameZh: 'Telegram 允许列表（访问控制）',
    category: 'Messaging',
    description:
      'Workspace owners list, pending requests, per-binding allow-list. Drives the Phase 1 design for restricting bot access.',
    descriptionZh: '工作区所有者列表、待处理请求、按绑定的允许列表。用于推动限制机器人访问的 Phase 1 设计。',
    component: AllowListPreview,
    layout: 'full',
    props: [
      {
        name: 'accessMode',
        description:
          'Workspace-level access policy. "open" shows the migration banner; "owner-only" enforces the allow-list.',
        descriptionZh: '工作区级访问策略。“open”显示迁移横幅；“owner-only”强制执行允许列表。',
        control: {
          type: 'select',
          options: [
            { label: 'Open (legacy / migration banner)', value: 'open' },
            { label: 'Owner-only · empty list', value: 'owner-only-empty' },
            { label: 'Owner-only · with owner', value: 'owner-only-with-owner' },
          ],
        },
        defaultValue: 'owner-only-with-owner',
      },
      {
        name: 'pending',
        description: 'How many recently rejected senders to show.',
        descriptionZh: '显示多少个最近被拒绝的发送者。',
        control: {
          type: 'select',
          options: [
            { label: 'None', value: 'none' },
            { label: 'One', value: 'one' },
            { label: 'Three', value: 'three' },
          ],
        },
        defaultValue: 'one',
      },
      {
        name: 'dmBindingAccess',
        description: 'Per-binding access mode for the sample DM binding.',
        descriptionZh: '示例私信绑定的按绑定访问模式。',
        control: {
          type: 'select',
          options: [
            { label: 'Inherit workspace', value: 'inherit' },
            { label: 'Custom allow-list', value: 'allow-list' },
            { label: 'Open to anyone', value: 'open' },
          ],
        },
        defaultValue: 'inherit',
      },
      {
        name: 'topicBindingAccess',
        description: 'Per-binding access mode for the sample supergroup topic.',
        descriptionZh: '示例超级群组话题的按绑定访问模式。',
        control: {
          type: 'select',
          options: [
            { label: 'Inherit workspace', value: 'inherit' },
            { label: 'Custom allow-list', value: 'allow-list' },
            { label: 'Open to anyone', value: 'open' },
          ],
        },
        defaultValue: 'inherit',
      },
    ],
    variants: [
      {
        name: 'Migration: open mode + pending requests',
        nameZh: '迁移：开放模式 + 待处理请求',
        description:
          'Existing workspace, accessMode=open. Banner prompts owner to lock down; pending list grows as random senders try the bot.',
        descriptionZh: '现有工作区，accessMode=open。横幅提示所有者锁定；随机发送者尝试使用机器人时，待处理列表不断增长。',
        props: {
          accessMode: 'open',
          pending: 'three',
          dmBindingAccess: 'open',
          topicBindingAccess: 'open',
        },
      },
      {
        name: 'Locked-down · with owner · 1 pending',
        nameZh: '已锁定 · 有所有者 · 1 个待处理',
        description:
          'Default state for a freshly-paired bot: one owner, one pending request to consider.',
        descriptionZh: '刚配对的机器人的默认状态：一个所有者，一个待处理的请求。',
        props: {
          accessMode: 'owner-only-with-owner',
          pending: 'one',
          dmBindingAccess: 'inherit',
          topicBindingAccess: 'inherit',
        },
      },
      {
        name: 'Locked-down · empty list',
        nameZh: '已锁定 · 空列表',
        description:
          'Bot is locked down but no owners are recorded yet (rare — typically right after a manual lock-down with empty seed).',
        descriptionZh: '机器人已锁定但尚未记录所有者（少见——通常在手动锁定且没有初始所有者之后出现）。',
        props: {
          accessMode: 'owner-only-empty',
          pending: 'none',
          dmBindingAccess: 'inherit',
          topicBindingAccess: 'inherit',
        },
      },
      {
        name: 'Per-binding: custom allow-list',
        nameZh: '按绑定：自定义允许列表',
        description:
          'Owner narrowed the DM binding to a custom allow-list, while the supergroup topic still inherits.',
        descriptionZh: '所有者将私信绑定限制为自定义允许列表，而超级群组话题仍继承工作区设置。',
        props: {
          accessMode: 'owner-only-with-owner',
          pending: 'none',
          dmBindingAccess: 'allow-list',
          topicBindingAccess: 'inherit',
        },
      },
    ],
  },
  {
    id: 'messaging-telegram-reworked',
    name: 'Telegram Settings (rework draft)',
    nameZh: 'Telegram 设置（改版草稿）',
    category: 'Messaging',
    description:
      'Prototype: bot header → direct sessions → separator → collapsible supergroup with topics',
    descriptionZh: '原型：机器人头部 → 私信会话 → 分隔线 → 可折叠的超级群组及话题',
    component: MessagingTelegramReworkedPreview,
    layout: 'full',
    props: [
      {
        name: 'telegramConnected',
        description: 'Whether the Telegram bot is connected',
        descriptionZh: 'Telegram 机器人是否已连接',
        control: { type: 'boolean' },
        defaultValue: true,
      },
      {
        name: 'supergroupPaired',
        description: 'Whether a supergroup is paired (controls chevron section vs Pair CTA)',
        descriptionZh: '是否已配对超级群组（控制折叠区 vs 配对按钮）',
        control: { type: 'boolean' },
        defaultValue: true,
      },
      {
        name: 'directSessions',
        description: 'Direct (DM) session present? — only one direct session can be paired per bot.',
        descriptionZh: '是否存在私信（DM）会话？——每个机器人只能配对一条私信会话。',
        control: { type: 'number', min: 0, max: 1, step: 1 },
        defaultValue: 1,
      },
      {
        name: 'supergroupTopics',
        description: 'Number of topic-bound bindings under the supergroup (0–3)',
        descriptionZh: '超级群组下绑定话题的数量（0–3）',
        control: { type: 'number', min: 0, max: 3, step: 1 },
        defaultValue: 2,
      },
    ],
    variants: [
      {
        name: 'Connected · DM + supergroup with topics',
        nameZh: '已连接 · 私信 + 带话题的超级群组',
        props: { telegramConnected: true, supergroupPaired: true, directSessions: 1, supergroupTopics: 2 },
      },
      {
        name: 'Connected · DM only (no supergroup)',
        nameZh: '已连接 · 仅私信（无超级群组）',
        props: { telegramConnected: true, supergroupPaired: false, directSessions: 1, supergroupTopics: 0 },
      },
      {
        name: 'Connected · Supergroup with no topics yet',
        nameZh: '已连接 · 超级群组暂无话题',
        props: { telegramConnected: true, supergroupPaired: true, directSessions: 0, supergroupTopics: 0 },
      },
      {
        name: 'Connected · No bindings, no supergroup',
        nameZh: '已连接 · 无绑定、无超级群组',
        props: { telegramConnected: true, supergroupPaired: false, directSessions: 0, supergroupTopics: 0 },
      },
      {
        name: 'Disconnected',
        nameZh: '未连接',
        props: { telegramConnected: false, supergroupPaired: false, directSessions: 0, supergroupTopics: 0 },
      },
    ],
  },
  {
    id: 'messaging-settings-page',
    name: 'Messaging Settings Page',
    nameZh: '消息设置页',
    category: 'Messaging',
    description: 'Telegram + WhatsApp settings page with inline bindings',
    descriptionZh: '带内联绑定的 Telegram + WhatsApp 设置页',
    component: MessagingSettingsPagePreview,
    layout: 'full',
    props: [
      {
        name: 'telegramConnected',
        description: 'Whether the Telegram bot is connected',
        descriptionZh: 'Telegram 机器人是否已连接',
        control: { type: 'boolean' },
        defaultValue: false,
      },
      {
        name: 'whatsappConnected',
        description: 'Whether the WhatsApp adapter is connected',
        descriptionZh: 'WhatsApp 适配器是否已连接',
        control: { type: 'boolean' },
        defaultValue: false,
      },
      {
        name: 'bindings',
        description: 'Bindings preset to show in the table',
        descriptionZh: '要显示在表格中的绑定预设',
        control: {
          type: 'select',
          options: [
            { label: 'None', value: 'none' },
            { label: 'One binding', value: 'one' },
            { label: 'Many bindings', value: 'many' },
          ],
        },
        defaultValue: 'none',
      },
    ],
    variants: [
      {
        name: 'Both disconnected',
        nameZh: '均未连接',
        props: { telegramConnected: false, whatsappConnected: false, bindings: 'none' },
      },
      {
        name: 'Telegram only',
        nameZh: '仅 Telegram',
        props: { telegramConnected: true, whatsappConnected: false, bindings: 'none' },
      },
      {
        name: 'Both connected, no bindings',
        nameZh: '均已连接，无绑定',
        props: { telegramConnected: true, whatsappConnected: true, bindings: 'none' },
      },
      {
        name: 'Both connected, 3 bindings',
        nameZh: '均已连接，3 个绑定',
        props: { telegramConnected: true, whatsappConnected: true, bindings: 'many' },
      },
    ],
  },
  {
    id: 'messaging-pairing-code-dialog',
    name: 'Pairing Code Dialog',
    nameZh: '配对码对话框',
    category: 'Messaging',
    description: '6-digit pairing code modal (Telegram + WhatsApp)',
    descriptionZh: '6 位配对码弹窗（Telegram + WhatsApp）',
    component: PairingCodeDialogPreview,
    layout: 'centered',
    props: [
      {
        name: 'platform',
        description: 'Messaging platform',
        descriptionZh: '消息平台',
        control: {
          type: 'select',
          options: [
            { label: 'Telegram', value: 'telegram' },
            { label: 'WhatsApp', value: 'whatsapp' },
          ],
        },
        defaultValue: 'telegram',
      },
      {
        name: 'code',
        description: '6-digit pairing code (empty → "generating" state)',
        descriptionZh: '6 位配对码（为空 → “生成中”状态）',
        control: { type: 'string', placeholder: '482193' },
        defaultValue: '482193',
      },
      {
        name: 'expiresInSeconds',
        description: 'Seconds remaining until the code expires (-1 to hide the timer)',
        descriptionZh: '配对码过期前的剩余秒数（-1 隐藏倒计时）',
        control: { type: 'number', min: -1, max: 600, step: 1 },
        defaultValue: 300,
      },
      {
        name: 'botUsername',
        description: 'Telegram bot username (enables the "Open bot" link)',
        descriptionZh: 'Telegram 机器人用户名（启用“打开机器人”链接）',
        control: { type: 'string', placeholder: 'my_bot' },
        defaultValue: 'playground_bot',
      },
      {
        name: 'error',
        description: 'Error text to show in place of the code',
        descriptionZh: '代替配对码显示的错误文本',
        control: { type: 'string', placeholder: '' },
        defaultValue: '',
      },
    ],
    variants: [
      {
        name: 'Telegram with bot link',
        nameZh: '带机器人链接的 Telegram',
        props: {
          platform: 'telegram',
          code: '482193',
          expiresInSeconds: 300,
          botUsername: 'playground_bot',
          error: '',
        },
      },
      {
        name: 'WhatsApp',
        nameZh: 'WhatsApp',
        props: {
          platform: 'whatsapp',
          code: '482193',
          expiresInSeconds: 300,
          botUsername: '',
          error: '',
        },
      },
      {
        name: 'Loading (no code)',
        nameZh: '加载中（无配对码）',
        props: {
          platform: 'telegram',
          code: '',
          expiresInSeconds: -1,
          botUsername: '',
          error: '',
        },
      },
      {
        name: 'Error: rate limited',
        nameZh: '错误：请求过于频繁',
        props: {
          platform: 'telegram',
          code: '',
          expiresInSeconds: -1,
          botUsername: '',
          error: 'Too many pairing code requests. Please wait a moment and try again.',
        },
      },
      {
        name: 'Expired',
        nameZh: '已过期',
        props: {
          platform: 'telegram',
          code: '482193',
          expiresInSeconds: 0,
          botUsername: 'playground_bot',
          error: '',
        },
      },
    ],
  },
  {
    id: 'messaging-whatsapp-connect-dialog',
    name: 'WhatsApp Connect Dialog',
    nameZh: 'WhatsApp 连接对话框',
    category: 'Messaging',
    description: 'Baileys QR pairing modal with phase state machine',
    descriptionZh: '基于 Baileys 二维码配对的弹窗（带阶段状态机）',
    component: WhatsAppConnectDialogPreview,
    layout: 'centered',
    props: [
      {
        name: 'phase',
        description: 'Internal phase of the connect dialog',
        descriptionZh: '连接对话框的内部阶段',
        control: {
          type: 'select',
          options: [
            { label: 'Idle', value: 'idle' },
            { label: 'Starting', value: 'starting' },
            { label: 'Show QR', value: 'show_qr' },
            { label: 'Connected', value: 'connected' },
            { label: 'Error', value: 'error' },
          ],
        },
        defaultValue: 'show_qr',
      },
      {
        name: 'errorMessage',
        description: 'Error text (only used when phase = "error")',
        descriptionZh: '错误文本（仅 phase = “error” 时使用）',
        control: { type: 'string', placeholder: 'Pairing failed: ...' },
        defaultValue: 'Pairing failed: connection timed out',
      },
    ],
    variants: [
      { name: 'Idle', nameZh: '空闲', props: { phase: 'idle', errorMessage: '' } },
      { name: 'Starting', nameZh: '启动中', props: { phase: 'starting', errorMessage: '' } },
      { name: 'Show QR', nameZh: '显示二维码', props: { phase: 'show_qr', errorMessage: '' } },
      { name: 'Connected', nameZh: '已连接', props: { phase: 'connected', errorMessage: '' } },
      {
        name: 'Error',
        nameZh: '错误',
        props: { phase: 'error', errorMessage: 'Pairing failed: connection timed out' },
      },
    ],
  },
  {
    id: 'messaging-submenu',
    name: 'Messaging Submenu',
    nameZh: '消息子菜单',
    category: 'Messaging',
    description: 'Session menu → Connect Messaging submenu (Telegram / WhatsApp)',
    descriptionZh: '会话菜单 → 连接消息平台子菜单（Telegram / WhatsApp）',
    component: MessagingSubmenuPreview,
    layout: 'top',
    previewOverflow: 'visible',
    props: [
      {
        name: 'telegramConnected',
        description: 'Whether the Telegram bot is connected (changes flow)',
        descriptionZh: 'Telegram 机器人是否已连接（改变流程）',
        control: { type: 'boolean' },
        defaultValue: true,
      },
      {
        name: 'whatsappConnected',
        description: 'Whether the WhatsApp adapter is connected (changes flow)',
        descriptionZh: 'WhatsApp 适配器是否已连接（改变流程）',
        control: { type: 'boolean' },
        defaultValue: true,
      },
    ],
    variants: [
      {
        name: 'Both connected',
        nameZh: '均已连接',
        props: { telegramConnected: true, whatsappConnected: true },
      },
      {
        name: 'Nothing connected',
        nameZh: '均未连接',
        props: { telegramConnected: false, whatsappConnected: false },
      },
      {
        name: 'WhatsApp only',
        nameZh: '仅 WhatsApp',
        props: { telegramConnected: false, whatsappConnected: true },
      },
    ],
  },
]
