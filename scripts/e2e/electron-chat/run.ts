import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { _electron as electron, chromium, type Browser, type BrowserContext, type ElectronApplication, type Page } from "playwright-core";

type JsonRecord = Record<string, unknown>;

interface LlmConnectionWithStatus {
  slug: string;
  name?: string;
  isAuthenticated?: boolean;
  isDefault?: boolean;
  defaultModel?: string;
}

interface Summary {
  runId: string;
  status: "running" | "passed" | "failed";
  startedAt: string;
  endedAt?: string;
  rootDir: string;
  artifactsDir: string;
  tempRoot: string;
  tempProfileRemoved?: boolean;
  selectedConnection?: Pick<LlmConnectionWithStatus, "slug" | "name" | "defaultModel">;
  requestedConnectionSlug?: string;
  chatPhaseStartMs?: number;
  error?: string;
  evidence?: {
    providerRequestCount: number;
    providerSuccessResponseCount: number;
    providerErrorCount: number;
    visibleSentinelCount: number;
    sendButtonDisappeared: boolean;
    createdSessionId?: string;
    activeSessionIdBeforeSend?: string;
    inputSessionIdBeforeSend?: string;
    selectedSessionIdBeforeSend?: string | null;
    activeSessionIdAfterReply?: string;
    backendSessionId?: string;
    sessionIdsMatched?: boolean;
    fatalUiErrorCount?: number;
    fatalUiErrorKinds?: string[];
  };
  phases: Record<string, { status: "pending" | "running" | "passed" | "failed"; detail?: string }>;
}

interface DesktopLaunch {
  mode: "playwright-electron" | "cdp" | "node-inspector";
  app?: ElectronApplication;
  browser?: Browser;
  context?: BrowserContext;
  child?: ChildProcessWithoutNullStreams;
  inspector?: NodeInspectorClient;
  page?: Page;
}

interface InspectorChatResult {
  chatPhaseStartMs: number;
  visibleSentinelCount: number;
  sendButtonDisappeared: boolean;
  createdSessionId: string;
  activeSessionIdBeforeSend: string;
  inputSessionIdBeforeSend: string;
  selectedSessionIdBeforeSend: string | null;
  activeSessionIdAfterReply: string;
}

const require = createRequire(import.meta.url);
const ROOT_DIR = resolve(import.meta.dir, "../../..");
const ELECTRON_APP_DIR = join(ROOT_DIR, "apps", "electron");
const ARTIFACT_ROOT = join(ROOT_DIR, "output", "playwright", "electron-chat");
const PROVIDER_HOOK_PATH = join(import.meta.dir, "provider-hook.cjs");
const PLAYWRIGHT_ELECTRON_DRIVER_TIMEOUT_MS = 20_000;
const ELECTRON_LAUNCH_TIMEOUT_MS = 300_000;
const CDP_CONNECT_TIMEOUT_MS = 60_000;
const CHAT_TIMEOUT_MS = 180_000;

const FATAL_UI_LOG_PATTERNS: Array<{ kind: string; pattern: RegExp }> = [
  { kind: "pi-process-exited", pattern: /Pi Process Exited/i },
  { kind: "pi-get-capabilities", pattern: /get_capabilities|does not expose get_capabilities/i },
  { kind: "agent-process-exited", pattern: /Agent process exited|process exited before/i },
  { kind: "eperm-reading", pattern: /EPERM reading/i },
  { kind: "send-message-timeout", pattern: /Failed to send message|Request timeout: sessions:sendMessage/i },
  { kind: "rpc-client-not-started", pattern: /Client not started|stdin is not writable/i },
  { kind: "closed-socket-response", pattern: /WebSocket send skipped because socket is not open/i },
];

const runId = makeRunId();
const artifactsDir = join(ARTIFACT_ROOT, runId);
const providerLogPath = join(artifactsDir, "provider-requests.jsonl");
const consoleLogPath = join(artifactsDir, "console.jsonl");
const pageErrorLogPath = join(artifactsDir, "page-errors.jsonl");
const electronProcessLogPath = join(artifactsDir, "electron-process.log");
const summaryPath = join(artifactsDir, "summary.json");
const tracePath = join(artifactsDir, "trace.zip");
const tempRoot = join(tmpdir(), `craft-electron-chat-${runId}`);
const requestedConnectionSlug = process.env.CRAFT_E2E_CONNECTION_SLUG?.trim() || undefined;

let summary: Summary = {
  runId,
  status: "running",
  startedAt: new Date().toISOString(),
  rootDir: ROOT_DIR,
  artifactsDir,
  tempRoot,
  requestedConnectionSlug,
  phases: {
    build: { status: "pending" },
    profile: { status: "pending" },
    launch: { status: "pending" },
    connection: { status: "pending" },
    chat: { status: "pending" },
    evidence: { status: "pending" },
  },
};

function makeRunId(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  return `${stamp}-${Math.random().toString(36).slice(2, 8)}`;
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

function writeJson(path: string, data: unknown): void {
  ensureDir(dirname(path));
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function appendJsonLine(path: string, data: JsonRecord): void {
  ensureDir(dirname(path));
  appendFileSync(path, `${JSON.stringify(data)}\n`, "utf8");
}

function updateSummary(patch: Partial<Summary>): void {
  summary = {
    ...summary,
    ...patch,
    phases: {
      ...summary.phases,
      ...(patch.phases ?? {}),
    },
  };
  writeJson(summaryPath, summary);
}

function updatePhase(name: keyof Summary["phases"], status: Summary["phases"][string]["status"], detail?: string): void {
  updateSummary({
    phases: {
      [name]: { status, ...(detail ? { detail } : {}) },
    },
  });
}

function runCommand(command: string, args: string[], phaseName: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT_DIR,
      env: process.env,
      stdio: "inherit",
      shell: false,
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
      } else {
        reject(new Error(`${phaseName} failed (code=${code ?? "null"} signal=${signal ?? "null"})`));
      }
    });
  });
}

