import { describe, expect, it } from "vitest";
import desktopPackage from "../../package.json";

describe("Tauri resource bootstrap", () => {
  it("prepares ignored bundle resource directories before Tauri dev starts", () => {
    expect(desktopPackage.scripts["tauri:dev"]).toBe(
      "node ../../scripts/prepare-rust-test-resources.mjs && tauri dev",
    );
  });

  it("does not prepare empty development resources for a release build", () => {
    expect(desktopPackage.scripts["tauri:build"]).toBe("tauri build");
  });
});
