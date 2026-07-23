import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MultiWriterStore } from '@mortise/shared/storage'
import { ConfigStore } from '../config-store'

const directories: string[] = []

function makeDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'mortise-messaging-sqlite-'))
  directories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('SqliteRecordStore authority', () => {
  it('does not import a legacy JSON file when the SQLite record is absent', () => {
    const directory = makeDirectory()
    const database = MultiWriterStore.openSync({
      databasePath: join(directory, 'state.sqlite'),
      writerId: 'authority-test',
      writerVersion: 1,
    })
    database.close()
    const legacyPath = join(directory, 'config.json')
    const legacy = JSON.stringify({ enabled: true, platforms: { telegram: { enabled: true } } })
    writeFileSync(legacyPath, legacy)

    const config = new ConfigStore(directory).get()

    expect(config.enabled).toBe(false)
    expect(config.platforms).toEqual({})
    expect(existsSync(join(directory, 'state.sqlite'))).toBe(true)
    expect(readFileSync(legacyPath, 'utf8')).toBe(legacy)
  })

  it('persists only to SQLite and does not materialize JSON compatibility files', () => {
    const directory = makeDirectory()

    new ConfigStore(directory).update({ enabled: true })

    expect(existsSync(join(directory, 'state.sqlite'))).toBe(true)
    expect(existsSync(join(directory, 'config.json'))).toBe(false)
    expect(existsSync(join(directory, 'config.json.sync'))).toBe(false)
    expect(new ConfigStore(directory).get().enabled).toBe(true)
  })

  it('does not patch an existing SQLite record from edited compatibility files', () => {
    const directory = makeDirectory()
    new ConfigStore(directory).update({ enabled: true })
    writeFileSync(
      join(directory, 'config.json'),
      JSON.stringify({ enabled: false, platforms: { telegram: { enabled: true } } }),
    )
    writeFileSync(join(directory, 'config.json.sync'), JSON.stringify({ enabled: true, platforms: {} }))

    const config = new ConfigStore(directory).get()

    expect(config.enabled).toBe(true)
    expect(config.platforms).toEqual({})
  })
})
