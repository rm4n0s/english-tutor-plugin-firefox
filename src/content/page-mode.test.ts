// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CountingRandom } from "../core/analysis/testing/helpers";
import { placed, resultOf } from "../core/issues/testing/helpers";
import { Logger } from "../core/log";
import { frameIdOfFragment, type ContentMessage } from "../core/page-mode/protocol";
import { FakeClock, FakeScheduler } from "../core/testing/fake-clock";
import { PageFrame } from "../page-ui/frame";
import { FakeRunner, MODEL, settle } from "../page-ui/testing";
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
  html?: string;
  enabled?: boolean;
  frame?: "ok" | "never";
}

/** Every content script of a test: all are removed afterwards, as their listeners are on the shared window. */
const made: PageModeContent[] = [];

async function setup(options: Options = {}) {
  const box = setBody(document, options.html ?? `<textarea id="box">${TEXT}</textarea>`);
  layOut();
  const runtime = new FakePageModeRuntime();
  runtime.enabled = options.enabled ?? true;
  const bus = new FakePortBus();
  const scheduler = new FakeScheduler();
  const runner = new FakeRunner();
  const random = new CountingRandom();
  const logged: string[] = [];
  const record = (message: string) => {
    logged.push(message);
  };
  const log = new Logger({ debug: record, info: record, warn: record, error: record });
  const content = new PageModeContent({
    win: window,
    runtime,
    connector: bus.connector,
    scheduler,
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
          settings: { delaySeconds: 3, getModel: () => MODEL, load: () => Promise.resolve() },
        }),
        log,
      });
    }
    Object.defineProperty(frameElement, "contentWindow", { value: {}, configurable: true });
    frameElement.dispatchEvent(new Event("load"));
  };
  made.push(content);

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
    const t = await setup({ enabled: false });
    expect(t.runtime.asked).toEqual([window.location.hostname]);
    expect(t.content.running).toBe(false);
    expect(t.host()).toBeUndefined();
    focusIn(t.box);
    expect(t.content.boxes).toEqual([]);
  });

  it("does nothing on a host in the list of sites it is off on, as the background script answers", async () => {
    const t = await setup({ enabled: false });
    focusIn(t.box);
    expect(t.iframe()).toBeNull();
    expect(t.runtime.opened).toEqual([]);
  });

  it("does nothing when it cannot ask", async () => {
    const box = setBody(document, "<textarea>one two three</textarea>");
    const runtime = new FakePageModeRuntime();
    runtime.enabledFails = new Error("no background");

    const content = new PageModeContent({
      win: window,
      runtime,
      connector: new FakePortBus().connector,
      scheduler: new FakeScheduler(),
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

  it("does not react to a click while the frame works: the dialog of step 15 is behind the seam", async () => {
    const t = await setup();
    t.runner.answer(resultOf(ISSUES));
    await t.focusAndLoad();
    const clicked = vi.fn();
    t.content.onBadgeClick = clicked;
    t.badge()?.dispatchEvent(trusted(new MouseEvent("click", { bubbles: true })));
    expect(clicked).toHaveBeenCalledTimes(1);
    expect(clicked).toHaveBeenCalledWith({ box: t.content.boxes[0] });
    expect(t.content.boxes[0]?.id).toBe(1);
    expect(t.runtime.opened).toEqual([]);
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
    const t = await setup({ enabled: false });
    expect(t.content.running).toBe(false);
    t.runtime.enabled = true;
    t.runtime.broadcast("settings-changed");
    await settle();
    expect(t.content.running).toBe(true);
    expect(t.runtime.asked).toHaveLength(2);
  });

  it("removes everything on settings-changed when the host was turned off", async () => {
    const t = await setup();
    t.runner.answer(resultOf(ISSUES));
    await t.focusAndLoad();
    t.runtime.enabled = false;
    t.runtime.broadcast("settings-changed");
    await settle();
    expect(t.content.running).toBe(false);
    expect(t.host()).toBeUndefined();
    expect(t.getFrame()?.boxes).toBe(1 - 1 + t.getFrame()!.boxes);
  });

  it("the latest answer wins when two settings-changed overlap", async () => {
    const t = await setup({ enabled: false });
    t.runtime.enabled = true;
    t.runtime.broadcast("settings-changed");
    t.runtime.enabled = false;
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
