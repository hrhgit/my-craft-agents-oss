import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const aiSrcIndex = fileURLToPath(new URL("../ai/src/index.ts", import.meta.url));
const aiSrcDir = fileURLToPath(new URL("../ai/src", import.meta.url));
const agentSrcIndex = fileURLToPath(new URL("../agent/src/index.ts", import.meta.url));

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000,
		server: {
			deps: {
				external: [/@silvia-odwyer\/photon-node/],
			},
		},
	},
	resolve: {
		alias: [
			{ find: /^@mortise\/pi-ai$/, replacement: aiSrcIndex },
			{ find: /^@mortise\/pi-ai\/(.+)$/, replacement: `${aiSrcDir}/$1.ts` },
			{ find: /^@mortise\/pi-agent-core$/, replacement: agentSrcIndex },
		],
	},
});
