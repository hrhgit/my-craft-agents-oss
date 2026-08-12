import { valid, validRange } from "semver";

export interface ExtensionManifestAuthorV1 {
	name: string;
	url?: string;
}

export interface ExtensionManifestLoadOrderV1 {
	priority?: number;
	after?: string[];
	before?: string[];
}

export interface ExtensionSubagentTemplateV1 {
	id: string;
	name: string;
	description: string;
	systemPrompt: string;
	tools?: string[];
	model?: string;
}

export type ExtensionCapabilityScopeV1 = "global" | "workspace" | "session";
export type ExtensionCapabilityFacetV1 = "service" | "ui";
export type ExtensionJsonSchemaV1 = Record<string, unknown>;

export interface ExtensionCapabilityServiceOperationV1 {
	inputSchema: ExtensionJsonSchemaV1;
	outputSchema: ExtensionJsonSchemaV1;
}

export interface ExtensionCapabilityProvideV1 {
	version: string;
	scope: ExtensionCapabilityScopeV1;
	service?: { operations: Record<string, ExtensionCapabilityServiceOperationV1> };
	ui?: { modules?: string[]; frontends?: string[] };
}

export interface ExtensionCapabilityUseV1 {
	capability: string;
	version: string;
	required?: boolean;
	provider?: string;
	facets?: ExtensionCapabilityFacetV1[];
}

export interface ExtensionManifestV1 {
	schemaVersion: 1;
	name: string;
	version: string;
	author: ExtensionManifestAuthorV1;
	publisher?: string;
	description?: string;
	homepage?: string;
	repository?: string;
	license?: string;
	dependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
	conflicts?: Record<string, string>;
	capabilities?: string[];
	permissions?: string[];
	provides?: Record<string, ExtensionCapabilityProvideV1>;
	uses?: Record<string, ExtensionCapabilityUseV1>;
	subagents?: ExtensionSubagentTemplateV1[];
	loadOrder?: ExtensionManifestLoadOrderV1;
}

export type ExtensionManifestDiagnosticCode =
	| "legacy-manifest"
	| "duplicate-id"
	| "missing-dependency"
	| "dependency-version-mismatch"
	| "optional-dependency-missing"
	| "optional-dependency-version-mismatch"
	| "conflict"
	| "dependency-cycle"
	| "missing-capability"
	| "capability-version-mismatch"
	| "capability-provider-mismatch"
	| "capability-provider-ambiguous"
	| "capability-facet-missing"
	| "capability-dependency-cycle"
	| "capability-ui-reference-missing"
	| "load-order-cycle";

export interface ExtensionManifestDiagnostic {
	code: ExtensionManifestDiagnosticCode;
	severity: "warning" | "error";
	message: string;
	relatedExtensionId?: string;
	capability?: string;
	consumerAlias?: string;
	providerExtensionId?: string;
}

export type ExtensionCapabilityBindingStatusV1 =
	| "bound"
	| "missing"
	| "version-mismatch"
	| "provider-mismatch"
	| "ambiguous"
	| "facet-missing";

export interface ExtensionCapabilityBindingV1 {
	alias: string;
	capability: string;
	version: string;
	required: boolean;
	requestedFacets: ExtensionCapabilityFacetV1[];
	status: ExtensionCapabilityBindingStatusV1;
	providerExtensionId?: string;
	providerVersion?: string;
	scope?: ExtensionCapabilityScopeV1;
	candidateProviderIds?: string[];
}

export type ExtensionManifestStatus = "compatible" | "warning" | "blocked" | "legacy";

const EXTENSION_ID_PATTERN = /^[a-z0-9](?:[a-z0-9.-]{0,126}[a-z0-9])?$/;
const DECLARATION_ID_PATTERN = /^[a-z][a-z0-9.-]{0,127}$/;
const TOOL_ID_PATTERN = /^[a-z][a-z0-9._-]{0,255}$/;
const OPERATION_ID_PATTERN = /^[a-z][a-z0-9._-]{0,127}$/;

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
	return Object.keys(value).every((key) => allowed.includes(key));
}

function isHttpUrl(value: unknown): value is string {
	if (typeof value !== "string" || value.length > 2048) return false;
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}

