/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "../../lib/stores/app-store";
import { ChatPage } from "./ChatPage";

const BASE_SETTINGS = {
  theme: "system" as const,
  language: "en" as const,
  restoreLastSession: true,
  autoRestartHostOnce: true,
  extensionDecisionPresentation: "auto" as const,
  terminalProfile: "auto" as const,
};

describe("ChatPage conversation width", () => {
  beforeEach(() => {
    useAppStore.getState().setWorkspace({
      id: "22222222-2222-4222-8222-222222222222",
      cwd: "/workspace",
      canonicalCwd: "/workspace",
      revision: 1,
      servicesReady: true,
    });
    useAppStore.getState().applySessionSnapshot(null);
    useAppStore.getState().setDesktopSettings({
      ...BASE_SETTINGS,
      conversationContentWidth: 920,
    });
  });

  afterEach(() => {
    cleanup();
    useAppStore.getState().setWorkspace(null);
    useAppStore.getState().setDesktopSettings(null);
  });

  it("publishes the configured width and clamps stale below-minimum values", () => {
    const { container } = render(<ChatPage />);
    const page = container.querySelector<HTMLElement>("[data-chat-page]")!;
    expect(page.style.getPropertyValue("--conversation-content-width")).toBe("920px");
    expect(page.querySelector("[data-chat-header-fade]")).toHaveAttribute("aria-hidden", "true");

    act(() => {
      useAppStore.getState().setDesktopSettings({
        ...BASE_SETTINGS,
        conversationContentWidth: 500,
      });
    });

    expect(page.style.getPropertyValue("--conversation-content-width")).toBe("560px");
  });
});
