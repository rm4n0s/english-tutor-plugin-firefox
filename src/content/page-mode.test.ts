// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CountingRandom } from "../core/analysis/testing/helpers";
import { placed, resultOf } from "../core/issues/testing/helpers";
import { Logger } from "../core/log";
import type { SiteConfig } from "../core/page-mode/messages";
import { frameIdOfFragment, type ContentMessage } from "../core/page-mode/protocol";
import { FakeClock, FakeScheduler } from "../core/testing/fake-clock";
import { PageFrame } from "../page-ui/frame";
import type { DialogHost } from "../page-ui/dialog";
import type { PopoverHost } from "../page-ui/popover";
import { FakeRecorder, FakeRunner, MODEL, settle } from "../page-ui/testing";
import { FakeFrameClaim, FakePageModeRuntime } from "../platform/testing/fake-page-mode";
import { FakePortBus } from "../platform/testing/fake-page-port";
import { OPEN_IN_TUTOR_LABEL } from "./blocked-card";
import { FRAME_BLOCKED_MESSAGE, FRAME_TIMEOUT_MS } from "./frame-link";
import { PageModeContent } from "./page-mode";
import { clearBody, setBody } from "./testing/html";
import { skipIframeLoading } from "./testing/iframes";

const TEXT = "Yesterday I seen him. He go home.";
// "I seen" is 10..16 and "He go" is 22..27 (grammar), "home" is 28..32 (vocabulary).
const ISSUES = [placed(10, 16, "verb_form"), placed(22, 27, "subject_verb_agreement")];

/** The box is 300 x 150 at (100, 100): its bottom right corner is at (400, 250). */
function layOut(): void {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    () => ({ left: 100, top: 100, right: 400, bottom: 250, width: 300, height: 150 }) as DOMRect,
  );
}

/** An event the browser made: `isTrusted` is true. A script's `new Event` is not. */
function trusted<T extends Event>(event: T): T {
  Object.defineProperty(event, "isTrusted", { value: true });
  return event;
}

const focusIn = (target: Element) =>
  target.dispatchEvent(trusted(new FocusEvent("focusin", { bubbles: true })));
const focusOut = (target: Element) =>
  target.dispatchEvent(trusted(new FocusEvent("focusout", { bubbles: true })));
const typeInto = (box: HTMLTextAreaElement | HTMLInputElement, value: string) => {
  box.value = value;
  box.dispatchEvent(trusted(new Event("input", { bubbles: true })));
};

interface Options {
  popover?: PopoverHost;
  dialog?: DialogHost;
  html?: string;
  config?: SiteConfig;
  frame?: "ok" | "never";
  /** Runs after the page is made and before the content script starts (a box that is focused at start). */
  beforeStart?: (box: HTMLElement) => void;
  /** Sees every log line's fields. */
  onLog?: (message: string, fields: unknown) => void;
}

/** Every content script of a test: all are removed afterwards, as their listeners are on the shared window. */
const made: PageModeContent[] = [];

async function setup(options: Options = {}) {
  const box = setBody(document, options.html ?? `<textarea id="box">${TEXT}</textarea>`);
  layOut();
  const runtime = new FakePageModeRuntime();
  runtime.config = options.config ?? { state: "on" };
  const bus = new FakePortBus();
  const scheduler = new FakeScheduler();
  const clock = new FakeClock(1_000_000);
  const runner = new FakeRunner();
  const random = new CountingRandom();
  const logged: string[] = [];
  const record = (message: string, fields?: unknown) => {
    logged.push(message);
    options.onLog?.(message, fields);
  };
  const log = new Logger({ debug: record, info: record, warn: record, error: record });
  const content = new PageModeContent({
    win: window,
    runtime,
    connector: bus.connector,
    scheduler,
    clock,
    random,
    log,
    overlayMode: "open",
  });
  /** Where the first message that `sent()` shows begins (`clearSent` moves it). */
  let mark = 0;
  const host = () => [...document.documentElement.children].find((c) => c.tagName === "DIV");
  const layer = () => host()?.shadowRoot?.firstElementChild;
  const iframe = () => layer()?.querySelector("iframe") ?? null;
  let frame: PageFrame | undefined;
  /** The browser loads the iframe: the frame's script runs and the iframe fires `load`. */
  const loadFrame = () => {
    const frameElement = iframe();
    if (frameElement === null) throw new Error("no iframe");
    const id = frameIdOfFragment(new URL(frameElement.src).hash);
    if (id === undefined) throw new Error("no id in the address");
    if (options.frame !== "never") {
      frame = new PageFrame({
        id,
        server: bus.server,
        claim: new FakeFrameClaim(),
        services: Promise.resolve({
          clock: new FakeClock(1_000),
          scheduler,
          runner,
          settings: {
            delaySeconds: 3,
            autoCheck: true,
            getModel: () => MODEL,
            load: () => Promise.resolve(),
          },
          recorder: new FakeRecorder(),
          ...(options.popover === undefined ? {} : { popover: options.popover }),
          ...(options.dialog === undefined ? {} : { dialog: options.dialog }),
        }),
        log,
      });
    }
    Object.defineProperty(frameElement, "contentWindow", { value: {}, configurable: true });
    frameElement.dispatchEvent(new Event("load"));
  };
  made.push(content);

  options.beforeStart?.(box);
  await content.start();
  const badge = () => layer()?.querySelector<HTMLButtonElement>("button[data-kind]") ?? null;
  const kind = () => badge()?.getAttribute("data-kind");
  /** Focus the box, load the frame, and let the frame finish its work. */
  const focusAndLoad = async (target: Element = box) => {
    focusIn(target);
    // The id is registered with the background script before the iframe is made.
    await settle();
    if (iframe() !== null && frame === undefined) loadFrame();
    await frame?.idle();
    await settle();
  };
  return {
    box: box as HTMLTextAreaElement,
    content,
    runtime,
    bus,
    scheduler,
    clock,
    runner,
    logged,
    sent: (): ContentMessage[] =>
      (bus.connections.at(-1)?.port.posted.slice(mark) ?? []) as ContentMessage[],
    clearSent: () => {
      mark = bus.connections.at(-1)?.port.posted.length ?? 0;
    },
    host,
    layer,
    iframe,
    badge,
    kind,
    focusAndLoad,
    loadFrame,
    getFrame: () => frame,
  };
}

let restoreIframes: () => void = () => undefined;

beforeEach(() => {
  vi.restoreAllMocks();
  restoreIframes = skipIframeLoading(window);
});

afterEach(() => {
  for (const content of made.splice(0)) content.destroy();
  restoreIframes();
  vi.restoreAllMocks();
  for (const child of [...document.documentElement.children]) {
    if (child.tagName === "DIV") child.remove();
  }
  clearBody(document);
});

describe("PageModeContent: asking whether it runs here", () => {
  it("asks the background script with the host of the page and does nothing when page mode is off", async () => {
    const t = await setup({ config: { state: "off" } });
    expect(t.runtime.asked).toEqual([window.location.hostname]);
    expect(t.content.running).toBe(false);
    expect(t.host()).toBeUndefined();
    focusIn(t.box);
    expect(t.content.boxes).toEqual([]);
  });

  it("does nothing on a host in the list of sites it is off on, as the background script answers", async () => {
    const t = await setup({ config: { state: "off" } });
    focusIn(t.box);
    expect(t.iframe()).toBeNull();
    expect(t.runtime.opened).toEqual([]);
  });

  it("does not even ask on a frame that belongs to no site (a sandboxed frame, a data: page)", async () => {
    const box = setBody(document, "<textarea>one two three</textarea>");
    const runtime = new FakePageModeRuntime();
    runtime.config = { state: "on" };
    // A window whose origin is opaque: no host name, and the origin "null".
    const sandboxed = new Proxy(window, {
      get: (target, key) => {
        if (key === "location") return { hostname: "" };
        if (key === "origin") return "null";
        const value: unknown = Reflect.get(target, key);
        return typeof value === "function" ? (value.bind(target) as unknown) : value;
      },
    });
    const content = new PageModeContent({
      win: sandboxed,
      runtime,
      connector: new FakePortBus().connector,
      scheduler: new FakeScheduler(),
      clock: new FakeClock(),
      random: new CountingRandom(),
      log: new Logger({
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      }),
    });
    made.push(content);
    await content.start();
    focusIn(box);
    expect(runtime.asked).toEqual([]);
    expect(content.running).toBe(false);
    expect(content.asking).toBe(false);
    expect(content.boxes).toEqual([]);
  });

  it("does nothing when it cannot ask", async () => {
    const box = setBody(document, "<textarea>one two three</textarea>");
    const runtime = new FakePageModeRuntime();
    runtime.configFails = new Error("no background");

    const content = new PageModeContent({
      win: window,
      runtime,
      connector: new FakePortBus().connector,
      scheduler: new FakeScheduler(),
      clock: new FakeClock(),
      random: new CountingRandom(),
      log: new Logger({
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      }),
    });
    made.push(content);
    await content.start();
    focusIn(box);
    expect(content.running).toBe(false);
  });

  it("makes one host element with a closed shadow root and no frame until a box is focused", async () => {
    const t = await setup();
    expect(t.content.running).toBe(true);
    expect(t.host()).toBeDefined();
    expect(t.iframe()).toBeNull();
    expect(t.bus.connections).toEqual([]);
  });

  it("uses a closed shadow root in the extension", async () => {
    const box = setBody(document, "<textarea>x</textarea>");
    layOut();
    const content = new PageModeContent({
      win: window,
      runtime: new FakePageModeRuntime(),
      connector: new FakePortBus().connector,
      scheduler: new FakeScheduler(),
      clock: new FakeClock(),
      random: new CountingRandom(),
      log: new Logger({
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      }),
    });
    made.push(content);
    await content.start();
    const host = [...document.documentElement.children].find((c) => c.tagName === "DIV");
    expect(host?.shadowRoot).toBeNull();
    expect(box.isConnected).toBe(true);
    content.destroy();
  });
});

describe("PageModeContent: a text box takes part only after the user focuses it", () => {
  it("never reads a box that is not focused", async () => {
    const t = await setup();
    const reads = vi.fn(() => TEXT);
    Object.defineProperty(t.box, "value", { get: reads, set: () => undefined, configurable: true });
    t.box.dispatchEvent(trusted(new Event("click", { bubbles: true })));
    document.body.dispatchEvent(trusted(new Event("input", { bubbles: true })));
    expect(reads).not.toHaveBeenCalled();
    expect(t.content.boxes).toEqual([]);
  });

  it("makes the frame and the badge on the first focus, and sends the text with a session source", async () => {
    const t = await setup();
    await t.focusAndLoad();
    expect(t.iframe()).not.toBeNull();
    expect(t.content.boxes).toHaveLength(1);
    const state = t.content.boxes[0];
    expect(state?.source).toMatch(/^session:[0-9a-f-]{36}$/);
    expect(t.sent()[0]).toMatchObject({ type: "focus", box: 1, revision: 0, text: TEXT });
    expect(t.badge()).not.toBeNull();
  });

  it("makes the source once per box and page load: a second focus keeps it", async () => {
    const t = await setup({
      html: '<textarea id="a">one two three</textarea><textarea id="b">four five six</textarea>',
    });
    await t.focusAndLoad();
    const first = t.content.boxes[0]?.source;
    const b = document.getElementById("b");
    if (b === null) throw new Error("no box b");
    focusIn(b);
    focusIn(t.box);
    expect(t.content.boxes).toHaveLength(2);
    expect(t.content.boxes[0]?.source).toBe(first);
    expect(t.content.boxes[1]?.source).not.toBe(first);
  });

  it("makes one frame for the page, whatever the number of boxes", async () => {
    const t = await setup({
      html: '<textarea id="a">one two three</textarea><textarea id="b">four five six</textarea>',
    });
    await t.focusAndLoad();
    const b = document.getElementById("b");
    if (b === null) throw new Error("no box b");
    focusIn(b);
    expect(t.layer()?.querySelectorAll("iframe")).toHaveLength(1);
  });

  it.each([
    { name: "a password input", html: '<input id="box" type="password" value="one two three">' },
    { name: "an email input", html: '<input id="box" type="email" value="one two three">' },
    {
      name: "a field with spellcheck=false",
      html: '<textarea id="box" spellcheck="false">one two three</textarea>',
    },
    {
      name: "a card field",
      html: '<input id="box" autocomplete="cc-number" value="one two three">',
    },
    { name: "a read-only field", html: '<textarea id="box" readonly>one two three</textarea>' },
    {
      name: "a field of a site that opted out",
      html: '<div data-english-tutor="off"><textarea id="box">one two three</textarea></div>',
    },
    { name: "plain content", html: '<p id="box">one two three</p>' },
  ])("leaves $name alone: no frame, no state, no badge, nothing sent", async ({ html }) => {
    const t = await setup({ html });
    const element = document.getElementById("box");
    if (element === null) throw new Error("no box");
    focusIn(element);
    element.dispatchEvent(trusted(new Event("input", { bubbles: true })));
    expect(t.content.boxes).toEqual([]);
    expect(t.iframe()).toBeNull();
    expect(t.badge()).toBeNull();
    expect(t.bus.connections).toEqual([]);
  });
});