function assertOptionalUrl(value: unknown, field: string, context: string): void {
	if (value !== undefined && !isHttpUrl(value)) {
		throw new Error(`${context}: extension manifest ${field} must be an http(s) URL`);
	}
}

function assertStringMap(
	value: unknown,
	field: string,
	context: string,
	options: { selfId: string; maxEntries?: number },
): asserts value is Record<string, string> | undefined {
	if (value === undefined) return;
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${context}: extension manifest ${field} must be an object`);
	}
	const entries = Object.entries(value as Record<string, unknown>);
	if (entries.length > (options.maxEntries ?? 128)) {
		throw new Error(`${context}: extension manifest ${field} has too many entries`);
	}
	for (const [id, range] of entries) {
		if (!EXTENSION_ID_PATTERN.test(id) || id === options.selfId) {
			throw new Error(`${context}: extension manifest ${field} contains an invalid extension id`);
		}
		if (typeof range !== "string" || validRange(range) === null) {
			throw new Error(`${context}: extension manifest ${field}.${id} must be a valid semver range`);
		}
	}
}

function assertDeclarationList(value: unknown, field: string, context: string): asserts value is string[] | undefined {
	if (value === undefined) return;
	if (!Array.isArray(value) || value.length > 128) {
		throw new Error(`${context}: extension manifest ${field} must be an array with at most 128 entries`);
	}
	const seen = new Set<string>();
	for (const entry of value) {
		if (typeof entry !== "string" || !DECLARATION_ID_PATTERN.test(entry) || seen.has(entry)) {
			throw new Error(`${context}: extension manifest ${field} must contain unique stable identifiers`);
		}
		seen.add(entry);
	}
}

function assertToolList(value: unknown, context: string): asserts value is string[] | undefined {
	if (value === undefined) return;
	if (!Array.isArray(value) || value.length > 128) {
		throw new Error(`${context}: extension manifest subagents.tools must be an array with at most 128 entries`);
	}
	const seen = new Set<string>();
	for (const entry of value) {
		if (typeof entry !== "string" || !TOOL_ID_PATTERN.test(entry) || seen.has(entry)) {
			throw new Error(`${context}: extension manifest subagents.tools must contain unique tool identifiers`);
		}
		seen.add(entry);
	}
}

function assertJsonSchema(value: unknown, field: string, context: string): asserts value is ExtensionJsonSchemaV1 {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${context}: extension manifest ${field} must be a JSON Schema object`);
	}
	let serialized: string;
	try {
		serialized = JSON.stringify(value);
	} catch {
		throw new Error(`${context}: extension manifest ${field} must be JSON serializable`);
	}
	if (!serialized || serialized.length > 256_000) {
		throw new Error(`${context}: extension manifest ${field} is too large`);
	}
}

function assertStableIdList(value: unknown, field: string, context: string): asserts value is string[] | undefined {
	if (value === undefined) return;
	if (!Array.isArray(value) || value.length > 128) {
		throw new Error(`${context}: extension manifest ${field} must be an array with at most 128 entries`);
	}
	const seen = new Set<string>();
	for (const id of value) {
		if (typeof id !== "string" || !DECLARATION_ID_PATTERN.test(id) || seen.has(id)) {
			throw new Error(`${context}: extension manifest ${field} contains an invalid or duplicate id`);
		}
		seen.add(id);
	}
}

