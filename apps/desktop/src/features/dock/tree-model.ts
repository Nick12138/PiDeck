import type { JsonValue, SerializableSessionTreeNode } from "@pideck/protocol";

export type TreeRowKind = "user" | "assistant" | "other";

export type TreeRow = {
  id: string;
  /** Branch depth: siblings after the first start a deeper branch. */
  depth: number;
  kind: TreeRowKind;
  excerpt: string;
  /** Branch label recorded on the node, if any. */
  label?: string;
  /** True when the row lies on the path from the root to the current leaf. */
  onPath: boolean;
  isLeaf: boolean;
};

const EXCERPT_LIMIT = 96;

function firstTextLine(text: string): string {
  const line = text.split("\n").find((candidate) => candidate.trim().length > 0) ?? "";
  const trimmed = line.trim();
  return trimmed.length > EXCERPT_LIMIT
    ? `${trimmed.slice(0, EXCERPT_LIMIT - 1)}…`
    : trimmed;
}

function messageText(content: JsonValue | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  for (const block of content) {
    if (
      typeof block === "object" &&
      block !== null &&
      !Array.isArray(block) &&
      block.type === "text" &&
      typeof block.text === "string"
    ) {
      return block.text;
    }
  }
  return "";
}

export function entryExcerpt(entry: {
  type: string;
  [key: string]: JsonValue | undefined;
}): { kind: TreeRowKind; excerpt: string } {
  if (entry.type === "message") {
    const message = entry.message;
    if (typeof message === "object" && message !== null && !Array.isArray(message)) {
      const role = message.role;
      const text = firstTextLine(messageText(message.content));
      if (role === "user") return { kind: "user", excerpt: text || "(user message)" };
      if (role === "assistant") {
        return { kind: "assistant", excerpt: text || "(assistant message)" };
      }
      return { kind: "other", excerpt: text || String(role ?? entry.type) };
    }
  }
  return { kind: "other", excerpt: entry.type };
}

/** Ids from the root to the entry with `leafId`, or an empty set. */
export function currentPathIds(
  nodes: SerializableSessionTreeNode[],
  leafId: string | null,
): Set<string> {
  const path = new Set<string>();
  if (!leafId) return path;
  const visit = (node: SerializableSessionTreeNode, trail: string[]): boolean => {
    const next = [...trail, node.entry.id];
    if (node.entry.id === leafId) {
      for (const id of next) path.add(id);
      return true;
    }
    return node.children.some((child) => visit(child, next));
  };
  nodes.some((node) => visit(node, []));
  return path;
}

/**
 * DFS flatten. The first child continues its parent's depth (trunk); each
 * additional child starts a new branch one level deeper.
 */
export function flattenSessionTree(
  nodes: SerializableSessionTreeNode[],
  leafId: string | null,
): TreeRow[] {
  const onPath = currentPathIds(nodes, leafId);
  const rows: TreeRow[] = [];
  const visit = (node: SerializableSessionTreeNode, depth: number) => {
    const { kind, excerpt } = entryExcerpt(node.entry);
    rows.push({
      id: node.entry.id,
      depth,
      kind,
      excerpt,
      ...(node.label ? { label: node.label } : {}),
      onPath: onPath.has(node.entry.id),
      isLeaf: node.entry.id === leafId,
    });
    node.children.forEach((child, index) => {
      visit(child, index === 0 ? depth : depth + 1);
    });
  };
  nodes.forEach((node, index) => visit(node, index === 0 ? 0 : 1));
  return rows;
}
