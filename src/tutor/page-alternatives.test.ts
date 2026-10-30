// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { reply, streamReply } from "../core/analysis/testing/helpers";
import type { FakeResponse, RecordedRequest } from "../core/llm/testing/fake-fetch";
import type { ErrorEvent } from "../core/store";
import { requestResult } from "../core/store/idb";
import {
  config,
  mountForTest,
  TAB_ID,
  type HarnessOptions,
  type TutorHarness,
} from "./testing/harness";
import { TEXT_CHANGED_WHILE_CHECKING } from "./page";
import { TEXT_CHANGED_NOTE } from "./alternatives-flow";

let mounted: TutorHarness | undefined;

afterEach(() => {
  mounted?.page.destroy();
  mounted = undefined;
  Reflect.deleteProperty(document, "execCommand");
});

const byId = (id: string): HTMLElement => {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`no element #${id}`);
  return found;
};
const editor = () => byId("editor") as HTMLTextAreaElement;
const rows = () => [...document.querySelectorAll<HTMLElement>(".issue-row")];
const snippets = () => rows().map((row) => row.querySelector(".row-snippet")?.textContent);
const underlined = () =>
  [...document.querySelectorAll("#mirror span.issue")].map((s) => s.textContent);
const click = (id: string) => byId(id).dispatchEvent(new MouseEvent("click", { bubbles: true }));
const rowClick = (index: number) =>
  rows()[index]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
const status = () => byId("status-state").textContent;

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

const ALT = `editor-alternative-${String(TAB_ID)}`;
const CHECK = `editor-check-${String(TAB_ID)}`;

const TEXT = "Yesterday I seen him. He go to school. I very like it.";
const FULL = JSON.stringify({
  issues: [
    { text: "I seen", error_type: "verb_form", message: "Use saw." },
    { text: "He go", error_type: "subject_verb_agreement", message: "Use goes." },
    { text: "school", error_type: "collocation", message: "Odd here." },
    { text: "I very like", error_type: "word_order", message: "Put very first." },
  ],
});

/** What the fake LLM answers, chosen by the test between requests. */
interface Replies {
  check: FakeResponse;
  alternatives: FakeResponse;
  explain: FakeResponse;
}

/** The same JSON reply, after a delay. */
function later(response: FakeResponse, delayMs: number): FakeResponse {
  if (response.kind !== "json") throw new TypeError("only a JSON reply can be delayed");
  return { ...response, delayMs };
}

function promptOf(request: RecordedRequest): { system: string; user: string } {
  const messages = request.body.messages as { role: string; content: string }[];
  return {
    system: messages.find((m) => m.role === "system")?.content ?? "",
    user: messages.find((m) => m.role === "user")?.content ?? "",
  };
}
const isAlternatives = (r: RecordedRequest) => promptOf(r).system.includes("writing coach");
const isExplain = (r: RecordedRequest) => promptOf(r).system.includes("patient English teacher");
const checks = (h: TutorHarness) =>
  h.fake.requests.filter((r) => !isAlternatives(r) && !isExplain(r));

const ALTS = JSON.stringify({ alternatives: ["He goes", "He is going"] });

function replies(): Replies {
  return {
    check: reply(FULL, { usage: { input: 812, output: 164 } }),
    alternatives: reply(ALTS, { usage: { input: 50, output: 10 } }),
    explain: streamReply(["### Why\n", "Because."], { usage: { input: 5, output: 5 } }),
  };
}

async function mount(r: Replies, options: HarnessOptions = {}): Promise<TutorHarness> {
  mounted = await mountForTest(document, {
    configs: [config()],
    selected: 1,
    ...options,
    script: (request) => {
      if (isAlternatives(request)) return r.alternatives;
      if (isExplain(request)) return r.explain;
      return r.check;
    },
  });
  return mounted;
}

function type(value: string): void {
  editor().value = value;
  editor().dispatchEvent(new Event("input", { bubbles: true }));
}

