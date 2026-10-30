// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { reply, slowReply } from "../core/analysis/testing/helpers";
import { parseSavedTab, serialiseSavedTab, type SavedTab } from "../core/files";
import type { ErrorEvent } from "../core/store";
import { requestResult } from "../core/store/idb";
import { config, mountForTest, type HarnessOptions, type TutorHarness } from "./testing/harness";
import { FLASH_MS } from "./status-bar";
import { PERSIST_DELAY_MS } from "./tab-persistence";

let mounted: TutorHarness | undefined;

afterEach(() => {
  mounted?.page.destroy();
  mounted = undefined;
  document.title = "";
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
const button = (id: string) => byId(id) as HTMLButtonElement;
const rows = () => [...document.querySelectorAll<HTMLElement>(".issue-row")];
const underlined = () =>
  [...document.querySelectorAll("#mirror span.issue")].map((s) => s.textContent);
/** Clicks a button of a row of the Library dialog (the first row by default). */
const clickRow = (selector: string, index = 0): void => {
  const found = document.querySelectorAll<HTMLElement>(selector)[index];
  if (found === undefined) throw new Error(`no ${selector} at ${String(index)}`);
  found.click();
};
const dialogOpen = (id: string) => (document.getElementById(id) as HTMLDialogElement).open;

function type(value: string): void {
  editor().value = value;
  editor().dispatchEvent(new Event("input", { bubbles: true }));
}
const click = (id: string) => byId(id).dispatchEvent(new MouseEvent("click", { bubbles: true }));
const keydown = (init: KeyboardEventInit) => {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  document.dispatchEvent(event);
  return event;
};

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

/** Chooses a file in the hidden file input, as the browser's file chooser does. */
function chooseFile(name: string, content: string | Uint8Array): void {
  const input = byId("file-input") as HTMLInputElement;
  const file = new File([content as BlobPart], name, { type: "text/plain" });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

const TEXT = "Yesterday I seen him. He go to school. I very like it.";
const THREE_ISSUES = JSON.stringify({
  issues: [
    { text: "I seen", error_type: "verb_form", message: "Use saw." },
    { text: "He go", error_type: "subject_verb_agreement", message: "Use goes." },
    { text: "I very like", error_type: "word_order", message: "Put very first." },
  ],
});
const CHECKED = reply(THREE_ISSUES, { usage: { input: 10, output: 5 } });

async function allEvents(h: TutorHarness): Promise<ErrorEvent[]> {
  return requestResult(
    h.db.transaction("error_events").objectStore("error_events").getAll(),
  ) as Promise<ErrorEvent[]>;
}

async function checked(h: TutorHarness, value = TEXT): Promise<void> {
  type(value);
  click("check");
  await settle(() => {
    expect(h.page.state.outcome).toBe("finished");
    expect(h.page.state.pending).toBeNull();
  });
  await settle(async () => {
    expect((await allEvents(h)).length).toBeGreaterThan(0);
  });
}

describe("the toolbar", () => {
  it.each([
    { id: "new", empty: false, typed: false },
    { id: "clear", empty: false, typed: false },
    { id: "open", empty: false, typed: false },
    { id: "library", empty: false, typed: false },
    { id: "save", empty: true, typed: false },
    { id: "save-as", empty: true, typed: false },
    { id: "save-to-library", empty: true, typed: false },
    { id: "copy", empty: true, typed: false },
  ])("$id is disabled for an empty text: $empty", async ({ id, empty }) => {
    await mount();
    expect(button(id).disabled).toBe(empty);
    type("Hello");
    expect(button(id).disabled).toBe(false);
    type("");
    expect(button(id).disabled).toBe(empty);
  });

  it("Save, Save As and Save to library stay disabled for white space, Copy does not", async () => {
    await mount();
    type("  \n ");
    expect(["save", "save-as", "save-to-library", "copy"].map((id) => button(id).disabled)).toEqual(
      [true, true, true, false],
    );
  });
});

describe("Copy", () => {
  it("copies the whole text and the status bar says Copied for a moment", async () => {
    const h = await mount();
    type("Line one\nLine two");
    click("copy");
    await settle(() => {
      expect(text("status-state")).toBe("Copied");
    });
    expect(h.clipboard.written).toEqual(["Line one\nLine two"]);
    h.scheduler.advance(FLASH_MS);
    expect(text("status-state")).toBe("Ready");
  });

  it("shows ClipboardWriteFailed in the banner and never says Copied", async () => {
    const h = await mount();
    type("x");
    h.clipboard.failWith = new Error("denied");
    click("copy");
    await settle(() => {
      expect(byId("banner").hidden).toBe(false);
    });
    expect(text("status-state")).toBe("Ready");
  });
});

describe("New and Clear", () => {
  it.each([
    { id: "new", choose: "unsaved-discard", result: "" },
    { id: "clear", choose: "unsaved-discard", result: "" },
    { id: "new", choose: "unsaved-cancel", result: "Some text" },
    { id: "clear", choose: "unsaved-cancel", result: "Some text" },
  ])("$id with unsaved changes, answered with $choose", async ({ id, choose, result }) => {
    const h = await mount();
    const before = h.page.source.key;
    type("Some text");
    click(id);
    await settle(() => {
      expect(dialogOpen("unsaved-dialog")).toBe(true);
    });
    expect(text("unsaved-message")).toBe("This text has changes that are not saved.");
    click(choose);
    await settle(() => {
      expect(dialogOpen("unsaved-dialog")).toBe(false);
      expect(editor().value).toBe(result);
    });
    expect(h.page.source.key === before).toBe(result !== "");
    expect(document.title).toBe(
      result === "" ? "Untitled – English Tutor" : "Untitled* – English Tutor",
    );
  });

  it("starts at once when nothing is unsaved", async () => {
    const h = await mount();
    type("Some text");
    h.page.tabText.saved();
    click("new");
    await settle(() => {
      expect(editor().value).toBe("");
    });
    expect(dialogOpen("unsaved-dialog")).toBe(false);
    expect(h.downloads.requests).toEqual([]);
  });

  it("Save in the dialog downloads a named text and then clears it", async () => {
    const h = await mount();
    chooseFile("essay.txt", "Hello");
    await settle(() => {
      expect(editor().value).toBe("Hello");
    });
    type("Hello again");
    click("new");
    await settle(() => {
      expect(dialogOpen("unsaved-dialog")).toBe(true);
    });
    expect(text("unsaved-message")).toBe("“essay” has changes that are not saved.");
    expect(text("unsaved-hint")).toBe("Save downloads the text as a file.");
    click("unsaved-save");
    await settle(() => {
      expect(editor().value).toBe("");
    });
    expect(h.downloads.requests).toEqual([
      { text: "Hello again", filename: "essay.txt", saveAs: false },
    ]);
  });

  it("a Save that fails keeps the text, shows the error, and does not clear", async () => {
    const h = await mount();
    h.downloads.outcomes = [{ kind: "failed" }];
    type("Some text");
    click("new");
    await settle(() => {
      expect(dialogOpen("unsaved-dialog")).toBe(true);
    });
    click("unsaved-save");
    await settle(() => {
      expect(byId("banner").hidden).toBe(false);
    });
    expect(editor().value).toBe("Some text");
    expect(text("banner")).toContain("could not write the file");
  });

  it("clears the issues, the underlines and the status, and starts no auto-check", async () => {
    const h = await mount({
      script: CHECKED,
      settings: { auto_check: true },
    });
    await checked(h);
    expect(rows()).toHaveLength(3);
    h.page.tabText.saved();
    const requests = h.fake.requests.length;
    click("new");
    await settle(() => {
      expect(editor().value).toBe("");
    });
    expect(rows()).toHaveLength(0);
    expect(underlined()).toEqual([]);
    expect(text("status-state")).toBe("Ready");
    expect(text("status-words")).toBe("0 words");
    expect(h.page.state.checkId).toBe(0);
    h.scheduler.advance(60_000);
    expect(h.fake.requests).toHaveLength(requests);
  });

  it("cancels a running check, and its late result is not applied", async () => {
    const h = await mount({ script: slowReply(THREE_ISSUES, 30) });
    type(TEXT);
    click("check");
    expect(h.page.state.pending).not.toBeNull();
    click("new");
    await settle(() => {
      expect(dialogOpen("unsaved-dialog")).toBe(true);
    });
    click("unsaved-discard");
    await settle(() => {
      expect(editor().value).toBe("");
    });
    expect(h.page.state.pending).toBeNull();
    expect(byId("loading").hidden).toBe(true);
    expect(editor().readOnly).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(rows()).toHaveLength(0);
    expect(text("status-state")).toBe("Ready");
  });
});

describe("Open", () => {
  it("opens a file: its text, its name in the title, no unsaved changes", async () => {
    const h = await mount();
    const before = h.page.source.key;
    chooseFile("My essay.md", "Hello there.\nSecond line.");
    await settle(() => {
      expect(editor().value).toBe("Hello there.\nSecond line.");
    });
    expect(document.title).toBe("My essay – English Tutor");
    expect(h.page.tabText.lineEnding).toBe("lf");
    expect(h.page.hasUnsavedChanges()).toBe(false);
    expect(h.page.source.key).not.toBe(before);
    expect(h.page.source.key.startsWith("session:")).toBe(true);
    expect(text("status-words")).toBe("4 words");
    expect(button("save").disabled).toBe(false);
  });

  it("the file input accepts text and markdown, and can choose the same file twice", async () => {
    await mount();
    const input = byId("file-input") as HTMLInputElement;
    expect(input.getAttribute("accept")).toBe(".txt,.md,text/plain,text/markdown");
    expect(input.hidden).toBe(true);
    chooseFile("a.txt", "one");
    await settle(() => {
      expect(editor().value).toBe("one");
    });
    expect(input.value).toBe("");
  });

  it("the Open button opens the chooser", async () => {
    await mount();
    const input = byId("file-input") as HTMLInputElement;
    let clicks = 0;
    input.addEventListener("click", () => clicks++);
    click("open");
    expect(clicks).toBe(1);
  });

  it("remembers CRLF and writes it back on Save", async () => {
    const h = await mount();
    chooseFile("windows.txt", "a\r\nb\r\n");
    await settle(() => {
      expect(editor().value).toBe("a\nb\n");
    });
    expect(h.page.tabText.lineEnding).toBe("crlf");
    click("save");
    await settle(() => {
      expect(h.downloads.requests).toHaveLength(1);
    });
    expect(h.downloads.requests[0]).toEqual({
      text: "a\r\nb\r\n",
      filename: "windows.txt",
      saveAs: false,
    });
  });

  it("drops a BOM", async () => {
    await mount();
    chooseFile("bom.txt", Uint8Array.from([0xef, 0xbb, 0xbf, 0x48, 0x69]));
    await settle(() => {
      expect(editor().value).toBe("Hi");
    });
  });

  it.each([
    {
      name: "not UTF-8",
      file: Uint8Array.from([0x63, 0x61, 0x66, 0xe9]),
      message: "not valid UTF-8",
    },
    { name: "a NUL byte", file: Uint8Array.from([0x61, 0, 0x62]), message: "NUL byte" },
  ])(
    "a file with $name shows the banner and leaves the text, without asking",
    async ({ file, message }) => {
      const h = await mount();
      type("Keep this");
      chooseFile("bad.txt", file);
      await settle(() => {
        expect(byId("banner").hidden).toBe(false);
      });
      expect(text("banner")).toContain(message);
      expect(editor().value).toBe("Keep this");
      expect(dialogOpen("unsaved-dialog")).toBe(false);
      expect(document.title).toBe("Untitled* – English Tutor");
      expect(h.page.tabText.name).toBeUndefined();
      expect(h.logged.some((l) => l.level === "error")).toBe(true);
      expect(JSON.stringify(h.logged)).not.toContain("Keep this");
    },
  );

  it("asks about unsaved changes only after a good read, and Cancel keeps the text", async () => {
    const h = await mount();
    type("Keep this");
    chooseFile("good.txt", "New");
    await settle(() => {
      expect(dialogOpen("unsaved-dialog")).toBe(true);
    });
    expect(editor().value).toBe("Keep this");
    click("unsaved-cancel");
    await settle(() => {
      expect(dialogOpen("unsaved-dialog")).toBe(false);
      expect(h.page.saving.isBusy).toBe(false);
    });
    expect(editor().value).toBe("Keep this");
    chooseFile("good.txt", "New");
    await settle(() => {
      expect(dialogOpen("unsaved-dialog")).toBe(true);
    });
    click("unsaved-discard");
    await settle(() => {
      expect(editor().value).toBe("New");
    });
  });

  it("hides an old banner when a text is loaded", async () => {
    await mount();
    chooseFile("bad.txt", Uint8Array.from([0xff]));
    await settle(() => {
      expect(byId("banner").hidden).toBe(false);
    });
    chooseFile("good.txt", "fine");
    await settle(() => {
      expect(editor().value).toBe("fine");
    });
    expect(byId("banner").hidden).toBe(true);
  });
});

describe("Save and Save As", () => {
  it("Save downloads a named text; the text is saved and the title loses its star", async () => {
    const h = await mount();
    chooseFile("essay.txt", "Hello");
    await settle(() => {
      expect(editor().value).toBe("Hello");
    });
    type("Hello, world");
    expect(document.title).toBe("essay* – English Tutor");
    click("save");
    await settle(() => {
      expect(document.title).toBe("essay – English Tutor");
    });
    expect(h.downloads.requests).toEqual([
      { text: "Hello, world", filename: "essay.txt", saveAs: false },
    ]);
  });

  it("Save of a text without a name asks for the browser's dialog, and takes the name typed there", async () => {
    const h = await mount();
    h.downloads.outcomes = [{ kind: "saved", path: "/home/me/Downloads/My letter.txt" }];
    type("Dear Sir\nI write to you.");
    click("save");
    await settle(() => {
      expect(document.title).toBe("My letter – English Tutor");
    });
    expect(h.downloads.requests).toEqual([
      { text: "Dear Sir\nI write to you.", filename: "Dear Sir.txt", saveAs: true },
    ]);
  });

  it("Save As always asks for the dialog; cancelling it is not an error", async () => {
    const h = await mount();
    h.downloads.outcomes = [{ kind: "cancelled" }];
    type("Hello");
    click("save-as");
    await settle(() => {
      expect(h.downloads.requests).toHaveLength(1);
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.downloads.requests[0]?.saveAs).toBe(true);
    expect(byId("banner").hidden).toBe(true);
    expect(document.title).toBe("Untitled* – English Tutor");
  });

  it("a failed download shows FileWriteFailed in the banner and keeps the star", async () => {
    const h = await mount();
    h.downloads.outcomes = [{ kind: "failed" }];
    type("Hello");
    click("save-as");
    await settle(() => {
      expect(byId("banner").hidden).toBe(false);
    });
    expect(document.title).toBe("Untitled* – English Tutor");
    expect(h.logged.some((l) => l.level === "error")).toBe(true);
  });

  it.each([
    { name: "Ctrl+S", init: { key: "s", ctrlKey: true }, saveAs: false },
    { name: "Ctrl+Shift+S", init: { key: "S", ctrlKey: true, shiftKey: true }, saveAs: true },
    { name: "Cmd+S", init: { key: "s", metaKey: true }, saveAs: false },
  ])("$name presses Save or Save As and not the browser's Save Page", async ({ init, saveAs }) => {
    const h = await mount();
    chooseFile("named.txt", "x");
    await settle(() => {
      expect(editor().value).toBe("x");
    });
    const event = keydown(init);
    expect(event.defaultPrevented).toBe(true);
    await settle(() => {
      expect(h.downloads.requests).toHaveLength(1);
    });
    expect(h.downloads.requests[0]?.saveAs).toBe(saveAs);
  });

  it("Ctrl+S with an empty text is swallowed and does nothing", async () => {
    const h = await mount();
    const event = keydown({ key: "s", ctrlKey: true });
    expect(event.defaultPrevented).toBe(true);
    expect(h.downloads.requests).toEqual([]);
  });

  it("Ctrl+S does nothing while a dialog is open", async () => {
    const h = await mount();
    type("Hello");
    click("new");
    await settle(() => {
      expect(dialogOpen("unsaved-dialog")).toBe(true);
    });
    keydown({ key: "s", ctrlKey: true });
    expect(h.downloads.requests).toEqual([]);
  });

  it("the buttons name their shortcut", async () => {
    await mount();
    expect(button("save").title).toContain("Ctrl+S");
    expect(button("save-as").title).toContain("Ctrl+Shift+S");
  });
});

describe("Save to library and the Library dialog", () => {
  async function saveToLibrary(h: TutorHarness, value: string, title?: string): Promise<void> {
    type(value);
    click("save-to-library");
    await settle(() => {
      expect(dialogOpen("title-dialog")).toBe(true);
    });
    if (title !== undefined) (byId("title-input") as HTMLInputElement).value = title;
    byId("title-form").dispatchEvent(new Event("submit", { cancelable: true }));
    await settle(() => {
      expect(dialogOpen("title-dialog")).toBe(false);
      expect(h.page.tabText.documentId).toBeDefined();
    });
  }

  it("asks for the title with the first line as the default", async () => {
    await mount();
    type(`${"word ".repeat(30)}\nsecond line`);
    click("save-to-library");
    await settle(() => {
      expect(dialogOpen("title-dialog")).toBe(true);
    });
    expect((byId("title-input") as HTMLInputElement).value).toBe("word ".repeat(12).trimEnd());
    expect(text("title-heading")).toBe("Save to library");
  });

  it("stores the document, titles the tab, moves the source, and tells the other tabs", async () => {
    const h = await mount();
    await saveToLibrary(h, "Dear Sir, hello.", "My letter");
    const [doc] = await h.deps.store.listDocuments();
    expect(doc).toMatchObject({
      title: "My letter",
      content: "Dear Sir, hello.",
      line_ending: "lf",
    });
    expect(document.title).toBe("My letter – English Tutor");
    expect(h.page.source.key).toBe(`doc:${String(doc?.id)}`);
    expect(h.other.received).toEqual(expect.arrayContaining(["library-changed", "stats-changed"]));
    expect(h.page.hasUnsavedChanges()).toBe(false);
  });

  it("cancelling the title dialog stores nothing", async () => {
    const h = await mount();
    type("Hello");
    click("save-to-library");
    await settle(() => {
      expect(dialogOpen("title-dialog")).toBe(true);
    });
    click("title-cancel");
    await settle(() => {
      expect(dialogOpen("title-dialog")).toBe(false);
    });
    expect(await h.deps.store.listDocuments()).toEqual([]);
    expect(document.title).toBe("Untitled* – English Tutor");
  });

  it("checking a saved text again counts nothing twice", async () => {
    const h = await mount({ script: CHECKED });
    await checked(h);
    const first = await allEvents(h);
    expect(first).toHaveLength(3);
    expect(new Set(first.map((e) => e.source_key))).toEqual(new Set([h.page.source.key]));
    await saveToLibrary(h, TEXT, "Checked text");
    await settle(async () => {
      expect(new Set((await allEvents(h)).map((e) => e.source_key))).toEqual(
        new Set([h.page.source.key]),
      );
    });
    expect(h.page.source.key.startsWith("doc:")).toBe(true);
    // The same text, checked again under the document's source.
    click("check");
    await settle(() => {
      expect(h.fake.requests.length).toBe(2);
      expect(h.page.state.pending).toBeNull();
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const after = await allEvents(h);
    expect(after).toHaveLength(3);
    expect(new Set(after.map((e) => e.source_key))).toEqual(new Set([h.page.source.key]));
  });

  it("the Library dialog lists the documents, newest update first", async () => {
    const h = await mount({
      documents: [
        { title: "Older", content: "one two", line_ending: "lf" },
        { title: "Newer", content: "three", line_ending: "crlf" },
      ],
    });
    h.clock.advance(1000);
    await h.deps.store.renameDocument(1, "Older renamed");
    click("library");
    await settle(() => {
      expect(dialogOpen("library-dialog")).toBe(true);
      expect(document.querySelectorAll(".library-row")).toHaveLength(2);
    });
    expect([...document.querySelectorAll(".library-title")].map((e) => e.textContent)).toEqual([
      "Older renamed",
      "Newer",
    ]);
  });

  it("Open loads the document with its title, line ending and source", async () => {
    const h = await mount({
      documents: [{ title: "Stored", content: "a\r\nb", line_ending: "crlf" }],
    });
    click("library");
    await settle(() => {
      expect(document.querySelectorAll(".library-row")).toHaveLength(1);
    });
    clickRow(".library-open");
    await settle(() => {
      expect(editor().value).toBe("a\r\nb");
    });
    expect(dialogOpen("library-dialog")).toBe(false);
    expect(document.title).toBe("Stored – English Tutor");
    expect(h.page.source.key).toBe("doc:1");
    expect(h.page.tabText.lineEnding).toBe("crlf");
    expect(h.page.tabText.documentId).toBe(1);
  });

  it("Open with unsaved changes asks first; Cancel keeps the text and the Library dialog open", async () => {
    const h = await mount({
      documents: [{ title: "Stored", content: "stored text", line_ending: "lf" }],
    });
    type("my unsaved text");
    click("library");
    await settle(() => {
      expect(document.querySelectorAll(".library-row")).toHaveLength(1);
    });
    clickRow(".library-open");
    await settle(() => {
      expect(dialogOpen("unsaved-dialog")).toBe(true);
    });
    click("unsaved-cancel");
    await settle(() => {
      expect(dialogOpen("unsaved-dialog")).toBe(false);
    });
    expect(editor().value).toBe("my unsaved text");
    expect(dialogOpen("library-dialog")).toBe(true);
    expect(h.page.tabText.documentId).toBeUndefined();
  });

  it("Save in the unsaved dialog for a library text updates the document without a title dialog", async () => {
    const h = await mount({
      documents: [
        { title: "Open one", content: "first", line_ending: "lf" },
        { title: "Other", content: "second", line_ending: "lf" },
      ],
    });
    click("library");
    await settle(() => {
      expect(document.querySelectorAll(".library-row")).toHaveLength(2);
    });
    // Rows are listed newest update first: "Other" is first, "Open one" second.
    clickRow(".library-open", 1);
    await settle(() => {
      expect(editor().value).toBe("first");
    });
    type("first, edited");
    expect(document.title).toBe("Open one* – English Tutor");
    click("new");
    await settle(() => {
      expect(dialogOpen("unsaved-dialog")).toBe(true);
    });
    expect(text("unsaved-hint")).toBe("Save updates the document in the library.");
    click("unsaved-save");
    await settle(() => {
      expect(editor().value).toBe("");
    });
    expect(dialogOpen("title-dialog")).toBe(false);
    expect((await h.deps.store.getDocument(1)).content).toBe("first, edited");
  });

  it("Rename asks for a title, updates the list, and renames the tab of the open document", async () => {
    const h = await mount({ documents: [{ title: "Stored", content: "x", line_ending: "lf" }] });
    click("library");
    await settle(() => {
      expect(document.querySelectorAll(".library-row")).toHaveLength(1);
    });
    clickRow(".library-open");
    await settle(() => {
      expect(h.page.tabText.documentId).toBe(1);
    });
    click("library");
    await settle(() => {
      expect(document.querySelectorAll(".library-row")).toHaveLength(1);
    });
    clickRow(".library-rename");
    await settle(() => {
      expect(dialogOpen("title-dialog")).toBe(true);
    });
    expect(text("title-heading")).toBe("Rename");
    (byId("title-input") as HTMLInputElement).value = "Renamed";
    byId("title-form").dispatchEvent(new Event("submit", { cancelable: true }));
    await settle(() => {
      expect(document.title).toBe("Renamed – English Tutor");
    });
    await settle(() => {
      expect(document.querySelector(".library-title")?.textContent).toBe("Renamed");
    });
    expect((await h.deps.store.getDocument(1)).title).toBe("Renamed");
    expect(h.other.received).toContain("library-changed");
  });

  it("Delete asks first, deletes, and detaches the open document, so the next save creates a new one", async () => {
    const h = await mount({ documents: [{ title: "Stored", content: "x", line_ending: "lf" }] });
    click("library");
    await settle(() => {
      expect(document.querySelectorAll(".library-row")).toHaveLength(1);
    });
    clickRow(".library-open");
    await settle(() => {
      expect(h.page.tabText.documentId).toBe(1);
    });
    click("library");
    await settle(() => {
      expect(document.querySelectorAll(".library-row")).toHaveLength(1);
    });
    clickRow(".library-delete");
    expect(byId("library-confirm").hidden).toBe(false);
    click("library-delete-ok");
    await settle(() => {
      expect(document.querySelectorAll(".library-row")).toHaveLength(0);
    });
    expect(await h.deps.store.listDocuments()).toEqual([]);
    expect(h.page.tabText.documentId).toBeUndefined();
    expect(document.title).toBe("Stored – English Tutor");
    click("library-close");
    // The next Save to library creates a new document.
    type("x again");
    click("save-to-library");
    await settle(() => {
      expect(dialogOpen("title-dialog")).toBe(true);
    });
    expect((byId("title-input") as HTMLInputElement).value).toBe("Stored");
  });

  it("another tab's changes follow: a rename updates the title, a delete detaches, the open dialog reloads", async () => {
    const h = await mount({ documents: [{ title: "Stored", content: "x", line_ending: "lf" }] });
    click("library");
    await settle(() => {
      expect(document.querySelectorAll(".library-row")).toHaveLength(1);
    });
    clickRow(".library-open");
    await settle(() => {
      expect(h.page.tabText.documentId).toBe(1);
    });
    click("library");
    await settle(() => {
      expect(document.querySelectorAll(".library-row")).toHaveLength(1);
    });
    await h.deps.store.renameDocument(1, "Elsewhere");
    h.other.channel.post("library-changed");
    await settle(() => {
      expect(document.title).toBe("Elsewhere – English Tutor");
      expect(document.querySelector(".library-title")?.textContent).toBe("Elsewhere");
    });
    await h.deps.store.deleteDocument(1);
    h.other.channel.post("library-changed");
    await settle(() => {
      expect(h.page.tabText.documentId).toBeUndefined();
      expect(document.querySelectorAll(".library-row")).toHaveLength(0);
    });
  });
});

describe("the tab title and leaving the page", () => {
  it.each([
    { name: "a new tab", steps: () => undefined, title: "Untitled – English Tutor" },
    {
      name: "typing",
      steps: () => {
        type("a");
      },
      title: "Untitled* – English Tutor",
    },
    {
      name: "typing, then typing it away",
      steps: () => {
        type("a");
        type("");
      },
      title: "Untitled – English Tutor",
    },
    {
      name: "typing white space only",
      steps: () => {
        type("   ");
      },
      title: "Untitled – English Tutor",
    },
  ])("$name: $title", async ({ steps, title }) => {
    await mount();
    steps();
    expect(document.title).toBe(title);
  });

  it("asks the browser's question (beforeunload) only with unsaved changes", async () => {
    const h = await mount();
    const leave = () => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(leave()).toBe(false);
    type("Hello");
    expect(h.page.hasUnsavedChanges()).toBe(true);
    expect(leave()).toBe(true);
    h.page.tabText.saved();
    expect(leave()).toBe(false);
  });
});

describe("the tab's state in sessionStorage", () => {
  const SAVED: SavedTab = {
    text: "Restored text.\nSecond line.",
    source: "session:11111111-2222-4333-8444-555555555555",
    name: "draft",
    documentId: undefined,
    lineEnding: "crlf",
    dirty: true,
  };

  it("writes the text and its state after a pause, and not the issues", async () => {
    const h = await mount({ script: CHECKED });
    expect(h.tabStorage.value).toBeNull();
    type("Hello there");
    h.scheduler.advance(PERSIST_DELAY_MS);
    expect(parseSavedTab(h.tabStorage.value)).toEqual({
      text: "Hello there",
      source: h.page.source.key,
      name: undefined,
      documentId: undefined,
      lineEnding: "lf",
      dirty: true,
    });
    expect(h.tabStorage.value).not.toContain("issues");
  });

  it("writes at once when the page is hidden or unloaded", async () => {
    const h = await mount();
    type("Hello there");
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    expect(parseSavedTab(h.tabStorage.value)?.text).toBe("Hello there");
    type("Hello there again");
    window.dispatchEvent(new Event("beforeunload", { cancelable: true }));
    expect(parseSavedTab(h.tabStorage.value)?.text).toBe("Hello there again");
  });

  it("writes the new state after New, Open and Save to library", async () => {
    const h = await mount();
    chooseFile("opened.txt", "one two");
    await settle(() => {
      expect(editor().value).toBe("one two");
    });
    h.scheduler.advance(PERSIST_DELAY_MS);
    expect(parseSavedTab(h.tabStorage.value)).toMatchObject({
      text: "one two",
      name: "opened",
      dirty: false,
      source: h.page.source.key,
    });
  });

  it("restores the text, source, name, line ending and dirty flag after a reload, with no issues", async () => {
    const h = await mount({ tabState: serialiseSavedTab(SAVED) });
    expect(editor().value).toBe("Restored text.\nSecond line.");
    expect(h.page.source.key).toBe(SAVED.source);
    expect(h.page.tabText.name).toBe("draft");
    expect(h.page.tabText.lineEnding).toBe("crlf");
    expect(h.page.hasUnsavedChanges()).toBe(true);
    expect(document.title).toBe("draft* – English Tutor");
    expect(rows()).toHaveLength(0);
    expect(underlined()).toEqual([]);
    expect(text("status-words")).toBe("4 words");
    expect(button("save").disabled).toBe(false);
    expect(button("copy").disabled).toBe(false);
  });

  it("a restored library text is attached, and its title follows the library", async () => {
    const h = await mount({
      documents: [{ title: "Renamed in the library", content: "stored", line_ending: "lf" }],
      tabState: serialiseSavedTab({
        ...SAVED,
        source: "doc:1",
        documentId: 1,
        name: "Old title",
        dirty: false,
      }),
    });
    expect(h.page.tabText.documentId).toBe(1);
    expect(document.title).toBe("Renamed in the library – English Tutor");
    expect(h.page.source.key).toBe("doc:1");
  });

  it("a restored library text whose document is gone is detached", async () => {
    const h = await mount({
      tabState: serialiseSavedTab({ ...SAVED, source: "doc:5", documentId: 5, dirty: false }),
    });
    expect(h.page.tabText.documentId).toBeUndefined();
    expect(h.page.tabText.name).toBe("draft");
    expect(editor().value).toBe(SAVED.text);
  });

  it.each([
    { name: "a broken value", raw: "{not json" },
    { name: "a value of another shape", raw: JSON.stringify({ text: 5 }) },
    { name: "an unknown source", raw: JSON.stringify({ ...SAVED, v: 1, source: "file:x" }) },
  ])("starts empty for $name", async ({ raw }) => {
    const h = await mount({ tabState: raw });
    expect(editor().value).toBe("");
    expect(h.page.source.key).toBe("session:00000000-0000-4000-8000-000000000000");
    expect(document.title).toBe("Untitled – English Tutor");
  });

  it("a restored text can be checked again and counts mistakes under its restored source", async () => {
    const h = await mount({
      tabState: serialiseSavedTab({ ...SAVED, text: TEXT }),
      script: CHECKED,
    });
    click("check");
    await settle(async () => {
      expect((await allEvents(h)).length).toBe(3);
    });
    expect((await allEvents(h)).every((e) => e.source_key === SAVED.source)).toBe(true);
  });

  it("the editor does not restore its text by itself (autocomplete is off)", async () => {
    await mount();
    expect(editor().getAttribute("autocomplete")).toBe("off");
  });
});
