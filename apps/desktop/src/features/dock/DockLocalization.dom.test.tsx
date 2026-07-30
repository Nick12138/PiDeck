/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "../../lib/stores/app-store";
import { ExtensionTerminal } from "./ExtensionTerminal";
import { FilesPanel } from "./FilesPanel";

describe("Dock built-in panel localization", () => {
  beforeEach(() => {
    useAppStore.setState({
      host: null,
      workspace: null,
      extensionTerminal: null,
      desktopSettings: { language: "zh" } as never,
    });
  });

  afterEach(() => cleanup());

  it("localizes the Files panel controls and empty state", () => {
    render(<FilesPanel visible />);

    expect(screen.getByRole("region", { name: "工作区文件" })).toBeVisible();
    expect(screen.getByRole("searchbox", { name: "搜索工作区文件" })).toHaveAttribute(
      "placeholder",
      "搜索文件",
    );
    expect(screen.getByRole("button", { name: "刷新文件" })).toBeVisible();
    expect(screen.getByRole("button", { name: "收起所有文件夹" })).toBeDisabled();
    expect(screen.getByText("未打开工作区")).toBeVisible();
  });

  it("localizes the Extension panel empty state", () => {
    render(<ExtensionTerminal />);

    expect(screen.getByText("扩展面板（例如 /mcp）将在这里打开。")).toBeVisible();
  });
});
