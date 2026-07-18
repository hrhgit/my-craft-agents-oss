import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, normalize, parse, resolve, sep } from "node:path";
import { Container, type Focusable, getKeybindings, Input, Spacer, Text, TruncatedText } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";

export interface WorkspaceSelectorKnownWorkspace {
	cwd: string;
	label: string;
	searchText: string;
}

type WorkspaceSelectorItem =
	| { kind: "new"; label: string; description: string }
	| { kind: "current"; cwd: string; label: string; description: string }
	| { kind: "known"; cwd: string; label: string; description: string }
	| WorkspaceSelectorFolderItem;

type WorkspaceSelectorFolderItem = { kind: "folder"; cwd: string; label: string; description: string };

function pathKey(targetPath: string): string {
	const resolved = resolve(targetPath);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isDirectory(targetPath: string): boolean {
	try {
		return existsSync(targetPath) && statSync(targetPath).isDirectory();
	} catch {
		return false;
	}
}

function shortenHomePath(targetPath: string): string {
	const home = homedir();
	const normalizedHome = normalize(home);
	const normalizedTarget = normalize(targetPath);
	if (normalizedTarget === normalizedHome) return "~";
	if (process.platform === "win32") {
		const prefix = `${normalizedHome.toLowerCase()}${sep}`;
		if (normalizedTarget.toLowerCase().startsWith(prefix)) {
			return `~${normalizedTarget.slice(normalizedHome.length)}`;
		}
		return targetPath;
	}
	if (normalizedTarget.startsWith(`${normalizedHome}${sep}`)) {
		return `~${normalizedTarget.slice(normalizedHome.length)}`;
	}
	return targetPath;
}

function lastPathSegment(targetPath: string): string {
	const normalized = normalize(targetPath);
	const name = basename(normalized);
	return name || parse(normalized).root || normalized;
}

function stripQuotes(value: string): string {
	return value.trim().replace(/^["']|["']$/g, "");
}

function expandHome(value: string): string {
	if (value === "~") return homedir();
	if (value.startsWith("~/") || value.startsWith("~\\")) {
		return resolve(homedir(), value.slice(2));
	}
	return value;
}

function resolveWorkspaceInput(input: string, currentCwd: string): string {
	const expanded = expandHome(stripQuotes(input));
	return isAbsolute(expanded) ? resolve(expanded) : resolve(currentCwd, expanded);
}

function hasTrailingSeparator(value: string): boolean {
	return value.endsWith("/") || value.endsWith("\\");
}

function withTrailingSeparator(value: string): string {
	return value.endsWith("/") || value.endsWith("\\") ? value : `${value}${sep}`;
}

function getDirectorySearch(input: string, currentCwd: string): { baseDir: string; prefix: string } {
	const raw = stripQuotes(input);
	if (!raw) return { baseDir: currentCwd, prefix: "" };

	const resolved = resolveWorkspaceInput(raw, currentCwd);
	if (hasTrailingSeparator(raw) || isDirectory(resolved)) {
		return { baseDir: resolved, prefix: "" };
	}

	return { baseDir: dirname(resolved), prefix: basename(resolved).toLowerCase() };
}

function listChildDirectories(baseDir: string, prefix: string): WorkspaceSelectorFolderItem[] {
	if (!isDirectory(baseDir)) return [];
	try {
		return readdirSync(baseDir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && entry.name.toLowerCase().startsWith(prefix))
			.sort((a, b) => a.name.localeCompare(b.name))
			.slice(0, 40)
			.map((entry) => {
				const cwd = resolve(baseDir, entry.name);
				return {
					kind: "folder" as const,
					cwd,
					label: `Folder: ${entry.name}${sep}`,
					description: shortenHomePath(cwd),
				};
			});
	} catch {
		return [];
	}
}

export class WorkspaceSelectorComponent extends Container implements Focusable {
	private readonly pathInput = new Input();
	private readonly listContainer = new Container();
	private readonly knownWorkspaces: WorkspaceSelectorKnownWorkspace[];
	private readonly currentCwd: string;
	private readonly onSelect: (cwd: string) => void;
	private readonly onCancel: () => void;
	private items: WorkspaceSelectorItem[] = [];
	private selectedIndex = 0;

	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.pathInput.focused = value;
	}

	constructor(
		knownWorkspaces: WorkspaceSelectorKnownWorkspace[],
		currentCwd: string,
		onSelect: (cwd: string) => void,
		onCancel: () => void,
		initialInput?: string,
	) {
		super();
		this.knownWorkspaces = knownWorkspaces;
		this.currentCwd = currentCwd;
		this.onSelect = onSelect;
		this.onCancel = onCancel;

		if (initialInput) {
			this.pathInput.setValue(initialInput, initialInput.length);
		}
		this.pathInput.onSubmit = () => {
			this.selectCurrent();
		};

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.bold(theme.fg("accent", "Switch workspace")), 1, 0));
		this.addChild(new Text(theme.fg("muted", "Type a path or workspace name"), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(this.pathInput);
		this.addChild(new Spacer(1));
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				rawKeyHint("↑↓", "navigate") +
					"  " +
					keyHint("tui.input.tab", "open folder") +
					"  " +
					keyHint("tui.select.confirm", "select") +
					"  " +
					keyHint("tui.select.cancel", "cancel"),
				1,
				0,
			),
		);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());

		this.rebuildItems();
	}

	getInput(): Input {
		return this.pathInput;
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.up")) {
			if (this.items.length > 0) {
				this.selectedIndex = this.selectedIndex === 0 ? this.items.length - 1 : this.selectedIndex - 1;
				this.updateList();
			}
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			if (this.items.length > 0) {
				this.selectedIndex = this.selectedIndex === this.items.length - 1 ? 0 : this.selectedIndex + 1;
				this.updateList();
			}
			return;
		}
		if (kb.matches(data, "tui.input.tab")) {
			this.openSelectedFolder();
			return;
		}
		if (kb.matches(data, "tui.select.confirm")) {
			this.selectCurrent();
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			this.onCancel();
			return;
		}

		this.pathInput.handleInput(data);
		this.rebuildItems();
	}

	private rebuildItems(): void {
		const input = this.pathInput.getValue().trim();
		const items: WorkspaceSelectorItem[] = [];

		if (!input) {
			items.push({
				kind: "new",
				label: "New workspace...",
				description: shortenHomePath(this.currentCwd),
			});
		}

		const seen = new Set<string>();
		const { baseDir, prefix } = getDirectorySearch(input, this.currentCwd);
		if (input) {
			if (!prefix && isDirectory(baseDir)) {
				seen.add(pathKey(baseDir));
				items.push({
					kind: "current",
					cwd: baseDir,
					label: "Use this folder",
					description: shortenHomePath(baseDir),
				});
			}
			for (const item of listChildDirectories(baseDir, prefix)) {
				seen.add(pathKey(item.cwd));
				items.push(item);
			}
		}

		const query = input.toLowerCase();
		for (const workspace of this.knownWorkspaces) {
			if (query && !workspace.searchText.toLowerCase().includes(query)) continue;
			const key = pathKey(workspace.cwd);
			if (seen.has(key)) continue;
			seen.add(key);
			items.push({
				kind: "known",
				cwd: workspace.cwd,
				label: workspace.label,
				description: lastPathSegment(workspace.cwd),
			});
			if (items.length >= 40) break;
		}

		this.items = items;
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.items.length - 1));
		this.updateList();
	}

	private updateList(): void {
		this.listContainer.clear();
		if (this.items.length === 0) {
			const input = this.pathInput.getValue().trim();
			const resolved = input ? resolveWorkspaceInput(input, this.currentCwd) : "";
			const suffix = resolved ? `: ${shortenHomePath(resolved)}` : "";
			this.listContainer.addChild(new Text(theme.fg("muted", `  No matching folders${suffix}`), 0, 0));
			return;
		}

		const maxVisible = 10;
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.items.length - maxVisible),
		);
		const endIndex = Math.min(startIndex + maxVisible, this.items.length);

		for (let i = startIndex; i < endIndex; i++) {
			const item = this.items[i];
			if (!item) continue;
			const selected = i === this.selectedIndex;
			const prefix = selected ? theme.fg("accent", "→ ") : "  ";
			const label = selected ? theme.fg("accent", item.label) : theme.fg("text", item.label);
			const description = theme.fg("muted", ` ${item.description}`);
			this.listContainer.addChild(new TruncatedText(`${prefix}${label}${description}`, 1, 0));
		}

		if (startIndex > 0 || endIndex < this.items.length) {
			this.listContainer.addChild(
				new Text(theme.fg("muted", `  (${this.selectedIndex + 1}/${this.items.length})`), 0, 0),
			);
		}
	}

	private openSelectedFolder(): void {
		const selected = this.items[this.selectedIndex];
		if (!selected) return;
		if (selected.kind === "current") return;
		const cwd = selected.kind === "new" ? this.currentCwd : selected.cwd;
		const value = withTrailingSeparator(shortenHomePath(cwd));
		this.pathInput.setValue(value, value.length);
		this.rebuildItems();
	}

	private selectCurrent(): void {
		const selected = this.items[this.selectedIndex];
		if (selected?.kind === "new") {
			this.openSelectedFolder();
			return;
		}
		if (selected) {
			this.onSelect(selected.cwd);
			return;
		}

		const input = this.pathInput.getValue().trim();
		if (!input) return;
		const resolved = resolveWorkspaceInput(input, this.currentCwd);
		if (isDirectory(resolved)) {
			this.onSelect(resolved);
		}
	}
}
