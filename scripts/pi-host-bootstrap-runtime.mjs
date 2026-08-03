import { createHash, randomUUID } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { assertNodeModulesGraph, restoreNodeModulesLinks } from "./portable-node-modules.mjs";

const PI_HOST_CACHE_SCHEMA_VERSION = 1;
const CACHE_HASH_PATTERN = /^[a-f0-9]{64}$/u;
const DEFAULT_LOCK_WAIT_MS = 180_000;
const MISSING_OWNER_STALE_MS = 30_000;

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `${label} is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function assertSha256(value, label) {
  if (typeof value !== "string" || !CACHE_HASH_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function cacheMarker(staging) {
  if (staging.hostRuntimePackagedInZip !== true) {
    throw new Error("STAGING hostRuntimePackagedInZip must be true");
  }
  if (staging.hostCacheSchemaVersion !== PI_HOST_CACHE_SCHEMA_VERSION) {
    throw new Error(
      `STAGING hostCacheSchemaVersion ${staging.hostCacheSchemaVersion ?? "missing"} !== ${PI_HOST_CACHE_SCHEMA_VERSION}`,
    );
  }
  return {
    schemaVersion: PI_HOST_CACHE_SCHEMA_VERSION,
    nodeModulesZipSha256: assertSha256(
      staging.nodeModulesZipSha256,
      "STAGING nodeModulesZipSha256",
    ),
    nodeModulesLinksSha256: assertSha256(
      staging.nodeModulesLinksSha256,
      "STAGING nodeModulesLinksSha256",
    ),
    nodeModulesGraphSha256: assertSha256(
      staging.nodeModulesGraphSha256,
      "STAGING nodeModulesGraphSha256",
    ),
  };
}

function sameMarker(actual, expected) {
  return (
    actual?.schemaVersion === expected.schemaVersion &&
    actual?.nodeModulesZipSha256 === expected.nodeModulesZipSha256 &&
    actual?.nodeModulesLinksSha256 === expected.nodeModulesLinksSha256 &&
    actual?.nodeModulesGraphSha256 === expected.nodeModulesGraphSha256
  );
}

function validateCache(cacheDir, expectedMarker, expectedGraph) {
  try {
    const marker = readJson(join(cacheDir, "READY.json"), "Pi Host cache marker");
    if (!sameMarker(marker, expectedMarker)) return null;
    const runtimeDir = join(cacheDir, "host-runtime");
    const entry = join(runtimeDir, "host-main.js");
    const nodeModulesDir = join(cacheDir, "node_modules");
    if (!existsSync(entry) || !existsSync(nodeModulesDir)) return null;
    const releasePackage = readJson(join(runtimeDir, "package.json"), "cached Host package");
    assertNodeModulesGraph(
      nodeModulesDir,
      releasePackage.dependencies,
      expectedGraph,
      "cached release node_modules",
    );
    return entry;
  } catch {
    return null;
  }
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function lockIsStale(lockDir, now) {
  try {
    const owner = readJson(join(lockDir, "owner.json"), "Pi Host cache lock owner");
    // Never steal from a live PID. A hung owner is handled by the bounded wait,
    // which is safer than corrupting an install that may still be progressing.
    return !processIsAlive(owner.pid);
  } catch {
    try {
      return now - statSync(lockDir).mtimeMs > MISSING_OWNER_STALE_MS;
    } catch {
      return true;
    }
  }
}

function assertLockOwner(lockDir, token) {
  const owner = readJson(join(lockDir, "owner.json"), "Pi Host cache lock owner");
  if (owner.pid !== process.pid || owner.token !== token) {
    throw new Error("Pi Host cache lock ownership changed during installation");
  }
}

function releaseLock(lockDir, token) {
  try {
    const owner = readJson(join(lockDir, "owner.json"), "Pi Host cache lock owner");
    if (owner.token !== token) return;
    rmSync(lockDir, { recursive: true, force: true });
  } catch {
    // The lock was already removed or replaced; never delete an unknown owner.
  }
}

async function acquireCacheLock(args) {
  const deadline = args.now() + args.waitMs;
  while (args.now() < deadline) {
    const cachedEntry = validateCache(args.cacheDir, args.marker, args.graph);
    if (cachedEntry) return { cachedEntry, release: null };
    const token = args.randomId();
    try {
      mkdirSync(args.lockDir);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (lockIsStale(args.lockDir, args.now())) {
        rmSync(args.lockDir, { recursive: true, force: true });
        continue;
      }
      await args.sleep(args.pollMs);
      continue;
    }
    try {
      writeFileSync(
        join(args.lockDir, "owner.json"),
        `${JSON.stringify({ pid: process.pid, token, startedAt: args.now() })}\n`,
      );
      return {
        cachedEntry: null,
        assertOwner: () => assertLockOwner(args.lockDir, token),
        release: () => releaseLock(args.lockDir, token),
      };
    } catch (error) {
      rmSync(args.lockDir, { recursive: true, force: true });
      throw error;
    }
  }
  throw new Error(`Timed out waiting for Pi Host cache lock: ${args.lockDir}`);
}

function windowsBsdTar() {
  const systemTar = process.env.SystemRoot
    ? join(process.env.SystemRoot, "System32", "tar.exe")
    : null;
  return systemTar && existsSync(systemTar) ? systemTar : "tar.exe";
}

function extractPiHostArchive(zipPath, destination) {
  mkdirSync(destination, { recursive: true });
  let result;
  if (process.platform === "win32") {
    result = spawnSync(windowsBsdTar(), ["-x", "-f", zipPath, "-C", destination], {
      encoding: "utf8",
      shell: false,
    });
  } else {
    result = spawnSync("unzip", ["-q", "-o", zipPath, "-d", destination], {
      encoding: "utf8",
      shell: false,
    });
    if (result.status !== 0) {
      result = spawnSync("tar", ["-x", "-f", zipPath, "-C", destination], {
        encoding: "utf8",
        shell: false,
      });
    }
  }
  if (result.status !== 0) {
    throw new Error(
      `Pi Host archive extraction failed: ${result.stderr || result.stdout || result.error?.message || `exit ${String(result.status)}`}`,
    );
  }
}

export async function ensurePiHostRuntime(options) {
  const resourceDir = resolve(options.resourceDir);
  const cacheRoot = resolve(options.cacheRoot);
  const zipPath = join(resourceDir, "node_modules.zip");
  const linksPath = join(resourceDir, "NODE_MODULES_LINKS.json");
  const graphPath = join(resourceDir, "NODE_MODULES_GRAPH.json");
  const staging = readJson(join(resourceDir, "STAGING.json"), "Pi Host STAGING metadata");
  const marker = cacheMarker(staging);
  const expectedGraph = readJson(graphPath, "Pi Host dependency graph");
  const actualHashes = await Promise.all([
    sha256File(zipPath),
    sha256File(linksPath),
    sha256File(graphPath),
  ]);
  for (const [actual, expected, label] of [
    [actualHashes[0], marker.nodeModulesZipSha256, "node_modules.zip"],
    [actualHashes[1], marker.nodeModulesLinksSha256, "NODE_MODULES_LINKS.json"],
    [actualHashes[2], marker.nodeModulesGraphSha256, "NODE_MODULES_GRAPH.json"],
  ]) {
    if (actual !== expected) {
      throw new Error(`Pi Host resource hash mismatch for ${label}: ${actual} !== ${expected}`);
    }
  }

  mkdirSync(cacheRoot, { recursive: true });
  const cacheDir = join(cacheRoot, marker.nodeModulesZipSha256);
  const existing = validateCache(cacheDir, marker, expectedGraph);
  if (existing) return existing;

  const lockRoot = join(cacheRoot, ".locks");
  mkdirSync(lockRoot, { recursive: true });
  const lockDir = join(lockRoot, marker.nodeModulesZipSha256);
  const lock = await acquireCacheLock({
    cacheDir,
    lockDir,
    marker,
    graph: expectedGraph,
    waitMs: options.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS,
    pollMs: options.lockPollMs ?? 100,
    now: options.now ?? Date.now,
    sleep:
      options.sleep ??
      ((milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds))),
    randomId: options.randomId ?? randomUUID,
  });
  if (lock.cachedEntry) return lock.cachedEntry;

  const tempDir = join(
    cacheRoot,
    `.tmp-${marker.nodeModulesZipSha256}-${process.pid}-${(options.randomId ?? randomUUID)()}`,
  );
  let installedFinal = false;
  try {
    rmSync(tempDir, { recursive: true, force: true });
    mkdirSync(tempDir, { recursive: true });
    await (options.extractArchive ?? extractPiHostArchive)(zipPath, tempDir);
    if (
      !existsSync(join(tempDir, "node_modules")) ||
      !existsSync(join(tempDir, "host-runtime", "host-main.js"))
    ) {
      throw new Error("Pi Host archive is missing node_modules or host-runtime/host-main.js");
    }
    lock.assertOwner();
    rmSync(cacheDir, { recursive: true, force: true });
    renameSync(tempDir, cacheDir);
    installedFinal = true;
    const nodeModulesDir = join(cacheDir, "node_modules");
    const runtimeDir = join(cacheDir, "host-runtime");
    const linkManifest = readJson(linksPath, "Pi Host node_modules link manifest");
    restoreNodeModulesLinks(nodeModulesDir, linkManifest);
    const releasePackage = readJson(join(runtimeDir, "package.json"), "cached Host package");
    assertNodeModulesGraph(
      nodeModulesDir,
      releasePackage.dependencies,
      expectedGraph,
      "extracted release node_modules",
    );
    const readyTemporary = join(cacheDir, `.READY-${process.pid}-${randomUUID()}.tmp`);
    writeFileSync(readyTemporary, `${JSON.stringify(marker, null, 2)}\n`);
    renameSync(readyTemporary, join(cacheDir, "READY.json"));
    const readyEntry = validateCache(cacheDir, marker, expectedGraph);
    if (!readyEntry) throw new Error("Pi Host cache failed validation after atomic install");
    return readyEntry;
  } catch (error) {
    rmSync(tempDir, { recursive: true, force: true });
    if (installedFinal) rmSync(cacheDir, { recursive: true, force: true });
    throw error;
  } finally {
    lock.release?.();
  }
}

export async function runPiHostBootstrap(options) {
  const entry = await ensurePiHostRuntime(options);
  return import(pathToFileURL(entry).href);
}
