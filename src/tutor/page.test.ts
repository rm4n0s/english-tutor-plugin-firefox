// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { issuesJson, reply, slowReply } from "../core/analysis/testing/helpers";
import type { FakeScript } from "../core/llm/testing/fake-fetch";
import { requestResult } from "../core/store/idb";
import {
  config,
  mountForTest,
  ORIGIN,
  type HarnessOptions,
  type TutorHarness,
} from "./testing/harness";

let mounted: TutorHarness | undefined;

afterEach(() => {
  mounted?.page.destroy();
  mounted = undefined;
});

async function mount(options: HarnessOptions = {}): Promise<TutorHarness> {
  mounted = await mountForTest(document, options);
  return mounted;
}

function byId(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`no element #${id}`);
  return found;
}

const select = () => byId("llm-select") as HTMLSelectElement;
const editor = () => byId("editor") as HTMLTextAreaElement;
const checkButton = () => byId("check") as HTMLButtonElement;
const text = (id: string) => byId(id).textContent;
const optionNames = () => [...select().options].map((option) => option.textContent);
const rowSnippets = () =>
  [...document.querySelectorAll(".issue-row .row-snippet")].map((e) => e.textContent);
const mirrorSpans = () =>
  [...document.querySelectorAll<HTMLElement>("#mirror span.issue")].map((s) => [
    s.textContent,
    s.className.split(" ")[1],
  ]);

function type(value: string): void {
  editor().value = value;
  editor().dispatchEvent(new Event("input", { bubbles: true }));
}
const click = (id: string) => byId(id).dispatchEvent(new MouseEvent("click", { bubbles: true }));
const keydown = (init: KeyboardEventInit) =>
  document.dispatchEvent(
    new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }),
  );

/** Waits until the page settles: the store and the fakes answer in a few turns. */
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

/** Types the text and presses Check, and waits for the result. */
async function checkText(h: TutorHarness, value = TEXT): Promise<void> {
  type(value);
  click("check");
  await settle(() => {
    expect(h.page.state.outcome).not.toBe("none");
    expect(h.page.state.pending).toBeNull();
  });
}

describe("the LLM selector", () => {
  it("is disabled with no LLM, Check too, and the panel asks for one", async () => {
    const h = await mount();
    expect(select().disabled).toBe(true);
    expect(optionNames()).toEqual(["No LLM configured"]);
    type(TEXT);
    expect(checkButton().disabled).toBe(true);
    expect(text("explanation")).toBe(
      "No LLM is configured. Add one in Preferences to start checking.",
    );
    byId("options-link").dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    expect(h.opened.options).toBe(1);
  });

  it.each([
    {
      name: "keeps the stored selection",
      configs: [config({ name: "Bravo" }), config({ name: "Alpha" }), config({ name: "Charlie" })],
      selected: 1,
      expectedName: "Bravo",
      stores: false,
    },
    {
      name: "selects the first by name when nothing is stored, and stores it",
      configs: [config({ name: "Bravo" }), config({ name: "Alpha" })],
      selected: null,
      expectedName: "Alpha",
      stores: true,
    },
    {
      name: "selects the first by name when the stored LLM does not exist, and stores it",
      configs: [config({ name: "Bravo" }), config({ name: "Alpha" })],
      selected: 99,
      expectedName: "Alpha",
      stores: true,
    },
  ])("$name", async ({ configs, selected, expectedName, stores }) => {
    const h = await mount({ configs, selected });
    expect(optionNames()).toEqual([...configs.map((c) => c.name)].sort());
    expect(select().disabled).toBe(false);
    expect(select().selectedOptions[0]?.textContent).toBe(expectedName);
    const storedId = await h.deps.store.getSetting("selected_llm_id");
    expect(String(storedId)).toBe(select().value);
    expect(h.channel.posted.map((m) => m.type)).toEqual(stores ? ["settings-changed"] : []);
    expect(text("explanation")).toContain("Select an error in the list");
  });

  it("remembers a choice and announces it", async () => {
    const h = await mount({
      configs: [config({ name: "Alpha" }), config({ name: "Bravo" })],
      selected: 1,
    });
    select().value = "2";
    select().dispatchEvent(new Event("change", { bubbles: true }));
    await settle(async () => {
      expect(await h.deps.store.getSetting("selected_llm_id")).toBe(2);
    });
    await settle(() => {
      expect(h.channel.posted.map((m) => m.type)).toEqual(["settings-changed"]);
    });
  });

  it("selects and stores the first LLM when one is added while the page is open", async () => {
    const h = await mount();
    await h.deps.store.createConfig(config({ name: "First" }));
    h.other.channel.post("configs-changed");
    await settle(() => {
      expect(select().disabled).toBe(false);
      expect(select().selectedOptions[0]?.textContent).toBe("First");
    });
    expect(await h.deps.store.getSetting("selected_llm_id")).toBe(1);
    expect(text("explanation")).toContain("Select an error in the list");
    type(TEXT);
    expect(checkButton().disabled).toBe(false);
  });

  it("follows a selection made in another tab", async () => {
    const h = await mount({
      configs: [config({ name: "Alpha" }), config({ name: "Bravo" })],
      selected: 1,
    });
    await h.deps.store.setSetting("selected_llm_id", 2);
    h.other.channel.post("settings-changed");
    await settle(() => {
      expect(select().selectedOptions[0]?.textContent).toBe("Bravo");
    });
  });

  it("drops to the no-LLM state when the last LLM is deleted", async () => {
    const h = await mount({ configs: [config()] });
    await h.deps.store.deleteConfig(1);
    h.other.channel.post("configs-changed");
    await settle(() => {
      expect(select().disabled).toBe(true);
    });
    type(TEXT);
    expect(checkButton().disabled).toBe(true);
  });
});

