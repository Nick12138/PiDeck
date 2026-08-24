import { readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { HostIdentity, SubagentStatusNode, SubagentsStatusSnapshot } from "@pideck/protocol";
import {
  findSubagentSessionInfo,
  listSubagentSessions,
  resolveExternalRunState,
  type DiscoveredSubagentSession,
} from "./subagent-session.js";

const RPC_READY_EVENT = "subagents:rpc:v1:ready";
const RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
const RPC_REPLY_PREFIX = "subagents:rpc:v1:reply:";
const RPC_VERSION = 1;
const POLL_MS = 750;
const EXTERNAL_SCAN_MS = 1_000;
const MAX_EXTERNAL_SESSIONS = 64;
const MAX_EXTERNAL_RUNS = 48;

type RpcReply = {
  success?: boolean;
  data?: {
    fleet?: {
      entries?: SubagentsStatusSnapshot["fleet"];
      totalActive?: number;
      omitted?: number;
    };
    asyncSnapshot?: { runs?: SubagentsStatusSnapshot["runs"] };
  };
};

function unavailable(): SubagentsStatusSnapshot {
  return {
    version: 1,
    available: false,
    generatedAt: Date.now(),
    totalActive: 0,
    omitted: 0,
    fleet: [],
    runs: [],
  };
}

export function externalCompletedRuns(
  sessionsDir: string,
  preferredSessionId?: string | null,
): SubagentStatusNode[] {
  let sessionFiles: string[];
  try {
    sessionFiles = readdirSync(sessionsDir)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => join(sessionsDir, name))
      .sort((left, right) => {
        try {
          return statSync(right).mtimeMs - statSync(left).mtimeMs;
        } catch {
          return 0;
        }
      });
  } catch {
    return [];
  }

  // A PiDeck Host and an interactive Pi process do not share an in-memory
  // event bus. Prefer the active session identified by the Host. This matters
  // when several named sessions in the same workspace have child-run history.
  if (preferredSessionId) {
    const preferred = sessionFiles.find((sessionFile) => {
      try {
        const firstLine = readFileSync(sessionFile, "utf8").split(/\r?\n/, 1)[0] ?? "";
        const header = JSON.parse(firstLine) as { type?: unknown; id?: unknown };
        return header.type === "session" && header.id === preferredSessionId;
      } catch {
        return false;
      }
    });
    sessionFiles = preferred ? [preferred] : [];
  } else {
    sessionFiles = sessionFiles.slice(0, MAX_EXTERNAL_SESSIONS);
  }

  for (const sessionFile of sessionFiles) {
    let text: string;
    try {
      text = readFileSync(sessionFile, "utf8");
    } catch {
      continue;
    }
    if (!text.includes('"customType":"subagent-notify"')) continue;

    const runs: SubagentStatusNode[] = [];
    const sessionId = basename(sessionFile, ".jsonl");
    for (const line of text.split(/\r?\n/)) {
      if (!line.includes('"customType":"subagent-notify"')) continue;
      let content = "";
      try {
        content = notificationContent(JSON.parse(line));
      } catch {
        continue;
      }
      const state = /Background task failed|Workflow failed/i.test(content)
        ? "failed"
        : /Background task stopped|Workflow stopped|stopped by user/i.test(content)
          ? "stopped"
          : /Background task completed|Workflow completed/i.test(content)
            ? "complete"
            : undefined;
      if (!state) continue;
      const runId = content.match(/"runId"\s*:\s*"([^"\r\n]+)"/)?.[1];
      if (!runId) continue;
      const agent = content.match(/"agent"\s*:\s*"([^"\r\n]+)"/)?.[1];
      const output = content.match(/"output"\s*:\s*"([^"\r\n]*)"/)?.[1];
      const nodeId = `external:${sessionId}:${runId}`;
      const sessionInfo = findSubagentSessionInfo(sessionsDir, nodeId);
      const role = agent ?? sessionInfo?.role ?? "subagent";
      runs.push({
        id: nodeId,
        kind: "subagent",
        label: agent ?? sessionInfo?.name ?? "Subagent",
        role,
        ...(sessionInfo?.name ? { name: sessionInfo.name } : {}),
        state,
        activity: output ? { state: output } : undefined,
      });
      if (runs.length >= MAX_EXTERNAL_RUNS)
        return runs.filter((run) => !isOrphanedTerminalRun(run, sessionsDir));
    }
    if (runs.length > 0) return runs.filter((run) => !isOrphanedTerminalRun(run, sessionsDir));
  }
  return [];
}

