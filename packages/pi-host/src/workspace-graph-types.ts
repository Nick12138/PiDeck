import type {
  AgentSession,
  DefaultPackageManager,
  DefaultResourceLoader,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  SessionInfo,
} from "@earendil-works/pi-coding-agent";
import type { FileCredentialStore } from "./credential-store.js";
import type { MigrationMilestone } from "./migration-backup.js";
import type {
  HostIdentity,
  ModelConfigHealth,
  PackageSnapshot,
  SessionSnapshot,
} from "@pideck/protocol";
import type { ResourceIdMap } from "./package-snapshot.js";

export type WorkspaceGraph = {
  workspaceId: string;
  cwd: string;
  canonicalCwd: string;
  revision: number;
  servicesReady: boolean;
  settingsManager: SettingsManager | null;
  packageManager: DefaultPackageManager | null;
  resourceLoader: DefaultResourceLoader | null;
  sessionManager: SessionManager | null;
  agentSession: AgentSession | null;
  extensionsResult: unknown;
  packageSnapshot: PackageSnapshot | null;
  sessionSnapshot: SessionSnapshot | null;
  toolRevision: number;
  /** Private resourceId -> metadata map for package and standalone preferences. */
  resourceIdMap: ResourceIdMap;
  unsubscribeAgent: (() => void) | null;
  extensionUiActivate: (() => Promise<() => void>) | null;
  extensionUiCleanup: (() => void) | null;
  extensionUiUpdateIdentity: ((identity: HostIdentity) => void) | null;
  /** After package mutation reload failure — block prompts until reload succeeds */
  resourceReloadRequired: boolean;
  backgroundSessions: Map<string, BackgroundSessionRuntime>;
  /** Idle runtimes parked for fast switching within this workspace. */
  retainedSessions: Map<string, BackgroundSessionRuntime>;
  /** Disk/config fingerprint captured when this graph was parked. */
  retainedFingerprint?: string;
};

export type BackgroundSessionRuntime = {
  sessionId: string;
  sessionRevision: number;
  sessionManager: SessionManager;
  agentSession: AgentSession;
  resourceLoader: DefaultResourceLoader;
  extensionsResult: unknown;
  toolRevision: number;
  sessionSnapshot: SessionSnapshot;
  unsubscribeAgent: (() => void) | null;
  extensionUiActivate: (() => Promise<() => void>) | null;
  extensionUiCleanup: (() => void) | null;
  extensionUiUpdateIdentity: ((identity: HostIdentity) => void) | null;
};

export type ManagedSessionInfo = SessionInfo & { archived: boolean };

export type GraphFactoryDeps = {
  agentDir: string;
  /** Persistent auth.json store injected into the Host-owned runtime. */
  credentialStore: FileCredentialStore;
  /**
   * The single authoritative runtime. Every createAgentSession call must
   * receive this instance; omitting it makes the SDK build a second runtime
   * with its own provider and auth state.
   */
  modelRuntime: ModelRuntime;
  /** Synchronous compatibility facade over `modelRuntime`. Owns no state. */
  modelRegistry: ModelRegistry;
  getModelConfigHealth: () => ModelConfigHealth;
  /** Local reconcile only — never reaches the network. */
  refreshModelHealth: (signal?: AbortSignal) => Promise<ModelConfigHealth> | ModelConfigHealth;
  /**
   * Report that a migration-dependent path succeeded. Absent once the
   * migration is complete. Never throws — a lost milestone only retains the
   * backup longer.
   */
  recordMigrationMilestone?: (milestone: MigrationMilestone) => Promise<void>;
  packageUpdateCheck: boolean;
};
