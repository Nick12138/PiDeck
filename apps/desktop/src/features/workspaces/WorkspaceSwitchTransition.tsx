import { useEffect, useState, type ReactNode } from "react";
import { useAppStore } from "../../lib/stores/app-store";
import { useT } from "../../lib/i18n/use-t";
import { workspaceDisplayName } from "./WorkspacePicker";

const SKELETON_UNMOUNT_DELAY_MS = 200;

function SkeletonBlock({ className }: { className: string }) {
  return (
    <div
      className={`animate-pulse rounded-lg bg-surface-overlay motion-reduce:animate-none ${className}`}
    />
  );
}

/**
 * Native-feeling workspace switch: the stale conversation fades out into a
 * chat-shaped skeleton, and the new workspace fades back in once ready.
 */
export function WorkspaceSwitchTransition({ children }: { children: ReactNode }) {
  const target = useAppStore((s) => s.workspaceSwitchTarget);
  const t = useT();
  const switching = target !== null;
  const [skeletonPresent, setSkeletonPresent] = useState(switching);
  const [lastTarget, setLastTarget] = useState(target);
  if (target !== null && target !== lastTarget) setLastTarget(target);

  useEffect(() => {
    if (switching) {
      setSkeletonPresent(true);
      return;
    }
    const timer = window.setTimeout(() => setSkeletonPresent(false), SKELETON_UNMOUNT_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [switching]);

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <div
        className={`flex min-h-0 min-w-0 flex-1 flex-col transition-opacity duration-150 ease-out motion-reduce:transition-none ${
          switching ? "pointer-events-none opacity-0" : "opacity-100"
        }`}
        aria-hidden={switching || undefined}
        inert={switching || undefined}
      >
        {children}
      </div>
      {skeletonPresent && (
        <div
          role="status"
          aria-live="polite"
          className={`workspace-switch-skeleton absolute inset-0 z-30 flex flex-col bg-surface transition-opacity duration-150 ease-out motion-reduce:transition-none ${
            switching ? "opacity-100" : "pointer-events-none opacity-0"
          }`}
        >
          <div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
            <SkeletonBlock className="h-4 w-40" />
            <span className="text-xs text-muted">
              {lastTarget !== null
                ? t("workspacesSwitchingTo", { name: workspaceDisplayName(lastTarget) })
                : null}
            </span>
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden px-6 py-6">
            <SkeletonBlock className="h-10 w-3/5 self-end" />
            <SkeletonBlock className="h-24 w-4/5" />
            <SkeletonBlock className="h-10 w-2/5 self-end" />
            <SkeletonBlock className="h-16 w-3/4" />
          </div>
          <div className="shrink-0 px-6 pb-6">
            <SkeletonBlock className="h-20 w-full rounded-xl" />
          </div>
        </div>
      )}
    </div>
  );
}