/** Runs that ended in failure (or were stopped/rejected) without producing any
 * child session file cannot be opened (subagents.getSession returns
 * SESSION_NOT_FOUND) and are hidden from the panel entirely. Active runs keep
 * showing even before a session file exists. */
function isOrphanedTerminalRun(node: SubagentStatusNode, sessionsDir?: string): boolean {
  if (!sessionsDir) return false;
  if (node.state !== "failed" && node.state !== "stopped" && node.state !== "rejected") {
    return false;
  }
  return findSubagentSessionInfo(sessionsDir, node.id) === null;
}

const BUILTIN_ROLES = new Set([
  "scout",
  "researcher",
  "worker",
  "reviewer",
  "delegate",
  "oracle",
  "advisor",
]);

function enrichNode(
  node: SubagentStatusNode,
  sessionsDir?: string,
  fleetRoles: string[] = [],
  fleetRoleIndex = { value: 0 },
  runAgents = new Map<string, string>(),
): SubagentStatusNode {
  const sessionInfo = sessionsDir ? findSubagentSessionInfo(sessionsDir, node.id) : null;
  const nodeRole = node.role?.trim();
  const labelRole = BUILTIN_ROLES.has(node.label.trim().toLowerCase())
    ? node.label.trim()
    : undefined;
  const fallbackRole = fleetRoles[fleetRoleIndex.value];
  const role =
    nodeRole ||
    sessionInfo?.role ||
    runAgents.get(node.id) ||
    runAgents.get(node.id.split(":").at(-1) ?? "") ||
    labelRole ||
    (fallbackRole && node.label.trim().toLowerCase() === "subagent" ? fallbackRole : undefined) ||
    (node.kind === "workflow" ? "workflow" : node.label);
  if (!nodeRole && !labelRole && fallbackRole && node.label.trim().toLowerCase() === "subagent") {
    fleetRoleIndex.value += 1;
  }
  return {
    ...node,
    role,
    ...(sessionInfo?.name ? { name: sessionInfo.name } : {}),
    ...(node.children
      ? {
          children: node.children.map((child) =>
            enrichNode(child, sessionsDir, fleetRoles, fleetRoleIndex, runAgents),
          ),
        }
      : {}),
  };
}

function notificationContent(raw: unknown): string {
  if (!raw || typeof raw !== "object") return "";
  const record = raw as { content?: unknown; message?: { content?: unknown } };
  if (typeof record.content === "string") return record.content;
  const content = record.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      typeof part === "string"
        ? part
        : part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
          ? (part as { text: string }).text
          : "",
    )
    .join("\n");
}

