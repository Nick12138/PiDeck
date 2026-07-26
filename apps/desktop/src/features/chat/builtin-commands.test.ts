import { describe, expect, it } from "vitest";
import { matchBuiltinCommand } from "./builtin-commands";

describe("matchBuiltinCommand", () => {
  it("matches /compact with and without instructions", () => {
    expect(matchBuiltinCommand("/compact")).toEqual({ name: "compact" });
    expect(matchBuiltinCommand("  /compact  ")).toEqual({ name: "compact" });
    expect(matchBuiltinCommand("/compact keep the migration details")).toEqual({
      name: "compact",
      args: "keep the migration details",
    });
    expect(matchBuiltinCommand("/compact\nkeep multi-line\ninstructions")).toEqual({
      name: "compact",
      args: "keep multi-line\ninstructions",
    });
  });

  it("rejects unknown commands and non-command text", () => {
    expect(matchBuiltinCommand("/compactx")).toBeNull();
    expect(matchBuiltinCommand("/unknown")).toBeNull();
    expect(matchBuiltinCommand("compact")).toBeNull();
    expect(matchBuiltinCommand("run /compact")).toBeNull();
    expect(matchBuiltinCommand("/")).toBeNull();
    expect(matchBuiltinCommand("")).toBeNull();
  });
});