async function ensureBuild(): Promise<void> {
  updatePhase("build", "running");

  if (process.env.CRAFT_E2E_SKIP_BUILD === "1") {
    ensureBuildOutputs();
    updatePhase("build", "passed", "Skipped via CRAFT_E2E_SKIP_BUILD=1");
    return;
  }

  await runCommand(process.execPath, ["run", "electron:build"], "electron:build");
  ensureBuildOutputs();
  updatePhase("build", "passed");
}

function ensureBuildOutputs(): void {
  const expected = [
    join(ELECTRON_APP_DIR, "dist", "main.cjs"),
    join(ELECTRON_APP_DIR, "dist", "bootstrap-preload.cjs"),
    join(ELECTRON_APP_DIR, "dist", "browser-toolbar-preload.cjs"),
    join(ELECTRON_APP_DIR, "dist", "renderer"),
  ];
  const missing = expected.filter((path) => !existsSync(path));
  if (missing.length > 0) {
    throw new Error(`Electron build output is missing: ${missing.join(", ")}`);
  }
}

function prepareProfile(): { craftConfigDir: string; piAgentDir: string; electronUserDataDir: string } {
  updatePhase("profile", "running");

  const sourceCraftConfig = process.env.CRAFT_CONFIG_DIR || join(homedir(), ".craft-agent");
  const sourcePiAgent = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  const craftConfigDir = join(tempRoot, "craft-config");
  const piAgentDir = join(tempRoot, "pi-agent");
  const electronUserDataDir = join(tempRoot, "electron-user-data");

  ensureDir(tempRoot);
  copyDirectoryIfExists(sourceCraftConfig, craftConfigDir);
  copyDirectoryIfExists(sourcePiAgent, piAgentDir);
  ensureDir(craftConfigDir);
  ensureDir(piAgentDir);
  ensureDir(electronUserDataDir);

  rmSync(join(craftConfigDir, "window-state.json"), { force: true });
  rmSync(join(craftConfigDir, ".server.lock"), { force: true });

  updatePhase("profile", "passed", `Craft: ${basename(craftConfigDir)}, Pi: ${basename(piAgentDir)}`);
  return { craftConfigDir, piAgentDir, electronUserDataDir };
}

function copyDirectoryIfExists(source: string, target: string): void {
  if (!existsSync(source)) return;
  cpSync(source, target, {
    recursive: true,
    force: true,
    // Windows often cannot recreate user-profile symlinks without elevated
    // privileges; copy the linked contents into the disposable profile instead.
    dereference: true,
  });
}

async function launchElectron(profile: { craftConfigDir: string; piAgentDir: string; electronUserDataDir: string }): Promise<DesktopLaunch> {
  updatePhase("launch", "running");

  // Playwright's Electron loader currently deadlocks with this app on Windows,
  // while the Node inspector path still drives the real Electron BrowserWindow.
  return await launchWithNodeInspector(profile);
}

function buildElectronEnv(profile: { craftConfigDir: string; piAgentDir: string }): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CRAFT_CONFIG_DIR: profile.craftConfigDir,
    PI_CODING_AGENT_DIR: profile.piAgentDir,
    CRAFT_APP_NAME: `Craft Agents E2E ${runId}`,
    CRAFT_DEEPLINK_SCHEME: `craftagentse2e${runId.replace(/[^a-z0-9]/gi, "")}`,
    PI_HOST_HOOKS_MODULE: PROVIDER_HOOK_PATH,
    CRAFT_E2E_PROVIDER_LOG_FILE: providerLogPath,
    CRAFT_E2E_RUN_ID: runId,
  };
}

async function launchWithPlaywrightElectron(profile: { craftConfigDir: string; piAgentDir: string; electronUserDataDir: string }): Promise<DesktopLaunch> {
  const app = await electron.launch({
    args: [`--user-data-dir=${profile.electronUserDataDir}`, ELECTRON_APP_DIR],
    cwd: ROOT_DIR,
    env: buildElectronEnv(profile),
    timeout: PLAYWRIGHT_ELECTRON_DRIVER_TIMEOUT_MS,
  });

  attachElectronProcessLog(app);

  const context = app.context();
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });

  const page = await app.firstWindow({ timeout: ELECTRON_LAUNCH_TIMEOUT_MS });
  attachPageLogs(page);
  app.on("window", attachPageLogs);

  await page.waitForLoadState("domcontentloaded", { timeout: 60_000 }).catch(() => undefined);
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window?.setBounds({ width: 1400, height: 900 });
    window?.show();
    window?.focus();
  });
  await page.waitForFunction(() => Boolean((window as any).electronAPI), undefined, { timeout: 60_000 });
  await page.screenshot({ path: join(artifactsDir, "01-after-launch.png"), fullPage: true });

  updatePhase("launch", "passed", "playwright-electron");
  return { mode: "playwright-electron", app, context, page };
}

