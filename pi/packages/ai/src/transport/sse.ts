import { TransportError } from "./errors.ts";

export interface ServerSentEvent {
	event: string | null;
	data: string;
	raw: string[];
}

export interface SseIteratorOptions {
	signal?: AbortSignal;
	cancelOnReturn?: boolean;
}

interface SseDecoderState {
	event: string | null;
	data: string[];
	raw: string[];
}

export async function* iterateSseMessages(
	body: ReadableStream<Uint8Array>,
	optionsOrSignal?: SseIteratorOptions | AbortSignal,
): AsyncGenerator<ServerSentEvent> {
	const options = normalizeSseIteratorOptions(optionsOrSignal);
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const state: SseDecoderState = { event: null, data: [], raw: [] };
	let buffer = "";
	let reachedEnd = false;

	try {
		while (true) {
			if (options.signal?.aborted) {
				throw createAbortError(options.signal.reason);
			}

			const { value, done } = await reader.read();
			if (done) {
				reachedEnd = true;
				break;
			}

			buffer += decoder.decode(value, { stream: true });
			let consumed = consumeLine(buffer);
			while (consumed) {
				buffer = consumed.rest;
				const event = decodeSseLine(consumed.line, state);
				if (event) {
					yield event;
				}
				consumed = consumeLine(buffer);
			}
		}

		buffer += decoder.decode();
		let consumed = consumeLine(buffer);
		while (consumed) {
			buffer = consumed.rest;
			const event = decodeSseLine(consumed.line, state);
			if (event) {
				yield event;
			}
			consumed = consumeLine(buffer);
		}

		if (buffer.length > 0) {
			const event = decodeSseLine(buffer, state);
			if (event) {
				yield event;
			}
		}

		const trailingEvent = flushSseEvent(state);
		if (trailingEvent) {
			yield trailingEvent;
		}
	} finally {
		if (!reachedEnd && options.cancelOnReturn !== false) {
			try {
				await reader.cancel();
			} catch {}
		}
		try {
			reader.releaseLock();
		} catch {}
	}
}

export async function* iterateJsonSseMessages<T = Record<string, unknown>>(
	body: ReadableStream<Uint8Array>,
	options: SseIteratorOptions & {
		skipDone?: boolean;
		parseErrorMessage?: (error: unknown, event: ServerSentEvent) => string;
	} = {},
): AsyncGenerator<T> {
	for await (const event of iterateSseMessages(body, options)) {
		if (options.skipDone !== false && event.data.trim() === "[DONE]") {
			continue;
		}
		try {
			yield JSON.parse(event.data) as T;
		} catch (cause) {
			throw new TransportError({
				code: "protocol_error",
				message: options.parseErrorMessage?.(cause, event) ?? "Invalid SSE JSON",
				phase: "stream",
				retryable: false,
				cause,
			});
		}
	}
}

function normalizeSseIteratorOptions(optionsOrSignal?: SseIteratorOptions | AbortSignal): SseIteratorOptions {
	if (!optionsOrSignal) return {};
	if ("aborted" in optionsOrSignal) {
		return { signal: optionsOrSignal };
	}
	return optionsOrSignal;
}

function flushSseEvent(state: SseDecoderState): ServerSentEvent | null {
	if (!state.event && state.data.length === 0) {
		state.raw = [];
		return null;
	}

	const event: ServerSentEvent = {
		event: state.event,
		data: state.data.join("\n"),
		raw: [...state.raw],
	};
	state.event = null;
	state.data = [];
	state.raw = [];
	return event;
}

function decodeSseLine(line: string, state: SseDecoderState): ServerSentEvent | null {
	if (line === "") {
		return flushSseEvent(state);
	}

	state.raw.push(line);
	if (line.startsWith(":")) {
		return null;
	}

	const delimiterIndex = line.indexOf(":");
	const fieldName = delimiterIndex === -1 ? line : line.slice(0, delimiterIndex);
	let value = delimiterIndex === -1 ? "" : line.slice(delimiterIndex + 1);
	if (value.startsWith(" ")) {
		value = value.slice(1);
	}

	if (fieldName === "event") {
		state.event = value;
	} else if (fieldName === "data") {
		state.data.push(value);
	}

	return null;
}

function nextLineBreakIndex(text: string): number {
	const carriageReturnIndex = text.indexOf("\r");
	const newlineIndex = text.indexOf("\n");
	if (carriageReturnIndex === -1) {
		return newlineIndex;
	}
	if (newlineIndex === -1) {
		return carriageReturnIndex;
	}
	return Math.min(carriageReturnIndex, newlineIndex);
}

function consumeLine(text: string): { line: string; rest: string } | null {
	const lineBreakIndex = nextLineBreakIndex(text);
	if (lineBreakIndex === -1) {
		return null;
	}

	let nextIndex = lineBreakIndex + 1;
	if (text[lineBreakIndex] === "\r" && text[nextIndex] === "\n") {
		nextIndex += 1;
	}

	return {
		line: text.slice(0, lineBreakIndex),
		rest: text.slice(nextIndex),
	};
}

function createAbortError(cause?: unknown): TransportError {
	return new TransportError({
		code: "aborted",
		message: "Request was aborted",
		phase: "stream",
		retryable: false,
		cause,
	});
}
