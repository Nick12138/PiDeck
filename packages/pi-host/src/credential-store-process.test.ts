/**
 * Cross-process credential serialization.
 *
 * The in-process promise chain cannot prove anything here: these tests run the
 * store in separate Node processes, so only the `proper-lockfile` advisory lock
 * around the read-modify-write can prevent lost updates. That is the case that
 * matters in production, where PiDeck and the Pi CLI share `~/.pi/agent`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const storeModule = join(here, "credential-store.ts");
const tsxBin = join(here, "..", "node_modules", ".bin", "tsx");

let root: string;
let authPath: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pideck-cred-proc-"));
  mkdirSync(join(root, "agent"), { recursive: true });
  authPath = join(root, "agent", "auth.json");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeChildScript(body: string): string {
  // `.mts` so tsx treats the script as ESM: the temp directory has no
  // package.json, and the CJS default rejects top-level await.
  const scriptPath = join(root, `child-${Math.random().toString(36).slice(2)}.mts`);
  writeFileSync(
    scriptPath,
    `import { FileCredentialStore } from ${JSON.stringify(storeModule)};\n${body}\n`,
    "utf8",
  );
  return scriptPath;
}

/**
 * tsx runs the script in a grandchild process, so signalling the immediate
 * child would leave the lock holder alive. Spawn detached and signal the whole
 * process group instead.
 */
function spawnDetachedChild(scriptPath: string, args: string[]) {
  return spawn(tsxBin, [scriptPath, ...args], {
    stdio: ["ignore", "ignore", "ignore"],
    detached: true,
  });
}

async function killGroup(child: ReturnType<typeof spawnDetachedChild>): Promise<void> {
  const exited = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once("exit", () => resolve());
  });
  try {
    if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
  await exited;
}

function runChild(scriptPath: string, args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(tsxBin, [scriptPath, ...args], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code: code ?? -1, stderr }));
  });
}

describe("FileCredentialStore across processes", () => {
  it("does not lose updates when independent processes increment the same provider", async () => {
    writeFileSync(authPath, JSON.stringify({ counter: { type: "api_key", key: "0" } }), "utf8");

    const script = writeChildScript(`
const [authPath, iterations] = process.argv.slice(2);
const store = new FileCredentialStore(authPath);
for (let i = 0; i < Number(iterations); i += 1) {
  await store.modify("counter", async (current) => {
    const value = Number(current?.key ?? "0");
    // Widen the window between read and write so an unlocked implementation
    // would reliably lose increments.
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { type: "api_key", key: String(value + 1) };
  });
}
`);

    const iterations = 5;
    const children = 3;
    const results = await Promise.all(
      Array.from({ length: children }, () => runChild(script, [authPath, String(iterations)])),
    );

    for (const result of results) {
      expect(result.stderr, result.stderr).not.toContain("Error");
      expect(result.code).toBe(0);
    }

    const stored = JSON.parse(readFileSync(authPath, "utf8"));
    expect(stored.counter.key).toBe(String(children * iterations));
  }, 60_000);

  it("keeps auth.json parseable when a process is killed mid-write", async () => {
    writeFileSync(authPath, JSON.stringify({ p: { type: "api_key", key: "original" } }), "utf8");

    const script = writeChildScript(`
const [authPath] = process.argv.slice(2);
const store = new FileCredentialStore(authPath);
await store.modify("p", async () => {
  process.stdout.write("");
  // Hold the lock open until the parent kills this process.
  await new Promise(() => {});
  return undefined;
});
`);

    const child = spawnDetachedChild(script, [authPath]);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await killGroup(child);

    // The interrupted process never reached a write, and an atomic rename means
    // a reader can never observe a half-written file.
    expect(JSON.parse(readFileSync(authPath, "utf8"))).toEqual({
      p: { type: "api_key", key: "original" },
    });

    // The abandoned lock must not wedge the file forever. proper-lockfile
    // clamps `stale` to a floor, so allow a retry budget that outlasts it.
    const { FileCredentialStore } = await import("./credential-store.js");
    const store = new FileCredentialStore(authPath, {
      staleMs: 5_000,
      retries: 10,
      minTimeoutMs: 200,
      maxTimeoutMs: 3_000,
    });
    await store.modify("p", async () => ({ type: "api_key", key: "recovered" }));
    expect(await store.read("p")).toEqual({ type: "api_key", key: "recovered" });
  }, 60_000);

  it("reports a typed lock_timeout instead of waiting indefinitely", async () => {
    writeFileSync(authPath, JSON.stringify({ p: { type: "api_key", key: "held" } }), "utf8");

    const script = writeChildScript(`
const [authPath] = process.argv.slice(2);
const store = new FileCredentialStore(authPath);
await store.modify("p", async () => {
  await new Promise((resolve) => setTimeout(resolve, 10_000));
  return undefined;
});
`);

    const child = spawnDetachedChild(script, [authPath]);
    try {
      await new Promise((resolve) => setTimeout(resolve, 1_500));

      const { CredentialStoreError, FileCredentialStore } = await import("./credential-store.js");
      const impatient = new FileCredentialStore(authPath, {
        retries: 2,
        minTimeoutMs: 20,
        maxTimeoutMs: 60,
        staleMs: 30_000,
      });

      const started = Date.now();
      const error = await impatient
        .modify("p", async () => ({ type: "api_key", key: "should not land" }))
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(CredentialStoreError);
      expect((error as InstanceType<typeof CredentialStoreError>).code).toBe("lock_timeout");
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(JSON.parse(readFileSync(authPath, "utf8")).p.key).toBe("held");
    } finally {
      await killGroup(child);
    }
  }, 60_000);
});
