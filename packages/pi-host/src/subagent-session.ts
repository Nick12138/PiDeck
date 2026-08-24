import { readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, sep } from "node:path";
import type {
  JsonValue,
  SerializableSessionEntry,
  SubagentSessionSnapshot,
  SubagentStatusState,
} from "@pideck/protocol";

const MAX_FILES = 512;
const MAX_ENTRIES = 160;
const MAX_STRING_LENGTH = 16_000;
const MAX_TOTAL_TEXT = 240_000;
const MAX_OBJECT_KEYS = 96;
const MAX_ARRAY_ITEMS = 96;

type SessionInfo = { path: string; id: string; name?: string; role?: string };

function roleFromSessionName(name: string | undefined): string | undefined {
  const match = name?.match(/^subagent-([^-]+)-/i);
  return match?.[1]?.trim() || undefined;
}

/** Extracts the real run id from a pi subagent session name such as
 * `subagent-worker-<runId>-1`. Fork-context children (worker/oracle) write
 * their transcript under a generic `forks/` folder whose directory name is
 * the fork session id, not the run id, so the name-encoded run id must win
 * over any directory-derived token. */
function subagentSessionRunToken(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const uuid = name.match(
    /^subagent-[^-]+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:-\d+)?$/i,
  );
  if (uuid) return uuid[1];
  const short = name.match(/^subagent-[^-]+-(.+?)(?:-\d+)?$/i);
  return short?.[1] || undefined;
}

function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 8) return false;
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1));
  return (
    typeof value === "object" &&
    value !== null &&
    Object.values(value).every((item) => isJsonValue(item, depth + 1))
  );
}

function hideAcceptanceReports(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(/```acceptance-report\s*[\s\S]*?```/gi, "");
  }
  if (Array.isArray(value)) return value.map(hideAcceptanceReports);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, hideAcceptanceReports(item)]),
    );
  }
  return value;
}

function boundedJson(value: unknown, budget: { value: number }, depth = 0): JsonValue | undefined {
  if (budget.value <= 0 || depth > 8) return undefined;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    const text = value.slice(0, Math.min(MAX_STRING_LENGTH, budget.value));
    budget.value -= text.length;
    return text;
  }
  if (Array.isArray(value)) {
    const result: JsonValue[] = [];
    for (const item of value.slice(0, MAX_ARRAY_ITEMS)) {
      const next = boundedJson(item, budget, depth + 1);
      if (next !== undefined) result.push(next);
      if (budget.value <= 0) break;
    }
    return result;
  }
  if (typeof value === "object") {
    const result: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
      const next = boundedJson(item, budget, depth + 1);
      if (next !== undefined) result[key.slice(0, 256)] = next;
      if (budget.value <= 0) break;
    }
    return result;
  }
  return undefined;
}

function timestamp(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

function firstUserText(entries: SerializableSessionEntry[]): string | undefined {
  for (const entry of entries) {
    if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") continue;
    const message = entry.message as Record<string, unknown>;
    if (message.role !== "user") continue;
    const content = message.content;
    const parts = Array.isArray(content) ? content : [content];
    const text = parts
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          const record = part as Record<string, unknown>;
          return typeof record.text === "string" ? record.text : "";
        }
        return "";
      })
      .join("\n")
      .replace(/[ \t]+/g, " ")
      .trim();
    if (text) return text;
  }
  return undefined;
}

function displayName(
  sessionName: string | undefined,
  entries: SerializableSessionEntry[],
): string | undefined {
  const normalized = sessionName?.replace(/^subagent-[\w-]+$/i, "").trim();
  if (normalized) return normalized.slice(0, 120);
  const task = firstUserText(entries);
  if (!task) return undefined;
  // Forked workers prepend delegation boilerplate ("Task: [Read from: …]") to
  // the real assignment; skip that source line so the display name reflects the
  // actual task instead of an inherited parent-session message.
  const taskBody = task.replace(/^\s*(?:task:\s*)?\[read from:[^\n]*\]\s*$/gim, "").trim();
  const taskLine = taskBody.match(/(?:^|\n)task:\s*([^\n]+)/i)?.[1] ?? taskBody;
  const clean = (taskLine.split(/[。！？!?，,；;]/, 1)[0] ?? taskLine)
    .replace(/\s+/g, " ")
    .replace(/^(请帮我|请|帮我)\s*/i, "")
    .trim();
  return clean ? clean.slice(0, 120) : undefined;
}

