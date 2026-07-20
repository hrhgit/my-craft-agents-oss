import { existsSync, readFileSync, statSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, normalize, resolve } from 'node:path';
import { loadStoredConfig, saveConfig } from './storage.ts';
import type {
  DeveloperKitConfigurationSource,
  DeveloperKitInstallation,
  DeveloperKitManifest,
  DeveloperKitStatus,
} from './types.ts';

const MANIFEST_NAME = 'developer-kit.json';
const EXPECTED_NAME = '@mortise/developer-kit';
const EXPECTED_APP_ID = 'io.github.hrhgit.mortise.devhost';
const SUPPORTED_SCHEMA_VERSION = 1;
const SUPPORTED_UI_VALIDATION_PROTOCOL_VERSION = 1;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

export interface DeveloperKitDiscoveryOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  productVersion?: string;
  extraCandidates?: string[];
}

export function validateDeveloperKit(
  selectedPath: string,
  options: Pick<DeveloperKitDiscoveryOptions, 'platform' | 'arch' | 'productVersion'> = {},
): DeveloperKitInstallation {
  const rootPath = resolveDeveloperKitRoot(selectedPath);
  const manifestPath = join(rootPath, MANIFEST_NAME);
  const cliName = options.platform === 'win32' || (options.platform ?? process.platform) === 'win32'
    ? 'mortise-ui.exe'
    : 'mortise-ui';
  const cliPath = join(rootPath, 'bin', cliName);
  const devHostPath = join(rootPath, 'dev-host');
  const developerHostExecutable = join(devHostPath, 'Mortise Developer Host.exe');

  if (!isFile(manifestPath)) throw new Error(`Missing ${MANIFEST_NAME}.`);
  if (!isFile(cliPath)) throw new Error(`Missing Developer Kit CLI at ${cliPath}.`);
  if (!isDirectory(devHostPath)) throw new Error(`Missing Developer Host at ${devHostPath}.`);
  if ((options.platform ?? process.platform) === 'win32' && !isFile(developerHostExecutable)) {
    throw new Error(`Missing Developer Host executable at ${developerHostExecutable}.`);
  }

  let manifest: DeveloperKitManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as DeveloperKitManifest;
  } catch {
    throw new Error(`${MANIFEST_NAME} is not valid JSON.`);
  }

  if (manifest.name !== EXPECTED_NAME) throw new Error(`Unexpected Developer Kit package name: ${String(manifest.name)}.`);
  if (manifest.appId !== EXPECTED_APP_ID) throw new Error(`Unexpected Developer Host app ID: ${String(manifest.appId)}.`);
  if (manifest.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    throw new Error(`Unsupported Developer Kit schema version: ${String(manifest.schemaVersion)}.`);
  }
  if (manifest.uiValidationProtocolVersion !== SUPPORTED_UI_VALIDATION_PROTOCOL_VERSION) {
    throw new Error(`Unsupported UI validation protocol version: ${String(manifest.uiValidationProtocolVersion)}.`);
  }
  if (!VERSION_PATTERN.test(manifest.version) || !VERSION_PATTERN.test(manifest.hostVersion)) {
    throw new Error('Developer Kit version metadata is invalid.');
  }
  const productVersion = options.productVersion
    ?? process.env.MORTISE_PRODUCT_VERSION
    ?? process.env.MORTISE_VERSION
    ?? process.env.npm_package_version;
  if (productVersion && manifest.hostVersion !== productVersion) {
    throw new Error(`Developer Kit Host version ${manifest.hostVersion} does not match Mortise ${productVersion}.`);
  }

  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  if (manifest.platform !== platform || manifest.arch !== arch) {
    throw new Error(`Developer Kit targets ${manifest.platform}-${manifest.arch}; this runtime is ${platform}-${arch}.`);
  }

  return { rootPath, cliPath, manifest };
}

