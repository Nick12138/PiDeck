import { describe, expect, it } from "vitest";
import {
  buildAttachmentReferenceBlock,
  parseAttachmentReferences,
  preserveAttachmentReferenceBlocks,
  stripAttachmentReferenceBlocks,
} from "./attachment-references.js";

const attachment = {
  id: "00000000-0000-4000-8000-000000000006",
  name: 'report "Q2".pdf',
  mediaType: "application/pdf" as const,
  sizeBytes: 1_024,
  status: "ready" as const,
  unit: "page" as const,
  unitCount: 12,
};

describe("attachment reference blocks", () => {
  it("round-trips structured references and strips only the hidden block", () => {
    const block = buildAttachmentReferenceBlock([attachment]);
    const text = `Summarize this.\n\n${block}`;

    expect(parseAttachmentReferences(text)).toEqual([
      {
        id: attachment.id,
        name: attachment.name,
        mediaType: attachment.mediaType,
        unit: "page",
        unitCount: 12,
      },
    ]);
    expect(stripAttachmentReferenceBlocks(text)).toBe("Summarize this.");
  });

  it("preserves references when queued visible text is edited", () => {
    const original = `Old text\n\n${buildAttachmentReferenceBlock([attachment])}`;
    const next = preserveAttachmentReferenceBlocks(original, "New text");
    expect(stripAttachmentReferenceBlocks(next)).toBe("New text");
    expect(parseAttachmentReferences(next)).toHaveLength(1);
  });

  it("ignores malformed and non-UUID reference data", () => {
    const text = '<pideck-attachments version="1">[{"id":"bad"}]</pideck-attachments>';
    expect(parseAttachmentReferences(text)).toEqual([]);
  });
});