describe("Check", () => {
  const withLLM = (script: FakeScript = CHECKED) =>
    mount({ configs: [config()], selected: 1, script });

  it("is disabled until there is text, and white space does not count", async () => {
    await withLLM();
    expect(checkButton().disabled).toBe(true);
    type("   \n ");
    expect(checkButton().disabled).toBe(true);
    type("Hello");
    expect(checkButton().disabled).toBe(false);
    expect(checkButton().title).toBe("Check (Ctrl+Enter)");
  });

  it("is ready before the first check", async () => {
    await withLLM();
    type(TEXT);
    expect(text("status-state")).toBe("Ready");
    expect(text("issues-header")).toBe("Issues (0)");
    expect(text("issues")).toBe("Press Check to find errors");
    expect(text("status-words")).toBe("12 words");
    expect(text("status-tokens")).toBe("last: none · session: 0 in / 0 out");
  });

  it("underlines, lists and counts the issues of the reply", async () => {
    const h = await withLLM();
    await checkText(h);
    expect(mirrorSpans()).toEqual([
      ["I seen", "issue-grammar"],
      ["He go", "issue-grammar"],
      ["school", "issue-vocabulary"],
      ["I very like", "issue-syntax"],
    ]);
    expect(rowSnippets()).toEqual(["I seen", "He go", "school", "I very like"]);
    expect(text("issues-header")).toBe("Issues (4)");
    expect(text("status-state")).toBe("4 issues · 1 issue could not be placed");
    expect(editor().value).toBe(TEXT);
    expect(checkButton().textContent).toBe("Check");
  });

  it("shows the tokens of the check and of the session, and stores the usage", async () => {
    const h = await withLLM();
    await checkText(h);
    expect(text("status-tokens")).toBe("last: 812 in / 164 out · session: 812 in / 164 out");
    click("check");
    await settle(() => {
      expect(text("status-tokens")).toBe("last: 812 in / 164 out · session: 1.6k in / 328 out");
    });
    await settle(async () => {
      const rows = await requestResult(
        h.db.transaction("llm_usage").objectStore("llm_usage").getAll(),
      );
      expect(rows).toMatchObject([
        {
          llm_name: "Local",
          kind: "check",
          input_tokens: 812,
          output_tokens: 164,
          estimated: false,
        },
        { llm_name: "Local", kind: "check", input_tokens: 812, output_tokens: 164 },
      ]);
    });
  });

  it("marks estimated tokens with ~", async () => {
    const h = await withLLM(reply(FOUR_ISSUES));
    await checkText(h);
    expect(text("status-tokens")).toMatch(
      /^last: ~\d+ in \/ ~\d+ out · session: ~\d+ in \/ ~\d+ out$/,
    );
  });

  it("says No errors found for an empty result", async () => {
    const h = await withLLM(reply(issuesJson()));
    await checkText(h);
    expect(text("issues")).toBe("No errors found");
    expect(text("status-state")).toBe("No errors found");
    expect(text("issues-header")).toBe("Issues (0)");
    expect(mirrorSpans()).toEqual([]);
  });

  it("sends the text of the editor to the selected LLM", async () => {
    const h = await withLLM();
    await checkText(h);
    expect(h.fake.requests).toHaveLength(1);
    expect(JSON.stringify(h.fake.requests[0]?.body)).toContain("He go to school");
  });

  it("an edit drops the issues, so no underline sits under the wrong word", async () => {
    const h = await withLLM();
    await checkText(h);
    type(`Oh. ${TEXT}`);
    expect(mirrorSpans()).toEqual([]);
    expect(rowSnippets()).toEqual([]);
    expect(text("status-state")).toBe("Ready");
    expect(text("issues-header")).toBe("Issues (0)");
  });

  it("does nothing when pressed without text", async () => {
    const h = await withLLM();
    click("check");
    expect(h.fake.requests).toEqual([]);
  });
});

