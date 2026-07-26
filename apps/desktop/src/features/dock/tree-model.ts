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
  /** Deepest visible row on the current leaf path. */
  isCurrent: boolean;
  /** True when the row is the first of a new branch (a later sibling). */
  branchStart: boolean;
};

const EXCERPT_LIMIT = 96;
const ASSISTANT_PLACEHOLDER = "(assistant message)";

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
        return { kind: "assistant", excerpt: text || ASSISTANT_PLACEHOLDER };
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
 * Conversation-turn view of the tree: keep user/assistant message nodes and
 * collapse everything else (tool results, model changes, session_info, …) so
 * their children reattach to the nearest visible ancestor. A hidden node's
 * branch label survives on its first visible descendant.
 */
export function filterConversationTree(
  nodes: SerializableSessionTreeNode[],
): SerializableSessionTreeNode[] {
  const visit = (node: SerializableSessionTreeNode): SerializableSessionTreeNode[] => {
    const children = node.children.flatMap(visit);
    if (entryExcerpt(node.entry).kind !== "other") {
      return [{ ...node, children }];
    }
    if (node.label && children.length > 0 && !children[0]!.label) {
      children[0] = { ...children[0]!, label: node.label };
    }
    return children;
  };
  return nodes.flatMap(visit);
}

type TurnNode = {
  /** Member entry ids in chain order; the last one is the navigation target. */
  ids: string[];
  kind: TreeRowKind;
  excerpt: string;
  label?: string;
  children: TurnNode[];
};

/**
 * Group the conversation-turn view into turns: a linear run of assistant
 * entries (tool-call segments) collapses into one node ending at the last
 * segment. Branch points break the run so every branch stays addressable.
 */
export function buildConversationTurns(
  nodes: SerializableSessionTreeNode[],
): TurnNode[] {
  const toTurn = (node: SerializableSessionTreeNode): TurnNode => {
    const { kind, excerpt } = entryExcerpt(node.entry);
    const ids = [node.entry.id];
    let turnExcerpt = excerpt;
    let label = node.label;
    let tail = node;
    if (kind === "assistant") {
      while (tail.children.length === 1) {
        const next = tail.children[0]!;
        const nextInfo = entryExcerpt(next.entry);
        if (nextInfo.kind !== "assistant") break;
        ids.push(next.entry.id);
        if (turnExcerpt === ASSISTANT_PLACEHOLDER) turnExcerpt = nextInfo.excerpt;
        if (!label && next.label) label = next.label;
        tail = next;
      }
    }
    return {
      ids,
      kind,
      excerpt: turnExcerpt,
      ...(label ? { label } : {}),
      children: tail.children.map(toTurn),
    };
  };
  return filterConversationTree(nodes).map(toTurn);
}

/**
 * DFS flatten of the conversation turns. The first child continues its
 * parent's depth (trunk); each additional child starts a new branch one level
 * deeper. The current marker lands on the deepest visible turn along the leaf
 * path — the actual leaf entry may be a collapsed one (e.g. a tool result).
 */
export function flattenSessionTree(
  nodes: SerializableSessionTreeNode[],
  leafId: string | null,
): TreeRow[] {
  const path = currentPathIds(nodes, leafId);
  const rows: TreeRow[] = [];
  const members: string[][] = [];
  const visit = (turn: TurnNode, depth: number, branchStart: boolean) => {
    rows.push({
      id: turn.ids[turn.ids.length - 1]!,
      depth,
      kind: turn.kind,
      excerpt: turn.excerpt,
      ...(turn.label ? { label: turn.label } : {}),
      onPath: turn.ids.some((id) => path.has(id)),
      isCurrent: false,
      branchStart,
    });
    members.push(turn.ids);
    turn.children.forEach((child, index) => {
      visit(child, index === 0 ? depth : depth + 1, index > 0);
    });
  };
  buildConversationTurns(nodes).forEach((turn, index) =>
    visit(turn, index === 0 ? 0 : 1, index > 0),
  );
  const rowIndexByMember = new Map<string, number>();
  members.forEach((ids, index) => {
    for (const id of ids) rowIndexByMember.set(id, index);
  });
  for (const id of [...path].reverse()) {
    const index = rowIndexByMember.get(id);
    if (index !== undefined) {
      rows[index]!.isCurrent = true;
      break;
    }
  }
  return rows;
}
