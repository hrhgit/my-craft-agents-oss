import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { truncateToWidth } from "@earendil-works/pi-tui";
import chalk from "chalk";
import { KeybindingsManager } from "../core/keybindings.ts";
import { stripAnsi } from "../utils/ansi.ts";
import { RpcClient, type RpcClientEvent } from "./rpc/rpc-client.ts";
import type { RpcExtensionUIRequest, RpcSessionState } from "./rpc/rpc-types.ts";

type PaneStatus = "starting" | "idle" | "running" | "closed" | "error";

interface MuxPane {
	id: number;
	title: string;
	cwd: string;
	client: RpcClient;
	status: PaneStatus;
	lines: string[];
	statusLines: Map<string, string>;
	state?: RpcSessionState;
	error?: string;
}

interface MuxOptions {
	childArgs: string[];
}

interface SelfInvocation {
	command: string;
	commandArgs: string[];
	cliPath: string;
}

const MAX_BUFFER_LINES = 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatUnknown(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function shortPath(value: string): string {
	const home = os.homedir();
	const normalizedHome = path.resolve(home);
	const normalizedValue = path.resolve(value);
	if (process.platform === "win32") {
		if (normalizedValue.toLowerCase().startsWith(`${normalizedHome.toLowerCase()}${path.sep}`)) {
			return `~${normalizedValue.slice(normalizedHome.length)}`;
		}
	} else if (normalizedValue.startsWith(`${normalizedHome}${path.sep}`)) {
		return `~${normalizedValue.slice(normalizedHome.length)}`;
	}
	return value;
}

function paneTitle(cwd: string): string {
	const base = path.basename(path.resolve(cwd));
	return base || shortPath(cwd);
}

function normalizeSessionPath(value: string): string {
	const resolved = path.resolve(value);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function removeSessionTargetingArgs(args: string[]): string[] {
	const result: string[] = [];
	const valueFlags = new Set(["--session", "--session-id", "--fork", "--name", "-n"]);
	const booleanFlags = new Set(["--continue", "-c", "--resume", "-r", "--no-session"]);

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (booleanFlags.has(arg)) {
			continue;
		}
		if (valueFlags.has(arg)) {
			i++;
			continue;
		}
		const eqIndex = arg.indexOf("=");
		if (eqIndex !== -1 && valueFlags.has(arg.slice(0, eqIndex))) {
			continue;
		}
		result.push(arg);
	}

	return result;
}

function removeMuxManagedArgs(args: string[]): string[] {
	const result: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--mode") {
			i++;
			continue;
		}
		if (arg.startsWith("--mode=")) {
			continue;
		}
		result.push(arg);
	}
	return result;
}

