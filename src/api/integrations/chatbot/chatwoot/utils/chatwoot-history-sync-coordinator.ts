type Release = () => void;

class AsyncSemaphore {
  private active = 0;
  private readonly waiters: Array<(release: Release) => void> = [];

  constructor(private readonly limit: number) {}

  public async acquire(): Promise<Release> {
    if (this.active < this.limit) {
      this.active++;
      return this.release;
    }

    return new Promise<Release>((resolve) => this.waiters.push(resolve));
  }

  private release = () => {
    const next = this.waiters.shift();
    if (next) {
      next(this.release);
      return;
    }

    this.active = Math.max(0, this.active - 1);
  };
}

const activeInstanceWriters = new Set<string>();
const instanceWriterWaiters = new Map<string, Array<(release: Release) => void>>();
const incrementalCapacity = new AsyncSemaphore(4);
const fullCapacity = new AsyncSemaphore(2);

const releaseInstanceWriter = (instanceName: string) => {
  const waiters = instanceWriterWaiters.get(instanceName);
  const next = waiters?.shift();
  if (next) {
    next(() => releaseInstanceWriter(instanceName));
    return;
  }

  instanceWriterWaiters.delete(instanceName);
  activeInstanceWriters.delete(instanceName);
};

export const tryAcquireHistoryWriter = (instanceName: string): Release | null => {
  if (activeInstanceWriters.has(instanceName)) {
    return null;
  }

  activeInstanceWriters.add(instanceName);
  return () => releaseInstanceWriter(instanceName);
};

export const acquireHistoryWriter = async (instanceName: string): Promise<Release> => {
  const immediate = tryAcquireHistoryWriter(instanceName);
  if (immediate) {
    return immediate;
  }

  return new Promise<Release>((resolve) => {
    const waiters = instanceWriterWaiters.get(instanceName) || [];
    waiters.push(resolve);
    instanceWriterWaiters.set(instanceName, waiters);
  });
};

export const acquireFullHistoryCapacity = () => fullCapacity.acquire();

type IncrementalRunner = (since: string) => Promise<void>;
type IncrementalWaiter = { resolve: () => void; reject: (error: unknown) => void };
type IncrementalState = {
  running: boolean;
  pendingSince: string | null;
  runner: IncrementalRunner;
  waiters: IncrementalWaiter[];
};

const incrementalStates = new Map<string, IncrementalState>();

const earliestTimestamp = (left: string | null, right: string) => {
  if (!left) return right;
  return new Date(left).getTime() <= new Date(right).getTime() ? left : right;
};

const drainIncremental = async (instanceName: string, state: IncrementalState) => {
  state.running = true;
  const releaseCapacity = await incrementalCapacity.acquire();
  let failure: unknown;

  try {
    while (state.pendingSince) {
      const since = state.pendingSince;
      state.pendingSince = null;
      await state.runner(since);
    }
  } catch (error) {
    failure = error;
  } finally {
    releaseCapacity();
    state.running = false;
    incrementalStates.delete(instanceName);
  }

  const waiters = state.waiters.splice(0);
  for (const waiter of waiters) {
    if (failure) waiter.reject(failure);
    else waiter.resolve();
  }
};

export const enqueueIncrementalHistorySync = (
  instanceName: string,
  since: string,
  runner: IncrementalRunner,
): Promise<void> => {
  let state = incrementalStates.get(instanceName);
  if (!state) {
    state = { running: false, pendingSince: null, runner, waiters: [] };
    incrementalStates.set(instanceName, state);
  }

  state.pendingSince = earliestTimestamp(state.pendingSince, since);
  state.runner = runner;

  const completion = new Promise<void>((resolve, reject) => state?.waiters.push({ resolve, reject }));
  if (!state.running) {
    void drainIncremental(instanceName, state);
  }

  return completion;
};
