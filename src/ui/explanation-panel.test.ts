// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExplanationAction } from "../core/issues/explanation-controller";
import { FakeScheduler } from "../core/testing/fake-clock";
import { ExplanationPanel, IDLE_HINT, RENDER_INTERVAL_MS } from "./explanation-panel";

let host: HTMLElement;
let opened: { options: number; links: string[] };
let scheduler: FakeScheduler;
let actions: ExplanationAction[];
let panel: ExplanationPanel;

const TARGET = { label: "Subject-verb agreement", categoryLabel: "Grammar", snippet: "He go" };

function mountPanel(layout?: "normal" | "compact"): ExplanationPanel {
  document.body.replaceChildren();
  host = document.createElement("section");
  document.body.append(host);
  opened = { options: 0, links: [] };
  scheduler = new FakeScheduler();
  actions = [];
  const created = new ExplanationPanel(
    document,
    host,
    {
      openOptions: () => {
        opened.options++;
      },
      openLink: (url) => {
        opened.links.push(url);
      },
      scheduler,
    },
    layout === undefined ? {} : { layout },
  );
  created.setActionHandler((action) => {
    actions.push(action);
  });
  return created;
}

beforeEach(() => {
  panel = mountPanel();
});

const q = (selector: string): HTMLElement => {
  const found = host.querySelector<HTMLElement>(selector);
  if (found === null) throw new Error(`nothing matches ${selector}`);
  return found;
};
const visible = (selector: string): boolean => {
  const found = host.querySelector<HTMLElement>(selector);
  return found !== null && !found.hidden;
};
const body = () => q("#explain-body");
const click = (selector: string) =>
  q(selector).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

