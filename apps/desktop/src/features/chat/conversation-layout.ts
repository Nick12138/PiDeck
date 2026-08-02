import type { CSSProperties } from "react";

export const DEFAULT_CONVERSATION_CONTENT_WIDTH = 668;
export const MIN_CONVERSATION_CONTENT_WIDTH = 560;

export function resolveConversationContentWidth(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_CONVERSATION_CONTENT_WIDTH;
  }
  return Math.max(MIN_CONVERSATION_CONTENT_WIDTH, Math.floor(value));
}

export function conversationContentWidthStyle(
  value: number | undefined,
): CSSProperties {
  return {
    "--conversation-content-width": `${resolveConversationContentWidth(value)}px`,
  } as CSSProperties;
}
