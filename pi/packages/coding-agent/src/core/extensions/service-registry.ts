import { randomUUID } from "node:crypto";
import { satisfies } from "semver";
import type { TSchema } from "typebox";
import { Check } from "typebox/value";
import type {
	ExtensionCapabilityBindingV1,
	ExtensionCapabilityProvideV1,
	ExtensionCapabilityScopeV1,
	ExtensionCapabilityUseV1,
	ExtensionManifestV1,
} from "../extension-manifest.ts";
import type {
	ExtensionServiceCatalogV1,
	ExtensionServiceHandle,
	ExtensionServiceImplementation,
	ExtensionServiceInvocationContext,
	ExtensionServiceInvokeOptions,
} from "./types.ts";

export type ExtensionServiceErrorCode =
	| "extension_service_unavailable"
	| "extension_service_ambiguous"
	| "extension_service_operation_unknown"
	| "extension_service_invalid_input"
	| "extension_service_invalid_output"
	| "extension_service_cancelled"
	| "extension_service_timed_out"
	| "extension_service_runtime_stale"
	| "extension_service_failed";

export class ExtensionServiceError extends Error {
	readonly code: ExtensionServiceErrorCode;
	readonly details?: Record<string, unknown>;
	constructor(code: ExtensionServiceErrorCode, message: string, details?: Record<string, unknown>) {
		super(message);
		this.code = code;
		this.details = details;
		this.name = "ExtensionServiceError";
	}
}

interface RegisteredService {
	ownerExtensionId: string;
	capabilityId: string;
	declaration: ExtensionCapabilityProvideV1;
	implementation: ExtensionServiceImplementation;
}

interface ExtensionServiceRegistryOptions {
	scope?: ExtensionCapabilityScopeV1;
	parent?: ExtensionServiceRegistry;
	runtimeId?: string;
}

const SCOPE_RANK: Record<ExtensionCapabilityScopeV1, number> = { global: 0, workspace: 1, session: 2 };

export class ExtensionServiceRegistry {
	readonly runtimeId: string;
	readonly scope: ExtensionCapabilityScopeV1;
	private readonly parent?: ExtensionServiceRegistry;
	private readonly services = new Map<string, RegisteredService[]>();
	private readonly manifests = new Map<string, ExtensionManifestV1 | undefined>();
	private readonly activeInvocations = new Map<string, AbortController>();
	private active = true;
	private staleMessage = "Extension service runtime is stale";

	constructor(options: ExtensionServiceRegistryOptions = {}) {
		this.scope = options.scope ?? "session";
		this.parent = options.parent;
		this.runtimeId = options.runtimeId ?? randomUUID();
		if (this.parent && SCOPE_RANK[this.parent.scope] >= SCOPE_RANK[this.scope]) {
			throw new Error(`Extension service parent scope ${this.parent.scope} must outlive ${this.scope}`);
		}
	}

	declareExtension(extensionId: string, manifest?: ExtensionManifestV1): void {
		this.assertActive();
		this.manifests.set(extensionId, manifest);
	}

	provide(extensionId: string, capabilityId: string, implementation: ExtensionServiceImplementation): () => void {
		this.assertActive();
		const declaration = this.manifests.get(extensionId)?.provides?.[capabilityId];
		if (!declaration?.service) {
			throw new Error(`Extension ${extensionId} did not declare service capability ${capabilityId}`);
		}
		if (declaration.scope !== this.scope) return () => {};
		const declaredOperations = Object.keys(declaration.service.operations).sort();
		const implementedOperations = Object.keys(implementation).sort();
		if (
			declaredOperations.length !== implementedOperations.length ||
			declaredOperations.some((operation, index) => operation !== implementedOperations[index])
		) {
			throw new Error(
				`Extension ${extensionId} must implement exactly the declared operations for ${capabilityId}: ${declaredOperations.join(", ")}`,
			);
		}
		for (const operation of implementedOperations) {
			if (typeof implementation[operation] !== "function") {
				throw new Error(
					`Extension ${extensionId} service operation ${capabilityId}.${operation} is not a function`,
				);
			}
		}
		const registrations = this.services.get(capabilityId) ?? [];
		if (registrations.some((registration) => registration.ownerExtensionId === extensionId)) {
			throw new Error(`Extension ${extensionId} already registered service capability ${capabilityId}`);
		}
		const registration = { ownerExtensionId: extensionId, capabilityId, declaration, implementation };
		registrations.push(registration);
		this.services.set(capabilityId, registrations);
		return () => {
			const current = this.services.get(capabilityId) ?? [];
			this.services.set(
				capabilityId,
				current.filter((item) => item !== registration),
			);
		};
	}

