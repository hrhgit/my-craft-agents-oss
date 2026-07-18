import { requestCraftUiHost } from '../../craft-ui/client.ts'
import { startCraftUiRun, stopCraftUiRun } from '../../craft-ui/controller.ts'

interface SnapshotNode {
  ref: string
  semanticId?: string
  role: string
  name: string
  value?: string
  actions: string[]
  bounds?: { x: number; y: number; width: number; height: number }
}

interface SnapshotResult {
  revision: number
  regions: Record<string, SnapshotNode[]>
}

interface IncrementalSnapshotResult {
  revision: number
  full: boolean
  changes: { added: unknown[]; updated: unknown[]; removed: unknown[] }
}

interface NativeSnapshotResult {
  revision: number
  windows: Array<{ nodes: Array<{ ref: string; role: string; name: string; actions: string[] }> }>
}

interface NativeDialogOpenResult {
  dialogId: string
  nativeRevision: number
  nativeTarget: { ref: string; role: string; name: string; actions: string[] }
}

interface NativeMenuSnapshotResult {
  revision: number
  nodes: Array<{ ref: string; role: string; name: string; enabled: boolean; accelerator?: string; actions: string[] }>
}

const manifest = await startCraftUiRun({
  surface: 'electron',
  profileMode: 'fixture',
  windowMode: 'foreground',
  waitMs: 180_000,
})

