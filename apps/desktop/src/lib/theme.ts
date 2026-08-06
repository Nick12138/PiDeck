import type { DesktopTheme, DesktopThemeFamily } from "@pideck/protocol";

export type AppTheme = DesktopTheme;
export type AppThemeFamily = DesktopThemeFamily;
export type EffectiveTheme = Exclude<AppTheme, "system">;

export const STARTUP_THEME_STORAGE_KEY = "pideck.theme";
export const STARTUP_THEME_FAMILY_STORAGE_KEY = "pideck.theme-family";
export const DEFAULT_THEME_FAMILY: AppThemeFamily = "pideck";

export function resolveEffectiveTheme(
  theme: AppTheme,
  systemPrefersLight = typeof window !== "undefined" &&
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

export function readStoredThemeFamily(): AppThemeFamily | null {
  try {
    const value = window.localStorage.getItem(STARTUP_THEME_FAMILY_STORAGE_KEY);
    return value === "pideck" || value === "vercel" ? value : null;
  } catch {
    return null;
  }
}

export function applyTheme(
  theme: AppTheme,
  options: { family?: AppThemeFamily; persist?: boolean } = {},
): void {
  const { family = DEFAULT_THEME_FAMILY, persist = true } = options;
  const root = document.documentElement;
  const effective = resolveEffectiveTheme(theme);
  if (persist) {
    try {
      window.localStorage.setItem(STARTUP_THEME_STORAGE_KEY, theme);
      window.localStorage.setItem(STARTUP_THEME_FAMILY_STORAGE_KEY, family);
    } catch {
      // Hardened WebViews may disable local storage; native settings remain authoritative.
    }
  }
  root.classList.toggle("light", effective === "light");
  root.classList.toggle("dark", effective === "dark");
  root.dataset.theme = effective;
  root.dataset.themeFamily = family;
  const themeColor =
    family === "vercel"
      ? effective === "light"
        ? "#ffffff"
        : "#000000"
      : effective === "light"
        ? "#ffffff"
        : "#17171b";
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", themeColor);
}

export function applyStoredTheme(): void {
  applyTheme(readStoredTheme() ?? "system", {
    family: readStoredThemeFamily() ?? DEFAULT_THEME_FAMILY,
    persist: false,
  });
}
