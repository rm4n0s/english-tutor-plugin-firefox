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
