import { useEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { AlertCircle, AlertTriangle, Bell, CheckCircle2, Info, Trash2, X } from "lucide-react";
import { useT, type Translate } from "../lib/i18n/use-t";
import { useAppStore, type AppNotification } from "../lib/stores/app-store";

function levelStyle(level: string, t: Translate) {
  switch (level) {
    case "error":
      return {
        icon: AlertCircle,
        color: "text-danger",
        accent: "border-l-danger",
        label: t("notifLevelError"),
      };
    case "warning":
      return {
        icon: AlertTriangle,
        color: "text-warning",
        accent: "border-l-warning",
        label: t("notifLevelWarning"),
      };
    case "success":
      return {
        icon: CheckCircle2,
        color: "text-success",
        accent: "border-l-success",
        label: t("notifLevelSuccess"),
      };
    default:
      return {
        icon: Info,
        color: "text-info",
        accent: "border-l-info",
        label: t("notifLevelInformation"),
      };
  }
}

function notificationTime(createdAt: number) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(createdAt);
}

export function NotificationPanel({
  notifications,
  onDismiss,
  onClear,
  style,
}: {
  notifications: AppNotification[];
  onDismiss: (id: string) => void;
  onClear: () => void;
  style?: CSSProperties;
}) {
  const t = useT();
  return (
    <section
      role="dialog"
      aria-label={t("notifCenterTitle")}
      style={style}
      className="theme-floating-surface fixed z-[70] flex w-[min(22rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-lg border border-border bg-surface-raised shadow-xl"
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
            const style = levelStyle(notification.level, t);
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
}

const TOAST_DURATION_MS = 6_000;
const TOAST_LEAVE_MS = 200;
const MAX_STACKED_TOASTS = 3;

// Matches the panel width in the CSS (`w-[min(22rem,calc(100vw-1.5rem))]`);
// on desktop the 22rem cap is what applies.
const PANEL_WIDTH_PX = 22 * 16;

// The popover uses fixed positioning anchored to the bell button so it can
// overflow the sidebar's overflow:hidden (the sidebar is only 220–420px wide,
// a 22rem panel would be clipped by an absolute anchor). It opens below the
// button with its left edge aligned to the button's left edge, growing right.
// The 4px gap keeps the panel clear of the bell's hover bg.
function panelAnchorStyle(rootRef: RefObject<HTMLDivElement | null>): CSSProperties {
  const rect = rootRef.current?.getBoundingClientRect();
  if (!rect) return { visibility: "hidden" };
  const left = Math.min(rect.left, window.innerWidth - PANEL_WIDTH_PX - 8);
  const maxHeight = Math.max(200, window.innerHeight - Math.round(rect.bottom) - 16);
  return {
    left: `${Math.max(8, Math.round(left))}px`,
    top: `${Math.round(rect.bottom) + 4}px`,
    maxHeight: `${Math.min(32 * 16, maxHeight)}px`,
  };
}

type ActiveToast = { id: string; leaving: boolean };

// Module-level: survives sidebar collapse/expand remounts so an already-seen
// notification is not re-toasted on every re-mount.
let previousLatestId: string | null = null;

export function NotificationCenter() {
  const t = useT();
  const notifications = useAppStore((state) => state.notifications);
  const transientNotifications = useAppStore((state) => state.transientNotifications);
  const dismissNotification = useAppStore((state) => state.dismissNotification);
  const clearNotifications = useAppStore((state) => state.clearNotifications);
  const markNotificationsRead = useAppStore((state) => state.markNotificationsRead);
  const [open, setOpen] = useState(false);
  const [toasts, setToasts] = useState<ActiveToast[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);
  const toastTimers = useRef(new Map<string, number[]>());
  // Toasts can originate from either channel; the seq stamps preserve global
  // arrival order across the persistent history and the transient toast feed.
  const notificationFeed = [...notifications, ...transientNotifications].sort(
    (a, b) => (a.seq ?? 0) - (b.seq ?? 0),
  );
  const latestId = notificationFeed.at(-1)?.id ?? null;

  function clearToastTimers(id: string) {
    for (const timer of toastTimers.current.get(id) ?? []) window.clearTimeout(timer);
    toastTimers.current.delete(id);
  }

  function dismissAllToasts() {
    for (const id of toastTimers.current.keys()) {
      for (const timer of toastTimers.current.get(id) ?? []) window.clearTimeout(timer);
    }
    toastTimers.current.clear();
    setToasts([]);
  }

  useEffect(() => {
    if (!latestId || latestId === previousLatestId) return;
    previousLatestId = latestId;
    // The open panel already shows (and marks read) incoming notifications.
    if (open) return;
    setToasts((current) =>
      [...current.filter((toast) => toast.id !== latestId), { id: latestId, leaving: false }].slice(
        -MAX_STACKED_TOASTS,
      ),
    );
    const leaveTimer = window.setTimeout(() => {
      setToasts((current) =>
        current.map((toast) => (toast.id === latestId ? { ...toast, leaving: true } : toast)),
      );
    }, TOAST_DURATION_MS - TOAST_LEAVE_MS);
    const removeTimer = window.setTimeout(() => {
      toastTimers.current.delete(latestId);
      setToasts((current) => current.filter((toast) => toast.id !== latestId));
    }, TOAST_DURATION_MS);
    toastTimers.current.set(latestId, [leaveTimer, removeTimer]);
  }, [latestId, open]);

  useEffect(
    () => () => {
      for (const timers of toastTimers.current.values()) {
        for (const timer of timers) window.clearTimeout(timer);
      }
    },
    [],
  );

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
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

  // Re-anchor the anchored panel if the viewport changes (window resize,
  // sidebar resize handle, device pixel ratio change, scroll, etc).
  const [anchorTick, setAnchorTick] = useState(0);
  useEffect(() => {
    if (!open) return;
    const reanchor = () => setAnchorTick((n) => n + 1);
    window.addEventListener("resize", reanchor);
    window.addEventListener("scroll", reanchor, true);
    return () => {
      window.removeEventListener("resize", reanchor);
      window.removeEventListener("scroll", reanchor, true);
    };
  }, [open]);
  // anchorTick is only read indirectly via panelAnchorStyle's closure over
  // rootRef.current; referencing it here keeps the linter happy and makes the
  // re-render dependency explicit.
  void anchorTick;

  /** Only error/warning notifications are "persistent" — they appear in the center
   *  and drive the bell badge. Info/success notifications are transient (toast only). */
  const persistentNotifications = notifications.filter(
    (n) => n.level === "error" || n.level === "warning",
  );
  const hasPersistentNotifications = persistentNotifications.length > 0;

  const unreadCount = persistentNotifications.filter((n) => !n.read).length;
  const urgentUnread = notifications.some(
    (notification) =>
      !notification.read && (notification.level === "error" || notification.level === "warning"),
  );

  useEffect(() => {
    if (open && unreadCount > 0) markNotificationsRead();
  }, [open, unreadCount, markNotificationsRead]);

  // Close the panel when all persistent notifications have been dismissed.
  useEffect(() => {
    if (!hasPersistentNotifications && open) setOpen(false);
  }, [hasPersistentNotifications, open]);

  function openPanel() {
    const latest = useAppStore.getState();
    const hasPersistent = latest.notifications.some(
      (n) => n.level === "error" || n.level === "warning",
    );
    if (!hasPersistent) {
      dismissAllToasts();
      return;
    }
    setOpen(true);
    markNotificationsRead();
    dismissAllToasts();
  }

  return (
    <>
      {/* Bell and panel sit below the Settings overlay (z-40) and modals (z-50);
        the toast stack is a sibling so its own z-[70] layer stays on top of both. */}
      <div ref={rootRef} className="relative z-30">
        {hasPersistentNotifications && (
          <button
            type="button"
            title={t("notifCenterTitle")}
            aria-label={t("notifCenterLabel", { count: unreadCount })}
            aria-expanded={open}
            onClick={() => {
              if (open) {
                setOpen(false);
                return;
              }
              openPanel();
            }}
            className={`relative flex size-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-overlay hover:text-foreground ${
              urgentUnread ? "text-warning" : ""
            }`}
          >
            <Bell size={15} />
            {unreadCount > 0 && (
              <span className="absolute right-1.5 top-1 flex min-h-3 min-w-3 items-center justify-center rounded-full bg-danger px-0.5 text-[9px] leading-3 text-white">
                {unreadCount > 99 ? "99+" : unreadCount}
              </span>
            )}
          </button>
        )}

        {open && (
          <div>
            <NotificationPanel
              style={panelAnchorStyle(rootRef)}
              notifications={persistentNotifications}
              onDismiss={dismissNotification}
              onClear={clearNotifications}
            />
          </div>
        )}
      </div>
      {!open && toasts.length > 0 && (
        <div
          role="status"
          aria-live="polite"
          className="pointer-events-none fixed right-3 top-14 z-[70] flex w-[min(20rem,calc(100vw-1.5rem))] flex-col gap-2"
        >
          {toasts.map(({ id, leaving }) => {
            const notification = notificationFeed.find((item) => item.id === id);
            if (!notification) return null;
            const style = levelStyle(notification.level, t);
            const Icon = style.icon;
            return (
              <button
                key={id}
                type="button"
                onClick={openPanel}
                className={`notification-toast theme-floating-surface pointer-events-auto flex items-start gap-2 rounded-lg border border-border bg-surface-raised px-3 py-2.5 text-left shadow-xl border-l-2 ${style.accent} ${
                  leaving ? "notification-toast--leaving" : ""
                }`}
              >
                <Icon size={16} aria-label={style.label} className={`mt-0.5 ${style.color}`} />
                <span className="min-w-0 flex-1 break-words text-sm leading-5">
                  {notification.message}
                </span>
                <X
                  size={14}
                  aria-label={t("notifCenterDismissPreview")}
                  className="mt-0.5 shrink-0 text-muted"
                  onClick={(event) => {
                    event.stopPropagation();
                    clearToastTimers(id);
                    setToasts((current) => current.filter((toast) => toast.id !== id));
                  }}
                />
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}
