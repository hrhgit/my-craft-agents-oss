import { describe, expect, it } from 'bun:test'
import { createHash, webcrypto } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import { semanticValueFingerprintScript } from '../value-fingerprint'

const EDITABLE_SELECTOR = 'textarea,input,[contenteditable="true"]'

class FakeHTMLElement {
  dataset: Record<string, string>
  innerText: string
  textContent: string | null
  value?: string
  private readonly editable: boolean
  private readonly descendant: FakeHTMLElement | null

  constructor(options: {
    semanticId?: string
    editable?: boolean
    descendant?: FakeHTMLElement
    innerText?: string
    textContent?: string | null
    value?: string
  } = {}) {
    this.dataset = options.semanticId ? { mortiseSemanticId: options.semanticId } : {}
    this.editable = options.editable ?? false
    this.descendant = options.descendant ?? null
    this.innerText = options.innerText ?? ''
    this.textContent = options.textContent ?? null
    if (options.value !== undefined) this.value = options.value
  }

  matches(selector: string): boolean {
    return selector === EDITABLE_SELECTOR && this.editable
  }

  querySelector(selector: string): FakeHTMLElement | null {
    return selector === EDITABLE_SELECTOR ? this.descendant : null
  }
}

async function fingerprint(elements: FakeHTMLElement[], semanticId = 'composer.session.input') {
  return await runInNewContext(semanticValueFingerprintScript(semanticId), {
    document: { querySelectorAll: () => elements },
    HTMLElement: FakeHTMLElement,
    crypto: webcrypto,
    TextEncoder,
    Uint8Array,
  }) as { length: number; sha256: string } | null
}

function expected(value: string) {
  return { length: value.length, sha256: createHash('sha256').update(value).digest('hex') }
}

describe('semantic value fingerprint', () => {
  it('reads a descendant textarea instead of wrapper text', async () => {
    const value = 'Preserve this exact ordinary Session payload across rejection and retry.'
    const textarea = new FakeHTMLElement({ editable: true, value })
    const wrapper = new FakeHTMLElement({ semanticId: 'composer.session.input', descendant: textarea, innerText: '\n' })

    expect(await fingerprint([wrapper])).toEqual(expected(value))
  })

  it('reads the semantic target itself when it is an input', async () => {
    const input = new FakeHTMLElement({ semanticId: 'composer.session.input', editable: true, value: 'direct input' })

    expect(await fingerprint([input])).toEqual(expected('direct input'))
  })

  it('reads text content from a descendant contenteditable element', async () => {
    const contenteditable = new FakeHTMLElement({ editable: true, textContent: 'editable text' })
    const wrapper = new FakeHTMLElement({ semanticId: 'composer.session.input', descendant: contenteditable })

    expect(await fingerprint([wrapper])).toEqual(expected('editable text'))
  })

  it('returns only the length and digest, never the raw value', async () => {
    const secret = 'sensitive composer contents'
    const input = new FakeHTMLElement({ semanticId: 'composer.session.input', editable: true, value: secret })
    const result = await fingerprint([input])

    expect(Object.keys(result ?? {}).sort()).toEqual(['length', 'sha256'])
    expect(JSON.stringify(result)).not.toContain(secret)
  })
})
