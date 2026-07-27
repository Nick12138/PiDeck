import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

const OPAQUE_DIRECTORY_NAMES = new Set(["node_modules", ".git"]);

function traversalReaches(ancestor: string, candidate: string): boolean {
  const rel = relative(ancestor, candidate);
  if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
    return false;
  }
  return !rel.split(/[\\/]/).some((segment) => OPAQUE_DIRECTORY_NAMES.has(segment));
}

function normalizeRoots(roots: Iterable<string>): string[] {
  const unique = [...new Set([...roots].map((root) => resolve(root)))];
  return unique
    .filter(
      (candidate) =>
        !unique.some(
          (ancestor) => ancestor !== candidate && traversalReaches(ancestor, candidate),
        ),
    )
    .sort((a, b) => a.localeCompare(b));
}

export async function captureFilesystemFingerprint(args: {
  roots: Iterable<string>;
  markers?: Iterable<string>;
  signal?: AbortSignal;
}): Promise<string> {
  const hash = createHash("sha256");

  const visit = async (root: string, path: string): Promise<void> => {
    args.signal?.throwIfAborted();
    const label = relative(root, path).replace(/\\/g, "/") || ".";
    let stat: Awaited<ReturnType<typeof lstat>>;
    try {
      stat = await lstat(path);
    } catch (error) {
      args.signal?.throwIfAborted();
      const code = (error as NodeJS.ErrnoException).code;
      hash.update(
        code === "ENOENT"
          ? `missing:${root}:${label}\n`
          : `error:${root}:${label}:${error instanceof Error ? error.message : String(error)}\n`,
      );
      return;
    }

    hash.update(`${root}:${label}|${stat.mode}|${stat.size}|${Math.trunc(stat.mtimeMs)}\n`);
    if (!stat.isDirectory()) return;
    if (path !== root && OPAQUE_DIRECTORY_NAMES.has(basename(path))) {
      hash.update(`opaque:${root}:${label}\n`);
      return;
    }

    const entries = await readdir(path, { withFileTypes: true });
    args.signal?.throwIfAborted();
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      await visit(root, join(path, entry.name));
    }
  };

  for (const marker of [...(args.markers ?? [])].sort((a, b) => a.localeCompare(b))) {
    hash.update(`marker:${marker}\n`);
  }
  for (const root of normalizeRoots(args.roots)) {
    hash.update(`root:${root}\n`);
    await visit(root, root);
  }
  args.signal?.throwIfAborted();
  return hash.digest("hex");
}