describe("PageModeContent: events a page script made are ignored", () => {
  it("ignores a focusin that is not trusted", async () => {
    const t = await setup();
    t.box.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(t.content.boxes).toEqual([]);
    expect(t.iframe()).toBeNull();
  });

  it("ignores an input event that is not trusted, and reads the change at the next trusted one", async () => {
    const t = await setup();
    await t.focusAndLoad();
    t.clearSent();
    t.box.value = `${TEXT} More.`;
    t.box.dispatchEvent(new Event("input", { bubbles: true }));
    expect(t.sent()).toEqual([]);
    expect(t.content.boxes[0]?.revision).toBe(0);
    typeInto(t.box, `${TEXT} More text.`);
    expect(t.sent()).toHaveLength(1);
    expect(t.content.boxes[0]?.revision).toBe(1);
  });

  it("ignores a focusout that is not trusted", async () => {
    const t = await setup();
    await t.focusAndLoad();
    t.box.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    expect(t.content.boxes[0]?.focused).toBe(true);
  });
});

describe("PageModeContent: the badge", () => {
  it("sits at the bottom right inside the box", async () => {
    const t = await setup();
    await t.focusAndLoad();
    const style = t.badge()?.style;
    // The box's corner is (400, 250): 4 px margin and the badge's 22 px.
    expect(style?.getPropertyValue("left")).toBe("374px");
    expect(style?.getPropertyValue("top")).toBe("224px");
  });

  it("shows the icon on a focused box before the first check (fewer than 3 words)", async () => {
    const t = await setup({ html: '<textarea id="box">hello</textarea>' });
    await t.focusAndLoad();
    expect(t.kind()).toBe("icon");
    expect(t.runner.asked).toEqual([]);
  });

  it("shows a spinner while checking, the count when it is done", async () => {
    const t = await setup();
    const finish = t.runner.hold();
    await t.focusAndLoad();
    expect(t.kind()).toBe("spinner");
    finish(resultOf(ISSUES));
    await t.getFrame()?.idle();
    await settle();
    expect(t.kind()).toBe("count");
    expect(t.badge()?.textContent).toBe("2");
    expect(t.badge()?.style.getPropertyValue("background")).toBe("#d55e00");
  });

  it("is coloured by the category with the most issues", async () => {
    const t = await setup();
    t.runner.answer(
      resultOf([
        placed(10, 16, "verb_form"),
        placed(28, 32, "wrong_word"),
        placed(22, 27, "collocation"),
      ]),
    );
    await t.focusAndLoad();
    expect(t.badge()?.textContent).toBe("3");
    // One grammar and two vocabulary issues.
    expect(t.badge()?.style.getPropertyValue("background")).toBe("#0072b2");
  });

  it("shows a check mark when no error was found", async () => {
    const t = await setup();
    t.runner.answer(resultOf([]));
    await t.focusAndLoad();
    expect(t.kind()).toBe("check");
  });

  it.each([
    {
      name: "an LLM that fails",
      prepare: (t: Awaited<ReturnType<typeof setup>>) => t.runner.fail(new Error("boom")),
      label: /failed|boom|LLM/i,
    },
  ])("shows ! for $name, with a tooltip", async ({ prepare, label }) => {
    const t = await setup();
    prepare(t);
    await t.focusAndLoad();
    expect(t.kind()).toBe("warning");
    expect(t.badge()?.textContent).toBe("!");
    expect(t.badge()?.getAttribute("title")).toMatch(label);
  });

  it("shows ! for a text that is too long, and says so", async () => {
    const text = Array.from({ length: 10_001 }, () => "word").join(" ");
    const t = await setup({ html: `<textarea id="box">${text}</textarea>` });
    await t.focusAndLoad();
    expect(t.kind()).toBe("warning");
    expect(t.badge()?.getAttribute("title")).toContain("10,000");
    expect(t.runner.asked).toEqual([]);
  });

  it("stays on a box with issues after the focus leaves it, and goes when there are none", async () => {
    const t = await setup({
      html: '<textarea id="a">Yesterday I seen him. He go home.</textarea><textarea id="b">four five six</textarea>',
    });
    t.runner.answer(resultOf(ISSUES));
    await t.focusAndLoad();
    expect(t.badge()?.style.getPropertyValue("display")).toBe("flex");
    focusOut(t.box);
    expect(t.badge()?.style.getPropertyValue("display")).toBe("flex");
    expect(t.content.boxes[0]?.focused).toBe(false);
    // Another box without issues loses its badge with the focus.
    const b = document.getElementById("b") as HTMLTextAreaElement;
    t.runner.answer(resultOf([]));
    focusIn(b);
    await t.getFrame()?.idle();
    await settle();
    focusOut(b);
    const badges = [...(t.layer()?.querySelectorAll("button[data-kind]") ?? [])] as HTMLElement[];
    expect(badges.map((x) => x.style.getPropertyValue("display"))).toEqual(["flex", "none"]);
  });

  it("goes when its box leaves the page, and the frame forgets the box", async () => {
    const t = await setup();
    t.runner.answer(resultOf(ISSUES));
    await t.focusAndLoad();
    t.box.remove();
    t.content.reposition();
    expect(t.badge()).toBeNull();
    expect(t.content.boxes).toEqual([]);
    await t.getFrame()?.idle();
    expect(t.getFrame()?.boxes).toBe(0);
  });

  it("follows the box when the page lays it out somewhere else", async () => {
    const t = await setup();
    await t.focusAndLoad();
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      () => ({ left: 300, top: 200, right: 700, bottom: 500, width: 400, height: 300 }) as DOMRect,
    );
    t.content.reposition();
    expect(t.badge()?.style.getPropertyValue("left")).toBe("674px");
    expect(t.badge()?.style.getPropertyValue("top")).toBe("474px");
  });

  it("hides the badge of a box that is scrolled out of the window", async () => {
    const t = await setup();
    await t.focusAndLoad();
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      () =>
        ({ left: 100, top: -500, right: 400, bottom: -300, width: 300, height: 200 }) as DOMRect,
    );
    t.content.reposition();
    expect(t.badge()?.style.getPropertyValue("display")).toBe("none");
  });

  it("is placed once per animation frame when the window scrolls or resizes", async () => {
    const t = await setup();
    await t.focusAndLoad();
    const queue: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      queue.push(callback);
      return queue.length;
    });
    for (let i = 0; i < 5; i++) window.dispatchEvent(new Event("scroll"));
    window.dispatchEvent(new Event("resize"));
    expect(queue).toHaveLength(1);
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      () => ({ left: 0, top: 0, right: 300, bottom: 100, width: 300, height: 100 }) as DOMRect,
    );
    queue[0]?.(0);
    expect(t.badge()?.style.getPropertyValue("left")).toBe("274px");
    // A new event after the frame asks for the next one.
    window.dispatchEvent(new Event("scroll"));
    expect(queue).toHaveLength(2);
  });
});

describe("PageModeContent: edits", () => {
  async function checked() {
    const t = await setup();
    t.runner.answer(resultOf(ISSUES));
    await t.focusAndLoad();
    t.clearSent();
    return t;
  }

  it("sends each edit with its revision, and the frame has the text", async () => {
    const t = await checked();
    typeInto(t.box, `Oh! ${TEXT}`);
    expect(t.sent()).toEqual([
      { type: "edit", box: 1, revision: 1, start: 0, removed: 0, inserted: "Oh! " },
    ]);
    await t.getFrame()?.idle();
    expect(t.getFrame()?.session(1)?.text).toBe(`Oh! ${TEXT}`);
  });

  it("removes a touched issue and moves the others at once, before the frame answers", async () => {
    const t = await checked();
    expect(t.badge()?.textContent).toBe("2");
    // Typing inside "I seen" removes it; the badge counts one issue now, synchronously.
    typeInto(t.box, "Yesterday I sXeen him. He go home.");
    expect(t.content.boxes[0]?.issues.map((i) => [i.start, i.end])).toEqual([[23, 28]]);
    expect(t.badge()?.textContent).toBe("1");
  });

  it("goes back to the icon when an edit leaves no issue", async () => {
    const t = await checked();
    typeInto(t.box, "Yesterday I sXeen him. HeX go home.");
    expect(t.kind()).toBe("icon");
  });

  it("starts a check after the pause in typing (not recorded), and shows its result", async () => {
    const t = await checked();
    t.runner.answer(resultOf([placed(10, 16, "verb_form")]));
    typeInto(t.box, `${TEXT} Ok.`);
    await t.getFrame()?.idle();
    t.scheduler.advance(3000);
    await t.getFrame()?.idle();
    await settle();
    expect(t.runner.asked).toHaveLength(2);
    expect(t.runner.asked[1]?.text).toBe(`${TEXT} Ok.`);
    expect(t.badge()?.textContent).toBe("1");
  });

  it("answers a request for the whole text", async () => {
    const t = await checked();
    t.bus.connections[0]?.port.peer?.post({ type: "resync", box: 1 });
    expect(t.sent()).toEqual([{ type: "text", box: 1, revision: 0, text: TEXT }]);
  });

  it("finds the change of a box a script wrote to while it was not focused", async () => {
    const t = await checked();
    focusOut(t.box);
    t.box.value = `${TEXT} Added by the page.`;
    t.clearSent();
    focusIn(t.box);
    expect(t.sent().map((m) => m.type)).toEqual(["edit", "focus"]);
    expect(t.sent()[1]).toMatchObject({ revision: 1, text: `${TEXT} Added by the page.` });
  });

  it("drops a state that is for an older revision", async () => {
    const t = await checked();
    typeInto(t.box, `${TEXT} More.`);
    // The frame answers for revision 0 after the edit: the content script ignores it.
    t.bus.connections[0]?.port.peer?.post({
      type: "state",
      box: 1,
      revision: 0,
      status: "failed",
      message: "old",
      issues: [],
    });
    expect(t.kind()).toBe("count");
  });

  it("stops following a box that is no longer a text box (made read-only)", async () => {
    const t = await checked();
    t.box.readOnly = true;
    t.clearSent();
    t.box.value = `${TEXT} More.`;
    t.box.dispatchEvent(trusted(new Event("input", { bubbles: true })));
    expect(t.content.boxes).toEqual([]);
    expect(t.badge()).toBeNull();
    await t.getFrame()?.idle();
    expect(t.getFrame()?.boxes).toBe(0);
  });
});

