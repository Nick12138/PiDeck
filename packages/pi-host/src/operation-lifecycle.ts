import type { GraphOperationKind } from "./locks.js";

export type GraphOperationHandle = {
  operationKind: GraphOperationKind;
  requestId: string;
  operationId: string;
  signal: AbortSignal;
  completion: Promise<void>;
  cancel: (reason: string) => void;
  finish: () => void;
};

export class GraphOperationRegistry {
  private active: GraphOperationHandle | null = null;

  begin(input: {
    operationKind: GraphOperationKind;
    requestId: string;
    operationId: string;
  }): GraphOperationHandle | null {
    if (this.active) return null;

    const controller = new AbortController();
    let resolveCompletion!: () => void;
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    let finished = false;
    const handle: GraphOperationHandle = {
      ...input,
      signal: controller.signal,
      completion,
      cancel: (reason) => {
        if (!controller.signal.aborted) controller.abort(new Error(reason));
      },
      finish: () => {
        if (finished) return;
        finished = true;
        if (this.active === handle) this.active = null;
        resolveCompletion();
      },
    };
    this.active = handle;
    return handle;
  }

  getActive(): GraphOperationHandle | null {
    return this.active;
  }

  cancelActive(reason: string): GraphOperationHandle | null {
    const active = this.active;
    active?.cancel(reason);
    return active;
  }
}
