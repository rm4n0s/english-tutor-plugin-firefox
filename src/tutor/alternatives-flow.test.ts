// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AlternativesOptions,
  AlternativesRequest,
  AlternativesResult,
  AnalysisModel,
} from "../core/analysis";
import { NO_USAGE } from "../core/analysis/usage";
import { AppError } from "../core/errors";
import { Logger } from "../core/log";
import { deferred } from "../core/issues/testing/helpers";
import { FakeClipboard } from "../platform/testing/fake-clipboard";
import {
  AlternativesFlow,
  COPY_FAILED_NOTE,
  EDITOR_BUSY_NOTE,
  NO_LLM_ALTERNATIVES_MESSAGE,
  TEXT_CHANGED_NOTE,
  type AlternativesRunner,
} from "./alternatives-flow";

const MODEL = { client: {}, name: "Local" } as unknown as AnalysisModel;

interface Call {
  request: AlternativesRequest;
  options: AlternativesOptions;
  done: ReturnType<typeof deferred<AlternativesResult>>;
}

class ManualSuggester implements AlternativesRunner {
  readonly calls: Call[] = [];
  cancels = 0;

  suggest(
    _model: AnalysisModel,
    request: AlternativesRequest,
    options: AlternativesOptions = {},
  ): Promise<AlternativesResult> {
    const done = deferred<AlternativesResult>();
    this.calls.push({ request, options, done });
    return done.promise;
  }

  cancel(): void {
    this.cancels++;
  }
}

const READY = (...alternatives: string[]): AlternativesResult => ({
  alternatives,
  usage: NO_USAGE,
  cancelled: false,
});
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

interface Setup {
  editor: HTMLTextAreaElement;
  host: HTMLElement;
  suggester: ManualSuggester;
  clipboard: FakeClipboard;
  flow: AlternativesFlow;
  box: { model: AnalysisModel | undefined; throws: Error | undefined };
  logged: { level: string; fields: unknown }[];
}

let s: Setup;

beforeEach(() => {
  document.body.replaceChildren();
  const editor = document.createElement("textarea");
  const host = document.createElement("div");
  document.body.append(editor, host);
  const suggester = new ManualSuggester();
  const clipboard = new FakeClipboard();
  const box: Setup["box"] = { model: MODEL, throws: undefined };
  const logged: Setup["logged"] = [];
  const sink = (level: string) => (_message: string, fields?: unknown) => {
    logged.push({ level, fields });
  };
  const flow = new AlternativesFlow(document, host, {
    editor,
    suggester,
    getModel: () => {
      if (box.throws !== undefined) throw box.throws;
      return box.model;
    },
    clipboard,
    log: new Logger({
      debug: sink("debug"),
      info: sink("info"),
      warn: sink("warn"),
      error: sink("error"),
    }),
  });
  s = { editor, host, suggester, clipboard, flow, box, logged };
});

afterEach(() => {
  Reflect.deleteProperty(document, "execCommand");
});

const q = (selector: string): HTMLElement => {
  const found = s.host.querySelector<HTMLElement>(selector);
  if (found === null) throw new Error(`nothing matches ${selector}`);
  return found;
};
const rows = () => [...s.host.querySelectorAll(".alt-row")].map((r) => r.textContent);
const click = (el: Element) => el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
const dblclick = (selector: string) =>
  q(selector).dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));

function select(
  text: string,
  start: number,
  end: number,
  direction: "forward" | "backward" = "forward",
) {
  s.editor.value = text;
  s.editor.setSelectionRange(start, end, direction);
}

/** `document.execCommand("insertText")` as a browser does it: one edit, with an `input` event. */
function installExecCommand(): ReturnType<typeof vi.fn> {
  const exec = vi.fn((command: string, _ui: boolean, value: string) => {
    expect(command).toBe("insertText");
    const { selectionStart: start, selectionEnd: end } = s.editor;
    s.editor.setRangeText(value, start, end, "end");
    s.editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    return true;
  });
  Object.defineProperty(document, "execCommand", { value: exec, configurable: true });
  return exec;
}