function assertCapabilityDeclarations(manifest: Record<string, unknown>, extensionId: string, context: string): void {
	if (manifest.provides !== undefined) {
		if (!manifest.provides || typeof manifest.provides !== "object" || Array.isArray(manifest.provides)) {
			throw new Error(`${context}: extension manifest provides must be an object`);
		}
		const entries = Object.entries(manifest.provides as Record<string, unknown>);
		if (entries.length > 128) throw new Error(`${context}: extension manifest provides has too many entries`);
		for (const [capabilityId, raw] of entries) {
			if (!DECLARATION_ID_PATTERN.test(capabilityId) || !raw || typeof raw !== "object" || Array.isArray(raw)) {
				throw new Error(`${context}: extension manifest provides contains an invalid capability`);
			}
			const provide = raw as Record<string, unknown>;
			if (!hasOnlyKeys(provide, ["version", "scope", "service", "ui"])) {
				throw new Error(`${context}: extension manifest provides.${capabilityId} contains unknown fields`);
			}
			if (typeof provide.version !== "string" || valid(provide.version) === null) {
				throw new Error(`${context}: extension manifest provides.${capabilityId}.version must be valid semver`);
			}
			if (!(["global", "workspace", "session"] as unknown[]).includes(provide.scope)) {
				throw new Error(`${context}: extension manifest provides.${capabilityId}.scope is invalid`);
			}
			let hasFacet = false;
			if (provide.service !== undefined) {
				hasFacet = true;
				if (!provide.service || typeof provide.service !== "object" || Array.isArray(provide.service)) {
					throw new Error(`${context}: extension manifest provides.${capabilityId}.service must be an object`);
				}
				const service = provide.service as Record<string, unknown>;
				if (
					!hasOnlyKeys(service, ["operations"]) ||
					!service.operations ||
					typeof service.operations !== "object" ||
					Array.isArray(service.operations)
				) {
					throw new Error(
						`${context}: extension manifest provides.${capabilityId}.service.operations must be an object`,
					);
				}
				const operations = Object.entries(service.operations as Record<string, unknown>);
				if (operations.length === 0 || operations.length > 128) {
					throw new Error(
						`${context}: extension manifest provides.${capabilityId}.service.operations is empty or too large`,
					);
				}
				for (const [operationId, operationRaw] of operations) {
					if (
						!OPERATION_ID_PATTERN.test(operationId) ||
						!operationRaw ||
						typeof operationRaw !== "object" ||
						Array.isArray(operationRaw)
					) {
						throw new Error(`${context}: extension manifest capability operation is invalid`);
					}
					const operation = operationRaw as Record<string, unknown>;
					if (!hasOnlyKeys(operation, ["inputSchema", "outputSchema"])) {
						throw new Error(`${context}: extension manifest capability operation contains unknown fields`);
					}
					assertJsonSchema(
						operation.inputSchema,
						`provides.${capabilityId}.service.operations.${operationId}.inputSchema`,
						context,
					);
					assertJsonSchema(
						operation.outputSchema,
						`provides.${capabilityId}.service.operations.${operationId}.outputSchema`,
						context,
					);
				}
			}
			if (provide.ui !== undefined) {
				hasFacet = true;
				if (!provide.ui || typeof provide.ui !== "object" || Array.isArray(provide.ui)) {
					throw new Error(`${context}: extension manifest provides.${capabilityId}.ui must be an object`);
				}
				const ui = provide.ui as Record<string, unknown>;
				if (!hasOnlyKeys(ui, ["modules", "frontends"])) {
					throw new Error(`${context}: extension manifest provides.${capabilityId}.ui contains unknown fields`);
				}
				assertStableIdList(ui.modules, `provides.${capabilityId}.ui.modules`, context);
				assertStableIdList(ui.frontends, `provides.${capabilityId}.ui.frontends`, context);
				if (
					((ui.modules as string[] | undefined)?.length ?? 0) +
						((ui.frontends as string[] | undefined)?.length ?? 0) ===
					0
				) {
					throw new Error(
						`${context}: extension manifest provides.${capabilityId}.ui must reference a module or frontend`,
					);
				}
			}
			if (!hasFacet)
				throw new Error(
					`${context}: extension manifest provides.${capabilityId} must expose a service or ui facet`,
				);
		}
	}
	if (manifest.uses !== undefined) {
		if (!manifest.uses || typeof manifest.uses !== "object" || Array.isArray(manifest.uses)) {
			throw new Error(`${context}: extension manifest uses must be an object`);
		}
		const entries = Object.entries(manifest.uses as Record<string, unknown>);
		if (entries.length > 128) throw new Error(`${context}: extension manifest uses has too many entries`);
		for (const [alias, raw] of entries) {
			if (!DECLARATION_ID_PATTERN.test(alias) || !raw || typeof raw !== "object" || Array.isArray(raw)) {
				throw new Error(`${context}: extension manifest uses contains an invalid alias`);
			}
			const use = raw as Record<string, unknown>;
			if (!hasOnlyKeys(use, ["capability", "version", "required", "provider", "facets"])) {
				throw new Error(`${context}: extension manifest uses.${alias} contains unknown fields`);
			}
			if (typeof use.capability !== "string" || !DECLARATION_ID_PATTERN.test(use.capability)) {
				throw new Error(`${context}: extension manifest uses.${alias}.capability is invalid`);
			}
			if (typeof use.version !== "string" || validRange(use.version) === null) {
				throw new Error(`${context}: extension manifest uses.${alias}.version must be a valid semver range`);
			}
			if (use.required !== undefined && typeof use.required !== "boolean") {
				throw new Error(`${context}: extension manifest uses.${alias}.required must be boolean`);
			}
			if (
				use.provider !== undefined &&
				(typeof use.provider !== "string" ||
					!EXTENSION_ID_PATTERN.test(use.provider) ||
					use.provider === extensionId)
			) {
				throw new Error(`${context}: extension manifest uses.${alias}.provider is invalid`);
			}
			if (use.facets !== undefined) {
				if (
					!Array.isArray(use.facets) ||
					use.facets.length === 0 ||
					use.facets.length > 2 ||
					new Set(use.facets).size !== use.facets.length ||
					use.facets.some((facet) => facet !== "service" && facet !== "ui")
				) {
					throw new Error(`${context}: extension manifest uses.${alias}.facets is invalid`);
				}
			}
		}
	}
}

