import { create } from "zustand";
import type {
  DesktopSettings,
  SessionTargetContext,
  ExtensionUiRequest,
  HostStatusSnapshot,
  PackageMutationResult,
  PackageSnapshot,
  SessionSnapshot,
  ToolSnapshot,
  WorkspaceSnapshot,
  HostEventPayloadMap,
  JsonValue,
  ProviderLoginPrompt,
  SessionSummary,
} from "@pideck/protocol";
import {
  applyPackageSnapshot as epochApplyPackages,
  applySessionSnapshot as epochApplySession,
  applyWorkspaceSnapshot as epochApplyWorkspace,
  beginHostEpoch as epochBeginHost,
  clearWorkspaceEpoch as epochClearWorkspace,
  emptyEpoch,
  markDesynchronized as epochMarkDesync,
  noteSequence as epochNoteSequence,
  type EpochState,
} from "./epoch-store";
import {
  emptySessionCatalog,
  replaceSessionCatalog as replaceCatalog,
  setSessionRuntimeState as setCatalogRuntimeState,
  updateSessionCatalogInfo as updateCatalogInfo,
  upsertSessionSnapshot as upsertCatalogSnapshot,
  type SessionCatalogState,
  type SessionRuntimeState,
} from "./session-catalog";
import { sidebarPref } from "../sidebar-prefs";

export type NavPage = "chat" | "packages" | "settings";

/** Live view of the single in-flight builtin Provider login flow. */
export type ProviderLoginUiState = {
  loginId: string;
  providerId: string;
  authUrl?: { url: string; instructions?: string };
  deviceCode?: {
    userCode: string;
    verificationUri: string;
    expiresInSeconds?: number;
  };
  infos: Array<{ message: string; links?: Array<{ url: string; label?: string }> }>;
  progress?: string;
  prompt: ProviderLoginPrompt | null;
  done?: { ok: boolean; message?: string };
};

export type PackageProgressState = HostEventPayloadMap["package.progress"] & {
  lastEventAt: number;
};

export type PackageRetryState = {
  method: string;
  params: JsonValue;
};

export type ExtensionUiRequestState = ExtensionUiRequest & {
  context: SessionTargetContext;
  expiresAt?: number;
};

export function isExtensionUiRequestExpired(
  request: ExtensionUiRequestState,
  now = Date.now(),
): boolean {
  return request.expiresAt !== undefined && request.expiresAt <= now;
}

function extensionUiSessionId(request: ExtensionUiRequestState): string | null {
  return request.context.expectedSessionId;
}

function alignExtensionUiToSession(
  activeRequest: ExtensionUiRequestState | null,
  queuedRequests: ExtensionUiRequestState[],
  sessionId: string | null,
  now = Date.now(),
): { extensionUiRequest: ExtensionUiRequestState | null; extensionUiQueue: ExtensionUiRequestState[] } {
  let active =
    activeRequest && !isExtensionUiRequestExpired(activeRequest, now) ? activeRequest : null;
  let queue = queuedRequests.filter((request) => !isExtensionUiRequestExpired(request, now));
  if (!sessionId) return { extensionUiRequest: active, extensionUiQueue: queue };
  if (active && extensionUiSessionId(active) === sessionId) {
    return { extensionUiRequest: active, extensionUiQueue: queue };
  }
  if (active) queue = [active, ...queue];
  const nextIndex = queue.findIndex((request) => extensionUiSessionId(request) === sessionId);
  if (nextIndex < 0) return { extensionUiRequest: null, extensionUiQueue: queue };
  active = queue[nextIndex]!;
  queue = queue.filter((_, index) => index !== nextIndex);
  return { extensionUiRequest: active, extensionUiQueue: queue };
}

export type ExtensionWidgetState = {
  key: string;
  widget: JsonValue;
  placement?: "aboveEditor" | "belowEditor";
  hostInstanceId: string;
  workspaceId: string | null;
  workspaceRevision: number;
  sessionId: string | null;
  sessionRevision: number;
};