function normalizeSubagentState(value: unknown): SubagentStatusNode["state"] | undefined {
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

function terminalState(value: unknown): SubagentStatusNode["state"] | undefined {
  const state = normalizeSubagentState(value);
  return state && state !== "queued" && state !== "running" ? state : undefined;
}

function asyncRunAgents(sessionsDir: string, preferredSessionId: string): Map<string, string> {
  const agents = new Map<string, string>();
  let parentFile: string | undefined;
  try {
    parentFile = readdirSync(sessionsDir)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => join(sessionsDir, name))
      .find((path) => {
        try {
          const header = JSON.parse(readFileSync(path, "utf8").split(/\r?\n/, 1)[0] ?? "") as {
            type?: unknown;
            id?: unknown;
          };
          return header.type === "session" && header.id === preferredSessionId;
        } catch {
          return false;
        }
      });
  } catch {
    return new Map();
  }
  if (!parentFile) return new Map();
  const parentName = basename(parentFile);
  try {
    for (const tempEntry of readdirSync(tmpdir(), { withFileTypes: true })) {
      if (!tempEntry.isDirectory() || !tempEntry.name.startsWith("pi-subagents-")) continue;
      const runsRoot = join(tmpdir(), tempEntry.name, "async-subagent-runs");
      for (const runDirectory of readdirSync(runsRoot, { withFileTypes: true })) {
        if (!runDirectory.isDirectory()) continue;
        try {
          const status = JSON.parse(
            readFileSync(join(runsRoot, runDirectory.name, "status.json"), "utf8"),
          ) as {
            sessionId?: unknown;
            runId?: unknown;
            agent?: unknown;
            steps?: Array<{ runId?: unknown; agent?: unknown }>;
          };
          if (
            status.sessionId !== preferredSessionId &&
            status.sessionId !== parentFile &&
            status.sessionId !== parentName
          )
            continue;
          if (typeof status.runId === "string" && typeof status.agent === "string") {
            agents.set(status.runId, status.agent);
          }
          for (const step of status.steps ?? []) {
            if (typeof step.runId === "string" && typeof step.agent === "string") {
              agents.set(step.runId, step.agent);
            }
          }
        } catch {
          // Ignore incomplete status files.
        }
      }
    }
  } catch {
    return new Map();
  }
  return agents;
}

function asyncRunStates(
  sessionsDir: string,
  preferredSessionId: string,
): Map<string, SubagentStatusNode["state"]> {
  const parentFile = readdirSync(sessionsDir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => join(sessionsDir, name))
    .find((path) => {
      try {
        const first = readFileSync(path, "utf8").split(/\r?\n/, 1)[0] ?? "";
        const header = JSON.parse(first) as { type?: unknown; id?: unknown };
        return header.type === "session" && header.id === preferredSessionId;
      } catch {
        return false;
      }
    });
  if (!parentFile) return new Map();
  const parentName = basename(parentFile);
  const states = new Map<string, SubagentStatusNode["state"]>();
  try {
    for (const tempEntry of readdirSync(tmpdir(), { withFileTypes: true })) {
      if (!tempEntry.isDirectory() || !tempEntry.name.startsWith("pi-subagents-")) continue;
      const runsRoot = join(tmpdir(), tempEntry.name, "async-subagent-runs");
      let runDirectories;
      try {
        runDirectories = readdirSync(runsRoot, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const runDirectory of runDirectories) {
        if (!runDirectory.isDirectory()) continue;
        try {
          const status = JSON.parse(
            readFileSync(join(runsRoot, runDirectory.name, "status.json"), "utf8"),
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
          const rootState = terminalState(status.state);
          if (typeof status.runId === "string" && rootState) states.set(status.runId, rootState);
          for (const step of status.steps ?? []) {
            const state = terminalState(step.status);
            if (typeof step.runId === "string" && state) states.set(step.runId, state);
          }
        } catch {
          // Ignore incomplete status files while a run is being created.
        }
      }
    }
  } catch {
    // Temp directory discovery is best effort.
  }
  return states;
}

function externalRunStates(
  sessionsDir: string,
  preferredSessionId: string | null,
): Map<string, SubagentStatusNode["state"]> {
  if (!preferredSessionId) return new Map();
  let parentFile: string | undefined;
  try {
    parentFile = readdirSync(sessionsDir)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => join(sessionsDir, name))
      .find((path) => {
        try {
          const first = readFileSync(path, "utf8").split(/\r?\n/, 1)[0] ?? "";
          const header = JSON.parse(first) as { type?: unknown; id?: unknown };
          return header.type === "session" && header.id === preferredSessionId;
        } catch {
          return false;
        }
      });
  } catch {
    return new Map();
  }
  if (!parentFile) return new Map();
  try {
    const text = readFileSync(parentFile, "utf8");
    const states = new Map<string, SubagentStatusNode["state"]>();
    for (const line of text.split(/\r?\n/)) {
      if (!line.includes('"customType":"subagent-notify"')) continue;
      let content = "";
      try {
        content = notificationContent(JSON.parse(line));
      } catch {
        continue;
      }
      const runId = content.match(/"runId"\s*:\s*"([^"\r\n]+)"/)?.[1];
      if (!runId) continue;
      if (/Background task failed|Workflow failed/i.test(content)) states.set(runId, "failed");
      else if (/Background task stopped|Workflow stopped|stopped by user/i.test(content))
        states.set(runId, "stopped");
      else if (/Background task completed|Workflow completed/i.test(content))
        states.set(runId, "complete");
    }
    for (const [runId, state] of asyncRunStates(sessionsDir, preferredSessionId)) {
      states.set(runId, state);
    }
    return states;
  } catch {
    return new Map();
  }
}

