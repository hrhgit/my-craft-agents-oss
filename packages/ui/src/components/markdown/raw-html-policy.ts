import rehypeRaw from 'rehype-raw'

export function markdownRawHtmlPolicy(allowRawHtml: boolean) {
  return {
    rehypePlugins: allowRawHtml ? [rehypeRaw] : [],
    skipHtml: !allowRawHtml,
  }
}

/** Recursive previews may narrow a parent's trust, but never widen it. */
export function inheritMarkdownRawHtmlPolicy(
  parentAllowsRawHtml: boolean,
  childAllowsRawHtml = true,
): boolean {
  return parentAllowsRawHtml && childAllowsRawHtml
}

/** An HTML preview fence creates an iframe/srcdoc surface and is raw HTML. */
export function markdownPreviewBlockAllowsRawHtml(
  blockName: string,
  allowRawHtml: boolean,
): boolean {
  return blockName !== 'html-preview' || allowRawHtml
}
