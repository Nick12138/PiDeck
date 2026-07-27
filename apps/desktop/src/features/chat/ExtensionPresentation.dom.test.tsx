/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hostClient } from "../../lib/bridge/host-client";
import { useAppStore, type ExtensionUiRequestState } from "../../lib/stores/app-store";
import { AssistantOrderedContent, ExtensionMessageRow } from "./Transcript";
import { ExtensionUiModal } from "./ExtensionUiModal";
import { InlineExtensionUiRequest } from "./InlineExtensionUiRequest";
import type { TranscriptRow } from "./transcript-model";

const CONTEXT = {
  expectedHostInstanceId: "11111111-1111-4111-8111-111111111111",
  expectedWorkspaceId: "22222222-2222-4222-8222-222222222222",
  expectedWorkspaceRevision: 1,
  expectedSessionId: "33333333-3333-4333-8333-333333333333",
  expectedSessionRevision: 1,
};

let requestSequence = 0;

function setLanguage(language: "en" | "zh") {
  useAppStore.getState().setDesktopSettings({
    theme: "system",
    language,
    restoreLastSession: true,
    autoRestartHostOnce: true,
    terminalProfile: "auto",
  });
}

function extensionRequest(
  overrides: Partial<ExtensionUiRequestState> = {},
): ExtensionUiRequestState {
  requestSequence += 1;
  return {
    requestId: `44444444-4444-4444-8444-${String(requestSequence).padStart(12, "0")}`,
    kind: "confirm",
    title: "Choose how to continue",
    context: CONTEXT,
    ...overrides,
  };
}

function renderRequestSurfaces() {
  return render(
    <>
      <InlineExtensionUiRequest />
      <ExtensionUiModal />
    </>,
  );
}

