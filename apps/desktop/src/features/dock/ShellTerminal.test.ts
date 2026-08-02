import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { closeShellTerminal, chunkTerminalInput, shellTerminalLabel } from "./ShellTerminal";

describe("chunkTerminalInput", () => {
  it("preserves input order while bounding chunks", () => {
    const input = "abcdefghij";
    const chunks = chunkTerminalInput(input, 4);
    expect(chunks).toEqual(["abcd", "efgh", "ij"]);
    expect(chunks.join("")).toBe(input);
  });

  it("does not split a Unicode surrogate pair", () => {
    const input = `abc\u{1f642}def`;
    const chunks = chunkTerminalInput(input, 4);
    expect(chunks).toEqual(["abc", "\u{1f642}de", "f"]);
    expect(chunks.join("")).toBe(input);
  });
});

describe("shellTerminalLabel", () => {
  it("uses the final workspace directory on Windows and Unix", () => {
    expect(shellTerminalLabel("C:\\work\\PiDesktop")).toBe("PiDesktop");
    expect(shellTerminalLabel("/work/PiDesktop/")).toBe("PiDesktop");
  });
});

describe("closeShellTerminal", () => {
  it("dispatches close before an in-flight write settles", async () => {
    let releaseWrite!: () => void;
    const pendingWrite = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const commands: string[] = [];
    const closing = closeShellTerminal("terminal-1", pendingWrite, async (command) => {
      commands.push(command);
    });

    await Promise.resolve();
    const commandsBeforeWriteSettled = [...commands];
    releaseWrite();
    await closing;

    expect(commandsBeforeWriteSettled).toEqual(["shell_terminal_close"]);
  });
});

describe("terminal stylesheet bundling", () => {
  it("loads xterm structural styles through the static application entry", () => {
    const main = readFileSync(join(process.cwd(), "src/main.tsx"), "utf8");
    const surface = readFileSync(join(process.cwd(), "src/features/dock/XtermSurface.tsx"), "utf8");

    expect(main).toContain('import "@xterm/xterm/css/xterm.css";');
    expect(surface).not.toContain('import("@xterm/xterm/css/xterm.css")');
  });
});