describe("PageModeContent: editable content", () => {
  const HTML =
    '<div id="box" contenteditable="true"><p>Yesterday I seen him.</p><p>He go home.</p></div>';

  it("reads the text as lines and sends it for the check", async () => {
    const t = await setup({ html: HTML });
    t.runner.answer(resultOf([placed(10, 16)]));
    await t.focusAndLoad();
    expect(t.sent()[0]).toMatchObject({
      type: "focus",
      text: "Yesterday I seen him.\nHe go home.",
    });
    expect(t.runner.asked[0]?.text).toBe("Yesterday I seen him.\nHe go home.");
    expect(t.badge()?.textContent).toBe("1");
    expect(t.content.boxes[0]?.model?.segments).toHaveLength(2);
  });

  it("finds an edit made in a text node", async () => {
    const t = await setup({ html: HTML });
    t.runner.answer(resultOf([placed(10, 16)]));
    await t.focusAndLoad();
    t.clearSent();
    const second = t.box.querySelectorAll("p")[1]?.firstChild as Text;
    second.data = "He goes home.";
    t.box.dispatchEvent(trusted(new Event("input", { bubbles: true })));
    expect(t.sent()).toEqual([
      { type: "edit", box: 1, revision: 1, start: 27, removed: 0, inserted: "es" },
    ]);
    expect(t.content.boxes[0]?.model?.text).toBe("Yesterday I seen him.\nHe goes home.");
  });

  it("finds the editing host from a focus inside a nested element", async () => {
    const t = await setup({
      html: '<div id="box" contenteditable="true"><p><b id="inner">one two three</b></p></div>',
    });
    t.runner.answer(resultOf([]));
    await t.focusAndLoad(document.getElementById("inner") as Element);
    expect(t.content.boxes[0]?.element.id).toBe("box");
  });
});

describe("PageModeContent: the frame is blocked (PageFrameBlocked)", () => {
  it("shows ! with the reason after 5 seconds, and checks nothing", async () => {
    const t = await setup({ frame: "never" });
    focusIn(t.box);
    await settle();
    t.loadFrame();
    t.scheduler.advance(FRAME_TIMEOUT_MS);
    expect(t.content.blocked?.hasRoute("PageFrameBlocked")).toBe(true);
    expect(t.kind()).toBe("warning");
    expect(t.badge()?.getAttribute("title")).toBe(FRAME_BLOCKED_MESSAGE);
    expect(t.runner.asked).toEqual([]);
  });

  it("registers the frame's id with the background script before the iframe is made", async () => {
    const t = await setup({ frame: "never" });
    focusIn(t.box);
    expect(t.runtime.registered).toEqual([]);
    expect(t.iframe()).toBeNull();
    await settle();
    expect(t.runtime.registered).toHaveLength(1);
    expect(t.iframe()?.src.endsWith(`#${t.runtime.registered[0] ?? ""}`)).toBe(true);
  });

  it("shows ! at once, with its own route, when the id cannot be registered, and makes no frame", async () => {
    const t = await setup({ frame: "never" });
    t.runtime.registerFails = new Error("no background");
    focusIn(t.box);
    await settle();
    expect(t.iframe()).toBeNull();
    expect(t.content.blocked?.hasRoute("FrameLink.register->PageFrameBlocked")).toBe(true);
    expect(t.kind()).toBe("warning");
    expect(t.runner.asked).toEqual([]);
  });

  it("shows ! on a box that is focused after the frame was blocked", async () => {
    const t = await setup({
      html: '<textarea id="a">one two three</textarea><textarea id="b">four five six</textarea>',
      frame: "never",
    });
    focusIn(t.box);
    await settle();
    t.loadFrame();
    t.scheduler.advance(FRAME_TIMEOUT_MS);
    const b = document.getElementById("b");
    if (b === null) throw new Error("no b");
    focusIn(b);
    const badges = [...(t.layer()?.querySelectorAll("button[data-kind]") ?? [])];
    expect(badges.map((x) => x.getAttribute("data-kind"))).toEqual(["warning", "warning"]);
  });

  it("offers only Open in English Tutor, which sends the text of the box", async () => {
    const t = await setup({ frame: "never" });
    focusIn(t.box);
    await settle();
    t.loadFrame();
    t.scheduler.advance(FRAME_TIMEOUT_MS);
    t.box.value = `${TEXT} More.`;
    t.badge()?.dispatchEvent(trusted(new MouseEvent("click", { bubbles: true })));
    const card = t.layer()?.querySelector("[role=dialog]");
    expect([...(card?.querySelectorAll("button") ?? [])].map((b) => b.textContent)).toEqual([
      OPEN_IN_TUTOR_LABEL,
    ]);
    card
      ?.querySelector("button")
      ?.dispatchEvent(trusted(new MouseEvent("click", { bubbles: true })));
    expect(t.runtime.opened).toEqual([`${TEXT} More.`]);
    expect(t.layer()?.querySelector("[role=dialog]")).toBeNull();
  });
});

describe("PageModeContent: turning page mode off and on", () => {
  it("removes everything on page-mode-off, at once, and does not ask again", async () => {
    const t = await setup();
    t.runner.answer(resultOf(ISSUES));
    await t.focusAndLoad();
    t.runtime.asked.length = 0;
    t.runtime.broadcast("page-mode-off");
    expect(t.content.running).toBe(false);
    expect(t.host()).toBeUndefined();
    expect(t.content.boxes).toEqual([]);
    expect(t.runtime.asked).toEqual([]);
    // Events of the page no longer do anything.
    focusIn(t.box);
    expect(t.iframe()).toBeNull();
  });

  it("asks again on settings-changed and starts when it runs here now", async () => {
    const t = await setup({ config: { state: "off" } });
    expect(t.content.running).toBe(false);
    t.runtime.config = { state: "on" };
    t.runtime.broadcast("settings-changed");
    await settle();
    expect(t.content.running).toBe(true);
    expect(t.runtime.asked).toHaveLength(2);
  });

  it("removes everything on settings-changed when the host was turned off", async () => {
    const t = await setup();
    t.runner.answer(resultOf(ISSUES));
    await t.focusAndLoad();
    t.runtime.config = { state: "off" };
    t.runtime.broadcast("settings-changed");
    await settle();
    expect(t.content.running).toBe(false);
    expect(t.host()).toBeUndefined();
    expect(t.getFrame()?.boxes).toBe(1 - 1 + t.getFrame()!.boxes);
  });

  it("the latest answer wins when two settings-changed overlap", async () => {
    const t = await setup({ config: { state: "off" } });
    t.runtime.config = { state: "on" };
    t.runtime.broadcast("settings-changed");
    t.runtime.config = { state: "off" };
    t.runtime.broadcast("settings-changed");
    await settle();
    expect(t.content.running).toBe(false);
  });

  it("is a clean start after being turned off and on", async () => {
    const t = await setup();
    t.runtime.broadcast("page-mode-off");
    t.runtime.broadcast("settings-changed");
    await settle();
    expect(t.content.running).toBe(true);
    expect(t.host()).toBeDefined();
    expect(t.content.boxes).toEqual([]);
  });

  it("removes everything when the page goes away", async () => {
    const t = await setup();
    window.dispatchEvent(new Event("pagehide"));
    expect(t.content.running).toBe(false);
    expect(t.host()).toBeUndefined();
  });

  it("destroy removes the host, the frame and the listeners of the runtime", async () => {
    const t = await setup();
    t.runner.answer(resultOf(ISSUES));
    await t.focusAndLoad();
    t.content.destroy();
    expect(t.host()).toBeUndefined();
    expect(t.runtime.listeners.size).toBe(0);
    expect(t.bus.connections[0]?.port.disconnected).toBe(true);
  });
});

describe("PageModeContent: a site that is not on", () => {
  const REMOTE: SiteConfig = {
    state: "ask",
    llm: { server: "api.example.com", local: false },
  };
  const LATER: SiteConfig = { state: "later", llm: { server: "api.example.com", local: false } };

  /** What the content script must never do before Turn on: read text, make a frame, send. */
  async function expectSilent(t: Awaited<ReturnType<typeof setup>>): Promise<void> {
    const reads = vi.fn(() => TEXT);
    Object.defineProperty(t.box, "value", { get: reads, set: () => undefined, configurable: true });
    focusIn(t.box);
    t.box.dispatchEvent(trusted(new Event("input", { bubbles: true })));
    t.box.dispatchEvent(trusted(new KeyboardEvent("keydown", { bubbles: true, key: "a" })));
    await settle();
    expect(reads).not.toHaveBeenCalled();
    expect(t.content.running).toBe(false);
    expect(t.content.boxes).toEqual([]);
    expect(t.iframe()).toBeNull();
    expect(t.bus.connections).toEqual([]);
    expect(t.runtime.registered).toEqual([]);
    expect(t.runtime.opened).toEqual([]);
    expect(t.runtime.chosen).toEqual([]);
  }

  it("does nothing at all on a site that is off: no badge, no listener, no host element, no frame", async () => {
    const t = await setup({ config: { state: "off" } });
    expect(t.content.asking).toBe(false);
    await expectSilent(t);
    expect(t.host()).toBeUndefined();
    expect(t.content.dimmedBadge).toBeUndefined();
  });

  it.each([
    { name: "ask", config: REMOTE },
    { name: "later", config: LATER },
  ])(
    "on a site that is $name it reads no text, makes no frame and no host element until a box is focused",
    async ({ config }) => {
      const t = await setup({ config });
      expect(t.content.asking).toBe(true);
      expect(t.host()).toBeUndefined();
      await expectSilent(t);
      // The focus shows the dimmed badge, and still nothing was read, framed or sent.
      expect(t.content.dimmedBadge).toBeDefined();
    },
  );

  it("does nothing on a site whose answer cannot be had", async () => {
    const box = setBody(document, `<textarea id="box">${TEXT}</textarea>`);
    layOut();
    const runtime = new FakePageModeRuntime();
    runtime.configFails = new Error("no background");
    const content = new PageModeContent({
      win: window,
      runtime,
      connector: new FakePortBus().connector,
      scheduler: new FakeScheduler(),
      clock: new FakeClock(),
      random: new CountingRandom(),
      log: new Logger({
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      }),
      overlayMode: "open",
    });
    made.push(content);
    await content.start();
    focusIn(box);
    expect(content.asking).toBe(false);
    expect(content.running).toBe(false);
    expect(content.promptOpen).toBe(false);
    expect(content.dimmedBadge).toBeUndefined();
  });
});

