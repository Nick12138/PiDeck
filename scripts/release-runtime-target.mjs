const SUPPORTED_TARGETS = new Set(["win32-x64", "darwin-arm64", "darwin-x64"]);

export function releaseRuntimeTargetKey(platform = process.platform, arch = process.arch) {
  const key = `${platform}-${arch}`;
  if (!SUPPORTED_TARGETS.has(key)) {
    throw new Error(`unsupported release runtime target: ${key}`);
  }
  return key;
}

export function resolveReleaseRuntimeTarget(
  lock,
  platform = process.platform,
  arch = process.arch,
) {
  const key = releaseRuntimeTargetKey(platform, arch);
  if (key === "win32-x64") {
    return {
      key,
      platform,
      arch,
      node: lock.node,
      git: {
        strategy: "bundled-portable",
        portable: lock.git?.portable,
      },
      stagedNodeExecutable: "node.exe",
      stagedNpmExecutable: "npm.cmd",
      stagedNpxExecutable: "npx.cmd",
    };
  }

  const target = lock.targets?.[key];
  if (!target || target.platform !== platform || target.arch !== arch) {
    throw new Error(`release-runtime lock is missing target ${key}`);
  }
  if (target.node?.version !== lock.node?.version) {
    throw new Error(
      `release-runtime target ${key} Node ${target.node?.version ?? "missing"} does not match canonical ${lock.node?.version ?? "missing"}`,
    );
  }
  return {
    key,
    ...target,
    stagedNodeExecutable: "node",
    stagedNpmExecutable: "npm",
    stagedNpxExecutable: "npx",
  };
}

export function updaterPlatformKey(platform = process.platform, arch = process.arch) {
  if (platform === "win32" && arch === "x64") return "windows-x86_64";
  if (platform === "darwin" && arch === "arm64") return "darwin-aarch64";
  if (platform === "darwin" && arch === "x64") return "darwin-x86_64";
  throw new Error(`unsupported updater platform: ${platform}-${arch}`);
}