describe("asking (the selection)", () => {
  it.each([
    {
      name: "a forward selection",
      text: "I seen him",
      start: 0,
      end: 6,
      direction: "forward" as const,
      selected: "I seen",
    },
    {
      name: "a backwards selection",
      text: "I seen him",
      start: 0,
      end: 6,
      direction: "backward" as const,
      selected: "I seen",
    },
    // The emoji is two UTF-16 units, so offsets after it are one more than the characters.
    {
      name: "after an emoji",
      text: "😀 I seen him",
      start: 3,
      end: 9,
      direction: "forward" as const,
      selected: "I seen",
    },
    {
      name: "a backwards selection after an emoji",
      text: "😀😀 go home",
      start: 5,
      end: 7,
      direction: "backward" as const,
      selected: "go",
    },
  ])("reads $name in UTF-16 units", ({ text, start, end, direction, selected }) => {
    select(text, start, end, direction);
    expect(s.flow.ask()).toBe("asked");
    expect(s.suggester.calls[0]?.request).toEqual({ text, start, end });
    expect(text.slice(start, end)).toBe(selected);
    expect(q("#alt-selected").textContent).toBe(selected);
    expect(s.flow.panel.state).toBe("loading");
  });

  it.each([
    { name: "nothing selected", start: 3, end: 3 },
    { name: "spaces", start: 1, end: 4 },
    { name: "line breaks and a tab", start: 5, end: 8 },
  ])("does nothing for $name", ({ start, end }) => {
    select("a   b\n\n\tc", start, end);
    expect(s.flow.ask()).toBe("empty");
    expect(s.suggester.calls).toEqual([]);
    expect(s.flow.panel.state).toBe("closed");
  });

  it("shows the alternatives when they arrive", async () => {
    select("I seen him", 0, 6);
    s.flow.ask();
    s.suggester.calls[0]?.done.resolve(READY("I saw", "I have seen"));
    await tick();
    expect(s.flow.panel.state).toBe("ready");
    expect(rows()).toEqual(["I saw", "I have seen"]);
  });

  it("shows a failure with its message and logs the error without the text", async () => {
    select("I seen him", 0, 6);
    s.flow.ask();
    s.suggester.calls[0]?.done.reject(
      new AppError("SelectionTooLong", "The selection has 700 words; select at most 600.", {
        words: 700,
      }),
    );
    await tick();
    expect(s.flow.panel.state).toBe("failed");
    expect(q("#alt-error").textContent).toBe("The selection has 700 words; select at most 600.");
    expect(s.logged.filter((l) => l.level === "error")).toHaveLength(1);
    expect(JSON.stringify(s.logged)).not.toContain("I seen");
  });

  it("wraps a foreign error as LLMCallFailed", async () => {
    select("I seen him", 0, 6);
    s.flow.ask();
    s.suggester.calls[0]?.done.reject(new TypeError("boom"));
    await tick();
    const logged = JSON.stringify(s.logged.find((l) => l.level === "error")?.fields);
    expect(logged).toContain("AlternativesFlow.request->LLMCallFailed");
  });

  it("fails at once with no LLM, without a request", () => {
    s.box.model = undefined;
    select("I seen him", 0, 6);
    s.flow.ask();
    expect(s.suggester.calls).toEqual([]);
    expect(s.flow.panel.state).toBe("failed");
    expect(q("#alt-error").textContent).toBe(NO_LLM_ALTERNATIVES_MESSAGE);
  });

  it("shows a failure of getModel as the failed state", () => {
    s.box.throws = new AppError("LLMConfigInvalid", "The LLM settings are invalid.");
    select("I seen him", 0, 6);
    s.flow.ask();
    expect(q("#alt-error").textContent).toBe("The LLM settings are invalid.");
  });

  it("Retry asks again for the same selection, with the text of the first request", async () => {
    select("I seen him", 0, 6);
    s.flow.ask();
    s.suggester.calls[0]?.done.reject(new AppError("LLMCallFailed", "no"));
    await tick();
    s.editor.value = "something else entirely";
    click(q("#alt-retry"));
    expect(s.suggester.calls).toHaveLength(2);
    expect(s.suggester.calls[1]?.request).toEqual({ text: "I seen him", start: 0, end: 6 });
    expect(s.flow.panel.state).toBe("loading");
  });
});

