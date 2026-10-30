import { diffText } from "./edits";
import type { IssueState } from "./state";

/**
 * Follows the text of one editor or text box and tells its `IssueState` about every change
 * (SPEC section 5.5): the page calls `changed` with the new text on each `input` event and the
 * edit is found by the common prefix and suffix of the old and the new text. Loading a text
 * (New, Open, a hand-off) is not an edit: `load` clears the issues instead. No DOM, so page mode
 * can keep one per text box.
 */
export class TrackedText {
  private readonly state: IssueState;
  private current: string;

  constructor(state: IssueState, initial = "") {
    this.state = state;
    this.current = initial;
  }

  get text(): string {
    return this.current;
  }

  /** The text is now `text`, by typing, pasting, undoing... Moves or removes the issues. */
  changed(text: string): void {
    const edit = diffText(this.current, text);
    this.current = text;
    if (edit !== undefined) this.state.applyEdit(edit);
  }

  /** A text was loaded: the issues, the selection and a running check's result go. */
  load(text: string): void {
    this.current = text;
    this.state.reset();
  }
}
