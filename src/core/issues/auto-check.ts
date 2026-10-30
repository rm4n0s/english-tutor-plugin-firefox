import type { Scheduler } from "../clock";

export interface AutoCheckDeps {
  scheduler: Scheduler;
  /** Whether auto-check is on, read each time. */
  enabled(): boolean;
  /** The pause in seconds, read each time the timer restarts. */
  delaySeconds(): number;
  /** Whether a check is running now. */
  busy(): boolean;
  /** Whether the text can be checked (an empty text cannot). */
  canCheck(): boolean;
  /** Starts an automatic check. */
  start(): void;
}

/**
 * The debounce of auto-check (SPEC section 5.1). Every edit restarts a timer of the configured
 * pause; when it fires the check starts. If a check is running when it fires, it does not cancel
 * it: it waits for another pause and tries again. Time comes from the injected `Scheduler`.
 */
export class AutoCheck {
  private readonly deps: AutoCheckDeps;
  private cancelTimer: (() => void) | undefined;

  constructor(deps: AutoCheckDeps) {
    this.deps = deps;
  }

  /** The text was edited: restart the pause (or stop waiting when auto-check is off). */
  edited(): void {
    this.stop();
    if (this.deps.enabled()) this.arm();
  }

  /** Stops waiting, for example because auto-check was turned off. */
  stop(): void {
    this.cancelTimer?.();
    this.cancelTimer = undefined;
  }

  private arm(): void {
    this.cancelTimer = this.deps.scheduler.after(this.deps.delaySeconds() * 1000, () => {
      this.cancelTimer = undefined;
      this.fire();
    });
  }

  private fire(): void {
    if (!this.deps.enabled()) return;
    if (this.deps.busy()) {
      this.arm();
      return;
    }
    if (this.deps.canCheck()) this.deps.start();
  }
}
