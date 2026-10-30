/**
 * Readers for the two streaming framings of SPEC section 6.2. They take the response body as it
 * comes from `fetch` and cope with any split of the bytes: inside a UTF-8 sequence (the
 * `TextDecoderStream` keeps the unfinished bytes), and inside a line (a line is handed on only
 * when its end has arrived).
 */

/** The lines of a byte stream. `\n`, `\r\n` and a lone `\r` end a line; the last line may lack one. */
export async function* readLines(
  body: ReadableStream<Uint8Array<ArrayBuffer>>,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  // A body that does not error by itself when the request is aborted must still stop being read.
  const stop = () => {
    reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", stop, { once: true });
  try {
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += value;
      let start = 0;
      for (let i = 0; i < buffer.length; i++) {
        const c = buffer[i];
        if (c === "\n") {
          yield buffer.slice(start, i);
          start = i + 1;
        } else if (c === "\r") {
          // A "\r" at the very end may be the first half of "\r\n": wait for the next chunk.
          if (i + 1 === buffer.length) break;
          yield buffer.slice(start, i);
          start = buffer[i + 1] === "\n" ? i + 2 : i + 1;
          i = start - 1;
        }
      }
      buffer = buffer.slice(start);
    }
    if (buffer !== "") yield buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
  } finally {
    signal?.removeEventListener("abort", stop);
    reader.releaseLock();
  }
}

export interface SseEvent {
  /** The `event:` field, "" when there is none. */
  event: string;
  /** The `data:` lines joined with a line feed. */
  data: string;
}

/** Server-Sent Events: fields until a blank line. Comments (`:`) and other fields are ignored. */
export async function* sseEvents(lines: AsyncIterable<string>): AsyncGenerator<SseEvent> {
  let event = "";
  let data: string[] = [];
  for await (const line of lines) {
    if (line === "") {
      if (data.length > 0) yield { event, data: data.join("\n") };
      event = "";
      data = [];
      continue;
    }
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") data.push(value);
    else if (field === "event") event = value;
  }
  if (data.length > 0) yield { event, data: data.join("\n") };
}

/** Newline-delimited JSON: every non-blank line is one message, with no event name. */
export async function* ndjsonMessages(lines: AsyncIterable<string>): AsyncGenerator<SseEvent> {
  for await (const line of lines) {
    if (line.trim() !== "") yield { event: "", data: line };
  }
}