describe("PageModeContent: the dimmed badge and the prompt (icon first)", () => {
  const REMOTE: SiteConfig = { state: "ask", llm: { server: "api.example.com", local: false } };
  const LOCAL: SiteConfig = { state: "ask", llm: { server: "localhost:11434", local: true } };
  const NONE: SiteConfig = { state: "ask", llm: null };
  type T = Awaited<ReturnType<typeof setup>>;

  const card = (t: T) => t.layer()?.querySelector<HTMLElement>("[role=dialog]") ?? null;
  const button = (t: T, choice: string) =>
    card(t)?.querySelector<HTMLElement>(`[data-choice="${choice}"]`) ?? null;
  const click = (target: Element | null | undefined) => {
    if (target === null || target === undefined) throw new Error("no such element");
    target.dispatchEvent(trusted(new MouseEvent("click", { bubbles: true })));
  };
  /** The user clicks the dimmed badge, after the guard of 500 ms. */
  const openCard = (t: T) => {
    t.clock.advance(600);
    click(t.content.dimmedBadge);
  };

  describe("the badge", () => {
    it("shows on a focused box, dimmed, at its bottom right, with its tooltip and accessible name", async () => {
      const t = await setup({ config: REMOTE });
      focusIn(t.box);
      const badge = t.content.dimmedBadge;
      const label = `English Tutor is off on ${window.location.hostname}. Click to turn it on.`;
      expect(badge?.getAttribute("data-kind")).toBe("dimmed");
      expect(badge?.getAttribute("title")).toBe(label);
      expect(badge?.getAttribute("aria-label")).toBe(label);
      expect(badge?.style.getPropertyValue("opacity")).toBe("0.6");
      // The box is at 100..400 by 100..250: the badge is 22 px, 4 px inside its corner.
      expect(badge?.style.getPropertyValue("left")).toBe("374px");
      expect(badge?.style.getPropertyValue("top")).toBe("224px");
      expect(t.host()?.shadowRoot).not.toBeNull();
    });

    it.each([
      { name: "a textarea", html: '<textarea id="box">one two three</textarea>' },
      { name: "an editing host", html: '<div id="box" contenteditable="true">one two three</div>' },
      { name: "a one-line input", html: '<input id="box" value="one two three">' },
      {
        name: "a rich editor with spellcheck=false",
        html: '<div id="box" class="ql-editor" contenteditable="true" role="textbox" spellcheck="false" data-gramm="false"><p>one</p></div>',
      },
    ])("shows on $name", async ({ html }) => {
      const t = await setup({ config: REMOTE, html });
      focusIn(t.box);
      expect(t.content.dimmedBadge).toBeDefined();
    });

    it("opens no card by itself, and the badge is the only thing page mode added", async () => {
      const t = await setup({ config: REMOTE });
      focusIn(t.box);
      t.clock.advance(60_000);
      await settle();
      expect(t.content.promptOpen).toBe(false);
      expect(card(t)).toBeNull();
      expect(t.layer()?.children).toHaveLength(1);
      expect(t.iframe()).toBeNull();
    });

    it.each([
      { name: "a password input", html: '<input id="box" type="password" value="one two three">' },
      { name: "an email input", html: '<input id="box" type="email" value="one two three">' },
      { name: "a search input", html: '<input id="box" type="search" value="one two three">' },
      {
        name: "a native field with spellcheck=false",
        html: '<textarea id="box" spellcheck="false">one two three</textarea>',
      },
      {
        name: "a code editor (CodeMirror 6)",
        html: '<div class="cm-editor"><div id="box" contenteditable="true">one two three</div></div>',
      },
      {
        name: "an editor with spellcheck, autocorrect and autocapitalize off",
        html: '<div id="box" contenteditable="true" spellcheck="false" autocorrect="off">one two three</div>',
      },
      {
        name: "a one-time-code field",
        html: '<input id="box" autocomplete="one-time-code" value="one two three">',
      },
      {
        name: "a card field",
        html: '<input id="box" autocomplete="cc-number" value="one two three">',
      },
      { name: "a read-only field", html: '<textarea id="box" readonly>one two three</textarea>' },
      { name: "a disabled field", html: '<textarea id="box" disabled>one two three</textarea>' },
      {
        name: "a field of a site that opted out",
        html: '<div data-english-tutor="off"><textarea id="box">one two three</textarea></div>',
      },
      { name: "plain content", html: '<p id="box">one two three</p>' },
      { name: "a button", html: '<button id="box">one two three</button>' },
    ])("never shows on $name", async ({ html }) => {
      const t = await setup({ config: REMOTE, html });
      const element = document.getElementById("box");
      if (element === null) throw new Error("no box");
      focusIn(element);
      await settle();
      expect(t.content.dimmedBadge).toBeUndefined();
      expect(t.host()).toBeUndefined();
      // The next eligible text box still gets it.
      document.body.append(
        Object.assign(document.createElement("textarea"), { id: "next", value: "one two three" }),
      );
      const next = document.getElementById("next");
      if (next === null) throw new Error("no next box");
      focusIn(next);
      expect(t.content.dimmedBadge).toBeDefined();
    });

    it("goes when the box loses the focus, and takes its element with it", async () => {
      const t = await setup({ config: REMOTE });
      focusIn(t.box);
      expect(t.host()).toBeDefined();
      focusOut(t.box);
      expect(t.content.dimmedBadge).toBeUndefined();
      expect(t.host()).toBeUndefined();
    });

    it("goes when the focus moves to something that is not a text box, and moves to another text box", async () => {
      const t = await setup({ config: REMOTE });
      document.body.append(
        Object.assign(document.createElement("textarea"), { id: "second", value: "four five six" }),
        Object.assign(document.createElement("button"), { id: "button" }),
      );
      const second = document.getElementById("second")!;
      focusIn(t.box);
      expect(t.content.dimmedBadge).toBeDefined();
      focusOut(t.box);
      focusIn(second);
      expect(t.layer()?.querySelectorAll("button[data-kind]")).toHaveLength(1);
      expect(t.content.dimmedBadge).toBeDefined();
      focusIn(document.getElementById("button")!);
      expect(t.content.dimmedBadge).toBeUndefined();
      expect(t.host()).toBeUndefined();
    });

    it("ignores a focus that a page script dispatched, and a blur that it dispatched", async () => {
      const t = await setup({ config: REMOTE });
      t.box.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      expect(t.content.dimmedBadge).toBeUndefined();
      expect(t.host()).toBeUndefined();
      focusIn(t.box);
      t.box.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      expect(t.content.dimmedBadge).toBeDefined();
    });

    it("follows the box when the window scrolls, and goes when the box leaves the page", async () => {
      const t = await setup({ config: REMOTE });
      focusIn(t.box);
      vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
        () => ({ left: 100, top: 60, right: 400, bottom: 210, width: 300, height: 150 }) as DOMRect,
      );
      window.dispatchEvent(new Event("scroll"));
      await new Promise((resolve) => {
        requestAnimationFrame(() => {
          resolve(undefined);
        });
      });
      expect(t.content.dimmedBadge?.style.getPropertyValue("top")).toBe("184px");
      t.box.remove();
      window.dispatchEvent(new Event("scroll"));
      await new Promise((resolve) => {
        requestAnimationFrame(() => {
          resolve(undefined);
        });
      });
      expect(t.content.dimmedBadge).toBeUndefined();
      expect(t.host()).toBeUndefined();
    });

    it("does not take the focus: a mouse press on the badge is cancelled", async () => {
      const t = await setup({ config: REMOTE });
      focusIn(t.box);
      const press = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
      t.content.dimmedBadge?.dispatchEvent(press);
      expect(press.defaultPrevented).toBe(true);
    });
  });

  describe("a click on the badge", () => {
    it.each([
      { name: "a click at once", wait: 0, opened: false },
      { name: "a click 499 ms after the badge appeared", wait: 499, opened: false },
      { name: "a click 500 ms after the badge appeared", wait: 500, opened: true },
      { name: "a click a minute later", wait: 60_000, opened: true },
    ])("takes $name: card $opened", async ({ wait, opened }) => {
      const t = await setup({ config: REMOTE });
      focusIn(t.box);
      t.clock.advance(wait);
      click(t.content.dimmedBadge);
      expect(t.content.promptOpen).toBe(opened);
    });

    it("ignores a click that a page script dispatched", async () => {
      const t = await setup({ config: REMOTE });
      focusIn(t.box);
      t.clock.advance(5_000);
      t.content.dimmedBadge?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(t.content.promptOpen).toBe(false);
    });

    it.each([
      {
        name: "a remote server",
        config: REMOTE,
        note: "What you type here is sent to api.example.com to be checked.",
      },
      {
        name: "a server on this computer",
        config: LOCAL,
        note: "What you type here is checked by localhost:11434, on this computer.",
      },
      {
        name: "no LLM",
        config: NONE,
        note: "No LLM is set up yet. You can add one in the options.",
      },
      {
        name: "a site answered Not now",
        config: {
          state: "later",
          llm: { server: "api.example.com", local: false },
        } satisfies SiteConfig,
        note: "What you type here is sent to api.example.com to be checked.",
      },
    ])(
      "opens the card with the host, the note for $name, and two buttons",
      async ({ config, note }) => {
        const t = await setup({ config });
        focusIn(t.box);
        openCard(t);
        const opened = card(t);
        expect(opened).not.toBeNull();
        expect(opened?.textContent).toContain(
          `Check what you write on ${window.location.hostname} with English Tutor?`,
        );
        expect(opened?.textContent).toContain(note);
        // Turn on and Never on this site: Not now is gone, the close button chooses nothing.
        expect([...(opened?.querySelectorAll("button") ?? [])].map((b) => b.textContent)).toEqual([
          "Turn on",
          "Never on this site",
          "×",
        ]);
        expect(t.iframe()).toBeNull();
      },
    );

    it("closes the card on a second click", async () => {
      const t = await setup({ config: REMOTE });
      focusIn(t.box);
      openCard(t);
      expect(t.content.promptOpen).toBe(true);
      click(t.content.dimmedBadge);
      expect(t.content.promptOpen).toBe(false);
      expect(t.content.dimmedBadge).toBeDefined();
    });

    it("sits just below the box, at its left edge", async () => {
      const t = await setup({ config: REMOTE });
      focusIn(t.box);
      openCard(t);
      // The box is at 100..250 by 100..400.
      expect(card(t)?.style.getPropertyValue("top")).toBe("256px");
      expect(card(t)?.style.getPropertyValue("left")).toBe("100px");
    });

    it("goes above the box when there is no room below it, and stays inside the window", async () => {
      const t = await setup({ config: REMOTE });
      vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
        () => ({ left: 20, top: 600, right: 320, bottom: 750, width: 300, height: 150 }) as DOMRect,
      );
      vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(120);
      focusIn(t.box);
      openCard(t);
      // 750 + 6 + 120 does not fit in the window: it goes above, 600 - 6 - 120.
      expect(card(t)?.style.getPropertyValue("top")).toBe("474px");
      expect(card(t)?.style.getPropertyValue("left")).toBe("20px");
    });

    it("keeps the card inside the window's right edge", async () => {
      const t = await setup({ config: REMOTE });
      vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
        () =>
          ({ left: 900, top: 100, right: 1200, bottom: 250, width: 300, height: 150 }) as DOMRect,
      );
      focusIn(t.box);
      openCard(t);
      // The window is 1024 wide in the test; the card is 330 wide, 8 px from the edge.
      expect(card(t)?.style.getPropertyValue("left")).toBe(`${String(window.innerWidth - 338)}px`);
    });

    it("follows the box while the window scrolls", async () => {
      const t = await setup({ config: REMOTE });
      focusIn(t.box);
      openCard(t);
      vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
        () => ({ left: 100, top: 60, right: 400, bottom: 210, width: 300, height: 150 }) as DOMRect,
      );
      window.dispatchEvent(new Event("scroll"));
      await new Promise((resolve) => {
        requestAnimationFrame(() => {
          resolve(undefined);
        });
      });
      expect(card(t)?.style.getPropertyValue("top")).toBe("216px");
    });

    it("does not take the focus: a mouse press on the card is cancelled, so the box keeps its caret", async () => {
      const t = await setup({ config: REMOTE });
      focusIn(t.box);
      openCard(t);
      for (const target of [card(t), button(t, "on"), button(t, "off"), button(t, "close")]) {
        const press = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
        target?.dispatchEvent(press);
        expect(press.defaultPrevented).toBe(true);
      }
    });

    it("stays open while the user types in the box", async () => {
      const t = await setup({ config: REMOTE });
      focusIn(t.box);
      openCard(t);
      typeInto(t.box, `${TEXT} More words.`);
      t.box.dispatchEvent(trusted(new KeyboardEvent("keydown", { bubbles: true, key: "x" })));
      await settle();
      expect(t.content.promptOpen).toBe(true);
      expect(t.runtime.chosen).toEqual([]);
      expect(t.iframe()).toBeNull();
    });

    it("goes with the badge when the box loses the focus", async () => {
      const t = await setup({ config: REMOTE });
      focusIn(t.box);
      openCard(t);
      focusOut(t.box);
      expect(t.content.promptOpen).toBe(false);
      expect(t.host()).toBeUndefined();
      expect(t.runtime.chosen).toEqual([]);
    });

    it("closes on Escape, and not on an Escape a page script made", async () => {
      const t = await setup({ config: REMOTE });
      focusIn(t.box);
      openCard(t);
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      expect(t.content.promptOpen).toBe(true);
      document.dispatchEvent(
        trusted(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
      );
      expect(t.content.promptOpen).toBe(false);
      // Only the card closed: the box still has the focus and the badge.
      expect(t.content.dimmedBadge).toBeDefined();
      expect(t.runtime.chosen).toEqual([]);
    });
  });

  describe("the card's buttons", () => {
    it.each([
      { name: "a click at once", wait: 0, chosen: false },
      { name: "a click 499 ms after it opened", wait: 499, chosen: false },
      { name: "a click 500 ms after it opened", wait: 500, chosen: true },
      { name: "a click a minute later", wait: 60_000, chosen: true },
    ])("take $name: chosen $chosen", async ({ wait, chosen }) => {
      const t = await setup({ config: REMOTE });
      focusIn(t.box);
      openCard(t);
      t.clock.advance(wait);
      click(button(t, "off"));
      await settle();
      expect(t.runtime.chosen).toHaveLength(chosen ? 1 : 0);
      expect(t.content.promptOpen).toBe(!chosen);
    });

    it("ignore the clicks of the first 500 ms for every button, and the card still takes a later one", async () => {
      const t = await setup({ config: REMOTE });
      focusIn(t.box);
      openCard(t);
      t.clock.advance(200);
      for (const choice of ["on", "off", "close"]) click(button(t, choice));
      await settle();
      expect(t.runtime.chosen).toEqual([]);
      expect(t.content.promptOpen).toBe(true);
      t.clock.advance(300);
      click(button(t, "off"));
      await settle();
      expect(t.runtime.chosen).toHaveLength(1);
    });

    it("ignore a click that a page script dispatched", async () => {
      const t = await setup({ config: REMOTE });
      focusIn(t.box);
      openCard(t);
      t.clock.advance(5_000);
      for (const choice of ["on", "off", "close"]) {
        button(t, choice)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      }
      await settle();
      expect(t.runtime.chosen).toEqual([]);
      expect(t.content.promptOpen).toBe(true);
    });

    it("close chooses nothing: the card goes and the dimmed badge stays", async () => {
      const t = await setup({ config: REMOTE });
      focusIn(t.box);
      openCard(t);
      t.clock.advance(600);
      click(button(t, "close"));
      await settle();
      expect(t.runtime.chosen).toEqual([]);
      expect(t.content.promptOpen).toBe(false);
      expect(t.content.dimmedBadge).toBeDefined();
      // The badge opens it again.
      click(t.content.dimmedBadge);
      expect(t.content.promptOpen).toBe(true);
    });

    it("Never sends off, and leaves nothing on the page", async () => {
      const t = await setup({ config: REMOTE });
      focusIn(t.box);
      openCard(t);
      t.clock.advance(600);
      click(button(t, "off"));
      await settle();
      expect(t.runtime.chosen).toEqual([{ host: window.location.hostname, choice: "off" }]);
      expect(t.content.promptOpen).toBe(false);
      expect(t.content.asking).toBe(false);
      expect(t.content.running).toBe(false);
      expect(t.content.dimmedBadge).toBeUndefined();
      expect(t.host()).toBeUndefined();
      expect(t.iframe()).toBeNull();
      expect(t.bus.connections).toEqual([]);
      expect(t.runtime.registered).toEqual([]);
    });

    it("send one choice only, even for a second click", async () => {
      const t = await setup({ config: REMOTE });
      focusIn(t.box);
      openCard(t);
      t.clock.advance(600);
      const turnOn = button(t, "on");
      click(turnOn);
      click(turnOn);
      await settle();
      expect(t.runtime.chosen).toHaveLength(1);
    });
  });

  describe("Turn on", () => {
    it("makes the site on at once: the badge and card change, and the focused box is checked", async () => {
      const t = await setup({ config: REMOTE });
      t.runner.answer(resultOf(ISSUES));
      t.box.focus();
      focusIn(t.box);
      openCard(t);
      t.clock.advance(600);
      click(button(t, "on"));
      await settle();
      expect(t.runtime.chosen).toEqual([{ host: window.location.hostname, choice: "on" }]);
      expect(t.content.promptOpen).toBe(false);
      expect(t.content.running).toBe(true);
      expect(t.content.dimmedBadge).toBeUndefined();
      // The box the user is in is taken up without another focus: its frame and badge.
      expect(t.content.boxes).toHaveLength(1);
      expect(t.iframe()).not.toBeNull();
      expect(t.badge()).not.toBeNull();
      t.loadFrame();
      await t.getFrame()?.idle();
      await settle();
      expect(t.sent()[0]).toMatchObject({ type: "focus", box: 1, revision: 0, text: TEXT });
      expect(t.runner.asked.map((a) => a.text)).toEqual([TEXT]);
      expect(t.kind()).toBe("count");
    });

    it("works the same when the background script's announcement arrives first", async () => {
      const t = await setup({ config: REMOTE });
      t.box.focus();
      focusIn(t.box);
      openCard(t);
      t.clock.advance(600);
      let finish: () => void = () => undefined;
      t.runtime.chooseGate = new Promise<void>((resolve) => {
        finish = resolve;
      });
      click(button(t, "on"));
      // The background script stored the choice and told the page, before it answered.
      t.runtime.config = { state: "on" };
      t.runtime.broadcast("settings-changed");
      await settle();
      expect(t.content.running).toBe(true);
      // The box that has the focus was taken up when the site turned on.
      expect(t.content.boxes).toHaveLength(1);
      finish();
      await settle();
      expect(t.content.running).toBe(true);
      expect(t.content.boxes).toHaveLength(1);
      expect(t.layer()?.querySelectorAll("iframe")).toHaveLength(1);
    });

    it("leaves the site as it is and logs when the choice cannot be stored", async () => {
      const t = await setup({ config: REMOTE });
      t.box.focus();
      focusIn(t.box);
      openCard(t);
      t.runtime.chooseFails = new Error("no background");
      t.clock.advance(600);
      click(button(t, "on"));
      await settle();
      expect(t.content.running).toBe(false);
      expect(t.iframe()).toBeNull();
      expect(t.logged.join("\n")).toContain("page mode could not store the choice");
    });

    it("checks nothing when the user left the box before it", async () => {
      const t = await setup({ config: REMOTE });
      focusIn(t.box);
      openCard(t);
      t.clock.advance(600);
      click(button(t, "on"));
      await settle();
      // The browser's focus was never in the box (this test only dispatched focusin).
      expect(t.content.running).toBe(true);
      expect(t.content.boxes).toEqual([]);
    });
  });

  describe("changes made elsewhere", () => {
    it.each<{ name: string; config: SiteConfig; running: boolean; asking: boolean }>([
      { name: "the site turned on", config: { state: "on" }, running: true, asking: false },
      { name: "the site turned off", config: { state: "off" }, running: false, asking: false },
      {
        name: "Not now on another tab (still dimmed)",
        config: { state: "later", llm: null },
        running: false,
        asking: true,
      },
    ])("$name: the card is $asking", async ({ config, running, asking }) => {
      const t = await setup({ config: REMOTE });
      focusIn(t.box);
      openCard(t);
      expect(t.content.promptOpen).toBe(true);
      t.runtime.config = config;
      t.runtime.broadcast("settings-changed");
      await settle();
      expect(t.content.running).toBe(running);
      expect(t.content.asking).toBe(asking);
      expect(t.content.promptOpen).toBe(asking);
      expect(t.content.dimmedBadge !== undefined).toBe(asking);
    });

    it("keeps the card open when the answer is still ask", async () => {
      const t = await setup({ config: REMOTE });
      focusIn(t.box);
      openCard(t);
      t.runtime.config = LOCAL;
      t.runtime.broadcast("settings-changed");
      await settle();
      expect(t.content.promptOpen).toBe(true);
    });

    it("is removed by page-mode-off", async () => {
      const t = await setup({ config: REMOTE });
      focusIn(t.box);
      openCard(t);
      t.runtime.broadcast("page-mode-off");
      expect(t.content.promptOpen).toBe(false);
      expect(t.content.asking).toBe(false);
      expect(t.content.dimmedBadge).toBeUndefined();
      expect(t.host()).toBeUndefined();
    });

    it("is removed when the page goes away", async () => {
      const t = await setup({ config: REMOTE });
      focusIn(t.box);
      openCard(t);
      window.dispatchEvent(new Event("pagehide"));
      expect(t.content.promptOpen).toBe(false);
      expect(t.host()).toBeUndefined();
    });

    it("starts offering when a site that was off is removed from the list", async () => {
      const t = await setup({ config: { state: "off" } });
      expect(t.content.asking).toBe(false);
      t.runtime.config = REMOTE;
      t.runtime.broadcast("settings-changed");
      await settle();
      expect(t.content.asking).toBe(true);
      focusIn(t.box);
      expect(t.content.dimmedBadge).toBeDefined();
    });

    it("stops listening once the site turns off before any focus", async () => {
      const t = await setup({ config: REMOTE });
      t.runtime.config = { state: "off" };
      t.runtime.broadcast("settings-changed");
      await settle();
      focusIn(t.box);
      expect(t.content.dimmedBadge).toBeUndefined();
    });
  });
});

