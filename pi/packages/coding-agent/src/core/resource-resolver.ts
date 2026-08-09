/** Local, read-only discovery for Mortise Agent resources. */
import { type Dirent, existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";

import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import ignore from "ignore";
import { minimatch } from "minimatch";
import { satisfies, validRange } from "semver";
import { getProjectConfigDir } from "../config.ts";
import { canonicalizePath, resolvePath } from "../utils/paths.ts";
import {
	assertValidExtensionManifest,
	type ExtensionManifestDiagnostic,
	type ExtensionManifestStatus,
	type ExtensionManifestV1,
	isExtensionManifestId,
} from "./extension-manifest.ts";
import {
	type ExtensionActivation,
	type ExtensionFrontendDiagnostic,
	type ExtensionManifestUI,
	type ExtensionManifestUIV1,
	type ExtensionManifestUIV2,
	ExtensionUISurfaces,
} from "./extensions/types.ts";
import type { SettingsManager } from "./settings-manager.ts";

export interface PathMetadata {
	source: string;
	scope: SourceScope;
	origin: "package" | "top-level";
	baseDir?: string;
	activation?: ExtensionActivation;
	extensionId?: string;
	extensionUI?: ExtensionManifestUI;
	extensionFrontendLoadable?: boolean;
	extensionFrontendDiagnostics?: ExtensionFrontendDiagnostic[];
	extensionManifest?: ExtensionManifestV1;
	extensionManifestStatus?: ExtensionManifestStatus;
	extensionManifestDiagnostics?: ExtensionManifestDiagnostic[];
	extensionLoadable?: boolean;
}

export interface ResolvedResource {
	path: string;
	enabled: boolean;
	metadata: PathMetadata;
}

export interface ResolvedPaths {
	extensions: ResolvedResource[];
	skills: ResolvedResource[];
	prompts: ResolvedResource[];
}

export interface ResourceResolverOptions {
	cwd: string;
	agentDir: string;
	projectConfigDir?: string;
	settingsManager: SettingsManager;
}

type SourceScope = "user" | "project" | "temporary";

export interface ExtensionManifestEntry {
	id: string;
	path: string;
	activation?: ExtensionActivation;
	manifest?: ExtensionManifestV1;
	ui?: ExtensionManifestUI;
	frontendDiagnostics?: ExtensionFrontendDiagnostic[];
}

type ManifestResourceEntry = ExtensionManifestEntry;

interface PiManifest {
	extensions?: ManifestResourceEntry[];
	skills?: string[];
	prompts?: string[];
}

interface ResourceAccumulator {
	extensions: Map<string, { metadata: PathMetadata; enabled: boolean }>;
	skills: Map<string, { metadata: PathMetadata; enabled: boolean }>;
	prompts: Map<string, { metadata: PathMetadata; enabled: boolean }>;
}

/**
 * Compute a numeric precedence rank for a resource based on its metadata.
 * Lower rank = higher precedence. Used to sort resolved resources so that
 * name-collision resolution ("first wins") produces the correct outcome.
 *
 * Precedence (highest to lowest):
 *   0  project + settings entry (source: "local", scope: "project")
 *   1  project + auto-discovered (source: "auto", scope: "project")
 *   2  user + settings entry (source: "local", scope: "user")
 *   3  user + auto-discovered (source: "auto", scope: "user")
 *   4  package resource (origin: "package")
 */
function resourcePrecedenceRank(m: PathMetadata): number {
	if (m.origin === "package") return 4;
	const scopeBase = m.scope === "project" ? 0 : 2;
	return scopeBase + (m.source === "local" ? 0 : 1);
}

type ResourceType = "extensions" | "skills" | "prompts";

const FILE_PATTERNS: Record<ResourceType, RegExp> = {
	extensions: /\.(ts|js)$/,
	skills: /\.md$/,
	prompts: /\.md$/,
};

const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];

type IgnoreMatcher = ReturnType<typeof ignore>;

export type ResourcePathEntry =
	| string
	| {
			id?: string;
			path: string;
			activation?: ExtensionActivation;
			manifest?: ExtensionManifestV1;
			ui?: ExtensionManifestUI;
	  };

interface ResolvedResourcePathEntry {
	id?: string;
	path: string;
	activation?: ExtensionActivation;
	manifest?: ExtensionManifestV1;
	ui?: ExtensionManifestUI;
}

interface ExtensionDiscoveryEntry extends ResolvedResourcePathEntry {
	id: string;
	manifest?: ExtensionManifestV1;
	ui?: ExtensionManifestUI;
	frontendDiagnostics?: ExtensionFrontendDiagnostic[];
}

const EXTENSION_ACTIVATIONS: ExtensionActivation[] = ["startup", "beforeFirstRequest", "lazy"];

function parseExtensionActivation(value: unknown): ExtensionActivation | undefined {
	if (typeof value !== "string") return undefined;
	return EXTENSION_ACTIVATIONS.includes(value as ExtensionActivation) ? (value as ExtensionActivation) : undefined;
}

function getResourceEntryPath(entry: ResourcePathEntry): string {
	return typeof entry === "string" ? entry : entry.path;
}

function getResourceEntryActivation(entry: ResourcePathEntry): ExtensionActivation | undefined {
	return typeof entry === "string" ? undefined : parseExtensionActivation(entry.activation);
}

function getResourceEntryManifest(entry: ResourcePathEntry): ExtensionManifestV1 | undefined {
	return typeof entry === "string" ? undefined : entry.manifest;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
	return Object.keys(value).every((key) => allowed.includes(key));
}

