import { copyFile, mkdir } from 'node:fs/promises'

await mkdir(new URL('./dist/ui/', import.meta.url), { recursive: true })
await Promise.all([
  copyFile(new URL('./src/toolbar.css', import.meta.url), new URL('./dist/ui/toolbar.css', import.meta.url)),
  copyFile(new URL('./src/conversation-review.css', import.meta.url), new URL('./dist/ui/conversation-review.css', import.meta.url)),
  copyFile(new URL('./src/settings.css', import.meta.url), new URL('./dist/ui/settings.css', import.meta.url)),
])