function assertSubagentTemplates(
	value: unknown,
	context: string,
): asserts value is ExtensionSubagentTemplateV1[] | undefined {
	if (value === undefined) return;
	if (!Array.isArray(value) || value.length > 64) {
		throw new Error(`${context}: extension manifest subagents must be an array with at most 64 entries`);
	}
	const ids = new Set<string>();
	for (const item of value) {
		if (!item || typeof item !== "object" || Array.isArray(item)) {
			throw new Error(`${context}: extension manifest subagents contains an invalid template`);
		}
		const template = item as Record<string, unknown>;
		if (!hasOnlyKeys(template, ["id", "name", "description", "systemPrompt", "tools", "model"])) {
			throw new Error(`${context}: extension manifest subagent contains unknown fields`);
		}
		if (typeof template.id !== "string" || !DECLARATION_ID_PATTERN.test(template.id) || ids.has(template.id)) {
			throw new Error(`${context}: extension manifest subagent id is invalid or duplicated`);
		}
		ids.add(template.id);
		for (const field of ["name", "description", "systemPrompt"] as const) {
			if (typeof template[field] !== "string" || !template[field].trim() || template[field].length > 16_000) {
				throw new Error(`${context}: extension manifest subagent ${field} is invalid`);
			}
		}
		assertToolList(template.tools, context);
		if (
			template.model !== undefined &&
			(typeof template.model !== "string" || !template.model.trim() || template.model.length > 512)
		) {
			throw new Error(`${context}: extension manifest subagent model is invalid`);
		}
	}
}

function assertOrderList(
	value: unknown,
	field: string,
	context: string,
	selfId: string,
): asserts value is string[] | undefined {
	if (value === undefined) return;
	if (!Array.isArray(value) || value.length > 128) {
		throw new Error(`${context}: extension manifest loadOrder.${field} is invalid`);
	}
	const seen = new Set<string>();
	for (const entry of value) {
		if (typeof entry !== "string" || !EXTENSION_ID_PATTERN.test(entry) || entry === selfId || seen.has(entry)) {
			throw new Error(`${context}: extension manifest loadOrder.${field} contains an invalid extension id`);
		}
		seen.add(entry);
	}
}

export function isExtensionManifestId(value: string): boolean {
	return EXTENSION_ID_PATTERN.test(value);
}

