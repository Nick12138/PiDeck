import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONVERSATION_CONTENT_WIDTH,
  MIN_CONVERSATION_CONTENT_WIDTH,
  conversationContentWidthStyle,
  resolveConversationContentWidth,
} from "./conversation-layout";

describe("conversation content width", () => {
  it("keeps the current default and enforces the configured minimum", () => {
    expect(resolveConversationContentWidth(undefined)).toBe(
      DEFAULT_CONVERSATION_CONTENT_WIDTH,
    );
    expect(resolveConversationContentWidth(559)).toBe(
      MIN_CONVERSATION_CONTENT_WIDTH,
    );
    expect(resolveConversationContentWidth(920.9)).toBe(920);
  });

  it("exposes the resolved width through the shared CSS property", () => {
    expect(conversationContentWidthStyle(920)).toEqual({
      "--conversation-content-width": "920px",
    });
  });
});
