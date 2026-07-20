import type { Model } from '@mortise/pi-ai';
import { getAgentDir } from '../config.ts';
import { SettingsManager, type HostModelDefaultSlot, type ModelDefaultThinkingLevel } from './settings-manager.ts';
import type { ModelRegistry } from './model-registry.ts';

export const CURRENT_SESSION_MODEL_REFERENCE = 'current-session' as const;
export type ModelReference =
	| typeof CURRENT_SESSION_MODEL_REFERENCE
	| `default:${number}`
	| `model:${string}/${string}`;

export type ResolvedModelReference = {
	provider: string;
	model: string;
	thinkingLevel?: ModelDefaultThinkingLevel;
	source: 'current-session' | 'default' | 'explicit';
};

export function resolveModelReference(
	reference: string | undefined,
	options: { currentModel?: Model<any>; currentThinkingLevel?: ModelDefaultThinkingLevel; modelRegistry?: ModelRegistry; cwd?: string; agentDir?: string } = {},
): ResolvedModelReference | undefined {
	if (!reference || reference === CURRENT_SESSION_MODEL_REFERENCE) {
		return options.currentModel
			? {
				source: 'current-session',
				provider: options.currentModel.provider,
				model: options.currentModel.id,
				...(options.currentThinkingLevel ? { thinkingLevel: options.currentThinkingLevel } : {}),
			}
			: undefined;
	}

	const defaultMatch = /^default:([1-9]\d*)$/.exec(reference);
	if (defaultMatch) {
		const slot = Number(defaultMatch[1]) as HostModelDefaultSlot;
		const configured = SettingsManager.create(options.cwd ?? process.cwd(), options.agentDir ?? getAgentDir())
			.getModelDefaultSlot(slot);
		if (!configured || (options.modelRegistry && !options.modelRegistry.find(configured.provider, configured.model))) return undefined;
		return { source: 'default', ...configured };
	}

	if (reference.startsWith('model:')) {
		const canonical = reference.slice('model:'.length);
		const separator = canonical.indexOf('/');
		if (separator > 0 && separator < canonical.length - 1) {
			const provider = canonical.slice(0, separator);
			const model = canonical.slice(separator + 1);
			if (options.modelRegistry && !options.modelRegistry.find(provider, model)) return undefined;
			return {
				source: 'explicit',
				provider,
				model,
			};
		}
	}

	return undefined;
}
