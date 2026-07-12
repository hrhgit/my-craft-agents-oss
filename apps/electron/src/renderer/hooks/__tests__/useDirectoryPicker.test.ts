import { describe, expect, it } from 'bun:test'
import { resolveDirectoryPickerTarget } from '../useDirectoryPicker'

describe('resolveDirectoryPickerTarget', () => {
  it('uses the server browser in WebUI before transport state is ready', () => {
    expect(resolveDirectoryPickerTarget(undefined, 'web', true)).toEqual({
      isRemote: true,
      serverBrowserMode: 'browse',
    })
  })

  it('uses manual server entry when an older remote server cannot browse', () => {
    expect(resolveDirectoryPickerTarget('remote', 'electron', false)).toEqual({
      isRemote: true,
      serverBrowserMode: 'manual',
    })
  })

  it('keeps an Electron local connection on the native dialog path', () => {
    expect(resolveDirectoryPickerTarget('local', 'electron', true)).toEqual({
      isRemote: false,
      serverBrowserMode: 'manual',
    })
  })

  it('uses the native dialog for client-hosted workspace folders in Electron', () => {
    expect(resolveDirectoryPickerTarget('remote', 'electron', true, 'client')).toEqual({
      isRemote: false,
      serverBrowserMode: 'manual',
    })
  })

  it('uses the server browser for client-hosted workspace folders in WebUI', () => {
    expect(resolveDirectoryPickerTarget('remote', 'web', true, 'client')).toEqual({
      isRemote: true,
      serverBrowserMode: 'browse',
    })
  })
})