function assertValidExtensionUIV1(value: unknown, context: string): asserts value is ExtensionManifestUIV1 {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error(`${context}: extension ui must be an object`);
	const ui = value as Record<string, unknown>;
	if (!hasOnlyKeys(ui, ["schemaVersion", "title", "description", "category", "settings"]))
		throw new Error(`${context}: extension ui contains unknown fields`);
	if (ui.schemaVersion !== 1) throw new Error(`${context}: extension ui schemaVersion must be 1`);
	if (ui.title !== undefined && (typeof ui.title !== "string" || ui.title.length > 256))
		throw new Error(`${context}: extension ui title is invalid`);
	if (ui.description !== undefined && (typeof ui.description !== "string" || ui.description.length > 2000))
		throw new Error(`${context}: extension ui description is invalid`);
	if (
		ui.category !== undefined &&
		!["ui", "automation", "agent", "shell", "diagnostics", "memory", "search", "other"].includes(String(ui.category))
	)
		throw new Error(`${context}: extension ui category is invalid`);
	if (ui.settings === undefined) return;
	if (!ui.settings || typeof ui.settings !== "object" || Array.isArray(ui.settings))
		throw new Error(`${context}: extension settings must be an object`);
	const settings = ui.settings as Record<string, unknown>;
	if (!hasOnlyKeys(settings, ["schemaVersion", "groups", "fields", "page"]))
		throw new Error(`${context}: extension settings contains unknown fields`);
	if (settings.schemaVersion !== 1 || !Array.isArray(settings.fields) || settings.fields.length > 128)
		throw new Error(`${context}: extension settings schema is invalid`);
	if (settings.page !== undefined) {
		if (!settings.page || typeof settings.page !== "object" || Array.isArray(settings.page))
			throw new Error(`${context}: extension settings page is invalid`);
		const page = settings.page as Record<string, unknown>;
		if (
			!hasOnlyKeys(page, ["id", "title", "description", "icon", "order"]) ||
			typeof page.id !== "string" ||
			!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(page.id) ||
			typeof page.title !== "string" ||
			page.title.length === 0 ||
			page.title.length > 256
		)
			throw new Error(`${context}: extension settings page requires a bounded id and title`);
		if (page.description !== undefined && (typeof page.description !== "string" || page.description.length > 2000))
			throw new Error(`${context}: extension settings page description is invalid`);
		if (page.icon !== undefined && (typeof page.icon !== "string" || !/^[A-Za-z][A-Za-z0-9-]{0,31}$/.test(page.icon)))
			throw new Error(`${context}: extension settings page icon is invalid`);
		if (
			page.order !== undefined &&
			(typeof page.order !== "number" || !Number.isFinite(page.order) || page.order < -1000 || page.order > 1000)
		)
			throw new Error(`${context}: extension settings page order is invalid`);
	}
	const groups = new Set<string>();
	if (settings.groups !== undefined) {
		if (!Array.isArray(settings.groups) || settings.groups.length > 32)
			throw new Error(`${context}: extension setting groups are invalid`);
		for (const candidate of settings.groups) {
			if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
				throw new Error(`${context}: extension setting group is invalid`);
			const group = candidate as Record<string, unknown>;
			if (
				!hasOnlyKeys(group, ["id", "title", "description"]) ||
				typeof group.id !== "string" ||
				typeof group.title !== "string" ||
				groups.has(group.id)
			)
				throw new Error(`${context}: extension setting groups require unique ids and titles`);
			groups.add(group.id);
		}
	}
	const keys = new Set<string>();
	for (const candidate of settings.fields) {
		if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
			throw new Error(`${context}: extension setting field is invalid`);
		const field = candidate as Record<string, unknown>;
		const commonKeys = ["key", "type", "label", "description", "group", "requiresReload", "visibleWhen", "default"];
		const typeKeys =
			field.type === "number"
				? ["min", "max", "step"]
				: field.type === "string" || field.type === "textarea"
					? ["minLength", "maxLength"]
					: field.type === "select"
						? ["options"]
						: field.type === "model-reference"
							? []
							: [];
		if (!hasOnlyKeys(field, [...commonKeys, ...typeKeys]))
			throw new Error(`${context}: extension setting field contains unknown fields`);
		if (typeof field.key !== "string" || !/^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(field.key) || keys.has(field.key))
			throw new Error(`${context}: extension setting keys must be unique stable identifiers`);
		keys.add(field.key);
		if (typeof field.label !== "string" || field.label.length === 0 || field.label.length > 256)
			throw new Error(`${context}: extension setting label is invalid`);
		if (
			!["boolean", "string", "textarea", "number", "select", "model", "model-reference"].includes(String(field.type))
		)
			throw new Error(`${context}: extension setting type is invalid`);
		if (field.type === "boolean" && typeof field.default !== "boolean")
			throw new Error(`${context}: boolean settings require a default`);
		if (
			field.type === "model-reference" &&
			field.default !== undefined &&
			(typeof field.default !== "string" ||
				!/^current-session$|^default:[1-9]\d*$|^model:[^/]+\/.+$/.test(field.default))
		)
			throw new Error(`${context}: model-reference default is invalid`);
		if (
			field.type === "select" &&
			(!Array.isArray(field.options) || field.options.length === 0 || field.options.length > 128)
		)
			throw new Error(`${context}: select settings require options`);
		if (field.group !== undefined && (typeof field.group !== "string" || !groups.has(field.group)))
			throw new Error(`${context}: extension setting references an unknown group`);
		if (field.requiresReload !== undefined && typeof field.requiresReload !== "boolean")
			throw new Error(`${context}: requiresReload must be boolean`);
		if (field.type === "number") {
			for (const key of ["default", "min", "max", "step"] as const) {
				if (field[key] !== undefined && (typeof field[key] !== "number" || !Number.isFinite(field[key])))
					throw new Error(`${context}: numeric setting bounds are invalid`);
			}
			if (typeof field.min === "number" && typeof field.max === "number" && field.min > field.max)
				throw new Error(`${context}: numeric setting bounds are inconsistent`);
		}
		if (field.type === "select") {
			const optionValues = new Set<string>();
			for (const option of field.options as Array<Record<string, unknown>>) {
				if (
					!option ||
					typeof option !== "object" ||
					!hasOnlyKeys(option, ["value", "label", "description"]) ||
					typeof option.value !== "string" ||
					typeof option.label !== "string" ||
					optionValues.has(option.value)
				)
					throw new Error(`${context}: select options are invalid`);
				optionValues.add(option.value);
			}
			if (field.default !== undefined && (typeof field.default !== "string" || !optionValues.has(field.default)))
				throw new Error(`${context}: select default must use a declared option`);
		}
		if (field.visibleWhen !== undefined) {
			const condition = field.visibleWhen as Record<string, unknown>;
			if (
				!condition ||
				typeof condition !== "object" ||
				typeof condition.key !== "string" ||
				!["string", "number", "boolean"].includes(typeof condition.equals)
			)
				throw new Error(`${context}: setting visibility condition is invalid`);
		}
	}
	for (const candidate of settings.fields) {
		const condition = (candidate as Record<string, unknown>).visibleWhen as Record<string, unknown> | undefined;
		if (condition && !keys.has(String(condition.key)))
			throw new Error(`${context}: visibility condition references an unknown setting`);
	}
}

export const MORTISE_EXTENSION_UI_API_VERSION = "2.0.0";
export const MORTISE_EXTENSION_UI_HOST_VERSION = "0.1.0";

const extensionFrontendModes = new Set(["append", "replace", "overlay"]);
const extensionFrontendScopes = new Set(["session", "workspace", "global"]);
const extensionFrontendSurfaces = new Set<string>([...ExtensionUISurfaces, "settings.page"]);
const stableFrontendId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function assertBoundedOptionalText(value: unknown, maxLength: number, message: string): void {
	if (value !== undefined && (typeof value !== "string" || value.length > maxLength)) throw new Error(message);
}

function assertPackageRelativeResource(value: unknown, context: string): asserts value is string {
	if (
		typeof value !== "string" ||
		!value.startsWith("./") ||
		value.includes("\\") ||
		isAbsolute(value) ||
		value.includes("\0")
	) {
		throw new Error(`${context}: frontend resources must use package-relative ./ paths`);
	}
	const parts = value.slice(2).split("/");
	if (parts.length === 0 || parts.some((part) => !part || part === "." || part === "..")) {
		throw new Error(`${context}: frontend resource path is invalid`);
	}
}

function assertValidFrontendPage(value: unknown, context: string): void {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error(`${context}: settings page is invalid`);
	const page = value as Record<string, unknown>;
	if (!hasOnlyKeys(page, ["id", "title", "description", "icon", "order"]))
		throw new Error(`${context}: settings page contains unknown fields`);
	if (typeof page.id !== "string" || !stableFrontendId.test(page.id))
		throw new Error(`${context}: settings page id is invalid`);
	if (typeof page.title !== "string" || page.title.length === 0 || page.title.length > 256)
		throw new Error(`${context}: settings page title is invalid`);
	assertBoundedOptionalText(page.description, 2000, `${context}: settings page description is invalid`);
	if (page.icon !== undefined && (typeof page.icon !== "string" || !/^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(page.icon)))
		throw new Error(`${context}: settings page icon is invalid`);
	if (
		page.order !== undefined &&
		(typeof page.order !== "number" || !Number.isFinite(page.order) || page.order < -1000 || page.order > 1000)
	) {
		throw new Error(`${context}: settings page order is invalid`);
	}
}

