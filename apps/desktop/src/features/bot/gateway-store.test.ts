import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addGateway,
  createTelegramGateway,
  loadBotGateways,
  removeGateway,
  saveBotGateways,
} from "./gateway-store";

/** A minimal localStorage double that mirrors real write/read semantics. */
function createLocalStorageStub() {
  const store = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      store.delete(key);
    }),
    clear: vi.fn(() => store.clear()),
  };
}

describe("gateway-store", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("round-trips a gateway through save/load", () => {
    const ls = createLocalStorageStub();
    vi.stubGlobal("localStorage", ls);

    const gateway = createTelegramGateway({
      token: "123456789:AAA_HELLO_TOKEN_PADDED_TO_LEN",
      username: "my_pi_bot",
      firstName: "My Pi",
      botId: 42,
      name: "My Pi",
      boundWorkspacePath: "/agent/workspace/telegram",
    });
    const saved = addGateway(gateway);
    expect(saved).toHaveLength(1);

    // A fresh load reads the persisted JSON, not the in-memory array.
    expect(loadBotGateways()).toEqual(saved);
  });

  it("removeGateway drops only the matching id and persists the rest", () => {
    const ls = createLocalStorageStub();
    vi.stubGlobal("localStorage", ls);

    const a = addGateway(
      createTelegramGateway({
        token: "111111111:AAA_TOKEN_A_PADDING_TO_LENGTH",
        username: "bot_a",
        firstName: "A",
        botId: 1,
        name: "A",
        boundWorkspacePath: null,
      }),
    );
    addGateway(
      createTelegramGateway({
        token: "222222222:BBB_TOKEN_B_PADDING_TO_LENGTH",
        username: "bot_b",
        firstName: "B",
        botId: 2,
        name: "B",
        boundWorkspacePath: null,
      }),
    );
    expect(removeGateway(a[0]!.id)).toHaveLength(1);
    expect(loadBotGateways().map((g) => g.name)).toEqual(["B"]);
  });

  it("loadBotGateways tolerates corrupt JSON and non-array payloads", () => {
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => "{not-json"),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn(),
    });
    expect(loadBotGateways()).toEqual([]);

    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => JSON.stringify({ no: "array" })),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn(),
    });
    expect(loadBotGateways()).toEqual([]);
  });

  it("saveBotGateways is a no-op when localStorage is unavailable", () => {
    // No globalThis.localStorage in this test -> save must not throw.
    expect(() => saveBotGateways([])).not.toThrow();
  });
});
