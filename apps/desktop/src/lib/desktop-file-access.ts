export type DesktopSmallFile =
  | {
      kind: "image";
      name: string;
      sizeBytes: number;
      mediaType: string;
      data: string;
    }
  | {
      kind: "text";
      name: string;
      sizeBytes: number;
      text: string;
    };

export async function isDesktopRuntime(): Promise<boolean> {
  const { isTauri } = await import("@tauri-apps/api/core");
  return isTauri();
}

export async function pickDesktopAttachmentPaths(): Promise<string[] | null> {
  if (!(await isDesktopRuntime())) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({
    multiple: true,
    directory: false,
    filters: [
      {
        name: "Documents and images",
        extensions: [
          "pdf",
          "docx",
          "png",
          "jpg",
          "jpeg",
          "gif",
          "webp",
          "txt",
          "md",
          "mdx",
          "json",
          "jsonl",
          "yaml",
          "yml",
          "toml",
          "csv",
          "tsv",
          "xml",
          "html",
          "css",
          "js",
          "jsx",
          "ts",
          "tsx",
          "py",
          "rs",
          "go",
          "java",
          "kt",
          "swift",
          "c",
          "h",
          "cpp",
          "hpp",
          "sh",
          "sql",
          "log",
        ],
      },
    ],
  });
  if (!selected) return [];
  return Array.isArray(selected) ? selected : [selected];
}

export async function readDesktopSmallFile(path: string): Promise<DesktopSmallFile> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<DesktopSmallFile>("desktop_read_small_file", { path });
}

export function isDocumentPath(path: string): boolean {
  return /\.(?:pdf|docx)$/iu.test(path.trim());
}