describe("cancelling", () => {
  it("closing cancels the request, shows nothing and is not an error", async () => {
    select("I seen him", 0, 6);
    s.flow.ask();
    const call = s.suggester.calls[0];
    s.flow.close();
    expect(call?.options.signal?.aborted).toBe(true);
    expect(s.suggester.cancels).toBeGreaterThan(0);
    expect(s.flow.panel.state).toBe("closed");
    // The suggester answers with a cancelled result, or the late reply arrives anyway.
    call?.done.resolve({ alternatives: [], usage: NO_USAGE, cancelled: true });
    await tick();
    expect(s.flow.panel.state).toBe("closed");
    expect(s.logged.filter((l) => l.level === "error")).toEqual([]);
  });

  it("a late failure after closing shows nothing", async () => {
    select("I seen him", 0, 6);
    s.flow.ask();
    s.flow.close();
    s.suggester.calls[0]?.done.reject(new DOMException("aborted", "AbortError"));
    await tick();
    expect(s.flow.panel.state).toBe("closed");
    expect(s.logged.filter((l) => l.level === "error")).toEqual([]);
  });

  it("asking again replaces the panel and cancels the earlier request, whose result is ignored", async () => {
    select("I seen him", 0, 6);
    s.flow.ask();
    select("He go to school", 0, 5);
    s.flow.ask();
    expect(s.suggester.calls[0]?.options.signal?.aborted).toBe(true);
    expect(s.suggester.calls[1]?.options.signal?.aborted).toBe(false);
    expect(q("#alt-selected").textContent).toBe("He go");
    s.suggester.calls[0]?.done.resolve(READY("old one"));
    await tick();
    expect(s.flow.panel.state).toBe("loading");
    s.suggester.calls[1]?.done.resolve(READY("He goes"));
    await tick();
    expect(rows()).toEqual(["He goes"]);
    expect(s.host.querySelectorAll("#alternatives")).toHaveLength(1);
  });
});

