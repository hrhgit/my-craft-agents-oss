/**
 * ConfigStore — workspace-scoped messaging configuration persistence.
 *
 * Stored in `{storageDir}/state.sqlite`. Shape is `MessagingConfig`.
 */

import { DEFAULT_MESSAGING_CONFIG, type MessagingConfig, type MessagingLogger } from './types'
import { NOOP_LOGGER, SqliteRecordStore } from './sqlite-record-store'

export class ConfigStore extends SqliteRecordStore<MessagingConfig> {
  private config: MessagingConfig

  constructor(storageDir: string, logger: MessagingLogger = NOOP_LOGGER) {
    super(storageDir, 'config', logger)
    this.config = this.load()
  }

  get(): MessagingConfig {
    return { ...this.config, platforms: { ...this.config.platforms } }
  }

  update(partial: Partial<MessagingConfig>): MessagingConfig {
    const next: MessagingConfig = {
      enabled: partial.enabled ?? this.config.enabled,
      platforms: {
        ...this.config.platforms,
        ...(partial.platforms ?? {}),
      },
    }
    this.config = next
    this.saveRecord(this.config)
    return this.get()
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  private load(): MessagingConfig {
    const parsed = this.loadRecord()
    if (!parsed) {
      return { ...DEFAULT_MESSAGING_CONFIG, platforms: {} }
    }
    return {
      enabled: parsed.enabled ?? DEFAULT_MESSAGING_CONFIG.enabled,
      platforms: parsed.platforms ?? { ...DEFAULT_MESSAGING_CONFIG.platforms },
    }
  }
}
