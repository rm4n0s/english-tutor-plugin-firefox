/** Source of time, injected so that time windows can be tested. */
export interface Clock {
  /** Milliseconds since the epoch. */
  now(): number;
}

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}

/** Runs a function once after a delay, so that timed behaviour is testable without real waiting. */
export interface Scheduler {
  /** Calls `run` after `ms` milliseconds. Returns a function that cancels it (harmless once it ran). */
  after(ms: number, run: () => void): () => void;
}

export class SystemScheduler implements Scheduler {
  after(ms: number, run: () => void): () => void {
    const handle = setTimeout(run, ms);
    return () => {
      clearTimeout(handle);
    };
  }
}
