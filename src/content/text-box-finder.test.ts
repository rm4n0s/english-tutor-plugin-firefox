// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Logger } from "../core/log";
import { FakeScheduler } from "../core/testing/fake-clock";
import { clearBody, setBody } from "./testing/html";
import { deepActiveElement, RETRY_DELAYS_MS, TextBoxFinder } from "./text-box-finder";

function make() {
  const lines: { message: string; fields: unknown }[] = [];
  const record = (message: string, fields?: unknown) => {
    lines.push({ message, fields });
  };
  const scheduler = new FakeScheduler();
  const finder = new TextBoxFinder({
    win: window,
    scheduler,
    log: new Logger({ debug: record, info: record, warn: record, error: record }),
    host: "example.com",
  });
  return { finder, lines, scheduler };
}

let size = 300;
beforeEach(() => {
  size = 300;
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    () =>
      ({
        width: size,
        height: size / 2,
        top: 0,
        left: 0,
        right: size,
        bottom: size / 2,
      }) as DOMRect,
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  clearBody(document);
});

describe("deepActiveElement", () => {
  it("is the focused element of the page, and looks inside open shadow roots", () => {
    const host = setBody(document, '<div id="host"><button id="plain">x</button></div>');
    const root = host.attachShadow({ mode: "open" });
    const inner = document.createElement("textarea");
    root.append(inner);
    document.getElementById("plain")?.focus();
    expect(deepActiveElement(document)?.id).toBe("plain");
    inner.focus();
    expect(deepActiveElement(document)).toBe(inner);
  });
});

describe("TextBoxFinder.find", () => {
  it.each([
    { name: "a text box", html: "<textarea></textarea>", message: undefined },
    { name: "a read-only box", html: "<textarea readonly></textarea>", message: "read-only" },
    {
      name: "a box with spellcheck off",
      html: '<textarea spellcheck="false"></textarea>',
      message: "spellcheck is off on a native text box",
    },
  ])(
    "logs $name at the debug level, once, with the tag and the host, never the text",
    ({ html, message }) => {
      const { finder, lines } = make();
      const box = setBody(document, html);
      (box as HTMLTextAreaElement).value = "my secret words";
      finder.find(box);
      finder.find(box);
      if (message === undefined) {
        expect(lines).toEqual([]);
        return;
      }
      expect(lines).toEqual([
        {
          message: `[english-tutor] skipped a focused text box: ${message}`,
          fields: { tag: "textarea", host: "example.com" },
        },
      ]);
      expect(JSON.stringify(lines)).not.toContain("secret");
    },
  );

  it("logs each different reason for the same element", () => {
    const { finder, lines } = make();
    const box = setBody(document, "<textarea readonly></textarea>");
    finder.find(box);
    box.removeAttribute("readonly");
    box.setAttribute("autocomplete", "cc-number");
    finder.find(box);
    expect(lines.map((l) => l.message)).toEqual([
      "[english-tutor] skipped a focused text box: read-only",
      "[english-tutor] skipped a focused text box: private autocomplete",
    ]);
  });

  it("says nothing for an element that is not like a text box", () => {
    const { finder, lines } = make();
    expect(finder.find(setBody(document, "<button>Go</button>"))).toBeUndefined();
    expect(lines).toEqual([]);
  });
});

describe("TextBoxFinder.retry", () => {
  const FADING = '<div contenteditable="true"><p>text</p></div>';

  it.each(RETRY_DELAYS_MS.map((_, i) => ({ attempt: i + 1 })))(
    "calls again at attempt $attempt when the box is usable by then",
    ({ attempt }) => {
      const { finder, scheduler } = make();
      const box = setBody(document, FADING);
      box.setAttribute("tabindex", "0");
      box.focus();
      size = 0;
      const again = vi.fn();
      finder.retry(box, again);
      const delays = RETRY_DELAYS_MS.slice(0, attempt);
      for (const [i, delay] of delays.entries()) {
        if (i === attempt - 1) size = 300;
        scheduler.advance(delay);
      }
      expect(again).toHaveBeenCalledTimes(1);
      expect(scheduler.pending).toBe(0);
    },
  );

  it("gives up after the last delay", () => {
    const { finder, scheduler } = make();
    const box = setBody(document, FADING);
    box.setAttribute("tabindex", "0");
    box.focus();
    size = 0;
    const again = vi.fn();
    finder.retry(box, again);
    scheduler.advance(10_000);
    expect(again).not.toHaveBeenCalled();
    expect(scheduler.pending).toBe(0);
  });

  it("stops when the element no longer has the focus", () => {
    const { finder, scheduler } = make();
    const box = setBody(document, FADING);
    box.setAttribute("tabindex", "0");
    size = 0;
    const again = vi.fn();
    finder.retry(box, again);
    size = 300;
    scheduler.advance(10_000);
    expect(again).not.toHaveBeenCalled();
  });

  it("makes one series per element", () => {
    const { finder, scheduler } = make();
    const box = setBody(document, FADING);
    box.setAttribute("tabindex", "0");
    box.focus();
    size = 0;
    finder.retry(box, vi.fn());
    finder.retry(box, vi.fn());
    expect(scheduler.pending).toBe(1);
  });

  it("cancel forgets every pending look", () => {
    const { finder, scheduler } = make();
    const box = setBody(document, FADING);
    box.setAttribute("tabindex", "0");
    box.focus();
    size = 0;
    finder.retry(box, vi.fn());
    finder.cancel();
    expect(scheduler.pending).toBe(0);
  });
});
