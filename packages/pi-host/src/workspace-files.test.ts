import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_PREVIEW_INLINE_BYTES,
} from "@pideck/protocol";
import {
  MAX_DIRECTORY_WATCHES,
  WorkspaceFileService,
  listWorkspaceDirectory,
  normalizeWorkspaceRelativePath,
  readWorkspaceFile,
} from "./workspace-files.js";

// Node 24.18.0 predates the Windows fs-event fix in libuv/libuv#5152 and can abort here.
const hasBrokenWindowsFsWatch =
  process.platform === "win32" && process.versions.node === "24.18.0";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pideck-workspace-files-"));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "README.md"), "readme");
  await writeFile(join(root, "src", "index.ts"), "export {};");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("workspace relative paths", () => {
  it("normalizes portable relative paths and rejects escapes", () => {
    expect(normalizeWorkspaceRelativePath("")).toBe("");
    expect(normalizeWorkspaceRelativePath("src\\components/./Button.tsx")).toBe(
      "src/components/Button.tsx",
    );
    expect(() => normalizeWorkspaceRelativePath("../outside")).toThrow(/cannot leave/);
    expect(() => normalizeWorkspaceRelativePath("C:\\outside")).toThrow(/relative/);
    expect(() => normalizeWorkspaceRelativePath("/outside")).toThrow(/relative/);
  });
});

describe("listWorkspaceDirectory", () => {
  it("returns a directory-first, workspace-relative listing", async () => {
    await expect(listWorkspaceDirectory(root, "")).resolves.toEqual({
      path: "",
      entries: [
        { name: "src", path: "src", kind: "dir", symlink: false },
        { name: "README.md", path: "README.md", kind: "file", symlink: false },
      ],
    });
  });

  it("does not traverse symbolic-link directories", async () => {
    try {
      await symlink(join(root, "src"), join(root, "linked-src"), "dir");
    } catch {
      return;
    }
    const listing = await listWorkspaceDirectory(root, "");
    expect(listing.entries.find((entry) => entry.name === "linked-src")).toEqual({
      name: "linked-src",
      path: "linked-src",
      kind: "file",
      symlink: true,
    });
    await expect(listWorkspaceDirectory(root, "linked-src")).rejects.toThrow(/Symbolic-link/);
  });
});

describe("WorkspaceFileService", () => {
  it("rejects more than the bounded number of watches", async () => {
    const service = new WorkspaceFileService();
    const paths = Array.from({ length: MAX_DIRECTORY_WATCHES + 1 }, (_, index) => `d${index}`);
    await expect(service.setDirectoryWatches(root, paths, () => {})).rejects.toThrow(/At most/);
    service.dispose();
  });

  it.skipIf(hasBrokenWindowsFsWatch)(
    "coalesces changes for watched expanded directories",
    async () => {
      const service = new WorkspaceFileService();
      const changed = new Promise<string[]>((resolve) => {
        void service.setDirectoryWatches(root, ["src"], resolve);
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      await writeFile(join(root, "src", "second.ts"), "export const second = true;");
      await expect(changed).resolves.toEqual(["src"]);
      service.dispose();
    },
  );
});

describe("readWorkspaceFile", () => {
  it("reads UTF-8 text and reports the encoding", async () => {
    await expect(readWorkspaceFile(root, "README.md")).resolves.toEqual({
      path: "README.md",
      kind: "text",
      size: 6,
      truncated: false,
      content: "readme",
      encoding: "utf-8",
    });
  });

  it("decodes GBK text for Windows-authored files", async () => {
    // GBK bytes for 中文内容 (U+4E2D→D6 D0; U+6587→CE C4; U+5185→C4 DA; U+5BB9→C8 DD).
    const gbkBytes = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xc4, 0xda, 0xc8, 0xdd]);
    await writeFile(join(root, "src", "gbk.txt"), gbkBytes);
    const preview = await readWorkspaceFile(root, "src/gbk.txt");
    expect(preview.kind).toBe("text");
    expect(preview.encoding).toBe("gbk");
    expect(preview.content).toBe("中文内容");
  });

  it("detects binary files via NUL bytes", async () => {
    const bytes = Buffer.concat([
      Buffer.from("text"),
      Buffer.from([0x00]),
      Buffer.from("tail"),
    ]);
    await writeFile(join(root, "src", "blob.bin"), bytes);
    await expect(readWorkspaceFile(root, "src/blob.bin")).resolves.toEqual({
      path: "src/blob.bin",
      kind: "binary",
      size: 9,
      truncated: false,
    });
  });

  it("truncates text at the preview limit", async () => {
    const content = "a".repeat(64);
    await writeFile(join(root, "src", "long.txt"), content);
    await expect(readWorkspaceFile(root, "src/long.txt", 32)).resolves.toEqual({
      path: "src/long.txt",
      kind: "text",
      size: 64,
      truncated: true,
      content: "a".repeat(32),
      encoding: "utf-8",
    });
  });

  it("returns images as base64 with a MIME type", async () => {
    // Minimal 1x1 PNG.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64",
    );
    await writeFile(join(root, "src", "pixel.png"), png);
    const preview = await readWorkspaceFile(root, "src/pixel.png");
    expect(preview).toMatchObject({
      path: "src/pixel.png",
      kind: "image",
      size: png.length,
      truncated: false,
      mimeType: "image/png",
    });
    expect(Buffer.from(preview.content ?? "", "base64")).toEqual(png);
  });

  it("reports oversized inline files as binary", async () => {
    const bytes = Buffer.alloc(MAX_PREVIEW_INLINE_BYTES + 1, 0x41);
    await writeFile(join(root, "src", "huge.png"), bytes);
    const preview = await readWorkspaceFile(root, "src/huge.png");
    expect(preview.kind).toBe("binary");
    expect(preview.size).toBe(MAX_PREVIEW_INLINE_BYTES + 1);
  });

  it("rejects directories and paths outside the workspace", async () => {
    await expect(readWorkspaceFile(root, "src")).rejects.toThrow(/not a file/);
    await expect(readWorkspaceFile(root, "../outside")).rejects.toThrow(/cannot leave/);
    await expect(readWorkspaceFile(root, "C:\\outside")).rejects.toThrow(/relative/);
    await expect(readWorkspaceFile(root, "")).rejects.toThrow(/not a file/);
  });

  it("exposes readFile through the service", async () => {
    const service = new WorkspaceFileService();
    await expect(service.readFile(root, "README.md")).resolves.toMatchObject({
      path: "README.md",
      kind: "text",
      content: "readme",
    });
    service.dispose();
  });
});
