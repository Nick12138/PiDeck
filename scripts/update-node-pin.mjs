/**
 * update-node-pin — repoint every Node runtime pin at a new release.
 *
 * Usage:
 *   node scripts/update-node-pin.mjs <version> --libuv-fix-verified
 *   node scripts/update-node-pin.mjs 24.18.1 --libuv-fix-verified
 *
 * The flag is a deliberate gate, not ceremony. The Windows watcher test skip
 * in packages/pi-host/src/workspace-files.test.ts matches "24.18.0" exactly,
 * so ANY new version un-skips it automatically. Node security releases are
 * minimal patches and may not carry the libuv fs-event fix (libuv/libuv#5152)
 * that 24.18.0 lacks — if the new release still lacks it, the un-skipped test
 * will abort the Windows lane. Check the release changelog for a libuv bump
 * before pinning; if the fix is absent, do NOT pin — widen the skip condition
 * instead and record the decision in the handoff document.
 *
 * Writes: scripts/release-runtime.lock.json (node section) and .node-version.
 * Downloads nothing; prepare-release-runtime.mjs verifies the archive against
 * the pinned SHA-256 at build time.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const lockPath = join(root, "scripts", "release-runtime.lock.json");
const nodeVersionPath = join(root, ".node-version");

const args = process.argv.slice(2);
const version = args.find((a) => !a.startsWith("--"));
const libuvVerified = args.includes("--libuv-fix-verified");

if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error("usage: node scripts/update-node-pin.mjs <version> --libuv-fix-verified");
  process.exit(1);
}
if (!libuvVerified) {
  console.error(
    [
      "refused: pass --libuv-fix-verified only after confirming the release",
      "carries the libuv fs-event fix (libuv/libuv#5152).",
      "",
      "Why: the Windows watcher test skip matches 24.18.0 exactly and will",
      "un-skip on this version. A security release without the libuv bump",
      "aborts the Windows lane. Check the changelog:",
      `  https://github.com/nodejs/node/releases/tag/v${version}`,
      "If the fix is absent, widen the skip in workspace-files.test.ts",
      "instead of pinning, and record the decision in the handoff document.",
    ].join("\n"),
  );
  process.exit(1);
}

const archives = {
  "win32-x64": `node-v${version}-win-x64.zip`,
  "darwin-arm64": `node-v${version}-darwin-arm64.tar.gz`,
  "darwin-x64": `node-v${version}-darwin-x64.tar.gz`,
};
const shasumsUrl = `https://nodejs.org/dist/v${version}/SHASUMS256.txt`;
const response = await fetch(shasumsUrl);
if (!response.ok) {
  console.error(`failed to fetch ${shasumsUrl}: HTTP ${response.status}`);
  process.exit(1);
}
const shasums = await response.text();
const sha256ByTarget = {};
for (const [target, archive] of Object.entries(archives)) {
  const line = shasums.split("\n").find((candidate) => candidate.trim().endsWith(archive));
  const sha256 = line?.trim().split(/\s+/)[0];
  if (!/^[0-9a-f]{64}$/.test(sha256 ?? "")) {
    console.error(`missing or malformed sha256 for ${archive}: ${sha256 ?? "missing"}`);
    process.exit(1);
  }
  sha256ByTarget[target] = sha256;
}

const lock = JSON.parse(readFileSync(lockPath, "utf8"));
const previous = lock.node.version;
lock.node.version = version;
lock.node.archive = archives["win32-x64"];
lock.node.url = `https://nodejs.org/dist/v${version}/${archives["win32-x64"]}`;
lock.node.sha256 = sha256ByTarget["win32-x64"];
for (const target of ["darwin-arm64", "darwin-x64"]) {
  const node = lock.targets?.[target]?.node;
  if (!node) {
    console.error(`release runtime lock is missing ${target}`);
    process.exit(1);
  }
  node.version = version;
  node.archive = archives[target];
  node.url = `https://nodejs.org/dist/v${version}/${archives[target]}`;
  node.sha256 = sha256ByTarget[target];
}
writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n");
writeFileSync(nodeVersionPath, `${version}\n`);

console.log(`node pin: ${previous} -> ${version}`);
console.log(`  ${lockPath}`);
console.log(`  ${nodeVersionPath}`);
for (const target of Object.keys(archives)) {
  console.log(`  ${target} sha256 ${sha256ByTarget[target]} (from SHASUMS256.txt)`);
}
console.log("");
console.log("remaining steps (handoff doc section 10 has the full runbook):");
console.log(`  fnm install ${version} && fnm use ${version}`);
console.log("  pnpm install --frozen-lockfile && pnpm verify:quick");
console.log("  push, then confirm on the Windows lane that the watcher test");
console.log("  RUNS (not skipped) and passes; record evidence in the handoff.");
