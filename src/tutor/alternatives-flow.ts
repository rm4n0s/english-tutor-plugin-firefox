import {
  trimSpace,
  type AlternativesOptions,
  type AlternativesRequest,
  type AlternativesResult,
  type AnalysisModel,
} from "../core/analysis";
import { AppError } from "../core/errors";
import type { Logger } from "../core/log";
import type { Clipboard } from "../platform/clipboard";
import { AlternativesPanel } from "../ui/alternatives-panel";

/** The failed state's message when there is no LLM (SPEC section 4.6). */
export const NO_LLM_ALTERNATIVES_MESSAGE =
  "No LLM is configured. Add one in Preferences to get alternatives.";

/** Under the list when the text at the original range is not the selected text any more. */
export const TEXT_CHANGED_NOTE = "The text changed, so nothing was replaced. Select it again.";
/** Under the list while a check keeps the editor read-only. */
export const EDITOR_BUSY_NOTE = "The text cannot be changed while a check runs.";
export const COPY_FAILED_NOTE = "Could not copy to the clipboard.";

/** What the flow needs from the suggester. `Suggester` fits. */
export interface AlternativesRunner {
  suggest(
    model: AnalysisModel,
    request: AlternativesRequest,
    options?: AlternativesOptions,
  ): Promise<AlternativesResult>;
  cancel(): void;
}

export interface AlternativesFlowDeps {
  editor: HTMLTextAreaElement;
  suggester: AlternativesRunner;
  /** The LLM to ask, read at the start of each request; undefined when none is configured. */
  getModel(): AnalysisModel | undefined;
  clipboard: Clipboard;
  log: Logger;
}

/** What `ask` found out. */
export type AskResult = "asked" | "empty";

interface Asked {
  /** The whole text when the selection was made, which the request is made from. */
  readonly snapshot: string;
  readonly start: number;
  readonly end: number;
  /** The selected text, which must still be at the range for a replacement to happen. */
  readonly selected: string;
}

/**
 * The Alternatives panel's behaviour in the tutor page (SPEC section 4.6): it reads the selection
 * of the editor, asks the suggester, shows the states in the panel, and replaces the selection
 * with the alternative the user uses. One request at a time: asking again, and closing, cancel
 * the one before, and a cancelled request is not an error (it shows nothing). The flow never
 * touches the statistics; the suggester records the usage.
 *
 * A replacement re-selects the original range and goes through
 * `document.execCommand("insertText")`, so the editor sees an ordinary edit (an `input` event,
 * which rebases the issues) and the browser makes it one step of its undo history. Only if that
 * does not change the text does it fall back to `setRangeText` and a synthetic `input` event,
 * which works but is not one undo step.
 */
export class AlternativesFlow {
  readonly panel: AlternativesPanel;
  private readonly doc: Document;
  private readonly deps: AlternativesFlowDeps;
  private asked: Asked | undefined;
  private abort: AbortController | undefined;
  /** Counts requests; a result belongs to the latest one only while it has the same number. */
  private run = 0;

  constructor(doc: Document, host: HTMLElement, deps: AlternativesFlowDeps) {
    this.doc = doc;
    this.deps = deps;
    this.panel = new AlternativesPanel(doc, host, {
      use: (text) => {
        this.use(text);
      },
      copy: (text) => {
        this.copy(text);
      },
      retry: () => {
        this.request();
      },
      close: () => {
        this.close();
      },
    });
  }

  /** The editor's selection as a range, whichever way it was made (a backwards one included). */
  selection(): { start: number; end: number; text: string } {
    const { editor } = this.deps;
    const start = Math.min(editor.selectionStart, editor.selectionEnd);
    const end = Math.max(editor.selectionStart, editor.selectionEnd);
    return { start, end, text: editor.value.slice(start, end) };
  }

  /**
   * Asks for alternatives for the editor's selection now (the **Alternative** entry). Replaces
   * the panel's content and cancels the request before. Nothing happens for an empty or
   * white-space selection.
   */
  ask(): AskResult {
    const { start, end, text } = this.selection();
    if (trimSpace(text) === "") return "empty";
    this.asked = { snapshot: this.deps.editor.value, start, end, selected: text };
    this.request();
    return "asked";
  }

  /** Closes the panel and cancels a running request. That is not an error. */
  close(): void {
    this.stop();
    this.panel.close();
  }

  destroy(): void {
    this.stop();
    this.panel.destroy();
  }

  private stop(): void {
    this.run++;
    this.abort?.abort();
    this.abort = undefined;
    this.deps.suggester.cancel();
  }

  private request(): void {
    const asked = this.asked;
    if (asked === undefined) return;
    this.stop();
    const run = this.run;
    this.panel.showLoading(asked.selected);

    let model: AnalysisModel | undefined;
    try {
      model = this.deps.getModel();
    } catch (err) {
      this.fail(err);
      return;
    }
    if (model === undefined) {
      this.panel.showFailed(NO_LLM_ALTERNATIVES_MESSAGE);
      return;
    }
    const controller = new AbortController();
    this.abort = controller;
    this.deps.suggester
      .suggest(
        model,
        { text: asked.snapshot, start: asked.start, end: asked.end },
        { signal: controller.signal },
      )
      .then(
        (result) => {
          if (run !== this.run || result.cancelled) return;
          this.panel.showReady(result.alternatives);
        },
        (err: unknown) => {
          if (run !== this.run) return;
          this.fail(err);
        },
      );
  }

  private fail(err: unknown): void {
    const error = (err instanceof AppError ? err : AppError.wrap("LLMCallFailed", err)).via(
      "AlternativesFlow.request",
    );
    this.deps.log.error("alternatives failed", { err: error });
    this.panel.showFailed(error.message);
  }

  private copy(text: string): void {
    this.deps.clipboard.writeText(text).then(
      () => {
        this.panel.clearNote();
      },
      (err: unknown) => {
        this.deps.log.warn("could not copy an alternative", { err });
        this.panel.showNote(COPY_FAILED_NOTE);
      },
    );
  }

  /** Replaces the original range with `alternative`, if the text there is still the selected text. */
  private use(alternative: string): void {
    const asked = this.asked;
    const { editor } = this.deps;
    if (asked === undefined) return;
    if (editor.value.slice(asked.start, asked.end) !== asked.selected) {
      this.panel.showNote(TEXT_CHANGED_NOTE);
      return;
    }
    if (editor.readOnly) {
      this.panel.showNote(EDITOR_BUSY_NOTE);
      return;
    }
    const before = editor.value;
    editor.focus();
    editor.setSelectionRange(asked.start, asked.end);
    let done: boolean;
    try {
      // The only way to edit a textarea that keeps the browser's undo history (SPEC section 4.6).
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- no replacement exists
      done = this.doc.execCommand("insertText", false, alternative);
    } catch {
      done = false;
    }
    if (!done || editor.value === before) {
      // The browser did not do it: edit the text directly and tell the page as typing would.
      editor.setRangeText(alternative, asked.start, asked.end, "end");
      editor.dispatchEvent(
        new InputEvent("input", { bubbles: true, inputType: "insertText", data: alternative }),
      );
    }
    this.close();
    editor.focus();
  }
}