export function resolveSubagentStopRunId(
  sessionsDir: string,
  preferredSessionId: string,
  requestedRunId: string,
): string {
  let parentFile: string | undefined;
  try {
    parentFile = readdirSync(sessionsDir)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => join(sessionsDir, name))
      .find((path) => {
        try {
          const header = JSON.parse(readFileSync(path, "utf8").split(/\r?\n/, 1)[0] ?? "") as {
            type?: unknown;
            id?: unknown;
          };
          return header.type === "session" && header.id === preferredSessionId;
        } catch {
          return false;
        }
      });
  } catch {
    return requestedRunId;
  }
  if (!parentFile) return requestedRunId;
  const parentName = basename(parentFile);
  try {
    for (const tempEntry of readdirSync(tmpdir(), { withFileTypes: true })) {
      if (!tempEntry.isDirectory() || !tempEntry.name.startsWith("pi-subagents-")) continue;
      const runsRoot = join(tmpdir(), tempEntry.name, "async-subagent-runs");
      let runDirectories;
      try {
        runDirectories = readdirSync(runsRoot, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const runDirectory of runDirectories) {
        if (!runDirectory.isDirectory()) continue;
        try {
          const status = JSON.parse(
            readFileSync(join(runsRoot, runDirectory.name, "status.json"), "utf8"),
          ) as {
            sessionId?: unknown;
            runId?: unknown;
            steps?: Array<{ runId?: unknown }>;
          };
          if (
            status.sessionId !== preferredSessionId &&
            status.sessionId !== parentFile &&
            status.sessionId !== parentName
          )
            continue;
          if (status.runId === requestedRunId) return requestedRunId;
          if (status.steps?.some((step) => step.runId === requestedRunId)) {
            return typeof status.runId === "string" ? status.runId : requestedRunId;
          }
        } catch {
          // Ignore incomplete status files.
        }
      }
    }
  } catch {
    return requestedRunId;
  }
  return requestedRunId;
}

function roleFromSessionName(name: string | undefined): string | undefined {
  const match = name?.match(/^subagent-([^-]+)-/i);
  return match?.[1]?.trim() || undefined;
}

export function externalRunAgents(
  sessionsDir: string,
  preferredSessionId: string | null,
): Map<string, string> {
  if (!preferredSessionId) return new Map();
  const parentFile = readdirSync(sessionsDir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => join(sessionsDir, name))
    .find((path) => {
      try {
        const firstLine = readFileSync(path, "utf8").split(/\r?\n/, 1)[0] ?? "";
        const header = JSON.parse(firstLine) as { type?: unknown; id?: unknown };
        return header.type === "session" && header.id === preferredSessionId;
      } catch {
        return false;
      }
    });
  if (!parentFile) return new Map();

  const agents = new Map<string, string>();
  try {
    for (const line of readFileSync(parentFile, "utf8").split(/\r?\n/)) {
      if (!line.includes('"customType":"subagent-notify"')) continue;
      const content = notificationContent(JSON.parse(line));
      if (!content) continue;
      const runId = content.match(/"runId"\s*:\s*"([^"\r\n]+)"/)?.[1]?.trim();
      const agent = content.match(/"agent"\s*:\s*"([^"\r\n]+)"/)?.[1]?.trim();
      if (agent && runId) agents.set(runId, agent);
      for (const match of content.matchAll(
        /"runId"\s*:\s*"([^"\r\n]+)"[\s\S]{0,1200}?"agent"\s*:\s*"([^"\r\n]+)"/g,
      )) {
        const runId = match[1]?.trim();
        const agent = match[2]?.trim();
        if (agent && runId) agents.set(runId, agent);
      }
    }
  } catch {
    return new Map();
  }
  return agents;
}

