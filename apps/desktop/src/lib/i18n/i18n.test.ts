import { describe, expect, it } from "vitest";
import { resolveLocale, translate } from "./index";
import { en } from "./en";
import { zh } from "./zh";

describe("resolveLocale", () => {
  it("honors explicit choices and falls back to en without a navigator", () => {
    expect(resolveLocale("en")).toBe("en");
    expect(resolveLocale("zh")).toBe("zh");
    // node test environment has no navigator → system resolves to en
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