describe("using an alternative (SPEC section 4.6)", () => {
  async function ready(text = "Yesterday I seen him.", start = 10, end = 16) {
    select(text, start, end);
    s.flow.ask();
    s.suggester.calls.at(-1)?.done.resolve(READY("I saw", "I have seen"));
    await tick();
  }

  it("re-selects the range, replaces it with execCommand, puts the caret after it and focuses the editor", async () => {
    const exec = installExecCommand();
    const inputs: string[] = [];
    s.editor.addEventListener("input", () => inputs.push(s.editor.value));
    await ready();
    // The user clicked elsewhere meanwhile: the panel re-selects the original range.
    s.editor.setSelectionRange(0, 0);
    dblclick(".alt-row:nth-child(2)");
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith("insertText", false, "I have seen");
    expect(s.editor.value).toBe("Yesterday I have seen him.");
    expect(s.editor.selectionStart).toBe(10 + "I have seen".length);
    expect(s.editor.selectionEnd).toBe(s.editor.selectionStart);
    expect(document.activeElement).toBe(s.editor);
    // One edit: one input event, so one undo step in the browser and one edit to rebase.
    expect(inputs).toEqual(["Yesterday I have seen him."]);
    expect(s.flow.panel.state).toBe("closed");
  });

  it("Enter on the list uses the selected row", async () => {
    installExecCommand();
    await ready();
    q("#alt-list").dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    expect(s.editor.value).toBe("Yesterday I saw him.");
  });

  it("replaces a range after an emoji, in UTF-16 units", async () => {
    installExecCommand();
    await ready("😀 I seen him", 3, 9);
    dblclick(".alt-row");
    expect(s.editor.value).toBe("😀 I saw him");
    expect(s.editor.selectionStart).toBe(3 + "I saw".length);
  });

  it("replaces a backwards selection", async () => {
    installExecCommand();
    select("Yesterday I seen him.", 10, 16, "backward");
    s.flow.ask();
    s.suggester.calls[0]?.done.resolve(READY("I saw"));
    await tick();
    dblclick(".alt-row");
    expect(s.editor.value).toBe("Yesterday I saw him.");
  });

  it.each([
    { name: "a letter typed inside it", edit: (v: string) => v.replace("seen", "seeen") },
    { name: "its text deleted", edit: (v: string) => v.replace("I seen", "") },
    { name: "text typed before it, which moves it", edit: (v: string) => `Oh, ${v}` },
  ])("changes nothing and says so when $name", async ({ edit }) => {
    const exec = installExecCommand();
    await ready();
    s.editor.value = edit(s.editor.value);
    const after = s.editor.value;
    dblclick(".alt-row");
    expect(exec).not.toHaveBeenCalled();
    expect(s.editor.value).toBe(after);
    expect(s.flow.panel.state).toBe("ready");
    expect(rows()).toEqual(["I saw", "I have seen"]);
    expect(q("#alt-note").textContent).toBe(TEXT_CHANGED_NOTE);
    expect(q("#alt-note").hidden).toBe(false);
  });

  it("changes nothing while a check keeps the editor read-only", async () => {
    const exec = installExecCommand();
    await ready();
    s.editor.readOnly = true;
    dblclick(".alt-row");
    expect(exec).not.toHaveBeenCalled();
    expect(s.editor.value).toBe("Yesterday I seen him.");
    expect(q("#alt-note").textContent).toBe(EDITOR_BUSY_NOTE);
  });

  it.each([
    { name: "execCommand does not exist", setup: () => undefined },
    {
      name: "execCommand returns false",
      setup: () => {
        Object.defineProperty(document, "execCommand", { value: () => false, configurable: true });
      },
    },
    {
      name: "execCommand throws",
      setup: () => {
        Object.defineProperty(document, "execCommand", {
          value: () => {
            throw new Error("not allowed");
          },
          configurable: true,
        });
      },
    },
    {
      name: "execCommand says yes and changes nothing",
      setup: () => {
        Object.defineProperty(document, "execCommand", { value: () => true, configurable: true });
      },
    },
  ])("falls back to setRangeText and an input event when $name", async ({ setup }) => {
    setup();
    const inputs: InputEvent[] = [];
    s.editor.addEventListener("input", (e) => inputs.push(e));
    await ready();
    dblclick(".alt-row");
    expect(s.editor.value).toBe("Yesterday I saw him.");
    expect(s.editor.selectionStart).toBe(15);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.inputType).toBe("insertText");
    expect(s.flow.panel.state).toBe("closed");
  });
});

describe("Copy", () => {
  it("puts the current row on the clipboard and leaves the panel open", async () => {
    select("I seen him", 0, 6);
    s.flow.ask();
    s.suggester.calls[0]?.done.resolve(READY("I saw", "I have seen"));
    await tick();
    click(q(".alt-row:nth-child(2)"));
    click(q("#alt-copy"));
    await tick();
    expect(s.clipboard.written).toEqual(["I have seen"]);
    expect(s.flow.panel.state).toBe("ready");
    expect(q("#alt-note").hidden).toBe(true);
  });

  it("says so under the list when the clipboard refuses, and does not log the text", async () => {
    s.clipboard.failWith = new AppError("ClipboardWriteFailed", "denied");
    select("I seen him", 0, 6);
    s.flow.ask();
    s.suggester.calls[0]?.done.resolve(READY("I saw"));
    await tick();
    click(q("#alt-copy"));
    await tick();
    expect(q("#alt-note").textContent).toBe(COPY_FAILED_NOTE);
    expect(JSON.stringify(s.logged)).not.toContain("I saw");
  });
});
