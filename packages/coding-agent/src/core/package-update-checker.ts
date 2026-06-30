import { getAgentDir } from "../config.ts";
import { DefaultPackageManager } from "./package-manager.ts";
import type { SettingsManager } from "./settings-manager.ts";

export async function checkForPackageUpdateNames(options: {
	cwd: string;
	settingsManager: SettingsManager;
}): Promise<string[]> {
	if (process.env.PI_OFFLINE) {
		return [];
	}

	try {
		const packageManager = new DefaultPackageManager({
			cwd: options.cwd,
			agentDir: getAgentDir(),
			settingsManager: options.settingsManager,
		});
		const updates = await packageManager.checkForAvailableUpdates();
		return updates.map((update) => update.displayName);
	} catch {
		return [];
	}
}
