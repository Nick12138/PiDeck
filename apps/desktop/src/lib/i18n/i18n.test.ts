import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveLocale, translate } from "./index";
import { en } from "./en";
import { zh } from "./zh";

describe("resolveLocale", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("honors explicit language choices", () => {
    expect(resolveLocale("en")).toBe("en");
    expect(resolveLocale("zh")).toBe("zh");
  });

  it.each([
    ["en-US", "en"],
    ["zh-CN", "zh"],
    ["zh-Hans", "zh"],
  ] as const)("maps the system locale %s to %s", (language, expected) => {
    vi.stubGlobal("navigator", { language });
    expect(resolveLocale("system")).toBe(expected);
    expect(resolveLocale(undefined)).toBe(expected);
  });

  it("falls back to English without a navigator", () => {
    vi.stubGlobal("navigator", undefined);
    expect(resolveLocale("system")).toBe("en");
    expect(resolveLocale(undefined)).toBe("en");
  });
});

describe("translate", () => {
  it("returns the locale string and interpolates params", () => {
    expect(translate("en", "notifFoundModels", { count: 3 })).toBe("Found 3 models");
    expect(translate("zh", "notifFoundModels", { count: 3 })).toBe("发现 3 个模型");
    expect(translate("zh", "navGeneral")).toBe("通用");
  });

  it("has a Chinese entry for every English key", () => {
    // The type system enforces this too; the runtime check guards against
    // accidental empty strings.
    for (const key of Object.keys(en) as Array<keyof typeof en>) {
      expect(zh[key], key).toBeTruthy();
    }
  });
});
