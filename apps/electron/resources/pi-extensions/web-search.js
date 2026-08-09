const DEFAULT_MAX_RESULTS = 5;

function getDomain(url) {
  try { return new URL(url).hostname; } catch { return undefined; }
}

function parseDuckDuckGo(html, maxResults) {
  const results = [];
  const pattern = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(pattern)) {
    const href = match[1];
    const title = match[2].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').trim();
    if (!href || !title) continue;
    let url = href;
    try {
      const parsed = new URL(href, 'https://html.duckduckgo.com');
      const redirected = parsed.searchParams.get('uddg');
      if (redirected) url = decodeURIComponent(redirected);
    } catch {}
    if (!/^https?:\/\//i.test(url)) continue;
    results.push({ title, url, domain: getDomain(url) });
    if (results.length >= maxResults) break;
  }
  return results;
}

export default function webSearchExtension(pi) {
  pi.registerTool({
    name: 'web_search',
    label: 'Web Search',
    description: 'Search the public web and return source titles and URLs. Use only when current web information is needed.',
    promptSnippet: 'Search the public web with web_search when current information is needed.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 500 },
        maxResults: { type: 'integer', minimum: 1, maximum: 10 },
      },
      required: ['query'],
      additionalProperties: false,
    },
    async execute(_toolCallId, params, signal) {
      const query = params.query.trim();
      const maxResults = Number.isInteger(params.maxResults) ? params.maxResults : DEFAULT_MAX_RESULTS;
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const response = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
          signal: controller.signal,
          headers: { 'user-agent': 'Mortise/1.0 web-search' },
        });
        if (!response.ok) throw new Error(`搜索服务返回 HTTP ${response.status}`);
        const html = await response.text();
        const sources = parseDuckDuckGo(html, maxResults);
        if (sources.length === 0) {
          return { content: [{ type: 'text', text: `未找到“${query}”的公开网页结果。` }], details: { query, sources } };
        }
        const text = sources.map((source, index) => `${index + 1}. ${source.title}\n   ${source.url}`).join('\n');
        return { content: [{ type: 'text', text: `网页搜索结果（${query}）：\n${text}` }], details: { query, sources } };
      } catch (error) {
        const message = error?.name === 'AbortError' ? '网页搜索已取消' : (error?.message || '网页搜索失败');
        return { content: [{ type: 'text', text: message }], details: { query, sources: [] }, isError: true };
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
    },
  });
}

