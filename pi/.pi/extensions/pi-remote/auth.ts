import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

interface RemoteConfig {
	host: string;
	port: number;
	tokenHash: string;
}

export interface LoadedAuthConfig {
	path: string;
	host: string;
	port: number;
	token?: string;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;

function hashToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

function readConfig(path: string): RemoteConfig | undefined {
	if (!existsSync(path)) return undefined;
	const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<RemoteConfig>;
	if (typeof parsed.tokenHash !== "string" || !parsed.tokenHash) return undefined;
	return {
		host: typeof parsed.host === "string" && parsed.host ? parsed.host : DEFAULT_HOST,
		port: typeof parsed.port === "number" && Number.isInteger(parsed.port) ? parsed.port : DEFAULT_PORT,
		tokenHash: parsed.tokenHash,
	};
}

function writeConfig(path: string, config: RemoteConfig): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(config, null, "\t")}\n`, { mode: 0o600 });
}

export class RemoteAuth {
	private config: RemoteConfig;

	private constructor(
		private readonly path: string,
		config: RemoteConfig,
	) {
		this.config = config;
	}

	static load(baseDir: string): LoadedAuthConfig & { auth: RemoteAuth } {
		const path = join(baseDir, ".remote.local.json");
		const existing = readConfig(path);
		if (existing) {
			return { auth: new RemoteAuth(path, existing), path, host: existing.host, port: existing.port };
		}

		const token = randomBytes(24).toString("base64url");
		const config = { host: DEFAULT_HOST, port: DEFAULT_PORT, tokenHash: hashToken(token) };
		writeConfig(path, config);
		return { auth: new RemoteAuth(path, config), path, host: config.host, port: config.port, token };
	}

	verify(token: string): boolean {
		const actual = Buffer.from(hashToken(token), "hex");
		const expected = Buffer.from(this.config.tokenHash, "hex");
		if (actual.length !== expected.length) return false;
		return timingSafeEqual(actual, expected);
	}

	rotate(): string {
		const token = randomBytes(24).toString("base64url");
		this.config = { ...this.config, tokenHash: hashToken(token) };
		writeConfig(this.path, this.config);
		return token;
	}

	setEndpoint(host: string, port: number): void {
		this.config = { ...this.config, host, port };
		writeConfig(this.path, this.config);
	}

	get host(): string {
		return this.config.host;
	}

	get port(): number {
		return this.config.port;
	}
}
