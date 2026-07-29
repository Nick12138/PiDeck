/**
 * generate-update-manifest — builds the updater feed (latest.json) for a
 * GitHub Release from an accepted package:release run.
 *
 * Reads target/release-staging/PACKAGE_RELEASE.json, binds the accepted
 * installer to its Tauri updater signature (.sig), and stages everything a
 * release needs under target/release-staging/github-release/:
 *   <installer>.exe, latest.json, installer-manifest.json
 *
 * Usage: node scripts/generate-update-manifest.mjs --tag v0.1.0 [--repo owner/name]
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

function fail(message) {
  throw new Error(`[generate-update-manifest] ${message}`);
}

/** Pure manifest builder so tests can pin the feed shape without IO. */
export function buildUpdateManifest({ tag, version, installerName, signature, repo, publishedAt }) {
  if (!/^v\d/.test(String(tag))) fail(`tag must look like v<semver>, got ${String(tag)}`);
  if (tag !== `v${version}`) {
    fail(`tag ${tag} does not match the packaged app version ${version}`);
  }
  if (!/^[^/\\]+\/[^/\\]+$/.test(String(repo))) fail(`repo must be owner/name, got ${String(repo)}`);
  if (typeof signature !== "string" || signature.trim() === "") {
    fail("updater signature is empty — was the installer built with TAURI_SIGNING_PRIVATE_KEY set?");
  }
  if (typeof installerName !== "string" || !/\.exe$/i.test(installerName)) {
    fail(`installer name must be the NSIS setup exe, got ${String(installerName)}`);
  }
  return {
    version,
    pub_date: publishedAt,
    platforms: {
      "windows-x86_64": {
        signature: signature.trim(),
        url: `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(installerName)}`,
      },
    },
  };
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function main() {
  const args = process.argv.slice(2);
  const readArg = (name) => {
    const index = args.indexOf(name);
    return index === -1 ? null : args[index + 1];
  };
  const tag = readArg("--tag") ?? fail("--tag is required (e.g. --tag v0.1.0)");
  const repo = readArg("--repo") ?? process.env.GITHUB_REPOSITORY ?? "Skitre/PiDeck";

  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const stagingDir = join(root, "apps/desktop/src-tauri/target/release-staging");
  const packageManifestPath = join(stagingDir, "PACKAGE_RELEASE.json");
  if (!existsSync(packageManifestPath)) fail("PACKAGE_RELEASE.json missing — run pnpm package:release first");
  const packageManifest = JSON.parse(readFileSync(packageManifestPath, "utf8"));
  if (packageManifest.status !== "ok") fail(`refusing a ${packageManifest.status} package:release run`);

  const installer = packageManifest.primaryInstaller;
  if (!installer || !existsSync(installer)) fail("accepted installer missing from release staging");
  const actualSha = sha256File(installer);
  if (actualSha !== packageManifest.primaryInstallerSha256) {
    fail(`accepted installer hash drifted since packaging: ${actualSha}`);
  }

  // createUpdaterArtifacts writes the signature next to the bundle output; the
  // accepted installer is a verified byte-identical copy, so the sig transfers.
  const sigPath = `${packageManifest.sourceInstaller}.sig`;
  if (!existsSync(sigPath)) fail(`updater signature missing: ${sigPath}`);

  const version = JSON.parse(
    readFileSync(join(root, "apps/desktop/src-tauri/tauri.conf.json"), "utf8"),
  ).version;

  const manifest = buildUpdateManifest({
    tag,
    version,
    installerName: basename(installer),
    signature: readFileSync(sigPath, "utf8"),
    repo,
    publishedAt: new Date().toISOString(),
  });

  const outDir = join(stagingDir, "github-release");
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  copyFileSync(installer, join(outDir, basename(installer)));
  if (sha256File(join(outDir, basename(installer))) !== actualSha) {
    fail("staged release installer copy does not match the accepted installer");
  }
  writeFileSync(join(outDir, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  copyFileSync(packageManifestPath, join(outDir, "installer-manifest.json"));
  console.log(`[generate-update-manifest] staged ${outDir}`);
  console.log(`[generate-update-manifest] ${basename(installer)} sha256=${actualSha}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
