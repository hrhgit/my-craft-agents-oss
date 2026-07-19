import type { ExtensionTarget } from "./extensions/types.ts";

const CANONICAL_EXTENSION_TARGETS: ExtensionTarget[] = ["pi", "mortise"];

export function parseExtensionTargets(value: unknown): ExtensionTarget[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const targets: ExtensionTarget[] = [];
	for (const rawTarget of value) {
		if (
			typeof rawTarget !== "string" ||
			!CANONICAL_EXTENSION_TARGETS.includes(rawTarget as ExtensionTarget) ||
			targets.includes(rawTarget as ExtensionTarget)
		) {
			return undefined;
		}
		targets.push(rawTarget as ExtensionTarget);
	}
	return targets;
}
