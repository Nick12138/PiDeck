import { describe, expect, it } from "vitest";
import type { Translate } from "../i18n/use-t";
import {
  hostErrorLevel,
  localizeHostError,
  TRANSIENT_HOST_ERROR_CODES,
} from "./localize-host-error";

describe("localizeHostError", () => {
  const t: Translate = (key) =>
    key === "hostErrSessionNotInWorkspace"
      ? "会话不在当前工作区，请先切换工作区"
      : key === "hostErrAgentBusy"
        ? "Agent 正忙，请等待当前运行结束后再试。"
        : key === "hostErrSessionNotFound"
          ? "会话不存在。"
          : key === "hostErrUnknown"
            ? "操作失败。"
            : `[${key}]`;

  it("maps the not-in-workspace host message to a localized string", () => {
    expect(
      localizeHostError(
        {
          code: "SESSION_NOT_FOUND",
          message: "Session is not in the current workspace; switch workspace first",
        },
        t,
      ),
    ).toBe("会话不在当前工作区，请先切换工作区");
  });

  it("maps known error codes", () => {
    expect(localizeHostError({ code: "AGENT_BUSY", message: "Agent is busy" }, t)).toBe(
      "Agent 正忙，请等待当前运行结束后再试。",
    );
    expect(localizeHostError({ code: "SESSION_NOT_FOUND", message: "Session not found" }, t)).toBe(
      "会话不存在。",
    );
  });

  it("passes through unknown error messages", () => {
    expect(localizeHostError({ code: "INTERNAL_ERROR", message: "Some detail" }, t)).toBe(
      "Some detail",
    );
  });

  it("falls back when the error is missing", () => {
    expect(localizeHostError(undefined, t)).toBe("操作失败。");
  });
});

describe("hostErrorLevel", () => {
  it("treats AGENT_BUSY as a transient (info) notification", () => {
    expect(hostErrorLevel({ code: "AGENT_BUSY", message: "Agent is busy" })).toBe("info");
  });

  it("keeps other host errors as persistent (error) notifications", () => {
    expect(hostErrorLevel({ code: "SESSION_NOT_FOUND", message: "Session not found" })).toBe(
      "error",
    );
    expect(hostErrorLevel({ code: "INTERNAL_ERROR", message: "Some detail" })).toBe("error");
  });

  it("falls back to error for missing errors", () => {
    expect(hostErrorLevel(undefined)).toBe("error");
    expect(hostErrorLevel(null)).toBe("error");
    expect(hostErrorLevel({})).toBe("error");
  });

  it("exposes AGENT_BUSY as a transient host error code", () => {
    expect(TRANSIENT_HOST_ERROR_CODES.has("AGENT_BUSY")).toBe(true);
    expect(TRANSIENT_HOST_ERROR_CODES.has("SESSION_NOT_FOUND")).toBe(false);
  });
});