function assertValidExtensionUIV2(value: unknown, context: string): asserts value is ExtensionManifestUIV2 {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error(`${context}: extension ui must be an object`);
	const ui = value as Record<string, unknown>;
	if (
		!hasOnlyKeys(ui, [
			"schemaVersion",
			"title",
			"description",
			"category",
			"compatibility",
			"frontends",
			"modules",
			"overrides",
		])
	)
		throw new Error(`${context}: extension ui contains unknown fields`);
	if (ui.schemaVersion !== 2) throw new Error(`${context}: extension ui schemaVersion must be 2`);
	assertBoundedOptionalText(ui.title, 256, `${context}: extension ui title is invalid`);
	assertBoundedOptionalText(ui.description, 2000, `${context}: extension ui description is invalid`);
	if (
		ui.category !== undefined &&
		!["ui", "automation", "agent", "shell", "diagnostics", "memory", "search", "other"].includes(String(ui.category))
	) {
		throw new Error(`${context}: extension ui category is invalid`);
	}
	if (!ui.compatibility || typeof ui.compatibility !== "object" || Array.isArray(ui.compatibility))
		throw new Error(`${context}: extension ui compatibility is required`);
	const compatibility = ui.compatibility as Record<string, unknown>;
	if (!hasOnlyKeys(compatibility, ["uiApi", "mortise"]))
		throw new Error(`${context}: extension ui compatibility contains unknown fields`);
	for (const key of ["uiApi", "mortise"] as const) {
		if (typeof compatibility[key] !== "string" || validRange(compatibility[key]) === null)
			throw new Error(`${context}: extension ui compatibility.${key} must be a valid semver range`);
	}
	if (ui.frontends !== undefined && (!Array.isArray(ui.frontends) || ui.frontends.length > 64))
		throw new Error(`${context}: extension ui frontends must be a bounded array`);
	if (ui.modules !== undefined && (!Array.isArray(ui.modules) || ui.modules.length > 64))
		throw new Error(`${context}: extension ui modules must be a bounded array`);
	if (ui.overrides !== undefined && (!Array.isArray(ui.overrides) || ui.overrides.length > 64))
		throw new Error(`${context}: extension ui overrides must be a bounded array`);
	if (
		(!Array.isArray(ui.frontends) || ui.frontends.length === 0) &&
		(!Array.isArray(ui.modules) || ui.modules.length === 0) &&
		(!Array.isArray(ui.overrides) || ui.overrides.length === 0)
	)
		throw new Error(`${context}: extension ui must declare frontends or modules`);
	const ids = new Set<string>();
	for (const candidate of ui.frontends ?? []) {
		if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
			throw new Error(`${context}: frontend entry is invalid`);
		const frontend = candidate as Record<string, unknown>;
		if (!hasOnlyKeys(frontend, ["id", "entry", "styles", "surface", "mode", "scope", "page"]))
			throw new Error(`${context}: frontend entry contains unknown fields`);
		if (typeof frontend.id !== "string" || !stableFrontendId.test(frontend.id) || ids.has(frontend.id))
			throw new Error(`${context}: frontend ids must be unique stable identifiers`);
		ids.add(frontend.id);
		assertPackageRelativeResource(frontend.entry, `${context}: frontend ${frontend.id}`);
		if (frontend.styles !== undefined) {
			if (!Array.isArray(frontend.styles) || frontend.styles.length > 32)
				throw new Error(`${context}: frontend styles are invalid`);
			const styles = new Set<string>();
			for (const style of frontend.styles) {
				assertPackageRelativeResource(style, `${context}: frontend ${frontend.id}`);
				if (styles.has(style)) throw new Error(`${context}: frontend styles must be unique`);
				styles.add(style);
			}
		}
		if (!extensionFrontendSurfaces.has(String(frontend.surface)))
			throw new Error(`${context}: frontend surface is invalid`);
		if (!extensionFrontendModes.has(String(frontend.mode))) throw new Error(`${context}: frontend mode is invalid`);
		if (!extensionFrontendScopes.has(String(frontend.scope)))
			throw new Error(`${context}: frontend scope is invalid`);
		if (frontend.surface === "settings.page") {
			assertValidFrontendPage(frontend.page, `${context}: frontend ${frontend.id}`);
		} else if (frontend.page !== undefined) {
			throw new Error(`${context}: only settings.page frontends may declare page metadata`);
		}
	}
	const moduleIds = new Set<string>();
	for (const candidate of ui.modules ?? []) {
		if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
			throw new Error(`${context}: ui module entry is invalid`);
		const module = candidate as Record<string, unknown>;
		if (!hasOnlyKeys(module, ["id", "entry", "styles", "apiVersion"]))
			throw new Error(`${context}: ui module entry contains unknown fields`);
		if (typeof module.id !== "string" || !stableFrontendId.test(module.id) || moduleIds.has(module.id))
			throw new Error(`${context}: ui module ids must be unique stable identifiers`);
		moduleIds.add(module.id);
		assertPackageRelativeResource(module.entry, `${context}: ui module ${module.id}`);
		if (typeof module.apiVersion !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(module.apiVersion))
			throw new Error(`${context}: ui module ${module.id} apiVersion is invalid`);
		if (module.styles !== undefined) {
			if (!Array.isArray(module.styles) || module.styles.length > 32)
				throw new Error(`${context}: ui module styles are invalid`);
			for (const style of module.styles) assertPackageRelativeResource(style, `${context}: ui module ${module.id}`);
		}
	}
	const overrideIds = new Set<string>();
	for (const candidate of ui.overrides ?? []) {
		if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
			throw new Error(`${context}: ui override entry is invalid`);
		const override = candidate as Record<string, unknown>;
		if (!hasOnlyKeys(override, ["id", "target", "mode", "entry", "styles"]))
			throw new Error(`${context}: ui override entry contains unknown fields`);
		if (typeof override.id !== "string" || !stableFrontendId.test(override.id) || overrideIds.has(override.id))
			throw new Error(`${context}: ui override ids must be unique stable identifiers`);
		overrideIds.add(override.id);
		if (!override.target || typeof override.target !== "object" || Array.isArray(override.target))
			throw new Error(`${context}: ui override ${override.id} target is invalid`);
		const target = override.target as Record<string, unknown>;
		if (
			!hasOnlyKeys(target, ["extensionId", "kind", "id"]) ||
			typeof target.extensionId !== "string" ||
			!isExtensionManifestId(target.extensionId) ||
			!["frontend", "module"].includes(String(target.kind)) ||
			typeof target.id !== "string" ||
			!stableFrontendId.test(target.id)
		)
			throw new Error(`${context}: ui override ${override.id} target is invalid`);
		if (!["decorate", "replace"].includes(String(override.mode)))
			throw new Error(`${context}: ui override ${override.id} mode is invalid`);
		assertPackageRelativeResource(override.entry, `${context}: ui override ${override.id}`);
		if (override.styles !== undefined) {
			if (!Array.isArray(override.styles) || override.styles.length > 32)
				throw new Error(`${context}: ui override styles are invalid`);
			for (const style of override.styles)
				assertPackageRelativeResource(style, `${context}: ui override ${override.id}`);
		}
	}
}

