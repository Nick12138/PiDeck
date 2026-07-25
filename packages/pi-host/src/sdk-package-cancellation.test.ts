import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultPackageManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

describe("PiDeck package-manager cancellation patch", () => {
  let root: string | undefined;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it("aborts the active package-manager subprocess", async () => {
    root = mkdtempSync(join(tmpdir(), "pideck-package-cancel-"));
    const agentDir = join(root, "agent");
    const cwd = join(root, "workspace");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    const settingsManager = {
      getNpmCommand: () => [
        process.execPath,
        "-e",
        "setInterval(() => {}, 1_000)",
        "--",
      ],
      isProjectTrusted: () => true,
      getGlobalSettings: () => ({ packages: [] }),
      getProjectSettings: () => ({ packages: [] }),
    };
    const manager = new DefaultPackageManager({
      cwd,
      agentDir,
      settingsManager: settingsManager as never,
    });
    const controller = new AbortController();
    manager.setOperationSignal(controller.signal);

    const installing = manager.installAndPersist("npm:never-finishes");
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort(new Error("test cancellation"));

    await expect(installing).rejects.toMatchObject({ name: "AbortError" });
  }, 5_000);
});