function sessionHeader(path: string): { id?: string; name?: string } | null {
  try {
    const first = readFileSync(path, "utf8").split(/\r?\n/, 1)[0] ?? "";
    const raw = JSON.parse(first) as Record<string, unknown>;
    return raw.type === "session"
      ? {
          ...(typeof raw.id === "string" ? { id: raw.id } : {}),
          ...(typeof raw.name === "string" ? { name: raw.name } : {}),
        }
      : null;
  } catch {
    return null;
  }
}

function allJsonlFiles(root: string): string[] {
  const result: string[] = [];
  const visit = (directory: string) => {
    if (result.length >= MAX_FILES) return;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (result.length >= MAX_FILES) return;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) result.push(path);
    }
  };
  visit(root);
  return result;
}

function readEntries(path: string): {
  entries: SerializableSessionEntry[];
  sessionName?: string;
  truncated: boolean;
} {
  let lines: string[];
  try {
    lines = readFileSync(path, "utf8").split(/\r?\n/);
  } catch {
    return { entries: [], truncated: false };
  }
  const startIndex = forkStartIndex(lines);
  const entries: SerializableSessionEntry[] = [];
  const budget = { value: MAX_TOTAL_TEXT };
  let sessionName: string | undefined;
  let truncated = lines.length - startIndex > MAX_ENTRIES;
  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || !line.trim()) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      truncated = true;
      continue;
    }
    if (!raw || typeof raw !== "object") continue;
    const record = hideAcceptanceReports(raw) as Record<string, unknown>;
    if (record.type === "session_info" && typeof record.name === "string") {
      sessionName = record.name;
    }
    if (typeof record.id !== "string" || typeof record.type !== "string") continue;
    const bounded = boundedJson(record, budget);
    if (
      !bounded ||
      !isJsonValue(bounded) ||
      typeof bounded !== "object" ||
      Array.isArray(bounded)
    ) {
      truncated = true;
      continue;
    }
    entries.push(bounded as SerializableSessionEntry);
    if (budget.value <= 0) {
      truncated = true;
      break;
    }
  }
  return {
    entries: entries.slice(-MAX_ENTRIES),
    ...(sessionName ? { sessionName } : {}),
    truncated: truncated || entries.length > MAX_ENTRIES,
  };
}

/** Fork-context subagent transcripts (worker/oracle) begin with a full copy of
 * the parent session history because pi forks the parent context. The actual
 * child content starts at the child's own `subagent-*` session_info entry.
 * Skipping everything before it keeps the parent conversation out of the
 * subagent panel. Returns the first line index to include (0 when the file is
 * not such a fork or no child marker is found). The last `subagent-*` marker
 * wins so nested forks resolve to the innermost child. */
function forkStartIndex(lines: string[]): number {
  if (lines.length === 0) return 0;
  const firstLine = lines[0];
  if (firstLine === undefined) return 0;
  let header: unknown;
  try {
    header = JSON.parse(firstLine);
  } catch {
    return 0;
  }
  if (!header || typeof header !== "object") return 0;
  const first = header as { type?: unknown; parentSession?: unknown };
  if (first.type !== "session" || typeof first.parentSession !== "string") return 0;
  let start = 0;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || !line.trim()) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    if (!raw || typeof raw !== "object") continue;
    const record = raw as { type?: unknown; name?: unknown };
    if (
      record.type === "session_info" &&
      typeof record.name === "string" &&
      subagentSessionRunToken(record.name) !== undefined
    ) {
      start = index;
    }
  }
  return start;
}

