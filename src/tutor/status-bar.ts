import { countWords } from "../core/analysis";
import {
  checkStatusText,
  tokenStatusText,
  wordCountText,
  type IssueState,
  type TokenTally,
} from "../core/issues";
import { setText } from "../ui/dom";

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
  private readonly unsubscribes: (() => void)[] = [];

  constructor(
    parts: { state: HTMLElement; words: HTMLElement; tokens: HTMLElement },
    state: IssueState,
    tally: TokenTally,
    textarea: HTMLTextAreaElement,
  ) {
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

  destroy(): void {
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    this.textarea.removeEventListener("input", this.render);
  }

  readonly render = (): void => {
    setText(this.stateText, checkStatusText(this.state));
    setText(this.wordsText, wordCountText(countWords(this.textarea.value)));
    setText(this.tokensText, tokenStatusText(this.tally.last, this.tally.session));
  };
}