function statusBackedExternalRuns(
  sessionsDir: string,
  preferredSessionId: string,
): SubagentStatusNode[] {
  const sessions = listSubagentSessions(sessionsDir, preferredSessionId);
  const byRunId = new Map(
    sessions.map((session) => [session.nodeId.split(":").at(-1) ?? "", session]),
  );
  const states = new Map<string, SubagentStatusNode["state"]>();
  const labels = new Map<string, { label?: string; role?: string }>();
  const parentFile = readdirSync(sessionsDir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => join(sessionsDir, name))
    .find((path) => {
      try {
        const header = JSON.parse(readFileSync(path, "utf8").split(/\r?\n/, 1)[0] ?? "") as {
          type?: unknown;
          id?: unknown;
        };
        return header.type === "session" && header.id === preferredSessionId;
      } catch {
        return false;
      }
    });
  if (!parentFile) return [];
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
            steps?: Array<{
              runId?: unknown;
              agent?: unknown;
              label?: unknown;
              status?: unknown;
              sessionFile?: unknown;
            }>;
          };
          if (
            status.sessionId !== preferredSessionId &&
            status.sessionId !== parentFile &&
            status.sessionId !== parentName
          )
            continue;
          for (const step of status.steps ?? []) {
            const sessionToken =
              typeof step.sessionFile === "string"
                ? step.sessionFile.match(/[\\/]([^\\/]+)[\\/]run-0[\\/]session\.jsonl$/)?.[1]
                : undefined;
            const runId =
              (typeof step.runId === "string" && step.runId) || sessionToken || undefined;
            if (!runId) continue;
            const state = normalizeSubagentState(step.status) ?? "running";
            states.set(runId, state);
            labels.set(runId, {
              ...(typeof step.label === "string" ? { label: step.label } : {}),
              ...(typeof step.agent === "string" ? { role: step.agent } : {}),
            });
          }
        } catch {
          // Ignore incomplete status files while a run is being created.
        }
      }
    }
  } catch {
    // Temp directory discovery is best effort.
  }

  const agents = externalRunAgents(sessionsDir, preferredSessionId);
  for (const session of sessions) {
    const runId = session.nodeId.split(":").at(-1) ?? "";
    if (!states.has(runId)) {
      // Foreground runs never write an async status file nor emit a
      // notification; their completion is recorded in the parent session's
      // subagent tool-result mission, so resolve from there instead of leaving
      // a finished run stuck in "running".
      states.set(runId, resolveExternalRunState(sessionsDir, preferredSessionId, runId));
    }
  }
  const mapped: SubagentStatusNode[] = [...new Set([...states.keys(), ...byRunId.keys()])]
    .slice(0, MAX_EXTERNAL_RUNS)
    .map((runId) => {
      const session = byRunId.get(runId);
      const metadata = labels.get(runId);
      const role = agents.get(runId) ?? metadata?.role ?? session?.role ?? "subagent";
      return {
        id: `external:${preferredSessionId}:${runId}`,
        kind: "subagent",
        label: session?.name ?? metadata?.label ?? "Subagent",
        role,
        ...(session?.name ? { name: session.name } : {}),
        state: states.get(runId) ?? "running",
      };
    });
  return mapped.filter((run) => !isOrphanedTerminalRun(run, sessionsDir));
}

function liveExternalRuns(
  sessionsDir: string,
  preferredSessionId: string | null,
): SubagentStatusNode[] {
  if (!preferredSessionId) return [];
  return statusBackedExternalRuns(sessionsDir, preferredSessionId);
}