function isPathInsideRoot(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function inspectExtensionUI(
	value: unknown,
	extensionRoot: string,
	context: string,
): { ui?: ExtensionManifestUI; diagnostics: ExtensionFrontendDiagnostic[] } {
	if ((value as { schemaVersion?: unknown } | undefined)?.schemaVersion !== 2) {
		assertValidExtensionUIV1(value, context);
		return { ui: value, diagnostics: [] };
	}
	try {
		assertValidExtensionUIV2(value, context);
	} catch (error) {
		return {
			diagnostics: [
				{
					code: "invalid-ui-manifest",
					severity: "error",
					message: error instanceof Error ? error.message : String(error),
				},
			],
		};
	}
	const ui = value as ExtensionManifestUIV2;
	const diagnostics: ExtensionFrontendDiagnostic[] = [];
	if (!satisfies(MORTISE_EXTENSION_UI_API_VERSION, ui.compatibility.uiApi, { includePrerelease: true })) {
		diagnostics.push({
			code: "ui-api-version-mismatch",
			severity: "error",
			message: `Requires UI API ${ui.compatibility.uiApi}; host provides ${MORTISE_EXTENSION_UI_API_VERSION}`,
		});
	}
	if (!satisfies(MORTISE_EXTENSION_UI_HOST_VERSION, ui.compatibility.mortise, { includePrerelease: true })) {
		diagnostics.push({
			code: "mortise-version-mismatch",
			severity: "error",
			message: `Requires Mortise ${ui.compatibility.mortise}; host is ${MORTISE_EXTENSION_UI_HOST_VERSION}`,
		});
	}
	const canonicalRoot = realpathSync(extensionRoot);
	for (const frontend of ui.frontends ?? []) {
		for (const resource of [frontend.entry, ...(frontend.styles ?? [])]) {
			const extension = extname(resource).toLowerCase();
			const isEntry = resource === frontend.entry;
			if ((isEntry && extension !== ".js" && extension !== ".mjs") || (!isEntry && extension !== ".css")) {
				diagnostics.push({
					code: isEntry ? "frontend-entry-mime-invalid" : "frontend-style-mime-invalid",
					severity: "error",
					message: `Frontend ${isEntry ? "entry" : "style"} has an unsupported file type: ${resource}`,
					frontendId: frontend.id,
					resource,
				});
				continue;
			}
			const resolvedResource = resolve(extensionRoot, resource);
			if (!isPathInsideRoot(extensionRoot, resolvedResource)) {
				diagnostics.push({
					code: "frontend-path-outside-package",
					severity: "error",
					message: `Frontend resource escapes the extension package: ${resource}`,
					frontendId: frontend.id,
					resource,
				});
				continue;
			}
			if (!existsSync(resolvedResource) || !statSync(resolvedResource).isFile()) {
				diagnostics.push({
					code: "frontend-resource-missing",
					severity: "error",
					message: `Frontend resource does not exist: ${resource}`,
					frontendId: frontend.id,
					resource,
				});
				continue;
			}
			if (!isPathInsideRoot(canonicalRoot, realpathSync(resolvedResource))) {
				diagnostics.push({
					code: "frontend-symlink-outside-package",
					severity: "error",
					message: `Frontend resource resolves outside the extension package: ${resource}`,
					frontendId: frontend.id,
					resource,
				});
			}
		}
	}
	for (const module of ui.modules ?? []) {
		for (const resource of [module.entry, ...(module.styles ?? [])]) {
			const extension = extname(resource).toLowerCase();
			const isEntry = resource === module.entry;
			const diagnosticBase = { frontendId: `module:${module.id}`, resource };
			if ((isEntry && extension !== ".js" && extension !== ".mjs") || (!isEntry && extension !== ".css")) {
				diagnostics.push({
					code: isEntry ? "frontend-entry-mime-invalid" : "frontend-style-mime-invalid",
					severity: "error",
					message: `UI module ${isEntry ? "entry" : "style"} has an unsupported file type: ${resource}`,
					...diagnosticBase,
				});
				continue;
			}
			const resolvedResource = resolve(extensionRoot, resource);
			if (
				!isPathInsideRoot(extensionRoot, resolvedResource) ||
				!existsSync(resolvedResource) ||
				!statSync(resolvedResource).isFile() ||
				!isPathInsideRoot(canonicalRoot, realpathSync(resolvedResource))
			) {
				diagnostics.push({
					code: "frontend-resource-missing",
					severity: "error",
					message: `UI module resource does not exist or escapes the extension package: ${resource}`,
					...diagnosticBase,
				});
			}
		}
	}
	for (const override of ui.overrides ?? []) {
		for (const resource of [override.entry, ...(override.styles ?? [])]) {
			const extension = extname(resource).toLowerCase();
			const isEntry = resource === override.entry;
			const diagnosticBase = { frontendId: `override:${override.id}`, resource };
			if ((isEntry && extension !== ".js" && extension !== ".mjs") || (!isEntry && extension !== ".css")) {
				diagnostics.push({
					code: isEntry ? "frontend-entry-mime-invalid" : "frontend-style-mime-invalid",
					severity: "error",
					message: `UI override ${isEntry ? "entry" : "style"} has an unsupported file type: ${resource}`,
					...diagnosticBase,
				});
				continue;
			}
			const resolvedResource = resolve(extensionRoot, resource);
			if (
				!isPathInsideRoot(extensionRoot, resolvedResource) ||
				!existsSync(resolvedResource) ||
				!statSync(resolvedResource).isFile() ||
				!isPathInsideRoot(canonicalRoot, realpathSync(resolvedResource))
			) {
				diagnostics.push({
					code: "frontend-resource-missing",
					severity: "error",
					message: `UI override resource does not exist or escapes the extension package: ${resource}`,
					...diagnosticBase,
				});
			}
		}
	}
	return { ui, diagnostics };
}

function getResourceEntryId(entry: ResourcePathEntry): string | undefined {
	if (typeof entry === "string") return undefined;
	const id = entry.id?.trim();
	return id && isExtensionManifestId(id) ? id : undefined;
}

export function assertValidExtensionEntry(entry: unknown, context: string): asserts entry is ExtensionManifestEntry {
	if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
		throw new Error(`${context}: extension entries must be objects with id and path`);
	}
	const candidate = entry as Exclude<ResourcePathEntry, string>;
	const extensionId = getResourceEntryId(candidate);
	if (!extensionId) {
		throw new Error(`${context}: extension id must be a lowercase stable identifier`);
	}
	if (!hasOnlyKeys(entry as Record<string, unknown>, ["id", "path", "activation", "manifest", "ui"])) {
		throw new Error(`${context}: extension entry contains unknown fields`);
	}
	if (typeof candidate.path !== "string" || !candidate.path.trim()) {
		throw new Error(`${context}: extension path must be a non-empty string`);
	}
	if (candidate.activation !== undefined && parseExtensionActivation(candidate.activation) === undefined) {
		throw new Error(`${context}: extension activation is invalid`);
	}
	if (candidate.manifest !== undefined) assertValidExtensionManifest(candidate.manifest, extensionId, context);
	if (candidate.ui !== undefined && (candidate.ui as { schemaVersion?: unknown }).schemaVersion !== 2) {
		assertValidExtensionUIV1(candidate.ui, context);
	}
}

function getSettingsResourceEntries(
	settings: ReturnType<SettingsManager["getGlobalSettings"]>,
	resourceType: ResourceType,
): ResourcePathEntry[] {
	const entries = settings[resourceType];
	return Array.isArray(entries) ? (entries as ResourcePathEntry[]) : [];
}

function getSettingsStringEntries(
	settings: ReturnType<SettingsManager["getGlobalSettings"]>,
	resourceType: Exclude<ResourceType, "extensions">,
): string[] {
	const entries = settings[resourceType];
	return Array.isArray(entries) ? (entries as string[]) : [];
}

function withExtensionMetadata(
	metadata: PathMetadata,
	activation: ExtensionActivation | undefined,
	extensionId?: string,
	extensionUI?: ExtensionManifestUI,
	extensionManifest?: ExtensionManifestV1,
	extensionFrontendDiagnostics: ExtensionFrontendDiagnostic[] = [],
): PathMetadata {
	const next: PathMetadata = { ...metadata };
	if (activation) {
		next.activation = activation;
	}
	if (extensionId) {
		next.extensionId = extensionId;
	}
	if (extensionUI) next.extensionUI = extensionUI;
	if (extensionUI?.schemaVersion === 2 || extensionFrontendDiagnostics.length > 0) {
		next.extensionFrontendDiagnostics = extensionFrontendDiagnostics;
		next.extensionFrontendLoadable = extensionFrontendDiagnostics.every((item) => item.severity !== "error");
	}
	if (extensionManifest) next.extensionManifest = extensionManifest;
	return next;
}

function toPosixPath(p: string): string {
	return p.split(sep).join("/");
}

function getHomeDir(): string {
	return process.env.HOME || homedir();
}

function prefixIgnorePattern(line: string, prefix: string): string | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	if (trimmed.startsWith("#") && !trimmed.startsWith("\\#")) return null;

	let pattern = line;
	let negated = false;

	if (pattern.startsWith("!")) {
		negated = true;
		pattern = pattern.slice(1);
	} else if (pattern.startsWith("\\!")) {
		pattern = pattern.slice(1);
	}

	if (pattern.startsWith("/")) {
		pattern = pattern.slice(1);
	}

	const prefixed = prefix ? `${prefix}${pattern}` : pattern;
	return negated ? `!${prefixed}` : prefixed;
}

