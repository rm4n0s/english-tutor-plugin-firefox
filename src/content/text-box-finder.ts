import type { Scheduler } from "../core/clock";
import type { Logger } from "../core/log";
import { inspectTextBox, type Inspection } from "./text-box";

/** After a focus on a box that cannot be used yet, it is looked at again after these delays (ms). */
export const RETRY_DELAYS_MS = [150, 350, 1000] as const;

/** The element that has the focus, looking inside the open shadow roots below it. */
export function deepActiveElement(doc: Document): Element | null {
  let active = doc.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return active;
}

/** The element an event target is, or the element that holds it. */
function elementOf(target: EventTarget | null): Element | null {
  if (target === null || !("nodeType" in target)) return null;
  const node = target as Node;
  return node.nodeType === 1 ? (node as Element) : node.parentElement;
}

export interface TextBoxFinderDeps {
  win: Window & typeof globalThis;
  scheduler: Scheduler;
  log: Logger;
  /** The site's host name, for the debug log. */
  host: string;
}

/**
 * Finds the text box a focus is in (`inspectTextBox`) for the content script, and does the two
 * things that make real pages work (SPEC section 4.11):
 *
 * - it says, at the debug level in the page's console, why a focused element that looks like a
 *   text box was left alone: one short fixed reason with the tag name and the host, once per
 *   element and reason, never the text;
 * - it looks again, shortly after, at a box that was focused while it could not be used yet (a
 *   modal that is still fading in has no size or is see-through), for as long as it is the
 *   element that has the focus.
 */
export class TextBoxFinder {
  private readonly deps: TextBoxFinderDeps;
  private readonly told = new WeakMap<Element, Set<string>>();
  private readonly retries = new Map<Element, () => void>();

  constructor(deps: TextBoxFinderDeps) {
    this.deps = deps;
  }

  /** The text box `target` is in, or why not. `undefined` means it is nothing like a text box. */
  find(target: EventTarget | null): Inspection | undefined {
    const inspection = inspectTextBox(target, this.deps.win);
    if (inspection !== undefined && "skip" in inspection) this.say(target, inspection.skip);
    return inspection;
  }

  private say(target: EventTarget | null, reason: string): void {
    const element = elementOf(target);
    if (element === null) return;
    const told = this.told.get(element) ?? new Set<string>();
    if (told.has(reason)) return;
    told.add(reason);
    this.told.set(element, told);
    this.deps.log.debug(`skipped a focused text box: ${reason}`, {
      tag: element.tagName.toLowerCase(),
      host: this.deps.host,
    });
  }

  /**
   * Looks at `target` again after each of `RETRY_DELAYS_MS`, while it still has the focus, and
   * calls `again` as soon as it is a text box. Stops at once for a reason that cannot change.
   */
  retry(target: EventTarget | null, again: () => void): void {
    const element = elementOf(target);
    if (element === null || this.retries.has(element)) return;
    const step = (index: number): void => {
      const delay = RETRY_DELAYS_MS[index];
      if (delay === undefined) {
        this.retries.delete(element);
        return;
      }
      this.retries.set(
        element,
        this.deps.scheduler.after(delay, () => {
          if (deepActiveElement(this.deps.win.document) !== element) {
            this.retries.delete(element);
            return;
          }
          const inspection = inspectTextBox(element, this.deps.win);
          if (inspection === undefined) {
            this.retries.delete(element);
          } else if ("found" in inspection) {
            this.retries.delete(element);
            again();
          } else if (inspection.transient) {
            step(index + 1);
          } else {
            this.retries.delete(element);
          }
        }),
      );
    };
    step(0);
  }

  /** Forgets every pending look. */
  cancel(): void {
    for (const cancel of this.retries.values()) cancel();
    this.retries.clear();
  }
}
