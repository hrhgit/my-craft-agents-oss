const OPENAI_SDK_FINGERPRINT_HEADERS = [
	"user-agent",
	"x-stainless-arch",
	"x-stainless-lang",
	"x-stainless-os",
	"x-stainless-package-version",
	"x-stainless-retry-count",
	"x-stainless-runtime",
	"x-stainless-runtime-version",
];

function isOpenAIHost(url: URL): boolean {
	return url.hostname === "api.openai.com" || url.hostname.endsWith(".openai.com");
}

function stripOpenAISdkFingerprintHeaders(headers: Headers): void {
	const userAgent = headers.get("user-agent");
	if (userAgent && /^OpenAI\//i.test(userAgent)) {
		headers.delete("user-agent");
	}

	for (const header of OPENAI_SDK_FINGERPRINT_HEADERS.slice(1)) {
		headers.delete(header);
	}
}

export function createOpenAIProxyAwareFetch(fetchImpl: typeof fetch = globalThis.fetch): typeof fetch {
	return async (input, init) => {
		const request = new Request(input, init);
		const url = new URL(request.url);

		if (isOpenAIHost(url)) {
			return fetchImpl(request);
		}

		const headers = new Headers(request.headers);
		stripOpenAISdkFingerprintHeaders(headers);

		return fetchImpl(
			new Request(request, {
				headers,
			}),
		);
	};
}

export function createOpenAICompatibleFetch(baseUrl: string, fetchImpl?: typeof fetch): typeof fetch | undefined {
	const url = new URL(baseUrl);
	if (isOpenAIHost(url)) {
		return fetchImpl;
	}

	return createOpenAIProxyAwareFetch(fetchImpl ?? globalThis.fetch);
}
