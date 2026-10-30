// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { reply, slowReply, streamReply } from "../core/analysis/testing/helpers";
import { NOT_COUNTED_TEXT } from "../core/issues";
import type { FakeResponse, FakeScript } from "../core/llm/testing/fake-fetch";
import type { ErrorEvent } from "../core/store";
import { requestResult } from "../core/store/idb";
import { ignoreKey } from "../platform/ignore-set";
import {
  config,
  mountForTest,
  TAB_ID,
  type HarnessOptions,
  type TutorHarness,
} from "./testing/harness";

let mounted: TutorHarness | undefined;

afterEach(() => {
  mounted?.page.destroy();
  mounted = undefined;
});

async function mount(options: HarnessOptions = {}): Promise<TutorHarness> {
  mounted = await mountForTest(document, { configs: [config()], selected: 1, ...options });
  return mounted;
}

function byId(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`no element #${id}`);
  return found;
}

const editor = () => byId("editor") as HTMLTextAreaElement;
const text = (id: string) => byId(id).textContent;
const rows = () => [...document.querySelectorAll<HTMLElement>(".issue-row")];
const badges = () =>
  rows().map((row) => {
    const badge = row.querySelector<HTMLElement>(".count-badge");
    return badge === null || badge.hidden ? "" : badge.textContent;
  });
const snippets = () => rows().map((row) => row.querySelector(".row-snippet")?.textContent);
const underlined = () =>
  [...document.querySelectorAll("#mirror span.issue")].map((s) => s.textContent);

function type(value: string): void {
  editor().value = value;
  editor().dispatchEvent(new Event("input", { bubbles: true }));
}
const click = (id: string) => byId(id).dispatchEvent(new MouseEvent("click", { bubbles: true }));
const rowClick = (index: number) =>
  rows()[index]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
const panelState = () => document.getElementById("explain-panel")?.dataset.state ?? "idle";

