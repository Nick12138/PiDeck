import { useEffect, useRef, useState, forwardRef, type CSSProperties } from "react";
import { AlertCircle, AlertTriangle, Bell, CheckCircle2, Info, Trash2, X } from "lucide-react";
import { useT } from "../lib/i18n/use-t";
import { useAppStore, type AppNotification } from "../lib/stores/app-store";

function levelStyle(level: string) {
  switch (level) {
    case "error":
      return { icon: AlertCircle, color: "text-danger", label: "Error" };
    case "warning":
      return { icon: AlertTriangle, color: "text-warning", label: "Warning" };
    case "success":
      return { icon: CheckCircle2, color: "text-success", label: "Success" };
    default:
      return { icon: Info, color: "text-info", label: "Information" };
  }
}

function notificationTime(createdAt: number) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(createdAt);
}

// Matches the panel width in the CSS (`w-[min(25rem,calc(100vw-1.5rem))]`);
// on desktop the 25rem cap is what applies. Used to center the popover on
// the bell button without measuring the rendered element.
const PANEL_WIDTH = 25 * 16;

export const NotificationPanel = forwardRef<
  HTMLElement,
  {
    notifications: AppNotification[];
    onDismiss: (id: string) => void;
    onClear: () => void;
    anchorStyle?: CSSProperties;
  }
