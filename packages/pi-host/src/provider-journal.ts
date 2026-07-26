/**
 * Crash-durable journal for provider mutations.
 *
 * A provider change writes two files that no single rename can cover together:
 * `models.json` (provider configuration) and `auth.json` (its credential). If
 * the Host dies between them, the in-memory rollback in provider-controller
 * never runs and the user is left with a provider whose configuration and
 * credential disagree.
 *
 * The journal makes that state detectable. Before committing anything, the
 * pre-mutation bytes of both files are copied to disk alongside a journal
 * record. The record is removed only after the whole mutation, including the
 * local refresh and reconciliation, has succeeded. So a journal found at
 * startup means exactly one thing: a mutation did not finish.
 *
 * Recovery restores both files from those copies. If it cannot, the journal is
 * kept and `modelConfigHealth` reports `degraded`, because at that point the
 * Host genuinely does not know whether the configuration is coherent.
 */
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProviderMutationStage } from "@pideck/protocol";
import { logger } from "./logger.js";
import type { FileCredentialStore } from "./credential-store.js";

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const JOURNAL_FILE = "journal.json";

export type ProviderJournalRecord = {
  schemaVersion: 1;
  journalId: string;
  startedAt: string;
  operation: string;
  providerId: string;
  stage: ProviderMutationStage;
  modelsPath: string;
  /** `null` when models.json did not exist before the mutation. */
  modelsBackup: string | null;
};

export type JournalRecovery = {
  journalId: string;
  stage: ProviderMutationStage;
  restored: boolean;
  message: string;
};

function journalRoot(agentDir: string): string {
  return join(agentDir, "provider-journal");
}

function entryDir(agentDir: string, journalId: string): string {
  return join(journalRoot(agentDir), journalId);
}

async function writeRecord(directory: string, record: ProviderJournalRecord): Promise<void> {
  const path = join(directory, JOURNAL_FILE);
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(record, null, 2) + "\n", {
    encoding: "utf8",
    mode: FILE_MODE,
  });
  const { rename } = await import("node:fs/promises");
  await rename(temp, path);
}