describe("idle", () => {
  it("shows the hint of SPEC section 4.5", () => {
    expect(IDLE_HINT).toBe(
      "Select an error in the list or an underlined error in the text to learn more",
    );
    expect(host.textContent).toBe(IDLE_HINT);
    expect(host.querySelector("a")).toBeNull();
    expect(panel.state).toBe("idle");
  });

  it("without an LLM asks for one, with a link that opens the options page", () => {
    panel.setHasLLM(false);
    expect(host.textContent).toBe(
      "No LLM is configured. Add one in Preferences to start checking.",
    );
    const link = q("a");
    expect(link.textContent).toBe("Preferences");
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(event);
    expect(opened.options).toBe(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("goes back to the idle hint once an LLM exists", () => {
    panel.setHasLLM(false);
    panel.setHasLLM(true);
    expect(host.textContent).toBe(IDLE_HINT);
  });

  it("is not disturbed by a change of LLM while an explanation shows", () => {
    panel.showLoading(TARGET);
    panel.showReady("Done.");
    panel.setHasLLM(false);
    expect(body().textContent).toBe("Done.");
    panel.showIdle();
    expect(host.textContent).toContain("No LLM is configured");
  });
});

describe("the states", () => {
  const states = [
    {
      name: "loading",
      show: () => {
        panel.showLoading(TARGET);
      },
      shown: [
        "#explain-header",
        "#explain-target",
        "#explain-progress",
        "#explain-cancel",
        "#explain-not-error",
      ],
      hidden: ["#explain-regenerate", "#explain-retry"],
    },
    {
      name: "ready",
      show: () => {
        panel.showLoading(TARGET);
        panel.showReady("Use **goes**.");
      },
      shown: ["#explain-header", "#explain-regenerate", "#explain-not-error"],
      hidden: ["#explain-target", "#explain-progress", "#explain-retry"],
    },
    {
      name: "failed",
      show: () => {
        panel.showLoading(TARGET);
        panel.showFailed("The server said no.");
      },
      shown: ["#explain-header", "#explain-retry", "#explain-not-error"],
      hidden: ["#explain-target", "#explain-progress", "#explain-regenerate"],
    },
    {
      name: "cancelled",
      show: () => {
        panel.showLoading(TARGET);
        panel.showCancelled();
      },
      shown: ["#explain-header", "#explain-regenerate", "#explain-not-error"],
      hidden: ["#explain-target", "#explain-progress", "#explain-retry"],
    },
  ];

  it.each(states)("$name shows $shown and hides $hidden", ({ show, shown, hidden, name }) => {
    show();
    expect(panel.state).toBe(name);
    for (const selector of shown) expect(visible(selector), selector).toBe(true);
    for (const selector of hidden) expect(visible(selector), selector).toBe(false);
    expect(q("#explain-panel").dataset.state).toBe(name);
  });

  it("loading shows the snippet and the category, the label as the header, and Cancel", () => {
    panel.showLoading(TARGET);
    expect(q("#explain-header").textContent).toBe("Subject-verb agreement");
    expect(q("#explain-snippet").textContent).toBe("He go");
    expect(q("#explain-category").textContent).toBe("Grammar");
    expect(q("#explain-progress").getAttribute("role")).toBe("status");
    expect(body().getAttribute("aria-busy")).toBe("true");
    expect(body().textContent).toBe("");
  });

  it("ready renders the markdown and is no longer busy", () => {
    panel.showLoading(TARGET);
    panel.showReady("### What is wrong\nUse **goes**, not `go`.\n\n- one\n- two");
    expect(body().getAttribute("aria-busy")).toBe("false");
    expect(body().querySelector("h5")?.textContent).toBe("What is wrong");
    expect(body().querySelector("strong")?.textContent).toBe("goes");
    expect(body().querySelector("code")?.textContent).toBe("go");
    expect(body().querySelectorAll("li")).toHaveLength(2);
    expect(body().textContent).not.toContain("**");
  });

  it("failed shows the message as an alert, as text", () => {
    panel.showLoading(TARGET);
    panel.showFailed("<b>HTTP 500</b>");
    const message = q(".explain-message");
    expect(message.textContent).toBe("<b>HTTP 500</b>");
    expect(message.getAttribute("role")).toBe("alert");
    expect(body().querySelector("b")).toBeNull();
  });

  it("cancelled says so, and drops the partial text", () => {
    panel.showLoading(TARGET);
    panel.appendText("Partial text");
    panel.showCancelled();
    expect(body().textContent).toBe("Explanation cancelled.");
  });

  it("a new loading state clears the previous explanation", () => {
    panel.showLoading(TARGET);
    panel.showReady("Old explanation.");
    panel.showLoading({ ...TARGET, label: "Article", snippet: "a apple" });
    expect(body().textContent).toBe("");
    expect(q("#explain-header").textContent).toBe("Article");
    expect(q("#explain-snippet").textContent).toBe("a apple");
  });

  it("returns to the idle hint", () => {
    panel.showLoading(TARGET);
    panel.showReady("x");
    panel.showIdle();
    expect(host.textContent).toBe(IDLE_HINT);
    expect(host.querySelector("#explain-panel")).toBeNull();
  });

  it("shows Not an error in every state but idle, and the header line can be replaced", () => {
    expect(host.querySelector("#explain-not-error")).toBeNull();
    panel.showLoading(TARGET);
    panel.showReady("x");
    expect(panel.notErrorButton.hidden).toBe(false);
    expect(panel.notErrorButton.textContent).toBe("Not an error");
    panel.setHeaderLine("Subject-verb agreement: you have made this mistake 7 times");
    expect(q("#explain-header").textContent).toBe(
      "Subject-verb agreement: you have made this mistake 7 times",
    );
    panel.setHeaderLine(undefined);
    expect(q("#explain-header").textContent).toBe("Subject-verb agreement");
  });

  it("ignores text that arrives outside the loading state", () => {
    panel.showLoading(TARGET);
    panel.showReady("Final.");
    panel.appendText("late");
    expect(body().textContent).toBe("Final.");
    panel.showIdle();
    panel.appendText("late");
    expect(host.textContent).toBe(IDLE_HINT);
  });
});

describe("buttons", () => {
  it.each([
    {
      selector: "#explain-cancel",
      action: "cancel",
      state: () => {
        panel.showLoading(TARGET);
      },
    },
    {
      selector: "#explain-regenerate",
      action: "regenerate",
      state: () => {
        panel.showLoading(TARGET);
        panel.showReady("x");
      },
    },
    {
      selector: "#explain-regenerate",
      action: "regenerate",
      state: () => {
        panel.showLoading(TARGET);
        panel.showCancelled();
      },
    },
    {
      selector: "#explain-retry",
      action: "retry",
      state: () => {
        panel.showLoading(TARGET);
        panel.showFailed("no");
      },
    },
  ])("$selector reports $action", ({ selector, action, state }) => {
    state();
    click(selector);
    expect(actions).toEqual([action]);
  });

  it("without a handler a press does nothing", () => {
    panel.setActionHandler(undefined);
    panel.showLoading(TARGET);
    expect(() => {
      click("#explain-cancel");
    }).not.toThrow();
  });
});

describe("streaming", () => {
  it("draws the first chunk at once and then at most every 100 ms", () => {
    panel.showLoading(TARGET);
    panel.appendText("a");
    expect(body().textContent).toBe("a");
    panel.appendText("b");
    panel.appendText("c");
    expect(body().textContent).toBe("a");
    scheduler.advance(RENDER_INTERVAL_MS - 1);
    expect(body().textContent).toBe("a");
    scheduler.advance(1);
    expect(body().textContent).toBe("abc");
    // The draw opened a new window: the next chunk waits for it.
    panel.appendText("d");
    expect(body().textContent).toBe("abc");
    scheduler.advance(RENDER_INTERVAL_MS);
    expect(body().textContent).toBe("abcd");
    // A window with nothing new closes; the next chunk is drawn at once.
    scheduler.advance(RENDER_INTERVAL_MS);
    expect(scheduler.pending).toBe(0);
    panel.appendText("e");
    expect(body().textContent).toBe("abcde");
  });

  it.each([
    { name: "twenty chunks in one window", chunks: 20, draws: 2 },
    { name: "one chunk", chunks: 1, draws: 1 },
    { name: "none", chunks: 0, draws: 0 },
  ])("$name make $draws draw(s) in 100 ms", ({ chunks, draws }) => {
    panel.showLoading(TARGET);
    const draw = vi.spyOn(body(), "replaceChildren");
    for (let i = 0; i < chunks; i++) panel.appendText("x");
    scheduler.advance(RENDER_INTERVAL_MS);
    expect(draw).toHaveBeenCalledTimes(draws);
    expect(body().textContent).toBe("x".repeat(chunks));
  });

  it("renders the markdown that has arrived, partial markup included", () => {
    panel.showLoading(TARGET);
    panel.appendText("Use **go");
    expect(body().textContent).toBe("Use **go");
    panel.appendText("es**.");
    scheduler.advance(RENDER_INTERVAL_MS);
    expect(body().querySelector("strong")?.textContent).toBe("goes");
  });

  it("draws the final text again when the stream ends, and stops the timer", () => {
    panel.showLoading(TARGET);
    panel.appendText("thinking </think>");
    panel.appendText(" The answer.");
    expect(body().textContent).toBe("thinking </think>");
    panel.showReady("The answer.");
    expect(body().textContent).toBe("The answer.");
    expect(scheduler.pending).toBe(0);
    scheduler.advance(1000);
    expect(body().textContent).toBe("The answer.");
  });

  it("a cancel or a failure stops the timer and shows no more text", () => {
    panel.showLoading(TARGET);
    panel.appendText("a");
    panel.appendText("b");
    panel.showCancelled();
    scheduler.advance(1000);
    expect(body().textContent).toBe("Explanation cancelled.");
    panel.showLoading(TARGET);
    panel.appendText("a");
    panel.appendText("b");
    panel.showFailed("no");
    scheduler.advance(1000);
    expect(body().textContent).toBe("no");
  });

  it("a cached explanation arrives in one chunk and then as the final text", () => {
    panel.showLoading(TARGET);
    panel.appendText("Cached **text**.");
    panel.showReady("Cached **text**.");
    expect(body().querySelector("strong")?.textContent).toBe("text");
    expect(scheduler.pending).toBe(0);
  });
});

describe("following the end", () => {
  /** Gives the body a scroll geometry: 100 px high, 10 px per character of text. */
  function useGeometry(): void {
    const element = body();
    Object.defineProperty(element, "clientHeight", { configurable: true, value: 100 });
    Object.defineProperty(element, "scrollHeight", {
      configurable: true,
      get: () => Math.max(100, element.textContent.length * 10),
    });
  }

  function userScrollsTo(top: number): void {
    body().scrollTop = top;
    body().dispatchEvent(new Event("scroll"));
  }

  it("scrolls to the end while text arrives", () => {
    panel.showLoading(TARGET);
    useGeometry();
    panel.appendText("first lines");
    expect(body().scrollTop).toBe(0); // the first draw stays at the top
    panel.appendText(" and more text");
    scheduler.advance(RENDER_INTERVAL_MS);
    expect(body().scrollTop).toBe(body().scrollHeight);
    panel.appendText(" and even more");
    scheduler.advance(RENDER_INTERVAL_MS);
    expect(body().scrollTop).toBe(body().scrollHeight);
  });

  it("stops following when the user scrolls up, and follows again at the end", () => {
    panel.showLoading(TARGET);
    useGeometry();
    panel.appendText("first lines of the text");
    panel.appendText(" more");
    scheduler.advance(RENDER_INTERVAL_MS);
    userScrollsTo(40);
    panel.appendText(" even more");
    scheduler.advance(RENDER_INTERVAL_MS);
    expect(body().scrollTop).toBe(40);
    panel.showReady("first lines of the text more even more and the end");
    expect(body().scrollTop).toBe(40);
    userScrollsTo(body().scrollHeight - 100);
    panel.showLoading(TARGET); // a new request starts at the top and follows again
    expect(body().scrollTop).toBe(0);
  });

  it("follows again once the user scrolls back to the end", () => {
    panel.showLoading(TARGET);
    useGeometry();
    panel.appendText("first lines of the text");
    panel.appendText(" more");
    scheduler.advance(RENDER_INTERVAL_MS);
    userScrollsTo(10);
    userScrollsTo(body().scrollHeight - 100);
    panel.appendText(" and more still");
    scheduler.advance(RENDER_INTERVAL_MS);
    expect(body().scrollTop).toBe(body().scrollHeight);
  });

  it("shows a finished explanation from its top when the view followed the end of the stream", () => {
    panel.showLoading(TARGET);
    useGeometry();
    panel.appendText("first lines");
    panel.appendText(" and more text");
    scheduler.advance(RENDER_INTERVAL_MS);
    panel.appendText(" and even more");
    scheduler.advance(RENDER_INTERVAL_MS);
    expect(body().scrollTop).toBe(body().scrollHeight);
    panel.showReady("first lines and more text and even more, and the last words");
    expect(body().scrollTop).toBe(0);
  });

  it("keeps the user's place when the stream ends after they scrolled up", () => {
    panel.showLoading(TARGET);
    useGeometry();
    panel.appendText("first lines of the text");
    panel.appendText(" more");
    scheduler.advance(RENDER_INTERVAL_MS);
    userScrollsTo(30);
    panel.showReady("first lines of the text more and the end of it");
    expect(body().scrollTop).toBe(30);
  });

  it("shows an explanation that arrives finished (not streamed) from its top", () => {
    panel.showLoading(TARGET);
    useGeometry();
    panel.showReady("A long explanation that overflows the panel and was never streamed");
    expect(body().scrollTop).toBe(0);
  });

  it("shows a cached explanation from its top, not its end", () => {
    panel.showLoading(TARGET);
    useGeometry();
    panel.appendText("A long cached explanation that overflows the panel");
    panel.showReady("A long cached explanation that overflows the panel");
    expect(body().scrollTop).toBe(0);
  });
});

describe("links", () => {
  const LINK = "See [the rules](https://example.com/rules?a=1) and [**bold**](http://example.org).";

  function clickOn(selector: string, type = "click"): MouseEvent {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true });
    q(selector).dispatchEvent(event);
    return event;
  }

  beforeEach(() => {
    panel.showLoading(TARGET);
    panel.showReady(LINK);
  });

  it("asks the page to open the full address, and never navigates", () => {
    const event = clickOn("a");
    expect(event.defaultPrevented).toBe(true);
    expect(opened.links).toEqual(["https://example.com/rules?a=1"]);
  });

  it("works for a click inside the link's markup", () => {
    const inner = body().querySelector("a strong");
    inner?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(opened.links).toEqual(["http://example.org/"]);
  });

  it("opens in no tab by itself: the anchors only target a new tab as a fallback", () => {
    const anchor = q("a");
    expect(anchor.getAttribute("target")).toBe("_blank");
    expect(anchor.getAttribute("rel")).toBe("noopener noreferrer nofollow");
  });

  it("stops a middle click, which would skip the confirmation", () => {
    const event = clickOn("a", "auxclick");
    expect(event.defaultPrevented).toBe(true);
    expect(opened.links).toEqual([]);
  });

  it("ignores a click on text", () => {
    const event = clickOn("#explain-body p");
    expect(event.defaultPrevented).toBe(false);
    expect(opened.links).toEqual([]);
  });

  it("does not open an address that is not http(s), even if the DOM was changed", () => {
    q("a").setAttribute("href", "javascript:alert(1)");
    const event = clickOn("a");
    expect(event.defaultPrevented).toBe(true);
    expect(opened.links).toEqual([]);
  });

  it("the options link of the idle hint is separate from explanation links", () => {
    panel.showIdle();
    panel.setHasLLM(false);
    click("#options-link");
    expect(opened.options).toBe(1);
    expect(opened.links).toEqual([]);
  });
});

describe("layout", () => {
  it.each([
    { layout: undefined, compact: false },
    { layout: "normal" as const, compact: false },
    { layout: "compact" as const, compact: true },
  ])("$layout: compact class is $compact", ({ layout, compact }) => {
    const created = mountPanel(layout);
    created.showLoading(TARGET);
    expect(q("#explain-panel").classList.contains("explain-compact")).toBe(compact);
  });
});
