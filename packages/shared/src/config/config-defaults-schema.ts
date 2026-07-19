/**
 * TypeScript types for config-defaults.json
 *
 * Source of truth: apps/electron/resources/config-defaults.json
 * This file only defines types - the actual defaults come from the bundled JSON.
 */

import type { PermissionMode } from '../agent/mode-manager.ts';
import type { ThinkingLevel } from '../agent/thinking-levels.ts';
import type { PiExtensionSettings } from './pi-extension-settings.ts';

export interface ConfigDefaults {
  version: string;
  description: string;
  defaults: {
    notificationsEnabled: boolean;
    colorTheme: string;
    autoCapitalisation: boolean;
    sendMessageKey: 'enter' | 'cmd-enter';
    spellCheck: boolean;
    keepAwakeWhileRunning: boolean;
    richToolDescriptions: boolean;
    browserToolEnabled: boolean;
    dataSourcesEnabled: boolean;
    /**
     * Allow remote agents to call `browser_tool evaluate <expression>`.
     * When false, the local dispatcher rejects with `BROWSER_REMOTE_EVALUATE_BLOCKED`.
     */
    allowRemoteEvaluate: boolean;
    /**
     * Pi 扩展集成开关。
     * - enabled: 控制 pi 扩展相关 UI 组件的可见性。Pi RpcClient始终加载
     *   全局 pi 扩展，此字段不影响子进程行为。默认 true。
     * - delegatePromptAutomation: 为 true 时，automation 的 prompt 触发执行路径
     *   委托 pi prompt-automation 扩展处理。默认 false。
     */
    piExtensions: PiExtensionSettings;
    /**
     * Pi 壳模式开关。
     * - fullPassthrough: 完全 Pi 透传——使用 Pi 原生 system prompt，移除 Mortise 身份覆盖。
     *   默认 true。为 false 时回退到 Mortise 独立身份模式。
     */
    piShell: {
      fullPassthrough: boolean;
    };
  };
  workspaceDefaults: {
    thinkingLevel: ThinkingLevel;
    permissionMode: PermissionMode;
    cyclablePermissionModes: PermissionMode[];
    localMcpServers: {
      enabled: boolean;
    };
  };
}
