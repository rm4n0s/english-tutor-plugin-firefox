/** Small facts about a failure: ids, sizes, status codes. Never user text, replies or keys. */
export type ErrorMetadata = Readonly<Record<string, string | number | boolean | null>>;

const ROUTE_SEPARATOR = "->";

/**
 * The only error type of application code (CLAUDE.md, "Error handling").
 *
 * - `tag` names the failure (PascalCase, listed in SPEC section 10).
 * - `where` holds the layers that added context with `via`, outermost first.
 * - `route()` is the `where` chain followed by the tag, for example
 *   `Analyzer.check->OpenAIClient.chat->LLMCallTimeout`.
 */
export class AppError extends Error {
  readonly tag: string;
  readonly metadata: ErrorMetadata;
  private readonly layers: string[] = [];

  constructor(
    tag: string,
    message: string,
    metadata: ErrorMetadata = {},
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "AppError";
    this.tag = tag;
    this.metadata = { ...metadata };
  }

  /**
   * Wraps a foreign error (a DOMException, a TypeError from fetch, an IndexedDB error).
   * An AppError is returned as it is: wrapping it would replace its tag.
   */
  static wrap(tag: string, err: unknown, metadata: ErrorMetadata = {}): AppError {
    if (err instanceof AppError) return err;
    const message = err instanceof Error && err.message !== "" ? err.message : "unknown error";
    return new AppError(tag, message, metadata, { cause: err });
  }

  /** The layers that added context, outermost first. */
  get where(): readonly string[] {
    return this.layers;
  }

  /** Records that the error passed through `where` (for example `"Analyzer.check"`). Returns this error. */
  via(where: string): this {
    this.layers.unshift(where);
    return this;
  }

  /** The `where` chain, outermost first, ending with the tag. */
  route(): string {
    return [...this.layers, this.tag].join(ROUTE_SEPARATOR);
  }

  /** True when `route` is a substring of this error's route. */
  hasRoute(route: string): boolean {
    return this.route().includes(route);
  }
}