/** Types the text, selects `[start, end)` and presses Check. */
async function checked(h: TutorHarness, value = TEXT): Promise<void> {
  type(value);
  click("check");
  await settle(() => {
    expect(h.page.state.outcome).toBe("finished");
    expect(h.page.state.pending).toBeNull();
  });
}

function select(start: number, end: number, direction: "forward" | "backward" = "forward") {
  editor().setSelectionRange(start, end, direction);
}

/** The user right-clicks the editor and the browser shows the menu. */
async function openEditorMenu(h: TutorHarness): Promise<string[]> {
  editor().dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  h.menus.show(TAB_ID);
  await new Promise((resolve) => setTimeout(resolve, 10));
  return h.menus.visibleIds.filter((id) => id.startsWith("editor-"));
}

async function allEvents(h: TutorHarness): Promise<ErrorEvent[]> {
  return requestResult(
    h.db.transaction("error_events").objectStore("error_events").getAll(),
  ) as Promise<ErrorEvent[]>;
}
async function usageKinds(h: TutorHarness): Promise<string[]> {
  const found = (await requestResult(
    h.db.transaction("llm_usage").objectStore("llm_usage").getAll(),
  )) as { kind: string }[];
  return found.map((u) => u.kind);
}

const start = (text: string, part: string) => text.indexOf(part);
const selectPart = (part: string, text = TEXT) => {
  select(start(text, part), start(text, part) + part.length);
};

describe("the editor's menu entries (SPEC section 4.3)", () => {
  it.each([
    { name: "a word", selection: [0, 9] as const, expected: [ALT, CHECK] },
    { name: "nothing selected", selection: [3, 3] as const, expected: [] },
  ])("with $name the visible entries are $expected", async ({ selection, expected }) => {
    const h = await mount(replies());
    type(TEXT);
    select(selection[0], selection[1]);
    expect(await openEditorMenu(h)).toEqual(expected);
    expect(h.menus.lastShowDefaults).toBe(true);
  });

  it.each([
    { name: "spaces", value: "a    b", selection: [1, 4] as const },
    { name: "line breaks", value: "a\n\n\nb", selection: [1, 4] as const },
    { name: "spaces, a tab and line breaks", value: "a \t\n\r\n b", selection: [1, 6] as const },
  ])("shows nothing for a selection of only $name", async ({ value, selection }) => {
    const h = await mount(replies());
    type(value);
    select(selection[0], selection[1]);
    expect(await openEditorMenu(h)).toEqual([]);
  });

  it("hides the entries while a manual check runs (the loading layer is up)", async () => {
    const r = replies();
    r.check = { kind: "hang" };
    const h = await mount(r);
    type(TEXT);
    click("check");
    await settle(() => {
      expect(h.page.state.pending).not.toBeNull();
    });
    select(0, 9);
    expect(byId("loading").hidden).toBe(false);
    expect(await openEditorMenu(h)).toEqual([]);
    click("check"); // Cancel
    await settle(() => {
      expect(h.page.state.pending).toBeNull();
    });
    expect(await openEditorMenu(h)).toEqual([ALT, CHECK]);
  });

  it("still shows them during an auto-check (no layer)", async () => {
    const r = replies();
    r.check = { kind: "hang" };
    const h = await mount(r, { settings: { auto_check: true } });
    type(TEXT);
    h.scheduler.advance(3_000);
    await settle(() => {
      expect(h.page.state.pending).not.toBeNull();
    });
    select(0, 9);
    expect(await openEditorMenu(h)).toEqual([ALT, CHECK]);
  });

  it("disables Check, not Alternative, without an LLM", async () => {
    const h = await mount(replies());
    await h.deps.store.deleteConfig(1);
    h.other.channel.post("configs-changed");
    await settle(() => {
      expect((byId("llm-select") as HTMLSelectElement).disabled).toBe(true);
    });
    type(TEXT);
    select(0, 9);
    expect(await openEditorMenu(h)).toEqual([ALT, CHECK]);
    expect(h.menus.entries.get(CHECK)?.enabled).toBe(false);
    expect(h.menus.entries.get(ALT)?.enabled).toBe(true);
    h.menus.choose(CHECK, TAB_ID);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.fake.requests).toHaveLength(0);
  });

  it("leaves the menu of the issues list alone", async () => {
    const h = await mount(replies());
    await checked(h);
    document
      .getElementById("issues")
      ?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    expect(h.menus.overridden).toBe(0);
  });

  it("ignores a click chosen in another tab", async () => {
    const h = await mount(replies());
    type(TEXT);
    select(0, 9);
    await openEditorMenu(h);
    h.menus.choose(CHECK, TAB_ID + 1);
    h.menus.choose(ALT, TAB_ID + 1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.fake.requests).toHaveLength(0);
  });
});

