import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { HostIdentity, SubagentStatusNode, SubagentsStatusSnapshot } from "@pideck/protocol";

const RPC_READY_EVENT = "subagents:rpc:v1:ready";
const RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
const RPC_REPLY_PREFIX = "subagents:rpc:v1:reply:";
const RPC_VERSION = 1;
const POLL_MS = 750;
const EXTERNAL_SCAN_MS = 1_500;
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

function externalCompletedRuns(sessionsDir: string): SubagentStatusNode[] {
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
      })
      .slice(0, MAX_EXTERNAL_SESSIONS);
  } catch {
    return [];
  }

  // A PiDeck Host and an interactive Pi process do not share an in-memory
  // event bus. Prefer the newest session that has published a subagent result,
  // which represents the current external parent session without replaying all
  // historical subagent sessions in the workspace.
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
        const parsed = JSON.parse(line) as { content?: unknown };
        content = typeof parsed.content === "string" ? parsed.content : "";
      } catch {
        continue;
      }
      if (!/Background task completed|Workflow completed/i.test(content)) continue;
      const runId = content.match(/"runId"\s*:\s*"([^"\r\n]+)"/)?.[1];
      const agent = content.match(/"agent"\s*:\s*"([^"\r\n]+)"/)?.[1];
      if (!runId || !agent) continue;
      const output = content.match(/"output"\s*:\s*"([^"\r\n]*)"/)?.[1];
      runs.push({
        id: `external:${sessionId}:${runId}`,
        kind: "subagent",
        label: `${agent} (${runId})`,
        state: "complete",
        activity: output ? { state: output } : undefined,
      });
      if (runs.length >= MAX_EXTERNAL_RUNS) return runs;
    }
    if (runs.length > 0) return runs;
  }
  return [];
}

function normalizeSnapshot(data: RpcReply["data"]): SubagentsStatusSnapshot {
  const fleet = Array.isArray(data?.fleet?.entries) ? data.fleet.entries : [];
  const runs = Array.isArray(data?.asyncSnapshot?.runs) ? data.asyncSnapshot.runs : [];
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
    emit(identity, {
      ...latest,
      available: latest.available || external.available,
      runs: [...latest.runs, ...external.runs],
    });
  };

  const publish = (generation: number, snapshot: SubagentsStatusSnapshot) => {
    latest = snapshot;
    if (generation === activeGeneration) emitCurrent();
  };

  const scanExternal = (generation: number) => {
    if (!options.sessionsDir || generation !== activeGeneration) return;
    const runs = externalCompletedRuns(options.sessionsDir);
    external = {
      version: 1,
      available: runs.length > 0,
      generatedAt: Date.now(),
      totalActive: 0,
      omitted: 0,
      fleet: [],
      runs,
    };
    if (generation === activeGeneration) emitCurrent();
  };

  let stopActiveExtension: (() => void) | null = null;
  const extension: ExtensionFactory = (pi: ExtensionAPI) => {
    stopActiveExtension?.();
    const generation = ++nextGeneration;
    activeGeneration = generation;
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
            reply.success && reply.data ? normalizeSnapshot(reply.data) : unavailable(),
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
  };

  return {
    extension,
    setIdentity(next) {
      // Session lifecycle commits identity before publishing session.snapshot.
      // Do not emit here: the desktop must observe the snapshot first or it
      // will reject this session-scoped event as an identity mismatch.
      identity = { ...next };
      identityGeneration = activeGeneration;
      readyGeneration = 0;
    },
    markReady() {
      readyGeneration = activeGeneration;
      emitCurrent();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      identity = null;
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