try {
  let nativeVerificationLevel: string | undefined
  if (process.platform === 'win32') {
    const nativeSnapshot = await requestCraftUiHost<NativeSnapshotResult>({
      ...manifest,
      command: 'ui.native',
      params: { operation: 'snapshot' },
      timeoutMs: 30_000,
    })
    if (!nativeSnapshot.ok) throw new Error(`Native snapshot failed: ${nativeSnapshot.error.message}`)
    const nativeWindow = nativeSnapshot.result.windows.flatMap(window => window.nodes)
      .find(node => node.role === 'Window' && node.actions.includes('focus'))
    if (!nativeWindow) throw new Error('Windows UI Automation did not expose a focusable Craft window.')
    const nativeAction = await requestCraftUiHost({
      ...manifest,
      command: 'ui.action',
      params: { mode: 'native', revision: nativeSnapshot.result.revision, target: { kind: 'native', ref: nativeWindow.ref }, action: 'focus' },
      timeoutMs: 30_000,
    })
    if (!nativeAction.ok || nativeAction.verificationLevel !== 'native-verified') {
      throw new Error(nativeAction.ok ? 'Native action did not produce native verification.' : nativeAction.error.message)
    }
    nativeVerificationLevel = nativeAction.verificationLevel

    const dialogTitle = `Craft UI Validation Folder ${manifest.runId.slice(-8)}`
    const openedDialog = await requestCraftUiHost<NativeDialogOpenResult>({
      ...manifest,
      command: 'ui.native',
      params: { operation: 'dialog.open', kind: 'open-directory', title: dialogTitle, timeoutMs: 30_000 },
      timeoutMs: 35_000,
    })
    if (!openedDialog.ok || openedDialog.result.nativeTarget.name !== dialogTitle || !openedDialog.result.nativeTarget.actions.includes('close')) {
      throw new Error(openedDialog.ok ? 'Native folder dialog did not expose a closable UIA window.' : openedDialog.error.message)
    }
    const closeDialog = await requestCraftUiHost({
      ...manifest,
      command: 'ui.action',
      params: {
        mode: 'native', revision: openedDialog.result.nativeRevision,
        target: { kind: 'native', ref: openedDialog.result.nativeTarget.ref }, action: 'close',
      },
      timeoutMs: 30_000,
    })
    if (!closeDialog.ok || closeDialog.verificationLevel !== 'native-verified') {
      throw new Error(closeDialog.ok ? 'Native dialog close did not produce native verification.' : closeDialog.error.message)
    }
    const dialogStatus = await requestCraftUiHost<{ phase: string; canceled?: boolean }>({
      ...manifest,
      command: 'ui.native',
      params: { operation: 'dialog.wait', dialogId: openedDialog.result.dialogId, timeoutMs: 30_000 },
      timeoutMs: 30_000,
    })
    if (!dialogStatus.ok || dialogStatus.result.phase !== 'completed' || dialogStatus.result.canceled !== true) {
      throw new Error(dialogStatus.ok ? 'Native folder dialog did not report a canceled completion.' : dialogStatus.error.message)
    }

    const menuSnapshot = await requestCraftUiHost<NativeMenuSnapshotResult>({
      ...manifest,
      command: 'ui.native',
      params: { operation: 'menu.snapshot' },
      timeoutMs: 30_000,
    })
    if (!menuSnapshot.ok) {
      if (menuSnapshot.error.code !== 'UNSUPPORTED') throw new Error(`Native menu snapshot failed: ${menuSnapshot.error.message}`)
    } else {
      const reloadItem = menuSnapshot.result.nodes.find(node =>
        node.accelerator === 'CmdOrCtrl+R' && node.enabled && node.actions.includes('click'),
      )
      if (!reloadItem) throw new Error('Electron application menu did not expose the development Reload command.')
      const menuAction = await requestCraftUiHost({
        ...manifest,
        command: 'ui.native',
        params: {
          operation: 'menu.action',
          revision: menuSnapshot.result.revision,
          target: { ref: reloadItem.ref },
          action: 'click',
        },
        timeoutMs: 30_000,
      })
      if (!menuAction.ok || menuAction.verificationLevel !== 'native-verified') {
        throw new Error(menuAction.ok ? 'Electron menu action did not produce native verification.' : menuAction.error.message)
      }
      const reloaded = await requestCraftUiHost({
        ...manifest,
        command: 'ui.wait',
        params: { predicate: { kind: 'semantic-ready' }, timeoutMs: 60_000, stableForMs: 100 },
        timeoutMs: 65_000,
      })
      if (!reloaded.ok) throw new Error(`Renderer did not recover after the native Reload command: ${reloaded.error.message}`)
    }
  }

  const scenario = await requestCraftUiHost({
    ...manifest,
    command: 'scenario.apply',
    params: { name: 'remote-ui-composer' },
  })
  if (!scenario.ok) throw new Error(`Scenario failed: ${scenario.error.message}`)

  const snapshotResponse = await requestCraftUiHost<SnapshotResult>({
    ...manifest,
    command: 'ui.snapshot',
  })
  if (!snapshotResponse.ok) throw new Error(`Snapshot failed: ${snapshotResponse.error.message}`)
  const snapshot = snapshotResponse.result
  const unchangedResponse = await requestCraftUiHost<IncrementalSnapshotResult>({
    ...manifest,
    command: 'ui.snapshot',
    params: { sinceRevision: snapshot.revision },
  })
  if (!unchangedResponse.ok) throw new Error(`Incremental snapshot failed: ${unchangedResponse.error.message}`)
  if (unchangedResponse.result.revision !== snapshot.revision || unchangedResponse.result.full || Object.values(unchangedResponse.result.changes).some(items => items.length > 0)) {
    throw new Error('An unchanged UI produced a new revision or non-empty incremental snapshot.')
  }
  const target = Object.values(snapshot.regions).flat().find((node) => node.role === 'radio' && node.name === 'Rapid prototype')
  if (!target) throw new Error('Physical smoke target was not present in the semantic snapshot.')

  const action = await requestCraftUiHost({
    ...manifest,
    command: 'ui.action',
    params: { revision: snapshot.revision, ref: target.ref, action: 'click' },
  })
  if (!action.ok || action.verificationLevel !== 'renderer-verified') {
    throw new Error(action.ok ? 'Physical action did not produce renderer verification.' : action.error.message)
  }

  const assertion = await requestCraftUiHost({
    ...manifest,
    command: 'ui.assert',
    params: { predicate: { kind: 'node', target: { role: 'radio', name: 'Rapid prototype' }, state: 'checked', equals: true } },
  })
  if (!assertion.ok) throw new Error(`Assertion failed: ${assertion.error.message}`)

  const imeScenario = await requestCraftUiHost({
    ...manifest,
    command: 'scenario.apply',
    params: { name: 'remote-ui-composer', variant: 'Direct input' },
  })
  if (!imeScenario.ok) throw new Error(`IME scenario failed: ${imeScenario.error.message}`)
  const imeSnapshotResponse = await requestCraftUiHost<SnapshotResult>({ ...manifest, command: 'ui.snapshot' })
  if (!imeSnapshotResponse.ok) throw new Error(`IME snapshot failed: ${imeSnapshotResponse.error.message}`)
  const imeSnapshot = imeSnapshotResponse.result
  const textbox = Object.values(imeSnapshot.regions).flat().find((node) => node.role === 'textbox')
  if (!textbox) throw new Error('IME scenario did not expose a textbox.')
  const ime = await requestCraftUiHost({
    ...manifest,
    command: 'ui.action',
    params: { revision: imeSnapshot.revision, target: { ref: textbox.ref }, action: 'ime', value: '中文输入' },
  })
  if (!ime.ok) throw new Error(`IME action failed: ${ime.error.message}`)
  const imeResultResponse = await requestCraftUiHost<SnapshotResult>({ ...manifest, command: 'ui.snapshot' })
  if (!imeResultResponse.ok) throw new Error(`IME result snapshot failed: ${imeResultResponse.error.message}`)
  const composed = Object.values(imeResultResponse.result.regions).flat().find((node) => node.role === 'textbox')
  if (!composed?.value?.includes('中文输入')) throw new Error(`IME composition was not reflected in the UI value: ${composed?.value ?? '(empty)'}`)

  const shortcut = await requestCraftUiHost({
    ...manifest,
    command: 'ui.action',
    params: { revision: imeResultResponse.result.revision, target: { ref: composed.ref }, action: 'shortcut', key: 'A', modifiers: ['control'], mode: 'physical' },
  })
  if (!shortcut.ok || shortcut.verificationLevel !== 'renderer-verified') throw new Error(shortcut.ok ? 'Shortcut was not renderer-verified.' : shortcut.error.message)
  const clipboardSnapshot = await requestCraftUiHost<SnapshotResult>({ ...manifest, command: 'ui.snapshot' })
  if (!clipboardSnapshot.ok) throw new Error(clipboardSnapshot.error.message)
  const clipboardTarget = Object.values(clipboardSnapshot.result.regions).flat().find(node => node.role === 'textbox')
  if (!clipboardTarget) throw new Error('Clipboard target disappeared.')
  const clipboard = await requestCraftUiHost({
    ...manifest,
    command: 'ui.action',
    params: { revision: clipboardSnapshot.result.revision, target: { ref: clipboardTarget.ref }, action: 'clipboard', value: 'clipboard validation', mode: 'physical' },
  })
  if (!clipboard.ok || clipboard.verificationLevel !== 'renderer-verified') throw new Error(clipboard.ok ? 'Clipboard was not renderer-verified.' : clipboard.error.message)
  const richSnapshot = await requestCraftUiHost<SnapshotResult>({ ...manifest, command: 'ui.snapshot' })
  if (!richSnapshot.ok) throw new Error(richSnapshot.error.message)
  const richTarget = Object.values(richSnapshot.result.regions).flat().find(node => node.role === 'textbox')
  if (!richTarget) throw new Error('Rich-text target disappeared.')
  const richText = await requestCraftUiHost({
    ...manifest,
    command: 'ui.action',
    params: { revision: richSnapshot.result.revision, target: { ref: richTarget.ref }, action: 'rich-text', value: 'rich text validation', mode: 'physical' },
  })
  if (!richText.ok || richText.verificationLevel !== 'renderer-verified') throw new Error(richText.ok ? 'Rich-text was not renderer-verified.' : richText.error.message)

  const semanticScenario = await requestCraftUiHost({
    ...manifest,
    command: 'scenario.apply',
    params: { name: 'slash-command-demo' },
  })
  if (!semanticScenario.ok) throw new Error(`Business semantic scenario failed: ${semanticScenario.error.message}`)
  const semanticSnapshotResponse = await requestCraftUiHost<SnapshotResult>({ ...manifest, command: 'ui.snapshot' })
  if (!semanticSnapshotResponse.ok) throw new Error(`Business semantic snapshot failed: ${semanticSnapshotResponse.error.message}`)
  const semanticSnapshot = semanticSnapshotResponse.result
  const semanticNodes = Object.values(semanticSnapshot.regions).flat()
  const semanticInput = semanticNodes.find(node => node.semanticId === 'composer.playground-session.input')
  if (!semanticInput || !semanticInput.ref.includes('business.composer.playground-session.input')) {
    throw new Error('The composer input was not merged with its stable business semantic identity.')
  }
  const semanticFill = await requestCraftUiHost({
    ...manifest,
    command: 'ui.action',
    params: { revision: semanticSnapshot.revision, target: { ref: semanticInput.ref }, action: 'fill', mode: 'semantic', value: 'private validation prompt' },
  })
  if (!semanticFill.ok || semanticFill.verificationLevel !== 'scenario-verified') {
    throw new Error(semanticFill.ok ? 'Semantic fill was assigned the wrong verification level.' : semanticFill.error.message)
  }
  const redactedResponse = await requestCraftUiHost<SnapshotResult>({ ...manifest, command: 'ui.snapshot' })
  if (!redactedResponse.ok) throw new Error(`Redacted snapshot failed: ${redactedResponse.error.message}`)
  const redactedInput = Object.values(redactedResponse.result.regions).flat().find(node => node.semanticId === 'composer.playground-session.input')
  if (redactedInput?.value !== '[REDACTED]') throw new Error('Sensitive composer value leaked through the business semantic snapshot.')
  const physicalFocus = await requestCraftUiHost<{ observed?: { hit?: boolean; focused?: boolean }; mode?: string }>({
    ...manifest,
    command: 'ui.action',
    params: { revision: redactedResponse.result.revision, target: { ref: redactedInput.ref }, action: 'click', mode: 'physical' },
  })
  if (!physicalFocus.ok || physicalFocus.verificationLevel !== 'renderer-verified' || physicalFocus.result.mode !== 'physical'
    || physicalFocus.result.observed?.hit !== true || physicalFocus.result.observed?.focused !== true) {
    throw new Error(physicalFocus.ok ? 'Physical stable target did not return hit/focus renderer evidence.' : physicalFocus.error.message)
  }

  const dragScenario = await requestCraftUiHost({ ...manifest, command: 'scenario.apply', params: { name: 'planner-things-board' } })
  if (!dragScenario.ok) throw new Error(`Drag scenario failed: ${dragScenario.error.message}`)
  const dragSnapshot = await requestCraftUiHost<SnapshotResult>({ ...manifest, command: 'ui.snapshot' })
  if (!dragSnapshot.ok) throw new Error(dragSnapshot.error.message)
  const draggable = Object.values(dragSnapshot.result.regions).flat()
    .filter(node => node.semanticId?.startsWith('planner.task.') && node.bounds && node.actions.includes('drag'))
  if (draggable.length < 3) throw new Error('Planner scenario did not expose three typed draggable task rows.')
  // Cross a complete intervening row so the physical simulation clears the
  // sortable collision threshold instead of depending on adjacent-row jitter.
  const dragSource = draggable[0]
  const dragDestination = draggable[2]
  const destination = dragDestination!.bounds!
  const dragged = await requestCraftUiHost({
    ...manifest,
    command: 'ui.action',
    params: {
      revision: dragSnapshot.result.revision,
      target: { ref: dragSource!.ref },
      action: 'drag', mode: 'physical',
      to: { x: destination.x + destination.width / 2, y: destination.y + destination.height * 0.8 },
    },
  })
  if (!dragged.ok || dragged.verificationLevel !== 'renderer-verified') throw new Error(dragged.ok ? 'Drag was not renderer-verified.' : dragged.error.message)
  const reordered = await requestCraftUiHost<SnapshotResult>({ ...manifest, command: 'ui.snapshot' })
  if (!reordered.ok) throw new Error(reordered.error.message)
  const reorderedIds = Object.values(reordered.result.regions).flat().filter(node => node.semanticId?.startsWith('planner.task.')).map(node => node.semanticId)
  if (reorderedIds.indexOf(dragSource!.semanticId) <= reorderedIds.indexOf(dragDestination!.semanticId)) {
    throw new Error('Physical drag completed without changing the real Planner row order.')
  }

  const evidence = await requestCraftUiHost({
    ...manifest,
    command: 'evidence.capture',
    params: { label: 'electron-ui-validation-smoke' },
  })
  if (!evidence.ok) throw new Error(`Evidence capture failed: ${evidence.error.message}`)

  process.stdout.write(`${JSON.stringify({
    ok: true,
    runId: manifest.runId,
    verificationLevel: action.verificationLevel,
    nativeVerificationLevel,
    evidence: evidence.result,
  })}\n`)
} catch (error) {
  try {
    const failure = await requestCraftUiHost<{ bundleDir: string }>({
      ...manifest,
      command: 'evidence.capture',
      params: { label: 'electron-e2e-client-failure' },
      timeoutMs: 30_000,
    })
    if (failure.ok) process.stderr.write(`Electron UI validation failure evidence: ${failure.result.bundleDir}\n`)
  } catch (evidenceError) {
    process.stderr.write(`Unable to capture Electron UI validation failure evidence: ${String(evidenceError)}\n`)
  }
  throw error
} finally {
  await stopCraftUiRun(manifest.runDir)
}
