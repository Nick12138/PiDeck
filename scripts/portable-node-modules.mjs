import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const PORTABLE_NODE_MODULES_LINKS_VERSION = 1;
const NODE_MODULES_GRAPH_VERSION = 1;

function toPortablePath(path) {
  return path.split(sep).join("/");
}

function isInside(root, candidate) {
  const path = relative(root, candidate);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

function portablePath(root, path, label) {
  if (!isInside(root, path) || path === root) {
    throw new Error(`${label} is outside node_modules: ${path}`);
  }
  return toPortablePath(relative(root, path));
}

function resolvePortablePath(root, path, label) {
  if (typeof path !== "string" || path.length === 0 || path.includes("\\")) {
    throw new Error(`${label} must be a non-empty forward-slash relative path`);
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error(`${label} contains an unsafe segment: ${path}`);
  }
  const resolved = resolve(root, ...segments);
  if (!isInside(root, resolved) || resolved === root) {
    throw new Error(`${label} escapes node_modules: ${path}`);
  }
  return resolved;
}

function normalizeLinkManifest(manifest) {
  if (!manifest || typeof manifest !== "object") {
    throw new Error("node_modules link manifest must be an object");
  }
  if (manifest.version !== PORTABLE_NODE_MODULES_LINKS_VERSION) {
    throw new Error(`unsupported node_modules link manifest version: ${String(manifest.version)}`);
  }
  if (!Array.isArray(manifest.links)) {
    throw new Error("node_modules link manifest links must be an array");
  }
  const seen = new Set();
  const links = manifest.links.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`node_modules link manifest entry ${index} must be an object`);
    }
    const { path, target, kind } = entry;
    if (kind !== "directory" && kind !== "file") {
      throw new Error(`node_modules link manifest entry ${index} has invalid kind`);
    }
    if (typeof path !== "string" || typeof target !== "string") {
      throw new Error(`node_modules link manifest entry ${index} requires path and target`);
    }
    if (seen.has(path)) throw new Error(`duplicate node_modules link path: ${path}`);
    seen.add(path);
    return { path, target, kind };
  });
  for (const entry of links) {
    const segments = entry.path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      const ancestor = segments.slice(0, index).join("/");
      if (seen.has(ancestor)) {
        throw new Error(`node_modules link paths overlap: ${ancestor} and ${entry.path}`);
      }
    }
    if (entry.path === entry.target) {
      throw new Error(`node_modules link cannot target itself: ${entry.path}`);
    }
  }
  return {
    version: PORTABLE_NODE_MODULES_LINKS_VERSION,
    links: links.sort((left, right) => left.path.localeCompare(right.path)),
  };
}

function scanLinks(nodeModulesDir) {
  const root = realpathSync(nodeModulesDir);
  const links = [];
  const visit = (directory) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const stats = lstatSync(path);
      if (stats.isSymbolicLink()) {
        const target = realpathSync(path);
        links.push({
          absolutePath: path,
          path: portablePath(root, path, "node_modules link"),
          absoluteTarget: target,
          kind: statSync(path).isDirectory() ? "directory" : "file",
        });
        continue;
      }
      if (stats.isDirectory()) visit(path);
    }
  };
  visit(root);
  return { root, links };
}

export function detachNodeModulesLinks(nodeModulesDir, options = {}) {
  const ignoredExternalLinks = new Set(options.ignoredExternalLinks ?? []);
  const { root, links } = scanLinks(nodeModulesDir);
  const portableLinks = [];
  const ignored = [];
  for (const link of links) {
    if (isInside(root, link.absoluteTarget)) {
      portableLinks.push({
        path: link.path,
        target: portablePath(root, link.absoluteTarget, `target for ${link.path}`),
        kind: link.kind,
      });
      continue;
    }
    if (!ignoredExternalLinks.has(link.path)) {
      throw new Error(
        `node_modules link target escapes the deploy tree: ${link.path} -> ${link.absoluteTarget}`,
      );
    }
    ignored.push(link.path);
  }
  for (const expected of ignoredExternalLinks) {
    if (!ignored.includes(expected)) {
      throw new Error(`expected external node_modules link was not found: ${expected}`);
    }
  }
  for (const link of links) unlinkSync(link.absolutePath);
  return {
    manifest: normalizeLinkManifest({
      version: PORTABLE_NODE_MODULES_LINKS_VERSION,
      links: portableLinks,
    }),
    ignoredExternalLinks: ignored.sort(),
  };
}

