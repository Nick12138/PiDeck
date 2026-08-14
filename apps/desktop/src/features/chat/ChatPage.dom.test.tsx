/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "../../lib/stores/app-store";
import {
  DEFAULT_CONVERSATION_MAX_WIDTH,
  DEFAULT_CONVERSATION_MIN_WIDTH,
} from "./conversation-layout";
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
    useAppStore.getState().setDesktopSettings(BASE_SETTINGS);
  });

  afterEach(() => {
    cleanup();
    useAppStore.getState().setWorkspace(null);
    useAppStore.getState().setDesktopSettings(null);
  });

  it("publishes the configured conversation min and max width bounds", () => {
    useAppStore.getState().setDesktopSettings({
      ...BASE_SETTINGS,
      conversationMinWidth: 640,
      conversationMaxWidth: 1200,
    });
    const { container } = render(<ChatPage />);
    const page = container.querySelector<HTMLElement>("[data-chat-page]")!;
    expect(page.style.getPropertyValue("--conversation-min-width")).toBe("640px");
    expect(page.style.getPropertyValue("--conversation-max-width")).toBe("1200px");
    expect(page.querySelector("[data-chat-header-fade]")).toHaveAttribute("aria-hidden", "true");
  });

  it("falls back to default bounds when none are configured", () => {
    const { container } = render(<ChatPage />);
    const page = container.querySelector<HTMLElement>("[data-chat-page]")!;
    expect(page.style.getPropertyValue("--conversation-min-width")).toBe(
      `${DEFAULT_CONVERSATION_MIN_WIDTH}px`,
    );
    expect(page.style.getPropertyValue("--conversation-max-width")).toBe(
      `${DEFAULT_CONVERSATION_MAX_WIDTH}px`,
    );
  });
});
