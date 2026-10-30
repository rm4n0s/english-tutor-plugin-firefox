import { AppError } from "../../errors";

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export const MAX_PROVIDER_MESSAGE = 300;

export function cut(text: string, max = MAX_PROVIDER_MESSAGE): string {
  return text.length > max ? text.slice(0, max) : text;
}

/**
 * The message a provider gave for a failure: `error.message`, `error` as text, or a top-level
 * `message` / `detail` text. Cut to 300 characters. "" when the body has none.
 */
export function providerMessage(json: unknown): string {
  const body = asRecord(json);
  const error = body.error;
  const message =
    typeof error === "string"
      ? error
      : asString(asRecord(error).message) || asString(body.message) || asString(body.detail);
  return cut(message.trim());
}

/**
 * Parses one streamed message or a reply body. Text that is not JSON breaks the reply. The
 * parser's own message is not kept: it can quote the text.
 */
export function parseJson(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    throw new AppError("LLMCallFailed", "The server sent a reply that is not valid JSON.");
  }
}

/** The error a stream message carries, as a failure. */
export function streamError(message: string): AppError {
  const shown = message === "" ? "the server sent an error" : message;
  return new AppError("LLMCallFailed", `The server reported an error: ${shown}`, {
    stage: "stream",
  });
}

/** Adds the fields the body does not have yet; a field the body has is kept (SPEC section 6.4). */
export function addMissing(
  body: Record<string, unknown>,
  fields: Readonly<Record<string, unknown>>,
) {
  for (const [field, value] of Object.entries(fields)) {
    if (!(field in body)) body[field] = value;
  }
}