describe("the loading layer", () => {
  it("covers the editor during a manual check, makes it read-only, and goes with the result", async () => {
    const h = await mount({ configs: [config()], selected: 1, script: slowReply(FOUR_ISSUES, 30) });
    type(TEXT);
    click("check");
    expect(byId("loading").hidden).toBe(false);
    expect(editor().readOnly).toBe(true);
    expect(text("status-state")).toBe("Checking...");
    expect(text("issues")).toBe("Checking...");
    expect(checkButton().textContent).toBe("Cancel");
    expect(h.scheduler.pending).toBe(1);
    await settle(() => {
      expect(h.page.state.pending).toBeNull();
    });
    expect(byId("loading").hidden).toBe(true);
    expect(editor().readOnly).toBe(false);
    expect(checkButton().textContent).toBe("Check");
  });

  it("adds the notification line after 10 seconds", async () => {
    const h = await mount({ configs: [config()], selected: 1, script: slowReply(FOUR_ISSUES, 60) });
    type(TEXT);
    click("check");
    const notice = document.querySelector<HTMLElement>(".loading-notice");
    expect(notice?.hidden).toBe(true);
    h.scheduler.advance(10_000);
    expect(notice?.hidden).toBe(false);
    await settle(() => {
      expect(h.page.state.pending).toBeNull();
    });
    expect(byId("loading").hidden).toBe(true);
  });
});

describe("cancelling", () => {
  it("Cancel stops the check without an error, and the old issues stay", async () => {
    const h = await mount({
      configs: [config()],
      selected: 1,
      script: [reply(FOUR_ISSUES, USAGE), slowReply(FOUR_ISSUES, 5_000)],
    });
    await checkText(h);
    click("check");
    await settle(() => {
      expect(checkButton().textContent).toBe("Cancel");
      expect(h.fake.requests).toHaveLength(2);
    });
    click("check");
    await settle(() => {
      expect(h.page.state.pending).toBeNull();
    });
    expect(text("status-state")).toBe("Check cancelled");
    expect(byId("banner").hidden).toBe(true);
    expect(rowSnippets()).toHaveLength(4);
    expect(mirrorSpans()).toHaveLength(4);
    expect(byId("loading").hidden).toBe(true);
    expect(editor().readOnly).toBe(false);
    expect(h.logged.filter((l) => l.level === "error")).toEqual([]);
  });

  it("Ctrl+Enter checks, and Ctrl+Enter again cancels", async () => {
    const h = await mount({
      configs: [config()],
      selected: 1,
      script: slowReply(FOUR_ISSUES, 5_000),
    });
    type(TEXT);
    keydown({ key: "Enter", ctrlKey: true });
    expect(h.page.state.pending?.manual).toBe(true);
    keydown({ key: "Enter", ctrlKey: true });
    await settle(() => {
      expect(text("status-state")).toBe("Check cancelled");
    });
  });

  it.each([
    { name: "plain Enter", init: { key: "Enter" } },
    { name: "Ctrl+Shift+Enter", init: { key: "Enter", ctrlKey: true, shiftKey: true } },
    { name: "Ctrl+K", init: { key: "k", ctrlKey: true } },
  ])("$name does not check", async ({ init }) => {
    const h = await mount({ configs: [config()], selected: 1, script: CHECKED });
    type(TEXT);
    keydown(init);
    expect(h.page.state.pending).toBeNull();
    expect(h.fake.requests).toEqual([]);
  });
});

