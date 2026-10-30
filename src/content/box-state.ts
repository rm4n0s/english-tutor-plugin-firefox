import { countWords } from "../core/analysis/text";
import { diffText, rebaseIssues, type Edit } from "../core/issues/edits";
import { MAX_WORDS, MIN_WORDS, type BoxStatus, type WireIssue } from "../core/page-mode/protocol";
import { readEditableText, type EditableText } from "./text-model";
import type { TextBoxKind } from "./text-box";

/** What a text box looks like to the badge and the underlines. */
export interface BoxView {
  readonly status: BoxStatus;
  /** Why a check failed, or why there is none (no LLM, too long). */
  readonly message: string | undefined;
  readonly issues: readonly WireIssue[];
}

/** An edit found by `sync`, with the text it added, as the port message needs it. */
export interface FoundEdit {
  readonly edit: Edit;
  readonly inserted: string;
}

/**
 * One text box the user has focused (SPEC section 4.11): its id on this page, its `session:`
 * source, the text last read, the revision (counting edits), and what the frame last said about
 * it. The content script reads the text only when the box is focused or changes, finds each edit
 * with `diffText` and moves the issues it holds the way the frame's `IssueState` does, so that
 * underlines and the badge follow the typing before the frame answers.
 */
export class BoxState implements BoxView {
  readonly id: number;
  readonly element: HTMLElement;
  readonly kind: TextBoxKind;
  /** `session:<uuid>`, made when the box is first focused on this page load (SPEC section 5.7). */
  readonly source: string;
  private readonly view: Window;
  private current: string;
  private currentRevision = 0;
  private currentModel: EditableText | undefined;
  private currentStatus: BoxStatus = "idle";
  private currentMessage: string | undefined;
  private currentIssues: readonly WireIssue[] = [];
  /** Whether the box has the focus now. */
  focused = false;

  constructor(id: number, element: HTMLElement, kind: TextBoxKind, source: string, view: Window) {
    this.id = id;
    this.element = element;
    this.kind = kind;
    this.source = source;
    this.view = view;
    this.current = "";
    this.current = this.read();
  }

  get text(): string {
    return this.current;
  }

  get revision(): number {
    return this.currentRevision;
  }

  /** The mapping from the text to the nodes of editable content; undefined for other boxes. */
  get model(): EditableText | undefined {
    return this.currentModel;
  }

  get status(): BoxStatus {
    return this.currentStatus;
  }

  get message(): string | undefined {
    return this.currentMessage;
  }

  get issues(): readonly WireIssue[] {
    return this.currentIssues;
  }

  /** Reads the text of the box now. */
  private read(): string {
    if (this.kind === "editable") {
      this.currentModel = readEditableText(this.element, this.view);
      return this.currentModel.text;
    }
    return (this.element as HTMLInputElement | HTMLTextAreaElement).value;
  }

  /**
   * Reads the box again. If the text is different, the difference is an edit (the part between
   * the common prefix and suffix, `diffText`): the revision moves on, and the issues the edit
   * touches go and the ones after it move (SPEC section 5.5). Returns the edit, or undefined when
   * nothing changed.
   */
  sync(): FoundEdit | undefined {
    const text = this.read();
    const edit = diffText(this.current, text);
    this.current = text;
    if (edit === undefined) return undefined;
    this.currentRevision++;
    this.currentIssues = rebaseIssues(this.currentIssues, edit);
    // The frame does the same: with no issue left the check says nothing about the text.
    if (this.currentIssues.length === 0 && this.currentStatus === "checked") {
      this.currentStatus = "idle";
    }
    // A text under the minimum (an emptied box) has nothing to say: no spinner for a check that
    // is no longer wanted, no failure of an earlier text, no "too long" for a text that is not.
    if (this.currentStatus !== "idle") {
      const words = countWords(text);
      if (words < MIN_WORDS || (this.currentStatus === "too-long" && words <= MAX_WORDS)) {
        this.currentStatus = "idle";
        this.currentMessage = undefined;
      }
    }
    return { edit, inserted: text.slice(edit.start, edit.start + edit.added) };
  }

  /**
   * What the frame says about the text at `revision`. Returns false, and changes nothing, when the
   * revision is not the current one: the frame answered before it had seen the latest edit, and
   * it answers again after it has.
   */
  apply(state: {
    revision: number;
    status: BoxStatus;
    message?: string | undefined;
    issues: readonly WireIssue[];
  }): boolean {
    if (state.revision !== this.currentRevision) return false;
    this.currentStatus = state.status;
    this.currentMessage = state.message;
    this.currentIssues = state.issues;
    return true;
  }
}
