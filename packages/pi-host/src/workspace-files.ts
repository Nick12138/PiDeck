import { watch, type FSWatcher } from "node:fs";
import { lstat, open, readdir, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  DEFAULT_PREVIEW_MAX_BYTES,
  MAX_PREVIEW_INLINE_BYTES,
  type WorkspaceDirectoryEntry,
  type WorkspaceFilePreview,
} from "@pideck/protocol";

export const MAX_DIRECTORY_WATCHES = 128;
const WATCH_COALESCE_MS = 100;

/** NUL-byte probe window for the text/binary decision. */
const BINARY_PROBE_BYTES = 8 * 1024;

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const LOOSE_UTF8_DECODER = new TextDecoder("utf-8");

const IMAGE_MEDIA_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".avif": "image/avif",
};

function mediaTypeForPath(path: string): string | null {
  const lower = path.toLocaleLowerCase();
  for (const [extension, mime] of Object.entries(IMAGE_MEDIA_TYPES)) {
    if (lower.endsWith(extension)) return mime;
  }
  return null;
}

function decodeText(bytes: Uint8Array): { text: string; encoding: "utf-8" | "gbk" } {
  try {
    return { text: UTF8_DECODER.decode(bytes), encoding: "utf-8" };
  } catch {
    // Windows-authored files are often GBK; Node 22 ships full ICU so
    // TextDecoder("gbk") is available. Fall back to a lossy UTF-8 pass only
    // if the bundled runtime cannot decode GBK at all.
    try {
      const gbk = new TextDecoder("gbk");
      return { text: gbk.decode(bytes), encoding: "gbk" };
    } catch {
      return { text: LOOSE_UTF8_DECODER.decode(bytes), encoding: "utf-8" };
    }
  }
}

async function resolveWorkspaceFile(
  root: string,
  input: string,
): Promise<{ absolute: string; path: string }> {
  const resolved = resolveContainedPath(root, input);
  if (!resolved.path) throw new Error("Workspace path is not a file");
  const stats = await lstat(resolved.absolute);
  if (!stats.isFile()) throw new Error("Workspace path is not a file");
  return resolved;
}

/**
 * Read a workspace file for read-only preview. Text is decoded with UTF-8
 * and falls back to GBK for Windows-authored files; images are returned as
 * base64; anything else (or oversized content) is reported as binary.
 */
export async function readWorkspaceFile(
  root: string,
  input: string,
  maxBytes = DEFAULT_PREVIEW_MAX_BYTES,
): Promise<WorkspaceFilePreview> {
  const file = await resolveWorkspaceFile(root, input);
  const stats = await lstat(file.absolute);
  const size = stats.size;

  const mimeType = mediaTypeForPath(file.path);
  if (mimeType) {
    if (size > MAX_PREVIEW_INLINE_BYTES) {
      return { path: file.path, kind: "binary", size, truncated: false };
    }
    const bytes = await readFile(file.absolute);
    return {
      path: file.path,
      kind: "image",
      size,
      truncated: false,
      mimeType,
      content: bytes.toString("base64"),
    };
  }

  // Read one extra byte so truncation can be detected without a second stat.
  if (size === 0) {
    return {
      path: file.path,
      kind: "text",
      size: 0,
      truncated: false,
      content: "",
      encoding: "utf-8",
    };
  }
  const readLength = Math.min(size, maxBytes + 1);
  const handle = await open(file.absolute, "r");
  try {
    const buffer = new Uint8Array(readLength);
    const { bytesRead } = await handle.read(buffer, 0, readLength, 0);
    const truncated = size > maxBytes;
    const probe = buffer.subarray(0, Math.min(bytesRead, BINARY_PROBE_BYTES));
    if (probe.includes(0)) {
      return { path: file.path, kind: "binary", size, truncated };
    }
    const payload = buffer.subarray(0, Math.min(bytesRead, maxBytes));
    const { text, encoding } = decodeText(payload);
    return { path: file.path, kind: "text", size, truncated, content: text, encoding };
  } finally {
    await handle.close();
  }
}

export function normalizeWorkspaceRelativePath(input: string): string {
  if (input.includes("\0")) throw new Error("Workspace path contains a null byte");
  const portable = input.replace(/\\/g, "/");
  if (portable === "" || portable === ".") return "";
  if (portable.startsWith("/") || /^[A-Za-z]:/.test(portable)) {
    throw new Error("Workspace path must be relative");
  }
  const segments = portable.split("/").filter((segment) => segment && segment !== ".");
  if (segments.some((segment) => segment === "..")) {
    throw new Error("Workspace path cannot leave the workspace");
  }
  return segments.join("/");
}