function addIgnoreRules(ig: IgnoreMatcher, dir: string, rootDir: string): void {
	const relativeDir = relative(rootDir, dir);
	const prefix = relativeDir ? `${toPosixPath(relativeDir)}/` : "";

	for (const filename of IGNORE_FILE_NAMES) {
		const ignorePath = join(dir, filename);
		if (!existsSync(ignorePath)) continue;
		try {
			const content = readFileSync(ignorePath, "utf-8");
			const patterns = content
				.split(/\r?\n/)
				.map((line) => prefixIgnorePattern(line, prefix))
				.filter((line): line is string => Boolean(line));
			if (patterns.length > 0) {
				ig.add(patterns);
			}
		} catch {}
	}
}

function collectFiles(
	dir: string,
	filePattern: RegExp,
	skipNodeModules = true,
	ignoreMatcher?: IgnoreMatcher,
	rootDir?: string,
): string[] {
	const files: string[] = [];
	if (!existsSync(dir)) return files;

	const root = rootDir ?? dir;
	const ig = ignoreMatcher ?? ignore();
	addIgnoreRules(ig, dir, root);

	try {
		const entries = readdirSync(dir, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.name.startsWith(".")) continue;
			if (skipNodeModules && entry.name === "node_modules") continue;

			const fullPath = join(dir, entry.name);
			let isDir = entry.isDirectory();
			let isFile = entry.isFile();

			if (entry.isSymbolicLink()) {
				try {
					const stats = statSync(fullPath);
					isDir = stats.isDirectory();
					isFile = stats.isFile();
				} catch {
					continue;
				}
			}

			const relPath = toPosixPath(relative(root, fullPath));
			const ignorePath = isDir ? `${relPath}/` : relPath;
			if (ig.ignores(ignorePath)) continue;

			if (isDir) {
				files.push(...collectFiles(fullPath, filePattern, skipNodeModules, ig, root));
			} else if (isFile && filePattern.test(entry.name)) {
				files.push(fullPath);
			}
		}
	} catch {
		// Ignore errors
	}

	return files;
}

type SkillDiscoveryMode = "pi" | "agents";

function collectSkillEntries(
	dir: string,
	mode: SkillDiscoveryMode,
	ignoreMatcher?: IgnoreMatcher,
	rootDir?: string,
): string[] {
	const entries: string[] = [];
	if (!existsSync(dir)) return entries;

	const root = rootDir ?? dir;
	const ig = ignoreMatcher ?? ignore();
	addIgnoreRules(ig, dir, root);

	try {
		const dirEntries = readdirSync(dir, { withFileTypes: true });

		for (const entry of dirEntries) {
			if (entry.name !== "SKILL.md") {
				continue;
			}

			const fullPath = join(dir, entry.name);
			let isFile = entry.isFile();
			if (entry.isSymbolicLink()) {
				try {
					isFile = statSync(fullPath).isFile();
				} catch {
					continue;
				}
			}

			const relPath = toPosixPath(relative(root, fullPath));
			if (isFile && !ig.ignores(relPath)) {
				entries.push(fullPath);
				return entries;
			}
		}

		for (const entry of dirEntries) {
			if (entry.name.startsWith(".")) continue;
			if (entry.name === "node_modules") continue;

			const fullPath = join(dir, entry.name);
			let isDir = entry.isDirectory();
			let isFile = entry.isFile();

			if (entry.isSymbolicLink()) {
				try {
					const stats = statSync(fullPath);
					isDir = stats.isDirectory();
					isFile = stats.isFile();
				} catch {
					continue;
				}
			}

			const relPath = toPosixPath(relative(root, fullPath));
			if (mode === "pi" && dir === root && isFile && entry.name.endsWith(".md") && !ig.ignores(relPath)) {
				entries.push(fullPath);
				continue;
			}

			if (!isDir) continue;
			if (ig.ignores(`${relPath}/`)) continue;

			entries.push(...collectSkillEntries(fullPath, mode, ig, root));
		}
	} catch {
		// Ignore errors
	}

	return entries;
}

function collectAutoSkillEntries(dir: string, mode: SkillDiscoveryMode): string[] {
	return collectSkillEntries(dir, mode);
}

function findGitRepoRoot(startDir: string): string | null {
	let dir = resolve(startDir);
	while (true) {
		if (existsSync(join(dir, ".git"))) {
			return dir;
		}
		const parent = dirname(dir);
		if (parent === dir) {
			return null;
		}
		dir = parent;
	}
}

function collectAncestorAgentsSkillDirs(startDir: string): string[] {
	const skillDirs: string[] = [];
	const resolvedStartDir = resolve(startDir);
	const gitRepoRoot = findGitRepoRoot(resolvedStartDir);

	let dir = resolvedStartDir;
	while (true) {
		skillDirs.push(join(dir, ".agents", "skills"));
		if (gitRepoRoot && dir === gitRepoRoot) {
			break;
		}
		const parent = dirname(dir);
		if (parent === dir) {
			break;
		}
		dir = parent;
	}

	return skillDirs;
}

function collectAutoPromptEntries(dir: string): string[] {
	const entries: string[] = [];
	if (!existsSync(dir)) return entries;

	const ig = ignore();
	addIgnoreRules(ig, dir, dir);

	try {
		const dirEntries = readdirSync(dir, { withFileTypes: true });
		for (const entry of dirEntries) {
			if (entry.name.startsWith(".")) continue;
			if (entry.name === "node_modules") continue;

			const fullPath = join(dir, entry.name);
			let isFile = entry.isFile();
			if (entry.isSymbolicLink()) {
				try {
					isFile = statSync(fullPath).isFile();
				} catch {
					continue;
				}
			}

			const relPath = toPosixPath(relative(dir, fullPath));
			if (ig.ignores(relPath)) continue;

			if (isFile && entry.name.endsWith(".md")) {
				entries.push(fullPath);
			}
		}
	} catch {
		// Ignore errors
	}

	return entries;
}

function readPiManifestFile(packageJsonPath: string): PiManifest | null {
	try {
		const content = readFileSync(packageJsonPath, "utf-8");
		const pkg = JSON.parse(content) as { pi?: PiManifest };
		return pkg.pi ?? null;
	} catch {
		return null;
	}
}

function resolveExtensionEntries(dir: string): ExtensionDiscoveryEntry[] | null {
	const packageJsonPath = join(dir, "package.json");
	if (existsSync(packageJsonPath)) {
		const manifest = readPiManifestFile(packageJsonPath);
		if (manifest?.extensions?.length) {
			const entries: ExtensionDiscoveryEntry[] = [];
			for (const entry of manifest.extensions) {
				assertValidExtensionEntry(entry, packageJsonPath);
				const extPath = getResourceEntryPath(entry);
				const resolvedExtPath = resolve(dir, extPath);
				if (existsSync(resolvedExtPath)) {
					const inspectedUI =
						entry.ui === undefined
							? { ui: undefined, diagnostics: [] }
							: inspectExtensionUI(
									entry.ui,
									statSync(resolvedExtPath).isDirectory() ? resolvedExtPath : dirname(resolvedExtPath),
									packageJsonPath,
								);
					entries.push({
						id: entry.id,
						path: resolvedExtPath,
						activation: getResourceEntryActivation(entry),
						manifest: getResourceEntryManifest(entry),
						ui: inspectedUI.ui,
						frontendDiagnostics: inspectedUI.diagnostics,
					});
				}
			}
			if (entries.length > 0) {
				return entries;
			}
		}
	}

	return null;
}