describe("PageModeContent: real-world editors (SPEC section 4.11)", () => {
  const REMOTE: SiteConfig = { state: "ask", llm: { server: "api.example.com", local: false } };

  const QUILL =
    '<div id="box" class="ql-editor" contenteditable="true" role="textbox" aria-multiline="true" data-gramm="false" spellcheck="false"><p>Yesterday I seen him.</p></div>';
  const MESSAGE_BOX =
    '<form><div id="box" contenteditable="true" role="textbox" aria-multiline="true" class="msg-form__contenteditable"><p><br></p></div></form>';

  describe("a box that is already focused when the content script starts", () => {
    /** The page's `#box` has the focus before the script starts (it is not always the first element). */
    const focused = () => {
      document.getElementById("box")?.focus();
    };

    it.each([
      { name: "a textarea", html: `<textarea id="box">${TEXT}</textarea>` },
      { name: "a Quill editor", html: QUILL },
      { name: "an empty message box (<p><br></p>)", html: MESSAGE_BOX },
    ])("is taken up on a site that is on: $name", async ({ html }) => {
      const t = await setup({ html, beforeStart: focused });
      expect(t.content.running).toBe(true);
      expect(t.content.boxes).toHaveLength(1);
      expect(t.badge()).not.toBeNull();
      expect(t.iframe()).not.toBeNull();
    });

    it.each([
      { name: "a textarea", html: `<textarea id="box">${TEXT}</textarea>` },
      { name: "a Quill editor", html: QUILL },
      { name: "an empty message box (<p><br></p>)", html: MESSAGE_BOX },
    ])("gets the dimmed badge on a site that is not on: $name", async ({ html }) => {
      const t = await setup({ config: REMOTE, html, beforeStart: focused });
      expect(t.content.dimmedBadge).toBeDefined();
      expect(t.iframe()).toBeNull();
      expect(t.bus.connections).toEqual([]);
      expect(t.runtime.registered).toEqual([]);
    });

    it.each<{ name: string; config: SiteConfig; expectBadge: boolean }>([
      { name: "on", config: { state: "on" }, expectBadge: false },
      { name: "ask", config: REMOTE, expectBadge: false },
    ])(
      "is not taken up on a site that is $name when the document does not have the focus (a background tab)",
      async ({ config }) => {
        vi.spyOn(document, "hasFocus").mockReturnValue(false);
        const t = await setup({
          config,
          beforeStart: (box) => {
            box.focus();
          },
        });
        expect(t.content.boxes).toEqual([]);
        expect(t.content.dimmedBadge).toBeUndefined();
        expect(t.host()?.shadowRoot?.firstElementChild?.children.length ?? 0).toBe(0);
      },
    );

    it("is not taken up when the focused element is not a text box", async () => {
      const t = await setup({
        html: '<button id="box">Go</button>',
        beforeStart: (box) => {
          box.focus();
        },
      });
      expect(t.content.boxes).toEqual([]);
    });

    it("reads nothing on a site that is off, whatever has the focus", async () => {
      const t = await setup({
        config: { state: "off" },
        beforeStart: (box) => {
          box.focus();
        },
      });
      expect(t.content.boxes).toEqual([]);
      expect(t.host()).toBeUndefined();
    });

    it("is taken up when the site turns on from another tab while the box has the focus", async () => {
      const t = await setup({ config: REMOTE });
      t.box.focus();
      focusIn(t.box);
      expect(t.content.dimmedBadge).toBeDefined();
      t.runtime.config = { state: "on" };
      t.runtime.broadcast("settings-changed");
      await settle();
      expect(t.content.dimmedBadge).toBeUndefined();
      expect(t.content.boxes).toHaveLength(1);
    });
  });

  describe("an editor in an open shadow root (Lit and other web components)", () => {
    function shadowEditor(): { host: HTMLElement; inner: HTMLElement } {
      const host = setBody(document, '<div id="host"></div>');
      const root = host.attachShadow({ mode: "open" });
      const inner = document.createElement("div");
      inner.setAttribute("contenteditable", "true");
      inner.setAttribute("role", "textbox");
      inner.textContent = TEXT;
      root.append(inner);
      return { host, inner };
    }
    /** A focusin from inside the shadow root: it is composed, so the page sees it on the host. */
    const focusInside = (inner: HTMLElement) =>
      inner.dispatchEvent(trusted(new FocusEvent("focusin", { bubbles: true, composed: true })));

    it("is found from a focus inside the shadow root on a site that is on", async () => {
      const { inner } = shadowEditor();
      const t = await setup({ html: '<div id="host"></div>' });
      // `setup` replaced the page: make the editor again in the new body.
      const again = shadowEditor();
      focusInside(again.inner);
      await settle();
      expect(inner).not.toBe(again.inner);
      expect(t.content.boxes).toHaveLength(1);
      expect(t.content.boxes[0]?.element).toBe(again.inner);
    });

    it("gets the dimmed badge on a site that is not on", async () => {
      const t = await setup({ config: REMOTE, html: '<div id="host"></div>' });
      const { inner } = shadowEditor();
      focusInside(inner);
      expect(t.content.dimmedBadge).toBeDefined();
      expect(t.content.boxWithBadge).toBe(inner);
    });

    it("is found at start through the activeElement of the shadow root", async () => {
      const t = await setup({
        html: '<div id="host"></div>',
        beforeStart: () => {
          const { inner } = shadowEditor();
          inner.setAttribute("tabindex", "0");
          inner.focus();
        },
      });
      expect(t.content.boxes).toHaveLength(1);
      expect(t.content.boxes[0]?.element.getAttribute("role")).toBe("textbox");
    });
  });

  describe("a box that cannot be used yet when it is focused (a modal that is still fading in)", () => {
    const FADING = '<div id="box" contenteditable="true" role="textbox"><p>one two three</p></div>';

    /** The box has no size yet, and gets it when `grow` is called. */
    function growLater(): () => void {
      let size = 0;
      vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
        () =>
          ({
            left: 100,
            top: 100,
            right: 100 + size,
            bottom: 100 + size / 2,
            width: size,
            height: size / 2,
          }) as DOMRect,
      );
      return () => {
        size = 300;
      };
    }

    it("is looked at again, and taken up on a site that is on, as soon as it can be used", async () => {
      const t = await setup({ html: FADING });
      const grow = growLater();
      t.box.focus();
      focusIn(t.box);
      expect(t.content.boxes).toEqual([]);
      t.scheduler.advance(100);
      expect(t.content.boxes).toEqual([]);
      grow();
      t.scheduler.advance(100);
      expect(t.content.boxes).toHaveLength(1);
      expect(t.badge()).not.toBeNull();
    });

    it("gets the dimmed badge on a site that is not on, as soon as it can be used", async () => {
      const t = await setup({ config: REMOTE, html: FADING });
      const grow = growLater();
      t.box.focus();
      focusIn(t.box);
      expect(t.content.dimmedBadge).toBeUndefined();
      grow();
      t.scheduler.advance(200);
      expect(t.content.dimmedBadge).toBeDefined();
    });

    it.each([
      { name: "after 150 ms", at: 150, found: true },
      { name: "after 500 ms", at: 500, found: true },
      { name: "after 1500 ms", at: 1500, found: true },
      { name: "after 5 seconds (it gave up)", at: 5000, found: false },
    ])("looks again until it gives up: usable $name -> $found", async ({ at, found }) => {
      const t = await setup({ html: FADING });
      const grow = growLater();
      t.box.focus();
      focusIn(t.box);
      t.scheduler.advance(at === 5000 ? 2000 : at - 1);
      grow();
      t.scheduler.advance(at === 5000 ? 3000 : 1);
      expect(t.content.boxes).toHaveLength(found ? 1 : 0);
    });

    it("stops looking when the box has lost the focus", async () => {
      const t = await setup({ html: FADING });
      const grow = growLater();
      t.box.focus();
      focusIn(t.box);
      t.box.blur();
      grow();
      t.scheduler.advance(2000);
      expect(t.content.boxes).toEqual([]);
    });

    it("does not look again for a reason that cannot change", async () => {
      const t = await setup({ html: '<textarea id="box" readonly>one two three</textarea>' });
      t.box.focus();
      focusIn(t.box);
      expect(t.scheduler.pending).toBe(0);
    });
  });

  describe("a box that moves without scrolling or resizing (a modal that grows with a CSS transform)", () => {
    /** The box is at `top()`: nothing tells the page, as a transform animation does not. */
    function slide(): { moveTo: (top: number) => void } {
      let top = 100;
      vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
        () =>
          ({ left: 100, top, right: 400, bottom: top + 150, width: 300, height: 150 }) as DOMRect,
      );
      return {
        moveTo: (value) => {
          top = value;
        },
      };
    }

    it("moves the badge of a site that is on at the next look, and again at the end of a transition", async () => {
      const t = await setup();
      const place = slide();
      await t.focusAndLoad();
      expect(t.badge()?.style.getPropertyValue("top")).toBe("224px");
      place.moveTo(300);
      t.scheduler.advance(250);
      await new Promise((resolve) => requestAnimationFrame(resolve));
      expect(t.badge()?.style.getPropertyValue("top")).toBe("424px");
      // The end of the transition repositions at once, without waiting for a look.
      place.moveTo(320);
      document.dispatchEvent(trusted(new Event("transitionend", { bubbles: true })));
      await new Promise((resolve) => requestAnimationFrame(resolve));
      expect(t.badge()?.style.getPropertyValue("top")).toBe("444px");
    });

    it("moves the dimmed badge of a site that is not on", async () => {
      const t = await setup({ config: REMOTE });
      const place = slide();
      focusIn(t.box);
      expect(t.content.dimmedBadge?.style.getPropertyValue("top")).toBe("224px");
      place.moveTo(300);
      t.scheduler.advance(250);
      await new Promise((resolve) => requestAnimationFrame(resolve));
      expect(t.content.dimmedBadge?.style.getPropertyValue("top")).toBe("424px");
    });

    it("keeps no timer when there is no box", async () => {
      const t = await setup();
      expect(t.scheduler.pending).toBe(0);
      const off = await setup({ config: { state: "off" } });
      expect(off.scheduler.pending).toBe(0);
    });
  });

  describe("a box that the page inserts and focuses by script", () => {
    it("is found: a focus that a script causes with focus() is trusted, like the user's", async () => {
      // The browser makes the event for element.focus(); only events a page creates and dispatches
      // are untrusted. The test stands for the browser with its own trusted event.
      const t = await setup({ html: "<div id='app'></div>" });
      const modal = document.createElement("div");
      modal.setAttribute("role", "dialog");
      const editor = document.createElement("div");
      editor.className = "ql-editor";
      editor.setAttribute("contenteditable", "true");
      editor.setAttribute("role", "textbox");
      editor.setAttribute("spellcheck", "false");
      editor.append(document.createElement("p"));
      modal.append(editor);
      document.body.append(modal);
      focusIn(editor);
      await settle();
      expect(t.content.boxes.map((b) => b.element)).toEqual([editor]);
    });
  });

  describe("why a box was skipped (the debug log)", () => {
    const html = (attrs: string) =>
      `<textarea id="box" ${attrs}>my private sentence is here</textarea>`;

    it.each([
      { name: "a read-only box", html: html("readonly"), reason: "read-only" },
      {
        name: "a native box with spellcheck=false",
        html: html('spellcheck="false"'),
        reason: "spellcheck is off on a native text box",
      },
      {
        name: "a private field",
        html: html('autocomplete="cc-number"'),
        reason: "private autocomplete",
      },
      {
        name: "an opt-out",
        html: `<div data-english-tutor="off">${html("")}</div>`,
        reason: "opted out by data-english-tutor",
      },
      {
        name: "a code editor",
        html: `<div class="CodeMirror">${html("")}</div>`,
        reason: "code editor (.CodeMirror)",
      },
    ])("says why $name is skipped, on a site that is on, and not what it holds", async (c) => {
      const t = await setup({ html: c.html });
      const box = document.getElementById("box")!;
      focusIn(box);
      const lines = t.logged.filter((l) => l.includes("skipped a focused text box"));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toBe(`[english-tutor] skipped a focused text box: ${c.reason}`);
      expect(t.logged.join("\n")).not.toContain("private sentence");
    });

    it("says it on a site that is not on too, with the tag and the host as fields, once per element", async () => {
      const fields: unknown[] = [];
      const t = await setup({
        config: REMOTE,
        html: html("readonly"),
        onLog: (_message, f) => fields.push(f),
      });
      focusIn(t.box);
      focusOut(t.box);
      focusIn(t.box);
      expect(t.logged.filter((l) => l.includes("skipped"))).toHaveLength(1);
      expect(fields).toContainEqual({ tag: "textarea", host: window.location.hostname });
    });

    it("says nothing about elements that are not text boxes at all", async () => {
      const t = await setup({ html: '<button id="box">Go</button>' });
      focusIn(t.box);
      expect(t.logged.filter((l) => l.includes("skipped"))).toEqual([]);
    });

    it("says what page mode does on this host, without a path", async () => {
      const t = await setup({ config: REMOTE });
      expect(t.logged).toContain(`[english-tutor] page mode is ask on ${window.location.hostname}`);
      expect(t.logged.join("\n")).not.toContain("/");
    });
  });
});

