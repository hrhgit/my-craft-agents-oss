import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { complete, type Message, parseJsonWithRepair } from "@mortise/pi-ai";
import type { ExtensionContext } from "@mortise/pi-coding-agent";
import { hashText, writeFileAtomic } from "./state.ts";
import {
	type SessionDigest,
	type SummarizerResult,
	YOURSELF_MODEL_ID,
	YOURSELF_MODEL_PROVIDER,
	YOURSELF_MODEL_REF,
} from "./types.ts";

const SUMMARY_AGENT_PROMPT = `你是 Pi 的私有记忆整理子代理。请总结一段历史 Pi 会话，方便未来的人类查阅。

硬性规则：
- 只返回符合此形状的有效 JSON：{"content":"markdown"}
- content 中的 Markdown 必须使用中文。
- 不要包含 secrets、tokens、API keys、cookies、bearer strings、private keys 或 passwords。
- 不要长篇引用工具输出，只总结效果和证据。
- 不要提及 assistant hidden thinking。
- 重点关注：用户想做什么、模型做了什么、怎么实现、文件/命令/验证、后续事项。
- 如有价值，可补充问题与解决：用户指出或模型实现时发现的问题，以及最终如何处理。
- 保持简洁，但要具体。`;

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	if (currentScript && !currentScript.startsWith("/$bunfs/root/") && currentScript.endsWith(".js")) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	return { command: "pi", args };
}

function extractText(content: Message["content"]): string {
	if (typeof content === "string") return content;
	return content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function buildPrompt(digest: SessionDigest): string {
	return [
		SUMMARY_AGENT_PROMPT,
		"",
		"Session metadata:",
		`- sessionId: ${digest.sessionId}`,
		`- sessionPath: ${digest.sessionPath}`,
		`- cwd: ${digest.cwd || "(unknown)"}`,
		`- date: ${digest.date}`,
		`- modified: ${digest.modified}`,
		`- digestHash: ${digest.hash}`,
		"",
		"Historical session transcript:",
		"<session>",
		digest.text,
		"</session>",
	].join("\n");
}

function parseSummaryJson(raw: string): string | undefined {
	const trimmed = raw
		.trim()
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/\s*```$/, "")
		.trim();
	try {
		const parsed = parseJsonWithRepair<{ content?: unknown }>(trimmed);
		return typeof parsed.content === "string" ? parsed.content.trim() : undefined;
	} catch {
		const start = trimmed.indexOf("{");
		const end = trimmed.lastIndexOf("}");
		if (start >= 0 && end > start) {
			const parsed = parseJsonWithRepair<{ content?: unknown }>(trimmed.slice(start, end + 1));
			return typeof parsed.content === "string" ? parsed.content.trim() : undefined;
		}
		return undefined;
	}
}

async function summarizeViaSubagentProcess(digest: SessionDigest, signal?: AbortSignal): Promise<SummarizerResult> {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-yourself-subagent-"));
	const promptPath = path.join(tempDir, "prompt.md");
	try {
		await writeFileAtomic(promptPath, buildPrompt(digest));
		const args = [
			"--mode",
			"json",
			"-p",
			"--no-session",
			"--no-tools",
			"--no-context-files",
			"--no-skills",
			"--no-prompt-templates",
			"--model",
			YOURSELF_MODEL_REF,
			`@${promptPath}`,
		];
		const invocation = getPiInvocation(args);
		let stdout = "";
		let stderr = "";
		let finalAssistantText = "";
		let settled = false;

		const exitCode = await new Promise<number>((resolve) => {
			const child = spawn(invocation.command, invocation.args, {
				cwd: digest.cwd || process.cwd(),
				env: { ...process.env, PI_SUBAGENT_CHILD: "1" },
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});

			const finish = (code: number) => {
				if (settled) return;
				settled = true;
				resolve(code);
			};

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: { type?: string; message?: Message };
				try {
					event = JSON.parse(line) as { type?: string; message?: Message };
				} catch {
					return;
				}
				if (event.type === "message_end" && event.message?.role === "assistant") {
					const text = extractText(event.message.content);
					if (text.trim()) finalAssistantText = text;
				}
			};

			child.stdout.on("data", (chunk) => {
				stdout += chunk.toString();
				const lines = stdout.split("\n");
				stdout = lines.pop() ?? "";
				for (const line of lines) processLine(line);
			});
			child.stderr.on("data", (chunk) => {
				stderr += chunk.toString();
			});
			child.on("close", (code) => {
				if (stdout.trim()) processLine(stdout);
				finish(code ?? 0);
			});
			child.on("error", () => finish(1));

			const abortChild = () => {
				child.kill("SIGTERM");
				setTimeout(() => {
					if (!child.killed) child.kill("SIGKILL");
				}, 3000).unref?.();
			};
			if (signal?.aborted) {
				abortChild();
			} else {
				signal?.addEventListener("abort", abortChild, { once: true });
				child.on("close", () => signal?.removeEventListener("abort", abortChild));
			}
		});

		if (signal?.aborted) {
			throw new Error("Summarization aborted");
		}
		if (exitCode !== 0) {
			throw new Error(stderr.trim() || `Subagent-style Pi process exited with code ${exitCode}`);
		}
		const content = parseSummaryJson(finalAssistantText) ?? finalAssistantText.trim();
		if (!content) throw new Error("Subagent-style Pi process returned no summary text");
		return { content, model: YOURSELF_MODEL_REF, via: "pi-subagents-json" };
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
}

async function summarizeDirect(
	ctx: ExtensionContext,
	digest: SessionDigest,
	signal?: AbortSignal,
): Promise<SummarizerResult> {
	const model = ctx.modelRegistry.find(YOURSELF_MODEL_PROVIDER, YOURSELF_MODEL_ID);
	if (!model) {
		throw new Error(`Model not found: ${YOURSELF_MODEL_REF}`);
	}
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) {
		throw new Error(auth.error);
	}
	if (!auth.apiKey && !auth.headers) {
		throw new Error(`No API key or request headers for ${YOURSELF_MODEL_REF}`);
	}

	const userMessage: Message = {
		role: "user",
		content: [{ type: "text", text: buildPrompt(digest) }],
		timestamp: Date.now(),
	};
	const response = await complete(
		model,
		{ systemPrompt: SUMMARY_AGENT_PROMPT, messages: [userMessage] },
		{ apiKey: auth.apiKey, headers: auth.headers, maxTokens: 4096, signal },
	);
	if (response.stopReason === "error" || response.stopReason === "aborted") {
		throw new Error(response.errorMessage || `Summary request ${response.stopReason}`);
	}
	const raw = extractText(response.content);
	const content = parseSummaryJson(raw) ?? raw.trim();
	if (!content) throw new Error("Direct MiMo summary was empty");
	return { content, model: YOURSELF_MODEL_REF, via: "direct-mimo" };
}

export function isMimoAvailable(ctx: ExtensionContext): boolean {
	return Boolean(ctx.modelRegistry.find(YOURSELF_MODEL_PROVIDER, YOURSELF_MODEL_ID));
}

export async function summarizeDigest(
	ctx: ExtensionContext,
	digest: SessionDigest,
	signal?: AbortSignal,
): Promise<SummarizerResult> {
	try {
		return await summarizeViaSubagentProcess(digest, signal);
	} catch (error) {
		const fallback = await summarizeDirect(ctx, digest, signal);
		return {
			...fallback,
			content: `${fallback.content.trim()}\n\n<!-- subagent-fallback:${hashText(error instanceof Error ? error.message : String(error)).slice(0, 12)} -->`,
		};
	}
}