function collectAutoExtensionEntries(dir: string): ExtensionDiscoveryEntry[] {
	const entries: ExtensionDiscoveryEntry[] = [];
	if (!existsSync(dir)) return entries;

	// First check if this directory itself has explicit extension entries (package.json or index)
	const rootEntries = resolveExtensionEntries(dir);
	if (rootEntries) {
		return rootEntries;
	}

	// Otherwise, discover extensions from directory contents
	const ig = ignore();
	addIgnoreRules(ig, dir, dir);

	try {
		const dirEntries = readdirSync(dir, { withFileTypes: true });
		for (const entry of dirEntries) {
			if (entry.name.startsWith(".")) continue;
			if (entry.name === "node_modules") continue;

			const fullPath = join(dir, entry.name);
			let isDir = entry.isDirectory();

			if (entry.isSymbolicLink()) {
				try {
					const stats = statSync(fullPath);
					isDir = stats.isDirectory();
				} catch {
					continue;
				}
			}

			const relPath = toPosixPath(relative(dir, fullPath));
			const ignorePath = isDir ? `${relPath}/` : relPath;
			if (ig.ignores(ignorePath)) continue;

			if (isDir) {
				const resolvedEntries = resolveExtensionEntries(fullPath);
				if (resolvedEntries) {
					entries.push(...resolvedEntries);
				}
			}
		}
	} catch {
		// Ignore errors
	}

	return entries;
}

/**
 * Collect resource files from a directory based on resource type.
 * Extensions use smart discovery (index.ts in subdirs), others use recursive collection.
 */
function collectResourceFiles(dir: string, resourceType: ResourceType): string[] {
	if (resourceType === "skills") {
		return collectSkillEntries(dir, "pi");
	}
	if (resourceType === "extensions") {
		return collectAutoExtensionEntries(dir).map((entry) => entry.path);
	}
	return collectFiles(dir, FILE_PATTERNS[resourceType]);
}

function _collectGlobMatches(root: string, pattern: string): string[] {
	const matches: string[] = [];
	if (!existsSync(root)) return matches;
	const normalizedPattern = normalizeExactPattern(pattern);

	const visit = (dir: string) => {
		let entries: Dirent<string>[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}

		for (const entry of entries) {
			if (entry.name.startsWith(".")) continue;
			if (entry.name === "node_modules") continue;

			const fullPath = join(dir, entry.name);
			let isDirectory = entry.isDirectory();
			let isFile = entry.isFile();

			if (entry.isSymbolicLink()) {
				try {
					const stats = statSync(fullPath);
					isDirectory = stats.isDirectory();
					isFile = stats.isFile();
				} catch {
					continue;
				}
			}

			if (!isDirectory && !isFile) continue;

			const relPath = toPosixPath(relative(root, fullPath));
			if (minimatch(relPath, normalizedPattern)) {
				matches.push(resolve(fullPath));
			}

			if (isDirectory) {
				visit(fullPath);
			}
		}
	};

	visit(root);
	return matches;
}

function matchesAnyPattern(filePath: string, patterns: string[], baseDir: string): boolean {
	const rel = toPosixPath(relative(baseDir, filePath));
	const name = basename(filePath);
	const filePathPosix = toPosixPath(filePath);
	const isSkillFile = name === "SKILL.md";
	const parentDir = isSkillFile ? dirname(filePath) : undefined;
	const parentRel = isSkillFile ? toPosixPath(relative(baseDir, parentDir!)) : undefined;
	const parentName = isSkillFile ? basename(parentDir!) : undefined;
	const parentDirPosix = isSkillFile ? toPosixPath(parentDir!) : undefined;

	return patterns.some((pattern) => {
		const normalizedPattern = toPosixPath(pattern);
		if (
			minimatch(rel, normalizedPattern) ||
			minimatch(name, normalizedPattern) ||
			minimatch(filePathPosix, normalizedPattern)
		) {
			return true;
		}
		if (!isSkillFile) return false;
		return (
			minimatch(parentRel!, normalizedPattern) ||
			minimatch(parentName!, normalizedPattern) ||
			minimatch(parentDirPosix!, normalizedPattern)
		);
	});
}

function normalizeExactPattern(pattern: string): string {
	const normalized = pattern.startsWith("./") || pattern.startsWith(".\\") ? pattern.slice(2) : pattern;
	return toPosixPath(normalized);
}

function matchesAnyExactPattern(filePath: string, patterns: string[], baseDir: string): boolean {
	if (patterns.length === 0) return false;
	const rel = toPosixPath(relative(baseDir, filePath));
	const name = basename(filePath);
	const filePathPosix = toPosixPath(filePath);
	const isSkillFile = name === "SKILL.md";
	const parentDir = isSkillFile ? dirname(filePath) : undefined;
	const parentRel = isSkillFile ? toPosixPath(relative(baseDir, parentDir!)) : undefined;
	const parentDirPosix = isSkillFile ? toPosixPath(parentDir!) : undefined;

	return patterns.some((pattern) => {
		const normalized = normalizeExactPattern(pattern);
		if (normalized === rel || normalized === filePathPosix) {
			return true;
		}
		if (!isSkillFile) return false;
		return normalized === parentRel || normalized === parentDirPosix;
	});
}

function getOverridePatterns(entries: string[]): string[] {
	return entries.filter((pattern) => pattern.startsWith("!") || pattern.startsWith("+") || pattern.startsWith("-"));
}

function isEnabledByOverrides(filePath: string, patterns: string[], baseDir: string): boolean {
	const overrides = getOverridePatterns(patterns);
	const excludes = overrides.filter((pattern) => pattern.startsWith("!")).map((pattern) => pattern.slice(1));
	const forceIncludes = overrides.filter((pattern) => pattern.startsWith("+")).map((pattern) => pattern.slice(1));
	const forceExcludes = overrides.filter((pattern) => pattern.startsWith("-")).map((pattern) => pattern.slice(1));

	let enabled = true;
	if (excludes.length > 0 && matchesAnyPattern(filePath, excludes, baseDir)) {
		enabled = false;
	}
	if (forceIncludes.length > 0 && matchesAnyExactPattern(filePath, forceIncludes, baseDir)) {
		enabled = true;
	}
	if (forceExcludes.length > 0 && matchesAnyExactPattern(filePath, forceExcludes, baseDir)) {
		enabled = false;
	}
	return enabled;
}
/**
 * Read-only resource authority used by the embedded Mortise runtime.
 *
 * Installation and update are host workflows. The Agent runtime resolves only
 * local, already-declared resources and fails closed when obsolete package
 * sources are present.
 */
export class ResourceResolver {
	private readonly cwd: string;
	private readonly agentDir: string;
	private readonly projectConfigDir: string;
	private readonly settingsManager: SettingsManager;

	constructor(options: ResourceResolverOptions) {
		this.cwd = resolvePath(options.cwd);
		this.agentDir = resolvePath(options.agentDir);
		this.projectConfigDir = options.projectConfigDir ?? getProjectConfigDir();
		this.settingsManager = options.settingsManager;
	}

	async resolve(): Promise<ResolvedPaths> {
		return this.toResolvedPaths(this.collectConfiguredResources());
	}

	/** Collect configured and discovered resources without resolving extension dependencies. */
	async resolveRaw(): Promise<ResolvedPaths> {
		return this.toResolvedPaths(this.collectConfiguredResources(), false);
	}

	private collectConfiguredResources(): ResourceAccumulator {
		const globalSettings = this.settingsManager.getGlobalSettings();
		const projectSettings = this.settingsManager.getProjectSettings();
		const accumulator = this.createAccumulator();
		const projectBase = join(this.cwd, this.projectConfigDir);
		this.addConfiguredResources(accumulator, projectSettings, projectBase, {
			source: "local",
			scope: "project",
			origin: "top-level",
			baseDir: projectBase,
		});
		this.addConfiguredResources(accumulator, globalSettings, this.agentDir, {
			source: "local",
			scope: "user",
			origin: "top-level",
			baseDir: this.agentDir,
		});
		this.addAutoDiscoveredResources(accumulator, projectBase, this.agentDir, projectSettings, globalSettings);
		return accumulator;
	}

