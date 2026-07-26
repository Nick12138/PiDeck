import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileCredentialStore } from "./credential-store.js";
import { ProviderMutationJournal, recoverProviderJournals } from "./provider-journal.js";
import { buildDegradedModelConfigHealth } from "./model-health.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const ORIGINAL_MODELS = JSON.stringify({ providers: { a: { name: "A" } } }, null, 2) + "\n";
const ORIGINAL_AUTH = JSON.stringify({ a: { type: "api_key", key: "sk-original" } }, null, 2);

function createAgentDir(): { agentDir: string; modelsPath: string; store: FileCredentialStore } {
  const root = mkdtempSync(join(tmpdir(), "pideck-journal-"));
  roots.push(root);
  const agentDir = join(root, "agent");
  mkdirSync(agentDir, { recursive: true });
  const modelsPath = join(agentDir, "models.json");
  writeFileSync(modelsPath, ORIGINAL_MODELS);
  writeFileSync(join(agentDir, "auth.json"), ORIGINAL_AUTH);
  return { agentDir, modelsPath, store: FileCredentialStore.forAgentDir(agentDir) };
}

function journalEntries(agentDir: string): string[] {
  const root = join(agentDir, "provider-journal");
  return existsSync(root) ? readdirSync(root) : [];
}

async function beginSave(agentDir: string, modelsPath: string, store: FileCredentialStore) {
  return ProviderMutationJournal.begin({
    agentDir,
    operation: "provider.save",
    providerId: "a",
    modelsPath,
    modelsBytes: ORIGINAL_MODELS,
    credentialStore: store,
  });
}

describe("ProviderMutationJournal", () => {
  it("removes the entry when the mutation finishes", async () => {
    const { agentDir, modelsPath, store } = createAgentDir();

    const journal = await beginSave(agentDir, modelsPath, store);
    expect(journalEntries(agentDir)).toHaveLength(1);

    await journal.markCommitted();
    await journal.finish();

    // Absence of the entry is the commit marker.
    expect(journalEntries(agentDir)).toHaveLength(0);
  });

  it("rolls both files back together and clears the entry", async () => {
    const { agentDir, modelsPath, store } = createAgentDir();
    const journal = await beginSave(agentDir, modelsPath, store);

    // Simulate a mutation that wrote both files before failing.
    writeFileSync(modelsPath, JSON.stringify({ providers: { b: {} } }));
    await store.modify("a", async () => ({ type: "api_key", key: "sk-rewritten" }));

    const outcome = await journal.rollback();

    expect(outcome.restored).toBe(true);
    expect(readFileSync(modelsPath, "utf8")).toBe(ORIGINAL_MODELS);
    expect(await store.readRaw("a")).toEqual({ type: "api_key", key: "sk-original" });
    expect(journalEntries(agentDir)).toHaveLength(0);
  });

  it("removes models.json again when it did not exist before the mutation", async () => {
    const { agentDir, modelsPath, store } = createAgentDir();
    rmSync(modelsPath);

    const journal = await ProviderMutationJournal.begin({
      agentDir,
      operation: "provider.save",
      providerId: "a",
      modelsPath,
      modelsBytes: null,
      credentialStore: store,
    });
    writeFileSync(modelsPath, JSON.stringify({ providers: {} }));

    const outcome = await journal.rollback();

    expect(outcome.restored).toBe(true);
    expect(existsSync(modelsPath)).toBe(false);
  });
});

describe("recoverProviderJournals", () => {
  it("returns null when no mutation was interrupted", async () => {
    const { agentDir, store } = createAgentDir();
    expect(await recoverProviderJournals(agentDir, store)).toBeNull();
  });

  it("restores an interrupted mutation left by a previous run", async () => {
    const { agentDir, modelsPath, store } = createAgentDir();

    // A crash: the journal is open and both files have already been rewritten,
    // so the in-process rollback never ran.
    await beginSave(agentDir, modelsPath, store);
    writeFileSync(modelsPath, JSON.stringify({ providers: { crashed: {} } }));
    await store.modify("a", async () => ({ type: "api_key", key: "sk-half-written" }));

    // Next start.
    const recovered = FileCredentialStore.forAgentDir(agentDir);
    const outcome = await recoverProviderJournals(agentDir, recovered);

    expect(outcome).toBeNull(); // resolved cleanly, so nothing to report
    expect(readFileSync(modelsPath, "utf8")).toBe(ORIGINAL_MODELS);
    expect(await recovered.readRaw("a")).toEqual({ type: "api_key", key: "sk-original" });
    expect(journalEntries(agentDir)).toHaveLength(0);
  });

  it("reports an unresolved recovery and keeps the entry when restore fails", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const { agentDir, modelsPath, store } = createAgentDir();
    const journal = await beginSave(agentDir, modelsPath, store);
    writeFileSync(modelsPath, JSON.stringify({ providers: { crashed: {} } }));

    // Make the agent directory read-only so the restore cannot land.
    await chmod(agentDir, 0o500);
    try {
      // Short lock budget: this asserts the failure shape, not the wait.
      const impatient = FileCredentialStore.forAgentDir(agentDir, {
        retries: 1,
        minTimeoutMs: 10,
        maxTimeoutMs: 20,
      });
      const outcome = await recoverProviderJournals(agentDir, impatient);

      expect(outcome).not.toBeNull();
      expect(outcome!.restored).toBe(false);
      expect(outcome!.journalId).toBe(journal.journalId);
      expect(outcome!.message).toContain("Could not fully roll back");
    } finally {
      await chmod(agentDir, 0o700);
    }

    // The entry must survive so the next start still knows.
    expect(journalEntries(agentDir)).toHaveLength(1);
  });

  it("discards an entry with no readable record instead of blocking startup", async () => {
    const { agentDir, store } = createAgentDir();
    const orphan = join(agentDir, "provider-journal", "orphan");
    mkdirSync(orphan, { recursive: true });
    writeFileSync(join(orphan, "journal.json"), "{ not json");

    expect(await recoverProviderJournals(agentDir, store)).toBeNull();
    expect(journalEntries(agentDir)).toHaveLength(0);
  });
});

describe("degraded model config health", () => {
  it("reports degraded with the journal identity and stage", () => {
    const health = buildDegradedModelConfigHealth({
      journalId: "abc",
      stage: "committed",
      restored: false,
      message: "Could not fully roll back provider.save of provider a: models.json: EACCES",
    });

    expect(health.state).toBe("degraded");
    expect(health.source).toBe("provider.journal");
    expect(health.recovery).toEqual({ journalId: "abc", stage: "committed", restored: false });
    expect(health.message).toContain("Could not fully roll back");
  });

  it("redacts anything secret-shaped in the recovery message", () => {
    const health = buildDegradedModelConfigHealth({
      journalId: "abc",
      stage: "prepared",
      restored: false,
      message: "restore failed with api_key=sk-live-value",
    });

    expect(health.message).not.toContain("sk-live-value");
  });
});