async function launchWithCdp(profile: { craftConfigDir: string; piAgentDir: string; electronUserDataDir: string }): Promise<DesktopLaunch> {
  const electronExecutablePath = String(require("electron"));
  const child = spawn(electronExecutablePath, [
    "--remote-debugging-port=0",
    "--remote-allow-origins=*",
    `--user-data-dir=${profile.electronUserDataDir}`,
    ELECTRON_APP_DIR,
  ], {
    cwd: ROOT_DIR,
    env: buildElectronEnv(profile),
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });

  try {
    const wsEndpoint = await waitForDevToolsEndpoint(child);
    const browser = await chromium.connectOverCDP(devToolsHttpEndpoint(wsEndpoint), { timeout: CDP_CONNECT_TIMEOUT_MS });
    const context = browser.contexts()[0] ?? await browser.newContext();
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });

    for (const existingPage of context.pages()) {
      attachPageLogs(existingPage);
    }
    context.on("page", attachPageLogs);

    const page = await waitForRendererPage(context);
    await page.waitForLoadState("domcontentloaded", { timeout: 60_000 }).catch(() => undefined);
    await resizeRendererWindow(context, page);
    await page.waitForFunction(() => Boolean((window as any).electronAPI), undefined, { timeout: 60_000 });
    await page.screenshot({ path: join(artifactsDir, "01-after-launch.png"), fullPage: true });

    updatePhase("launch", "passed", "cdp-fallback");
    return { mode: "cdp", browser, context, child, page };
  } catch (error) {
    await killChildProcess(child);
    throw error;
  }
}

async function launchWithNodeInspector(profile: { craftConfigDir: string; piAgentDir: string; electronUserDataDir: string }): Promise<DesktopLaunch> {
  const electronExecutablePath = String(require("electron"));
  const child = spawn(electronExecutablePath, [
    "--inspect=0",
    `--user-data-dir=${profile.electronUserDataDir}`,
    ELECTRON_APP_DIR,
  ], {
    cwd: ROOT_DIR,
    env: buildElectronEnv(profile),
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });

  try {
    const inspectorEndpoint = await waitForNodeInspectorEndpoint(child);
    const inspector = await NodeInspectorClient.connect(inspectorEndpoint);
    await setupInspectorWindow(inspector);
    await captureInspectorScreenshot(inspector, "01-after-launch.png");
    updatePhase("launch", "passed", "node-inspector-fallback");
    return { mode: "node-inspector", inspector, child };
  } catch (error) {
    await killChildProcess(child);
    throw error;
  }
}

class NodeInspectorClient {
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();

  private constructor(private readonly ws: WebSocket) {
    this.ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: any; error?: { message?: string } };
      if (typeof message.id !== "number") return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
      } else {
        pending.resolve(message.result);
      }
    };
    this.ws.onerror = () => {
      this.rejectAll(new Error("Node inspector websocket error."));
    };
    this.ws.onclose = () => {
      this.rejectAll(new Error("Node inspector websocket closed."));
    };
  }

  static async connect(endpoint: string): Promise<NodeInspectorClient> {
    const ws = new WebSocket(endpoint);
    const client = await new Promise<NodeInspectorClient>((resolvePromise, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Timed out connecting to Node inspector: ${endpoint}`)), 30_000);
      ws.onopen = () => {
        clearTimeout(timeout);
        resolvePromise(new NodeInspectorClient(ws));
      };
      ws.onerror = () => {
        clearTimeout(timeout);
        reject(new Error(`Failed to connect to Node inspector: ${endpoint}`));
      };
    });
    await client.send("Runtime.enable", {});
    return client;
  }

  async evaluate<T>(expression: string): Promise<T> {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      includeCommandLineAPI: true,
    }) as { result?: { value?: T }; exceptionDetails?: { text?: string; exception?: { description?: string; value?: unknown } } };

    if (result.exceptionDetails) {
      const details = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? JSON.stringify(result.exceptionDetails);
      throw new Error(details);
    }

    return result.result?.value as T;
  }

  close(): void {
    this.ws.close();
    this.rejectAll(new Error("Node inspector closed."));
  }

  private send(method: string, params: JsonRecord): Promise<unknown> {
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolvePromise, reject) => {
      this.pending.set(id, { resolve: resolvePromise, reject });
      this.ws.send(payload);
    });
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function waitForNodeInspectorEndpoint(child: ChildProcessWithoutNullStreams): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    let buffered = "";
    let endpoint: string | undefined;
    let appReady = false;
    const timeout = setTimeout(() => {
      fail(new Error(`Timed out waiting for Node inspector endpoint and ready signal after ${ELECTRON_LAUNCH_TIMEOUT_MS}ms.`));
    }, ELECTRON_LAUNCH_TIMEOUT_MS);

    const maybeFinish = () => {
      if (settled) return;
      if (!endpoint || !appReady) return;
      settled = true;
      clearTimeout(timeout);
      resolvePromise(endpoint);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    };
    const onData = (chunk: Buffer) => {
      appendFileSync(electronProcessLogPath, chunk);
      buffered = `${buffered}${chunk.toString("utf8")}`.slice(-8192);
      const match = buffered.match(/Debugger listening on (ws:\/\/[^\s]+)/);
      if (match) endpoint = match[1];
      if (/App initialized successfully|Created window for first workspace/.test(buffered)) {
        appReady = true;
      }
      maybeFinish();
    };

    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("error", fail);
    child.once("exit", (code, signal) => {
      fail(new Error(`Electron exited before Node inspector was available (code=${code ?? "null"} signal=${signal ?? "null"}).`));
    });
  });
}

async function setupInspectorWindow(inspector: NodeInspectorClient): Promise<void> {
  await inspector.evaluate<boolean>(`(async () => {
    const { BrowserWindow } = require('electron');
    const fs = require('fs');
    const consoleLogPath = ${JSON.stringify(consoleLogPath)};
    const pageErrorLogPath = ${JSON.stringify(pageErrorLogPath)};
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) throw new Error('No BrowserWindow is available.');
    win.setBounds({ width: 1400, height: 900 });
    win.show();
    win.focus();
    win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
      fs.appendFileSync(consoleLogPath, JSON.stringify({
        timestamp: new Date().toISOString(),
        type: String(level),
        text: String(message),
        location: { url: sourceId, lineNumber: line },
      }) + '\\n');
    });
    win.webContents.on('render-process-gone', (_event, details) => {
      fs.appendFileSync(pageErrorLogPath, JSON.stringify({
        timestamp: new Date().toISOString(),
        name: 'render-process-gone',
        message: JSON.stringify(details),
      }) + '\\n');
    });
    await win.webContents.executeJavaScript('Boolean(window.electronAPI)', true);
    return true;
  })()`);
}

async function captureInspectorScreenshot(inspector: NodeInspectorClient, fileName: string): Promise<void> {
  await inspector.evaluate<boolean>(`(async () => {
    const { BrowserWindow } = require('electron');
    const fs = require('fs');
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return false;
    const image = await win.webContents.capturePage();
    fs.writeFileSync(${JSON.stringify(join(artifactsDir, fileName))}, image.toPNG());
    return true;
  })()`).catch(() => undefined);
}

async function evaluateInRenderer<T>(inspector: NodeInspectorClient, rendererSource: string): Promise<T> {
  return await inspector.evaluate<T>(`(async () => {
    const { BrowserWindow } = require('electron');
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) throw new Error('No BrowserWindow is available.');
    return await win.webContents.executeJavaScript(${JSON.stringify(rendererSource)}, true);
  })()`);
}

function devToolsHttpEndpoint(wsEndpoint: string): string {
  const url = new URL(wsEndpoint);
  return `http://${url.host}`;
}

