import { describe, expect, it } from "vitest";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  beginQueueTransaction,
  finishQueueTransaction,
  getQueueSnapshot,
  observeQueueUpdate,
} from "./queue-state.js";

function queueSession() {
  const steering: string[] = [];
  const followUp: string[] = [];
  const session = {
    getSteeringMessages: () => steering,
    getFollowUpMessages: () => followUp,
  } as unknown as AgentSession;
  return { session, steering, followUp };
}

describe("queue state revisions", () => {
  it("increments once per observed logical queue change", () => {
    const { session, followUp } = queueSession();
    expect(getQueueSnapshot(session)).toEqual({
      revision: 0,
      steering: [],
      followUp: [],
    });

    followUp.push("one");
    expect(observeQueueUpdate(session)).toEqual({
      changed: true,
      suppressed: false,
      queue: { revision: 1, steering: [], followUp: ["one"] },
    });
    expect(observeQueueUpdate(session).changed).toBe(false);
    expect(getQueueSnapshot(session).revision).toBe(1);
  });

  it("suppresses intermediate rebuilds and commits one final revision", () => {
    const { session, steering, followUp } = queueSession();
    followUp.push("old");
    expect(getQueueSnapshot(session).revision).toBe(0);

    beginQueueTransaction(session);
    followUp.length = 0;
    expect(observeQueueUpdate(session)).toEqual(
      expect.objectContaining({ changed: true, suppressed: true }),
    );
    steering.push("new steer");
    followUp.push("new follow-up");
    expect(observeQueueUpdate(session)).toEqual(
      expect.objectContaining({ changed: true, suppressed: true }),
    );

    expect(finishQueueTransaction(session)).toEqual({
      changed: true,
      queue: {
        revision: 1,
        steering: ["new steer"],
        followUp: ["new follow-up"],
      },
    });
  });

  it("does not consume a revision when rollback restores the original queue", () => {
    const { session, followUp } = queueSession();
    followUp.push("first", "second");
    expect(getQueueSnapshot(session).revision).toBe(0);

    beginQueueTransaction(session);
    followUp.splice(0, followUp.length, "partial");
    observeQueueUpdate(session);
    followUp.splice(0, followUp.length, "first", "second");
    observeQueueUpdate(session);

    expect(finishQueueTransaction(session)).toEqual({
      changed: false,
      queue: {
        revision: 0,
        steering: [],
        followUp: ["first", "second"],
      },
    });
  });
});
