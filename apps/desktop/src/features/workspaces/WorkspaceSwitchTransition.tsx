import { useEffect, useState, type ReactNode } from "react";
import { useAppStore } from "../../lib/stores/app-store";
import { useT } from "../../lib/i18n/use-t";
import { workspaceDisplayName } from "./WorkspacePicker";

/** 切换启动后先等这么久再显示骨架屏；快速切换期间旧对话保持原样，不闪骨架。 */
const SKELETON_SHOW_DELAY_MS = 200;
const SKELETON_UNMOUNT_DELAY_MS = 200;

function SkeletonBlock({ className }: { className: string }) {
  return (
    <div
      className={`animate-pulse rounded-lg bg-surface-overlay motion-reduce:animate-none ${className}`}
    />
  );
}

/**
 * Native-feeling workspace switch: the stale conversation stays fully visible
 * for a short grace period while the switch resolves, so a fast switch never
 * flashes the skeleton. Only a switch that outlasts that grace period fades
 * into a chat-shaped skeleton; once the new workspace is ready it fades back.
 */
export function WorkspaceSwitchTransition({ children }: { children: ReactNode }) {
  const target = useAppStore((s) => s.workspaceSwitchTarget);
  const t = useT();
  const switching = target !== null;
  // The visual transition (fade-out + skeleton) only starts once the switch has
  // been in flight past SKELETON_SHOW_DELAY_MS, so quick switches are seamless.
  const [transitioning, setTransitioning] = useState(switching);
  const [skeletonMounted, setSkeletonMounted] = useState(switching);
  const [lastTarget, setLastTarget] = useState(target);
  if (target !== null && target !== lastTarget) setLastTarget(target);

  useEffect(() => {
    if (switching) {
      setSkeletonMounted(true);
      const timer = window.setTimeout(() => setTransitioning(true), SKELETON_SHOW_DELAY_MS);
      return () => window.clearTimeout(timer);
    }
    setTransitioning(false);
    const timer = window.setTimeout(() => setSkeletonMounted(false), SKELETON_UNMOUNT_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [switching]);

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <div
        className={`flex min-h-0 min-w-0 flex-1 flex-col transition-opacity duration-150 ease-out motion-reduce:transition-none ${
          transitioning ? "pointer-events-none opacity-0" : "opacity-100"
        }`}
        aria-hidden={transitioning || undefined}
        inert={transitioning || undefined}
      >
        {children}
      </div>
      {skeletonMounted && (
        <div
          role="status"
          aria-live="polite"
          className={`workspace-switch-skeleton absolute inset-0 z-30 flex flex-col bg-surface transition-opacity duration-150 ease-out motion-reduce:transition-none ${
            transitioning ? "opacity-100" : "pointer-events-none opacity-0"
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