async function settle(check: () => void | Promise<void>): Promise<void> {
  const deadline = Date.now() + 2000;
  for (;;) {
    try {
      await check();
      return;
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}

const TEXT = "Yesterday I seen him. He go to school. I very like it.";
const FOUR_ISSUES = JSON.stringify({
  issues: [
    { text: "I seen", error_type: "verb_form", message: "Use saw." },
    { text: "He go", error_type: "subject_verb_agreement", message: "Use goes." },
    { text: "school", error_type: "collocation", message: "Odd here." },
    { text: "I very like", error_type: "word_order", message: "Put very first." },
    { text: "not in the text", error_type: "article", message: "m" },
  ],
});
const USAGE = { usage: { input: 812, output: 164 } };
const CHECKED = reply(FOUR_ISSUES, USAGE);

async function allEvents(h: TutorHarness): Promise<ErrorEvent[]> {
  return requestResult(
    h.db.transaction("error_events").objectStore("error_events").getAll(),
  ) as Promise<ErrorEvent[]>;
}

/** Types the text and presses Check (or sends an auto-check), and waits for the result. */
async function checkText(h: TutorHarness, value = TEXT): Promise<void> {
  type(value);
  click("check");
  await settle(() => {
    expect(h.page.state.outcome).not.toBe("none");
    expect(h.page.state.pending).toBeNull();
  });
}

/** A manual check, and the recording and the badges that follow it. */
async function checkedAndCounted(h: TutorHarness, value = TEXT): Promise<void> {
  await checkText(h, value);
  await settle(() => {
    expect(badges().some((b) => b !== "")).toBe(true);
  });
}

describe("the tab's source", () => {
  it("is a session key from the injected random source, made when the tab loads", async () => {
    const h = await mount();
    expect(h.page.source.key).toBe("session:00000000-0000-4000-8000-000000000000");
  });
});

describe("recording (SPEC section 5.7)", () => {
  it("records the placed issues of a manual check under the tab's source, with the LLM's name", async () => {
    const h = await mount({ script: CHECKED });
    h.clock.set(50_000);
    await checkedAndCounted(h);
    const events = await allEvents(h);
    expect(events.map((e) => [e.error_type, e.category, e.snippet])).toEqual([
      ["verb_form", "grammar", "I seen"],
      ["subject_verb_agreement", "grammar", "He go"],
      ["collocation", "vocabulary", "school"],
      ["word_order", "syntax", "I very like"],
    ]);
    expect(new Set(events.map((e) => e.source_key))).toEqual(new Set([h.page.source.key]));
    expect(new Set(events.map((e) => e.llm_name))).toEqual(new Set(["Local"]));
    expect(new Set(events.map((e) => e.created_at))).toEqual(new Set([50_000]));
    expect(events.map((e) => e.fingerprint)).toEqual(
      h.page.state.issues.map((issue) => issue.fingerprint),
    );
    expect(h.channel.posted.map((m) => m.type)).toEqual(["stats-changed"]);
  });

  it("counts a second check of the same text once, and announces nothing the second time", async () => {
    const h = await mount({ script: CHECKED });
    await checkedAndCounted(h);
    click("check");
    await settle(() => {
      expect(h.fake.requests).toHaveLength(2);
      expect(h.page.state.pending).toBeNull();
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await allEvents(h)).toHaveLength(4);
    expect(h.channel.posted.map((m) => m.type)).toEqual(["stats-changed"]);
    expect(badges()).toEqual(["x1", "x1", "x1", "x1"]);
  });

  it("does not record the issues of an auto-check, and gives their rows no badge", async () => {
    const h = await mount({ script: CHECKED, settings: { auto_check: true } });
    type(TEXT);
    h.scheduler.advance(3_000);
    await settle(() => {
      expect(h.page.state.issues).toHaveLength(4);
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(await allEvents(h)).toEqual([]);
    expect(badges()).toEqual(["", "", "", ""]);
    expect(h.channel.posted.map((m) => m.type)).toEqual([]);
  });

  it("a failed recording shows ErrorEventSaveFailed in the banner and keeps the underlines", async () => {
    const h = await mount({ script: CHECKED });
    h.session.failWith = new Error("storage.session is not available");
    await checkText(h);
    await settle(() => {
      expect(byId("banner").hidden).toBe(false);
    });
    expect(text("banner")).toContain("The mistakes of this check could not be saved.");
    expect(underlined()).toEqual(["I seen", "He go", "school", "I very like"]);
    expect(snippets()).toEqual(["I seen", "He go", "school", "I very like"]);
    expect(
      h.logged.some(
        (l) => l.level === "error" && JSON.stringify(l.fields).includes("ErrorEventSaveFailed"),
      ),
    ).toBe(true);
    expect(await allEvents(h)).toEqual([]);
    expect(h.channel.posted).toEqual([]);
  });

  it("a cancelled or failed check records nothing", async () => {
    const h = await mount({
      script: { kind: "json", status: 500, body: { error: { message: "no" } } },
    });
    await checkText(h);
    expect(await allEvents(h)).toEqual([]);
  });
});

describe("badges (SPEC section 4.4)", () => {
  it("shows x<total> on the rows of recorded issues, by error type", async () => {
    const h = await mount({ script: CHECKED });
    // Two earlier mistakes of the type "He go" has, in another text.
    await h.stats.record("session:old", "Local", [
      {
        error_type: "subject_verb_agreement",
        category: "grammar",
        snippet: "a",
        fingerprint: "o1",
      },
      {
        error_type: "subject_verb_agreement",
        category: "grammar",
        snippet: "b",
        fingerprint: "o2",
      },
    ]);
    await checkedAndCounted(h);
    expect(badges()).toEqual(["x1", "x3", "x1", "x1"]);
    expect(rows()[1]?.querySelector(".count-badge")?.getAttribute("title")).toBe(
      "You have made this mistake 3 times",
    );
  });

  it("follows another tab: a record, then a reset, announced as stats-changed", async () => {
    const h = await mount({ script: CHECKED });
    await checkedAndCounted(h);
    await h.stats.record("session:other", "Local", [
      { error_type: "verb_form", category: "grammar", snippet: "x", fingerprint: "ot" },
    ]);
    h.other.channel.post("stats-changed");
    await settle(() => {
      expect(badges()).toEqual(["x2", "x1", "x1", "x1"]);
    });
    await h.stats.resetMistakes();
    h.other.channel.post("stats-changed");
    await settle(() => {
      expect(badges()).toEqual(["", "", "", ""]);
    });
    expect(underlined()).toHaveLength(4);
  });
});

describe("the header line (SPEC section 4.5)", () => {
  const header = () => text("explain-header");

  it("reads the counts of the selected issue's type, with the last 7 days", async () => {
    const h = await mount({ script: CHECKED });
    h.clock.set(100 * 86_400_000);
    await h.stats.record("session:old", "Local", [
      {
        error_type: "subject_verb_agreement",
        category: "grammar",
        snippet: "a",
        fingerprint: "o1",
      },
    ]);
    h.clock.advance(10 * 86_400_000);
    await checkedAndCounted(h);
    rowClick(1);
    await settle(() => {
      expect(header()).toBe(
        "Subject-verb agreement: you have made this mistake 2 times (1 in the last 7 days)",
      );
    });
  });

  it("says that nothing is recorded yet for a type that has no mistake", async () => {
    const h = await mount({ script: CHECKED });
    await checkedAndCounted(h);
    await h.stats.resetMistakes();
    h.other.channel.post("stats-changed");
    await settle(() => {
      expect(badges()).toEqual(["", "", "", ""]);
    });
    rowClick(0);
    await settle(() => {
      expect(header()).toBe("Verb form: no mistake of this type recorded yet");
    });
  });

  it("ends with 'This one is not counted' for an issue of an auto-check", async () => {
    const h = await mount({ script: CHECKED, settings: { auto_check: true } });
    type(TEXT);
    h.scheduler.advance(3_000);
    await settle(() => {
      expect(h.page.state.issues).toHaveLength(4);
    });
    rowClick(0);
    await settle(() => {
      expect(header()).toBe(`Verb form: no mistake of this type recorded yet. ${NOT_COUNTED_TEXT}`);
    });
  });

  it("returns to the plain label when another issue is selected before its counts arrive, and clears with the panel", async () => {
    const h = await mount({ script: CHECKED });
    await checkedAndCounted(h);
    rowClick(0);
    await settle(() => {
      expect(header()).toContain("you have made this mistake 1 time");
    });
    h.page.state.select(null);
    expect(panelState()).toBe("idle");
  });

  it("changes when another tab resets the statistics under a selected issue", async () => {
    const h = await mount({ script: CHECKED });
    await checkedAndCounted(h);
    rowClick(0);
    await settle(() => {
      expect(header()).toContain("1 time");
    });
    await h.stats.resetMistakes();
    h.other.channel.post("stats-changed");
    await settle(() => {
      expect(header()).toBe("Verb form: no mistake of this type recorded yet");
    });
  });
});

describe("Not an error (SPEC section 5.7)", () => {
  const sse = (content: string) =>
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n`;
  const script = (explain: FakeResponse = streamReply(["### Why\nBecause."])): FakeScript => {
    return (request) => {
      const messages = request.body.messages as { role: string; content: string }[];
      const system = messages.find((m) => m.role === "system")?.content ?? "";
      return system.includes("patient English teacher") ? explain : CHECKED;
    };
  };
  const notError = () => document.getElementById("explain-not-error");

  it("is not there while the panel is idle, and shows once an explanation starts", async () => {
    const h = await mount({ script: script() });
    await checkedAndCounted(h);
    expect(notError()).toBeNull();
    rowClick(1);
    expect(notError()?.hidden).toBe(false);
    await settle(() => {
      expect(panelState()).toBe("ready");
    });
    expect(notError()?.hidden).toBe(false);
  });

  it.each<{ name: string; explain: FakeResponse }>([
    {
      name: "loading",
      explain: { kind: "stream", chunks: [sse("Part")], hold: true },
    },
    { name: "ready", explain: streamReply(["Done."]) },
    {
      name: "failed",
      explain: { kind: "json", status: 500, body: { error: { message: "no" } } },
    },
  ])(
    "works from the $name panel: the underline and row go, the event is deleted, the pair is ignored",
    async ({ explain }) => {
      const h = await mount({ script: script(explain) });
      await checkedAndCounted(h);
      const before = await allEvents(h);
      rowClick(1);
      await settle(() => {
        expect(panelState()).not.toBe("idle");
      });
      h.channel.posted.length = 0;
      click("explain-not-error");
      await settle(() => {
        expect(snippets()).toEqual(["I seen", "school", "I very like"]);
      });
      expect(underlined()).toEqual(["I seen", "school", "I very like"]);
      expect(text("issues-header")).toBe("Issues (3)");
      expect(panelState()).toBe("idle");
      const gone = before.find((e) => e.snippet === "He go");
      const after = await allEvents(h);
      expect(after.map((e) => e.snippet)).toEqual(["I seen", "school", "I very like"]);
      expect(h.session.values.has(ignoreKey(h.page.source.key, gone?.fingerprint ?? ""))).toBe(
        true,
      );
      expect(h.channel.posted.map((m) => m.type)).toEqual(["stats-changed"]);
      expect(h.page.state.checked).toBe(true);
    },
  );

  it("a re-check does not record it again and its row gets no badge", async () => {
    const h = await mount({ script: script() });
    await checkedAndCounted(h);
    rowClick(1);
    click("explain-not-error");
    await settle(() => {
      expect(snippets()).toHaveLength(3);
    });
    click("check");
    await settle(() => {
      expect(
        h.fake.requests.filter((r) => !JSON.stringify(r.body).includes("patient English teacher")),
      ).toHaveLength(2);
      expect(h.page.state.issues).toHaveLength(4);
      expect(h.page.state.pending).toBeNull();
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((await allEvents(h)).map((e) => e.snippet)).toEqual(["I seen", "school", "I very like"]);
    expect(badges()).toEqual(["x1", "", "x1", "x1"]);
  });

  it("works for an issue of an auto-check too: it is ignored in later manual checks", async () => {
    const h = await mount({ script: script(), settings: { auto_check: true } });
    type(TEXT);
    h.scheduler.advance(3_000);
    await settle(() => {
      expect(h.page.state.issues).toHaveLength(4);
    });
    rowClick(0);
    click("explain-not-error");
    await settle(() => {
      expect(snippets()).toHaveLength(3);
    });
    expect(h.session.values.size).toBe(1);
    click("check");
    await settle(() => {
      expect(h.page.state.issues.every((i) => i.manual)).toBe(true);
      expect(h.page.state.pending).toBeNull();
    });
    await settle(async () => {
      expect(await allEvents(h)).toHaveLength(3);
    });
  });

  it("a failure shows StatsResetFailed in the banner and keeps the issue", async () => {
    const h = await mount({ script: script() });
    await checkedAndCounted(h);
    rowClick(1);
    h.session.failWith = new Error("storage.session is not available");
    click("explain-not-error");
    await settle(() => {
      expect(byId("banner").hidden).toBe(false);
    });
    expect(text("banner")).toContain("The mistake could not be removed from the statistics.");
    expect(snippets()).toHaveLength(4);
    expect(await allEvents(h)).toHaveLength(4);
  });
});

describe("the row's context menu (SPEC section 4.4)", () => {
  const NOT = `row-not-an-error-${String(TAB_ID)}`;
  const REGEN = `row-regenerate-${String(TAB_ID)}`;
  const contextMenu = (index: number) => {
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    rows()[index]?.dispatchEvent(event);
    return event;
  };
  const explainRequests = (h: TutorHarness) =>
    h.fake.requests.filter((r) => JSON.stringify(r.body).includes("patient English teacher"));
  const script: FakeScript = (request) =>
    JSON.stringify(request.body).includes("patient English teacher")
      ? streamReply(["### Why\nBecause."])
      : CHECKED;

  it("makes its entries for this tab on the tutor page, invisible until a row's menu is shown", async () => {
    const h = await mount({ script });
    await settle(() => {
      expect(h.menus.entries.size).toBe(2);
    });
    expect([...h.menus.entries.keys()]).toEqual([NOT, REGEN]);
    expect(h.menus.entries.get(NOT)).toMatchObject({
      title: "Not an error",
      visible: false,
      patterns: ["moz-extension://test/tutor.html"],
    });
    expect(h.menus.entries.get(REGEN)?.title).toBe("Regenerate explanation");
  });

  it("overrides the browser's menu on a right click on a row, and on no other element", async () => {
    const h = await mount({ script });
    await checkedAndCounted(h);
    await settle(() => {
      expect(h.menus.entries.size).toBe(2);
    });
    byId("issues").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    expect(h.menus.overridden).toBe(0);
    contextMenu(2);
    expect(h.menus.overridden).toBe(1);
  });

  it("Not an error removes the issue of the row it was opened on, selected or not", async () => {
    const h = await mount({ script });
    await checkedAndCounted(h);
    await settle(() => {
      expect(h.menus.entries.size).toBe(2);
    });
    rowClick(0);
    contextMenu(2);
    h.menus.show(TAB_ID);
    await settle(() => {
      expect(h.menus.visibleIds).toEqual([NOT, REGEN]);
    });
    h.menus.choose(NOT, TAB_ID);
    h.menus.hide();
    await settle(() => {
      expect(snippets()).toEqual(["I seen", "He go", "I very like"]);
    });
    expect(underlined()).toEqual(["I seen", "He go", "I very like"]);
    expect(h.page.state.selected?.snippet).toBe("I seen");
    await settle(() => {
      expect(h.menus.visibleIds).toEqual([]);
    });
    expect((await allEvents(h)).map((e) => e.snippet)).toEqual(["I seen", "He go", "I very like"]);
  });

  it("Regenerate explanation selects the row and makes one request that skips the cache", async () => {
    const h = await mount({ script });
    await checkedAndCounted(h);
    await settle(() => {
      expect(h.menus.entries.size).toBe(2);
    });
    contextMenu(1);
    h.menus.show(TAB_ID);
    h.menus.choose(REGEN, TAB_ID);
    h.menus.hide();
    await settle(() => {
      expect(panelState()).toBe("ready");
    });
    expect(h.page.state.selected?.snippet).toBe("He go");
    expect(explainRequests(h)).toHaveLength(1);
    // Again on the same row: the cache is skipped, so there is a second request.
    contextMenu(1);
    h.menus.show(TAB_ID);
    h.menus.choose(REGEN, TAB_ID);
    await settle(() => {
      expect(explainRequests(h)).toHaveLength(2);
    });
  });

  it("disables Regenerate explanation when no LLM is selected", async () => {
    const h = await mount({ script });
    await checkedAndCounted(h);
    await h.deps.store.deleteConfig(1);
    h.other.channel.post("configs-changed");
    await settle(() => {
      expect((byId("llm-select") as HTMLSelectElement).disabled).toBe(true);
    });
    contextMenu(0);
    h.menus.show(TAB_ID);
    await settle(() => {
      expect(h.menus.entries.get(REGEN)?.enabled).toBe(false);
    });
    expect(h.menus.entries.get(NOT)?.enabled).toBe(true);
    expect(h.menus.refreshes).toBeGreaterThan(0);
  });

  it("ignores a click for another tab, and removes its entries when the page goes", async () => {
    const h = await mount({ script });
    await checkedAndCounted(h);
    await settle(() => {
      expect(h.menus.entries.size).toBe(2);
    });
    contextMenu(0);
    h.menus.choose(NOT, TAB_ID + 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(snippets()).toHaveLength(4);
    h.page.destroy();
    await settle(() => {
      expect(h.menus.entries.size).toBe(0);
    });
  });
});

describe("the Statistics dialog on the page (SPEC section 4.8)", () => {
  const dialog = () => byId("stats-dialog") as HTMLDialogElement;
  const rowsOf = () =>
    [...document.querySelectorAll("#stats-rows .stats-row")].map((tr) =>
      [...tr.querySelectorAll("td")].map((td) => td.textContent),
    );

  it("opens from the Stats button on the recorded mistakes", async () => {
    const h = await mount({ script: CHECKED });
    h.clock.set(Date.UTC(2026, 2, 5, 12));
    await checkedAndCounted(h);
    expect((byId("stats") as HTMLButtonElement).disabled).toBe(false);
    expect(dialog().open).toBe(false);
    click("stats");
    await settle(() => {
      expect(rowsOf()).toHaveLength(4);
    });
    expect(dialog().open).toBe(true);
    expect(text("stats-summary")).toBe("4 mistakes in all time. Most frequent: Collocation.");
    expect(rowsOf().map((r) => r.slice(0, 5))).toEqual([
      ["Collocation", "Vocabulary", "1", "1", "1"],
      ["Subject-verb agreement", "Grammar", "1", "1", "1"],
      ["Verb form", "Grammar", "1", "1", "1"],
      ["Word order", "Syntax", "1", "1", "1"],
    ]);
  });

  it("shows the token usage of the LLM, from the stored requests", async () => {
    const h = await mount({ script: CHECKED });
    await checkedAndCounted(h);
    click("stats");
    await settle(() => {
      expect(document.querySelectorAll("#usage-rows .usage-row")).toHaveLength(1);
    });
    expect(text("usage-rows")).toContain("Local");
    expect(text("usage-rows")).toContain("812 in / 164 out");
  });

  it("Reset statistics clears the badges and the header here, and announces it to the other tabs", async () => {
    const h = await mount({ script: CHECKED });
    await checkedAndCounted(h);
    rowClick(0);
    await settle(() => {
      expect(text("explain-header")).toContain("1 time");
    });
    click("stats");
    await settle(() => {
      expect(rowsOf()).toHaveLength(4);
    });
    h.channel.posted.length = 0;
    click("stats-reset");
    expect(byId("stats-reset-confirm").hidden).toBe(false);
    click("stats-reset-confirm-yes");
    await settle(() => {
      expect(rowsOf()).toEqual([]);
    });
    await settle(() => {
      expect(badges()).toEqual(["", "", "", ""]);
      expect(text("explain-header")).toBe("Verb form: no mistake of this type recorded yet");
    });
    expect(await allEvents(h)).toEqual([]);
    expect(h.channel.posted.map((m) => m.type)).toEqual(["stats-changed"]);
    expect(text("stats-summary")).toBe("No mistakes recorded yet.");
  });

  it("reloads an open dialog when another tab announces a change", async () => {
    const h = await mount({ script: CHECKED });
    await checkedAndCounted(h);
    click("stats");
    await settle(() => {
      expect(rowsOf()).toHaveLength(4);
    });
    await h.stats.resetMistakes();
    h.other.channel.post("stats-changed");
    await settle(() => {
      expect(rowsOf()).toEqual([]);
    });
  });

  it("a failing query shows its message in the dialog's own banner, not the page's", async () => {
    const h = await mount({ script: CHECKED });
    h.db.close();
    click("stats");
    await settle(() => {
      expect(byId("stats-banner").hidden).toBe(false);
    });
    expect(text("stats-banner")).toContain("could not be read");
    expect(byId("banner").hidden).toBe(true);
  });

  it("is closed with the page", async () => {
    const h = await mount({ script: slowReply(FOUR_ISSUES, 0, USAGE) });
    click("stats");
    await settle(() => {
      expect(dialog().open).toBe(true);
    });
    h.page.destroy();
    expect(document.getElementById("stats-dialog")).toBeNull();
    mounted = undefined;
  });
});
