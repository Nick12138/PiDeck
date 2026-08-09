import { describe, expect, it } from "vitest";
import macosConfig from "../../src-tauri/tauri.macos.conf.json";
import baseConfig from "../../src-tauri/tauri.conf.json";
import windowsConfig from "../../src-tauri/tauri.windows.conf.json";

type WindowConfig = {
  title: string;
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
  resizable: boolean;
  decorations: boolean;
  dragDropEnabled: boolean;
  transparent?: boolean;
  shadow?: boolean;
  backgroundColor: string;
  windowEffects?: {
    effects: string[];
    state?: string;
    radius?: number;
  };
};

const baseWindow = baseConfig.app.windows[0] as WindowConfig;
const macosWindow = macosConfig.app.windows[0] as WindowConfig;
const windowsWindow = windowsConfig.app.windows[0] as WindowConfig;

describe("native window platform configuration", () => {
  it("keeps the Cargo-managed macOS private API feature allowlisted in shared config", () => {
    expect(baseConfig.app.macOSPrivateApi).toBe(true);
  });

  it.each([
    ["macOS", macosWindow],
    ["Windows", windowsWindow],
  ])("keeps the shared window contract in the %s override", (_platform, platformWindow) => {
    expect({
      title: platformWindow.title,
      width: platformWindow.width,
      height: platformWindow.height,
      minWidth: platformWindow.minWidth,
      minHeight: platformWindow.minHeight,
      resizable: platformWindow.resizable,
      decorations: platformWindow.decorations,
      dragDropEnabled: platformWindow.dragDropEnabled,
    }).toEqual({
      title: baseWindow.title,
      width: baseWindow.width,
      height: baseWindow.height,
      minWidth: baseWindow.minWidth,
      minHeight: baseWindow.minHeight,
      resizable: baseWindow.resizable,
      decorations: baseWindow.decorations,
      dragDropEnabled: baseWindow.dragDropEnabled,
    });
    expect(platformWindow).toMatchObject({
      transparent: true,
      shadow: true,
      backgroundColor: "#00000000",
    });
  });

  it("uses semantic behind-window material on macOS", () => {
    expect(macosWindow.windowEffects).toEqual({
      effects: ["underWindowBackground"],
      state: "followsWindowActiveState",
      radius: 12,
    });
  });

  it("uses Windows Acrylic without macOS-only effect fields", () => {
    expect(windowsWindow.windowEffects).toEqual({ effects: ["acrylic"] });
  });
});