function attachElectronProcessLog(app: ElectronApplication): void {
  const child = app.process();
  child.stdout?.on("data", (chunk) => appendFileSync(electronProcessLogPath, chunk));
  child.stderr?.on("data", (chunk) => appendFileSync(electronProcessLogPath, chunk));
}

function waitForDevToolsEndpoint(child: ChildProcessWithoutNullStreams): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    let buffered = "";
    let endpoint: string | undefined;
    let appReady = false;
    const timeout = setTimeout(() => {
      fail(new Error(`Timed out waiting for Electron DevTools endpoint and ready signal after ${ELECTRON_LAUNCH_TIMEOUT_MS}ms.`));
    }, ELECTRON_LAUNCH_TIMEOUT_MS);

    const maybeFinish = () => {
      if (settled) return;
      if (!endpoint || !appReady) return;
      settled = true;
      clearTimeout(timeout);
      resolvePromise(endpoint);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    };
    const onData = (chunk: Buffer) => {
      appendFileSync(electronProcessLogPath, chunk);
      buffered = `${buffered}${chunk.toString("utf8")}`.slice(-4096);
      const match = buffered.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) endpoint = match[1];
      if (/App initialized successfully|Created window for first workspace/.test(buffered)) {
        appReady = true;
      }
      maybeFinish();
    };

    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("error", fail);
    child.once("exit", (code, signal) => {
      fail(new Error(`Electron exited before DevTools endpoint was available (code=${code ?? "null"} signal=${signal ?? "null"}).`));
    });
  });
}

async function waitForRendererPage(context: BrowserContext): Promise<Page> {
  const deadline = Date.now() + ELECTRON_LAUNCH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const existing = context.pages().find((candidate) => !candidate.isClosed());
    if (existing) return existing;

    const remaining = Math.max(1, Math.min(1_000, deadline - Date.now()));
    const nextPage = await context.waitForEvent("page", { timeout: remaining }).catch(() => undefined);
    if (nextPage && !nextPage.isClosed()) return nextPage;
  }

  throw new Error(`No Electron renderer page appeared after ${ELECTRON_LAUNCH_TIMEOUT_MS}ms.`);
}

async function resizeRendererWindow(context: BrowserContext, page: Page): Promise<void> {
  await page.bringToFront().catch(() => undefined);
  await page.setViewportSize({ width: 1400, height: 900 }).catch(() => undefined);

  const session = await context.newCDPSession(page).catch(() => undefined);
  if (!session) return;

  try {
    const { windowId } = await session.send("Browser.getWindowForTarget");
    await session.send("Browser.setWindowBounds", {
      windowId,
      bounds: { width: 1400, height: 900, windowState: "normal" },
    });
  } catch {
    // Best-effort only: UI locators do not depend on a specific window size.
  } finally {
    await session.detach().catch(() => undefined);
  }
}

function attachPageLogs(page: Page): void {
  page.on("console", (message) => {
    appendJsonLine(consoleLogPath, {
      timestamp: new Date().toISOString(),
      type: message.type(),
      text: message.text(),
      location: message.location(),
    });
  });
  page.on("pageerror", (error) => {
    appendJsonLine(pageErrorLogPath, {
      timestamp: new Date().toISOString(),
      name: error.name,
      message: error.message,
      stack: error.stack,
    });
  });
}

async function chooseAndPreflightConnection(page: Page): Promise<LlmConnectionWithStatus> {
  updatePhase("connection", "running");

  const connections = await page.evaluate(async () => {
    return await (window as any).electronAPI.listLlmConnectionsWithStatus();
  }) as LlmConnectionWithStatus[];

  if (!Array.isArray(connections) || connections.length === 0) {
    throw new Error("No LLM connections are configured in the cloned profile.");
  }

  const selected = selectConnection(connections);
  updateSummary({
    selectedConnection: {
      slug: selected.slug,
      name: selected.name,
      defaultModel: selected.defaultModel,
    },
  });

  const setGlobal = await page.evaluate(async (slug) => {
    return await (window as any).electronAPI.setDefaultLlmConnection(slug);
  }, selected.slug) as { success: boolean; error?: string };

  if (!setGlobal?.success) {
    throw new Error(`Failed to set global default connection "${selected.slug}": ${setGlobal?.error ?? "unknown error"}`);
  }

  const workspaceId = await page.evaluate(async () => {
    return await (window as any).electronAPI.getWindowWorkspace();
  }) as string | null;

  if (workspaceId) {
    const setWorkspace = await page.evaluate(async ({ workspaceId, slug }) => {
      return await (window as any).electronAPI.setWorkspaceDefaultLlmConnection(workspaceId, slug);
    }, { workspaceId, slug: selected.slug }) as { success: boolean; error?: string };

    if (!setWorkspace?.success) {
      throw new Error(`Failed to set workspace default connection "${selected.slug}": ${setWorkspace?.error ?? "unknown error"}`);
    }
  }

  const preflight = await page.evaluate(async (slug) => {
    return await (window as any).electronAPI.testLlmConnection(slug);
  }, selected.slug) as { success: boolean; error?: string };

  if (!preflight?.success) {
    throw new Error(`Connection preflight failed for "${selected.slug}": ${preflight?.error ?? "unknown error"}`);
  }

  updatePhase("connection", "passed", selected.slug);
  return selected;
}