async function readRecord(directory: string): Promise<ProviderJournalRecord | null> {
  const raw = await readFile(join(directory, JOURNAL_FILE), "utf8").catch(() => null);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as ProviderJournalRecord;
    if (parsed.schemaVersion !== 1 || typeof parsed.journalId !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * An open journal entry. Exactly one can exist at a time because every provider
 * mutation holds `serviceGraphLock`.
 */
export class ProviderMutationJournal {
  private constructor(
    private readonly agentDir: string,
    private readonly directory: string,
    private readonly record: ProviderJournalRecord,
    private readonly credentialStore: FileCredentialStore,
  ) {}

  get journalId(): string {
    return this.record.journalId;
  }

  /**
   * Capture pre-mutation state. Call after validating the candidate config and
   * before writing anything the user can observe.
   */
  static async begin(options: {
    agentDir: string;
    operation: string;
    providerId: string;
    modelsPath: string;
    /** Exact pre-mutation models.json bytes, or null when it did not exist. */
    modelsBytes: string | null;
    credentialStore: FileCredentialStore;
  }): Promise<ProviderMutationJournal> {
    const journalId = randomUUID();
    const directory = entryDir(options.agentDir, journalId);
    await mkdir(directory, { recursive: true, mode: DIR_MODE });

    let modelsBackup: string | null = null;
    if (options.modelsBytes !== null) {
      modelsBackup = join(directory, "models.json");
      await writeFile(modelsBackup, options.modelsBytes, { encoding: "utf8", mode: FILE_MODE });
    }

    // The credential snapshot is whole-file, so it restores every provider the
    // mutation might touch, not just the named one.
    const snapshot = await options.credentialStore.snapshot();
    const authBackup = join(directory, "auth.json");
    if (snapshot.content === null) {
      await writeFile(join(directory, "auth.absent"), "", { encoding: "utf8", mode: FILE_MODE });
    } else {
      await writeFile(authBackup, snapshot.content, { encoding: "utf8", mode: FILE_MODE });
      await chmod(authBackup, FILE_MODE).catch(() => undefined);
    }

    const record: ProviderJournalRecord = {
      schemaVersion: 1,
      journalId,
      startedAt: new Date().toISOString(),
      operation: options.operation,
      providerId: options.providerId,
      stage: "prepared",
      modelsPath: options.modelsPath,
      modelsBackup,
    };
    await writeRecord(directory, record);
    return new ProviderMutationJournal(
      options.agentDir,
      directory,
      record,
      options.credentialStore,
    );
  }

  /** Both durable writes landed; only reconciliation remains. */
  async markCommitted(): Promise<void> {
    this.record.stage = "committed";
    await writeRecord(this.directory, this.record);
  }

  /** The mutation fully succeeded. Removing the entry is the commit marker. */
  async finish(): Promise<void> {
    await rm(this.directory, { recursive: true, force: true }).catch((error: unknown) => {
      logger.warn("Could not clear provider journal entry", {
        journalId: this.record.journalId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /**
   * Restore both files from the captured copies. Keeps the entry when it
   * cannot, so startup reports a degraded configuration instead of silently
   * continuing.
   */
  async rollback(): Promise<JournalRecovery> {
    const outcome = await restoreFromEntry(
      this.agentDir,
      this.directory,
      this.record,
      this.credentialStore,
    );
    if (outcome.restored) await this.finish();
    return outcome;
  }
}

async function restoreFromEntry(
  agentDir: string,
  directory: string,
  record: ProviderJournalRecord,
  credentialStore: FileCredentialStore,
): Promise<JournalRecovery> {
  const failures: string[] = [];

  try {
    const { rename, unlink } = await import("node:fs/promises");
    if (record.modelsBackup) {
      const bytes = await readFile(record.modelsBackup, "utf8");
      const temp = `${record.modelsPath}.${randomUUID()}.restore`;
      await writeFile(temp, bytes, { encoding: "utf8", mode: FILE_MODE });
      await rename(temp, record.modelsPath);
    } else {
      // models.json did not exist before the mutation.
      await unlink(record.modelsPath).catch((error: unknown) => {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") throw error;
      });
    }
  } catch (error) {
    failures.push(`models.json: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    const authBackup = join(directory, "auth.json");
    const content = await readFile(authBackup, "utf8").catch(() => null);
    await credentialStore.restore({
      path: credentialStorePath(agentDir),
      content,
    });
  } catch (error) {
    failures.push(`auth.json: ${error instanceof Error ? error.message : String(error)}`);
  }

  return {
    journalId: record.journalId,
    stage: record.stage,
    restored: failures.length === 0,
    message:
      failures.length === 0
        ? `Rolled back interrupted ${record.operation} of provider ${record.providerId}`
        : `Could not fully roll back ${record.operation} of provider ${record.providerId}: ${failures.join("; ")}`,
  };
}

function credentialStorePath(agentDir: string): string {
  return join(agentDir, "auth.json");
}

/**
 * Resolve any journal left by a previous run. Call during startup, before the
 * first status is published.
 *
 * Returns `null` when nothing was pending. Otherwise returns the outcome; a
 * `restored: false` result must surface as degraded configuration health.
 */
export async function recoverProviderJournals(
  agentDir: string,
  credentialStore: FileCredentialStore,
): Promise<JournalRecovery | null> {
  const root = journalRoot(agentDir);
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (directories.length === 0) return null;

  let unresolved: JournalRecovery | null = null;
  for (const name of directories) {
    const directory = join(root, name);
    const record = await readRecord(directory);
    if (!record) {
      // Nothing actionable: a partial entry without a record cannot be replayed.
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      continue;
    }
    const outcome = await restoreFromEntry(agentDir, directory, record, credentialStore);
    if (outcome.restored) {
      logger.warn("Recovered an interrupted provider mutation", {
        journalId: outcome.journalId,
        stage: outcome.stage,
      });
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    } else {
      logger.error("Provider mutation recovery incomplete", {
        journalId: outcome.journalId,
        stage: outcome.stage,
        message: outcome.message,
      });
      unresolved = outcome;
    }
  }
  return unresolved;
}
