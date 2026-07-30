export type AppTheme = "light" | "dark" | "system";
export type EffectiveTheme = Exclude<AppTheme, "system">;

export const STARTUP_THEME_STORAGE_KEY = "pideck.theme";

export function resolveEffectiveTheme(
  theme: AppTheme,
  systemPrefersLight =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: light)").matches,
): EffectiveTheme {
  return theme === "system" ? (systemPrefersLight ? "light" : "dark") : theme;
}

export function readStoredTheme(): AppTheme | null {
  try {
    const value = window.localStorage.getItem(STARTUP_THEME_STORAGE_KEY);
    return value === "light" || value === "dark" || value === "system" ? value : null;
  } catch {
    return null;
  }
}

export function applyTheme(
  theme: AppTheme,
  options: { persist?: boolean } = {},
): void {
  const { persist = true } = options;
  const root = document.documentElement;
  const effective = resolveEffectiveTheme(theme);
  if (persist) {
    try {
      window.localStorage.setItem(STARTUP_THEME_STORAGE_KEY, theme);
    } catch {
      // Hardened WebViews may disable local storage; native settings remain authoritative.
    }
  }
  root.classList.toggle("light", effective === "light");
  root.classList.toggle("dark", effective === "dark");
  root.dataset.theme = effective;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", effective === "light" ? "#f7f7f8" : "#121214");
}

export function applyStoredTheme(): void {
  applyTheme(readStoredTheme() ?? "system", { persist: false });
}
