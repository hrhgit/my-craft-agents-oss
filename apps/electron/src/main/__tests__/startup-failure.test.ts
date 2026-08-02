import { describe, expect, mock, test } from 'bun:test'
import { handleStartupFailure, type StartupFailureDependencies } from '../startup-failure'

function createDependencies(isHeadless = false): StartupFailureDependencies & {
  logError: ReturnType<typeof mock>
  writeRuntimeError: ReturnType<typeof mock>
  showErrorBox: ReturnType<typeof mock>
  setExitCode: ReturnType<typeof mock>
  quit: ReturnType<typeof mock>
} {
  return {
    isHeadless,
    logError: mock(() => {}),
    writeRuntimeError: mock(() => {}),
    showErrorBox: mock(() => {}),
    setExitCode: mock(() => {}),
    quit: mock(() => {}),
  }
}

describe('startup failure handling', () => {
  test('shows a visible error and quits a desktop startup', () => {
    const dependencies = createDependencies()
    const error = new Error('workspace identity does not match')

    handleStartupFailure(error, dependencies)

    expect(dependencies.showErrorBox).toHaveBeenCalledWith(
      'Mortise',
      'Mortise failed to start.\n\nworkspace identity does not match',
    )
    expect(dependencies.writeRuntimeError).toHaveBeenCalledWith(expect.objectContaining({
      scope: 'process',
      event: 'startup.failed',
      message: 'workspace identity does not match',
    }))
    expect(dependencies.setExitCode).toHaveBeenCalledWith(1)
    expect(dependencies.quit).toHaveBeenCalledTimes(1)
  })

  test('does not open a dialog in headless mode', () => {
    const dependencies = createDependencies(true)

    handleStartupFailure(new Error('server startup failed'), dependencies)

    expect(dependencies.showErrorBox).not.toHaveBeenCalled()
    expect(dependencies.setExitCode).toHaveBeenCalledWith(1)
    expect(dependencies.quit).toHaveBeenCalledTimes(1)
  })

  test('reports non-Error failures without hiding them', () => {
    const dependencies = createDependencies()

    handleStartupFailure('unexpected startup failure', dependencies)

    expect(dependencies.logError).toHaveBeenCalledWith('Failed to initialize app', {
      message: 'unexpected startup failure',
    })
    expect(dependencies.writeRuntimeError).toHaveBeenCalledWith({
      scope: 'process',
      event: 'startup.failed',
      message: 'unexpected startup failure',
    })
    expect(dependencies.showErrorBox).toHaveBeenCalledTimes(1)
  })
})
