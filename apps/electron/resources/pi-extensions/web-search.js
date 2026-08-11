const DEFAULT_MAX_RESULTS = 5;
const DEFAULT_SOURCE_TIMEOUT_MS = 8000;

function getDomain(url) {
  try { return new URL(url).hostname; } catch { return undefined; }
}

function decodeHtml(value) {
  const named = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (entity, code) => {
    if (code[0] !== '#') return named[code.toLowerCase()] ?? entity;
    const numeric = code[1].toLowerCase() === 'x'
      ? Number.parseInt(code.slice(2), 16)
      : Number.parseInt(code.slice(1), 10);
    return Number.isFinite(numeric) ? String.fromCodePoint(numeric) : entity;
  });
}

function textContent(html) {
  return decodeHtml(html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')).trim();
}

export function parseDuckDuckGo(html, maxResults) {
  const results = [];
  const pattern = /<a[^>]+class="[^"]*\bresult__a\b[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(pattern)) {
    const href = decodeHtml(match[1]);
    const title = textContent(match[2]);
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

export function parseBing(html, maxResults) {
  const results = [];
  const pattern = /<li[^>]+class="[^"]*\bb_algo\b[^"]*"[\s\S]*?<h2[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(pattern)) {
    const url = decodeHtml(match[1]);
    const title = textContent(match[2]);
    if (!/^https?:\/\//i.test(url) || !title) continue;
    results.push({ title, url, domain: getDomain(url) });
    if (results.length >= maxResults) break;
  }
  return results;
}

const SEARCH_BACKENDS = [
  {
    id: 'bing',
    label: 'Bing',
    url: query => `https://www.bing.com/search?q=${encodeURIComponent(query)}`,
    parse: parseBing,
  },
  {
    id: 'duckduckgo',
    label: 'DuckDuckGo',
    url: query => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    parse: parseDuckDuckGo,
  },
];

function configuredBackends() {
  const configured = typeof process !== 'undefined'
    ? process.env.MORTISE_WEB_SEARCH_BACKENDS
    : undefined;
  if (!configured?.trim()) return SEARCH_BACKENDS;
  const requested = configured.split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
  const selected = requested
    .map(id => SEARCH_BACKENDS.find(backend => backend.id === id))
    .filter(Boolean);
  return selected.length > 0 ? selected : SEARCH_BACKENDS;
}

function sourceTimeoutMs() {
  const configured = typeof process !== 'undefined'
    ? Number.parseInt(process.env.MORTISE_WEB_SEARCH_TIMEOUT_MS ?? '', 10)
    : Number.NaN;
  return Number.isFinite(configured)
    ? Math.min(Math.max(configured, 1000), 30000)
    : DEFAULT_SOURCE_TIMEOUT_MS;
}

async function fetchBackend(backend, query, maxResults, signal) {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, sourceTimeoutMs());

  try {
    const response = await fetch(backend.url(query), {
      signal: controller.signal,
      headers: {
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.7',
        'user-agent': 'Mozilla/5.0 (compatible; Mortise/1.0; +https://github.com/mortise)',
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return backend.parse(await response.text(), maxResults);
  } catch (error) {
    if (signal?.aborted) throw Object.assign(new Error('网页搜索已取消'), { code: 'SEARCH_CANCELLED' });
    if (timedOut) throw new Error(`${sourceTimeoutMs()}ms 超时`);
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
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
      const attempts = [];
      let reachedSearchService = false;

      for (const backend of configuredBackends()) {
        try {
          const sources = await fetchBackend(backend, query, maxResults, signal);
          reachedSearchService = true;
          attempts.push({ backend: backend.id, status: sources.length > 0 ? 'success' : 'empty' });
          if (sources.length === 0) continue;
          const text = sources.map((source, index) => `${index + 1}. ${source.title}\n   ${source.url}`).join('\n');
          return {
            content: [{ type: 'text', text: `网页搜索结果（${query}）：\n${text}` }],
            details: { query, sources, backend: backend.id, attempts },
          };
        } catch (error) {
          if (error?.code === 'SEARCH_CANCELLED') {
            return {
              content: [{ type: 'text', text: error.message }],
              details: { query, sources: [], attempts },
              isError: true,
            };
          }
          attempts.push({
            backend: backend.id,
            status: 'failed',
            error: error?.message || '连接失败',
          });
        }
      }

      if (reachedSearchService) {
        return {
          content: [{ type: 'text', text: `未找到“${query}”的公开网页结果。` }],
          details: { query, sources: [], attempts },
        };
      }

      const reason = attempts.map(attempt => `${attempt.backend}: ${attempt.error}`).join('；');
      return {
        content: [{ type: 'text', text: `网页搜索后端均不可用${reason ? `（${reason}）` : ''}` }],
        details: { query, sources: [], attempts },
        isError: true,
      };
    },
  });
}