export function restoreNodeModulesLinks(nodeModulesDir, manifest) {
  const root = resolve(nodeModulesDir);
  const normalized = normalizeLinkManifest(manifest);
  const resolvedLinks = normalized.links.map((entry) => {
    const path = resolvePortablePath(root, entry.path, "node_modules link path");
    const target = resolvePortablePath(root, entry.target, `target for ${entry.path}`);
    if (!existsSync(target)) {
      throw new Error(`node_modules link target is missing: ${entry.path} -> ${entry.target}`);
    }
    const targetIsDirectory = statSync(target).isDirectory();
    if ((entry.kind === "directory") !== targetIsDirectory) {
      throw new Error(`node_modules link kind does not match target: ${entry.path}`);
    }
    let pathStats = null;
    try {
      pathStats = lstatSync(path);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (pathStats) {
      if (pathStats.isSymbolicLink() && realpathSync(path) === realpathSync(target)) {
        return { ...entry, path, target, exists: true };
      }
      throw new Error(
        `node_modules link path already exists with different content: ${entry.path}`,
      );
    }
    return { ...entry, path, target, exists: false };
  });
  const created = [];
  try {
    for (const entry of resolvedLinks) {
      if (entry.exists) continue;
      mkdirSync(dirname(entry.path), { recursive: true });
      const linkTarget =
        process.platform === "win32" ? entry.target : relative(dirname(entry.path), entry.target);
      const linkType =
        entry.kind === "directory" ? (process.platform === "win32" ? "junction" : "dir") : "file";
      symlinkSync(linkTarget, entry.path, linkType);
      created.push(entry.path);
    }
  } catch (error) {
    for (const path of created.reverse()) {
      try {
        unlinkSync(path);
      } catch {
        // Best effort rollback; preserve the original restore error.
      }
    }
    throw error;
  }
  return normalized.links.length;
}

function packageIdentity(metadata, path) {
  if (!metadata || typeof metadata !== "object") {
    throw new Error(`invalid package metadata: ${path}`);
  }
  if (typeof metadata.name !== "string" || typeof metadata.version !== "string") {
    throw new Error(`package metadata requires name and version: ${path}`);
  }
  return `${metadata.name}@${metadata.version}`;
}

function declaredRuntimeDependencies(metadata) {
  return new Set([
    ...Object.keys(metadata.dependencies ?? {}),
    ...Object.keys(metadata.optionalDependencies ?? {}),
    ...Object.keys(metadata.peerDependencies ?? {}),
  ]);
}

function dependencyPackageJson(nodeModulesRoot, fromPackageDir, dependencyName) {
  const dependencySegments = dependencyName.split("/");
  let current = fromPackageDir;
  while (isInside(nodeModulesRoot, current)) {
    const modules =
      basename(current).toLowerCase() === "node_modules" ? current : join(current, "node_modules");
    const candidate = join(modules, ...dependencySegments, "package.json");
    if (existsSync(candidate)) return realpathSync(candidate);
    if (current === nodeModulesRoot) return null;
    const parent = dirname(current);
    if (parent === current || !isInside(nodeModulesRoot, parent)) return null;
    current = parent;
  }
  return null;
}

function normalizeRootDependencies(rootDependencies) {
  if (
    !rootDependencies ||
    typeof rootDependencies !== "object" ||
    Array.isArray(rootDependencies)
  ) {
    throw new Error("root dependencies must be an object");
  }
  return Object.keys(rootDependencies).sort();
}

export function snapshotNodeModulesGraph(nodeModulesDir, rootDependencies) {
  const root = realpathSync(nodeModulesDir);
  const queue = [];
  const visited = new Set();
  const packages = new Set();
  const edges = new Set();

  for (const dependencyName of normalizeRootDependencies(rootDependencies)) {
    const packageJson = join(root, ...dependencyName.split("/"), "package.json");
    if (!existsSync(packageJson)) {
      throw new Error(`root dependency is missing: ${dependencyName}`);
    }
    const resolvedPackageJson = realpathSync(packageJson);
    const metadata = JSON.parse(readFileSync(resolvedPackageJson, "utf8"));
    const identity = packageIdentity(metadata, resolvedPackageJson);
    edges.add(`<root>|${dependencyName}|${identity}`);
    queue.push({ packageJson: resolvedPackageJson, metadata, identity });
  }

  while (queue.length > 0) {
    const current = queue.shift();
    const packageDir = realpathSync(dirname(current.packageJson));
    if (visited.has(packageDir)) continue;
    visited.add(packageDir);
    packages.add(current.identity);
    for (const dependencyName of [...declaredRuntimeDependencies(current.metadata)].sort()) {
      const resolvedPackageJson = dependencyPackageJson(root, packageDir, dependencyName);
      if (!resolvedPackageJson) {
        edges.add(`${current.identity}|${dependencyName}|<missing>`);
        continue;
      }
      const metadata = JSON.parse(readFileSync(resolvedPackageJson, "utf8"));
      const identity = packageIdentity(metadata, resolvedPackageJson);
      edges.add(`${current.identity}|${dependencyName}|${identity}`);
      queue.push({ packageJson: resolvedPackageJson, metadata, identity });
    }
  }

  return {
    version: NODE_MODULES_GRAPH_VERSION,
    packages: [...packages].sort(),
    edges: [...edges].sort(),
  };
}

function graphDifference(expected, actual) {
  const actualSet = new Set(actual);
  return expected.filter((entry) => !actualSet.has(entry));
}

export function assertNodeModulesGraph(
  nodeModulesDir,
  rootDependencies,
  expected,
  label = "node_modules",
) {
  if (!expected || expected.version !== NODE_MODULES_GRAPH_VERSION) {
    throw new Error(`${label} has unsupported dependency graph version`);
  }
  const actual = snapshotNodeModulesGraph(nodeModulesDir, rootDependencies);
  const missingPackages = graphDifference(expected.packages ?? [], actual.packages);
  const addedPackages = graphDifference(actual.packages, expected.packages ?? []);
  const missingEdges = graphDifference(expected.edges ?? [], actual.edges);
  const addedEdges = graphDifference(actual.edges, expected.edges ?? []);
  if (
    missingPackages.length > 0 ||
    addedPackages.length > 0 ||
    missingEdges.length > 0 ||
    addedEdges.length > 0
  ) {
    const sample = (values) => values.slice(0, 5).join(", ") || "none";
    throw new Error(
      `${label} dependency graph changed\n` +
        `  missing packages: ${sample(missingPackages)}\n` +
        `  added packages: ${sample(addedPackages)}\n` +
        `  missing edges: ${sample(missingEdges)}\n` +
        `  added edges: ${sample(addedEdges)}`,
    );
  }
  return actual;
}