function selectConnection(connections: LlmConnectionWithStatus[]): LlmConnectionWithStatus {
  if (requestedConnectionSlug) {
    const requested = connections.find((connection) => connection.slug === requestedConnectionSlug);
    if (!requested) {
      throw new Error(`CRAFT_E2E_CONNECTION_SLUG "${requestedConnectionSlug}" was not found.`);
    }
    if (!requested.isAuthenticated) {
      throw new Error(`CRAFT_E2E_CONNECTION_SLUG "${requestedConnectionSlug}" is not authenticated.`);
    }
    return requested;
  }

  const selected =
    connections.find((connection) => connection.isDefault && connection.isAuthenticated) ??
    connections.find((connection) => connection.isAuthenticated);

  if (!selected) {
    const slugs = connections.map((connection) => connection.slug).join(", ");
    throw new Error(`No authenticated LLM connection is available. Configured connections: ${slugs || "(none)"}`);
  }

  return selected;
}

async function chooseAndPreflightConnectionWithInspector(inspector: NodeInspectorClient): Promise<LlmConnectionWithStatus> {
  updatePhase("connection", "running");

  const selected = await evaluateInRenderer<LlmConnectionWithStatus>(inspector, `(
    async () => {
      const api = window.electronAPI;
      if (!api) throw new Error('window.electronAPI is not available.');
      const requestedConnectionSlug = ${JSON.stringify(requestedConnectionSlug ?? null)};
      const connections = await api.listLlmConnectionsWithStatus();
      if (!Array.isArray(connections) || connections.length === 0) {
        throw new Error('No LLM connections are configured in the cloned profile.');
      }

      function selectConnection() {
        if (requestedConnectionSlug) {
          const requested = connections.find((connection) => connection.slug === requestedConnectionSlug);
          if (!requested) throw new Error('CRAFT_E2E_CONNECTION_SLUG "' + requestedConnectionSlug + '" was not found.');
          if (!requested.isAuthenticated) throw new Error('CRAFT_E2E_CONNECTION_SLUG "' + requestedConnectionSlug + '" is not authenticated.');
          return requested;
        }
        const selected = connections.find((connection) => connection.isDefault && connection.isAuthenticated)
          ?? connections.find((connection) => connection.isAuthenticated);
        if (!selected) {
          const slugs = connections.map((connection) => connection.slug).join(', ');
          throw new Error('No authenticated LLM connection is available. Configured connections: ' + (slugs || '(none)'));
        }
        return selected;
      }

      const selected = selectConnection();
      const setGlobal = await api.setDefaultLlmConnection(selected.slug);
      if (!setGlobal?.success) {
        throw new Error('Failed to set global default connection "' + selected.slug + '": ' + (setGlobal?.error ?? 'unknown error'));
      }

      const workspaceId = await api.getWindowWorkspace();
      if (workspaceId) {
        const setWorkspace = await api.setWorkspaceDefaultLlmConnection(workspaceId, selected.slug);
        if (!setWorkspace?.success) {
          throw new Error('Failed to set workspace default connection "' + selected.slug + '": ' + (setWorkspace?.error ?? 'unknown error'));
        }
      }

      const preflight = await api.testLlmConnection(selected.slug);
      if (!preflight?.success) {
        throw new Error('Connection preflight failed for "' + selected.slug + '": ' + (preflight?.error ?? 'unknown error'));
      }

      return {
        slug: selected.slug,
        name: selected.name,
        defaultModel: selected.defaultModel,
        isAuthenticated: selected.isAuthenticated,
        isDefault: selected.isDefault,
      };
    }
  )()`);

  updateSummary({
    selectedConnection: {
      slug: selected.slug,
      name: selected.name,
      defaultModel: selected.defaultModel,
    },
  });
  updatePhase("connection", "passed", selected.slug);
  return selected;
}

async function runChatFlow(page: Page): Promise<InspectorChatResult> {
  updatePhase("chat", "running");

  const sentinel = `CRAFT_E2E_${runId.replace(/[^A-Z0-9]/gi, "_").toUpperCase()}`;
  const prompt = `Reply with exactly this token and no extra text: ${sentinel}`;
  const result = await page.evaluate(rendererChatFlow, { sentinel, prompt, chatTimeoutMs: CHAT_TIMEOUT_MS });

  await page.screenshot({ path: join(artifactsDir, "02-new-chat.png"), fullPage: true });
  await page.screenshot({ path: join(artifactsDir, "03-after-reply.png"), fullPage: true });

  updateSummary({ chatPhaseStartMs: result.chatPhaseStartMs });
  updatePhase("chat", "passed", sentinel);
  return result;
}

