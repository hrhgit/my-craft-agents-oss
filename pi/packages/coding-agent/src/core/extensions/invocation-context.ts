import { AsyncLocalStorage } from "node:async_hooks";

export type ExtensionInvocationOrigin =
	| { kind: "attempt"; attemptId: string }
	| { kind: "host" }
	| { kind: "runtime" };

const invocationOriginStorage = new AsyncLocalStorage<ExtensionInvocationOrigin>();

export function getExtensionInvocationOrigin(): ExtensionInvocationOrigin {
	return invocationOriginStorage.getStore() ?? { kind: "runtime" };
}

export function runWithExtensionInvocationOrigin<T>(origin: ExtensionInvocationOrigin, action: () => T): T {
	return invocationOriginStorage.run(origin, action);
}
