import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { capturePackageDiskFingerprint } from "./package-controller.js";
import type { WorkspaceGraph } from "./workspace-graph-types.js";

describe("package disk fingerprint", () => {
  let root: string | undefined;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  function fixture(): {
    graph: WorkspaceGraph;
    agentDir: string;
    packagesDir: string;
  } {
    root = mkdtempSync(join(tmpdir(), "pideck-fingerprint-"));
    const agentDir = join(root, "agent");
    const workspace = join(root, "workspace");
    const packagesDir = join(agentDir, "packages");
    mkdirSync(packagesDir, { recursive: true });
    mkdirSync(join(workspace, ".pi", "packages"), { recursive: true });
    const graph = {
      canonicalCwd: workspace,
      packageManager: {
        listConfiguredPackages: () => [],
      },
    } as unknown as WorkspaceGraph;
    return { graph, agentDir, packagesDir };
  }

  it("is stable for unchanged trees and changes with package files", async () => {
    const { graph, agentDir, packagesDir } = fixture();
    const manifest = join(packagesDir, "example.json");
    writeFileSync(manifest, "{}\n");

    const first = await capturePackageDiskFingerprint(graph, agentDir);
    const second = await capturePackageDiskFingerprint(graph, agentDir);
    writeFileSync(manifest, '{"changed":true}\n');
    const changed = await capturePackageDiskFingerprint(graph, agentDir);

    expect(second).toBe(first);
    expect(changed).not.toBe(first);
  });

  it("yields to the event loop and observes cancellation", async () => {
    const { graph, agentDir, packagesDir } = fixture();
    for (let index = 0; index < 100; index += 1) {
      writeFileSync(join(packagesDir, `entry-${index}.json`), `${index}\n`);
    }
    const controller = new AbortController();
    let timerFired = false;
    const scanning = capturePackageDiskFingerprint(graph, agentDir, controller.signal);
    setTimeout(() => {
      timerFired = true;
      controller.abort();
    }, 0);

    await expect(scanning).rejects.toMatchObject({ name: "AbortError" });
    expect(timerFired).toBe(true);
  });
});