function normalizeSnapshot(
  data: RpcReply["data"],
  sessionsDir?: string,
  preferredSessionId?: string | null,
): SubagentsStatusSnapshot {
  const fleet = Array.isArray(data?.fleet?.entries) ? data.fleet.entries : [];
  const fleetRoles = fleet
    .map((entry) => entry.role?.trim() || entry.agent?.trim())
    .filter((role): role is string => Boolean(role));
  const runAgents =
    sessionsDir && preferredSessionId
      ? asyncRunAgents(sessionsDir, preferredSessionId)
      : new Map<string, string>();
  const runs = Array.isArray(data?.asyncSnapshot?.runs)
    ? data.asyncSnapshot.runs
        .map((run) => enrichNode(run, sessionsDir, fleetRoles, { value: 0 }, runAgents))
        .filter((run) => !isOrphanedTerminalRun(run, sessionsDir))
    : [];
  return {
    version: 1,
    available: true,
    generatedAt: Date.now(),
    totalActive:
      typeof data?.fleet?.totalActive === "number" ? data.fleet.totalActive : fleet.length,
    omitted: typeof data?.fleet?.omitted === "number" ? data.fleet.omitted : 0,
    fleet,
    runs,
  };
}

export type SubagentStatusBridge = {
  extension: ExtensionFactory;
  setIdentity(identity: HostIdentity): void;
  markReady(): void;
  dispose(): void;
};

/**
 * Bridges pi-subagents' public in-process RPC into a Host event. The adapter
 * only uses the versioned event names documented by pi-subagents and degrades
 * to an empty/unavailable snapshot when the package is absent or unavailable.
 */
