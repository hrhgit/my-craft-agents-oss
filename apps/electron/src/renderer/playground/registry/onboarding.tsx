import type { ComponentEntry } from './types'
import { OnboardingFlowDemo } from '../demos/OnboardingFlowDemo'
import { ProviderSelectStep } from '@/components/onboarding/ProviderSelectStep'
import { WelcomeStep } from '@/components/onboarding/WelcomeStep'
import { APISetupStep } from '@/components/onboarding/APISetupStep'
import { CredentialsStep } from '@/components/onboarding/CredentialsStep'
import { CompletionStep } from '@/components/onboarding/CompletionStep'
import { GitBashWarning, type GitBashStatus } from '@/components/onboarding/GitBashWarning'
import { OnboardingWizard } from '@/components/onboarding/OnboardingWizard'
import type { OnboardingState } from '@/components/onboarding/OnboardingWizard'

const createOnboardingState = (overrides: Partial<OnboardingState> = {}): OnboardingState => ({
  step: 'welcome',
  loginStatus: 'idle',
  credentialStatus: 'idle',
  completionStatus: 'complete',
  apiSetupMethod: null,
  isExistingUser: false,
  gitBashStatus: { found: false, path: null, platform: 'win32' },
  isRecheckingGitBash: false,
  isCheckingGitBash: false,
  ...overrides,
})

const noopHandler = () => console.log('[Playground] Action triggered')

