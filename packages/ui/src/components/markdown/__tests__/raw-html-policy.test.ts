import { describe, expect, it, mock } from 'bun:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import {
  inheritMarkdownRawHtmlPolicy,
  markdownPreviewBlockAllowsRawHtml,
  markdownRawHtmlPolicy,
} from '../raw-html-policy'

mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: 'pdf.worker.js' }))
mock.module('react-pdf', () => ({
  Document: () => null,
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: {} },
}))
const { Markdown } = await import('../Markdown')

const dangerous = '<iframe srcdoc="<script>parent.postMessage(1, \'*\')</script>"></iframe>'

describe('markdown raw HTML policy', () => {
  it('drops raw HTML when rendering untrusted file previews', () => {
    const policy = markdownRawHtmlPolicy(false)
    const html = renderToStaticMarkup(React.createElement(ReactMarkdown, {
      children: dangerous,
      rehypePlugins: policy.rehypePlugins,
      skipHtml: policy.skipHtml,
    }))
    expect(html).not.toContain('iframe')
    expect(html).not.toContain('script')
  })

  it('preserves the existing opt-in behavior for trusted callers', () => {
    const policy = markdownRawHtmlPolicy(true)
    const html = renderToStaticMarkup(React.createElement(ReactMarkdown, {
      children: dangerous,
      rehypePlugins: policy.rehypePlugins,
      skipHtml: policy.skipHtml,
    }))
    expect(html).toContain('<iframe')
    expect(html).toContain('srcDoc=')
  })

  it('does not let recursive markdown previews widen an untrusted parent policy', () => {
    expect(inheritMarkdownRawHtmlPolicy(false)).toBe(false)
    expect(inheritMarkdownRawHtmlPolicy(false, true)).toBe(false)
    expect(inheritMarkdownRawHtmlPolicy(true, false)).toBe(false)
    expect(inheritMarkdownRawHtmlPolicy(true, true)).toBe(true)
  })

  it('does not restore an iframe surface through an html-preview fence', () => {
    expect(markdownPreviewBlockAllowsRawHtml('html-preview', false)).toBe(false)
    expect(markdownPreviewBlockAllowsRawHtml('html-preview', true)).toBe(true)
    expect(markdownPreviewBlockAllowsRawHtml('image-preview', false)).toBe(true)

    const html = renderToStaticMarkup(React.createElement(Markdown, {
      allowRawHtml: false,
      children: '```html-preview\n{"src":"untrusted.html"}\n```',
    }))
    expect(html).not.toContain('data-ca-block-type="html-preview"')
    expect(html).not.toContain('<iframe')
    expect(html).not.toContain('srcDoc=')
  })
})