/** Live ui.custom() panel rendered in the right dock's terminal tab. */
export type ExtensionTerminalState = {
  requestId: string;
  title?: string;
  cols: number;
  rows: number;
  context: SessionTargetContext;
};

export type AppNotification = {
  id: string;
  message: string;
  level: string;
  createdAt: number;
};

/**
 * Close the extension terminal panel, restoring the dock to its pre-panel
 * state unless the user toggled the dock manually while the panel was open.
 */
function resetExtensionTerminal(state: {
  extensionTerminal: ExtensionTerminalState | null;
  dockOpen: boolean;
  dockRestoreOnPanelClose: boolean | null;
}): {
  extensionTerminal: null;
  dockOpen: boolean;
  dockRestoreOnPanelClose: null;
} {
  return {
    extensionTerminal: null,
    dockOpen: state.extensionTerminal
      ? (state.dockRestoreOnPanelClose ?? state.dockOpen)
      : state.dockOpen,
    dockRestoreOnPanelClose: null,
  };
}

export type AppState = EpochState & {
  page: NavPage;
  desktopSettings: DesktopSettings | null;
  extensionUiRequest: ExtensionUiRequestState | null;
  extensionUiQueue: ExtensionUiRequestState[];
  extensionStatus: string | null;
  extensionStatuses: Record<string, string>;
  extensionWidgets: Record<string, ExtensionWidgetState>;
  extensionWidgetsOpen: boolean;
  lastExtensionWidgetAttentionRunId: string | null;
  extensionTerminal: ExtensionTerminalState | null;
  /** Right dock visibility. Auto-opens for extension panels; manual toggles persist. */
  dockOpen: boolean;
  /** Dock state to restore when the auto-opened panel closes (null = user took over). */
  dockRestoreOnPanelClose: boolean | null;
  packageProgress: PackageProgressState | null;
  packageRetry: PackageRetryState | null;
  thinkingLevels: string[];
  providerConfigRevision: number;
  sessionCatalog: SessionCatalogState;
  sessionDrafts: Record<string, string>;
  notifications: AppNotification[];
  hostFatal: string | null;
  connecting: boolean;
  rehydrating: boolean;
  /** True while the Providers settings form holds unsaved edits (guards Settings close/nav). */
  providersDirty: boolean;
  providerLogin: ProviderLoginUiState | null;
  beginProviderLogin: (loginId: string, providerId: string) => void;
  applyProviderLoginEvent: (payload: HostEventPayloadMap["provider.loginEvent"]) => void;
  clearProviderLogin: () => void;
  setPage: (page: NavPage) => void;
  setProvidersDirty: (dirty: boolean) => void;
  /** New host epoch: clears workspace/session/packages/tools/extension UI. */
  beginHostEpoch: (host: HostStatusSnapshot) => void;
  setHost: (host: HostStatusSnapshot | null) => void;
  applyWorkspaceSnapshot: (ws: WorkspaceSnapshot) => void;
  clearWorkspaceEpoch: () => void;
  setWorkspace: (ws: WorkspaceSnapshot | null) => void;
  applySessionSnapshot: (s: SessionSnapshot | null) => void;
  setSession: (s: SessionSnapshot | null) => void;
  applyPackageSnapshot: (p: PackageSnapshot | null) => void;
  applyPackageMutationResult: (result: PackageMutationResult) => void;
  setPackages: (p: PackageSnapshot | null) => void;
  setTools: (t: ToolSnapshot | null) => void;
  setDesktopSettings: (d: DesktopSettings | null) => void;
  setExtensionUiRequest: (r: ExtensionUiRequestState | null) => void;
  enqueueExtensionUiRequest: (r: ExtensionUiRequestState) => void;
  openExtensionTerminal: (t: ExtensionTerminalState) => void;
  closeExtensionTerminal: (requestId: string) => void;
  setDockOpen: (open: boolean) => void;
  setExtensionStatus: (key: string | undefined, text: string | null) => void;
  setExtensionWidget: (widget: ExtensionWidgetState) => void;
  setExtensionWidgetsOpen: (open: boolean) => void;
  requestExtensionWidgetAttention: (runId: string, key: string) => void;
  setPackageProgress: (progress: PackageProgressState | null) => void;
  setPackageRetry: (retry: PackageRetryState | null) => void;
  setThinkingLevels: (levels: string[]) => void;
  refreshProviderConfig: () => void;
  replaceSessionCatalog: (workspaceId: string, items: SessionSummary[]) => void;
  clearSessionCatalog: () => void;
  updateSessionCatalogInfo: (sessionId: string, name?: string) => void;
  setSessionRuntimeState: (
    sessionId: string,
    state: SessionRuntimeState,
    error?: string,
    updatedAt?: number,
  ) => void;
  setSessionDraft: (sessionId: string, text: string) => void;
  pushNotification: (message: string, level?: string) => void;
  dismissNotification: (id: string) => void;
  clearNotifications: () => void;
  setHostFatal: (msg: string | null) => void;
  setConnecting: (v: boolean) => void;
  setRehydrating: (v: boolean) => void;
  markDesynchronized: (reason: string) => void;
  noteSequence: (sequence: number) => "apply" | "drop" | "gap";
  completeRehydrate: (snap: {
    host?: HostStatusSnapshot | null;
    workspace?: WorkspaceSnapshot | null;
    session?: SessionSnapshot | null;
    packages?: PackageSnapshot | null;
    tools?: ToolSnapshot | null;
    /** Authoritative event watermark captured with the Host recovery snapshot. */
    lastSequence?: number;
  }) => void;
  clearHostEpoch: (reason: string) => void;
};

