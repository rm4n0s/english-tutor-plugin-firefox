import { countWords } from "../core/analysis";
import {
  checkStatusText,
  tokenStatusText,
  wordCountText,
  type IssueState,
  type TokenTally,
} from "../core/issues";
import type { Scheduler } from "../core/clock";
import { setText } from "../ui/dom";

/** How long a short message such as "Copied" stays in the status bar. */
export const FLASH_MS = 3000;

/**
 * The status bar of the tutor page (SPEC sections 4.2 and 5.8): the check state, the word count,
 * and the tokens of the last request and of the tab's session.
 */
export class StatusBar {
  private readonly stateText: HTMLElement;
  private readonly wordsText: HTMLElement;
  private readonly tokensText: HTMLElement;
  private readonly state: IssueState;
  private readonly tally: TokenTally;
  private readonly textarea: HTMLTextAreaElement;
  private readonly scheduler: Scheduler;
  private readonly unsubscribes: (() => void)[] = [];
  private stopFlash: (() => void) | undefined;

  constructor(
    parts: { state: HTMLElement; words: HTMLElement; tokens: HTMLElement },
    state: IssueState,
    tally: TokenTally,
    textarea: HTMLTextAreaElement,
    scheduler: Scheduler,
  ) {
    this.scheduler = scheduler;
    this.stateText = parts.state;
    this.wordsText = parts.words;
    this.tokensText = parts.tokens;
    this.state = state;
    this.tally = tally;
    this.textarea = textarea;
    this.unsubscribes.push(
      state.subscribe((change) => {
        if (change !== "selection" && change !== "visibility") this.render();
      }),
      tally.subscribe(() => {
        this.render();
      }),
    );
    textarea.addEventListener("input", this.render);
    this.render();
  }

  /** Shows a short message in place of the check state, for three seconds ("Copied"). */
  flash(message: string): void {
    this.stopFlash?.();
    setText(this.stateText, message);
    this.stopFlash = this.scheduler.after(FLASH_MS, () => {
      this.stopFlash = undefined;
      this.render();
    });
  }

  destroy(): void {
    this.stopFlash?.();
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    this.textarea.removeEventListener("input", this.render);
  }

  readonly render = (): void => {
    this.stopFlash?.();
    this.stopFlash = undefined;
    setText(this.stateText, checkStatusText(this.state));
    setText(this.wordsText, wordCountText(countWords(this.textarea.value)));
    setText(this.tokensText, tokenStatusText(this.tally.last, this.tally.session));
  };
}