describe("a failed check", () => {
  it("shows the message in the banner, keeps the old issues and says Check failed", async () => {
    const h = await mount({
      configs: [config()],
      selected: 1,
      script: [
        reply(FOUR_ISSUES, USAGE),
        { kind: "json", status: 500, body: { error: { message: "The server is down" } } },
      ],
    });
    await checkText(h);
    click("check");
    await settle(() => {
      expect(byId("banner").hidden).toBe(false);
    });
    expect(byId("banner").textContent).toContain("HTTP 500");
    expect(text("status-state")).toBe("Check failed");
    expect(rowSnippets()).toHaveLength(4);
    expect(document.querySelector<HTMLElement>(".banner-action")?.hidden).toBe(true);
    expect(byId("loading").hidden).toBe(true);
  });

  it("is dismissed by the next check", async () => {
    await mount({
      configs: [config()],
      selected: 1,
      script: [{ kind: "json", status: 500, body: { error: { message: "down" } } }, CHECKED],
    });
    type(TEXT);
    click("check");
    await settle(() => {
      expect(byId("banner").hidden).toBe(false);
    });
    click("check");
    expect(byId("banner").hidden).toBe(true);
    await settle(() => {
      expect(text("status-state")).toContain("4 issues");
    });
  });

  it("without the host permission offers Grant access, which asks in the click", async () => {
    const h = await mount({ configs: [config()], selected: 1, script: CHECKED, granted: false });
    type(TEXT);
    click("check");
    await settle(() => {
      expect(byId("banner").hidden).toBe(false);
    });
    expect(byId("banner").textContent).toContain("has not been allowed");
    const grant = document.querySelector<HTMLButtonElement>(".banner-action");
    expect(grant?.hidden).toBe(false);
    expect(grant?.textContent).toBe("Grant access");
    expect(h.fake.requests).toEqual([]);
    h.permissions.calls.length = 0;

    grant?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    // The request is made in the turn of the click, before anything is awaited.
    expect(h.permissions.calls).toEqual([`request ${ORIGIN}`]);
    await settle(() => {
      expect(byId("banner").hidden).toBe(true);
    });

    click("check");
    await settle(() => {
      expect(text("status-state")).toContain("4 issues");
    });
  });

  it("keeps the banner and says so when access is refused", async () => {
    const h = await mount({ configs: [config()], selected: 1, script: CHECKED, granted: false });
    h.permissions.answer = "refuse";
    type(TEXT);
    click("check");
    await settle(() => {
      expect(byId("banner").hidden).toBe(false);
    });
    document
      .querySelector<HTMLButtonElement>(".banner-action")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle(() => {
      expect(byId("banner").textContent).toContain("Access was not granted");
    });
  });
});

describe("the legend", () => {
  it("hides and shows a category in the text and in the list", async () => {
    const h = await mount({ configs: [config()], selected: 1, script: CHECKED });
    await checkText(h);
    const item = document.querySelector<HTMLElement>('.legend-item[data-category="grammar"]');
    item?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(item?.getAttribute("aria-pressed")).toBe("false");
    expect(text("issues-header")).toBe("Issues (2 of 4 shown)");
    expect(rowSnippets()).toEqual(["school", "I very like"]);
    expect(mirrorSpans().map((s) => s[1])).toEqual(["issue-vocabulary", "issue-syntax"]);
    item?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(item?.getAttribute("aria-pressed")).toBe("true");
    expect(text("issues-header")).toBe("Issues (4)");
    expect(mirrorSpans()).toHaveLength(4);
  });

  it("selecting a row highlights its issue in the text", async () => {
    const h = await mount({ configs: [config()], selected: 1, script: CHECKED });
    await checkText(h);
    document
      .querySelectorAll(".issue-row")[2]
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(
      [...document.querySelectorAll("#mirror .issue-selected")].map((s) => s.textContent),
    ).toEqual(["school"]);
  });
});

describe("the Prefs button", () => {
  it("opens the options page", async () => {
    const h = await mount();
    click("prefs");
    expect(h.opened.options).toBe(1);
  });
});
