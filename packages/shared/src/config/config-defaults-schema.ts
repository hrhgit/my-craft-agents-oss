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
    extendedPromptCache: boolean;
    browserToolEnabled: boolean;
    /**
     * Allow remote agents to call `browser_tool evaluate <expression>`.
     * When false, the local dispatcher rejects with `BROWSER_REMOTE_EVALUATE_BLOCKED`.
     */
    allowRemoteEvaluate: boolean;
    /**
     * Pi 扩展集成开关。
     * - enabled: 控制是否加载全局 pi 扩展（~/.pi/agent/extensions/）。默认 true。
     *   为 false 时回退到隔离模式（agentDir 指向 session 临时目录）。
     * - delegatePromptAutomation: 为 true 时，automation 的 prompt 触发执行路径
     *   委托 pi prompt-automation 扩展处理。默认 false。
     */
    piExtensions: PiExtensionSettings;
    /**
     * Pi 壳模式开关。
     * - fullPassthrough: 完全 Pi 透传——使用 Pi 原生 system prompt，移除 Craft 身份覆盖。
     *   默认 true。为 false 时回退到 Craft 独立身份模式。
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
