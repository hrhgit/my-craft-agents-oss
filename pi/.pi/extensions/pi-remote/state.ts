import type { Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RemoteModel, RemoteState } from "./protocol.ts";

export interface RemoteSettings {
	webSearch: boolean;
	planMode: boolean;
}

export function toRemoteModel(model: Model<any>): RemoteModel {
	return {
		provider: model.provider,
		id: model.id,
		name: model.name,
		reasoning: model.reasoning,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
	};
}

export function createRemoteState(ctx: ExtensionContext, settings: RemoteSettings, thinkingLevel: ThinkingLevel): RemoteState {
	return {
		sessionId: ctx.sessionManager.getSessionId(),
		sessionFile: ctx.sessionManager.getSessionFile(),
		sessionName: ctx.sessionManager.getSessionName(),
		cwd: ctx.cwd,
		model: ctx.model ? toRemoteModel(ctx.model) : undefined,
		thinkingLevel,
		webSearch: settings.webSearch,
		planMode: settings.planMode,
		isStreaming: !ctx.isIdle(),
	};
}
