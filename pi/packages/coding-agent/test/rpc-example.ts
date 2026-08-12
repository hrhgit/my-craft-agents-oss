import { dirname, join } from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Interactive example of using coding-agent via RpcClient.
 * Usage: npx tsx test/rpc-example.ts
 */

async function main() {
	const client = new RpcClient({
		runtimePath: join(__dirname, "../dist/bun/headless.js"),
		provider: "anthropic",
		model: "claude-sonnet-4-20250514",
	});

	// Stream events to console
	client.onEvent((event) => {
		if (event.type === "message_update") {
			const { assistantMessageEvent } = event;
			if (assistantMessageEvent.type === "text_delta" || assistantMessageEvent.type === "thinking_delta") {
				process.stdout.write(assistantMessageEvent.delta);
			}
		}

		if (event.type === "tool_execution_start") {
			console.log(`\n[Tool: ${event.toolName}]`);
		}

		if (event.type === "tool_execution_end") {
			console.log(`[Result: ${JSON.stringify(event.result).slice(0, 200)}...]\n`);
		}
	});

	await client.start();

	const state = await client.getState();
	console.log(`Model: ${state.model?.provider}/${state.model?.id}`);
	console.log(`Thinking: ${state.thinkingLevel ?? "off"}\n`);

	// Handle user input
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
		terminal: true,
	});

	let isWaiting = false;

	const prompt = () => {
		if (!isWaiting) process.stdout.write("You: ");
	};

	let activeExecutionId: string | undefined;
	rl.on("line", async (line) => {
		if (isWaiting) return;
		if (line.trim() === "exit") {
			await client.stop();
			process.exit(0);
		}

		isWaiting = true;
		activeExecutionId = crypto.randomUUID();
		await client.promptAndWait(activeExecutionId, line);
		activeExecutionId = undefined;
		console.log("\n");
		isWaiting = false;
		prompt();
	});

	rl.on("SIGINT", () => {
		if (isWaiting) {
			console.log("\n[Aborting...]");
			if (activeExecutionId) client.abort(activeExecutionId);
		} else {
			client.stop();
			process.exit(0);
		}
	});

	console.log("Interactive RPC example. Type 'exit' to quit.\n");
	prompt();
}

main().catch(console.error);
