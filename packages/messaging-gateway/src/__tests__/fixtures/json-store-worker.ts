import { ConfigStore } from '../../config-store'

const [directory, platform] = process.argv.slice(2)
if (!directory || !platform) throw new Error('Usage: json-store-worker.ts <directory> <platform>')

const store = new ConfigStore(directory)
await new Promise(resolve => setTimeout(resolve, 250))
store.update({
  platforms: platform === 'telegram'
    ? { telegram: { enabled: true } }
    : { whatsapp: { enabled: true } },
})
process.stdout.write(platform)
