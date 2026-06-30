import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type SubmittedInput = {
	text: string;
	images?: unknown[];
};

type SubmitContext = {
	defaultEditor: { onSubmit?: (text: string) => void };
	editor: {
		addToHistory?: (text: string) => void;
		setText: (text: string) => void;
	};
	session: {
		isCompacting: boolean;
		isStreaming: boolean;
		isBashRunning: boolean;
		prompt: (text: string, options?: unknown) => Promise<void>;
	};
	flushPendingBashComponents: () => void;
	extractSubmittedImages: (text: string) => Promise<SubmittedInput>;
	prepareRequestResources: (showLoader: boolean) => Promise<void>;
	handleSwitchCommand: (text: string) => Promise<void>;
	onInputCallback?: (input: SubmittedInput) => void;
	pendingUserInputs: SubmittedInput[];
};

type InputContext = {
	onInputCallback?: (input: SubmittedInput) => void;
	pendingUserInputs: SubmittedInput[];
};

type TestTaskPriority = "low" | "normal" | "high";

type WorkspaceSummaryContext = {
	backgroundTaskQueue: {
		schedule: (
			key: string,
			run: () => Promise<unknown>,
			options?: { priority?: TestTaskPriority },
		) => Promise<unknown>;
	};
	scheduleBackgroundTask: (
		key: string,
		run: () => Promise<unknown>,
		options?: { priority?: TestTaskPriority },
	) => Promise<unknown>;
	loadWorkspaceSummaries: (options?: { priority?: TestTaskPriority }) => Promise<unknown>;
	listVisibleSessions: () => Promise<unknown[]>;
	sessionActivityRegistry: {
		listActiveSessions: () => Promise<unknown[]>;
		listWorkspaces: () => Promise<unknown[]>;
	};
	sessionManager: {
		getCwd: () => string;
	};
};

type StartupBackgroundChecksContext = {
	version: string;
	scheduleBackgroundTask: (
		key: string,
		run: () => Promise<unknown>,
		options?: { priority?: TestTaskPriority },
	) => Promise<unknown>;
	options: {
		checkForPackageUpdates?: (options: never) => Promise<string[]>;
	};
	showNewVersionNotification: (release: unknown) => void;
	showPackageUpdateNotification: (packages: string[]) => void;
	showWarning: (warning: string) => void;
	checkForPackageUpdates: () => Promise<string[]>;
	checkTmuxKeyboardSetup: () => Promise<string | undefined>;
};

type RequestResourcesContext = {
	sessionGeneration: number;
	scheduleRequestResourceLoad: (options?: { priority?: TestTaskPriority }) => Promise<void>;
	showError: (message: string) => void;
};

type RequestResourceScheduleContext = {
	session: {
		prepareForFirstRequest: () => Promise<void>;
	};
	sessionGeneration: number;
	scheduleBackgroundTask: (
		key: string,
		run: () => Promise<void>,
		options?: { priority?: TestTaskPriority },
	) => Promise<void>;
	applyCurrentSessionExtensionBindings: () => void;
	updateAvailableProviderCount: () => Promise<void>;
	updateEditorBorderColor: () => void;
	footer: {
		invalidate: () => void;
	};
	ui: {
		requestRender: () => void;
	};
};