	async resolveExtensionSources(
		sources: ResourcePathEntry[],
		options: { resolveGraph?: boolean } = {},
	): Promise<ResolvedPaths> {
		const accumulator = this.createAccumulator();
		for (const source of sources) {
			if (typeof source === "string") {
				const resolvedPath = resolvePath(source, this.cwd, { homeDir: getHomeDir(), trim: true });
				if (!existsSync(resolvedPath) || !statSync(resolvedPath).isDirectory()) {
					throw new Error("Runtime extension sources must be strict manifest directories or object declarations");
				}
				this.addDiscoveredExtensions(accumulator.extensions, resolvedPath, {
					source: "runtime",
					scope: "temporary",
					origin: "top-level",
					baseDir: resolvedPath,
				});
				continue;
			}
			assertValidExtensionEntry(source, "runtime extension source");
			this.addExtensionEntry(accumulator.extensions, source, this.cwd, {
				source: "runtime",
				scope: "temporary",
				origin: "top-level",
				baseDir: this.cwd,
			});
		}
		return this.toResolvedPaths(accumulator, options.resolveGraph !== false);
	}

	private createAccumulator(): ResourceAccumulator {
		return { extensions: new Map(), skills: new Map(), prompts: new Map() };
	}

	private addConfiguredResources(
		accumulator: ResourceAccumulator,
		settings: ReturnType<SettingsManager["getGlobalSettings"]>,
		baseDir: string,
		metadata: PathMetadata,
	): void {
		for (const extension of getSettingsResourceEntries(settings, "extensions")) {
			assertValidExtensionEntry(extension, `${baseDir}/settings.json`);
			this.addExtensionEntry(accumulator.extensions, extension, baseDir, metadata);
		}
		for (const resourceType of ["skills", "prompts"] as const) {
			for (const entry of getSettingsStringEntries(settings, resourceType)) {
				this.addResourcePath(accumulator[resourceType], entry, baseDir, metadata, resourceType);
			}
		}
	}

	private addExtensionEntry(
		target: ResourceAccumulator["extensions"],
		entry: ExtensionManifestEntry,
		baseDir: string,
		metadata: PathMetadata,
	): void {
		const resolvedPath = resolvePath(entry.path, baseDir, { homeDir: getHomeDir(), trim: true });
		if (!existsSync(resolvedPath)) return;
		const inspectedUI =
			entry.ui === undefined
				? { ui: undefined, diagnostics: [] }
				: inspectExtensionUI(
						entry.ui,
						statSync(resolvedPath).isDirectory() ? resolvedPath : dirname(resolvedPath),
						`${baseDir}/settings.json`,
					);
		const directMetadata = withExtensionMetadata(
			metadata,
			entry.activation,
			entry.id,
			inspectedUI.ui,
			entry.manifest,
			inspectedUI.diagnostics,
		);
		if (!statSync(resolvedPath).isDirectory()) {
			this.addResource(target, resolvedPath, directMetadata);
			return;
		}

		for (const discovered of collectAutoExtensionEntries(resolvedPath)) {
			this.addResource(
				target,
				discovered.path,
				withExtensionMetadata(
					metadata,
					entry.activation ?? discovered.activation,
					discovered.id,
					discovered.ui,
					discovered.manifest,
					discovered.frontendDiagnostics,
				),
			);
		}
	}

	private addResourcePath(
		target: ResourceAccumulator["skills"] | ResourceAccumulator["prompts"],
		entry: string,
		baseDir: string,
		metadata: PathMetadata,
		resourceType: "skills" | "prompts",
	): void {
		const resolvedPath = resolvePath(entry, baseDir, { homeDir: getHomeDir(), trim: true });
		if (!existsSync(resolvedPath)) return;
		const paths = statSync(resolvedPath).isDirectory()
			? collectResourceFiles(resolvedPath, resourceType)
			: [resolvedPath];
		for (const path of paths) this.addResource(target, path, metadata);
	}

	private addAutoDiscoveredResources(
		accumulator: ResourceAccumulator,
		projectBase: string,
		agentBase: string,
		projectSettings: ReturnType<SettingsManager["getProjectSettings"]>,
		globalSettings: ReturnType<SettingsManager["getGlobalSettings"]>,
	): void {
		const projectMetadata: PathMetadata = {
			source: "auto",
			scope: "project",
			origin: "top-level",
			baseDir: projectBase,
		};
		const userMetadata: PathMetadata = {
			source: "auto",
			scope: "user",
			origin: "top-level",
			baseDir: agentBase,
		};
		this.addDiscoveredExtensions(accumulator.extensions, join(projectBase, "extensions"), projectMetadata);
		this.addDiscoveredResources(
			accumulator.skills,
			collectAutoSkillEntries(join(projectBase, "skills"), "pi"),
			projectMetadata,
			(path) => isEnabledByOverrides(path, getSettingsStringEntries(projectSettings, "skills"), projectBase),
		);
		this.addDiscoveredResources(
			accumulator.prompts,
			collectAutoPromptEntries(join(projectBase, "prompts")),
			projectMetadata,
			(path) => isEnabledByOverrides(path, getSettingsStringEntries(projectSettings, "prompts"), projectBase),
		);

		for (const agentsSkillsDir of collectAncestorAgentsSkillDirs(this.cwd)) {
			if (resolve(agentsSkillsDir) === resolve(join(getHomeDir(), ".agents", "skills"))) continue;
			const metadata = { ...projectMetadata, baseDir: dirname(agentsSkillsDir) };
			this.addDiscoveredResources(
				accumulator.skills,
				collectAutoSkillEntries(agentsSkillsDir, "agents"),
				metadata,
				(path) =>
					isEnabledByOverrides(path, getSettingsStringEntries(projectSettings, "skills"), metadata.baseDir!),
			);
		}

		this.addDiscoveredExtensions(accumulator.extensions, join(agentBase, "extensions"), userMetadata);
		this.addDiscoveredResources(
			accumulator.skills,
			collectAutoSkillEntries(join(agentBase, "skills"), "pi"),
			userMetadata,
			(path) => isEnabledByOverrides(path, getSettingsStringEntries(globalSettings, "skills"), agentBase),
		);
		this.addDiscoveredResources(
			accumulator.prompts,
			collectAutoPromptEntries(join(agentBase, "prompts")),
			userMetadata,
			(path) => isEnabledByOverrides(path, getSettingsStringEntries(globalSettings, "prompts"), agentBase),
		);
		const userAgentsSkillsDir = join(getHomeDir(), ".agents", "skills");
		const userAgentsMetadata = { ...userMetadata, baseDir: dirname(userAgentsSkillsDir) };
		this.addDiscoveredResources(
			accumulator.skills,
			collectAutoSkillEntries(userAgentsSkillsDir, "agents"),
			userAgentsMetadata,
			(path) =>
				isEnabledByOverrides(path, getSettingsStringEntries(globalSettings, "skills"), userAgentsMetadata.baseDir),
		);
	}

	private addDiscoveredExtensions(
		target: ResourceAccumulator["extensions"],
		directory: string,
		metadata: PathMetadata,
	): void {
		for (const entry of collectAutoExtensionEntries(directory)) {
			this.addResource(
				target,
				entry.path,
				withExtensionMetadata(
					metadata,
					entry.activation,
					entry.id,
					entry.ui,
					entry.manifest,
					entry.frontendDiagnostics,
				),
			);
		}
	}

	private addDiscoveredResources(
		target: ResourceAccumulator["skills"] | ResourceAccumulator["prompts"],
		paths: string[],
		metadata: PathMetadata,
		isEnabled: (path: string) => boolean = () => true,
	): void {
		for (const path of paths) this.addResource(target, path, metadata, isEnabled(path));
	}

	private addResource(
		target: Map<string, { metadata: PathMetadata; enabled: boolean }>,
		path: string,
		metadata: PathMetadata,
		enabled = true,
	): void {
		const key = canonicalizePath(path);
		if (!target.has(key)) target.set(key, { metadata: { ...metadata }, enabled });
	}