function matchesNode(path: string, nodeId: string, sessionId: string): boolean {
  const normalized = nodeId.trim().toLowerCase();
  const token = normalized.startsWith("external:")
    ? normalized.split(":").filter(Boolean).at(-1)
    : normalized;
  if (!token) return false;
  if (`${path}\n${sessionId}`.toLowerCase().includes(token)) return true;
  // Fork transcripts live under a `forks/` directory that is not named after
  // the run, so fall back to the run id encoded in the child session name.
  return sessionFileHasRunToken(path, token);
}

/** True when a session file contains a pi `subagent-<role>-<runId>-<n>` name
 * whose run id matches the token. Only fork transcripts carry the run id
 * inside their content (under a generic `forks/` folder); everything else
 * matches via path/session id. Only session/session_info headers are inspected
 * (never tool-result payloads) so the parent session itself can never match.
 * Reading is bounded to keep unrelated sessions cheap. */
function sessionFileHasRunToken(path: string, token: string): boolean {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return false;
  }
  const firstLineEnd = text.indexOf("\n");
  const firstLine = firstLineEnd === -1 ? text : text.slice(0, firstLineEnd);
  let header: unknown;
  try {
    header = JSON.parse(firstLine);
  } catch {
    return false;
  }
  if (
    !header ||
    typeof header !== "object" ||
    (header as { type?: unknown }).type !== "session" ||
    typeof (header as { parentSession?: unknown }).parentSession !== "string"
  ) {
    return false;
  }
  if (text.length > 512 * 1024) text = text.slice(0, 512 * 1024);
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes("session_info") && !line.includes('"type":"session"')) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    if (!raw || typeof raw !== "object") continue;
    const record = raw as { type?: unknown; name?: unknown };
    if (typeof record.name !== "string") continue;
    if (subagentSessionRunToken(record.name) === token) return true;
  }
  return false;
}

function findSession(sessionsDir: string, nodeId: string): SessionInfo | null {
  const candidates: SessionInfo[] = [];
  for (const path of allJsonlFiles(sessionsDir)) {
    try {
      const first = readFileSync(path, "utf8").split(/\r?\n/, 1)[0] ?? "";
      const header = JSON.parse(first) as Record<string, unknown>;
      if (header.type !== "session" || typeof header.id !== "string") continue;
      if (!matchesNode(path, nodeId, header.id)) continue;
      candidates.push({
        path,
        id: header.id,
        ...(typeof header.name === "string" ? { name: header.name } : {}),
        ...(roleFromSessionName(typeof header.name === "string" ? header.name : undefined)
          ? { role: roleFromSessionName(typeof header.name === "string" ? header.name : undefined) }
          : {}),
      });
    } catch {
      // Ignore partial or unrelated JSONL files.
    }
  }
  candidates.sort((left, right) => {
    try {
      return statSync(right.path).mtimeMs - statSync(left.path).mtimeMs;
    } catch {
      return 0;
    }
  });
  return candidates[0] ?? null;
}

export function findSubagentSessionInfo(
  sessionsDir: string,
  nodeId: string,
): { sessionId: string; name?: string; role?: string } | null {
  const session = findSession(sessionsDir, nodeId);
  if (!session) return null;
  const parsed = readEntries(session.path);
  const sourceName = parsed.sessionName ?? session.name;
  const name = displayName(sourceName, parsed.entries);
  const role = session.role ?? roleFromSessionName(sourceName);
  return {
    sessionId: session.id,
    ...(name ? { name } : {}),
    ...(role ? { role } : {}),
  };
}

export type DiscoveredSubagentSession = {
  nodeId: string;
  sessionId: string;
  name?: string;
  role?: string;
};

/** Discover child sessions written below the currently active Pi parent.
 * Workflow/container metadata is intentionally ignored; each returned item
 * corresponds to a real child session that can be opened and polled. */
