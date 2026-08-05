import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'

describe('extension UI content security policy', () => {
  for (const page of ['index.html', 'playground.html']) {
    it(`allows packaged and loopback development frontends in ${page}`, () => {
      const html = readFileSync(new URL(`../${page}`, import.meta.url), 'utf8')
      const content = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1]

      expect(content).toContain("script-src 'self'")
      expect(content).toContain('mortise-extension:')
      expect(content).toContain('http://localhost:*')
      expect(content).toContain('http://127.0.0.1:*')
      expect(content).toMatch(/style-src[^;]+mortise-extension:/)
      expect(content).toMatch(/connect-src[^;]+mortise-extension:/)
    })
  }
})