describe("Extension presentation surfaces", () => {
  beforeEach(() => {
    requestSequence = 0;
    setLanguage("en");
    useAppStore.setState({
      extensionUiRequest: null,
      extensionUiQueue: [],
      notifications: [],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    cleanup();
    useAppStore.getState().setDesktopSettings(null);
  });

  it("opens raw agent protocol from the Agent coordination title row", async () => {
    const user = userEvent.setup();
    const rawProtocol = "Reply with: internal_tool({ action: 'respond' })";
    const row: TranscriptRow = {
      key: "custom:1",
      role: "custom",
      blocks: [{ kind: "text", text: rawProtocol }],
      copyText: rawProtocol,
      customType: "subagent_supervisor_request",
      details: { id: "request-1" },
      extensionPresentation: {
        version: 1,
        extensionId: "pi-subagents",
        sourceLabel: "Subagents",
        audience: "agent",
        kind: "activity",
        correlationId: "request-1",
      },
    };

    render(<ExtensionMessageRow row={row} />);

    const disclosure = screen.getByRole("button", { name: /Agent coordination/ });
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Technical details")).not.toBeInTheDocument();
    expect(screen.queryByText(rawProtocol)).not.toBeInTheDocument();
    await user.click(disclosure);
    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(rawProtocol)).toBeVisible();
  });

  it("collects Extension activity inside the execution checklist", async () => {
    const user = userEvent.setup();
    const row: TranscriptRow = {
      key: "custom:trace",
      role: "custom",
      blocks: [{ kind: "text", text: "Internal extension payload" }],
      copyText: "Internal extension payload",
      customType: "subagent_supervisor_request",
      extensionPresentation: {
        version: 1,
        extensionId: "pi-subagents",
        sourceLabel: "Subagents",
        audience: "agent",
        kind: "activity",
        correlationId: "trace-request",
      },
    };

    render(
      <AssistantOrderedContent
        blocks={[
          { kind: "tool", tool: { id: "read-1", name: "read", status: "done" } },
          { kind: "extension", row },
        ]}
        mode="static"
        showCaret={false}
        turnActive={false}
      />,
    );

    const trace = screen.getByRole("button", { name: "2 actions completed" });
    expect(screen.queryByRole("button", { name: /Agent coordination/ })).not.toBeInTheDocument();
    await user.click(trace);
    expect(screen.getByRole("button", { name: /Agent coordination/ })).toBeVisible();
  });

  it("localizes the nested checklist and keeps agent diagnostics behind the second disclosure", async () => {
    setLanguage("zh");
    const user = userEvent.setup();
    const rawProtocol = "Reply with the internal result";
    const agentRow: TranscriptRow = {
      key: "custom:agent-failure",
      role: "custom",
      blocks: [{ kind: "text", text: rawProtocol }],
      copyText: rawProtocol,
      customType: "subagent_supervisor_request",
      details: { id: "request-failed" },
      extensionPresentation: {
        version: 1,
        extensionId: "pi-subagents",
        sourceLabel: "Subagents",
        audience: "agent",
        kind: "activity",
        correlationId: "request-failed",
        status: "failed",
      },
    };
    const fallbackRow: TranscriptRow = {
      key: "custom:unknown-extension",
      role: "custom",
      blocks: [{ kind: "text", text: "Unknown extension payload" }],
      copyText: "Unknown extension payload",
      customType: "unknown-extension",
    };

    render(
      <AssistantOrderedContent
        blocks={[
          { kind: "extension", row: agentRow },
          { kind: "extension", row: fallbackRow },
        ]}
        mode="static"
        showCaret={false}
        turnActive={false}
      />,
    );

    const trace = screen.getByRole("button", { name: "已完成 2 个操作，1 个失败" });
    expect(screen.queryByRole("button", { name: /Agent 协作/ })).not.toBeInTheDocument();
    trace.focus();
    await user.keyboard("{Enter}");

    const agentDisclosure = screen.getByRole("button", { name: /Agent 协作/ });
    expect(screen.getByRole("button", { name: "扩展消息" })).toBeVisible();
    expect(screen.queryByText("Subagents")).not.toBeInTheDocument();
    expect(screen.queryByText(rawProtocol)).not.toBeInTheDocument();

    await user.click(agentDisclosure);

    expect(agentDisclosure).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("原始消息")).toBeVisible();
    expect(screen.getByText("元数据")).toBeVisible();
    expect(screen.getByText(rawProtocol)).toBeVisible();
  });

  it("renders exactly one surface and keeps legacy requests modal", async () => {
    act(() => {
      useAppStore.getState().setExtensionUiRequest(
        extensionRequest({ presentation: "inline" }),
      );
    });
    renderRequestSurfaces();

    expect(screen.getByRole("region", { name: "Choose how to continue" })).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    act(() => {
      useAppStore.setState({
        extensionUiRequest: extensionRequest({ title: "Legacy modal request" }),
        extensionUiQueue: [],
      });
    });

    expect(await screen.findByRole("dialog", { name: "Legacy modal request" })).toBeVisible();
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
  });

  it("shows a local failure and lets the same action retry", async () => {
    const hostRequest = vi
      .spyOn(hostClient, "request")
      .mockResolvedValueOnce({ ok: false, error: { message: "Host temporarily unavailable" } } as never)
      .mockResolvedValueOnce({ ok: true, result: null } as never);
    act(() => {
      useAppStore.getState().setExtensionUiRequest(
        extensionRequest({ presentation: "inline" }),
      );
    });
    const user = userEvent.setup();
    renderRequestSurfaces();

    await user.click(screen.getByRole("button", { name: "Confirm" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Host temporarily unavailable");
    expect(useAppStore.getState().extensionUiRequest).not.toBeNull();

    await user.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(screen.queryByRole("region")).not.toBeInTheDocument());
    expect(hostRequest).toHaveBeenCalledTimes(2);
    expect(hostRequest).toHaveBeenLastCalledWith(
      "extensionUi.respond",
      CONTEXT,
      expect.objectContaining({ status: "resolved", value: true }),
    );
  });

  it("disables duplicate actions while a response is in flight", async () => {
    let resolveResponse: ((value: unknown) => void) | undefined;
    const hostRequest = vi.spyOn(hostClient, "request").mockImplementation(
      () => new Promise((resolve) => {
        resolveResponse = resolve;
      }) as never,
    );
    act(() => {
      useAppStore.getState().setExtensionUiRequest(
        extensionRequest({ presentation: "inline" }),
      );
    });
    const user = userEvent.setup();
    renderRequestSurfaces();

    await user.click(screen.getByRole("button", { name: "Confirm" }));

    expect(screen.getByRole("button", { name: "Submitting…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(hostRequest).toHaveBeenCalledOnce();

    await act(async () => {
      resolveResponse?.({ ok: true, result: null });
      await Promise.resolve();
    });
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
  });

  it("keeps select progress on the option that is being submitted", async () => {
    vi.spyOn(hostClient, "request").mockImplementation(
      () => new Promise(() => {}) as never,
    );
    act(() => {
      useAppStore.getState().setExtensionUiRequest(
        extensionRequest({
          presentation: "inline",
          kind: "select",
          options: [
            { id: "apply", label: "Apply the recommendation", description: "Use shared semantics." },
            { id: "later", label: "Decide later" },
          ],
          allowFreeform: true,
        }),
      );
    });
    const user = userEvent.setup();
    renderRequestSurfaces();

    const option = screen.getByRole("button", {
      name: "Apply the recommendation. Use shared semantics.",
    });
    await user.click(option);

    expect(option).toBeDisabled();
    expect(option).toHaveTextContent("Submitting…");
    expect(screen.getByRole("status")).toHaveTextContent("Submitting…");
    expect(screen.getByRole("button", { name: "Send response" })).toBeDisabled();
  });

  it("submits a labeled input from the keyboard", async () => {
    const hostRequest = vi
      .spyOn(hostClient, "request")
      .mockResolvedValue({ ok: true, result: null } as never);
    act(() => {
      useAppStore.getState().setExtensionUiRequest(
        extensionRequest({
          presentation: "inline",
          kind: "input",
          title: "Provide a branch name",
        }),
      );
    });
    const user = userEvent.setup();
    renderRequestSurfaces();

    const input = screen.getByRole("textbox", { name: "Your response" });
    await user.type(input, "release-candidate{Enter}");

    await waitFor(() => expect(hostRequest).toHaveBeenCalledOnce());
    expect(hostRequest).toHaveBeenCalledWith(
      "extensionUi.respond",
      CONTEXT,
      expect.objectContaining({ status: "resolved", value: "release-candidate" }),
    );
  });

  it("traps modal focus and lets Escape cancel", async () => {
    vi.spyOn(hostClient, "request").mockResolvedValue({ ok: true, result: null } as never);
    act(() => {
      useAppStore.getState().setExtensionUiRequest(extensionRequest());
    });
    const user = userEvent.setup();
    renderRequestSurfaces();

    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus());
    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Confirm" })).toHaveFocus();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(hostClient.request).toHaveBeenCalledWith(
      "extensionUi.respond",
      CONTEXT,
      expect.objectContaining({ status: "cancelled" }),
    );
  });

  it("expires the current request once and advances to the next live request", async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const first = extensionRequest({
      presentation: "inline",
      title: "Expiring request",
      expiresAt: now + 100,
    });
    const next = extensionRequest({ title: "Next modal request" });
    act(() => {
      useAppStore.getState().setExtensionUiRequest(first);
      useAppStore.getState().setExtensionUiRequest(next);
    });
    renderRequestSurfaces();

    expect(screen.getByRole("region", { name: "Expiring request" })).toBeVisible();
    await act(async () => {
      vi.advanceTimersByTime(101);
      await Promise.resolve();
    });

    expect(screen.queryByRole("region")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Next modal request" })).toBeVisible();
    expect(useAppStore.getState().notifications.filter((item) => item.message === "Extension request expired"))
      .toHaveLength(1);
  });
});
