/**
 * ConfigStore — workspace-scoped messaging config.json persistence.
 *
 * Stored at `{storageDir}/config.json`. Shape is `MessagingConfig`.
 */

import { DEFAULT_MESSAGING_CONFIG, type MessagingConfig, type MessagingLogger } from './types'
import { JsonFileStore, NOOP_LOGGER } from './json-file-store'

export class ConfigStore extends JsonFileStore<MessagingConfig> {
  private config: MessagingConfig

  constructor(storageDir: string, logger: MessagingLogger = NOOP_LOGGER) {
    super(storageDir, 'config.json', logger)
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
    this.saveFile(this.config)
    return this.get()
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  private load(): MessagingConfig {
    const parsed = this.loadFile()
    if (!parsed) {
      return { ...DEFAULT_MESSAGING_CONFIG, platforms: {} }
    }
    return {
      enabled: parsed.enabled ?? DEFAULT_MESSAGING_CONFIG.enabled,
      platforms: parsed.platforms ?? { ...DEFAULT_MESSAGING_CONFIG.platforms },
    }
  }
}
