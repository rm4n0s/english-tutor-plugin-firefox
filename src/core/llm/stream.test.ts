import { describe, expect, it } from "vitest";
import { ndjsonMessages, readLines, sseEvents, type SseEvent } from "./stream";
import { splitAtBytes, splitEvery } from "./testing/canned";

function bodyOf(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array<ArrayBuffer>> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk as Uint8Array<ArrayBuffer>);
      controller.close();
    },
  });
}

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of items) out.push(item);
  return out;
}

const bytes = (text: string) => new TextEncoder().encode(text);

describe("readLines", () => {
  it.each([
    { name: "no lines", text: "", expected: [] },
    { name: "one line without an end", text: "abc", expected: ["abc"] },
    { name: "lines ended by LF", text: "a\nb\n", expected: ["a", "b"] },
    { name: "lines ended by CRLF", text: "a\r\nb\r\n", expected: ["a", "b"] },
    { name: "lines ended by CR", text: "a\rb\r", expected: ["a", "b"] },
    { name: "empty lines", text: "a\n\nb\n\n", expected: ["a", "", "b", ""] },
    { name: "a last line without an end", text: "a\nb", expected: ["a", "b"] },
    { name: "multi-byte characters", text: "é日本語😀\nok\n", expected: ["é日本語😀", "ok"] },
    { name: "a CR at the very end", text: "a\r", expected: ["a"] },
  ])("$name", async ({ text, expected }) => {
    expect(await collect(readLines(bodyOf([bytes(text)])))).toEqual(expected);
  });

  it("gives the same lines for every split of the bytes, including inside a character", async () => {
    const text = "data: é日本語😀 end\r\n\r\ndata: second ✓\n\n";
    const whole = await collect(readLines(bodyOf([bytes(text)])));
    const length = bytes(text).length;
    expect(whole).toEqual(["data: é日本語😀 end", "", "data: second ✓", ""]);
    for (let cut = 1; cut < length; cut++) {
      expect(await collect(readLines(bodyOf(splitAtBytes(text, [cut]))))).toEqual(whole);
    }
    for (const size of [1, 2, 3, 5]) {
      expect(await collect(readLines(bodyOf(splitEvery(text, size))))).toEqual(whole);
    }
  });

  it("stops reading when the signal is aborted", async () => {
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array<ArrayBuffer>>({
      start(c) {
        c.enqueue(bytes("first\n"));
      },
    });
    const lines: string[] = [];
    for await (const line of readLines(body, controller.signal)) {
      lines.push(line);
      controller.abort();
    }
    expect(lines).toEqual(["first"]);
  });
});

async function* linesOf(...lines: string[]): AsyncGenerator<string> {
  await Promise.resolve();
  for (const line of lines) yield line;
}

describe("sseEvents", () => {
  it.each([
    {
      name: "data events",
      lines: ['data: {"a":1}', "", "data: [DONE]", ""],
      expected: [
        { event: "", data: '{"a":1}' },
        { event: "", data: "[DONE]" },
      ],
    },
    {
      name: "named events (Anthropic)",
      lines: ["event: message_start", 'data: {"type":"message_start"}', ""],
      expected: [{ event: "message_start", data: '{"type":"message_start"}' }],
    },
    {
      name: "several data lines in one event",
      lines: ["data: one", "data: two", ""],
      expected: [{ event: "", data: "one\ntwo" }],
    },
    {
      name: "comments and unknown fields",
      lines: [": keep-alive", "id: 7", "retry: 100", "data: x", ""],
      expected: [{ event: "", data: "x" }],
    },
    {
      name: "data without a space after the colon",
      lines: ["data:x", ""],
      expected: [{ event: "", data: "x" }],
    },
    { name: "blank lines alone", lines: ["", "", ""], expected: [] },
    {
      name: "an event at the end without a blank line",
      lines: ["data: last"],
      expected: [{ event: "", data: "last" }],
    },
    {
      name: "an event name resets after each event",
      lines: ["event: a", "data: 1", "", "data: 2", ""],
      expected: [
        { event: "a", data: "1" },
        { event: "", data: "2" },
      ],
    },
  ] as { name: string; lines: string[]; expected: SseEvent[] }[])(
    "$name",
    async ({ lines, expected }) => {
      expect(await collect(sseEvents(linesOf(...lines)))).toEqual(expected);
    },
  );
});

describe("ndjsonMessages", () => {
  it("skips blank lines", async () => {
    expect(await collect(ndjsonMessages(linesOf('{"a":1}', "", "  ", '{"b":2}')))).toEqual([
      { event: "", data: '{"a":1}' },
      { event: "", data: '{"b":2}' },
    ]);
  });
});