export function getDeveloperKitStatus(): DeveloperKitStatus {
  const configured = loadStoredConfig()?.developerKit;
  if (!configured?.rootPath) return { state: 'not-configured' };

  try {
    return {
      state: 'ready',
      source: configured.source,
      configuredPath: configured.rootPath,
      installation: validateDeveloperKit(configured.rootPath),
    };
  } catch (error) {
    return {
      state: 'invalid',
      source: configured.source,
      configuredPath: configured.rootPath,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function setDeveloperKitPath(
  selectedPath: string | null,
  source: DeveloperKitConfigurationSource = 'manual',
): DeveloperKitStatus {
  const config = loadStoredConfig();
  if (!config) throw new Error('Mortise configuration is unavailable.');

  if (selectedPath === null) {
    delete config.developerKit;
    saveConfig(config);
    return { state: 'not-configured' };
  }

  const installation = validateDeveloperKit(selectedPath);
  config.developerKit = { rootPath: installation.rootPath, source };
  saveConfig(config);
  return {
    state: 'ready',
    source,
    configuredPath: installation.rootPath,
    installation,
  };
}

export function discoverAndConfigureDeveloperKit(options: DeveloperKitDiscoveryOptions = {}): DeveloperKitStatus {
  const current = getDeveloperKitStatus();
  if (current.state === 'ready') return current;

  const installation = discoverDeveloperKit(options);
  if (installation) return setDeveloperKitPath(installation.rootPath, 'automatic');

  return current.state === 'invalid' ? current : { state: 'not-configured' };
}

export function discoverDeveloperKit(options: DeveloperKitDiscoveryOptions = {}): DeveloperKitInstallation | undefined {
  for (const candidate of developerKitCandidates(options)) {
    try {
      return validateDeveloperKit(candidate, options);
    } catch {
      // Continue through bounded, explicit discovery locations.
    }
  }
  return undefined;
}

export function formatDeveloperKitSystemPrompt(status: DeveloperKitStatus = getDeveloperKitStatus()): string | undefined {
  if (status.state !== 'ready' || !status.installation) return undefined;
  const { rootPath, cliPath, manifest } = status.installation;
  return [
    '<mortise_developer_kit>',
    'A validated Mortise Developer Kit is configured globally for extension development and UI validation.',
    `Root: ${JSON.stringify(rootPath)}`,
    `CLI: ${JSON.stringify(cliPath)}`,
    `Kit version: ${manifest.version}`,
    `Developer Host version: ${manifest.hostVersion}`,
    'Invoke the CLI from any working directory. Mount an extension source directory with --extension <directory>; do not copy the Developer Kit into the project.',
    '</mortise_developer_kit>',
  ].join('\n');
}

export function developerKitCandidates(options: DeveloperKitDiscoveryOptions = {}): string[] {
  const env = options.env ?? process.env;
  const cwd = resolve(options.cwd ?? process.cwd());
  const candidates: string[] = [...(options.extraCandidates ?? [])];

  if (env.MORTISE_DEVELOPER_KIT_ROOT) candidates.push(env.MORTISE_DEVELOPER_KIT_ROOT);
  if (env.MORTISE_RESOURCES_PATH) candidates.push(join(env.MORTISE_RESOURCES_PATH, 'developer-kit'));

  for (const pathEntry of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    candidates.push(pathEntry);
  }

  let current = cwd;
  for (let depth = 0; depth < 6; depth += 1) {
    const latestPath = join(current, 'output', 'developer-kit-latest.json');
    if (isFile(latestPath)) {
      try {
        const latest = JSON.parse(readFileSync(latestPath, 'utf8')) as { artifactDirectory?: unknown };
        if (typeof latest.artifactDirectory === 'string') candidates.push(latest.artifactDirectory);
      } catch {
        // A malformed source-build pointer is ignored; validation reports only concrete candidates.
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  if (env.LOCALAPPDATA) candidates.push(join(env.LOCALAPPDATA, 'Mortise', 'Developer Kit', 'current'));
  if (env.USERPROFILE) candidates.push(join(env.USERPROFILE, '.mortise', 'developer-kit'));

  const seen = new Set<string>();
  return candidates
    .map(candidate => normalize(candidate.trim()))
    .filter(candidate => {
      if (!candidate || seen.has(candidate.toLowerCase())) return false;
      seen.add(candidate.toLowerCase());
      return true;
    });
}

function resolveDeveloperKitRoot(selectedPath: string): string {
  const trimmed = selectedPath.trim();
  if (!trimmed) throw new Error('Developer Kit path is required.');
  const absolutePath = isAbsolute(trimmed) ? normalize(trimmed) : resolve(trimmed);
  const lowerName = absolutePath.toLowerCase();
  if (lowerName.endsWith(`\\${MANIFEST_NAME}`) || lowerName.endsWith(`/${MANIFEST_NAME}`)) return dirname(absolutePath);
  if (lowerName.endsWith('mortise-ui.exe') || lowerName.endsWith('/mortise-ui')) return dirname(dirname(absolutePath));
  if (isFile(join(absolutePath, 'mortise-ui.exe')) || isFile(join(absolutePath, 'mortise-ui'))) return dirname(absolutePath);
  return absolutePath;
}

function isFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}
