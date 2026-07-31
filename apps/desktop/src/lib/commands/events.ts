export type DockCommandRequest =
  | { kind: "toggle" }
  | { kind: "activate-visible"; index: number };

type VoidHandler = () => void;
type DockHandler = (request: DockCommandRequest) => void;

let sessionSearchHandler: VoidHandler | null = null;
let sessionSearchPending = false;
let sidebarToggleHandler: VoidHandler | null = null;
let dockHandler: DockHandler | null = null;
let shortcutHelpHandler: VoidHandler | null = null;

function subscribe<T>(
  setHandler: (handler: T | null) => void,
  handler: T,
): () => void {
  setHandler(handler);
  return () => setHandler(null);
}

export function subscribeSessionSearchFocus(handler: VoidHandler): () => void {
  const unsubscribe = subscribe((next) => { sessionSearchHandler = next; }, handler);
  if (sessionSearchPending) {
    sessionSearchPending = false;
    handler();
  }
  return unsubscribe;
}

export function requestSessionSearchFocus(): boolean {
  if (sessionSearchHandler) {
    sessionSearchHandler();
    return true;
  }
  sessionSearchPending = true;
  return false;
}

export function subscribeSidebarToggle(handler: VoidHandler): () => void {
  return subscribe((next) => { sidebarToggleHandler = next; }, handler);
}

export function requestSidebarToggle(): void {
  sidebarToggleHandler?.();
}

export function subscribeDockCommands(handler: DockHandler): () => void {
  return subscribe((next) => { dockHandler = next; }, handler);
}

export function requestDockCommand(request: DockCommandRequest): void {
  dockHandler?.(request);
}

export function subscribeShortcutHelp(handler: VoidHandler): () => void {
  return subscribe((next) => { shortcutHelpHandler = next; }, handler);
}

export function requestShortcutHelp(): void {
  shortcutHelpHandler?.();
}