type InteractiveModePrivate = {
	setupEditorSubmitHandler(this: SubmitContext): void;
	getUserInput(this: InputContext): Promise<SubmittedInput>;
	scheduleStartupBackgroundChecks(this: StartupBackgroundChecksContext): void;
	preloadRequestResources(this: RequestResourcesContext): void;
	scheduleRequestResourceLoad(
		this: RequestResourceScheduleContext,
		options?: { priority?: TestTaskPriority },
	): Promise<void>;
	preloadWorkspaceSummaries(this: WorkspaceSummaryContext): void;
	loadWorkspaceSummaries(this: WorkspaceSummaryContext, options?: { priority?: TestTaskPriority }): Promise<unknown>;
	scheduleBackgroundTask(
		this: WorkspaceSummaryContext,
		key: string,
		run: () => Promise<unknown>,
		options?: { priority?: TestTaskPriority },
	): Promise<unknown>;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrivate;

function createSubmitContext(): SubmitContext {
	return {
		defaultEditor: {},
		editor: {
			addToHistory: vi.fn(),
			setText: vi.fn(),
		},
		session: {
			isCompacting: false,
			isStreaming: false,
			isBashRunning: false,
			prompt: vi.fn(async () => {}),
		},
		flushPendingBashComponents: vi.fn(),
		extractSubmittedImages: vi.fn(async (text: string) => ({ text })),
		prepareRequestResources: vi.fn(async () => {}),
		handleSwitchCommand: vi.fn(async () => {}),
		pendingUserInputs: [],
	};
}

describe("InteractiveMode startup input", () => {
	it("queues a normal prompt submitted before the input callback is installed", async () => {
		const context = createSubmitContext();
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.(" early prompt ");

		expect(context.pendingUserInputs).toEqual([{ text: "early prompt" }]);
		expect(context.flushPendingBashComponents).toHaveBeenCalledTimes(1);
		expect(context.editor.addToHistory).toHaveBeenCalledWith("early prompt");
	});

	it("waits for request resource preparation before accepting startup input", async () => {
		const context = createSubmitContext();
		let resolvePrepare: (() => void) | undefined;
		const preparePromise = new Promise<void>((resolve) => {
			resolvePrepare = resolve;
		});
		context.prepareRequestResources = vi.fn(() => preparePromise);
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		const submitPromise = context.defaultEditor.onSubmit?.(" early prompt ");
		await Promise.resolve();

		expect(context.pendingUserInputs).toEqual([]);
		expect(context.flushPendingBashComponents).not.toHaveBeenCalled();
		if (!resolvePrepare) {
			throw new Error("prepare promise resolver was not created");
		}
		resolvePrepare();
		await submitPromise;

		expect(context.prepareRequestResources).toHaveBeenCalledWith(true);
		expect(context.pendingUserInputs).toEqual([{ text: "early prompt" }]);
		expect(context.flushPendingBashComponents).toHaveBeenCalledTimes(1);
	});

	it("does not prepare request resources before handling built-in switch command", async () => {
		const context = createSubmitContext();
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.("/switch");

		expect(context.prepareRequestResources).not.toHaveBeenCalled();
		expect(context.handleSwitchCommand).toHaveBeenCalledWith("/switch");
		expect(context.editor.setText).toHaveBeenCalledWith("");
		expect(context.pendingUserInputs).toEqual([]);
	});

	it("returns queued startup input before installing a new input callback", async () => {
		const context: InputContext = {
			pendingUserInputs: [{ text: "queued prompt" }],
		};

		await expect(interactiveModePrototype.getUserInput.call(context)).resolves.toEqual({ text: "queued prompt" });
		expect(context.onInputCallback).toBeUndefined();
		expect(context.pendingUserInputs).toEqual([]);
	});

	it("uses normal priority for switch preloading and high priority when switch is opened", async () => {
		const calls: Array<{ key: string; priority?: string }> = [];
		const context: WorkspaceSummaryContext = {
			backgroundTaskQueue: {
				schedule: vi.fn(async (key, run, options) => {
					calls.push({ key, priority: options?.priority });
					return await run();
				}),
			},
			scheduleBackgroundTask: interactiveModePrototype.scheduleBackgroundTask,
			loadWorkspaceSummaries: interactiveModePrototype.loadWorkspaceSummaries,
			listVisibleSessions: vi.fn(async () => []),
			sessionActivityRegistry: {
				listActiveSessions: vi.fn(async () => []),
				listWorkspaces: vi.fn(async () => []),
			},
			sessionManager: {
				getCwd: () => "/workspace",
			},
		};

		interactiveModePrototype.preloadWorkspaceSummaries.call(context);
		await Promise.resolve();
		await interactiveModePrototype.loadWorkspaceSummaries.call(context, { priority: "high" });

		expect(calls).toEqual([
			{ key: "workspace-summaries", priority: "normal" },
			{ key: "workspace-summaries", priority: "high" },
		]);
	});

	it("preloads request resources after startup with low priority", async () => {
		vi.useFakeTimers();
		const context: RequestResourcesContext = {
			sessionGeneration: 7,
			scheduleRequestResourceLoad: vi.fn(async () => {}),
			showError: vi.fn(),
		};

		try {
			interactiveModePrototype.preloadRequestResources.call(context);

			expect(context.scheduleRequestResourceLoad).not.toHaveBeenCalled();
			await vi.runAllTimersAsync();

			expect(context.scheduleRequestResourceLoad).toHaveBeenCalledWith({ priority: "low" });
		} finally {
			vi.useRealTimers();
		}
	});

	it("schedules request resource preparation with a generation-scoped key", async () => {
		const calls: Array<{ key: string; priority?: string }> = [];
		const context: RequestResourceScheduleContext = {
			session: {
				prepareForFirstRequest: vi.fn(async () => {}),
			},
			sessionGeneration: 11,
			scheduleBackgroundTask: vi.fn(async (key, _run, options) => {
				calls.push({ key, priority: options?.priority });
			}),
			applyCurrentSessionExtensionBindings: vi.fn(),
			updateAvailableProviderCount: vi.fn(async () => {}),
			updateEditorBorderColor: vi.fn(),
			footer: {
				invalidate: vi.fn(),
			},
			ui: {
				requestRender: vi.fn(),
			},
		};

		await interactiveModePrototype.scheduleRequestResourceLoad.call(context, { priority: "low" });
		await interactiveModePrototype.scheduleRequestResourceLoad.call(context, { priority: "high" });

		expect(calls).toEqual([
			{ key: "request-resources:11", priority: "low" },
			{ key: "request-resources:11", priority: "high" },
		]);
	});

	it("does not schedule disabled startup background checks", async () => {
		const previousSkipVersion = process.env.PI_SKIP_VERSION_CHECK;
		const previousCheckPackages = process.env.PI_CHECK_PACKAGE_UPDATES;
		const previousSkipPackages = process.env.PI_SKIP_PACKAGE_UPDATE_CHECK;
		const previousSkipTmux = process.env.PI_SKIP_TMUX_CHECK;
		process.env.PI_SKIP_VERSION_CHECK = "1";
		process.env.PI_CHECK_PACKAGE_UPDATES = "1";
		process.env.PI_SKIP_PACKAGE_UPDATE_CHECK = "1";
		process.env.PI_SKIP_TMUX_CHECK = "1";

		try {
			const scheduled: string[] = [];
			const context: StartupBackgroundChecksContext = {
				version: "0.0.0",
				scheduleBackgroundTask: vi.fn(async (key) => {
					scheduled.push(key);
					return undefined;
				}),
				options: {
					checkForPackageUpdates: vi.fn(async () => []),
				},
				showNewVersionNotification: vi.fn(),
				showPackageUpdateNotification: vi.fn(),
				showWarning: vi.fn(),
				checkForPackageUpdates: vi.fn(async () => []),
				checkTmuxKeyboardSetup: vi.fn(async () => undefined),
			};

			interactiveModePrototype.scheduleStartupBackgroundChecks.call(context);

			expect(scheduled).toEqual([]);
		} finally {
			if (previousSkipVersion === undefined) delete process.env.PI_SKIP_VERSION_CHECK;
			else process.env.PI_SKIP_VERSION_CHECK = previousSkipVersion;
			if (previousCheckPackages === undefined) delete process.env.PI_CHECK_PACKAGE_UPDATES;
			else process.env.PI_CHECK_PACKAGE_UPDATES = previousCheckPackages;
			if (previousSkipPackages === undefined) delete process.env.PI_SKIP_PACKAGE_UPDATE_CHECK;
			else process.env.PI_SKIP_PACKAGE_UPDATE_CHECK = previousSkipPackages;
			if (previousSkipTmux === undefined) delete process.env.PI_SKIP_TMUX_CHECK;
			else process.env.PI_SKIP_TMUX_CHECK = previousSkipTmux;
		}
	});
});
