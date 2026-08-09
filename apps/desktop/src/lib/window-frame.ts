export type WindowFrameMode = "floating" | "filled";

export function resolveWindowFrameMode(maximized: boolean, fullscreen: boolean): WindowFrameMode {
  return maximized || fullscreen ? "filled" : "floating";
}

export function resolveWindowFrameAttribute(
  nativeWindowAvailable: boolean,
  mode: WindowFrameMode,
): WindowFrameMode | undefined {
  return nativeWindowAvailable ? mode : undefined;
}