export function assertValidExtensionManifest(
	value: unknown,
	extensionId: string,
	context: string,
): asserts value is ExtensionManifestV1 {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${context}: extension manifest must be an object`);
	}
	const manifest = value as Record<string, unknown>;
	const allowedKeys = [
		"schemaVersion",
		"name",
		"version",
		"author",
		"publisher",
		"description",
		"homepage",
		"repository",
		"license",
		"dependencies",
		"optionalDependencies",
		"conflicts",
		"capabilities",
		"permissions",
		"provides",
		"uses",
		"subagents",
		"loadOrder",
	];
	if (!hasOnlyKeys(manifest, allowedKeys)) {
		throw new Error(`${context}: extension manifest contains unknown fields`);
	}
	if (manifest.schemaVersion !== 1) throw new Error(`${context}: extension manifest schemaVersion must be 1`);
	if (typeof manifest.name !== "string" || manifest.name.trim().length === 0 || manifest.name.length > 256) {
		throw new Error(`${context}: extension manifest name is invalid`);
	}
	if (typeof manifest.version !== "string" || valid(manifest.version) === null) {
		throw new Error(`${context}: extension manifest version must be valid semver`);
	}
	if (!manifest.author || typeof manifest.author !== "object" || Array.isArray(manifest.author)) {
		throw new Error(`${context}: extension manifest author must be an object`);
	}
	const author = manifest.author as Record<string, unknown>;
	if (
		!hasOnlyKeys(author, ["name", "url"]) ||
		typeof author.name !== "string" ||
		!author.name.trim() ||
		author.name.length > 256
	) {
		throw new Error(`${context}: extension manifest author is invalid`);
	}
	assertOptionalUrl(author.url, "author.url", context);
	if (
		manifest.publisher !== undefined &&
		(typeof manifest.publisher !== "string" || !EXTENSION_ID_PATTERN.test(manifest.publisher))
	) {
		throw new Error(`${context}: extension manifest publisher must be a lowercase stable identifier`);
	}
	if (
		manifest.description !== undefined &&
		(typeof manifest.description !== "string" || manifest.description.length > 2000)
	) {
		throw new Error(`${context}: extension manifest description is invalid`);
	}
	assertOptionalUrl(manifest.homepage, "homepage", context);
	assertOptionalUrl(manifest.repository, "repository", context);
	if (
		manifest.license !== undefined &&
		(typeof manifest.license !== "string" || !manifest.license.trim() || manifest.license.length > 128)
	) {
		throw new Error(`${context}: extension manifest license is invalid`);
	}
	assertStringMap(manifest.dependencies, "dependencies", context, { selfId: extensionId });
	assertStringMap(manifest.optionalDependencies, "optionalDependencies", context, { selfId: extensionId });
	assertStringMap(manifest.conflicts, "conflicts", context, { selfId: extensionId });
	const dependencies = new Set(Object.keys((manifest.dependencies as Record<string, string> | undefined) ?? {}));
	const optionalDependencies = new Set(
		Object.keys((manifest.optionalDependencies as Record<string, string> | undefined) ?? {}),
	);
	for (const id of Object.keys((manifest.conflicts as Record<string, string> | undefined) ?? {})) {
		if (dependencies.has(id) || optionalDependencies.has(id)) {
			throw new Error(`${context}: extension manifest cannot both depend on and conflict with ${id}`);
		}
	}
	for (const id of optionalDependencies) {
		if (dependencies.has(id)) {
			throw new Error(`${context}: extension manifest cannot declare ${id} as both required and optional`);
		}
	}
	assertDeclarationList(manifest.capabilities, "capabilities", context);
	assertDeclarationList(manifest.permissions, "permissions", context);
	assertCapabilityDeclarations(manifest, extensionId, context);
	assertSubagentTemplates(manifest.subagents, context);
	if (manifest.loadOrder !== undefined) {
		if (!manifest.loadOrder || typeof manifest.loadOrder !== "object" || Array.isArray(manifest.loadOrder)) {
			throw new Error(`${context}: extension manifest loadOrder must be an object`);
		}
		const loadOrder = manifest.loadOrder as Record<string, unknown>;
		if (!hasOnlyKeys(loadOrder, ["priority", "after", "before"])) {
			throw new Error(`${context}: extension manifest loadOrder contains unknown fields`);
		}
		if (
			loadOrder.priority !== undefined &&
			(typeof loadOrder.priority !== "number" ||
				!Number.isSafeInteger(loadOrder.priority) ||
				Math.abs(loadOrder.priority) > 100000)
		) {
			throw new Error(`${context}: extension manifest loadOrder.priority is invalid`);
		}
		assertOrderList(loadOrder.after, "after", context, extensionId);
		assertOrderList(loadOrder.before, "before", context, extensionId);
		const after = new Set((loadOrder.after as string[] | undefined) ?? []);
		if (((loadOrder.before as string[] | undefined) ?? []).some((id) => after.has(id))) {
			throw new Error(`${context}: extension manifest cannot load both before and after the same extension`);
		}
	}
}