function findNearestTsxCli(startPath: string): string | undefined {
	let current = path.resolve(startPath);
	if (!fs.existsSync(current)) return undefined;
	if (!fs.statSync(current).isDirectory()) {
		current = path.dirname(current);
	}

	while (true) {
		const candidate = path.join(current, "node_modules", "tsx", "dist", "cli.mjs");
		if (fs.existsSync(candidate)) return candidate;
		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

function filterInheritedExecArgv(args: string[]): string[] {
	return args.filter(
		(arg) => arg !== "--inspect" && !arg.startsWith("--inspect=") && !arg.startsWith("--inspect-brk"),
	);
}

function resolveSelfInvocation(): SelfInvocation | undefined {
	const cliPath = process.argv[1];
	if (!cliPath) return undefined;
	if (cliPath.endsWith(".ts")) {
		const tsxCli = findNearestTsxCli(cliPath);
		if (tsxCli) {
			return { command: process.execPath, commandArgs: [tsxCli], cliPath };
		}
	}
	return { command: process.execPath, commandArgs: filterInheritedExecArgv(process.execArgv), cliPath };
}

function displayText(text: string): string {
	return text.replace(/\r/g, "").replace(/\t/g, "    ");
}

function printableFromData(data: string): string | undefined {
	let output = "";
	for (const char of data) {
		const code = char.codePointAt(0) ?? 0;
		if (code >= 0x20 && code !== 0x7f && char !== "\u001b") {
			output += char;
		}
	}
	return output.length > 0 ? output : undefined;
}

function renderHelp(): string {
	return [
		"pi mux - run multiple independent Pi RPC workers in one terminal",
		"",
		"Usage:",
		"  pi mux [child-options]",
		"",
		"Keys:",
		"  Ctrl+O       switch pane",
		"  Ctrl+N       start a new pane in the current workspace",
		"  Ctrl+Shift+W close the active pane",
		"  Escape       clear input; abort active pane when input is empty",
		"  Ctrl+D       quit when input is empty",
		"",
		"Mux commands:",
		"  /mux help              show this help",
		"  /mux new [path]        start a new independent session in a workspace",
		"  /mux switch <number>   switch to pane number",
		"  /mux close [number]    close a pane",
		"  /mux abort [number]    abort a running pane",
		"  /mux status            show pane status",
		"  /mux quit              quit mux",
	].join("\n");
}

class MuxMode {
	private options: MuxOptions;
	private keybindings = KeybindingsManager.create();
	private panes: MuxPane[] = [];
	private activeIndex = 0;
	private nextPaneId = 1;
	private input = "";
	private pickerVisible = false;
	private pickerIndex = 0;
	private renderTimer: ReturnType<typeof setTimeout> | undefined;
	private isShuttingDown = false;
	private resolveRun: (() => void) | undefined;
	private signalHandlers: Array<{ signal: NodeJS.Signals; handler: () => void }> = [];

	constructor(options: MuxOptions) {
		this.options = options;
	}

	async run(): Promise<void> {
		if (!process.stdin.isTTY || !process.stdout.isTTY) {
			throw new Error("pi mux requires an interactive terminal");
		}

		this.installTerminal();
		await this.createPane(process.cwd(), this.options.childArgs, { focus: true, initial: true });
		this.render();

		return new Promise<void>((resolve) => {
			this.resolveRun = resolve;
		});
	}

	private installTerminal(): void {
		process.stdin.setRawMode(true);
		process.stdin.resume();
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", this.handleInput);
		process.stdout.write("\u001b[?1049h\u001b[?25l");
		process.stdout.on("resize", this.handleResize);

		const installSignal = (signal: NodeJS.Signals): void => {
			const handler = () => {
				void this.shutdown();
			};
			process.on(signal, handler);
			this.signalHandlers.push({ signal, handler });
		};
		installSignal("SIGTERM");
		if (process.platform !== "win32") {
			installSignal("SIGHUP");
		}
	}

	private restoreTerminal(): void {
		process.stdin.off("data", this.handleInput);
		process.stdout.off("resize", this.handleResize);
		for (const { signal, handler } of this.signalHandlers) {
			process.off(signal, handler);
		}
		this.signalHandlers = [];
		if (process.stdin.isTTY) {
			process.stdin.setRawMode(false);
		}
		process.stdout.write("\u001b[?25h\u001b[?1049l");
	}

	private handleResize = (): void => {
		this.scheduleRender();
	};

	private handleInput = (data: string): void => {
		if (this.isShuttingDown) return;
		void this.handleInputAsync(data);
	};

	private async handleInputAsync(data: string): Promise<void> {
		if (this.pickerVisible) {
			await this.handlePickerInput(data);
			return;
		}

		if (this.keybindings.matches(data, "app.mux.switcher")) {
			this.openPicker();
			return;
		}
		if (this.keybindings.matches(data, "app.mux.new")) {
			await this.createPane(
				this.activePaneOrUndefined()?.cwd ?? process.cwd(),
				removeSessionTargetingArgs(this.options.childArgs),
				{
					focus: true,
				},
			);
			return;
		}
		if (this.keybindings.matches(data, "app.mux.close")) {
			await this.closePane(this.activeIndex);
			return;
		}
		if (this.keybindings.matches(data, "app.exit")) {
			if (this.input.length === 0) {
				await this.shutdown();
			}
			return;
		}
		if (this.keybindings.matches(data, "app.interrupt") || this.keybindings.matches(data, "app.clear")) {
			if (this.input.length > 0) {
				this.input = "";
				this.scheduleRender();
				return;
			}
			await this.abortPane(this.activeIndex);
			return;
		}
		if (this.keybindings.matches(data, "tui.input.submit")) {
			await this.submitInput();
			return;
		}
		if (this.keybindings.matches(data, "tui.input.newLine")) {
			this.input += "\n";
			this.scheduleRender();
			return;
		}
		if (this.keybindings.matches(data, "tui.editor.deleteCharBackward")) {
			this.input = Array.from(this.input).slice(0, -1).join("");
			this.scheduleRender();
			return;
		}

		const printable = printableFromData(data);
		if (printable !== undefined) {
			this.input += printable;
			this.scheduleRender();
		}
	}

	private async handlePickerInput(data: string): Promise<void> {
		if (this.keybindings.matches(data, "tui.select.cancel") || this.keybindings.matches(data, "app.mux.switcher")) {
			this.pickerVisible = false;
			this.scheduleRender();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.up")) {
			this.pickerIndex = Math.max(0, this.pickerIndex - 1);
			this.scheduleRender();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.down")) {
			this.pickerIndex = Math.min(this.panes.length - 1, this.pickerIndex + 1);
			this.scheduleRender();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.confirm")) {
			this.switchPane(this.pickerIndex);
			return;
		}
		if (data.length === 1 && data >= "1" && data <= "9") {
			const index = Number(data) - 1;
			if (index >= 0 && index < this.panes.length) {
				this.switchPane(index);
			}
		}
	}

	private openPicker(): void {
		this.pickerVisible = true;
		this.pickerIndex = this.activeIndex;
		this.scheduleRender();
	}

	private switchPane(index: number): void {
		if (index < 0 || index >= this.panes.length) return;
		this.activeIndex = index;
		this.pickerVisible = false;
		this.scheduleRender();
	}

	private async submitInput(): Promise<void> {
		const raw = this.input;
		const text = raw.trimEnd();
		this.input = "";
		this.scheduleRender();
		if (text.trim().length === 0) return;

		if (text === "/switch" || text.startsWith("/switch ")) {
			this.appendSystemLine(this.activePane(), "Use /mux new <path> to open another workspace in mux mode.");
			return;
		}
		if (text === "/resume" || text.startsWith("/resume ")) {
			this.appendSystemLine(
				this.activePane(),
				"Use a separate mux pane per live session; /resume is not available in mux.",
			);
			return;
		}
		if (text === "/mux" || text.startsWith("/mux ")) {
			await this.handleMuxCommand(text);
			return;
		}

		await this.promptActivePane(text);
	}

	private async handleMuxCommand(text: string): Promise<void> {
		const trimmed = text.trim();
		const rest = trimmed === "/mux" ? "" : trimmed.slice("/mux ".length).trim();
		const [command = "help", ...parts] = rest.split(/\s+/);
		const argText = rest.slice(command.length).trim();

		switch (command) {
			case "help":
				for (const line of renderHelp().split("\n")) {
					this.appendSystemLine(this.activePane(), line);
				}
				break;
			case "new":
				await this.createPane(this.resolvePaneCwd(argText), removeSessionTargetingArgs(this.options.childArgs), {
					focus: true,
				});
				break;
			case "switch": {
				const index = Number(parts[0]) - 1;
				if (!Number.isInteger(index) || index < 0 || index >= this.panes.length) {
					this.appendSystemLine(this.activePane(), "Usage: /mux switch <number>");
					break;
				}
				this.switchPane(index);
				break;
			}
			case "close": {
				const index = parts[0] ? Number(parts[0]) - 1 : this.activeIndex;
				if (!Number.isInteger(index) || index < 0 || index >= this.panes.length) {
					this.appendSystemLine(this.activePane(), "Usage: /mux close [number]");
					break;
				}
				await this.closePane(index);
				break;
			}
			case "abort": {
				const index = parts[0] ? Number(parts[0]) - 1 : this.activeIndex;
				if (!Number.isInteger(index) || index < 0 || index >= this.panes.length) {
					this.appendSystemLine(this.activePane(), "Usage: /mux abort [number]");
					break;
				}
				await this.abortPane(index);
				break;
			}
			case "status":
				for (const line of this.renderPaneStatusLines()) {
					this.appendSystemLine(this.activePane(), line);
				}
				break;
			case "quit":
				await this.shutdown();
				break;
			default:
				this.appendSystemLine(this.activePane(), `Unknown mux command: ${command}`);
				this.appendSystemLine(this.activePane(), "Use /mux help for commands.");
				break;
		}
	}

	private resolvePaneCwd(input: string): string {
		if (!input) return this.activePaneOrUndefined()?.cwd ?? process.cwd();
		const unquoted = input.replace(/^["']|["']$/g, "");
		if (unquoted === "~") return os.homedir();
		if (unquoted.startsWith("~/") || unquoted.startsWith("~\\")) {
			return path.resolve(os.homedir(), unquoted.slice(2));
		}
		return path.resolve(this.activePane().cwd, unquoted);
	}

	private async promptActivePane(text: string): Promise<void> {
		const pane = this.activePane();
		this.appendLine(pane, chalk.green(`you: ${displayText(text)}`));
		try {
			if (pane.status === "running" || pane.state?.isStreaming) {
				await pane.client.followUp(text);
				this.appendSystemLine(pane, "queued as follow-up");
			} else {
				await pane.client.prompt(text);
			}
		} catch (error: unknown) {
			this.appendSystemLine(pane, `prompt failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async createPane(
		cwd: string,
		childArgs: string[],
		options?: { focus?: boolean; initial?: boolean },
	): Promise<void> {
		const resolvedCwd = path.resolve(cwd);
		if (!fs.existsSync(resolvedCwd) || !fs.statSync(resolvedCwd).isDirectory()) {
			this.appendSystemLine(this.activePaneOrUndefined(), `workspace does not exist: ${resolvedCwd}`);
			return;
		}
		const invocation = resolveSelfInvocation();
		if (!invocation) {
			this.appendSystemLine(this.activePaneOrUndefined(), "cannot locate current Pi CLI entry point");
			return;
		}

		const pane: MuxPane = {
			id: this.nextPaneId++,
			title: paneTitle(resolvedCwd),
			cwd: resolvedCwd,
			client: new RpcClient({
				command: invocation.command,
				commandArgs: invocation.commandArgs,
				cliPath: invocation.cliPath,
				cwd: resolvedCwd,
				args: childArgs,
				env: { PI_MUX_CHILD: "1" },
				pipeStderr: false,
			}),
			status: "starting",
			lines: [],
			statusLines: new Map(),
		};

		this.panes.push(pane);
		if (options?.focus || this.panes.length === 1) {
			this.activeIndex = this.panes.length - 1;
		}
		this.appendSystemLine(pane, `starting ${shortPath(resolvedCwd)}`);
		this.scheduleRender();

		try {
			pane.client.onClientEvent((event) => {
				void this.handlePaneEvent(pane, event);
			});
			await pane.client.start();
			pane.state = await pane.client.getState();
			const duplicate = this.findDuplicateSessionPane(pane);
			if (duplicate) {
				await pane.client.stop();
				this.removePane(pane);
				this.appendSystemLine(
					this.activePaneOrUndefined(),
					`session already open in pane ${duplicate.id}: ${pane.state.sessionFile}`,
				);
				return;
			}
			pane.status = pane.state.isStreaming ? "running" : "idle";
			this.appendSystemLine(pane, this.formatPaneReady(pane));
		} catch (error: unknown) {
			pane.status = "error";
			pane.error = error instanceof Error ? error.message : String(error);
			this.appendSystemLine(pane, `failed to start: ${pane.error}`);
			if (options?.initial) {
				this.appendSystemLine(pane, "Press Ctrl+D to exit.");
			}
		}

		this.scheduleRender();
	}

	private findDuplicateSessionPane(pane: MuxPane): MuxPane | undefined {
		const sessionFile = pane.state?.sessionFile;
		if (!sessionFile) return undefined;
		const normalized = normalizeSessionPath(sessionFile);
		return this.panes.find(
			(candidate) =>
				candidate !== pane &&
				candidate.status !== "closed" &&
				candidate.state?.sessionFile !== undefined &&
				normalizeSessionPath(candidate.state.sessionFile) === normalized,
		);
	}

	private formatPaneReady(pane: MuxPane): string {
		const model = pane.state?.model;
		const modelLabel = model ? `${model.provider}/${model.id}` : "no model";
		const sessionLabel = pane.state?.sessionId ? `session ${pane.state.sessionId}` : "session pending";
		return `ready: ${sessionLabel}, ${modelLabel}`;
	}

	private async handlePaneEvent(pane: MuxPane, event: RpcClientEvent): Promise<void> {
		if (this.isExtensionUIRequest(event)) {
			this.handleExtensionUIRequest(pane, event);
			return;
		}
		if (event.type === "extension_error") {
			this.appendSystemLine(pane, `extension error: ${event.extensionPath}: ${event.error}`);
			return;
		}

		if (!isRecord(event) || typeof event.type !== "string") return;

		this.handleSessionEvent(pane, event);
		if (event.type === "agent_end") {
			try {
				pane.state = await pane.client.getState();
				pane.status = pane.state.isStreaming ? "running" : "idle";
			} catch (error: unknown) {
				pane.status = "error";
				pane.error = error instanceof Error ? error.message : String(error);
			}
			this.scheduleRender();
		}
	}

	private isExtensionUIRequest(event: RpcClientEvent): event is RpcExtensionUIRequest {
		return event.type === "extension_ui_request";
	}

	private handleExtensionUIRequest(pane: MuxPane, request: RpcExtensionUIRequest): void {
		switch (request.method) {
			case "notify":
				this.appendSystemLine(pane, `notify: ${request.message}`);
				return;
			case "setStatus":
				if (request.statusText) {
					pane.statusLines.set(request.statusKey, request.statusText);
				} else {
					pane.statusLines.delete(request.statusKey);
				}
				this.scheduleRender();
				return;
			case "setWidget":
				if (request.widgetLines && request.widgetLines.length > 0) {
					this.appendSystemLine(pane, `widget ${request.widgetKey}: ${request.widgetLines.join(" | ")}`);
				}
				return;
			case "setTitle":
				pane.title = request.title || pane.title;
				this.scheduleRender();
				return;
			case "set_editor_text":
				if (this.panes[this.activeIndex] === pane) {
					this.input = request.text;
				}
				this.scheduleRender();
				return;
			case "confirm":
				pane.client.respondToExtensionUI({ type: "extension_ui_response", id: request.id, confirmed: false });
				this.appendSystemLine(pane, `auto-declined confirm: ${request.title}`);
				return;
			case "select":
			case "input":
			case "editor":
				pane.client.respondToExtensionUI({ type: "extension_ui_response", id: request.id, cancelled: true });
				this.appendSystemLine(pane, `auto-cancelled ${request.method}: ${request.title}`);
				return;
		}
	}

	private handleSessionEvent(pane: MuxPane, event: Record<string, unknown> & { type: string }): void {
		switch (event.type) {
			case "agent_start":
				pane.status = "running";
				this.appendSystemLine(pane, "agent started");
				break;
			case "agent_end":
				this.appendSystemLine(pane, "agent ended");
				break;
			case "message_update":
				this.handleMessageUpdate(pane, event.assistantMessageEvent);
				break;
			case "tool_execution_start": {
				const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
				this.appendSystemLine(pane, `tool start: ${toolName} ${truncatePlain(formatUnknown(event.args), 160)}`);
				break;
			}
			case "tool_execution_end": {
				const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
				this.appendSystemLine(pane, `tool end: ${toolName}${event.isError === true ? " (error)" : ""}`);
				break;
			}
			case "queue_update": {
				const steeringCount = Array.isArray(event.steering) ? event.steering.length : 0;
				const followUpCount = Array.isArray(event.followUp) ? event.followUp.length : 0;
				this.appendSystemLine(pane, `queue: steer=${steeringCount}, follow-up=${followUpCount}`);
				break;
			}
			case "compaction_start": {
				const reason = typeof event.reason === "string" ? event.reason : "unknown";
				this.appendSystemLine(pane, `compaction started: ${reason}`);
				break;
			}
			case "compaction_end": {
				const reason = typeof event.reason === "string" ? event.reason : "unknown";
				this.appendSystemLine(pane, `compaction ended: ${event.aborted === true ? "aborted" : reason}`);
				break;
			}
			case "auto_retry_start": {
				const attempt = typeof event.attempt === "number" ? event.attempt : "?";
				const maxAttempts = typeof event.maxAttempts === "number" ? event.maxAttempts : "?";
				const reason = typeof event.reason === "string" ? event.reason : "unknown";
				this.appendSystemLine(pane, `retry ${attempt}/${maxAttempts}: ${reason}`);
				break;
			}
			case "auto_retry_end":
				this.appendSystemLine(pane, `retry ended: ${event.success === true ? "success" : "failed"}`);
				break;
			case "message_start":
			case "message_end":
			case "turn_start":
			case "turn_end":
			case "tool_execution_update":
				break;
		}
	}

	private handleMessageUpdate(pane: MuxPane, assistantMessageEvent: unknown): void {
		if (!isRecord(assistantMessageEvent)) return;
		const type = assistantMessageEvent.type;
		if (type === "text_start") {
			this.appendLine(pane, chalk.cyan("assistant: "));
			return;
		}
		if (type === "text_delta") {
			const delta = assistantMessageEvent.delta;
			if (typeof delta === "string") {
				this.appendText(pane, displayText(delta));
			}
			return;
		}
		if (type === "thinking_start") {
			this.appendSystemLine(pane, "thinking...");
			return;
		}
		if (type === "toolcall_start") {
			this.appendSystemLine(pane, "preparing tool call...");
		}
	}

	private async abortPane(index: number): Promise<void> {
		const pane = this.panes[index];
		if (!pane) return;
		try {
			await pane.client.abort();
			this.appendSystemLine(pane, "abort sent");
		} catch (error: unknown) {
			this.appendSystemLine(pane, `abort failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async closePane(index: number): Promise<void> {
		const pane = this.panes[index];
		if (!pane) return;
		this.appendSystemLine(pane, "closing pane");
		try {
			await pane.client.stop();
		} catch (error: unknown) {
			this.appendSystemLine(pane, `close failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		this.removePane(pane);
		if (this.panes.length === 0) {
			await this.shutdown();
			return;
		}
		this.activeIndex = Math.min(this.activeIndex, this.panes.length - 1);
		this.scheduleRender();
	}

	private removePane(pane: MuxPane): void {
		const index = this.panes.indexOf(pane);
		if (index === -1) return;
		pane.status = "closed";
		this.panes.splice(index, 1);
		if (this.activeIndex >= this.panes.length) {
			this.activeIndex = Math.max(0, this.panes.length - 1);
		}
	}

	private renderPaneStatusLines(): string[] {
		return this.panes.map((pane, index) => {
			const active = index === this.activeIndex ? "*" : " ";
			const model = pane.state?.model ? `${pane.state.model.provider}/${pane.state.model.id}` : "no model";
			const session = pane.state?.sessionId ?? "no session";
			return `${active} ${index + 1}. ${pane.title} | ${pane.status} | ${session} | ${model} | ${shortPath(pane.cwd)}`;
		});
	}

	private activePane(): MuxPane {
		const pane = this.panes[this.activeIndex];
		if (!pane) throw new Error("No active mux pane");
		return pane;
	}

	private activePaneOrUndefined(): MuxPane | undefined {
		return this.panes[this.activeIndex];
	}

	private appendSystemLine(pane: MuxPane | undefined, line: string): void {
		if (!pane) return;
		this.appendLine(pane, chalk.dim(`[mux] ${line}`));
	}

	private appendLine(pane: MuxPane, line: string): void {
		for (const part of displayText(line).split("\n")) {
			pane.lines.push(part);
		}
		if (pane.lines.length > MAX_BUFFER_LINES) {
			pane.lines.splice(0, pane.lines.length - MAX_BUFFER_LINES);
		}
		this.scheduleRender();
	}

	private appendText(pane: MuxPane, text: string): void {
		const parts = text.split("\n");
		if (pane.lines.length === 0) {
			pane.lines.push("");
		}
		const lastIndex = pane.lines.length - 1;
		pane.lines[lastIndex] = `${pane.lines[lastIndex] ?? ""}${parts[0] ?? ""}`;
		for (const part of parts.slice(1)) {
			pane.lines.push(part);
		}
		if (pane.lines.length > MAX_BUFFER_LINES) {
			pane.lines.splice(0, pane.lines.length - MAX_BUFFER_LINES);
		}
		this.scheduleRender();
	}

	private scheduleRender(): void {
		if (this.renderTimer !== undefined) return;
		this.renderTimer = setTimeout(() => {
			this.renderTimer = undefined;
			this.render();
		}, 16);
	}

	private render(): void {
		if (this.isShuttingDown) return;
		const columns = Math.max(20, process.stdout.columns || 80);
		const rows = Math.max(10, process.stdout.rows || 24);
		const pane = this.activePaneOrUndefined();
		const output: string[] = [];

		output.push(truncateToWidth(`${chalk.inverse(` pi mux `)} ${this.renderTabLine()}`, columns));
		output.push(truncateToWidth(chalk.dim("Ctrl+O switch | Ctrl+N new | /mux help | Ctrl+D quit"), columns));

		if (this.pickerVisible) {
			output.push("");
			output.push(chalk.bold("Switch pane"));
			for (let i = 0; i < this.panes.length; i++) {
				const entry = this.panes[i]!;
				const marker = i === this.pickerIndex ? ">" : " ";
				const model = entry.state?.model ? `${entry.state.model.provider}/${entry.state.model.id}` : "no model";
				output.push(
					truncateToWidth(
						`${marker} ${i + 1}. ${entry.title} | ${entry.status} | ${model} | ${shortPath(entry.cwd)}`,
						columns,
					),
				);
			}
		} else if (pane) {
			output.push(
				truncateToWidth(chalk.dim(`${shortPath(pane.cwd)} | ${pane.state?.sessionId ?? "starting"}`), columns),
			);
			const footerRows = 3;
			const availableRows = Math.max(1, rows - output.length - footerRows);
			const visibleLines = pane.lines.flatMap((line) => wrapPlainLine(line, columns)).slice(-availableRows);
			output.push(...visibleLines.map((line) => truncateToWidth(line, columns)));
			while (output.length < rows - footerRows) {
				output.push("");
			}
			const statuses = [...pane.statusLines.values()].join(" | ");
			const statusLine = statuses ? `${pane.status} | ${statuses}` : pane.status;
			output.push(truncateToWidth(chalk.dim(statusLine), columns));
			output.push(truncateToWidth(`> ${this.input.replace(/\n/g, "\\n")}`, columns));
			output.push(
				truncateToWidth(
					chalk.dim("Enter sends to active pane; running panes receive follow-up messages."),
					columns,
				),
			);
		}

		while (output.length < rows) {
			output.push("");
		}
		process.stdout.write(`\u001b[H${output.slice(0, rows).join("\n")}`);
	}

	private renderTabLine(): string {
		return this.panes
			.map((pane, index) => {
				const label = `${index + 1}:${pane.title}:${pane.status}`;
				return index === this.activeIndex ? chalk.bold(chalk.cyan(`[${label}]`)) : chalk.dim(label);
			})
			.join("  ");
	}

	private async shutdown(): Promise<void> {
		if (this.isShuttingDown) return;
		this.isShuttingDown = true;
		if (this.renderTimer !== undefined) {
			clearTimeout(this.renderTimer);
			this.renderTimer = undefined;
		}
		for (const pane of [...this.panes]) {
			try {
				await pane.client.stop();
			} catch {
				// Best-effort shutdown.
			}
		}
		this.panes = [];
		this.restoreTerminal();
		this.resolveRun?.();
	}
}

function truncatePlain(value: string, maxLength: number): string {
	const plain = stripAnsi(value).replace(/\s+/g, " ").trim();
	return plain.length > maxLength ? `${plain.slice(0, Math.max(0, maxLength - 3))}...` : plain;
}

function wrapPlainLine(line: string, columns: number): string[] {
	const width = Math.max(1, columns);
	const plain = stripAnsi(line);
	if (plain.length <= width) return [line];
	const chunks: string[] = [];
	let remaining = line;
	while (stripAnsi(remaining).length > width) {
		chunks.push(truncateToWidth(remaining, width));
		remaining = stripAnsi(remaining).slice(width);
	}
	chunks.push(remaining);
	return chunks;
}

export async function runMuxMode(args: string[]): Promise<void> {
	if (args.includes("--help") || args.includes("-h")) {
		console.log(renderHelp());
		return;
	}
	await new MuxMode({ childArgs: removeMuxManagedArgs(args) }).run();
}