	use(extensionId: string, alias: string): ExtensionServiceHandle {
		this.assertActive();
		const use = this.manifests.get(extensionId)?.uses?.[alias];
		if (!use) throw new Error(`Extension ${extensionId} did not declare capability alias ${alias}`);
		const registry = this;
		return Object.freeze({
			get available() {
				return Boolean(registry.resolve(use).selected);
			},
			invoke: <TOutput = unknown>(operation: string, input?: unknown, options?: ExtensionServiceInvokeOptions) =>
				this.invokeUse(extensionId, alias, use, operation, input, options) as Promise<TOutput>,
		});
	}

	private registrations(capabilityId: string): RegisteredService[] {
		this.assertActive();
		const local = this.services.get(capabilityId) ?? [];
		return [...local, ...(this.parent?.registrations(capabilityId) ?? [])];
	}

	private resolve(use: ExtensionCapabilityUseV1): { selected?: RegisteredService; candidates: RegisteredService[] } {
		const candidates = this.registrations(use.capability).filter((registration) => {
			if (use.provider && registration.ownerExtensionId !== use.provider) return false;
			return satisfies(registration.declaration.version, use.version, { includePrerelease: true });
		});
		return { selected: candidates.length === 1 ? candidates[0] : undefined, candidates };
	}

	private async invokeUse(
		consumerExtensionId: string,
		alias: string,
		use: ExtensionCapabilityUseV1,
		operation: string,
		input: unknown,
		options: ExtensionServiceInvokeOptions = {},
	): Promise<unknown> {
		this.assertActive(options.runtimeId);
		const { selected, candidates } = this.resolve(use);
		if (!selected) {
			throw new ExtensionServiceError(
				candidates.length > 1 ? "extension_service_ambiguous" : "extension_service_unavailable",
				`Capability alias ${consumerExtensionId}.${alias} is ${candidates.length > 1 ? "ambiguous" : "unavailable"}`,
				{ candidateProviderIds: candidates.map((candidate) => candidate.ownerExtensionId) },
			);
		}
		return this.invokeRegistration(selected, operation, input, options);
	}

	async invokeCapability(
		capabilityId: string,
		operation: string,
		input: unknown,
		options: ExtensionServiceInvokeOptions & { provider?: string } = {},
	): Promise<unknown> {
		this.assertActive(options.runtimeId);
		const candidates = this.registrations(capabilityId).filter(
			(registration) => !options.provider || registration.ownerExtensionId === options.provider,
		);
		if (candidates.length !== 1) {
			throw new ExtensionServiceError(
				candidates.length > 1 ? "extension_service_ambiguous" : "extension_service_unavailable",
				`Capability ${capabilityId} is ${candidates.length > 1 ? "ambiguous" : "unavailable"}`,
				{ candidateProviderIds: candidates.map((candidate) => candidate.ownerExtensionId) },
			);
		}
		return this.invokeRegistration(candidates[0]!, operation, input, options);
	}