async function runChatFlowWithInspector(inspector: NodeInspectorClient): Promise<InspectorChatResult> {
  updatePhase("chat", "running");

  const sentinel = `CRAFT_E2E_${runId.replace(/[^A-Z0-9]/gi, "_").toUpperCase()}`;
  const prompt = `Reply with exactly this token and no extra text: ${sentinel}`;

  const result = await evaluateInRenderer<InspectorChatResult>(inspector, `(
    ${rendererChatFlow.toString()}
  )(${JSON.stringify({ sentinel, prompt, chatTimeoutMs: CHAT_TIMEOUT_MS })})`);

  updateSummary({ chatPhaseStartMs: result.chatPhaseStartMs });
  await captureInspectorScreenshot(inspector, "02-new-chat.png");
  await captureInspectorScreenshot(inspector, "03-after-reply.png");
  updatePhase("chat", "passed", sentinel);
  return result;
}

async function rendererChatFlow(args: { sentinel: string; prompt: string; chatTimeoutMs: number }): Promise<InspectorChatResult> {
  const { sentinel, prompt, chatTimeoutMs } = args;
  const chatSessionAttr = "data-e2e-chat-session-id";

  function waitFor<T>(
    producer: () => T | false | null | undefined | Promise<T | false | null | undefined>,
    timeoutMs: number,
    label: string,
  ): Promise<T> {
    const startedAt = Date.now();
    return new Promise((resolvePromise, reject) => {
      const tick = async () => {
        let value: T | false | null | undefined;
        try {
          value = await producer();
        } catch {
          value = undefined;
        }

        if (value) {
          resolvePromise(value);
          return;
        }

        if (Date.now() - startedAt > timeoutMs) {
          reject(new Error(`Timed out waiting for ${label} after ${timeoutMs}ms.`));
          return;
        }

        setTimeout(tick, 100);
      };

      tick();
    });
  }

  function isVisible(element: Element): boolean {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < window.innerHeight &&
      rect.left < window.innerWidth &&
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.opacity !== "0"
    );
  }

  function visibleElements<T extends Element>(selector: string, root: ParentNode = document): T[] {
    return Array.from(root.querySelectorAll(selector)).filter(isVisible) as T[];
  }

  function attrSelector(name: string, value: string): string {
    return `[${name}="${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`;
  }

  function chatRootSelector(sessionId: string): string {
    return attrSelector(chatSessionAttr, sessionId);
  }

  function visibleChatRoots(sessionId: string): HTMLElement[] {
    return visibleElements<HTMLElement>(chatRootSelector(sessionId));
  }

  function visibleElementIn<T extends Element>(root: ParentNode, selector: string): T | null {
    return visibleElements<T>(selector, root)[0] ?? null;
  }

  function chatRootWithInput(sessionId: string): HTMLElement | null {
    return visibleChatRoots(sessionId).find((root) => visibleElementIn(root, '[data-tutorial="chat-input"]')) ?? null;
  }

  function currentChatRoot(sessionId: string): HTMLElement | null {
    return chatRootWithInput(sessionId) ?? visibleChatRoots(sessionId)[0] ?? null;
  }

  function getSelectedSessionId(): string | null {
    return document
      .querySelector('.session-item[data-selected="true"][data-session-id]')
      ?.getAttribute("data-session-id") ?? null;
  }

  function getSessionIdForElement(element: Element): string | null {
    return element.closest(`[${chatSessionAttr}]`)?.getAttribute(chatSessionAttr) ?? null;
  }

  function sessionIdsFromDom(): string[] {
    const ids = new Set<string>();
    for (const element of Array.from(document.querySelectorAll("[data-session-id]"))) {
      const id = element.getAttribute("data-session-id");
      if (id) ids.add(id);
    }
    for (const element of Array.from(document.querySelectorAll(`[${chatSessionAttr}]`))) {
      const id = element.getAttribute(chatSessionAttr);
      if (id) ids.add(id);
    }
    return Array.from(ids);
  }

  async function sessionIdsFromApi(): Promise<string[]> {
    const api = (window as any).electronAPI;
    if (!api?.getSessions) return [];
    const sessions = await api.getSessions().catch(() => []);
    if (!Array.isArray(sessions)) return [];
    return sessions
      .map((session: { id?: unknown }) => typeof session?.id === "string" ? session.id : undefined)
      .filter((id: string | undefined): id is string => Boolean(id));
  }

  function clickElement(element: Element): void {
    if (typeof PointerEvent !== "undefined") {
      element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    }
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    if (typeof PointerEvent !== "undefined") {
      element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    }
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    (element as HTMLElement).click();
  }

  function dispatchTextInput(element: HTMLElement, value: string): void {
    element.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: value,
    }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function setInputText(element: HTMLElement, value: string): void {
    element.focus();

    if (element.isContentEditable) {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(element);
      selection?.removeAllRanges();
      selection?.addRange(range);

      const inserted = document.execCommand?.("insertText", false, value);
      if (!inserted) {
        element.textContent = value;
      }
      dispatchTextInput(element, value);
      return;
    }

    if ("value" in element) {
      const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value");
      if (descriptor?.set) descriptor.set.call(element, value);
      else (element as HTMLInputElement | HTMLTextAreaElement).value = value;
      dispatchTextInput(element, value);
      return;
    }

    element.textContent = value;
    dispatchTextInput(element, value);
  }

  function sentinelCount(sessionId: string): number {
    const root = currentChatRoot(sessionId);
    const text = root?.innerText ?? "";
    return text.split(sentinel).length - 1;
  }

  const beforeSessionIds = new Set([...sessionIdsFromDom(), ...await sessionIdsFromApi()]);
  const newChatButton = await waitFor(
    () => visibleElements<HTMLElement>('[data-tutorial="new-chat-button"]')[0],
    60_000,
    "visible new chat button",
  );
  clickElement(newChatButton);

  let lastApiPollMs = 0;
  let apiSessionIds: string[] = [];

  const sessionId = await waitFor(async () => {
    const domCreated = sessionIdsFromDom().find((id) => !beforeSessionIds.has(id));
    if (domCreated) return domCreated;

    if (Date.now() - lastApiPollMs > 1_000) {
      lastApiPollMs = Date.now();
      apiSessionIds = await sessionIdsFromApi();
    }

    return apiSessionIds.find((id) => !beforeSessionIds.has(id)) ?? null;
  }, 60_000, "created session id after clicking new chat");

  try {
    const root = await waitFor(() => chatRootWithInput(sessionId), 60_000, `chat input for created session ${sessionId}`);
    const input = visibleElementIn<HTMLElement>(root, '[data-tutorial="chat-input"]');
    if (!input) {
      throw new Error(`Created session ${sessionId} is visible, but no chat input was found inside its panel.`);
    }

    setInputText(input, prompt);

    const sendButton = await waitFor(() => {
      const currentRoot = chatRootWithInput(sessionId);
      const button = currentRoot ? visibleElementIn<HTMLButtonElement>(currentRoot, '[data-tutorial="send-button"]') : null;
      return button && !button.disabled ? button : null;
    }, 15_000, `enabled send button for created session ${sessionId}`);

    const inputSessionIdBeforeSend = getSessionIdForElement(input);
    const activeSessionIdBeforeSend = getSessionIdForElement(sendButton);
    const selectedSessionIdBeforeSend = getSelectedSessionId();

    if (inputSessionIdBeforeSend !== sessionId || activeSessionIdBeforeSend !== sessionId) {
      throw new Error(
        `UI session mismatch before send: created=${sessionId}, input=${inputSessionIdBeforeSend ?? "(none)"}, sendButton=${activeSessionIdBeforeSend ?? "(none)"}`,
      );
    }

    if (selectedSessionIdBeforeSend && selectedSessionIdBeforeSend !== sessionId) {
      throw new Error(
        `Selected session mismatch before send: created=${sessionId}, selected=${selectedSessionIdBeforeSend}`,
      );
    }

    const chatPhaseStartMs = Date.now();
    clickElement(sendButton);

    let sendButtonDisappeared = false;
    try {
      await waitFor(() => {
        const currentRoot = currentChatRoot(sessionId);
        return currentRoot && !visibleElementIn(currentRoot, '[data-tutorial="send-button"]');
      }, 15_000, `send button to switch to stop state for ${sessionId}`);
      sendButtonDisappeared = true;
    } catch {
      sendButtonDisappeared = false;
    }

    await waitFor(() => sentinelCount(sessionId) >= 2, chatTimeoutMs, `assistant sentinel reply in session ${sessionId}`);
    await waitFor(() => {
      const currentRoot = currentChatRoot(sessionId);
      return currentRoot ? visibleElementIn(currentRoot, '[data-tutorial="send-button"]') : null;
    }, 60_000, `send button after reply for ${sessionId}`);

    return {
      chatPhaseStartMs,
      visibleSentinelCount: sentinelCount(sessionId),
      sendButtonDisappeared,
      createdSessionId: sessionId,
      activeSessionIdBeforeSend,
      inputSessionIdBeforeSend,
      selectedSessionIdBeforeSend,
      activeSessionIdAfterReply: currentChatRoot(sessionId)?.getAttribute(chatSessionAttr) ?? "",
    };
  } finally {
    // Nothing to clean up: this flow discovers the new session by DOM/API diff.
  }
}

