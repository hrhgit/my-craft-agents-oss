import type { ComponentEntry } from './types'
import { ApiKeyInput, type ApiKeySubmitData } from '@/components/apisetup/ApiKeyInput'

const logSubmit = (data: ApiKeySubmitData) => console.log('[Playground] Submit:', JSON.stringify(data, null, 2))

export const apiKeyInputComponents: ComponentEntry[] = [
  {
    id: 'api-key-custom-endpoint',
    name: 'Custom Endpoint',
    nameZh: '自定义端点',
    category: 'Agent Setup',
    description: 'ApiKeyInput with Custom preset — protocol toggle, base URL, and comma-separated models',
    descriptionZh: '使用自定义预设的 ApiKeyInput——协议切换、Base URL 和逗号分隔的模型列表',
    component: ApiKeyInput,
    props: [
      {
        name: 'status',
        description: 'Validation status',
        descriptionZh: '校验状态',
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
        description: 'Error message when status is error',
        descriptionZh: '状态为错误时的错误消息',
        control: { type: 'string', placeholder: 'Error message' },
        defaultValue: '',
      },
    ],
    variants: [
      {
        name: 'Empty (OpenAI compat)',
        nameZh: '空（OpenAI 兼容）',
        description: 'Custom preset, OpenAI protocol selected, no values filled',
        descriptionZh: '自定义预设，选择 OpenAI 协议，未填写任何值',
        props: {
          providerType: 'pi_api_key',
          initialValues: {
            activePreset: 'custom',
            baseUrl: 'https://your-endpoint.com/v1',
            customApi: 'openai-completions',
          },
        },
      },
      {
        name: 'Empty (Anthropic compat)',
        nameZh: '空（Anthropic 兼容）',
        description: 'Custom preset, Anthropic protocol selected',
        descriptionZh: '自定义预设，选择 Anthropic 协议',
        props: {
          providerType: 'pi_api_key',
          initialValues: {
            activePreset: 'custom',
            baseUrl: 'https://your-proxy.com',
            customApi: 'anthropic-messages',
          },
        },
      },
      {
        name: 'Alibaba DashScope (OpenAI)',
        nameZh: '阿里云 DashScope（OpenAI）',
        description: 'Alibaba/Qwen endpoint — OpenAI compatible with 3 models',
        descriptionZh: '阿里云/通义千问端点——OpenAI 兼容，含 3 个模型',
        props: {
          providerType: 'pi_api_key',
          initialValues: {
            activePreset: 'custom',
            baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
            providerDefaultModel: 'qwen3-coder-plus, qwen3-coder-flash, qwen-max',
            customApi: 'openai-completions',
          },
        },
      },
      {
        name: 'Ollama Local (OpenAI)',
        nameZh: 'Ollama 本地（OpenAI）',
        description: 'Local Ollama endpoint — OpenAI compatible',
        descriptionZh: '本地 Ollama 端点——OpenAI 兼容',
        props: {
          providerType: 'pi_api_key',
          initialValues: {
            activePreset: 'custom',
            baseUrl: 'http://localhost:11434/v1',
            providerDefaultModel: 'qwen3-coder',
            customApi: 'openai-completions',
          },
        },
      },
      {
        name: 'Anthropic Proxy',
        nameZh: 'Anthropic 代理',
        description: 'Custom Anthropic-compatible proxy endpoint',
        descriptionZh: '自定义 Anthropic 兼容代理端点',
        props: {
          providerType: 'pi_api_key',
          initialValues: {
            activePreset: 'custom',
            baseUrl: 'https://my-anthropic-proxy.internal/v1',
            providerDefaultModel: 'claude-sonnet-4-6',
            customApi: 'anthropic-messages',
          },
        },
      },
      {
        name: 'No Base URL (toggle hidden)',
        nameZh: '无 Base URL（切换隐藏）',
        description: 'Custom preset but no base URL — protocol toggle should not appear',
        descriptionZh: '自定义预设但没有 Base URL——不应显示协议切换',
        props: {
          providerType: 'pi_api_key',
          initialValues: {
            activePreset: 'custom',
          },
        },
      },
      {
        name: 'Validation Error',
        nameZh: '校验错误',
        description: 'Custom endpoint with connection error',
        descriptionZh: '自定义端点连接错误',
        props: {
          status: 'error',
          errorMessage: 'Connection failed: ECONNREFUSED 127.0.0.1:11434',
          providerType: 'pi_api_key',
          initialValues: {
            activePreset: 'custom',
            baseUrl: 'http://localhost:11434/v1',
            providerDefaultModel: 'qwen3-coder',
            customApi: 'openai-completions',
          },
        },
      },
    ],
    mockData: () => ({
      onSubmit: logSubmit,
      providerType: 'pi_api_key',
      initialValues: {
        activePreset: 'custom',
        baseUrl: 'https://your-endpoint.com/v1',
        customApi: 'openai-completions',
      },
    }),
  },
]