	private async invokeRegistration(
		registration: RegisteredService,
		operation: string,
		input: unknown,
		options: ExtensionServiceInvokeOptions,
	): Promise<unknown> {
		const declaration = registration.declaration.service?.operations[operation];
		const handler = registration.implementation[operation];
		if (!declaration || !handler) {
			throw new ExtensionServiceError(
				"extension_service_operation_unknown",
				`Unknown operation ${registration.capabilityId}.${operation}`,
			);
		}
		if (!Check(declaration.inputSchema as TSchema, input)) {
			throw new ExtensionServiceError(
				"extension_service_invalid_input",
				`Input for ${registration.capabilityId}.${operation} does not match its schema`,
			);
		}
		const controller = new AbortController();
		if (options.requestId) {
			if (this.activeInvocations.has(options.requestId))
				throw new ExtensionServiceError(
					"extension_service_failed",
					`Invocation request ${options.requestId} is already active`,
				);
			this.activeInvocations.set(options.requestId, controller);
		}
		let timedOut = false;
		const abort = () => controller.abort(options.signal?.reason);
		if (options.signal?.aborted) abort();
		else options.signal?.addEventListener("abort", abort, { once: true });
		if (controller.signal.aborted) {
			throw new ExtensionServiceError(
				"extension_service_cancelled",
				`Invocation of ${registration.capabilityId}.${operation} was cancelled`,
			);
		}
		const timeout =
			options.timeoutMs && options.timeoutMs > 0
				? setTimeout(() => {
						timedOut = true;
						controller.abort(new Error("Extension service invocation timed out"));
					}, options.timeoutMs)
				: undefined;
		const context: ExtensionServiceInvocationContext = {
			signal: controller.signal,
			reportProgress: (progress) => options.onProgress?.(progress),
		};
		try {
			const output = await handler(input, context);
			this.assertActive(options.runtimeId);
			if (!Check(declaration.outputSchema as TSchema, output)) {
				throw new ExtensionServiceError(
					"extension_service_invalid_output",
					`Output from ${registration.capabilityId}.${operation} does not match its schema`,
				);
			}
			return output;
		} catch (error) {
			if (error instanceof ExtensionServiceError) throw error;
			if (timedOut)
				throw new ExtensionServiceError(
					"extension_service_timed_out",
					`Invocation of ${registration.capabilityId}.${operation} timed out`,
				);
			if (controller.signal.aborted)
				throw new ExtensionServiceError(
					"extension_service_cancelled",
					`Invocation of ${registration.capabilityId}.${operation} was cancelled`,
				);
			throw new ExtensionServiceError(
				"extension_service_failed",
				error instanceof Error ? error.message : String(error),
			);
		} finally {
			if (options.requestId && this.activeInvocations.get(options.requestId) === controller)
				this.activeInvocations.delete(options.requestId);
			if (timeout) clearTimeout(timeout);
			options.signal?.removeEventListener("abort", abort);
		}
	}

	cancel(requestId: string, reason = "Extension service invocation cancelled"): boolean {
		const controller = this.activeInvocations.get(requestId);
		if (controller) {
			controller.abort(new Error(reason));
			return true;
		}
		return this.parent?.cancel(requestId, reason) ?? false;
	}

	catalog(bindings: ReadonlyMap<string, ExtensionCapabilityBindingV1[]> = new Map()): ExtensionServiceCatalogV1 {
		const providers = this.registrationsForCatalog().map((registration) => ({
			extensionId: registration.ownerExtensionId,
			capability: registration.capabilityId,
			version: registration.declaration.version,
			scope: registration.declaration.scope,
			operations: registration.declaration.service?.operations ?? {},
		}));
		return {
			protocolVersion: 1,
			runtimeId: this.runtimeId,
			scope: this.scope,
			providers,
			consumers: Array.from(bindings, ([extensionId, extensionBindings]) => ({
				extensionId,
				bindings: extensionBindings,
			})),
		};
	}

	private registrationsForCatalog(): RegisteredService[] {
		this.assertActive();
		return [...Array.from(this.services.values()).flat(), ...(this.parent?.registrationsForCatalog() ?? [])];
	}

	unregisterExtension(extensionId: string): void {
		for (const [capabilityId, registrations] of this.services) {
			this.services.set(
				capabilityId,
				registrations.filter((registration) => registration.ownerExtensionId !== extensionId),
			);
		}
		this.manifests.delete(extensionId);
	}

	invalidate(message?: string): void {
		if (!this.active) return;
		this.active = false;
		this.staleMessage = message ?? this.staleMessage;
		this.services.clear();
		for (const controller of this.activeInvocations.values()) controller.abort(new Error(this.staleMessage));
		this.activeInvocations.clear();
	}

	private assertActive(expectedRuntimeId?: string): void {
		if (!this.active || (expectedRuntimeId && expectedRuntimeId !== this.runtimeId)) {
			throw new ExtensionServiceError("extension_service_runtime_stale", this.staleMessage, {
				expectedRuntimeId,
				currentRuntimeId: this.runtimeId,
			});
		}
	}
}