function assertProviderEvidence(chatResult: InspectorChatResult): void {
  updatePhase("evidence", "running");

  const {
    chatPhaseStartMs,
    visibleSentinelCount,
    sendButtonDisappeared,
    createdSessionId,
    activeSessionIdBeforeSend,
    inputSessionIdBeforeSend,
    selectedSessionIdBeforeSend,
    activeSessionIdAfterReply,
  } = chatResult;
  const events = readJsonl(providerLogPath)
    .filter((event) => typeof event.timestampMs === "number" && event.timestampMs >= chatPhaseStartMs);
  const providerRequestCount = events.filter((event) => event.event === "request").length;
  const providerSuccessResponseCount = events.filter((event) => event.event === "response" && event.ok === true).length;
  const providerErrorCount = events.filter((event) => event.event === "error").length;
  const fatalUiErrors = collectFatalUiErrors(chatPhaseStartMs);
  const backendSessionId = findBackendChatSessionId(chatPhaseStartMs);
  const sessionIdsMatched =
    createdSessionId === activeSessionIdBeforeSend &&
    createdSessionId === inputSessionIdBeforeSend &&
    createdSessionId === activeSessionIdAfterReply &&
    createdSessionId === backendSessionId &&
    (selectedSessionIdBeforeSend === null || createdSessionId === selectedSessionIdBeforeSend);

  updateSummary({
    evidence: {
      providerRequestCount,
      providerSuccessResponseCount,
      providerErrorCount,
      visibleSentinelCount,
      sendButtonDisappeared,
      createdSessionId,
      activeSessionIdBeforeSend,
      inputSessionIdBeforeSend,
      selectedSessionIdBeforeSend,
      activeSessionIdAfterReply,
      backendSessionId,
      sessionIdsMatched,
      fatalUiErrorCount: fatalUiErrors.count,
      fatalUiErrorKinds: fatalUiErrors.kinds,
    },
  });

  if (fatalUiErrors.count > 0) {
    throw new Error(`Fatal UI/RPC errors were recorded after chat started: ${fatalUiErrors.kinds.join(", ")}`);
  }
  if (providerRequestCount < 1) {
    throw new Error("No provider request was recorded after the chat phase started.");
  }
  if (providerSuccessResponseCount < 1) {
    throw new Error("No successful provider response was recorded after the chat phase started.");
  }
  if (visibleSentinelCount < 2) {
    throw new Error(`Sentinel was visible ${visibleSentinelCount} time(s), expected at least 2.`);
  }
  if (!backendSessionId) {
    throw new Error("No backend chat session id was found in logs after the chat phase started.");
  }
  if (!sessionIdsMatched) {
    throw new Error(
      `Chat session mismatch: created=${createdSessionId}, input=${inputSessionIdBeforeSend}, activeBefore=${activeSessionIdBeforeSend}, selected=${selectedSessionIdBeforeSend ?? "(none)"}, activeAfter=${activeSessionIdAfterReply}, backend=${backendSessionId}`,
    );
  }

  updatePhase("evidence", "passed");
}

