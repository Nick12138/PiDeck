import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parse } from "yaml";

export const PI_SDK_PACKAGES = Object.freeze([
  "@earendil-works/pi-ai",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
]);

const DIRECT_PI_SDK_PACKAGES = Object.freeze([
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
]);
const SDK_PACKAGE = "@earendil-works/pi-coding-agent";
const AGENT_CORE_PACKAGE = "@earendil-works/pi-agent-core";
const HOST_MANIFEST_PATH = "packages/pi-host/package.json";
const ROOT_MANIFEST_PATH = "package.json";
const DEFAULT_LOCK_PATH = "pnpm-lock.yaml";

function fail(message) {
  throw new Error(`[release-sdk-evidence] ${message}`);
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function exactVersion(value, label) {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value)) {
    fail(`${label} must be an exact package version, got ${String(value)}`);
  }
  return value;
}

function lockVersion(value) {
  if (typeof value !== "string") return null;
  const peerSuffix = value.indexOf("(");
  return peerSuffix === -1 ? value : value.slice(0, peerSuffix);
}

function sortedRecord(record) {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

function assertRecord(actual, expected, label) {
  if (!isDeepStrictEqual(sortedRecord(actual ?? {}), sortedRecord(expected ?? {}))) {
    fail(
      `${label} mismatch\n  expected ${JSON.stringify(sortedRecord(expected ?? {}))}\n  got      ${JSON.stringify(sortedRecord(actual ?? {}))}`,
    );
  }
}

function resolveInside(root, relativePath, label) {
  const resolved = resolve(root, relativePath);
  const rel = relative(root, resolved);
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..")) return resolved;
  fail(`${label} must stay inside the repository: ${relativePath}`);
}

function findAgentCoreVersion(lock, sdkVersion, patchHash) {
  const prefix = `${SDK_PACKAGE}@${sdkVersion}`;
  const versions = new Set();
  for (const [key, snapshot] of Object.entries(lock.snapshots ?? {})) {
    if (key !== prefix && !key.startsWith(`${prefix}(`)) continue;
    if (!key.includes(`patch_hash=${patchHash}`)) continue;
    const version = lockVersion(snapshot?.dependencies?.[AGENT_CORE_PACKAGE]);
    if (version) versions.add(version);
  }
  if (versions.size !== 1) {
    fail(
      `pnpm lock must resolve exactly one ${AGENT_CORE_PACKAGE} version from patched ${SDK_PACKAGE}@${sdkVersion}, got ${JSON.stringify([...versions])}`,
    );
  }
  return [...versions][0];
}

function assertLockPackage(lock, packageName, version) {
  const prefix = `${packageName}@${version}`;
  const found = Object.keys(lock.packages ?? {}).some(
    (key) => key === prefix || key.startsWith(`${prefix}(`),
  );
  if (!found) fail(`pnpm lock does not contain ${packageName}@${version}`);
}

export function loadReleaseSdkEvidence(root, runtimeLockOverride) {
  const hostManifest = readJson(join(root, HOST_MANIFEST_PATH), "Host manifest");
  const rootManifest = readJson(join(root, ROOT_MANIFEST_PATH), "root manifest");
  const runtimeLock =
    runtimeLockOverride ??
    readJson(join(root, "scripts/release-runtime.lock.json"), "release runtime lock");
  if (runtimeLock.schemaVersion !== 3) {
    fail(`release runtime lock schemaVersion must be 3, got ${runtimeLock.schemaVersion}`);
  }
  if (Object.hasOwn(runtimeLock, "sdk")) {
    fail("release runtime lock must not duplicate the Host manifest SDK version");
  }
  const productionDependencies = hostManifest.dependencies;
  if (!productionDependencies || typeof productionDependencies !== "object") {
    fail("Host manifest must declare production dependencies");
  }

  const sdkVersion = exactVersion(
    productionDependencies[SDK_PACKAGE],
    `${HOST_MANIFEST_PATH} dependency ${SDK_PACKAGE}`,
  );
  for (const packageName of DIRECT_PI_SDK_PACKAGES) {
    const version = exactVersion(
      productionDependencies[packageName],
      `${HOST_MANIFEST_PATH} dependency ${packageName}`,
    );
    if (version !== sdkVersion) {
      fail(`${packageName}@${version} must match canonical ${SDK_PACKAGE}@${sdkVersion}`);
    }
  }

  const lockRelativePath = runtimeLock.pnpmLock?.path ?? DEFAULT_LOCK_PATH;
  if (lockRelativePath !== DEFAULT_LOCK_PATH) {
    fail(`release runtime lock pnpmLock.path must be ${DEFAULT_LOCK_PATH}`);
  }
  const lockPath = resolveInside(root, lockRelativePath, "pnpm lock path");
  const lockText = readFileSync(lockPath, "utf8");
  const lock = parse(lockText);
  const importerDependencies = lock.importers?.["packages/pi-host"]?.dependencies;
  if (!importerDependencies) fail("pnpm lock is missing packages/pi-host dependencies");

  assertRecord(
    Object.fromEntries(
      Object.entries(importerDependencies).map(([name, entry]) => [name, entry?.specifier]),
    ),
    productionDependencies,
    "Host manifest and pnpm-lock importer dependencies",
  );
  for (const [name, specifier] of Object.entries(productionDependencies)) {
    const resolvedVersion = importerDependencies[name]?.version;
    if (String(specifier).startsWith("workspace:")) {
      if (typeof resolvedVersion !== "string" || !resolvedVersion.startsWith("link:")) {
        fail(`pnpm lock must resolve workspace dependency ${name} to a link, got ${resolvedVersion}`);
      }
    } else if (lockVersion(resolvedVersion) !== specifier) {
      fail(`pnpm lock resolves ${name} to ${resolvedVersion}, expected ${specifier}`);
    }
  }

  const patchKey = `${SDK_PACKAGE}@${sdkVersion}`;
  const patchRelativePath = rootManifest.pnpm?.patchedDependencies?.[patchKey];
  if (typeof patchRelativePath !== "string" || patchRelativePath.length === 0) {
    fail(`root manifest must patch ${patchKey}`);
  }
  const lockPatch = lock.patchedDependencies?.[patchKey];
  if (!lockPatch || lockPatch.path !== patchRelativePath || typeof lockPatch.hash !== "string") {
    fail(`pnpm lock patch binding for ${patchKey} does not match the root manifest`);
  }
  const patchPath = resolveInside(root, patchRelativePath, "SDK patch path");
  if (!existsSync(patchPath)) fail(`SDK patch is missing: ${patchRelativePath}`);
  const sdkPatchSha256 = sha256File(patchPath);
  if (runtimeLock.hostProductionDeps?.sdkPatchSha256 !== sdkPatchSha256) {
    fail(
      `SDK patch SHA-256 mismatch\n  expected ${runtimeLock.hostProductionDeps?.sdkPatchSha256 ?? "missing"}\n  got      ${sdkPatchSha256}`,
    );
  }

  const agentCoreVersion = exactVersion(
    findAgentCoreVersion(lock, sdkVersion, lockPatch.hash),
    `${AGENT_CORE_PACKAGE} lock version`,
  );
  const packages = {
    "@earendil-works/pi-ai": sdkVersion,
    "@earendil-works/pi-agent-core": agentCoreVersion,
    "@earendil-works/pi-coding-agent": sdkVersion,
    "@earendil-works/pi-tui": sdkVersion,
  };
  for (const [packageName, version] of Object.entries(packages)) {
    if (version !== sdkVersion) {
      fail(`${packageName}@${version} must match canonical SDK version ${sdkVersion}`);
    }
    assertLockPackage(lock, packageName, version);
  }

  const pnpmLockSha256 = sha256File(lockPath);
  if (runtimeLock.pnpmLock?.sha256 !== pnpmLockSha256) {
    fail(
      `pnpm-lock.yaml SHA-256 mismatch\n  expected ${runtimeLock.pnpmLock?.sha256 ?? "missing"}\n  got      ${pnpmLockSha256}`,
    );
  }
  if (runtimeLock.hostProductionDeps?.manifest !== HOST_MANIFEST_PATH) {
    fail(`release runtime lock must point hostProductionDeps.manifest to ${HOST_MANIFEST_PATH}`);
  }

  return {
    schemaVersion: 1,
    sdkPackage: SDK_PACKAGE,
    sdkVersion,
    hostManifest: {
      path: HOST_MANIFEST_PATH,
      name: hostManifest.name,
      version: hostManifest.version,
      productionDependencies: { ...productionDependencies },
    },
    packages,
    patch: {
      package: SDK_PACKAGE,
      version: sdkVersion,
      path: patchRelativePath,
      sha256: sdkPatchSha256,
      pnpmPatchHash: lockPatch.hash,
    },
    pnpmLock: {
      path: lockRelativePath,
      sha256: pnpmLockSha256,
    },
  };
}

export function assertReleaseSdkEvidence(actual, expected, label = "SDK evidence") {
  if (!isDeepStrictEqual(actual, expected)) {
    fail(
      `${label} mismatch\n  expected ${JSON.stringify(expected)}\n  got      ${JSON.stringify(actual)}`,
    );
  }
}

function packageManifestPath(nodeModulesRoot, packageName) {
  return join(nodeModulesRoot, ...packageName.split("/"), "package.json");
}

function readPackageManifest(path, packageName, label) {
  if (!existsSync(path)) return null;
  const manifest = readJson(path, `${label} ${packageName} manifest`);
  if (manifest.name !== packageName) {
    fail(`${label} expected ${packageName} at ${path}, got ${manifest.name ?? "missing name"}`);
  }
  return { manifest, manifestPath: path };
}

export function assertPiPackageTree(hostRoot, expected, label = "package tree") {
  const versions = {};
  const topLevelNodeModules = join(hostRoot, "node_modules");
  const codingAgent = readPackageManifest(
    packageManifestPath(topLevelNodeModules, SDK_PACKAGE),
    SDK_PACKAGE,
    label,
  );
  if (!codingAgent) fail(`${label} is missing ${SDK_PACKAGE}`);
  const codingAgentRealRoot = realpathSync(dirname(codingAgent.manifestPath));
  const pnpmDependencyRoot = dirname(dirname(codingAgentRealRoot));
  for (const packageName of PI_SDK_PACKAGES) {
    const topLevelPath = packageManifestPath(topLevelNodeModules, packageName);
    const pnpmDependencyPath = packageManifestPath(pnpmDependencyRoot, packageName);
    const resolved =
      readPackageManifest(topLevelPath, packageName, label) ??
      readPackageManifest(pnpmDependencyPath, packageName, label);
    if (!resolved) fail(`${label} is missing ${packageName}`);
    const { manifest } = resolved;
    versions[packageName] = manifest.version;
  }
  assertRecord(versions, expected.packages, `${label} Pi package versions`);
  return versions;
}

export function deriveReleaseProductionDependencies(expected, workspaceVersions) {
  const dependencies = {};
  for (const [name, specifier] of Object.entries(
    expected.hostManifest.productionDependencies,
  )) {
    if (!String(specifier).startsWith("workspace:")) {
      dependencies[name] = specifier;
      continue;
    }
    const version = workspaceVersions?.[name];
    dependencies[name] = exactVersion(version, `staged workspace dependency ${name}`);
  }
  return dependencies;
}

export function assertReleaseProductionManifest(
  manifest,
  expected,
  workspaceVersions,
  label = "release Host manifest",
) {
  const dependencies = deriveReleaseProductionDependencies(expected, workspaceVersions);
  assertRecord(manifest?.dependencies, dependencies, `${label} dependencies`);
  return dependencies;
}
