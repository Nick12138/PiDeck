import type { HostTransport } from "./host-client";

type RoutedHostFrame = { routeId: string; line: string };

let activeRouteId: string | null = null;

function routedLine(payload: string | RoutedHostFrame): string | null {
  if (typeof payload === "string") return payload;
  return payload.routeId === activeRouteId ? payload.line : null;
}

export async function activateWorkspaceHost(cwd: string): Promise<boolean> {
  const { invoke, isTauri } = await import("@tauri-apps/api/core");
  if (!isTauri()) return false;
  activeRouteId = await invoke<string>("pi_host_activate", { cwd });
  return true;
}

export async function prepareWorkspaceHost(cwd: string, activeBusy: boolean): Promise<boolean> {
  const { invoke, isTauri } = await import("@tauri-apps/api/core");
  if (!isTauri()) return false;
  const routeId = await invoke<string | null>("pi_host_prepare_switch", { cwd, activeBusy });
  if (routeId === null) return false;
  activeRouteId = routeId;
  return true;
}

export async function rebindActiveWorkspaceHost(cwd: string): Promise<boolean> {
  const { invoke, isTauri } = await import("@tauri-apps/api/core");
  if (!isTauri()) return false;
  await invoke("pi_host_rebind_active", { cwd });
  return true;
}

/**
 * Re-sync a renderer that attached after the Host already announced ready
 * (window reload / HMR). Best-effort: on a cold start the Host is still
 * booting and has no ready line to replay — the live `host.ready` stdout
 * event (subscribed in `createTauriTransport`) delivers it instead, so a
 * miss here must never be treated as a startup failure.
 */
export async function replayActiveHostReady(): Promise<boolean> {
  const { invoke, isTauri } = await import("@tauri-apps/api/core");
  if (!isTauri()) return false;
  if (!activeRouteId) throw new Error("No active Host route");
  try {
    await invoke("pi_host_replay_ready", { routeId: activeRouteId });
    return true;
  } catch (err) {
    console.debug("[pi-host] ready replay unavailable (Host still booting?)", err);
    return false;
  }
}

export type HostActivitySummary = {
  cwd: string;
  busy: boolean;
  hasBeenBusy: boolean;
  errorCount: number;
  doneCount: number;
  terminalSessions: Record<string, { state: "error" | "done"; generation: number }>;
};

/**
 * Live per-workspace session activity from the Host pool. Background Hosts do
 * not route their stdout to the renderer, so this snapshot is the only view
 * the UI has into whether another workspace still has sessions running.
 */
export async function fetchHostActivity(): Promise<HostActivitySummary[]> {
  const { invoke, isTauri } = await import("@tauri-apps/api/core");
  if (!isTauri()) return [];
  try {
    return await invoke<HostActivitySummary[]>("pi_host_activity");
  } catch (err) {
    console.debug("[pi-host] activity snapshot unavailable", err);
    return [];
  }
}

/**
 * Tells the Host pool that the user returned to a session, clearing its
 * unacknowledged terminal marker so the workspace dot downgrades (e.g. red →
 * green while another session still runs, gray → none once all are viewed).
 */
export async function acknowledgeSessionTerminal(cwd: string, sessionId: string): Promise<void> {
  const { invoke, isTauri } = await import("@tauri-apps/api/core");
  if (!isTauri()) return;
  try {
    await invoke("pi_host_acknowledge_terminal", { cwd, sessionId });
  } catch (err) {
    console.debug("[pi-host] acknowledge terminal unavailable", err);
  }
}

/** Re-invoked whenever any Host's busy set changes (a session started/settled). */
export function subscribeHostActivity(onChange: () => void): () => void {
  let unlisten: (() => void) | undefined;
  void (async () => {
    const { isTauri } = await import("@tauri-apps/api/core");
    if (!isTauri()) return;
    const { listen } = await import("@tauri-apps/api/event");
    try {
      unlisten = await listen("pi-host-activity", () => onChange());
    } catch (err) {
      console.debug("[pi-host] activity subscription unavailable", err);
    }
  })();
  return () => unlisten?.();
}

/**
 * Tauri IPC transport. Falls back to a mock for browser-only Vite dev
 * when Tauri APIs are unavailable.
 */
export async function createTauriTransport(): Promise<HostTransport> {
  const { invoke, isTauri } = await import("@tauri-apps/api/core");
  if (!isTauri()) return createMockTransport();

  const { listen } = await import("@tauri-apps/api/event");
  const handlers = new Set<(line: string) => void>();

  const unlistenStdout = await listen<string | RoutedHostFrame>("pi-host-stdout", (event) => {
    const line = routedLine(event.payload);
    if (line === null) return;
    for (const h of handlers) h(line);
  });

  const unlistenStderr = await listen<string | RoutedHostFrame>("pi-host-stderr", (event) => {
    const line = routedLine(event.payload);
    if (line !== null) console.debug("[pi-host]", line);
  });

  activeRouteId = await invoke<string>("pi_host_active_route");

  return {
    send: async (line: string) => {
      await invoke("pi_host_send", { line });
    },
    onMessage: (handler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    dispose: () => {
      handlers.clear();
      unlistenStdout();
      unlistenStderr();
    },
  };
}

const BROWSER_MOCK_HOST_ID = "00000000-0000-4000-8000-000000000004";

function createMockTransport(): HostTransport {
  const handlers = new Set<(line: string) => void>();
  return {
    send: async (line: string) => {
      try {
        const req = JSON.parse(line);
        if (req.method === "system.hello") {
          const response = {
            protocolVersion: 1,
            hostInstanceId: BROWSER_MOCK_HOST_ID,
            workspaceId: null,
            workspaceRevision: 0,
            sessionId: null,
            sessionRevision: 0,
            packageRevision: 0,
            id: req.id,
            method: "system.hello",
            ok: true,
            result: {
              protocolVersion: 1,
              hostInstanceId: BROWSER_MOCK_HOST_ID,
              workspaceId: null,
              workspaceRevision: 0,
              sessionId: null,
              sessionRevision: 0,
              packageRevision: 0,
              sdkVersion: "0.82.1",
              nodeVersion: "browser",
              agentDir: "(mock)",
              phase: "waitingForWorkspace",
              capabilities: {
                packageUpdateCheck: false,
                extensionUi: true,
                sessionExport: false,
              },
              modelConfigHealth: { state: "ok", source: "ModelRegistry.getError" },
            },
          };
          queueMicrotask(() => {
            for (const h of handlers) h(JSON.stringify(response));
          });
        }
      } catch {
        /* ignore */
      }
    },
    onMessage: (handler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };
}
