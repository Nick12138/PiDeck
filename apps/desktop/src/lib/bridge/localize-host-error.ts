import type { Translate } from "../i18n/use-t";

type HostErrorLike = { code?: string; message?: string };

const CODE_TO_KEY: Record<string, "hostErrAgentBusy" | "hostErrAgentNotReady" | "hostErrNoActiveSession" | "hostErrWorkspaceServicesNotReady" | "hostErrServiceBusy" | "hostErrNoWorkspace" | "hostErrPackageMutationBusy" | "hostErrPackageNotFound" | "hostErrModelNotFound" | "hostErrSessionSwitchFailed" | "hostErrWorkspaceSwitchFailed" | "hostErrWorkspaceDirMissing" | "hostErrSessionArchived" | "hostErrHostShuttingDown" | "hostErrInvalidRequest" | "hostErrAuthRequired" | "hostErrSessionNotFound" | "hostErrSessionNotInWorkspace" | "hostErrUnknown"> = {
  AGENT_BUSY: "hostErrAgentBusy",
  AGENT_NOT_READY: "hostErrAgentNotReady",
  SERVICE_GRAPH_BUSY: "hostErrServiceBusy",
  PROJECT_NOT_SELECTED: "hostErrNoWorkspace",
  PACKAGE_MUTATION_BUSY: "hostErrPackageMutationBusy",
  PACKAGE_NOT_FOUND: "hostErrPackageNotFound",
  MODEL_NOT_FOUND: "hostErrModelNotFound",
  SESSION_SWITCH_FAILED: "hostErrSessionSwitchFailed",
  WORKSPACE_SWITCH_FAILED: "hostErrWorkspaceSwitchFailed",
  HOST_SHUTTING_DOWN: "hostErrHostShuttingDown",
  INVALID_REQUEST: "hostErrInvalidRequest",
  AUTH_REQUIRED: "hostErrAuthRequired",
  SESSION_NOT_FOUND: "hostErrSessionNotFound",
};

/**
 * Host errors surface raw English strings. Map the known user-facing error
 * codes to the current locale so notifications render in the UI language.
 * Falls back to the raw message when the code is unknown or carries detail
 * (e.g. a path or provider id) that a generic translation would discard.
 */
export function localizeHostError(
  error: HostErrorLike | null | undefined,
  t: Translate,
): string {
  if (!error) return t("hostErrUnknown");
  const code = error.code ?? "";
  if (code === "SESSION_NOT_FOUND" && error.message) {
    if (/not in the current workspace|switch workspace first/iu.test(error.message)) {
      return t("hostErrSessionNotInWorkspace");
    }
  }
  if (code === "WORKSPACE_SWITCH_FAILED" && error.message) {
    const dir = error.message.match(/Directory does not exist: (.+)$/iu)?.[1];
    if (dir) return t("hostErrWorkspaceDirMissing", { path: dir });
  }
  if (code === "SESSION_SWITCH_FAILED" && /already archived/iu.test(error.message ?? "")) {
    return t("hostErrSessionArchived");
  }
  if (code === "AGENT_NOT_READY" && error.message) {
    if (/no active session/iu.test(error.message)) return t("hostErrNoActiveSession");
    if (/workspace services/iu.test(error.message)) return t("hostErrWorkspaceServicesNotReady");
  }
  const key = CODE_TO_KEY[code];
  if (key) return t(key);
  return error.message || t("hostErrUnknown");
}