	resolveExtensionManifestGraph(entries: ResolvedResource[]): ResolvedResource[] {
		const originalIndex = new Map(entries.map((entry, index) => [entry, index]));
		const byId = new Map<string, ResolvedResource>();
		const addDiagnostic = (entry: ResolvedResource, diagnostic: ExtensionManifestDiagnostic): void => {
			const diagnostics = entry.metadata.extensionManifestDiagnostics ?? [];
			if (
				!diagnostics.some(
					(item) => item.code === diagnostic.code && item.relatedExtensionId === diagnostic.relatedExtensionId,
				)
			) {
				diagnostics.push(diagnostic);
			}
			entry.metadata.extensionManifestDiagnostics = diagnostics;
		};
		const block = (entry: ResolvedResource, diagnostic: ExtensionManifestDiagnostic): void => {
			addDiagnostic(entry, diagnostic);
			entry.enabled = false;
		};

		for (const entry of entries) {
			entry.metadata.extensionManifestDiagnostics = [];
			const id = entry.metadata.extensionId;
			if (!id) continue;
			const winner = byId.get(id);
			if (winner) {
				block(entry, {
					code: "duplicate-id",
					severity: "error",
					message: `Extension id "${id}" conflicts with ${winner.path}`,
					relatedExtensionId: id,
				});
			} else {
				byId.set(id, entry);
			}
		}

		for (const entry of entries) {
			const id = entry.metadata.extensionId;
			if (id && !entry.metadata.extensionManifest) {
				addDiagnostic(entry, {
					code: "legacy-manifest",
					severity: "warning",
					message: "Extension has no versioned manifest",
				});
			}
		}

		const checkDependency = (
			entry: ResolvedResource,
			dependencyId: string,
			range: string,
			optional: boolean,
		): void => {
			const dependency = byId.get(dependencyId);
			const dependencyVersion = dependency?.metadata.extensionManifest?.version;
			if (
				!dependency?.enabled ||
				!dependencyVersion ||
				!satisfies(dependencyVersion, range, { includePrerelease: true })
			) {
				const diagnostic: ExtensionManifestDiagnostic = {
					code: optional ? "optional-dependency-missing" : "missing-dependency",
					severity: optional ? "warning" : "error",
					message: `${optional ? "Optional" : "Required"} dependency ${dependencyId} ${range} is unavailable`,
					relatedExtensionId: dependencyId,
				};
				optional ? addDiagnostic(entry, diagnostic) : block(entry, diagnostic);
			}
		};
		for (const entry of entries) {
			if (!entry.enabled) continue;
			for (const [id, range] of Object.entries(entry.metadata.extensionManifest?.dependencies ?? {}))
				checkDependency(entry, id, range, false);
			for (const [id, range] of Object.entries(entry.metadata.extensionManifest?.optionalDependencies ?? {}))
				checkDependency(entry, id, range, true);
			for (const [id, range] of Object.entries(entry.metadata.extensionManifest?.conflicts ?? {})) {
				const conflict = byId.get(id);
				const version = conflict?.metadata.extensionManifest?.version;
				if (conflict?.enabled && (!version || satisfies(version, range, { includePrerelease: true }))) {
					block(entry, {
						code: "conflict",
						severity: "error",
						message: `Conflicts with ${id} ${range}`,
						relatedExtensionId: id,
					});
				}
			}
		}

		const visiting = new Set<string>();
		const visited = new Set<string>();
		const cycleIds = new Set<string>();
		const stack: string[] = [];
		const visit = (id: string): void => {
			if (visited.has(id)) return;
			if (visiting.has(id)) {
				for (const cycleId of stack.slice(Math.max(0, stack.lastIndexOf(id)))) cycleIds.add(cycleId);
				return;
			}
			visiting.add(id);
			stack.push(id);
			for (const dependencyId of Object.keys(byId.get(id)?.metadata.extensionManifest?.dependencies ?? {})) {
				if (byId.get(dependencyId)?.enabled) visit(dependencyId);
			}
			stack.pop();
			visiting.delete(id);
			visited.add(id);
		};
		for (const [id, entry] of byId) if (entry.enabled) visit(id);
		for (const id of cycleIds) {
			const entry = byId.get(id);
			if (entry)
				block(entry, {
					code: "dependency-cycle",
					severity: "error",
					message: `Required dependency cycle includes ${Array.from(cycleIds).sort().join(", ")}`,
				});
		}

		const active = entries.filter((entry) => entry.enabled && entry.metadata.extensionId);
		const activeIds = new Set(active.map((entry) => entry.metadata.extensionId!));
		const outgoing = new Map<string, Set<string>>();
		const indegree = new Map(Array.from(activeIds, (id) => [id, 0]));
		const addEdge = (from: string, to: string): void => {
			if (from === to || !activeIds.has(from) || !activeIds.has(to)) return;
			const targets = outgoing.get(from) ?? new Set<string>();
			if (targets.has(to)) return;
			targets.add(to);
			outgoing.set(from, targets);
			indegree.set(to, (indegree.get(to) ?? 0) + 1);
		};
		for (const entry of active) {
			const id = entry.metadata.extensionId!;
			const manifest = entry.metadata.extensionManifest;
			for (const dependency of Object.keys(manifest?.dependencies ?? {})) addEdge(dependency, id);
			for (const after of manifest?.loadOrder?.after ?? []) addEdge(after, id);
			for (const before of manifest?.loadOrder?.before ?? []) addEdge(id, before);
		}
		const compare = (a: ResolvedResource, b: ResolvedResource): number =>
			(b.metadata.extensionManifest?.loadOrder?.priority ?? 0) -
				(a.metadata.extensionManifest?.loadOrder?.priority ?? 0) ||
			(a.metadata.extensionId ?? a.path).localeCompare(b.metadata.extensionId ?? b.path);
		const ready = active.filter((entry) => indegree.get(entry.metadata.extensionId!) === 0).sort(compare);
		const ordered: ResolvedResource[] = [];
		const orderedIds = new Set<string>();
		while (ready.length > 0) {
			const entry = ready.shift()!;
			const id = entry.metadata.extensionId!;
			ordered.push(entry);
			orderedIds.add(id);
			for (const target of outgoing.get(id) ?? []) {
				indegree.set(target, (indegree.get(target) ?? 0) - 1);
				if (indegree.get(target) === 0) {
					const next = byId.get(target);
					if (next) ready.push(next);
					ready.sort(compare);
				}
			}
		}
		for (const entry of active.filter((item) => !orderedIds.has(item.metadata.extensionId!)).sort(compare)) {
			addDiagnostic(entry, {
				code: "load-order-cycle",
				severity: "warning",
				message: "Load-order hints form a cycle; deterministic priority and id ordering is used",
			});
			ordered.push(entry);
		}
		for (const entry of entries) {
			const diagnostics = entry.metadata.extensionManifestDiagnostics ?? [];
			const status: ExtensionManifestStatus = diagnostics.some((item) => item.severity === "error")
				? "blocked"
				: !entry.metadata.extensionManifest
					? "legacy"
					: diagnostics.length > 0
						? "warning"
						: "compatible";
			entry.metadata.extensionManifestStatus = status;
			entry.metadata.extensionLoadable = entry.enabled && status !== "blocked";
		}
		const inactive = entries
			.filter((entry) => !ordered.includes(entry))
			.sort((a, b) => (originalIndex.get(a) ?? 0) - (originalIndex.get(b) ?? 0));
		return [...ordered, ...inactive];
	}

	private toResolvedPaths(accumulator: ResourceAccumulator, resolveGraph = true): ResolvedPaths {
		const convert = (entries: Map<string, { metadata: PathMetadata; enabled: boolean }>): ResolvedResource[] =>
			Array.from(entries.entries()).map(([path, value]) => ({ path, ...value }));
		const extensions = convert(accumulator.extensions).sort(
			(a, b) => resourcePrecedenceRank(a.metadata) - resourcePrecedenceRank(b.metadata),
		);
		return {
			extensions: resolveGraph ? this.resolveExtensionManifestGraph(extensions) : extensions,
			skills: convert(accumulator.skills),
			prompts: convert(accumulator.prompts),
		};
	}
}