export function createSubagentStatusBridge(
  emit: (identity: HostIdentity, snapshot: SubagentsStatusSnapshot) => void,
  options: { sessionsDir?: string } = {},
): SubagentStatusBridge {
  let identity: HostIdentity | null = null;
  let latest = unavailable();
  let external = unavailable();
  let currentSessionId: string | null = null;
  let disposed = false;
  let nextGeneration = 0;
  let activeGeneration = 0;
  let identityGeneration = 0;
  let readyGeneration = 0;
  const sessions = new Set<() => void>();
  const timers = new Set<ReturnType<typeof setTimeout>>();

  const emitCurrent = () => {
    if (
      disposed ||
      !identity ||
      identityGeneration !== activeGeneration ||
      readyGeneration !== activeGeneration
    )
      return;
    const useExternalRuns = Boolean(options.sessionsDir && currentSessionId);
    emit(identity, {
      ...(useExternalRuns ? external : latest),
      available: latest.available || external.available,
      runs: useExternalRuns ? external.runs : latest.runs,
    });
  };

  const publish = (generation: number, snapshot: SubagentsStatusSnapshot) => {
    latest = snapshot;
    if (generation === activeGeneration) emitCurrent();
  };

  const scanExternal = (generation: number) => {
    if (!options.sessionsDir || generation !== activeGeneration) return;
    const liveRuns = liveExternalRuns(options.sessionsDir, currentSessionId);
    const runs =
      liveRuns.length > 0 ? liveRuns : externalCompletedRuns(options.sessionsDir, currentSessionId);
    external = {
      version: 1,
      available: runs.length > 0,
      generatedAt: Date.now(),
      totalActive: runs.filter((run) => run.state === "running").length,
      omitted: 0,
      fleet: [],
      runs,
    };
    if (generation === activeGeneration) emitCurrent();
  };

  let stopActiveExtension: (() => void) | null = null;
  const extension: ExtensionFactory = (pi: ExtensionAPI) => {
    stopActiveExtension?.();
    // The SDK re-invokes inline extension factories whenever the resource
    // loader reloads (package install/remove/update, skill mutation). For an
    // already-live session the lifecycle only calls setIdentity/markReady on
    // session create/open, so without inheriting the previous instance's sync
    // markers every publish after the reload is dropped by the generation gate
    // below and the desktop panel freezes on its last snapshot (e.g. the
    // pre-install "pi-subagents not detected" state).
    const inheritsLiveSession =
      identity !== null &&
      identityGeneration === activeGeneration &&
      readyGeneration === activeGeneration;
    const generation = ++nextGeneration;
    activeGeneration = generation;
    if (inheritsLiveSession) {
      identityGeneration = generation;
      readyGeneration = generation;
    }
    let interval: ReturnType<typeof setInterval> | undefined;
    let externalInterval: ReturnType<typeof setInterval> | undefined;
    let sessionDisposed = false;
    const stop = () => {
      sessionDisposed = true;
      if (interval) clearInterval(interval);
      if (externalInterval) clearInterval(externalInterval);
      interval = undefined;
      externalInterval = undefined;
    };
    stopActiveExtension = stop;

    const request = () => {
      if (disposed || sessionDisposed || generation !== activeGeneration) return;
      const requestId = crypto.randomUUID();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let unsubscribe: (() => void) | undefined;
      const cleanup = () => {
        if (timer) {
          clearTimeout(timer);
          timers.delete(timer);
          timer = undefined;
        }
        if (unsubscribe) {
          unsubscribe();
          sessions.delete(unsubscribe);
          unsubscribe = undefined;
        }
      };
      unsubscribe =
        pi.events.on(`${RPC_REPLY_PREFIX}${requestId}`, (raw) => {
          cleanup();
          if (!raw || typeof raw !== "object") return;
          const reply = raw as RpcReply;
          publish(
            generation,
            reply.success && reply.data
              ? normalizeSnapshot(reply.data, options.sessionsDir, currentSessionId)
              : unavailable(),
          );
        }) ?? undefined;
      if (unsubscribe) sessions.add(unsubscribe);
      pi.events.emit(RPC_REQUEST_EVENT, {
        version: RPC_VERSION,
        requestId,
        method: "status",
        params: {},
        source: { extension: "pideck" },
      });
      timer = setTimeout(cleanup, POLL_MS * 2);
      timers.add(timer);
    };

    // Requests are safe before the package RPC announces readiness; a reply
    // simply arrives once pi-subagents has registered its bridge.
    pi.events.on(RPC_READY_EVENT, request);
    pi.on("session_start", () => {
      if (generation !== activeGeneration) return;
      sessionDisposed = false;
      publish(generation, unavailable());
      scanExternal(generation);
      if (interval) clearInterval(interval);
      interval = setInterval(request, POLL_MS);
      interval.unref?.();
      if (externalInterval) clearInterval(externalInterval);
      externalInterval = options.sessionsDir
        ? setInterval(() => scanExternal(generation), EXTERNAL_SCAN_MS)
        : undefined;
      externalInterval?.unref?.();
      request();
    });
    pi.on("session_shutdown", () => {
      if (generation !== activeGeneration) return;
      stop();
      external = unavailable();
      publish(generation, unavailable());
    });

    // A resource-loader reload of an already-live session is not followed by
    // a session_start (only a full agentSession.reload is), so resume polling
    // here; the session_start handler clears and rebuilds these intervals
    // when a full session reload does fire.
    if (inheritsLiveSession) {
      sessionDisposed = false;
      scanExternal(generation);
      interval = setInterval(request, POLL_MS);
      interval.unref?.();
      externalInterval = options.sessionsDir
        ? setInterval(() => scanExternal(generation), EXTERNAL_SCAN_MS)
        : undefined;
      externalInterval?.unref?.();
      request();
    }
  };

  return {
    extension,
    setIdentity(next) {
      // Session lifecycle commits identity before publishing session.snapshot.
      // Do not emit here: the desktop must observe the snapshot first or it
      // will reject this session-scoped event as an identity mismatch.
      identity = { ...next };
      currentSessionId = next.sessionId;
      identityGeneration = activeGeneration;
      readyGeneration = 0;
      scanExternal(activeGeneration);
    },
    markReady() {
      readyGeneration = activeGeneration;
      emitCurrent();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      identity = null;
      currentSessionId = null;
      identityGeneration = 0;
      readyGeneration = 0;
      activeGeneration = 0;
      for (const unsubscribe of sessions) unsubscribe();
      sessions.clear();
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
  };
}
