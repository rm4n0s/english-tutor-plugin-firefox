/** One running request at a time: `begin` cancels the one before it (SPEC section 7). */
export class Flight {
  private current: AbortController | undefined;

  /**
   * Cancels the running request, if any, and starts a new one. Its signal aborts when `parent`
   * aborts, when a newer request begins, or on `stop`. Call `end` when the request is over.
   */
  begin(parent?: AbortSignal): { signal: AbortSignal; end(): void } {
    this.current?.abort();
    const controller = new AbortController();
    this.current = controller;
    const onParent = () => {
      controller.abort(parent?.reason);
    };
    if (parent?.aborted === true) controller.abort(parent.reason);
    else parent?.addEventListener("abort", onParent, { once: true });
    return {
      signal: controller.signal,
      end: () => {
        parent?.removeEventListener("abort", onParent);
        if (this.current === controller) this.current = undefined;
      },
    };
  }

  /** Cancels the running request, if any. */
  stop(): void {
    this.current?.abort();
  }
}