export function listSubagentSessions(
  sessionsDir: string,
  preferredSessionId?: string | null,
): DiscoveredSubagentSession[] {
  if (!preferredSessionId) return [];
  const parent = allJsonlFiles(sessionsDir).find((path) => {
    if (relative(sessionsDir, path).includes(sep)) return false;
    try {
      const first = readFileSync(path, "utf8").split(/\r?\n/, 1)[0] ?? "";
      const header = JSON.parse(first) as Record<string, unknown>;
      return header.type === "session" && header.id === preferredSessionId;
    } catch {
      return false;
    }
  });
  if (!parent) return [];

  const parentDirectory = join(sessionsDir, basename(parent, ".jsonl"));
  const discovered = new Map<string, DiscoveredSubagentSession>();
  for (const path of allJsonlFiles(parentDirectory)) {
    const childRelative = relative(parentDirectory, path);
    if (!childRelative || childRelative.startsWith("..") || childRelative === path) continue;
    const directoryToken = childRelative.split(sep)[0];
    if (!directoryToken || directoryToken === "run-0" || !path.endsWith(".jsonl")) continue;
    const first = sessionHeader(path);
    if (!first?.id) continue;
    const parsed = readEntries(path);
    const sourceName = parsed.sessionName ?? first.name;
    // The run id encoded in the child session name is authoritative; fork
    // transcripts live under a generic `forks/` folder that is not the run id.
    const runToken = subagentSessionRunToken(sourceName) ?? directoryToken;
    const name = displayName(sourceName, parsed.entries);
    const role = roleFromSessionName(sourceName);
    discovered.set(runToken, {
      nodeId: `external:${preferredSessionId}:${runToken}`,
      sessionId: first.id,
      ...(name ? { name } : {}),
      ...(role ? { role } : {}),
    });
  }
  return [...discovered.values()];
}

function normalizeSubagentState(value: unknown): SubagentStatusState | undefined {
  switch (value) {
    case "queued":
    case "pending":
      return "queued";
    case "running":
    case "active":
      return "running";
    case "completed":
    case "complete":
      return "complete";
    case "failed":
    case "error":
      return "failed";
    case "paused":
      return "paused";
    case "stopped":
    case "cancelled":
      return "stopped";
    case "rejected":
      return "rejected";
    default:
      return undefined;
  }
}

