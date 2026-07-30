/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  STARTUP_THEME_STORAGE_KEY,
  applyStoredTheme,
  applyTheme,
  readStoredTheme,
  resolveEffectiveTheme,
} from "./theme";

function mockSystemTheme(light: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockReturnValue({ matches: light }),
  });
}

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.className = "";
  document.documentElement.removeAttribute("data-theme");
  document.head.innerHTML = '<meta name="theme-color" content="#121214">';
  mockSystemTheme(false);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("theme bootstrap", () => {
  it("resolves explicit themes independently from the system appearance", () => {
    expect(resolveEffectiveTheme("light", false)).toBe("light");
    expect(resolveEffectiveTheme("dark", true)).toBe("dark");
    expect(resolveEffectiveTheme("system", true)).toBe("light");
    expect(resolveEffectiveTheme("system", false)).toBe("dark");
  });

  it("persists the preference and applies a strongly distinct document theme", () => {
    applyTheme("light");
    expect(window.localStorage.getItem(STARTUP_THEME_STORAGE_KEY)).toBe("light");
    expect(document.documentElement).toHaveClass("light");
    expect(document.documentElement).not.toHaveClass("dark");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.querySelector('meta[name="theme-color"]')).toHaveAttribute(
      "content",
      "#f7f7f8",
    );

    applyTheme("dark");
    expect(document.documentElement).toHaveClass("dark");
    expect(document.documentElement).not.toHaveClass("light");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.querySelector('meta[name="theme-color"]')).toHaveAttribute(
      "content",
      "#121214",
    );
  });

  it("restores the mirrored preference before native settings are available", () => {
    window.localStorage.setItem(STARTUP_THEME_STORAGE_KEY, "light");
    applyStoredTheme();
    expect(readStoredTheme()).toBe("light");
    expect(document.documentElement).toHaveClass("light");

    window.localStorage.setItem(STARTUP_THEME_STORAGE_KEY, "invalid");
    mockSystemTheme(false);
    applyStoredTheme();
    expect(readStoredTheme()).toBeNull();
    expect(document.documentElement).toHaveClass("dark");
  });
});
