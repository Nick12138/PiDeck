/**
 * Concurrency primitives for Pi Host — PROJECT_SPEC §16.1
 */

export type GraphOperationKind =
  | "system.rehydrate"
  | "system.shutdown"
  | "workspace.setCurrent"
  | "session.create"
  | "session.open"
  | "session.reload"
  | "session.setName"
  | "session.rename"
  | "session.archive"
  | "session.restore"
  | "session.delete"
  | "session.cleanup"
  | "agent.setActiveTools"
  | "model.setCurrent"
  | "provider.mutation"
  | "package.mutation"
  | "package.reload"
  | "resource.setPreference"
  | "resource.setPreferences"
  | "piSettings.patch"
  | "sdk.read";

export type LockOwner = {
  operationKind: GraphOperationKind;
  requestId: string;
  operationId?: string;
  startedAt: number;
};

export class TryMutex {
  private owner: LockOwner | null = null;
  private waiters: Array<{
    owner: Omit<LockOwner, "startedAt">;
    resolve: (acquired: boolean) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  tryAcquire(owner: Omit<LockOwner, "startedAt">): boolean {
    if (this.owner) return false;
    this.owner = { ...owner, startedAt: Date.now() };
    return true;
  }

  acquire(owner: Omit<LockOwner, "startedAt">, timeoutMs: number): Promise<boolean> {
    if (this.tryAcquire(owner)) return Promise.resolve(true);
    if (timeoutMs <= 0) return Promise.resolve(false);

    return new Promise((resolve) => {
      const waiter = {
        owner,
        resolve,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          resolve(false);
        }, timeoutMs),
      };
      waiter.timer.unref?.();
      this.waiters.push(waiter);
    });
  }

  release(requestId?: string): void {
    if (!this.owner) return;
    if (requestId && this.owner.requestId !== requestId) return;
    this.owner = null;
    const waiter = this.waiters.shift();
    if (!waiter) return;
    clearTimeout(waiter.timer);
    this.owner = { ...waiter.owner, startedAt: Date.now() };
    waiter.resolve(true);
  }

  isHeld(): boolean {
    return this.owner !== null;
  }

  getOwner(): LockOwner | null {
    return this.owner;
  }
}

export class AgentOperationLock {
  private active = false;
  private requestId: string | null = null;
  private waiters: Array<{
    requestId: string;
    resolve: (acquired: boolean) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  tryAcquire(requestId: string): boolean {
    if (this.active) return false;
    this.active = true;
    this.requestId = requestId;
    return true;
  }

  acquire(requestId: string, timeoutMs: number): Promise<boolean> {
    if (this.tryAcquire(requestId)) return Promise.resolve(true);
    if (timeoutMs <= 0) return Promise.resolve(false);
    return new Promise((resolve) => {
      const waiter = {
        requestId,
        resolve,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          resolve(false);
        }, timeoutMs),
      };
      waiter.timer.unref?.();
      this.waiters.push(waiter);
    });
  }

  release(requestId?: string): void {
    if (requestId && this.requestId && this.requestId !== requestId) return;
    this.active = false;
    this.requestId = null;
    const waiter = this.waiters.shift();
    if (!waiter) return;
    clearTimeout(waiter.timer);
    this.active = true;
    this.requestId = waiter.requestId;
    waiter.resolve(true);
  }

  isHeld(): boolean {
    return this.active;
  }
}