export const onboardingComponents: ComponentEntry[] = [
  {
    id: 'onboarding-flow-demo',
    name: 'Onboarding Flow (Interactive)',
    nameZh: '引导流程（可交互）',
    category: 'Onboarding',
    description: 'Click through the full onboarding: Welcome → Provider → Credentials → Done',
    descriptionZh: '点击走完完整引导流程：欢迎 → 提供商 → 凭证 → 完成',
    component: OnboardingFlowDemo,
    props: [],
    variants: [],
    layout: 'full',
  },
  {
    id: 'provider-select-step',
    name: 'ProviderSelectStep',
    category: 'Onboarding',
    description: 'First-launch screen — pick your subscription or API key',
    descriptionZh: '首次启动画面——选择订阅或 API 密钥',
    component: ProviderSelectStep,
    props: [],
    variants: [],
    mockData: () => ({
      onSelect: (choice: string) => console.log('[Playground] Provider selected:', choice),
      onSkip: () => console.log('[Playground] Setup deferred'),
    }),
  },
  {
    id: 'welcome-step',
    name: 'WelcomeStep',
    category: 'Onboarding',
    description: 'Initial welcome screen with feature overview',
    descriptionZh: '首次启动欢迎画面，含功能概览',
    component: WelcomeStep,
    props: [
      {
        name: 'isExistingUser',
        description: 'Show update settings message instead of welcome',
        descriptionZh: '显示更新设置提示而不是欢迎语',
        control: { type: 'boolean' },
        defaultValue: false,
      },
      {
        name: 'isLoading',
        description: 'Show loading state on continue button',
        descriptionZh: '在“继续”按钮上显示加载状态',
        control: { type: 'boolean' },
        defaultValue: false,
      },
    ],
    variants: [
      { name: 'New User', nameZh: '新用户', props: { isExistingUser: false } },
      { name: 'Existing User', nameZh: '已有用户', props: { isExistingUser: true } },
      { name: 'Loading', nameZh: '加载中', props: { isLoading: true } },
    ],
    mockData: () => ({
      onContinue: noopHandler,
    }),
  },
  {
    id: 'api-setup-step',
    name: 'APISetupStep',
    category: 'Onboarding',
    description: 'Choose payment method for AI usage with provider segmented control',
    descriptionZh: '通过提供商分段控件选择 AI 使用的付费方式',
    component: APISetupStep,
    props: [
      {
        name: 'selectedMethod',
        description: 'Currently selected API setup method',
        descriptionZh: '当前选择的 API 设置方式',
        control: {
          type: 'select',
          options: [
            { label: 'None', value: '' },
            { label: 'Pi API Key', value: 'pi_api_key' },
          ],
        },
        defaultValue: '',
      },
      {
        name: 'initialSegment',
        description: 'Initial provider segment to show',
        descriptionZh: '初始显示的提供商分段',
        control: {
          type: 'select',
          options: [
            { label: 'Pi', value: 'pi' },
          ],
        },
        defaultValue: 'pi',
      },
    ],
    variants: [
      { name: 'Pi Segment', nameZh: 'Pi 分段', props: { selectedMethod: null, initialSegment: 'pi' } },
      { name: 'Pi - API Key Selected', nameZh: 'Pi - 已选 API 密钥', props: { selectedMethod: 'pi_api_key', initialSegment: 'pi' } },
    ],
    mockData: () => ({
      onSelect: (method: string) => console.log('[Playground] Selected method:', method),
      onContinue: noopHandler,
      onBack: noopHandler,
    }),
  },
  {
    id: 'credentials-step-api-key',
    name: 'Credentials - API Key',
    nameZh: '凭证 - API 密钥',
    category: 'Onboarding',
    description: 'API key + optional Base URL and Model for compatible APIs',
    descriptionZh: '兼容 API 的 API 密钥 + 可选 Base URL 和模型',
    component: CredentialsStep,
    props: [
      {
        name: 'status',
        description: 'Credential validation status',
        descriptionZh: '凭证校验状态',
        control: {
          type: 'select',
          options: [
            { label: 'Idle', value: 'idle' },
            { label: 'Validating', value: 'validating' },
            { label: 'Success', value: 'success' },
            { label: 'Error', value: 'error' },
          ],
        },
        defaultValue: 'idle',
      },
      {
        name: 'errorMessage',
        description: 'Error message to display',
        descriptionZh: '要显示的错误消息',
        control: { type: 'string', placeholder: 'Error message' },
        defaultValue: '',
      },
    ],
    variants: [
      { name: 'Idle', nameZh: '空闲', props: { apiSetupMethod: 'pi_api_key', status: 'idle' } },
      { name: 'Validating', nameZh: '校验中', props: { apiSetupMethod: 'pi_api_key', status: 'validating' } },
      { name: 'Success', nameZh: '成功', props: { apiSetupMethod: 'pi_api_key', status: 'success' } },
      { name: 'Error', nameZh: '错误', props: { apiSetupMethod: 'pi_api_key', status: 'error', errorMessage: 'Invalid API key. Please check and try again.' } },
    ],
    mockData: () => ({
      apiSetupMethod: 'pi_api_key',
      onSubmit: (data: { apiKey: string; baseUrl?: string; providerDefaultModel?: string; models?: string[] }) => console.log('[Playground] Submitted:', data),
      onBack: noopHandler,
    }),
  },
  {
    id: 'completion-step',
    name: 'CompletionStep',
    category: 'Onboarding',
    description: 'Success screen after completing onboarding',
    descriptionZh: '完成引导后的成功画面',
    component: CompletionStep,
    props: [
      {
        name: 'status',
        description: 'Completion status',
        descriptionZh: '完成状态',
        control: {
          type: 'select',
          options: [
            { label: 'Saving', value: 'saving' },
            { label: 'Complete', value: 'complete' },
          ],
        },
        defaultValue: 'complete',
      },
    ],
    variants: [
      { name: 'Saving', nameZh: '保存中', props: { status: 'saving' } },
      { name: 'Complete', nameZh: '完成', props: { status: 'complete' } },
    ],
    mockData: () => ({
      onFinish: noopHandler,
    }),
  },
  {
    id: 'git-bash-warning',
    name: 'GitBashWarning',
    category: 'Onboarding',
    description: 'Warning screen when Git Bash is not found on Windows',
    descriptionZh: '在 Windows 上未找到 Git Bash 时的警告画面',
    component: GitBashWarning,
    props: [
      {
        name: 'isRechecking',
        description: 'Show loading state on re-check button',
        descriptionZh: '在“重新检查”按钮上显示加载状态',
        control: { type: 'boolean' },
        defaultValue: false,
      },
    ],
    variants: [
      {
        name: 'Not Found',
        nameZh: '未找到',
        props: {
          status: { found: false, path: null, platform: 'win32' } as GitBashStatus,
        },
      },
      {
        name: 'Rechecking',
        nameZh: '重新检查中',
        props: {
          status: { found: false, path: null, platform: 'win32' } as GitBashStatus,
          isRechecking: true,
        },
      },
      {
        name: 'With Suggested Path',
        nameZh: '带建议路径',
        props: {
          status: { found: false, path: 'C:\\Program Files\\Git\\bin\\bash.exe', platform: 'win32' } as GitBashStatus,
        },
      },
      {
        name: 'With Error',
        nameZh: '带错误',
        props: {
          status: { found: false, path: null, platform: 'win32' } as GitBashStatus,
          errorMessage: 'File does not exist at the specified path',
        },
      },
    ],
    mockData: () => ({
      status: { found: false, path: null, platform: 'win32' } as GitBashStatus,
      onBrowse: async () => {
        console.log('[Playground] Browse clicked')
        return 'C:\\Program Files\\Git\\bin\\bash.exe'
      },
      onUsePath: (path: string) => console.log('[Playground] Use path:', path),
      onRecheck: noopHandler,
      onBack: noopHandler,
      onClearError: noopHandler,
    }),
  },
  {
    id: 'onboarding-wizard',
    name: 'OnboardingWizard',
    category: 'Onboarding',
    description: 'Full-screen onboarding flow container with all steps',
    descriptionZh: '包含所有步骤的全屏引导流程容器',
    component: OnboardingWizard,
    props: [],
    variants: [
      {
        name: 'Welcome (New User)',
        nameZh: '欢迎（新用户）',
        props: {
          state: createOnboardingState({ step: 'welcome', isExistingUser: false }),
        },
      },
      {
        name: 'Welcome (Existing User)',
        nameZh: '欢迎（已有用户）',
        props: {
          state: createOnboardingState({ step: 'welcome', isExistingUser: true }),
        },
      },
      {
        name: 'Git Bash Warning',
        nameZh: 'Git Bash 警告',
        props: {
          state: createOnboardingState({ step: 'git-bash' }),
        },
      },
      {
        name: 'Git Bash Warning (Rechecking)',
        nameZh: 'Git Bash 警告（重新检查中）',
        props: {
          state: createOnboardingState({ step: 'git-bash', isRecheckingGitBash: true }),
        },
      },
      {
        name: 'Credentials - API Key',
        nameZh: '凭证 - API 密钥',
        props: {
          state: createOnboardingState({ step: 'credentials', apiSetupMethod: 'pi_api_key' }),
        },
      },
      {
        name: 'Complete - Saving',
        nameZh: '完成 - 保存中',
        props: {
          state: createOnboardingState({ step: 'complete', completionStatus: 'saving' }),
        },
      },
      {
        name: 'Complete - Done',
        nameZh: '完成 - 已完成',
        props: {
          state: createOnboardingState({
            step: 'complete',
            completionStatus: 'complete',
          }),
        },
      },
    ],
    mockData: () => ({
      state: createOnboardingState(),
      className: 'min-h-0 h-full',
      onContinue: noopHandler,
      onBack: noopHandler,
      onSelectApiSetupMethod: (method: string) => console.log('[Playground] Selected method:', method),
      onSubmitCredential: (data: { apiKey: string; baseUrl?: string; providerDefaultModel?: string; models?: string[] }) => console.log('[Playground] Submitted:', data),
      onFinish: noopHandler,
      onBrowseGitBash: async () => {
        console.log('[Playground] Browse Git Bash clicked')
        return 'C:\\Program Files\\Git\\bin\\bash.exe'
      },
      onUseGitBashPath: (path: string) => console.log('[Playground] Use Git Bash path:', path),
      onRecheckGitBash: noopHandler,
      onClearError: noopHandler,
      onSkipSetup: () => console.log('[Playground] Setup deferred'),
    }),
  },
]


