import { describe, expect, it } from "vitest";
import type { SerializableSessionTreeNode } from "@pideck/protocol";
import {
  currentPathIds,
  entryExcerpt,
  filterConversationTree,
  flattenSessionTree,
} from "./tree-model";

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

function otherNode(
  id: string,
  type: string,
  children: SerializableSessionTreeNode[] = [],
  label?: string,
): SerializableSessionTreeNode {
  return { entry: { id, type }, children, ...(label ? { label } : {}) };
}

function toolResultNode(
  id: string,
  children: SerializableSessionTreeNode[] = [],
): SerializableSessionTreeNode {
  return {
    entry: {
      id,
      type: "message",
      message: { role: "toolResult", content: "tool output" },
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

  it("classifies non-conversation entries as other", () => {
    expect(entryExcerpt(otherNode("c", "compaction").entry).kind).toBe("other");
    expect(entryExcerpt(otherNode("m", "model_change").entry).kind).toBe("other");
    expect(entryExcerpt(toolResultNode("t").entry).kind).toBe("other");
  });

  it("truncates long first lines", () => {
    const { excerpt } = entryExcerpt(userNode("u", "x".repeat(200)).entry);
    expect(excerpt.length).toBeLessThanOrEqual(96);
    expect(excerpt.endsWith("…")).toBe(true);
  });
});

// u1 → mc1(model_change) → a1 → { u2 → tr1(toolResult, leaf), h1(labeled) → u3 }
const TREE = [
  userNode("u1", "first ask", [
    otherNode("mc1", "model_change", [
      assistantNode("a1", "the answer", [
        userNode("u2", "trunk follow-up", [toolResultNode("tr1")]),
        otherNode("h1", "branch_summary", [userNode("u3", "abandoned")], "experiment"),
      ]),
    ]),
  ]),
];

describe("filterConversationTree", () => {
  it("collapses non-conversation nodes and reattaches their children", () => {
    const visible = filterConversationTree(TREE);
    expect(visible.map((node) => node.entry.id)).toEqual(["u1"]);
    expect(visible[0]!.children.map((node) => node.entry.id)).toEqual(["a1"]);
    expect(visible[0]!.children[0]!.children.map((node) => node.entry.id)).toEqual([
      "u2",
      "u3",
    ]);
    expect(visible[0]!.children[0]!.children[0]!.children).toEqual([]);
  });

  it("carries a hidden node's label to its first visible descendant", () => {
    const visible = filterConversationTree(TREE);
    const u3 = visible[0]!.children[0]!.children[1]!;
    expect(u3.entry.id).toBe("u3");
    expect(u3.label).toBe("experiment");
  });

  it("drops hidden subtrees without visible descendants", () => {
    expect(
      filterConversationTree([otherNode("m", "model_change", [], "orphan-label")]),
    ).toEqual([]);
  });
});

describe("assistant turn merging", () => {
  it("merges a linear assistant run into one row ending at the last segment", () => {
    const tree = [
      userNode("u1", "ask", [
        assistantNode("a1", "part one", [
          toolResultNode("tr1", [
            assistantNode("a2", "", [
              assistantNode("a3", "final words", [userNode("u2", "next ask")]),
            ]),
          ]),
        ]),
      ]),
    ];
    const rows = flattenSessionTree(tree, "u2");
    expect(rows.map(({ id, kind, depth }) => [id, kind, depth])).toEqual([
      ["u1", "user", 0],
      ["a3", "assistant", 0],
      ["u2", "user", 0],
    ]);
    expect(rows[1]!.excerpt).toBe("part one");
    expect(rows[1]!.onPath).toBe(true);
  });

  it("uses the first segment with text when the run starts without text", () => {
    const tree = [assistantNode("a1", "", [assistantNode("a2", "real answer")])];
    const rows = flattenSessionTree(tree, null);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe("a2");
    expect(rows[0]!.excerpt).toBe("real answer");
  });

  it("marks the merged turn current when the leaf is inside it", () => {
    const tree = [
      userNode("u1", "ask", [assistantNode("a1", "one", [assistantNode("a2", "two")])]),
    ];
    const rows = flattenSessionTree(tree, "a1");
    expect(rows.find((row) => row.id === "a2")?.isCurrent).toBe(true);
  });

  it("does not merge across branch points", () => {
    const tree = [
      assistantNode("a1", "root", [
        assistantNode("a2", "left"),
        assistantNode("a3", "right"),
      ]),
    ];
    const rows = flattenSessionTree(tree, null);
    expect(rows.map(({ id, depth }) => [id, depth])).toEqual([
      ["a1", 0],
      ["a2", 0],
      ["a3", 1],
    ]);
  });
});

describe("flattenSessionTree", () => {
  it("keeps the trunk at depth 0 and pushes later siblings deeper", () => {
    const rows = flattenSessionTree(TREE, "tr1");
    expect(rows.map(({ id, depth }) => [id, depth])).toEqual([
      ["u1", 0],
      ["a1", 0],
      ["u2", 0],
      ["u3", 1],
    ]);
    expect(rows.find((row) => row.id === "u3")?.label).toBe("experiment");
  });

  it("marks the current path and puts the marker on the deepest visible row", () => {
    const rows = flattenSessionTree(TREE, "tr1");
    expect(rows.filter((row) => row.onPath).map((row) => row.id)).toEqual([
      "u1",
      "a1",
      "u2",
    ]);
    expect(rows.filter((row) => row.isCurrent).map((row) => row.id)).toEqual(["u2"]);
  });

  it("follows the marker when the leaf moves to another branch", () => {
    const rows = flattenSessionTree(TREE, "u3");
    expect(rows.filter((row) => row.onPath).map((row) => row.id)).toEqual([
      "u1",
      "a1",
      "u3",
    ]);
    expect(rows.find((row) => row.id === "u3")?.isCurrent).toBe(true);
  });

  it("marks nothing without a leaf", () => {
    expect(currentPathIds(TREE, null).size).toBe(0);
    expect(flattenSessionTree(TREE, null).some((row) => row.isCurrent)).toBe(false);
  });
});
