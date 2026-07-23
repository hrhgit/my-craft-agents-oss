import { loadStoredConfig, saveConfig } from '../../storage.ts'

const [configDir, field, value] = process.argv.slice(2)
if (!configDir || !field || value === undefined) {
  throw new Error('Usage: multi-writer-config-worker.ts <configDir> <field> <value>')
}

const config = loadStoredConfig() ?? {
  workspaces: [],
  activeWorkspaceId: null,
  activeSessionId: null,
}

if (field === 'colorTheme') config.colorTheme = value
else if (field === 'notificationsEnabled') config.notificationsEnabled = value === 'true'
else throw new Error(`Unknown field: ${field}`)

await new Promise(resolve => setTimeout(resolve, 250))
saveConfig(config)
process.stdout.write(JSON.stringify({ field, value }))
