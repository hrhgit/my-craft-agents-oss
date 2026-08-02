export interface StartupFailureRuntimeEntry {
  scope: 'process'
  event: 'startup.failed'
  message: string
  meta?: {
    stack?: string
  }
}

export interface StartupFailureDependencies {
  isHeadless: boolean
  logError: (message: string, details: { message: string; stack?: string }) => void
  writeRuntimeError: (entry: StartupFailureRuntimeEntry) => void
  showErrorBox: (title: string, message: string) => void
  setExitCode: (code: number) => void
  quit: () => void
}

export function getStartupFailureMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

export function handleStartupFailure(error: unknown, dependencies: StartupFailureDependencies): void {
  const message = getStartupFailureMessage(error)
  const stack = error instanceof Error ? error.stack : undefined
  const details = { message, ...(stack ? { stack } : {}) }

  dependencies.logError('Failed to initialize app', details)
  dependencies.writeRuntimeError({
    scope: 'process',
    event: 'startup.failed',
    message,
    ...(stack ? { meta: { stack } } : {}),
  })

  try {
    if (!dependencies.isHeadless) {
      dependencies.showErrorBox('Mortise', `Mortise failed to start.\n\n${message}`)
    }
  } finally {
    dependencies.setExitCode(1)
    dependencies.quit()
  }
}