function resolveContainedPath(root: string, input: string): { absolute: string; path: string } {
  const path = normalizeWorkspaceRelativePath(input);
  const absolute = path ? resolve(root, ...path.split("/")) : root;
  const fromRoot = relative(root, absolute);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error("Workspace path cannot leave the workspace");
  }
  return { absolute, path };
}

async function resolveWorkspaceDirectory(
  root: string,
  input: string,
): Promise<{ absolute: string; path: string }> {
  const resolved = resolveContainedPath(root, input);
  let cursor = root;
  for (const segment of resolved.path.split("/").filter(Boolean)) {
    cursor = resolve(cursor, segment);
    const stats = await lstat(cursor);
    if (stats.isSymbolicLink()) {
      throw new Error("Symbolic-link directories cannot be expanded or watched");
    }
  }
  const stats = await lstat(resolved.absolute);
  if (!stats.isDirectory()) throw new Error("Workspace path is not a directory");
  return resolved;
}

export async function listWorkspaceDirectory(
  root: string,
  input: string,
): Promise<{ path: string; entries: WorkspaceDirectoryEntry[] }> {
  const directory = await resolveWorkspaceDirectory(root, input);
  const dirents = await readdir(directory.absolute, { withFileTypes: true });
  const entries = dirents.map((entry): WorkspaceDirectoryEntry => ({
    name: entry.name,
    path: directory.path ? `${directory.path}/${entry.name}` : entry.name,
    kind: entry.isDirectory() && !entry.isSymbolicLink() ? "dir" : "file",
    symlink: entry.isSymbolicLink(),
  }));
  entries.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "dir" ? -1 : 1;
    return left.name.localeCompare(right.name, undefined, {
      numeric: true,
      sensitivity: "base",
    });
  });
  return { path: directory.path, entries };
}

export class WorkspaceFileService {
  private root: string | null = null;
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly pendingDirectories = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private emit: ((directories: string[]) => void) | null = null;
  private watchGeneration = 0;

  listDirectory(root: string, path: string) {
    return listWorkspaceDirectory(root, path);
  }

  readFile(root: string, path: string, maxBytes?: number) {
    return readWorkspaceFile(root, path, maxBytes);
  }

  async setDirectoryWatches(
    root: string,
    paths: string[],
    emit: (directories: string[]) => void,
  ): Promise<string[]> {
    const generation = ++this.watchGeneration;
    const normalized = [...new Set(paths.map(normalizeWorkspaceRelativePath))];
    if (normalized.length > MAX_DIRECTORY_WATCHES) {
      throw new Error(`At most ${MAX_DIRECTORY_WATCHES} directories can be watched`);
    }
    const resolved = await Promise.all(
      normalized.map((path) => resolveWorkspaceDirectory(root, path)),
    );
    if (generation !== this.watchGeneration) return normalized;

    if (this.root !== root) this.clearWatchers();
    this.root = root;
    this.emit = emit;

    const wanted = new Set(normalized);
    for (const [path, watcher] of this.watchers) {
      if (wanted.has(path)) continue;
      watcher.close();
      this.watchers.delete(path);
    }

    const created: Array<[string, FSWatcher]> = [];
    try {
      for (const directory of resolved) {
        if (this.watchers.has(directory.path)) continue;
        const watcher = watch(directory.absolute, { persistent: false }, () => {
          if (this.root === root) this.queue(directory.path);
        });
        watcher.on("error", () => {
          if (this.root === root) this.queue(directory.path);
        });
        created.push([directory.path, watcher]);
      }
    } catch (error) {
      for (const [, watcher] of created) watcher.close();
      throw error;
    }
    for (const [path, watcher] of created) this.watchers.set(path, watcher);
    return normalized;
  }

  dispose(): void {
    this.watchGeneration += 1;
    this.clearWatchers();
  }

  private clearWatchers(): void {
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    this.pendingDirectories.clear();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.root = null;
    this.emit = null;
  }

  private queue(path: string): void {
    this.pendingDirectories.add(path);
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const directories = [...this.pendingDirectories].sort();
      this.pendingDirectories.clear();
      if (directories.length > 0) this.emit?.(directories);
    }, WATCH_COALESCE_MS);
    this.timer.unref?.();
  }
}
