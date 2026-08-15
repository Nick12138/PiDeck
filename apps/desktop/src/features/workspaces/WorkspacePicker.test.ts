import { describe, expect, it } from "vitest";
import {
  addKnownWorkspace,
  replaceKnownWorkspace,
  removeKnownWorkspace,
  workspaceDisplayName,
} from "./WorkspacePicker";

describe("known workspace list", () => {
  it("appends new paths and keeps insertion order", () => {
    const list = addKnownWorkspace(["C:\\repos\\alpha"], "C:\\repos\\beta");
    expect(list).toEqual(["C:\\repos\\alpha", "C:\\repos\\beta"]);
  });

  it("preserves differently-cased canonical paths", () => {
    const list = addKnownWorkspace(["/repos/Alpha"], "/repos/alpha");
    expect(list).toEqual(["/repos/Alpha", "/repos/alpha"]);
  });

  it("removes only the exact canonical path", () => {
    const list = removeKnownWorkspace(["/repos/Alpha", "/repos/alpha"], "/repos/Alpha");
    expect(list).toEqual(["/repos/alpha"]);
  });

  it("replaces a requested path with the Host canonical path", () => {
    expect(
      replaceKnownWorkspace(
        ["C:\\repos\\alpha", "C:\\repos\\beta"],
        "C:\\repos\\alpha",
        "C:\\Repos\\Alpha",
      ),
    ).toEqual(["C:\\Repos\\Alpha", "C:\\repos\\beta"]);
  });
});

describe("workspaceDisplayName", () => {
  it("uses the last path segment for both separators", () => {
    expect(workspaceDisplayName("C:\\repos\\alpha")).toBe("alpha");
    expect(workspaceDisplayName("/home/user/beta/")).toBe("beta");
  });
});
