const { appendFileSync, mkdirSync } = require("node:fs");
const { dirname } = require("node:path");
const { randomUUID } = require("node:crypto");

const LOG_FILE = process.env.CRAFT_E2E_PROVIDER_LOG_FILE;
const RUN_ID = process.env.CRAFT_E2E_RUN_ID;

function writeEvent(event) {
  if (!LOG_FILE) return;
  try {
    mkdirSync(dirname(LOG_FILE), { recursive: true });
    appendFileSync(LOG_FILE, `${JSON.stringify(event)}\n`, "utf8");
  } catch {
    // Request observation must never break the provider call under test.
  }
}

function timestampFields() {
  const timestampMs = Date.now();
  return {
    timestamp: new Date(timestampMs).toISOString(),
    timestampMs,
  };
}

function extractUrl(input) {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  if (typeof Request !== "undefined" && input instanceof Request) return input.url;
  if (input && typeof input === "object" && typeof input.url === "string") return input.url;
  return "";
}

function sanitizeUrl(rawUrl) {
  if (!rawUrl) return { url: "", host: "", path: "", queryKeys: [] };
  try {
    const parsed = new URL(rawUrl);
    return {
      url: `${parsed.origin}${parsed.pathname}`,
      host: parsed.host,
      path: parsed.pathname,
      queryKeys: Array.from(parsed.searchParams.keys()).sort(),
    };
  } catch {
    return { url: "(unparseable)", host: "", path: "", queryKeys: [] };
  }
}

function headersToObject(headers) {
  if (!headers) return {};
  try {
    if (headers instanceof Headers) {
      return Object.fromEntries(headers.entries());
    }
    if (Array.isArray(headers)) {
      return Object.fromEntries(headers);
    }
    return { ...headers };
  } catch {
    return {};
  }
}

function getHeader(headers, name) {
  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(headersToObject(headers))) {
    if (key.toLowerCase() === lowerName) return String(value);
  }
  return undefined;
}

function extractBodyText(init) {
  const body = init && "body" in init ? init.body : undefined;
  if (typeof body === "string") return body;
  if (Buffer.isBuffer(body)) return body.toString("utf8");
  if (body instanceof Uint8Array) return Buffer.from(body).toString("utf8");
  return undefined;
}

function summarizeBody(bodyText) {
  if (!bodyText) return {};
  try {
    const body = JSON.parse(bodyText);
    const messages = Array.isArray(body.messages) ? body.messages : undefined;
    const input = Array.isArray(body.input) ? body.input : undefined;
    const tools = Array.isArray(body.tools) ? body.tools : undefined;
    const system = Array.isArray(body.system) ? body.system : undefined;
    return {
      model: typeof body.model === "string" ? body.model : undefined,
      stream: typeof body.stream === "boolean" ? body.stream : undefined,
      maxTokens: typeof body.max_tokens === "number" ? body.max_tokens : typeof body.maxTokens === "number" ? body.maxTokens : undefined,
      temperature: typeof body.temperature === "number" ? body.temperature : undefined,
      messageCount: messages?.length,
      inputCount: input?.length,
      toolCount: tools?.length,
      systemBlockCount: system?.length,
    };
  } catch {
    return { bodyParseable: false };
  }
}

function summarizeRequest(input, init) {
  const rawUrl = extractUrl(input);
  const headers =
    init?.headers ??
    (typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined);
  const method =
    init?.method ??
    (typeof Request !== "undefined" && input instanceof Request ? input.method : undefined) ??
    "GET";
  const bodySummary = summarizeBody(extractBodyText(init));
  const requestId =
    getHeader(headers, "x-pi-request-id") ??
    getHeader(headers, "x-request-id") ??
    getHeader(headers, "request-id");

  return {
    method: method.toUpperCase(),
    ...sanitizeUrl(rawUrl),
    requestHeaderContentType: getHeader(headers, "content-type"),
    piRequestId: requestId,
    hasAuthorizationHeader: Boolean(getHeader(headers, "authorization")),
    hasApiKeyHeader: Boolean(getHeader(headers, "x-api-key") || getHeader(headers, "api-key")),
    ...bodySummary,
  };
}

function summarizeResponse(response) {
  const headers = response?.headers;
  return {
    status: response?.status,
    statusText: response?.statusText,
    ok: response?.ok,
    responseHeaderContentType: headers?.get?.("content-type") ?? undefined,
    responseRequestId:
      headers?.get?.("x-request-id") ??
      headers?.get?.("request-id") ??
      headers?.get?.("cf-ray") ??
      undefined,
  };
}

function sanitizeErrorMessage(message) {
  return String(message)
    .replace(/Bearer\s+[^\s,)]+/gi, "Bearer [REDACTED]")
    .replace(/(?:sk|pk)-[A-Za-z0-9_-]{12,}/g, "[REDACTED_KEY]")
    .replace(/(api[_-]?key=)[^&\s]+/gi, "$1[REDACTED]")
    .slice(0, 1000);
}

function wrapFetch(baseFetch) {
  return async function observedFetch(input, init) {
    const requestId = randomUUID();
    const startedAt = Date.now();
    const requestSummary = summarizeRequest(input, init);

    writeEvent({
      ...timestampFields(),
      event: "request",
      runId: RUN_ID,
      requestId,
      ...requestSummary,
    });

    try {
      const response = await baseFetch(input, init);
      writeEvent({
        ...timestampFields(),
        event: "response",
        runId: RUN_ID,
        requestId,
        durationMs: Date.now() - startedAt,
        ...requestSummary,
        ...summarizeResponse(response),
      });
      return response;
    } catch (error) {
      writeEvent({
        ...timestampFields(),
        event: "error",
        runId: RUN_ID,
        requestId,
        durationMs: Date.now() - startedAt,
        ...requestSummary,
        errorName: error instanceof Error ? error.name : "Error",
        errorMessage: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)),
      });
      throw error;
    }
  };
}

function fetchInterceptor(baseFetch) {
  return wrapFetch(baseFetch);
}

function createFetchInterceptor() {
  return wrapFetch;
}

module.exports = {
  fetchInterceptor,
  createFetchInterceptor,
};