function epochSlice(s: AppState): EpochState {
  return {
    host: s.host,
    workspace: s.workspace,
    session: s.session,
    packages: s.packages,
    tools: s.tools,
    desynchronized: s.desynchronized,
    desyncReason: s.desyncReason,
    lastSequence: s.lastSequence,
  };
}

export const useAppStore = create<AppState>((set, get) => ({
  page: "chat",
  ...emptyEpoch(),
  desktopSettings: null,
  extensionUiRequest: null,
  extensionUiQueue: [],
  extensionStatus: null,
  extensionStatuses: {},
  extensionWidgets: {},
  extensionWidgetsOpen: false,
  lastExtensionWidgetAttentionRunId: null,
  extensionTerminal: null,
  dockOpen: sidebarPref("pideck.dock.open"),
  dockRestoreOnPanelClose: null,
  packageProgress: null,
  packageRetry: null,
  thinkingLevels: [],
  providerConfigRevision: 0,
  sessionCatalog: emptySessionCatalog(),
  sessionDrafts: {},
  notifications: [],
  hostFatal: null,
  connecting: true,
  rehydrating: false,
  providersDirty: false,
  providerLogin: null,
  beginProviderLogin: (loginId, providerId) =>
    set((state) =>
      // API-key flows prompt synchronously, so the loginEvent can outrun the
      // loginStart response; never reset a flow the event stream already began.
      state.providerLogin?.loginId === loginId
        ? {}
        : { providerLogin: { loginId, providerId, infos: [], prompt: null } },
    ),
  applyProviderLoginEvent: (payload) =>
    set((state) => {
      // The host is authoritative: adopt events for flows this client did not
      // start (or whose loginStart response has not resolved yet).
      const current: ProviderLoginUiState =
        state.providerLogin && state.providerLogin.loginId === payload.loginId
          ? state.providerLogin
          : {
              loginId: payload.loginId,
              providerId: payload.providerId,
              infos: [],
              prompt: null,
            };
      const event = payload.event;
      switch (event.kind) {
        case "info":
          return {
            providerLogin: {
              ...current,
              infos: [
                ...current.infos,
                { message: event.message, ...(event.links ? { links: event.links } : {}) },
              ],
            },
          };
        case "auth_url":
          return {
            providerLogin: {
              ...current,
              authUrl: {
                url: event.url,
                ...(event.instructions ? { instructions: event.instructions } : {}),
              },
            },
          };
        case "device_code":
          return {
            providerLogin: {
              ...current,
              deviceCode: {
                userCode: event.userCode,
                verificationUri: event.verificationUri,
                ...(event.expiresInSeconds !== undefined
                  ? { expiresInSeconds: event.expiresInSeconds }
                  : {}),
              },
            },
          };
        case "progress":
          return { providerLogin: { ...current, progress: event.message } };
        case "prompt":
          return { providerLogin: { ...current, prompt: event.prompt } };
        case "prompt_cancel":
          return current.prompt?.promptId === event.promptId
            ? { providerLogin: { ...current, prompt: null } }
            : { providerLogin: current };
        case "done":
          return {
            providerLogin: {
              ...current,
              prompt: null,
              done: { ok: event.ok, ...(event.message ? { message: event.message } : {}) },
            },
          };
        default:
          return { providerLogin: current };
      }
    }),
  clearProviderLogin: () => set({ providerLogin: null }),
  setPage: (page) =>
    set((state) => ({
      page,
      ...(page !== state.page ? { extensionWidgetsOpen: false } : {}),
    })),
  setProvidersDirty: (dirty) => set({ providersDirty: dirty }),

  beginHostEpoch: (host) => {
    const next = epochBeginHost(epochSlice(get()), host);
    set({
      ...next,
      extensionUiRequest: null,
      extensionUiQueue: [],
      extensionStatus: null,
      extensionStatuses: {},
      extensionWidgets: {},
      extensionWidgetsOpen: false,
      lastExtensionWidgetAttentionRunId: null,
      ...resetExtensionTerminal(get()),
      packageProgress: null,
      packageRetry: null,
      thinkingLevels: [],
      providerConfigRevision: 0,
      sessionCatalog: emptySessionCatalog(),
      hostFatal: null,
      desynchronized: false,
      desyncReason: undefined,
      rehydrating: false,
      providerLogin: null,
    });
  },

  setHost: (host) => {
    if (!host) {
      set({ host: null });
      return;
    }
    const prev = get().host;
    if (!prev || prev.hostInstanceId !== host.hostInstanceId) {
      get().beginHostEpoch(host);
      return;
    }
    set({ host });
  },

  applyWorkspaceSnapshot: (workspace) => {
    const next = epochApplyWorkspace(epochSlice(get()), workspace);
    const previousWorkspace = get().workspace;
    const clearedSession = Boolean(
      previousWorkspace &&
        (previousWorkspace.id !== workspace.id ||
          previousWorkspace.revision !== workspace.revision),
    );
    set({
      ...next,
      ...(clearedSession ? { sessionCatalog: emptySessionCatalog() } : {}),
      ...(clearedSession
        ? {
            extensionUiRequest: null,
            extensionUiQueue: [],
            extensionStatus: null,
            extensionStatuses: {},
            extensionWidgets: {},
            extensionWidgetsOpen: false,
            lastExtensionWidgetAttentionRunId: null,
            ...resetExtensionTerminal(get()),
            packageProgress: null,
            packageRetry: null,
            thinkingLevels: [],
          }
        : {}),
    });
  },

  clearWorkspaceEpoch: () => {
    const next = epochClearWorkspace(epochSlice(get()));
    set({
      ...next,
      sessionCatalog: emptySessionCatalog(),
      extensionUiRequest: null,
      extensionUiQueue: [],
      extensionStatus: null,
      extensionStatuses: {},
      extensionWidgets: {},
      extensionWidgetsOpen: false,
      lastExtensionWidgetAttentionRunId: null,
      ...resetExtensionTerminal(get()),
      packageProgress: null,
      packageRetry: null,
      thinkingLevels: [],
    });
  },

  setWorkspace: (workspace) => {
    if (!workspace) {
      get().clearWorkspaceEpoch();
      set({ workspace: null });
      return;
    }
    get().applyWorkspaceSnapshot(workspace);
  },

  applySessionSnapshot: (session) => {
    const current = get();
    const previousSession = current.session;
    const next = epochApplySession(epochSlice(current), session);
    const baseCatalog =
      previousSession && previousSession.sessionId !== session?.sessionId
        ? setCatalogRuntimeState(
            current.sessionCatalog,
            previousSession.sessionId,
            "inactive",
          )
        : current.sessionCatalog;
    const sessionCatalog =
      session && current.workspace
        ? upsertCatalogSnapshot(baseCatalog, current.workspace.id, session)
        : baseCatalog;
    const generationChanged = Boolean(
      previousSession &&
        (!session ||
          previousSession.sessionId !== session.sessionId ||
          previousSession.revision !== session.revision),
    );
    const extensionUi = alignExtensionUiToSession(
      current.extensionUiRequest,
      current.extensionUiQueue,
      session?.sessionId ?? null,
    );
    set({
      ...next,
      sessionCatalog,
      ...extensionUi,
      ...(generationChanged
        ? {
            extensionStatus: null,
            extensionStatuses: {},
            extensionWidgets: {},
            extensionWidgetsOpen: false,
            lastExtensionWidgetAttentionRunId: null,
            ...resetExtensionTerminal(current),
            packageProgress: null,
            packageRetry: null,
            thinkingLevels: [],
          }
        : {}),
    });
  },

  setSession: (session) => {
    get().applySessionSnapshot(session);
  },

  applyPackageSnapshot: (packages) => {
    const next = epochApplyPackages(epochSlice(get()), packages);
    set({
      ...next,
      ...(packages?.mutation?.reconcileRequired ? {} : { packageRetry: null }),
    });
  },

  applyPackageMutationResult: (result) => {
    const previous = get();
    let nextEpoch = epochApplyPackages(epochSlice(previous), result.packageSnapshot);
    const generationChanged = Boolean(
      result.session &&
        previous.session &&
        (previous.session.sessionId !== result.session.sessionId ||
          previous.session.revision !== result.session.revision),
    );
    if (result.session) {
      nextEpoch = epochApplySession(nextEpoch, result.session);
    }
    const sessionCatalog =
      result.session && previous.workspace
        ? upsertCatalogSnapshot(
            previous.sessionCatalog,
            previous.workspace.id,
            result.session,
          )
        : previous.sessionCatalog;
    set({
      ...nextEpoch,
      sessionCatalog,
      ...(generationChanged
        ? {
            extensionUiRequest: null,
            extensionUiQueue: [],
            extensionStatus: null,
            extensionStatuses: {},
            extensionWidgets: {},
            extensionWidgetsOpen: false,
            lastExtensionWidgetAttentionRunId: null,
            ...resetExtensionTerminal(previous),
            packageProgress: null,
            packageRetry: null,
            thinkingLevels: [],
          }
        : result.reconcileRequired
          ? {}
          : { packageRetry: null }),
    });
  },

  setPackages: (packages) => {
    get().applyPackageSnapshot(packages);
  },

  setTools: (tools) => set({ tools }),
  setDesktopSettings: (desktopSettings) => set({ desktopSettings }),
  setExtensionUiRequest: (request) =>
    set((state) => {
      const now = Date.now();
      let queue = state.extensionUiQueue.filter(
        (queued) => !isExtensionUiRequestExpired(queued, now),
      );
      if (request === null) {
        const targetSessionId = state.extensionUiRequest
          ? extensionUiSessionId(state.extensionUiRequest)
          : state.session?.sessionId ?? null;
        const nextIndex = targetSessionId
          ? queue.findIndex((queued) => extensionUiSessionId(queued) === targetSessionId)
          : -1;
        if (nextIndex < 0) {
          return { extensionUiRequest: null, extensionUiQueue: queue };
        }
        const next = queue[nextIndex]!;
        return {
          extensionUiRequest: next,
          extensionUiQueue: queue.filter((_, index) => index !== nextIndex),
        };
      }
      let active =
        state.extensionUiRequest && !isExtensionUiRequestExpired(state.extensionUiRequest, now)
          ? state.extensionUiRequest
          : null;
      if (!active && queue.length > 0) {
        [active, ...queue] = queue;
      }
      if (isExtensionUiRequestExpired(request, now)) {
        return { extensionUiRequest: active, extensionUiQueue: queue };
      }
      if (active?.requestId === request.requestId) {
        return { extensionUiRequest: request, extensionUiQueue: queue };
      }
      const existingIndex = queue.findIndex((queued) => queued.requestId === request.requestId);
      if (existingIndex >= 0) {
        queue = [...queue];
        queue[existingIndex] = request;
        return { extensionUiRequest: active, extensionUiQueue: queue };
      }
      if (!active) return { extensionUiRequest: request, extensionUiQueue: queue };
      return { extensionUiRequest: active, extensionUiQueue: [...queue, request] };
    }),
  enqueueExtensionUiRequest: (request) =>
    set((state) => {
      const now = Date.now();
      if (isExtensionUiRequestExpired(request, now)) return {};
      if (state.extensionUiRequest?.requestId === request.requestId) {
        return { extensionUiRequest: request };
      }
      const queue = state.extensionUiQueue.filter(
        (queued) => !isExtensionUiRequestExpired(queued, now),
      );
      const existingIndex = queue.findIndex((queued) => queued.requestId === request.requestId);
      if (existingIndex >= 0) {
        const nextQueue = [...queue];
        nextQueue[existingIndex] = request;
        return { extensionUiQueue: nextQueue };
      }
      return { extensionUiQueue: [...queue, request] };
    }),
  openExtensionTerminal: (panel) =>
    set((state) => ({
      extensionTerminal: panel,
      dockOpen: true,
      // Keep the original pre-panel dock state if one panel replaces another.
      dockRestoreOnPanelClose: state.extensionTerminal
        ? state.dockRestoreOnPanelClose
        : state.dockOpen,
    })),
  closeExtensionTerminal: (requestId) =>
    set((state) => {
      if (state.extensionTerminal?.requestId !== requestId) return {};
      return resetExtensionTerminal(state);
    }),
  setDockOpen: (open) =>
    set({
      dockOpen: open,
      // Manual toggle takes over — the panel close no longer restores.
      dockRestoreOnPanelClose: null,
    }),
  setExtensionStatus: (key, text) =>
    set((state) => {
      const statusKey = key || "default";
      const extensionStatuses = { ...state.extensionStatuses };
      if (text?.trim()) extensionStatuses[statusKey] = text;
      else delete extensionStatuses[statusKey];
      const values = Object.values(extensionStatuses);
      return {
        extensionStatuses,
        extensionStatus: values.length > 0 ? values[values.length - 1] : null,
      };
    }),
  setExtensionWidget: (extensionWidget) =>
    set((state) => {
      const key = extensionWidget.key || "default";
      if (extensionWidget.widget === null) {
        const extensionWidgets = { ...state.extensionWidgets };
        delete extensionWidgets[key];
        return {
          extensionWidgets,
          ...(Object.keys(extensionWidgets).length === 0
            ? { extensionWidgetsOpen: false }
            : {}),
        };
      }
      return {
        extensionWidgets: {
          ...state.extensionWidgets,
          [key]: { ...extensionWidget, key },
        },
      };
    }),
  setExtensionWidgetsOpen: (extensionWidgetsOpen) => set({ extensionWidgetsOpen }),
  requestExtensionWidgetAttention: (runId, key) =>
    set((state) => {
      if (state.lastExtensionWidgetAttentionRunId === runId) return {};
      return {
        lastExtensionWidgetAttentionRunId: runId,
        ...(state.page === "chat" && state.extensionWidgets[key]
          ? { extensionWidgetsOpen: true }
          : {}),
      };
    }),
  setPackageProgress: (packageProgress) => set({ packageProgress }),
  setPackageRetry: (packageRetry) => set({ packageRetry }),
  setThinkingLevels: (thinkingLevels) => set({ thinkingLevels: [...thinkingLevels] }),
  refreshProviderConfig: () =>
    set((state) => ({ providerConfigRevision: state.providerConfigRevision + 1 })),
  replaceSessionCatalog: (workspaceId, items) =>
    set((state) => ({
      sessionCatalog: replaceCatalog(state.sessionCatalog, workspaceId, items),
    })),
  clearSessionCatalog: () => set({ sessionCatalog: emptySessionCatalog() }),
  updateSessionCatalogInfo: (sessionId, name) =>
    set((state) => ({
      sessionCatalog: updateCatalogInfo(state.sessionCatalog, sessionId, name),
    })),
  setSessionRuntimeState: (sessionId, runtimeState, error, updatedAt) =>
    set((state) => ({
      sessionCatalog: setCatalogRuntimeState(
        state.sessionCatalog,
        sessionId,
        runtimeState,
        error,
        updatedAt,
      ),
    })),
  setSessionDraft: (sessionId, text) =>
    set((state) => {
      const sessionDrafts = { ...state.sessionDrafts };
      if (text) sessionDrafts[sessionId] = text;
      else delete sessionDrafts[sessionId];
      return { sessionDrafts };
    }),
  pushNotification: (message, level = "info") =>
    set((s) => ({
      notifications: [
        ...s.notifications.slice(-49),
        { id: crypto.randomUUID(), message, level, createdAt: Date.now() },
      ],
    })),
  dismissNotification: (id) =>
    set((state) => ({
      notifications: state.notifications.filter((notification) => notification.id !== id),
    })),
  clearNotifications: () => set({ notifications: [] }),
  setHostFatal: (hostFatal) => set({ hostFatal }),
  setConnecting: (connecting) => set({ connecting }),
  setRehydrating: (rehydrating) => set({ rehydrating }),

  markDesynchronized: (reason) => {
    const next = epochMarkDesync(epochSlice(get()), reason);
    set({ ...next });
  },

  noteSequence: (sequence) => {
    const r = epochNoteSequence(epochSlice(get()), sequence);
    set({ ...r.state });
    return r.action;
  },

  completeRehydrate: (snap) => {
    const current = get();
    const workspace = snap.workspace !== undefined ? snap.workspace : current.workspace;
    const session = snap.session !== undefined ? snap.session : current.session;
    set({
      host: snap.host !== undefined ? snap.host : current.host,
      workspace,
      session,
      packages: snap.packages !== undefined ? snap.packages : current.packages,
      tools:
        snap.tools !== undefined
          ? snap.tools
          : snap.session !== undefined
            ? (snap.session?.tools ?? null)
            : current.tools,
      sessionCatalog:
        workspace && session
          ? upsertCatalogSnapshot(current.sessionCatalog, workspace.id, session)
          : current.sessionCatalog,
      // Reset desync and advance sequence watermark so post-rehydrate events apply.
      lastSequence:
        snap.lastSequence !== undefined
          ? snap.lastSequence
          : Math.max(current.lastSequence, 0),
      desynchronized: false,
      desyncReason: undefined,
      rehydrating: false,
      extensionUiRequest: null,
      extensionUiQueue: [],
      extensionStatus: null,
      extensionStatuses: {},
      extensionWidgets: {},
      extensionWidgetsOpen: false,
      lastExtensionWidgetAttentionRunId: null,
      ...resetExtensionTerminal(current),
      packageProgress: null,
      packageRetry: null,
    });
  },

  clearHostEpoch: (reason) => {
    set({
      ...emptyEpoch(),
      extensionUiRequest: null,
      extensionUiQueue: [],
      extensionStatus: null,
      extensionStatuses: {},
      extensionWidgets: {},
      extensionWidgetsOpen: false,
      lastExtensionWidgetAttentionRunId: null,
      ...resetExtensionTerminal(get()),
      packageProgress: null,
      packageRetry: null,
      thinkingLevels: [],
      providerConfigRevision: 0,
      sessionCatalog: emptySessionCatalog(),
      hostFatal: reason,
      rehydrating: false,
    });
  },
}));
