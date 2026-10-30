import type { Clock, Scheduler } from "../clock";

/** A clock that only moves when a test says so. */
export class FakeClock implements Clock {
  private current: number;

  constructor(start = 0) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  advance(ms: number): void {
    this.current += ms;
  }

  set(ms: number): void {
    this.current = ms;
  }
}

/** A scheduler that runs its functions when a test advances time. */
export class FakeScheduler implements Scheduler {
  private current = 0;
  private nextId = 0;
  private readonly waiting = new Map<number, { at: number; run: () => void }>();

  after(ms: number, run: () => void): () => void {
    const id = this.nextId++;
    this.waiting.set(id, { at: this.current + ms, run });
    return () => {
      this.waiting.delete(id);
    };
  }

  /** Moves time forward and runs, in order, every function that has come due. */
  advance(ms: number): void {
    const target = this.current + ms;
    for (;;) {
      let due: [number, { at: number; run: () => void }] | undefined;
      for (const entry of this.waiting) {
        if (entry[1].at <= target && (due === undefined || entry[1].at < due[1].at)) due = entry;
      }
      if (due === undefined) break;
      this.waiting.delete(due[0]);
      this.current = due[1].at;
      due[1].run();
    }
    this.current = target;
  }

  /** The number of functions still waiting. */
  get pending(): number {
    return this.waiting.size;
  }
}