function statusFromAsyncRuns(
  sessionsDir: string,
  preferredSessionId: string,
  runId: string,
): SubagentStatusState | undefined {
  const parentFile = allJsonlFiles(sessionsDir).find(
    (path) =>
      relative(sessionsDir, path).split(sep).length === 1 &&
      sessionHeader(path)?.id === preferredSessionId,
  );
  if (!parentFile) return undefined;
  const parentName = basename(parentFile);
  try {
    for (const tempEntry of readdirSync(tmpdir(), { withFileTypes: true })) {
      if (!tempEntry.isDirectory() || !tempEntry.name.startsWith("pi-subagents-")) continue;
      const root = join(tmpdir(), tempEntry.name, "async-subagent-runs");
      let directories;
      try {
        directories = readdirSync(root, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const directory of directories) {
        if (!directory.isDirectory()) continue;
        try {
          const status = JSON.parse(
            readFileSync(join(root, directory.name, "status.json"), "utf8"),
          ) as {
            sessionId?: unknown;
            runId?: unknown;
            state?: unknown;
            steps?: Array<{ runId?: unknown; status?: unknown }>;
          };
          if (
            status.sessionId !== preferredSessionId &&
            status.sessionId !== parentFile &&
            status.sessionId !== parentName
          )
            continue;
          const candidates = [
            { runId: status.runId, state: status.state },
            ...(status.steps ?? []).map((step) => ({ runId: step.runId, state: step.status })),
          ];
          const match = candidates.find((candidate) => candidate.runId === runId);
          if (!match) continue;
          return normalizeSubagentState(match.state) ?? "running";
        } catch {
          // Ignore incomplete status files.
        }
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function stateForNode(sessionsDir: string, nodeId: string): SubagentStatusState {
  if (!nodeId.startsWith("external:")) return "running";
  const parts = nodeId.split(":");
  const parentSessionId = parts[1];
  const runId = parts.slice(2).join(":");
  return resolveExternalRunState(sessionsDir, parentSessionId, runId);
}

/** Resolve a subagent run's state from every source available to a file-only
 * bridge: async-run status files, parent-session completion notifications, and
 * the mission record embedded in the parent's `subagent` tool result (which is
 * what foreground runs produce instead of a notification). */
export function resolveExternalRunState(
  sessionsDir: string,
  parentSessionId: string | null | undefined,
  runId: string | null | undefined,
): SubagentStatusState {
  if (!parentSessionId || !runId) return "running";
  const asyncState = statusFromAsyncRuns(sessionsDir, parentSessionId, runId);
  if (asyncState) return asyncState;
  const parent = allJsonlFiles(sessionsDir).find((path) => {
    if (relative(sessionsDir, path).includes(sep)) return false;
    return sessionHeader(path)?.id === parentSessionId;
  });
  if (!parent) return "running";
  try {
    for (const line of readFileSync(parent, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      if (
        !line.includes('"customType":"subagent-notify"') &&
        !line.includes('"toolName":"subagent"')
      )
        continue;
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        continue;
      }
      if (!raw || typeof raw !== "object") continue;
      const record = raw as {
        type?: unknown;
        customType?: unknown;
        content?: unknown;
        message?: { role?: unknown; toolName?: unknown; details?: unknown };
      };
      if (record.type === "custom_message" && record.customType === "subagent-notify") {
        const content = record.content;
        if (typeof content !== "string") continue;
        const notifiedRunId = content.match(/"runId"\s*:\s*"([^"\r\n]+)"/)?.[1];
        if (notifiedRunId !== runId) continue;
        if (/Background task stopped|Workflow stopped|stopped by user/i.test(content))
          return "stopped";
        if (/Background task failed|Workflow failed/i.test(content)) return "failed";
        if (/Background task completed|Workflow completed/i.test(content)) return "complete";
        continue;
      }
      const message = record.message;
      if (
        !message ||
        typeof message !== "object" ||
        message.role !== "toolResult" ||
        message.toolName !== "subagent"
      )
        continue;
      const details =
        message.details !== undefined && typeof message.details === "object"
          ? (message.details as Record<string, unknown>)
          : undefined;
      if (!details) continue;
      const mission =
        typeof details.mission === "object" && details.mission !== null
          ? (details.mission as Record<string, unknown>)
          : undefined;
      if (mission) {
        const runs = mission.runs;
        if (Array.isArray(runs)) {
          for (const run of runs) {
            if (!run || typeof run !== "object") continue;
            const candidate = run as Record<string, unknown>;
            if (candidate.runId !== runId) continue;
            const status = normalizeMissionState(candidate.status);
            if (status) return status;
          }
        }
        if (details.runId === runId) {
          const status = normalizeMissionState(mission.status);
          if (status) return status;
        }
      }
    }
  } catch {
    return "running";
  }
  return "running";
}

function normalizeMissionState(value: unknown): SubagentStatusState | undefined {
  switch (value) {
    case "completed":
    case "complete":
      return "complete";
    case "failed":
      return "failed";
    case "stopped":
    case "cancelled":
      return "stopped";
    case "queued":
    case "pending":
      return "queued";
    case "paused":
      return "paused";
    default:
      return undefined;
  }
}

export function readSubagentSession(
  sessionsDir: string,
  nodeId: string,
): SubagentSessionSnapshot | null {
  const session = findSession(sessionsDir, nodeId);
  if (!session) return null;
  const parsed = readEntries(session.path);
  const name = displayName(parsed.sessionName ?? session.name, parsed.entries);
  const updatedAt = (() => {
    try {
      return statSync(session.path).mtimeMs;
    } catch {
      return Date.now();
    }
  })();
  return {
    nodeId,
    sessionId: session.id,
    ...(name ? { name } : {}),
    state: stateForNode(sessionsDir, nodeId),
    entries: parsed.entries,
    truncated: parsed.truncated,
    updatedAt,
  };
}

export function subagentSessionNodeIdCandidates(nodeId: string): string[] {
  return [nodeId];
}
