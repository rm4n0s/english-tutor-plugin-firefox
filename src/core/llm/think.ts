const OPEN = "<think>";
const CLOSE = "</think>";

/** The text after the last closing `</think>`: what comes before it is the model's thinking. */
export function stripThinking(text: string): string {
  const end = text.lastIndexOf(CLOSE);
  return end === -1 ? text : text.slice(end + CLOSE.length);
}

/**
 * Hides a leading `<think>...</think>` block from streamed text (SPEC section 6.2). A stream is
 * shown as it arrives, so the filter can only act on what it can know: text that starts with
 * `<think>` is held back up to the closing tag. Text that starts any other way passes at once.
 * (A reply with a closing tag only, as some templates produce, is cleaned in the final text by
 * `stripThinking`.)
 */
export class ThinkFilter {
  private mode: "undecided" | "thinking" | "text" = "undecided";
  private held = "";

  /** The part of `chunk` to show now (possibly empty). */
  push(chunk: string): string {
    if (this.mode === "text") return chunk;
    this.held += chunk;
    if (this.mode === "undecided") {
      const start = this.held.trimStart();
      if (start === "" || (start.length < OPEN.length && OPEN.startsWith(start))) return "";
      if (!start.startsWith(OPEN)) return this.release(this.held);
      this.mode = "thinking";
      this.held = start.slice(OPEN.length);
    }
    const end = this.held.indexOf(CLOSE);
    if (end === -1) {
      this.held = this.held.slice(-(CLOSE.length - 1));
      return "";
    }
    return this.release(this.held.slice(end + CLOSE.length).trimStart());
  }

  /** What is still held when the stream ends: text that never turned out to be thinking. */
  end(): string {
    return this.mode === "undecided" ? this.release(this.held) : "";
  }

  private release(text: string): string {
    this.mode = "text";
    this.held = "";
    return text;
  }
}