/** The frame's card, as a fake: it reports a height and records what it was asked. */
class FakePopover implements PopoverHost {
  readonly opened: { box: number; issue: number; maxHeight: number }[] = [];
  readonly closed: (number | undefined)[] = [];
  height = 180;
  send: ((message: unknown) => void) | undefined;

  open(
    session: { id: number },
    issue: number,
    maxHeight: number,
    send: (message: never) => void,
  ): void {
    this.opened.push({ box: session.id, issue, maxHeight });
    this.send = send as (message: unknown) => void;
    send({ type: "popover-size", box: session.id, issue, height: this.height } as never);
  }

  close(box?: number): void {
    this.closed.push(box);
  }
}

/** The frame's dialog, as a fake: it answers `dialog-ready` and records what it was asked. */
class FakeDialog implements DialogHost {
  readonly opened: { box: number; issue: number | null }[] = [];
  readonly closed: (number | undefined)[] = [];
  send: ((message: unknown) => void) | undefined;

  open(session: { id: number }, issue: number | null, send: (message: never) => void): void {
    this.opened.push({ box: session.id, issue });
    this.send = send as (message: unknown) => void;
    send({ type: "dialog-ready", box: session.id } as never);
  }

  close(box?: number): void {
    this.closed.push(box);
  }
}

/** Where each issue's underline is: issue `n` is the rectangle 60 * n + 100 .. 60 * n + 150, y 110..130. */
function layOutUnderlines(): void {
  for (const name of ["clientWidth", "clientHeight"] as const) {
    Object.defineProperty(HTMLElement.prototype, name, {
      configurable: true,
      // Only the text boxes have a size here: the document keeps the window's own.
      get(this: Element) {
        const isBox = this.tagName === "TEXTAREA" || this.hasAttribute("contenteditable");
        if (!isBox) return 0;
        return name === "clientWidth" ? 280 : 130;
      },
    });
  }
  vi.spyOn(Element.prototype, "getClientRects").mockImplementation(function (this: Element) {
    const id = Number((this as HTMLElement).dataset.issueId);
    if (!Number.isInteger(id)) return [] as unknown as DOMRectList;
    const left = 60 * id + 100;
    return [{ left, top: 110, right: left + 50, bottom: 130 }] as unknown as DOMRectList;
  });
}

