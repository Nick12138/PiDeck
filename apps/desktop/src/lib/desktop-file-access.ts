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
        name: "All files",
        extensions: ["*"],
      },
    ],
  });
  if (!selected) return [];
  return Array.isArray(selected) ? selected : [selected];
}

export type DesktopFileInfo = {
  name: string;
  sizeBytes: number;
  path: string;
  isDirectory: boolean;
};

export async function getDesktopFileInfo(path: string): Promise<DesktopFileInfo> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<DesktopFileInfo>("desktop_file_info", { path });
}

export async function readDesktopSmallFile(path: string): Promise<DesktopSmallFile> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<DesktopSmallFile>("desktop_read_small_file", { path });
}

export function isDocumentPath(path: string): boolean {
  return /\.(?:pdf|docx)$/iu.test(path.trim());
}
