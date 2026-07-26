import { describe, expect, it } from "vitest";
import type { SerializableSessionTreeNode } from "@pideck/protocol";
import { currentPathIds, entryExcerpt, flattenSessionTree } from "./tree-model";

function userNode(
  id: string,
  text: string,
  children: SerializableSessionTreeNode[] = [],
  label?: string,
): SerializableSessionTreeNode {
  return {
    entry: { id, type: "message", message: { role: "user", content: text } },
    children,
    ...(label ? { label } : {}),
  };
}

function assistantNode(
  id: string,
  text: string,
  children: SerializableSessionTreeNode[] = [],
): SerializableSessionTreeNode {
  return {
    entry: {
      id,
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text }] },
    },
    children,
  };
}

describe("entryExcerpt", () => {
  it("extracts user and assistant text from string and block content", () => {
    expect(entryExcerpt(userNode("u", "hello\nworld").entry)).toEqual({
      kind: "user",
      excerpt: "hello",
    });
    expect(entryExcerpt(assistantNode("a", "  reply  ").entry)).toEqual({
      kind: "assistant",
      excerpt: "reply",
    });
  });

  it("falls back to the entry type for non-message entries", () => {
    expect(entryExcerpt({ id: "c", type: "compaction" })).toEqual({
      kind: "other",
      excerpt: "compaction",
    });
  });

  it("truncates long first lines", () => {
    const { excerpt } = entryExcerpt(userNode("u", "x".repeat(200)).entry);
    expect(excerpt.length).toBeLessThanOrEqual(96);
    expect(excerpt.endsWith("…")).toBe(true);
  });
});

describe("flattenSessionTree", () => {
  // u1 → a1 → { u2 → a2 (current leaf), u3 (labeled branch) }
  const tree = [
    userNode("u1", "first", [
      assistantNode("a1", "answer", [
        userNode("u2", "trunk follow-up", [assistantNode("a2", "trunk answer")]),
        userNode("u3", "abandoned branch", [], "experiment"),
      ]),
    ]),
  ];

  it("keeps the trunk at depth 0 and pushes later siblings deeper", () => {
    const rows = flattenSessionTree(tree, "a2");
    expect(rows.map(({ id, depth }) => [id, depth])).toEqual([
      ["u1", 0],
      ["a1", 0],
      ["u2", 0],
      ["a2", 0],
      ["u3", 1],
    ]);
  });

  it("marks the current path and leaf", () => {
    const rows = flattenSessionTree(tree, "a2");
    expect(rows.filter((row) => row.onPath).map((row) => row.id)).toEqual([
      "u1",
      "a1",
      "u2",
      "a2",
    ]);
    expect(rows.find((row) => row.id === "a2")?.isLeaf).toBe(true);
    expect(rows.find((row) => row.id === "u3")?.label).toBe("experiment");
  });

  it("marks the abandoned branch as current when the leaf moves", () => {
    const rows = flattenSessionTree(tree, "u3");
    expect(rows.filter((row) => row.onPath).map((row) => row.id)).toEqual([
      "u1",
      "a1",
      "u3",
    ]);
  });

  it("returns an empty path without a leaf", () => {
    expect(currentPathIds(tree, null).size).toBe(0);
  });
});