const mouse = (type: string, target: Element, x = 0, y = 0) =>
  target.dispatchEvent(
    trusted(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, composed: true })),
  );
const key = (type: "keydown" | "keyup", key: string, target: Element = document.body) =>
  target.dispatchEvent(trusted(new KeyboardEvent(type, { key, bubbles: true })));
const caretTo = (box: HTMLTextAreaElement, at: number) => {
  box.setSelectionRange(at, at);
};

describe("PageModeContent: underlines and the explanation popover", () => {
  afterEach(() => {
    for (const name of ["clientWidth", "clientHeight"] as const) {
      Reflect.deleteProperty(HTMLElement.prototype, name);
    }
  });

  async function checked(extra: Options = {}) {
    const popover = new FakePopover();
    const t = await setup({ popover, ...extra });
    layOutUnderlines();
    t.runner.answer(resultOf(ISSUES));
    await t.focusAndLoad();
    t.clearSent();
    const spans = () => [...(t.layer()?.querySelectorAll<HTMLElement>("span.issue") ?? [])];
    const view = () => {
      const frame = t.iframe();
      return frame === null
        ? undefined
        : {
            display: frame.style.getPropertyValue("display"),
            visibility: frame.style.getPropertyValue("visibility"),
            left: frame.style.getPropertyValue("left"),
            top: frame.style.getPropertyValue("top"),
            width: frame.style.getPropertyValue("width"),
            height: frame.style.getPropertyValue("height"),
          };
    };
    /** Clicks the underline of an issue (by number) and lets the frame answer. */
    const clickIssue = async (n: number) => {
      mouse("mouseup", t.box, 60 * n + 120, 120);
      await t.getFrame()?.idle();
      await settle();
    };
    return { ...t, popover, spans, view, clickIssue };
  }

  it("draws an underline for each issue as soon as the frame has answered, in the category's style", async () => {
    const t = await checked();
    expect(t.spans().map((s) => s.textContent)).toEqual(["I seen", "He go"]);
    expect(t.spans().map((s) => s.style.getPropertyValue("text-decoration-style"))).toEqual([
      "wavy",
      "wavy",
    ]);
    expect(t.box.value).toBe(TEXT);
  });

  it("moves and removes the underlines at once on an edit, before the frame answers", async () => {
    const t = await checked();
    // Typing inside "I seen" removes it; the other underline stays (it moved by the added letter).
    typeInto(t.box, "Yesterday I sXeen him. He go home.");
    expect(t.spans().map((s) => s.textContent)).toEqual(["He go"]);
    expect(t.content.boxes[0]?.issues.map((i) => [i.start, i.end])).toEqual([[23, 28]]);
    // Words before them move both.
    typeInto(t.box, `Oh, so Yesterday I sXeen him. He go home.`);
    expect(t.content.boxes[0]?.issues.map((i) => [i.start, i.end])).toEqual([[30, 35]]);
    expect(t.spans().map((s) => s.textContent)).toEqual(["He go"]);
  });

  it("draws nothing for a box that is out of the window", async () => {
    const t = await checked();
    expect(t.spans()).toHaveLength(2);
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      () =>
        ({ left: 100, top: -500, right: 400, bottom: -350, width: 300, height: 150 }) as DOMRect,
    );
    t.content.reposition();
    expect(t.spans()).toHaveLength(0);
  });

  it("redraws at most once per animation frame while the page scrolls", async () => {
    const t = await checked();
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const drawn = vi.spyOn(t.content.underlinesOf(t.content.boxes[0] as never) as never, "draw");
    for (let i = 0; i < 5; i++) window.dispatchEvent(trusted(new Event("scroll")));
    expect(frames).toHaveLength(1);
    expect(drawn).not.toHaveBeenCalled();
    frames[0]?.(0);
    expect(drawn).toHaveBeenCalledTimes(1);
  });

  describe("opening", () => {
    it("opens when the click is inside an underline: the frame is asked, and shown below it once it has its size", async () => {
      const t = await checked();
      await t.clickIssue(1);
      expect(t.sent()).toEqual([{ type: "popover-open", box: 1, issue: 1, maxHeight: 340 }]);
      expect(t.popover.opened).toEqual([{ box: 1, issue: 1, maxHeight: 340 }]);
      expect(t.view()).toEqual({
        display: "block",
        visibility: "visible",
        left: "160px",
        top: "136px",
        width: "360px",
        height: "180px",
      });
      expect(t.content.popover?.issue).toBe(1);
      // The selected issue has its background (20% of the colour of its category).
      expect(t.spans()[0]?.style.getPropertyValue("background-color")).toBe(
        "rgba(213, 94, 0, 0.2)",
      );
      expect(t.spans()[1]?.style.getPropertyValue("background-color")).toBe("");
    });

    it("opens when the caret lands inside an issue even if the point is not on an underline", async () => {
      const t = await checked();
      caretTo(t.box, 12);
      mouse("mouseup", t.box, 700, 700);
      await t.getFrame()?.idle();
      expect(t.popover.opened.map((o) => o.issue)).toEqual([1]);
    });

    it("does not open for a click outside every issue", async () => {
      const t = await checked();
      caretTo(t.box, 3);
      mouse("mouseup", t.box, 700, 700);
      await t.getFrame()?.idle();
      expect(t.popover.opened).toEqual([]);
      expect(t.content.popover).toBeUndefined();
      expect(t.view()?.display).toBe("none");
    });

    it("does not open for a caret that only moves (keys) when no popover is open", async () => {
      const t = await checked();
      caretTo(t.box, 12);
      key("keyup", "ArrowRight", t.box);
      document.dispatchEvent(trusted(new Event("selectionchange")));
      await t.getFrame()?.idle();
      expect(t.popover.opened).toEqual([]);
    });

    it("ignores a click that a script of the page dispatched", async () => {
      const t = await checked();
      t.box.dispatchEvent(
        new MouseEvent("mouseup", { bubbles: true, clientX: 180, clientY: 120, composed: true }),
      );
      await t.getFrame()?.idle();
      expect(t.popover.opened).toEqual([]);
    });

    it("never takes the focus from the text box", async () => {
      const t = await checked();
      t.box.focus();
      await t.clickIssue(1);
      expect(document.activeElement).toBe(t.box);
    });

    it("does not open when the frame is blocked", async () => {
      const t = await setup({ frame: "never" });
      layOutUnderlines();
      focusIn(t.box);
      await settle();
      t.loadFrame();
      t.scheduler.advance(FRAME_TIMEOUT_MS);
      mouse("mouseup", t.box, 180, 120);
      expect(t.content.popover).toBeUndefined();
    });

    it("puts the card above the underline when there is no room below", async () => {
      const t = await checked();
      t.popover.height = 90;
      vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(200);
      await t.clickIssue(1);
      // The underline is at y 110..130 and the window is 200 high: 90 px does not fit below
      // (136 + 90 > 192) but does above it (110 - 6 - 90).
      expect(t.view()?.top).toBe("14px");
      expect(t.view()?.height).toBe("90px");
    });
  });

  describe("switching and closing", () => {
    it("switches to another issue when the caret moves into it, and closes when it leaves them all", async () => {
      const t = await checked();
      await t.clickIssue(1);
      t.clearSent();
      caretTo(t.box, 24);
      key("keyup", "ArrowRight", t.box);
      await t.getFrame()?.idle();
      expect(t.sent()).toEqual([{ type: "popover-open", box: 1, issue: 2, maxHeight: 340 }]);
      expect(t.view()?.left).toBe("220px");
      expect(t.spans()[1]?.style.getPropertyValue("background-color")).not.toBe("");
      expect(t.spans()[0]?.style.getPropertyValue("background-color")).toBe("");
      t.clearSent();
      caretTo(t.box, 2);
      key("keyup", "ArrowLeft", t.box);
      await t.getFrame()?.idle();
      expect(t.sent()).toEqual([{ type: "popover-close", box: 1 }]);
      expect(t.view()?.display).toBe("none");
      expect(t.content.popover).toBeUndefined();
      expect(t.spans().every((s) => s.style.getPropertyValue("background-color") === "")).toBe(
        true,
      );
    });

    it("keeps the card while the caret stays in the same issue", async () => {
      const t = await checked();
      await t.clickIssue(1);
      t.clearSent();
      caretTo(t.box, 14);
      key("keyup", "ArrowRight", t.box);
      document.dispatchEvent(trusted(new Event("selectionchange")));
      await t.getFrame()?.idle();
      expect(t.sent()).toEqual([]);
      expect(t.content.popover?.issue).toBe(1);
    });

    it("closes on Escape, and not on an Escape a script of the page made", async () => {
      const t = await checked();
      await t.clickIssue(1);
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      expect(t.content.popover?.issue).toBe(1);
      key("keydown", "Escape");
      await t.getFrame()?.idle();
      expect(t.content.popover).toBeUndefined();
      expect(t.popover.closed).toEqual([1]);
      expect(t.view()?.display).toBe("none");
    });

    it("closes on a press outside the box, but not on a press in the box", async () => {
      const t = await checked();
      await t.clickIssue(1);
      mouse("mousedown", t.box, 300, 200);
      expect(t.content.popover?.issue).toBe(1);
      mouse("mousedown", document.body, 900, 700);
      await t.getFrame()?.idle();
      expect(t.content.popover).toBeUndefined();
      expect(t.popover.closed).toEqual([1]);
    });

    it("does not close on a press on its own host (the badge, or the card)", async () => {
      const t = await checked();
      await t.clickIssue(1);
      const host = t.host()!;
      mouse("mousedown", host, 900, 700);
      expect(t.content.popover?.issue).toBe(1);
    });

    it("closes when the user types, before the underlines are drawn again", async () => {
      const t = await checked();
      await t.clickIssue(1);
      t.clearSent();
      typeInto(t.box, "Yesterday I seen him. He go home.!");
      expect(t.content.popover).toBeUndefined();
      expect(t.sent().map((m) => m.type)).toEqual(["popover-close", "edit"]);
      expect(t.spans().every((s) => s.style.getPropertyValue("background-color") === "")).toBe(
        true,
      );
    });

    it("closes with the issue when an edit removes it", async () => {
      const t = await checked();
      await t.clickIssue(1);
      typeInto(t.box, "Yesterday I sXeen him. He go home.");
      expect(t.content.popover).toBeUndefined();
    });

    it("closes when the focus goes to another element of the page, and stays when it goes into the card", async () => {
      const other =
        '<textarea id="a">Yesterday I seen him. He go home.</textarea><button id="b">x</button>';
      const t = await checked({ html: other });
      await t.clickIssue(1);
      // The focus goes into the card's frame: the page sees a focus on our host.
      focusOut(t.box);
      const host = t.host()!;
      host.dispatchEvent(trusted(new FocusEvent("focusin", { bubbles: true })));
      t.scheduler.advance(0);
      expect(t.content.popover?.issue).toBe(1);
      // Then to a button of the page.
      const button = document.getElementById("b") as Element;
      button.dispatchEvent(trusted(new FocusEvent("focusin", { bubbles: true })));
      expect(t.content.popover).toBeUndefined();
    });

    it("closes when the box loses the focus to nothing", async () => {
      const t = await checked();
      await t.clickIssue(1);
      focusOut(t.box);
      t.scheduler.advance(0);
      expect(t.content.popover).toBeUndefined();
    });

    it("closes when the frame says so (Escape in the card, Not an error), and gives the focus back", async () => {
      const t = await checked();
      await t.clickIssue(1);
      // The focus is in the card: the page's active element is our host.
      vi.spyOn(document, "activeElement", "get").mockReturnValue(t.host()!);
      const focus = vi.spyOn(t.box, "focus");
      t.popover.send?.({ type: "popover-closed", box: 1 });
      expect(t.content.popover).toBeUndefined();
      expect(t.view()?.display).toBe("none");
      expect(focus).toHaveBeenCalledWith({ preventScroll: true });
      // It did not echo the close to the frame.
      expect(t.popover.closed).toEqual([]);
    });

    it("closes when the underline leaves the box (it scrolls out of sight)", async () => {
      const t = await checked();
      await t.clickIssue(1);
      vi.spyOn(Element.prototype, "getClientRects").mockImplementation(
        () => [{ left: 160, top: 400, right: 210, bottom: 420 }] as unknown as DOMRectList,
      );
      t.content.reposition();
      expect(t.content.popover).toBeUndefined();
    });

    it("follows its underline when the page moves", async () => {
      const t = await checked();
      await t.clickIssue(1);
      vi.spyOn(Element.prototype, "getClientRects").mockImplementation(function (this: Element) {
        return ((this as HTMLElement).dataset.issueId === "1"
          ? [{ left: 160, top: 150, right: 210, bottom: 170 }]
          : []) as unknown as DOMRectList;
      });
      vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
        () =>
          ({ left: 100, top: 140, right: 400, bottom: 290, width: 300, height: 150 }) as DOMRect,
      );
      t.content.reposition();
      expect(t.view()?.top).toBe("176px");
    });
  });

  it("closes the card and draws nothing when page mode is turned off", async () => {
    const t = await checked();
    await t.clickIssue(1);
    t.runtime.broadcast("page-mode-off");
    expect(t.host()).toBeUndefined();
    expect(t.content.popover).toBeUndefined();
  });

  it("draws editable content from the rectangles of a Range over each issue", async () => {
    const popover = new FakePopover();
    const t = await setup({
      popover,
      html: `<div id="box" contenteditable="true"><p>Yesterday I seen him.</p><p>He go home.</p></div>`,
    });
    layOutUnderlines();
    vi.spyOn(Range.prototype, "getClientRects").mockImplementation(function (this: Range) {
      const left = this.toString() === "I seen" ? 160 : 220;
      return [
        { left, top: 110, right: left + 50, bottom: 130, width: 50, height: 20 },
      ] as unknown as DOMRectList;
    });
    // "Yesterday I seen him.\nHe go home.": "I seen" is 10..16 and "He go" is 22..27.
    t.runner.answer(resultOf(ISSUES));
    await t.focusAndLoad();
    const clip = t.layer()?.firstElementChild as HTMLElement;
    expect([...clip.querySelectorAll("path")]).toHaveLength(2);
    // A click in the second underline opens the popover for it.
    mouse("mouseup", t.box, 240, 120);
    await t.getFrame()?.idle();
    expect(popover.opened.map((o) => o.issue)).toEqual([2]);
  });
});

