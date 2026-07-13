/**
 * InputSettingsPage
 *
 * Input behavior settings that control how the chat input works.
 *
 * Settings:
 * - Auto Capitalisation (on/off)
 * - Spell Check (on/off)
 * - Send Message Key (Enter or ⌘+Enter)
 */

import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { ScrollArea } from '@/components/ui/scroll-area'
import { HeaderMenu } from '@/components/ui/HeaderMenu'
import { routes } from '@/lib/navigate'
import { isMac } from '@/lib/platform'
import type { DetailsPageMeta } from '@/lib/navigation-registry'
import type { MidStreamBehavior } from '@craft-agent/shared/config/midstream-behavior'

import {
  SettingsSection,
  SettingsCard,
  SettingsToggle,
  SettingsMenuSelectRow,
  SettingsRow,
  SettingsSegmentedControl,
} from '@/components/settings'

export const meta: DetailsPageMeta = {
  navigator: 'settings',
  slug: 'input',
}

// ============================================
// Main Component
// ============================================

export default function InputSettingsPage() {
  const { t } = useTranslation()

  // Auto-capitalisation state
  const [autoCapitalisation, setAutoCapitalisation] = useState(true)

  // Spell check state (default off)
  const [spellCheck, setSpellCheck] = useState(false)

  // Send message key state
  const [sendMessageKey, setSendMessageKey] = useState<'enter' | 'cmd-enter'>('enter')

  // Follow-up behavior while a response is streaming
  const [midStreamBehavior, setMidStreamBehaviorState] = useState<MidStreamBehavior>('queue')
  const [isLoadingMidStreamBehavior, setIsLoadingMidStreamBehavior] = useState(true)
  const alternateSendKey = isMac ? '⌘+Enter' : 'Ctrl+Enter'

  // Load settings on mount
  useEffect(() => {
    const loadSettings = async () => {
      if (!window.electronAPI) return
      try {
        const [autoCapEnabled, spellCheckEnabled, sendKey, followUpBehavior] = await Promise.all([
          window.electronAPI.getAutoCapitalisation(),
          window.electronAPI.getSpellCheck(),
          window.electronAPI.getSendMessageKey(),
          window.electronAPI.getMidStreamBehavior(),
        ])
        setAutoCapitalisation(autoCapEnabled)
        setSpellCheck(spellCheckEnabled)
        setSendMessageKey(sendKey)
        setMidStreamBehaviorState(followUpBehavior)
      } catch (error) {
        console.error('Failed to load input settings:', error)
      } finally {
        setIsLoadingMidStreamBehavior(false)
      }
    }
    loadSettings()
  }, [])

  const handleAutoCapitalisationChange = useCallback(async (enabled: boolean) => {
    setAutoCapitalisation(enabled)
    await window.electronAPI.setAutoCapitalisation(enabled)
  }, [])

  const handleSpellCheckChange = useCallback(async (enabled: boolean) => {
    setSpellCheck(enabled)
    await window.electronAPI.setSpellCheck(enabled)
  }, [])

  const handleSendMessageKeyChange = useCallback((value: string) => {
    const key = value as 'enter' | 'cmd-enter'
    setSendMessageKey(key)
    window.electronAPI.setSendMessageKey(key)
  }, [])

  const handleMidStreamBehaviorChange = useCallback(async (value: MidStreamBehavior) => {
    const previous = midStreamBehavior
    setMidStreamBehaviorState(value)
    try {
      const result = await window.electronAPI.setMidStreamBehavior(value)
      if (!result.success) {
        setMidStreamBehaviorState(previous)
        toast.error(t('settings.ai.midStream.updateFailed'), { description: result.error })
      }
    } catch (error) {
      setMidStreamBehaviorState(previous)
      console.error('Failed to update mid-stream behavior:', error)
      toast.error(t('settings.ai.midStream.updateFailed'))
    }
  }, [midStreamBehavior, t])

  return (
    <div className="h-full flex flex-col">
      <PanelHeader title={t("settings.input.title")} actions={<HeaderMenu route={routes.view.settings('input')} />} />
      <div className="flex-1 min-h-0 mask-fade-y">
        <ScrollArea className="h-full">
          <div className="px-5 py-7 max-w-3xl mx-auto">
            <div className="space-y-8">
              {/* Typing Behavior */}
              <SettingsSection title={t("settings.input.typing")} description={t("settings.input.typingDesc")}>
                <SettingsCard>
                  <SettingsToggle
                    label={t("settings.input.autoCapitalisation")}
                    description={t("settings.input.autoCapitalisationDesc")}
                    checked={autoCapitalisation}
                    onCheckedChange={handleAutoCapitalisationChange}
                  />
                  <SettingsToggle
                    label={t("settings.input.spellCheck")}
                    description={t("settings.input.spellCheckDesc")}
                    checked={spellCheck}
                    onCheckedChange={handleSpellCheckChange}
                  />
                </SettingsCard>
              </SettingsSection>

              {/* Send Behavior */}
              <SettingsSection title={t("settings.input.sending")} description={t("settings.input.sendingDesc")}>
                <SettingsCard>
                  <SettingsMenuSelectRow
                    label={t("settings.input.sendMessageWith")}
                    description={t("settings.input.sendMessageWithDesc")}
                    value={sendMessageKey}
                    onValueChange={handleSendMessageKeyChange}
                    options={[
                      { value: 'enter', label: t("settings.input.enterKey"), description: t("settings.input.enterKeyDesc") },
                      { value: 'cmd-enter', label: isMac ? t("settings.input.cmdEnterKey") : t("settings.input.ctrlEnterKey"), description: t("settings.input.cmdEnterKeyDesc") },
                    ]}
                  />
                  <SettingsRow
                    label={t('settings.ai.midStream.title')}
                    description={t('settings.ai.midStream.description', { alternateKey: alternateSendKey })}
                    descriptionClassName="whitespace-normal overflow-visible text-clip"
                  >
                    <SettingsSegmentedControl
                      value={midStreamBehavior}
                      onValueChange={handleMidStreamBehaviorChange}
                      disabled={isLoadingMidStreamBehavior}
                      variant="pill"
                      size="md"
                      options={[
                        { value: 'queue', label: t('settings.ai.midStream.queue') },
                        { value: 'steer', label: t('settings.ai.midStream.steer') },
                      ]}
                    />
                  </SettingsRow>
                </SettingsCard>
              </SettingsSection>
            </div>
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}
