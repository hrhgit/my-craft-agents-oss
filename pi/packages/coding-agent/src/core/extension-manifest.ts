import { valid, validRange } from "semver";

export type ExtensionManifestHost = "pi" | "mortise";

export interface ExtensionManifestAuthorV1 {
	name: string;
	url?: string;
}

export interface ExtensionManifestLoadOrderV1 {
	priority?: number;
	after?: string[];
	before?: string[];
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
	engines: Partial<Record<ExtensionManifestHost, string>>;
	dependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
	conflicts?: Record<string, string>;
	capabilities?: string[];
	permissions?: string[];
	loadOrder?: ExtensionManifestLoadOrderV1;
}

export type ExtensionManifestDiagnosticCode =
	| "legacy-manifest"
	| "duplicate-id"
	| "host-incompatible"
	| "missing-dependency"
	| "dependency-version-mismatch"
	| "optional-dependency-missing"
	| "optional-dependency-version-mismatch"
	| "conflict"
	| "dependency-cycle"
	| "load-order-cycle";

export interface ExtensionManifestDiagnostic {
	code: ExtensionManifestDiagnosticCode;
	severity: "warning" | "error";
	message: string;
	relatedExtensionId?: string;
}

export type ExtensionManifestStatus = "compatible" | "warning" | "blocked" | "legacy";

const EXTENSION_ID_PATTERN = /^[a-z0-9](?:[a-z0-9.-]{0,126}[a-z0-9])?$/;
const DECLARATION_ID_PATTERN = /^[a-z][a-z0-9.-]{0,127}$/;

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
	targets: readonly ExtensionManifestHost[],
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
		"engines",
		"dependencies",
		"optionalDependencies",
		"conflicts",
		"capabilities",
		"permissions",
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
	if (!manifest.engines || typeof manifest.engines !== "object" || Array.isArray(manifest.engines)) {
		throw new Error(`${context}: extension manifest engines must be an object`);
	}
	const engines = manifest.engines as Record<string, unknown>;
	if (!hasOnlyKeys(engines, ["pi", "mortise"])) {
		throw new Error(`${context}: extension manifest engines contains unknown hosts`);
	}
	for (const target of targets) {
		const range = engines[target];
		if (typeof range !== "string" || validRange(range) === null) {
			throw new Error(`${context}: extension manifest engines.${target} must be a valid semver range`);
		}
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