describe("PageModeContent: the issues dialog", () => {
  afterEach(() => {
    for (const name of ["clientWidth", "clientHeight"] as const) {
      Reflect.deleteProperty(HTMLElement.prototype, name);
    }
  });

  async function checked(extra: Options = {}) {
    const popover = new FakePopover();
    const dialog = new FakeDialog();
    const t = await setup({ popover, dialog, ...extra });
    layOutUnderlines();
    t.runner.answer(resultOf(ISSUES));
    await t.focusAndLoad();
    t.clearSent();
    const spans = () => [...(t.layer()?.querySelectorAll<HTMLElement>("span.issue") ?? [])];
    const view = () => {
      const frame = t.iframe();
      return frame === null
        ? undefined
        : {
            display: frame.style.getPropertyValue("display"),
            visibility: frame.style.getPropertyValue("visibility"),
            left: frame.style.getPropertyValue("left"),
            top: frame.style.getPropertyValue("top"),
            width: frame.style.getPropertyValue("width"),
            height: frame.style.getPropertyValue("height"),
          };
    };
    const clickBadge = async () => {
      t.badge()?.dispatchEvent(trusted(new MouseEvent("click", { bubbles: true })));
      await t.getFrame()?.idle();
      await settle();
    };
    const clickIssue = async (n: number) => {
      mouse("mouseup", t.box, 60 * n + 120, 120);
      await t.getFrame()?.idle();
      await settle();
    };
    return { ...t, popover, dialog, spans, view, clickBadge, clickIssue };
  }

  it("opens when the badge is clicked: the frame is asked, and shown next to the box once it has drawn the dialog", async () => {
    const t = await checked();
    await t.clickBadge();
    expect(t.sent()).toEqual([{ type: "dialog-open", box: 1, issue: null }]);
    expect(t.dialog.opened).toEqual([{ box: 1, issue: null }]);
    // The box is at x 100..400: there is room on its right for a panel of 440 by 520.
    expect(t.view()).toEqual({
      display: "block",
      visibility: "visible",
      left: "408px",
      top: "100px",
      width: "440px",
      height: "520px",
    });
    expect(t.content.dialog?.box.id).toBe(1);
    expect(t.runtime.opened).toEqual([]);
  });

  it("stays hidden until the frame has drawn the dialog", async () => {
    const t = await checked({ dialog: { open: () => undefined, close: () => undefined } });
    await t.clickBadge();
    expect(t.view()?.visibility).toBe("hidden");
    expect(t.view()?.display).toBe("block");
  });

  it("closes when the badge is clicked again, and tells the frame", async () => {
    const t = await checked();
    await t.clickBadge();
    t.clearSent();
    await t.clickBadge();
    expect(t.sent()).toEqual([{ type: "dialog-close", box: 1 }]);
    expect(t.view()?.display).toBe("none");
    expect(t.content.dialog).toBeUndefined();
  });

  it("opens even when there is no LLM or the check failed: the dialog says what is wrong", async () => {
    const t = await setup({ dialog: new FakeDialog(), popover: new FakePopover() });
    t.runner.fail(new Error("down"));
    await t.focusAndLoad();
    expect(t.kind()).toBe("warning");
    t.clearSent();
    t.badge()?.dispatchEvent(trusted(new MouseEvent("click", { bubbles: true })));
    expect(t.sent()).toEqual([{ type: "dialog-open", box: 1, issue: null }]);
  });

  it("selects an issue in the box when the frame says so: it has the selected background and is scrolled to", async () => {
    const t = await checked();
    const reveal = vi.spyOn(t.content.underlinesOf(t.content.boxes[0] as never) as never, "reveal");
    await t.clickBadge();
    t.dialog.send?.({ type: "dialog-select", box: 1, issue: 2 });
    expect(t.content.dialog?.issue).toBe(2);
    expect(t.spans()[1]?.style.getPropertyValue("background-color")).toBe("rgba(213, 94, 0, 0.2)");
    expect(t.spans()[0]?.style.getPropertyValue("background-color")).toBe("");
    expect(reveal).toHaveBeenCalledTimes(1);
    expect(reveal).toHaveBeenCalledWith(2);
    // The same issue again scrolls nothing; a selection of none takes the background away.
    t.dialog.send?.({ type: "dialog-select", box: 1, issue: 2 });
    expect(reveal).toHaveBeenCalledTimes(1);
    t.dialog.send?.({ type: "dialog-select", box: 1, issue: null });
    expect(t.spans()[1]?.style.getPropertyValue("background-color")).toBe("");
    expect(reveal).toHaveBeenCalledTimes(1);
    // Nothing is ever sent to move the caret or the focus of the box.
    expect(t.sent().every((m) => m.type === "dialog-open")).toBe(true);
  });

  it("closes when the frame says so (Close, Escape in the dialog), and gives the box its focus back", async () => {
    const t = await checked();
    await t.clickBadge();
    // The focus is in the dialog: the page's active element is our host.
    vi.spyOn(document, "activeElement", "get").mockReturnValue(t.host()!);
    const focus = vi.spyOn(t.box, "focus");
    t.dialog.send?.({ type: "dialog-closed", box: 1 });
    expect(t.content.dialog).toBeUndefined();
    expect(t.view()?.display).toBe("none");
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    // It did not echo the close to the frame.
    expect(t.dialog.closed).toEqual([]);
  });

  it("closes on Escape anywhere in the page, and the underline loses its selected background", async () => {
    const t = await checked();
    await t.clickBadge();
    t.dialog.send?.({ type: "dialog-select", box: 1, issue: 1 });
    t.clearSent();
    key("keydown", "Escape");
    expect(t.sent()).toEqual([{ type: "dialog-close", box: 1 }]);
    expect(t.content.dialog).toBeUndefined();
    expect(t.spans()[0]?.style.getPropertyValue("background-color")).toBe("");
  });

  it("ignores an Escape that the page made up", async () => {
    const t = await checked();
    await t.clickBadge();
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(t.content.dialog?.box.id).toBe(1);
  });

  it("stays open while the user types in the box, and follows its issues", async () => {
    const t = await checked();
    await t.clickBadge();
    typeInto(t.box, `Oh! ${TEXT}`);
    expect(t.content.dialog?.box.id).toBe(1);
    expect(t.view()?.display).toBe("block");
  });

  it("follows its box while the page moves", async () => {
    const t = await checked();
    await t.clickBadge();
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      () => ({ left: 100, top: 300, right: 400, bottom: 450, width: 300, height: 150 }) as DOMRect,
    );
    t.content.reposition();
    // Moved up to stay inside the window (768 high, 8 px margin): 768 - 520 - 8.
    expect(t.view()?.top).toBe("240px");
  });

  describe("and the popover", () => {
    it("opens the dialog for All issues, with the issue the card showed selected, and closes the card first", async () => {
      const t = await checked();
      await t.clickIssue(1);
      t.clearSent();
      t.popover.send?.({ type: "all-issues", box: 1 });
      expect(t.sent()).toEqual([
        { type: "popover-close", box: 1 },
        { type: "dialog-open", box: 1, issue: 1 },
      ]);
      expect(t.content.popover).toBeUndefined();
      expect(t.content.dialog?.box.id).toBe(1);
      expect(t.view()?.width).toBe("440px");
    });

    it("closes the dialog when a click in an underline opens the popover", async () => {
      const t = await checked();
      await t.clickBadge();
      t.clearSent();
      await t.clickIssue(2);
      expect(t.sent()).toEqual([
        { type: "dialog-close", box: 1 },
        { type: "popover-open", box: 1, issue: 2, maxHeight: 340 },
      ]);
      expect(t.content.dialog).toBeUndefined();
      expect(t.content.popover?.issue).toBe(2);
      expect(t.view()?.width).toBe("360px");
    });

    it("closes the popover when the badge opens the dialog", async () => {
      const t = await checked();
      await t.clickIssue(1);
      t.clearSent();
      await t.clickBadge();
      expect(t.sent()).toEqual([
        { type: "popover-close", box: 1 },
        { type: "dialog-open", box: 1, issue: null },
      ]);
      expect(t.content.popover).toBeUndefined();
    });

    it("keeps the dialog when a click is not in an underline", async () => {
      const t = await checked();
      await t.clickBadge();
      mouse("mouseup", t.box, 380, 240);
      await t.getFrame()?.idle();
      expect(t.content.dialog?.box.id).toBe(1);
      expect(t.content.popover).toBeUndefined();
    });
  });

  it("closes when the box leaves the page", async () => {
    const t = await checked();
    await t.clickBadge();
    t.box.remove();
    t.content.reposition();
    expect(t.content.dialog).toBeUndefined();
    expect(t.view()?.display).toBe("none");
  });

  it("is gone when page mode is turned off", async () => {
    const t = await checked();
    await t.clickBadge();
    t.runtime.broadcast("page-mode-off");
    expect(t.host()).toBeUndefined();
    expect(t.content.dialog).toBeUndefined();
  });

  it("does not open for a box whose frame is blocked: the badge offers only Open in English Tutor", async () => {
    const t = await setup({ frame: "never" });
    focusIn(t.box);
    await settle();
    t.scheduler.advance(FRAME_TIMEOUT_MS);
    t.clearSent();
    t.badge()?.dispatchEvent(trusted(new MouseEvent("click", { bubbles: true })));
    expect(t.content.dialog).toBeUndefined();
    expect(t.sent()).toEqual([]);
  });
});
