import { describe, expect, it, vi } from "vitest";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  renderExtensionMessageEntries,
  renderExtensionMessageEntry,
} from "./extension-message-renderer.js";

function sessionWithRenderer(
  renderer: (message: unknown, options: { expanded: boolean }) => unknown,
): AgentSession {
  return {
    extensionRunner: {
      getMessageRenderer: () => renderer,
    },
  } as unknown as AgentSession;
}

const visibleEntry = {
  id: "custom-visible",
  type: "custom_message",
  customType: "dynamic-result",
  content: "Running...",
  display: true,
  details: { requestId: "request-1" },
  timestamp: "2026-08-01T00:00:00.000Z",
};

describe("registered Extension message renderer projection", () => {
  it("renders collapsed and expanded states and strips terminal controls", () => {
    const dispose = vi.fn();
    const renderer = vi.fn((_message, options: { expanded: boolean }) => ({
      render: () => [
        "",
        `\u001b[31m${options.expanded ? "full details" : "summary"}\u001b[0m   `,
        "",
      ],
      invalidate: () => undefined,
      dispose,
    }));

    expect(renderExtensionMessageEntry(sessionWithRenderer(renderer), visibleEntry)).toEqual({
      version: 1,
      collapsed: ["summary"],
      expanded: ["full details"],
    });
    expect(renderer).toHaveBeenCalledTimes(2);
    expect(dispose).toHaveBeenCalledTimes(2);
  });

  it("lets a visible anchor resolve changing in-process renderer state", () => {
    let state = "running";
    const renderer = (_message: unknown, options: { expanded: boolean }) => ({
      render: () => [options.expanded ? `${state}: details` : state],
      invalidate: () => undefined,
    });
    const session = sessionWithRenderer(renderer);

    expect(renderExtensionMessageEntry(session, visibleEntry)?.collapsed).toEqual(["running"]);
    state = "Subagents doctor report";
    expect(renderExtensionMessageEntry(session, visibleEntry)).toMatchObject({
      collapsed: ["Subagents doctor report"],
      expanded: ["Subagents doctor report: details"],
    });
  });

  it("tracks the context message index across non-rendered entries", () => {
    const session = sessionWithRenderer((_message, options: { expanded: boolean }) => ({
      render: () => [options.expanded ? "full" : "summary"],
      invalidate: () => undefined,
    }));

    expect(
      renderExtensionMessageEntries(session, [
        { id: "model", type: "model_change" },
        { id: "user", type: "message" },
        { ...visibleEntry, id: "hidden", display: false },
        visibleEntry,
      ]),
    ).toEqual({
      "custom-visible": {
        version: 1,
        collapsed: ["summary"],
        expanded: ["full"],
        messageIndex: 2,
      },
    });
  });

  it("does not render hidden messages and isolates a throwing renderer", () => {
    const onError = vi.fn();
    const session = sessionWithRenderer(() => {
      throw new Error("renderer failed");
    });
    const renders = renderExtensionMessageEntries(
      session,
      [
        { ...visibleEntry, id: "hidden", display: false },
        visibleEntry,
      ],
      onError,
    );

    expect(renders).toEqual({});
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]?.[0]).toMatchObject({ id: "custom-visible" });
  });
});