function findBackendChatSessionId(sinceMs: number): string | undefined {
  for (const event of readJsonl(consoleLogPath)) {
    const timestampMs = parseTimestampMs(event.timestamp);
    if (timestampMs === undefined || timestampMs < sinceMs) continue;
    const match = String(event.text ?? event.message ?? "").match(/Starting chat for session:\s*([^\s]+)/i);
    if (match?.[1]) return match[1];
  }

  if (!existsSync(electronProcessLogPath)) return undefined;
  for (const line of readFileSync(electronProcessLogPath, "utf8").split(/\r?\n/)) {
    const timestampMs = parseTimestampMs(line);
    if (timestampMs === undefined || timestampMs < sinceMs) continue;
    const match = line.match(/Starting chat for session:\s*([^\s]+)/i);
    if (match?.[1]) return match[1];
  }

  return undefined;
}

function collectFatalUiErrors(sinceMs: number): { count: number; kinds: string[] } {
  const kinds: string[] = [];

  for (const event of readJsonl(consoleLogPath)) {
    const timestampMs = parseTimestampMs(event.timestamp);
    if (timestampMs === undefined || timestampMs < sinceMs) continue;
    collectFatalKinds(String(event.text ?? event.message ?? ""), kinds);
  }

  if (existsSync(electronProcessLogPath)) {
    for (const line of readFileSync(electronProcessLogPath, "utf8").split(/\r?\n/)) {
      const timestampMs = parseTimestampMs(line);
      if (timestampMs === undefined || timestampMs < sinceMs) continue;
      collectFatalKinds(line, kinds);
    }
  }

  return {
    count: kinds.length,
    kinds: Array.from(new Set(kinds)).sort(),
  };
}

function collectFatalKinds(message: string, kinds: string[]): void {
  for (const { kind, pattern } of FATAL_UI_LOG_PATTERNS) {
    if (pattern.test(message)) {
      kinds.push(kind);
    }
  }
}

function parseTimestampMs(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const match = value.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/);
  if (!match) return undefined;
  const timestampMs = Date.parse(match[0]);
  return Number.isFinite(timestampMs) ? timestampMs : undefined;
}

function readJsonl(path: string): JsonRecord[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as JsonRecord;
      } catch {
        return { event: "parse_error", rawLength: line.length };
      }
    });
}

async function stopTracing(desktop: DesktopLaunch | undefined): Promise<void> {
  if (!desktop?.context) return;
  try {
    await desktop.context.tracing.stop({ path: tracePath });
  } catch {
    // Trace capture is useful evidence, but should not mask the real failure.
  }
}

async function closeElectron(desktop: DesktopLaunch | undefined): Promise<void> {
  if (!desktop) return;

  try {
    if (desktop.app) {
      await desktop.app.close();
      return;
    }

    await desktop.browser?.close();
    desktop.inspector?.close();
  } catch {
    // Fall through to process cleanup below.
  }

  await killChildProcess(desktop.child);

  if (desktop.app) {
    try {
      desktop.app.process().kill();
    } catch {
      // Best-effort cleanup.
    }
  }
}

async function killChildProcess(child: ChildProcessWithoutNullStreams | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return;

  child.kill();
  await new Promise<void>((resolvePromise) => {
    const timeout = setTimeout(resolvePromise, 3_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolvePromise();
    });
  });
}

function cleanupTempProfile(): void {
  try {
    rmSync(tempRoot, { recursive: true, force: true });
    updateSummary({ tempProfileRemoved: true });
  } catch {
    updateSummary({ tempProfileRemoved: false });
  }
}

async function main(): Promise<void> {
  ensureDir(artifactsDir);
  writeJson(summaryPath, summary);

  let desktop: DesktopLaunch | undefined;
  let page: Page | undefined;

  try {
    await ensureBuild();
    const profile = prepareProfile();
    desktop = await launchElectron(profile);
    let chatResult: InspectorChatResult;
    if (desktop.mode === "node-inspector") {
      if (!desktop.inspector) throw new Error("Node inspector fallback did not return an inspector client.");
      await chooseAndPreflightConnectionWithInspector(desktop.inspector);
      chatResult = await runChatFlowWithInspector(desktop.inspector);
    } else {
      if (!desktop.page) throw new Error("Playwright launch did not return a page.");
      page = desktop.page;
      await chooseAndPreflightConnection(page);
      chatResult = await runChatFlow(page);
    }
    assertProviderEvidence(chatResult);

    updateSummary({
      status: "passed",
      endedAt: new Date().toISOString(),
    });
    process.exitCode = 0;
  } catch (error) {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    if (page) {
      await page.screenshot({ path: join(artifactsDir, "failure.png"), fullPage: true }).catch(() => undefined);
    } else if (desktop?.inspector) {
      await captureInspectorScreenshot(desktop.inspector, "failure.png").catch(() => undefined);
    }
    updateSummary({
      status: "failed",
      error: message,
      endedAt: new Date().toISOString(),
    });
    process.exitCode = 1;
  } finally {
    await stopTracing(desktop);
    await closeElectron(desktop);
    cleanupTempProfile();
    updateSummary({ endedAt: new Date().toISOString() });
  }
}

await main();

if (summary.status === "passed") {
  process.exit(0);
}