describe("checking a selection (SPEC section 5.1)", () => {
  it("sends only the selection, shows the layer, and merges: inside replaced, outside kept", async () => {
    const r = replies();
    const h = await mount(r);
    await checked(h);
    const before = [...h.page.state.issues];
    expect(snippets()).toEqual(["I seen", "He go", "school", "I very like"]);

    // The selection holds "He go to school.": the model now finds one issue in it.
    r.check = reply(
      JSON.stringify({
        issues: [{ text: "to school", error_type: "preposition", message: "Say at school." }],
      }),
      { usage: { input: 30, output: 9 } },
    );
    selectPart("He go to school.");
    await openEditorMenu(h);
    h.menus.choose(CHECK, TAB_ID);
    await settle(() => {
      expect(snippets()).toEqual(["I seen", "to school", "I very like"]);
    });
    const sent = promptOf(checks(h).at(-1)!).user;
    expect(sent).toContain("He go to school.");
    expect(sent).not.toContain("Yesterday");
    expect(sent).not.toContain("I very like");
    expect(underlined()).toEqual(["I seen", "to school", "I very like"]);
    // The issues outside the selection are the very same ones.
    expect(h.page.state.issues[0]).toBe(before[0]);
    expect(h.page.state.issues[2]).toBe(before[3]);
    expect(h.page.state.issues[1]?.start).toBe(start(TEXT, "to school"));
    expect(status()).toBe("3 issues");
    expect(byId("banner").hidden).toBe(true);
  });

  it("records the new issues once: fingerprints equal a full check's, so nothing counts twice", async () => {
    const r = replies();
    const h = await mount(r);
    await checked(h);
    await settle(async () => {
      expect(await allEvents(h)).toHaveLength(4);
    });
    const fullFingerprints = new Set(h.page.state.issues.map((i) => i.fingerprint));
    // The selection check finds the same "He go" again, and nothing else.
    r.check = reply(
      JSON.stringify({
        issues: [{ text: "He go", error_type: "subject_verb_agreement", message: "Use goes." }],
      }),
    );
    selectPart("He go to school.");
    await openEditorMenu(h);
    h.channel.posted.length = 0;
    h.menus.choose(CHECK, TAB_ID);
    await settle(() => {
      expect(snippets()).toEqual(["I seen", "He go", "I very like"]);
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(await allEvents(h)).toHaveLength(4);
    expect(h.channel.posted.map((m) => m.type)).toEqual([]);
    const again = h.page.state.issues.find((i) => i.snippet === "He go");
    expect(fullFingerprints.has(again?.fingerprint ?? "")).toBe(true);
  });

  it("records a new issue of the selection, as a manual check does", async () => {
    const r = replies();
    const h = await mount(r);
    await checked(h);
    r.check = reply(
      JSON.stringify({
        issues: [{ text: "to school", error_type: "preposition", message: "Say at school." }],
      }),
    );
    selectPart("He go to school.");
    await openEditorMenu(h);
    h.menus.choose(CHECK, TAB_ID);
    await settle(async () => {
      expect((await allEvents(h)).map((e) => e.snippet)).toContain("to school");
    });
    await settle(() => {
      expect(rows()[1]?.querySelector(".count-badge")?.textContent).toBe("x1");
    });
  });

  it("counts the selection's not-placed issues, not the earlier ones", async () => {
    const r = replies();
    r.check = reply(
      JSON.stringify({
        issues: [
          { text: "I seen", error_type: "verb_form", message: "m" },
          { text: "nowhere", error_type: "article", message: "m" },
          { text: "nothing", error_type: "article", message: "m" },
        ],
      }),
    );
    const h = await mount(r);
    await checked(h);
    expect(status()).toBe("1 issue · 2 issues could not be placed");
    r.check = reply(
      JSON.stringify({ issues: [{ text: "gone", error_type: "article", message: "m" }] }),
    );
    selectPart("I very like it.");
    await openEditorMenu(h);
    h.menus.choose(CHECK, TAB_ID);
    await settle(() => {
      expect(status()).toBe("1 issue · 1 issue could not be placed");
    });
  });

  it.each([
    { name: "after an emoji", text: "😀 He go to school.", part: "He go" },
    { name: "after two emoji", text: "😀😀 He go home. 😀 I seen it.", part: "I seen" },
  ])("places the issues in UTF-16 units $name", async ({ text, part }) => {
    const r = replies();
    r.check = reply(
      JSON.stringify({ issues: [{ text: part, error_type: "verb_form", message: "m" }] }),
    );
    const h = await mount(r);
    type(text);
    selectPart(part, text);
    await openEditorMenu(h);
    h.menus.choose(CHECK, TAB_ID);
    await settle(() => {
      expect(h.page.state.issues).toHaveLength(1);
    });
    const issue = h.page.state.issues[0];
    expect(issue?.start).toBe(text.indexOf(part));
    expect(text.slice(issue?.start, issue?.end)).toBe(part);
    expect(promptOf(h.fake.requests[0]!).user).not.toContain("😀");
    expect(underlined()).toEqual([part]);
  });

  it("works for a backwards selection", async () => {
    const r = replies();
    r.check = reply(
      JSON.stringify({ issues: [{ text: "He go", error_type: "verb_form", message: "m" }] }),
    );
    const h = await mount(r);
    type(TEXT);
    const from = start(TEXT, "He go");
    select(from, from + "He go to school.".length, "backward");
    await openEditorMenu(h);
    h.menus.choose(CHECK, TAB_ID);
    await settle(() => {
      expect(snippets()).toEqual(["He go"]);
    });
    expect(JSON.stringify(h.fake.requests[0]?.body)).toContain("He go to school.");
  });

  it("reads the selection when the entry is chosen, not when the menu was shown", async () => {
    const r = replies();
    r.check = reply(
      JSON.stringify({ issues: [{ text: "school", error_type: "collocation", message: "m" }] }),
    );
    const h = await mount(r);
    type(TEXT);
    selectPart("Yesterday");
    await openEditorMenu(h);
    selectPart("He go to school.");
    h.menus.choose(CHECK, TAB_ID);
    await settle(() => {
      expect(snippets()).toEqual(["school"]);
    });
    expect(JSON.stringify(h.fake.requests[0]?.body)).toContain("He go to school.");
  });

  it("is a manual check: the layer shows, the editor is read-only, and Check turns into Cancel", async () => {
    const r = replies();
    const h = await mount(r);
    await checked(h);
    r.check = { kind: "hang" };
    selectPart("He go to school.");
    await openEditorMenu(h);
    h.menus.choose(CHECK, TAB_ID);
    await settle(() => {
      expect(byId("loading").hidden).toBe(false);
    });
    expect(editor().readOnly).toBe(true);
    expect(byId("check").textContent).toBe("Cancel");
    expect(status()).toBe("Checking...");
  });

  it("Cancel leaves the issues, the selection and the recorded mistakes as they were", async () => {
    const r = replies();
    const h = await mount(r);
    await checked(h);
    await settle(async () => {
      expect(await allEvents(h)).toHaveLength(4);
    });
    const issues = [...h.page.state.issues];
    r.check = { kind: "hang" };
    selectPart("He go to school.");
    await openEditorMenu(h);
    h.menus.choose(CHECK, TAB_ID);
    await settle(() => {
      expect(h.page.state.pending).not.toBeNull();
    });
    // The list stays usable while the layer is up.
    rowClick(0);
    click("check");
    await settle(() => {
      expect(h.page.state.pending).toBeNull();
    });
    expect(h.page.state.issues).toEqual(issues);
    expect(h.page.state.selectedId).toBe(issues[0]?.id);
    expect(byId("banner").hidden).toBe(true);
    expect(await allEvents(h)).toHaveLength(4);
    expect(editor().readOnly).toBe(false);
    expect(status()).toBe("Check cancelled");
  });

  it("discards the result and says so when an edit touched the selection", async () => {
    const r = replies();
    const h = await mount(r);
    await checked(h);
    const issues = [...h.page.state.issues];
    r.check = {
      kind: "json",
      body: reply(FULL).kind === "json" ? (reply(FULL) as { body: unknown }).body : {},
      delayMs: 60,
    };
    selectPart("He go to school.");
    await openEditorMenu(h);
    h.menus.choose(CHECK, TAB_ID);
    await settle(() => {
      expect(h.page.state.pending).not.toBeNull();
    });
    // The layer makes the editor read-only, but an edit can still arrive (a loaded text, a script).
    editor().readOnly = false;
    const middle = start(TEXT, "to school");
    type(`${TEXT.slice(0, middle)}X${TEXT.slice(middle)}`);
    await settle(() => {
      expect(h.page.state.pending).toBeNull();
    });
    expect(byId("banner").hidden).toBe(false);
    expect(byId("banner").textContent).toContain(TEXT_CHANGED_WHILE_CHECKING);
    // The old issues stay (except the one the edit touched), and nothing new was added.
    expect(h.page.state.issues.every((i) => issues.some((old) => old.id === i.id))).toBe(true);
    expect(await allEvents(h)).toHaveLength(4);
  });

  it("an edit before the selection does not discard it: the result is rebased", async () => {
    const r = replies();
    const h = await mount(r);
    await checked(h);
    r.check = {
      kind: "json",
      body: (
        reply(
          JSON.stringify({
            issues: [{ text: "to school", error_type: "preposition", message: "m" }],
          }),
        ) as { body: unknown }
      ).body,
      delayMs: 60,
    };
    selectPart("He go to school.");
    await openEditorMenu(h);
    h.menus.choose(CHECK, TAB_ID);
    await settle(() => {
      expect(h.page.state.pending).not.toBeNull();
    });
    editor().readOnly = false;
    type(`>> ${TEXT}`);
    await settle(() => {
      expect(h.page.state.pending).toBeNull();
    });
    expect(byId("banner").hidden).toBe(true);
    const shown = h.page.state.issues.find((i) => i.snippet === "to school");
    expect(shown).toBeDefined();
    expect(editor().value.slice(shown?.start, shown?.end)).toBe("to school");
  });
});

describe("explanations after a selection check", () => {
  // The caret rule (SPEC section 4.3) deselects an issue when the editor's selection moves, so an
  // issue is selected here from the list while the selection check runs.
  it("keeps the explanation of a selected issue outside the selection, and drops one inside", async () => {
    const r = replies();
    const h = await mount(r);
    await checked(h);
    const explains = () => h.fake.requests.filter(isExplain).length;
    r.check = later(reply(JSON.stringify({ issues: [] })), 60);
    selectPart("He go to school.");
    await openEditorMenu(h);
    h.menus.choose(CHECK, TAB_ID);
    rowClick(0); // "I seen", outside the selection
    await settle(() => {
      expect(byId("explain-panel").dataset.state).toBe("ready");
    });
    // (Selecting the text in the editor explained "He go" first, by the caret rule.)
    const asked = explains();
    await settle(() => {
      expect(snippets()).toEqual(["I seen", "I very like"]);
    });
    expect(h.page.state.selected?.snippet).toBe("I seen");
    expect(byId("explain-panel").dataset.state).toBe("ready");
    expect(explains()).toBe(asked);

    // A selected issue inside the selection goes with its explanation.
    selectPart("I very like it.");
    await openEditorMenu(h);
    h.menus.choose(CHECK, TAB_ID);
    rowClick(1); // "I very like"
    await settle(() => {
      expect(byId("explain-panel").dataset.state).toBe("ready");
    });
    await settle(() => {
      expect(snippets()).toEqual(["I seen"]);
    });
    expect(h.page.state.selectedId).toBeNull();
    expect(document.getElementById("explain-panel")).toBeNull(); // the idle hint
  });
});

describe("the Alternatives panel on the page (SPEC section 4.6)", () => {
  const panel = () => byId("alternatives");
  const altRows = () => [...document.querySelectorAll(".alt-row")].map((r) => r.textContent);

  async function askAlternatives(h: TutorHarness, part = "He go"): Promise<void> {
    selectPart(part);
    await openEditorMenu(h);
    h.menus.choose(ALT, TAB_ID);
  }

  it("opens loading, then ready with the alternatives, and records usage as alternatives only", async () => {
    const h = await mount(replies());
    type(TEXT);
    await askAlternatives(h);
    expect(panel().dataset.state).toBe("loading");
    expect(byId("alt-selected").textContent).toBe("He go");
    await settle(() => {
      expect(panel().dataset.state).toBe("ready");
    });
    expect(altRows()).toEqual(["He goes", "He is going"]);
    await settle(async () => {
      expect(await usageKinds(h)).toEqual(["alternatives"]);
    });
    // The panel never touches the statistics.
    expect(await allEvents(h)).toEqual([]);
    expect(h.channel.posted).toEqual([]);
    expect(byId("status-tokens").textContent).toContain("session: 50 in / 10 out");
  });

  it("shows a failure with Retry", async () => {
    const r = replies();
    r.alternatives = { kind: "json", status: 500, body: { error: { message: "down" } } };
    const h = await mount(r);
    type(TEXT);
    await askAlternatives(h);
    await settle(() => {
      expect(panel().dataset.state).toBe("failed");
    });
    expect(byId("alt-state").textContent).toBe("Could not get alternatives.");
    expect(byId("alt-error").textContent).toContain("HTTP 500");
    r.alternatives = reply(ALTS);
    click("alt-retry");
    await settle(() => {
      expect(panel().dataset.state).toBe("ready");
    });
  });

  it("fails with a message for a selection over 600 words, without a request", async () => {
    const h = await mount(replies());
    type("word ".repeat(700));
    select(0, 5 * 700);
    await openEditorMenu(h);
    h.menus.choose(ALT, TAB_ID);
    await settle(() => {
      expect(panel().dataset.state).toBe("failed");
    });
    expect(byId("alt-error").textContent).toContain("700 words");
    expect(h.fake.requests).toHaveLength(0);
  });

  it("says there is no LLM in the failed state", async () => {
    const h = await mount(replies());
    await h.deps.store.deleteConfig(1);
    h.other.channel.post("configs-changed");
    await settle(() => {
      expect((byId("llm-select") as HTMLSelectElement).disabled).toBe(true);
    });
    type(TEXT);
    await askAlternatives(h);
    expect(panel().dataset.state).toBe("failed");
    expect(byId("alt-error").textContent).toContain("No LLM is configured");
  });

  it("a double click replaces the range through execCommand as one edit, and the issues are rebased", async () => {
    const h = await mount(replies());
    await checked(h);
    const calls: string[] = [];
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: (command: string, _ui: boolean, value: string) => {
        calls.push(`${command}:${value}`);
        const { selectionStart: a, selectionEnd: b } = editor();
        editor().setRangeText(value, a, b, "end");
        editor().dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
        return true;
      },
    });
    await askAlternatives(h, "He go");
    await settle(() => {
      expect(panel().dataset.state).toBe("ready");
    });
    document
      .querySelector(".alt-row")
      ?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(calls).toEqual(["insertText:He goes"]);
    expect(editor().value).toBe("Yesterday I seen him. He goes to school. I very like it.");
    expect(editor().selectionStart).toBe(start(TEXT, "He go") + "He goes".length);
    expect(document.activeElement).toBe(editor());
    expect(panel().hidden).toBe(true);
    // The edit touched "He go" (gone), and moved "school" and "I very like" by two units.
    await settle(() => {
      expect(snippets()).toEqual(["I seen", "school", "I very like"]);
    });
    const school = h.page.state.issues.find((i) => i.snippet === "school");
    expect(editor().value.slice(school?.start, school?.end)).toBe("school");
  });

  it("changes nothing and says so when the text at the range changed", async () => {
    const h = await mount(replies());
    type(TEXT);
    await askAlternatives(h, "He go");
    await settle(() => {
      expect(panel().dataset.state).toBe("ready");
    });
    type(TEXT.replace("He go", "She go"));
    const before = editor().value;
    document
      .querySelector(".alt-row")
      ?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(editor().value).toBe(before);
    expect(panel().hidden).toBe(false);
    expect(byId("alt-note").textContent).toBe(TEXT_CHANGED_NOTE);
    expect(altRows()).toEqual(["He goes", "He is going"]);
  });

  it("Copy puts the current row on the clipboard", async () => {
    const h = await mount(replies());
    type(TEXT);
    await askAlternatives(h);
    await settle(() => {
      expect(panel().dataset.state).toBe("ready");
    });
    document
      .querySelectorAll(".alt-row")[1]
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    click("alt-copy");
    await settle(() => {
      expect(h.clipboard.written).toEqual(["He is going"]);
    });
  });

  it.each([
    { name: "Close", close: () => click("alt-close") },
    {
      name: "Escape in the editor",
      close: () =>
        editor().dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
        ),
    },
    {
      name: "Escape in the panel",
      close: () =>
        byId("alt-list").dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
        ),
    },
  ])(
    "$name closes the panel and cancels the running request without an error",
    async ({ close }) => {
      const r = replies();
      r.alternatives = { kind: "hang" };
      const h = await mount(r);
      type(TEXT);
      await askAlternatives(h);
      expect(panel().dataset.state).toBe("loading");
      close();
      expect(panel().hidden).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(panel().hidden).toBe(true);
      expect(byId("banner").hidden).toBe(true);
      expect(h.logged.filter((l) => l.level === "error")).toEqual([]);
    },
  );

  it("asking again replaces the panel and cancels the earlier request", async () => {
    const r = replies();
    r.alternatives = { kind: "hang" };
    const h = await mount(r);
    type(TEXT);
    await askAlternatives(h, "He go");
    r.alternatives = reply(JSON.stringify({ alternatives: ["Very much I like it"] }));
    await askAlternatives(h, "I very like");
    await settle(() => {
      expect(panel().dataset.state).toBe("ready");
    });
    expect(byId("alt-selected").textContent).toBe("I very like");
    expect(altRows()).toEqual(["Very much I like it"]);
    expect(document.querySelectorAll("#alternatives")).toHaveLength(1);
  });

  it("stays usable while an explanation or a check is shown, and the panel does not hide the editor's text", async () => {
    const h = await mount(replies());
    await checked(h);
    await askAlternatives(h, "He go");
    await settle(() => {
      expect(panel().dataset.state).toBe("ready");
    });
    expect(editor().value).toBe(TEXT);
    expect(underlined()).toHaveLength(4);
  });
});
