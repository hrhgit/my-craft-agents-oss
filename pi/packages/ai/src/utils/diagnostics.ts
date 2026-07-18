export interface DiagnosticErrorInfo {
	name?: string;
	message: string;
	stack?: string;
	code?: string | number;
	status?: number;
	errno?: string | number;
	syscall?: string;
	hostname?: string;
	address?: string;
	port?: number;
	type?: string;
	causeChain?: DiagnosticErrorInfo[];
}

export interface AssistantMessageDiagnostic {
	type: string;
	timestamp: number;
	error?: DiagnosticErrorInfo;
	details?: Record<string, unknown>;
}

export function formatThrownValue(value: unknown): string {
	if (value instanceof Error) return value.message || value.name;
	if (typeof value === "string") return value;
	return String(value);
}

export function extractDiagnosticError(error: unknown): DiagnosticErrorInfo {
	if (!(error instanceof Error)) return { name: "ThrownValue", message: formatThrownValue(error) };
	const code = (error as Error & { code?: unknown }).code;
	const extra = error as Error & {
		status?: unknown;
		errno?: unknown;
		syscall?: unknown;
		hostname?: unknown;
		address?: unknown;
		port?: unknown;
		type?: unknown;
		cause?: unknown;
	};
	return {
		name: error.name || undefined,
		message: error.message || error.name,
		stack: error.stack,
		code: typeof code === "string" || typeof code === "number" ? code : undefined,
		status: typeof extra.status === "number" ? extra.status : undefined,
		errno: typeof extra.errno === "string" || typeof extra.errno === "number" ? extra.errno : undefined,
		syscall: typeof extra.syscall === "string" ? extra.syscall : undefined,
		hostname: typeof extra.hostname === "string" ? extra.hostname : undefined,
		address: typeof extra.address === "string" ? extra.address : undefined,
		port: typeof extra.port === "number" ? extra.port : undefined,
		type: typeof extra.type === "string" ? extra.type : undefined,
		causeChain: extractDiagnosticCauseChain(extra.cause),
	};
}

export function createAssistantMessageDiagnostic(
	type: string,
	error: unknown,
	details?: Record<string, unknown>,
): AssistantMessageDiagnostic {
	return { type, timestamp: Date.now(), error: extractDiagnosticError(error), details };
}

export function appendAssistantMessageDiagnostic<T extends { diagnostics?: AssistantMessageDiagnostic[] }>(
	message: T,
	diagnostic: AssistantMessageDiagnostic,
): void {
	message.diagnostics = [...(message.diagnostics ?? []), diagnostic];
}

function extractDiagnosticCauseChain(error: unknown): DiagnosticErrorInfo[] | undefined {
	const chain: DiagnosticErrorInfo[] = [];
	const seen = new Set<unknown>();
	let current = error;

	while (current instanceof Error && chain.length < 10) {
		if (seen.has(current)) break;
		seen.add(current);
		const nested = current as Error & {
			code?: unknown;
			status?: unknown;
			errno?: unknown;
			syscall?: unknown;
			hostname?: unknown;
			address?: unknown;
			port?: unknown;
			type?: unknown;
			cause?: unknown;
		};
		chain.push({
			name: current.name || undefined,
			message: current.message || current.name,
			stack: current.stack,
			code: typeof nested.code === "string" || typeof nested.code === "number" ? nested.code : undefined,
			status: typeof nested.status === "number" ? nested.status : undefined,
			errno: typeof nested.errno === "string" || typeof nested.errno === "number" ? nested.errno : undefined,
			syscall: typeof nested.syscall === "string" ? nested.syscall : undefined,
			hostname: typeof nested.hostname === "string" ? nested.hostname : undefined,
			address: typeof nested.address === "string" ? nested.address : undefined,
			port: typeof nested.port === "number" ? nested.port : undefined,
			type: typeof nested.type === "string" ? nested.type : undefined,
		});
		current = nested.cause;
	}

	return chain.length > 0 ? chain : undefined;
}