>(function NotificationPanel({ notifications, onDismiss, onClear, anchorStyle }, ref) {
  const t = useT();
  return (
    <section
      ref={ref}
      role="dialog"
      aria-label={t("notifCenterTitle")}
      style={anchorStyle}
      className="theme-floating-surface fixed z-[70] flex max-h-[min(32rem,calc(100vh-4.25rem))] w-[min(25rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-lg border border-border bg-surface-raised shadow-xl"
    >
      <header className="flex h-10 shrink-0 items-center border-b border-border px-3">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{t("notifCenterTitle")}</h2>
        {notifications.length > 0 && (
          <button
            type="button"
            title={t("notifCenterClearAll")}
            aria-label={t("notifCenterClearAll")}
            onClick={onClear}
            className="flex size-7 items-center justify-center rounded text-muted hover:bg-surface-overlay hover:text-foreground"
          >
            <Trash2 size={14} />
          </button>
        )}
      </header>
      {notifications.length === 0 ? (
        <div className="flex min-h-28 items-center justify-center px-4 text-sm text-muted">
          {t("notifCenterEmpty")}
        </div>
      ) : (
        <ol className="min-h-0 overflow-y-auto">
          {[...notifications].reverse().map((notification) => {
            const style = levelStyle(notification.level);
            const Icon = style.icon;
            return (
              <li
                key={notification.id}
                className="flex gap-2.5 border-b border-border/70 px-3 py-2.5 last:border-b-0"
              >
                <Icon
                  size={16}
                  aria-label={style.label}
                  className={`mt-0.5 shrink-0 ${style.color}`}
                />
                <div className="min-w-0 flex-1">
                  <p className="break-words text-sm leading-5 text-foreground">
                    {notification.message}
                  </p>
                  <time
                    dateTime={new Date(notification.createdAt).toISOString()}
                    className="mt-1 block text-[11px] text-muted"
                  >
                    {notificationTime(notification.createdAt)}
                  </time>
                </div>
                <button
                  type="button"
                  title={t("notifCenterDismiss")}
                  aria-label={t("notifCenterDismiss")}
                  onClick={() => onDismiss(notification.id)}
                  className="flex size-7 shrink-0 items-center justify-center rounded text-muted hover:bg-surface-overlay hover:text-foreground"
                >
                  <X size={14} />
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
});

export function NotificationCenter() {
  const t = useT();
  const notifications = useAppStore((state) => state.notifications);
  const dismissNotification = useAppStore((state) => state.dismissNotification);
  const clearNotifications = useAppStore((state) => state.clearNotifications);
  const [open, setOpen] = useState(false);
  const [toastId, setToastId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const previousLatestId = useRef<string | null>(null);
  const latest = notifications.at(-1) ?? null;
  const latestId = latest?.id ?? null;

  useEffect(() => {
    if (!latestId || latestId === previousLatestId.current) return;
    previousLatestId.current = latestId;
    setToastId(latestId);
    const timer = window.setTimeout(() => setToastId(null), 6_000);
    return () => window.clearTimeout(timer);
  }, [latestId]);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !panelRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      // A dialog or modal above us already acted on this Escape.
      if (event.key === "Escape" && !event.defaultPrevented) setOpen(false);
    };
    window.addEventListener("pointerdown", closeOutside);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOutside);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  // Re-anchor the panel/toast if the viewport changes (window resize,
  // sidebar resize handle, device pixel ratio change, scroll, etc).
  const [anchorTick, setAnchorTick] = useState(0);
  useEffect(() => {
    const reanchor = () => setAnchorTick((n) => n + 1);
    window.addEventListener("resize", reanchor);
    window.addEventListener("scroll", reanchor, true);
    return () => {
      window.removeEventListener("resize", reanchor);
      window.removeEventListener("scroll", reanchor, true);
    };
  }, []);
  // anchorTick is only read indirectly via getAnchorStyle's closure over
  // rootRef.current; referencing it here keeps the linter happy and makes the
  // re-render dependency explicit.
  void anchorTick;

  const toast = !open && toastId ? notifications.find((item) => item.id === toastId) : null;
  const urgentCount = notifications.filter(
    (notification) => notification.level === "error" || notification.level === "warning",
  ).length;

  // The popover/toast are rendered with fixed positioning anchored to the bell
  // button's bounding rect so they can overflow the sidebar's overflow:hidden
  // (the sidebar is only 220–420px wide; the 25rem panel would be clipped by
  // an absolute anchor). Compute the anchor on each render that matters.
  // The +0.5rem on `bottom` keeps the panel clear of the bell's hover bg.
  const getAnchorStyle = (): CSSProperties => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return { visibility: "hidden" as const };
    // Horizontally center the panel on the bell; clamp to the viewport edges
    // (at the minimum sidebar width the centering would overflow the left).
    const center = rect.left + rect.width / 2;
    const left = Math.max(8, Math.min(center - PANEL_WIDTH / 2, window.innerWidth - PANEL_WIDTH - 8));
    return {
      left: `${Math.round(left)}px`,
      bottom: `calc(100vh - ${Math.round(rect.top)}px + 0.5rem)`,
    };
  };

  return (
    <>
      {/* Bell and panel sit below the Settings overlay (z-40) and modals (z-50);
        the toast is a sibling so its own z-[70] layer stays on top of both.
        The panel/toast render as siblings of rootRef (not inside it) so their
        fixed z-[70]/[71] stack globally instead of being contained by the
        bell wrapper's z-30 stacking context. They still anchor to the bell
        via rootRef.getBoundingClientRect(). */}
      <div ref={rootRef} className="relative z-30">
        <button
          type="button"
          title={t("notifCenterTitle")}
          aria-label={t("notifCenterLabel", { count: notifications.length })}
          aria-expanded={open}
          onClick={() => {
            setOpen((value) => !value);
            setToastId(null);
          }}
          className={`relative flex size-8 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-overlay hover:text-foreground ${
            urgentCount > 0 ? "text-warning" : ""
          }`}
        >
          <Bell size={15} />
          {notifications.length > 0 && (
            <span className="absolute right-1.5 top-1 flex min-h-3 min-w-3 items-center justify-center rounded-full bg-danger px-0.5 text-[9px] leading-3 text-white">
              {notifications.length > 99 ? "99+" : notifications.length}
            </span>
          )}
        </button>
      </div>

      {open && (
        <NotificationPanel
          ref={panelRef}
          notifications={notifications}
          onDismiss={dismissNotification}
          onClear={clearNotifications}
          anchorStyle={getAnchorStyle()}
        />
      )}
      {toast && (
        <button
          type="button"
          aria-live="assertive"
          onClick={() => {
            setOpen(true);
            setToastId(null);
          }}
          style={getAnchorStyle()}
          className="theme-floating-surface fixed z-[71] flex w-[min(25rem,calc(100vw-1.5rem))] items-start gap-2 rounded-lg border border-border bg-surface-raised px-3 py-2.5 text-left shadow-xl"
        >
          {(() => {
            const style = levelStyle(toast.level);
            const Icon = style.icon;
            return <Icon size={16} aria-label={style.label} className={`mt-0.5 ${style.color}`} />;
          })()}
          <span className="min-w-0 flex-1 break-words text-sm leading-5">{toast.message}</span>
          <X
            size={14}
            aria-label={t("notifCenterDismissPreview")}
            className="mt-0.5 shrink-0 text-muted"
            onClick={(event) => {
              event.stopPropagation();
              setToastId(null);
            }}
          />
        </button>
      )}
    </>
  );
}
