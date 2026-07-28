import { chmod, lstat, mkdir, readdir, rename, rmdir } from "node:fs/promises";
import { dirname, join, resolve as pathResolve } from "node:path";

const DIR_MODE = 0o700;

export const PIDECK_MODEL_BACKUP_PATTERN = /^models-(\d+)-[0-9a-f]{8}\.bak$/u;

export function workspaceStorageKey(cwd: string): string {
  const resolvedCwd = pathResolve(cwd);
  return `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

export function pideckDataDir(agentDir: string): string {
  return join(pathResolve(agentDir), "pideck");
}

export function migrationBackupRoot(agentDir: string, migrationId: string): string {
  return join(pideckDataDir(agentDir), "migration-backups", migrationId);
}

export function providerJournalRoot(agentDir: string): string {
  return join(pideckDataDir(agentDir), "provider-journal");
}

export function modelBackupDir(agentDir: string): string {
  return join(pideckDataDir(agentDir), "model-backups");
}

export function sessionArchiveRoot(agentDir: string): string {
  return join(pideckDataDir(agentDir), "session-archive");
}

export function sessionArchiveDir(agentDir: string, cwd: string): string {
  return join(sessionArchiveRoot(agentDir), workspaceStorageKey(cwd));
}

function errnoCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null | undefined)?.code;
}

async function pathKind(path: string): Promise<"directory" | "other" | null> {
  try {
    return (await lstat(path)).isDirectory() ? "directory" : "other";
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return null;
    throw error;
  }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: DIR_MODE });
  if (process.platform !== "win32") await chmod(path, DIR_MODE);
}

async function moveLegacyTree(source: string, target: string): Promise<void> {
  const sourceKind = await pathKind(source);
  if (sourceKind === null) return;

  const targetKind = await pathKind(target);
  if (targetKind === null) {
    await ensurePrivateDirectory(dirname(target));
    try {
      await rename(source, target);
      if (sourceKind === "directory" && process.platform !== "win32") {
        await chmod(target, DIR_MODE);
      }
      return;
    } catch (error) {
      if (errnoCode(error) !== "EEXIST" && errnoCode(error) !== "ENOTEMPTY") throw error;
      // Another partially-completed migration populated the target. Merge it
      // under the same collision rules instead of overwriting either side.
    }
  }

  const currentTargetKind = await pathKind(target);
  if (sourceKind !== "directory" || currentTargetKind !== "directory") {
    throw new Error(`Conflicting PiDeck data at ${source} and ${target}`);
  }

  await ensurePrivateDirectory(target);
  const entries = await readdir(source);
  for (const entry of entries) {
    await moveLegacyTree(join(source, entry), join(target, entry));
  }
  await rmdir(source);
}

async function removeEmptyDirectory(path: string): Promise<void> {
  try {
    await rmdir(path);
  } catch (error) {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(errnoCode(error) ?? "")) throw error;
  }
}

/**
 * Adopt data written by older PiDeck versions. Every source and destination is
 * inside one agent directory, so successful renames stay on the same volume.
 * The operation is restartable and never overwrites conflicting recovery data.
 */
export async function migrateLegacyPideckData(
  agentDir: string,
  migrationId: string,
): Promise<void> {
  const resolvedAgentDir = pathResolve(agentDir);
  await ensurePrivateDirectory(pideckDataDir(resolvedAgentDir));

  await moveLegacyTree(
    join(resolvedAgentDir, "backups", migrationId),
    migrationBackupRoot(resolvedAgentDir, migrationId),
  );
  await removeEmptyDirectory(join(resolvedAgentDir, "backups"));

  await moveLegacyTree(
    join(resolvedAgentDir, "provider-journal"),
    providerJournalRoot(resolvedAgentDir),
  );

  const backups = await readdir(resolvedAgentDir, { withFileTypes: true });
  const targetModelBackupDir = modelBackupDir(resolvedAgentDir);
  await ensurePrivateDirectory(targetModelBackupDir);
  for (const entry of backups) {
    if (!entry.isFile() || !PIDECK_MODEL_BACKUP_PATTERN.test(entry.name)) continue;
    await moveLegacyTree(
      join(resolvedAgentDir, entry.name),
      join(targetModelBackupDir, entry.name),
    );
  }

  const sessionsRoot = join(resolvedAgentDir, "sessions");
  const workspaceDirs = await readdir(sessionsRoot, { withFileTypes: true }).catch((error) => {
    if (errnoCode(error) === "ENOENT") return [];
    throw error;
  });
  for (const entry of workspaceDirs) {
    if (!entry.isDirectory()) continue;
    await moveLegacyTree(
      join(sessionsRoot, entry.name, ".archive"),
      join(sessionArchiveRoot(resolvedAgentDir), entry.name),
    );
  }
}
