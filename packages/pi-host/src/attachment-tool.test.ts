import { describe, expect, it, vi } from "vitest";
import { createReadAttachmentTool } from "./attachment-tool.js";
import type { AttachmentStore } from "./attachment-store.js";

const ATTACHMENT_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";

function context() {
  return {
    sessionManager: { getSessionId: () => SESSION_ID },
  } as never;
}

describe("read_attachment tool", () => {
  it("uses the active session and returns a continuation range", async () => {
    const read = vi.fn().mockResolvedValue({
      attachmentId: ATTACHMENT_ID,
      name: "manual.pdf",
      mediaType: "application/pdf",
      unit: "page",
      start: 4,
      end: 5,
      total: 9,
      content: "--- Page 4 ---\nDetails",
      hasMore: true,
      truncated: false,
    });
    const tool = createReadAttachmentTool({ read } as unknown as AttachmentStore);

    const result = await tool.execute(
      "call-1",
      { attachmentId: ATTACHMENT_ID, start: 4, limit: 2 },
      new AbortController().signal,
      () => undefined,
      context(),
    );

    expect(read).toHaveBeenCalledWith({
      attachmentId: ATTACHMENT_ID,
      sessionId: SESSION_ID,
      start: 4,
      limit: 2,
    });
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("Continue at start=6"),
    });
  });

  it("does not hide authorization failures", async () => {
    const read = vi.fn().mockRejectedValue(new Error("Attachment does not belong to this session"));
    const tool = createReadAttachmentTool({ read } as unknown as AttachmentStore);

    await expect(
      tool.execute(
        "call-2",
        { attachmentId: ATTACHMENT_ID },
        new AbortController().signal,
        () => undefined,
        context(),
      ),
    ).rejects.toThrow("does not belong to this session");
  });
});
