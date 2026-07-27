import { describe, expect, it } from "vitest";
import { parseExtensionPresentation } from "./extension-presentation.js";

const REQUEST_ID = "11111111-1111-4111-8111-111111111111";

describe("Extension presentation", () => {
  it("accepts a portable decision presentation", () => {
    const presentation = {
      version: 1,
      extensionId: "pi-subagents",
      sourceLabel: "Subagents",
      audience: "user",
      kind: "decision",
      status: "pending",
      severity: "warning",
      correlationId: "decision-1",
      groupKey: "run-1",
      title: "Research agent needs a decision",
      summary: "Choose how the agent should continue.",
      actionRequestId: REQUEST_ID,
      technicalDetails: { childIndex: 1 },
    } as const;

    expect(parseExtensionPresentation(presentation)).toEqual(presentation);
  });

  it.each([
    { version: 2, extensionId: "x", audience: "agent", kind: "activity", correlationId: "1" },
    { version: 1, extensionId: "", audience: "agent", kind: "activity", correlationId: "1" },
    { version: 1, extensionId: "x", audience: "everyone", kind: "activity", correlationId: "1" },
    { version: 1, extensionId: "x", audience: "agent", kind: "html", correlationId: "1" },
    { version: 1, extensionId: "x", audience: "agent", kind: "activity", correlationId: "" },
    {
      version: 1,
      extensionId: "x",
      audience: "agent",
      kind: "activity",
      correlationId: "1",
      actionRequestId: REQUEST_ID,
    },
    {
      version: 1,
      extensionId: "x",
      audience: "agent",
      kind: "activity",
      correlationId: "1",
      extra: true,
    },
  ])("rejects unsafe or malformed presentation %#", (value) => {
    expect(parseExtensionPresentation(value)).toBeNull();
  });
});
