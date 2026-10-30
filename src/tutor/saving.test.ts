import { describe, expect, it } from "vitest";
import { CountingRandom } from "../core/analysis/testing/helpers";
import { AppError } from "../core/errors";
import { TabText, type TextInfo } from "../core/files";
import { Logger } from "../core/log";
import { TabSource, type DocumentInput, type MistakeInput } from "../core/store";
import { freshStats } from "../core/store/testing/db";
import { FakeChannelBus } from "../platform/testing/fake-channel";
import { FakeClipboard } from "../platform/testing/fake-clipboard";
import { FakeDownloads, type FakeDownloadOutcome } from "../platform/testing/fake-downloads";
import type { UnsavedChoice, UnsavedPrompt } from "../ui/unsaved-dialog";
import type { TitlePrompt } from "../ui/title-dialog";
import { SavingFlow, type ChosenFile, type SourceMover } from "./saving";

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

function file(name: string, bytes: Uint8Array, size = bytes.length): ChosenFile {
  return { name, size, arrayBuffer: () => Promise.resolve(bytes.slice().buffer) };
}

const mistake = (fingerprint: string): MistakeInput => ({
  error_type: "verb_form",
  category: "grammar",
  snippet: "I seen",
  fingerprint,
});

interface Options {
  /** What the editor holds. */
  text?: string;
  info?: Partial<TextInfo>;
  /** Marks the text as edited. */
  dirty?: boolean;
  /** The answers of the unsaved-changes dialog, in order (the last repeats). */
  unsaved?: UnsavedChoice[];
  /** The answers of the title dialog, in order (the last repeats). */
  titles?: (string | undefined)[];
  downloads?: FakeDownloadOutcome[];
  stats?: SourceMover;
}

async function fixture(options: Options = {}) {
  const { stats, store } = await freshStats();
  const bus = new FakeChannelBus();
  const channel = bus.connect();
  const peer = bus.connect();
  const peerSeen: string[] = [];
  peer.subscribe((m) => peerSeen.push(m.type));
  const downloads = new FakeDownloads();
  if (options.downloads !== undefined) downloads.outcomes = options.downloads;
  const clipboard = new FakeClipboard();
  const tabText = new TabText();
  const source = new TabSource(new CountingRandom());
  const host = {
    text: options.text ?? "",
    loaded: [] as string[],
    reported: [] as unknown[],
    banners: 0,
    flashes: [] as string[],
    statsMoved: 0,
  };
  const text = options.text ?? "";
  const info: TextInfo = {
    name: undefined,
    documentId: undefined,
    lineEnding: "lf",
    ...options.info,
  };
  tabText.loaded(info, text);
  if (options.dirty === true) tabText.edited(text);
  const unsavedAnswers = [...(options.unsaved ?? ["discard"])];
  const titleAnswers = [...(options.titles ?? ["Chosen title"])];
  const asked = { unsaved: [] as UnsavedPrompt[], titles: [] as TitlePrompt[] };
  const flow = new SavingFlow({
    host: {
      getText: () => host.text,
      loadText: (t) => {
        host.text = t;
        host.loaded.push(t);
      },
      report: (err) => host.reported.push(err),
      clearBanner: () => host.banners++,
      flash: (m) => host.flashes.push(m),
      statsMoved: () => host.statsMoved++,
    },
    tabText,
    source,
    store,
    stats: options.stats ?? stats,
    channel,
    downloads,
    clipboard,
    unsaved: {
      ask: (prompt) => {
        asked.unsaved.push(prompt);
        const answer = unsavedAnswers.length > 1 ? unsavedAnswers.shift() : unsavedAnswers[0];
        return Promise.resolve(answer ?? "cancel");
      },
    },
    titles: {
      ask: (prompt) => {
        asked.titles.push(prompt);
        const answer = titleAnswers.length > 1 ? titleAnswers.shift() : titleAnswers[0];
        return Promise.resolve(answer);
      },
    },
    log: new Logger({
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    }),
  });
  return {
    flow,
    host,
    tabText,
    source,
    store,
    stats,
    channel,
    peerSeen,
    downloads,
    clipboard,
    asked,
    /** Replaces the answers of the title dialog. */
    titles: (answers: (string | undefined)[]) => {
      titleAnswers.splice(0, titleAnswers.length, ...answers);
    },
    /** Replaces the answers of the unsaved-changes dialog. */
    unsavedAnswers: (answers: UnsavedChoice[]) => {
      unsavedAnswers.splice(0, unsavedAnswers.length, ...answers);
    },
  };
}

const firstError = (reported: unknown[]): AppError => {
  const err = reported[0];
  if (!(err instanceof AppError)) throw new Error("no AppError was reported");
  return err;
};

describe("New and Clear", () => {
  it.each([
    { name: "a clean text", text: "Hello", dirty: false, unsaved: [], ask: false },
    { name: "an empty text", text: "", dirty: true, unsaved: [], ask: false },
    { name: "a text of white space, edited", text: " \n ", dirty: true, unsaved: [], ask: false },
  ] as const)("$name starts without asking", async ({ text, dirty }) => {
    const f = await fixture({ text, dirty, info: { name: "old" } });
    const before = f.source.key;
    expect(await f.flow.newText()).toBe(true);
    expect(f.asked.unsaved).toEqual([]);
    expect(f.host.loaded).toEqual([""]);
    expect(f.host.banners).toBe(1);
    expect(f.source.key).not.toBe(before);
    expect(f.source.key.startsWith("session:")).toBe(true);
    expect([f.tabText.name, f.tabText.documentId, f.tabText.lineEnding, f.tabText.dirty]).toEqual([
      undefined,
      undefined,
      "lf",
      false,
    ]);
  });

  it("forgets a library document and a CRLF line ending", async () => {
    const f = await fixture({
      text: "x",
      info: { name: "doc", documentId: 4, lineEnding: "crlf" },
    });
    await f.flow.newText();
    expect([f.tabText.documentId, f.tabText.lineEnding]).toEqual([undefined, "lf"]);
  });

  describe("with unsaved changes", () => {
    it("asks, naming the text and what Save does", async () => {
      const f = await fixture({ text: "Hello", dirty: true, info: { name: "essay" } });
      await f.flow.newText();
      expect(f.asked.unsaved).toEqual([{ name: "essay", library: false }]);
      const g = await fixture({ text: "Hello", dirty: true, info: { name: "doc", documentId: 3 } });
      await g.flow.newText();
      expect(g.asked.unsaved).toEqual([{ name: "doc", library: true }]);
    });

    it.each([
      { choice: "discard" as const, loads: true, downloads: 0 },
      { choice: "cancel" as const, loads: false, downloads: 0 },
      { choice: "save" as const, loads: true, downloads: 1 },
    ])("$choice: loads $loads, downloads $downloads", async ({ choice, loads, downloads }) => {
      const f = await fixture({
        text: "Hello",
        dirty: true,
        info: { name: "essay" },
        unsaved: [choice],
      });
      const before = f.source.key;
      expect(await f.flow.newText()).toBe(loads);
      expect(f.host.loaded).toEqual(loads ? [""] : []);
      expect(f.downloads.requests).toHaveLength(downloads);
      expect(f.source.key === before).toBe(!loads);
      // Cancelling keeps the text and its unsaved flag.
      expect(f.tabText.unsaved).toBe(!loads);
    });

    it("Save of a named text downloads it without the dialog; of an unnamed one with it", async () => {
      const named = await fixture({
        text: "Hello",
        dirty: true,
        info: { name: "essay" },
        unsaved: ["save"],
      });
      await named.flow.newText();
      expect(named.downloads.requests.map((r) => [r.filename, r.saveAs])).toEqual([
        ["essay.txt", false],
      ]);
      const unnamed = await fixture({ text: "Hello world", dirty: true, unsaved: ["save"] });
      await unnamed.flow.newText();
      expect(unnamed.downloads.requests.map((r) => [r.filename, r.saveAs])).toEqual([
        ["Hello world.txt", true],
      ]);
    });

    it("Save cancelled in the browser's dialog cancels New, with no error", async () => {
      const f = await fixture({
        text: "Hello",
        dirty: true,
        unsaved: ["save"],
        downloads: [{ kind: "cancelled" }],
      });
      expect(await f.flow.newText()).toBe(false);
      expect(f.host.loaded).toEqual([]);
      expect(f.host.reported).toEqual([]);
      expect(f.tabText.unsaved).toBe(true);
    });

    it("a failed Save cancels New and reports FileWriteFailed", async () => {
      const f = await fixture({
        text: "Hello",
        dirty: true,
        info: { name: "essay" },
        unsaved: ["save"],
        downloads: [{ kind: "failed" }],
      });
      expect(await f.flow.newText()).toBe(false);
      expect(f.host.loaded).toEqual([]);
      expect(f.tabText.unsaved).toBe(true);
      expect(
        firstError(f.host.reported).hasRoute(
          "SavingFlow.download->FakeDownloads.download->FileWriteFailed",
        ),
      ).toBe(true);
    });

    it("Save of a library text updates the document, with no title dialog", async () => {
      const f = await fixture({ text: "Hello", unsaved: ["save"] });
      const doc = await f.store.createDocument({ title: "Doc", content: "old", line_ending: "lf" });
      f.tabText.loaded({ name: "Doc", documentId: doc.id, lineEnding: "lf" }, "Hello");
      f.tabText.edited("Hello");
      expect(await f.flow.newText()).toBe(true);
      expect(f.asked.titles).toEqual([]);
      expect((await f.store.getDocument(doc.id)).content).toBe("Hello");
      expect(f.downloads.requests).toEqual([]);
    });

    it("Save of a library text whose document is gone cancels New and detaches the text", async () => {
      const f = await fixture({
        text: "Hello",
        dirty: true,
        info: { name: "Doc", documentId: 99 },
        unsaved: ["save"],
      });
      expect(await f.flow.newText()).toBe(false);
      expect(f.host.loaded).toEqual([]);
      expect(f.tabText.documentId).toBeUndefined();
      expect(f.tabText.name).toBe("Doc");
      expect(
        firstError(f.host.reported).hasRoute(
          "SavingFlow.saveToLibrary->Store.updateDocument->DocumentNotFound",
        ),
      ).toBe(true);
    });
  });
});

describe("Copy", () => {
  it("copies the whole text and says Copied", async () => {
    const f = await fixture({ text: "Line one\nLine two" });
    await f.flow.copy();
    expect(f.clipboard.written).toEqual(["Line one\nLine two"]);
    expect(f.host.flashes).toEqual(["Copied"]);
  });

  it("does nothing for an empty text", async () => {
    const f = await fixture({ text: "" });
    await f.flow.copy();
    expect(f.clipboard.written).toEqual([]);
    expect(f.host.flashes).toEqual([]);
  });

  it("reports ClipboardWriteFailed and does not say Copied", async () => {
    const f = await fixture({ text: "x" });
    f.clipboard.failWith = new AppError("ClipboardWriteFailed", "denied");
    await f.flow.copy();
    expect(f.host.flashes).toEqual([]);
    expect(firstError(f.host.reported).hasRoute("SavingFlow.copy->ClipboardWriteFailed")).toBe(
      true,
    );
  });
});

describe("Open", () => {
  it.each([
    {
      name: "a plain file",
      file: file("My essay.txt", utf8("Hello there.")),
      text: "Hello there.",
      lineEnding: "lf",
      fileName: "My essay",
    },
    {
      name: "a CRLF file",
      file: file("notes.md", utf8("a\r\nb\r\n")),
      text: "a\nb\n",
      lineEnding: "crlf",
      fileName: "notes",
    },
    {
      name: "a file with a BOM",
      file: file("bom.txt", Uint8Array.from([0xef, 0xbb, 0xbf, 0x48, 0x69])),
      text: "Hi",
      lineEnding: "lf",
      fileName: "bom",
    },
    {
      name: "an empty file",
      file: file("empty.txt", utf8("")),
      text: "",
      lineEnding: "lf",
      fileName: "empty",
    },
    {
      name: "a file without an extension",
      file: file("README", utf8("x")),
      text: "x",
      lineEnding: "lf",
      fileName: "README",
    },
  ] as const)("opens $name", async ({ file: chosen, text, lineEnding, fileName }) => {
    const f = await fixture({ text: "old", info: { name: "old name", documentId: 8 } });
    const before = f.source.key;
    expect(await f.flow.openFile(chosen)).toBe(true);
    expect(f.host.loaded).toEqual([text]);
    expect([f.tabText.name, f.tabText.documentId, f.tabText.lineEnding, f.tabText.dirty]).toEqual([
      fileName,
      undefined,
      lineEnding,
      false,
    ]);
    expect(f.source.key).not.toBe(before);
    expect(f.source.key.startsWith("session:")).toBe(true);
  });

  it.each([
    {
      name: "a file that is not UTF-8",
      file: file("latin.txt", Uint8Array.from([0x63, 0x61, 0x66, 0xe9])),
      route: "SavingFlow.openFile->readTextFile->decodeTextFile->FileNotUTF8",
    },
    {
      name: "a file with a NUL byte",
      file: file("binary.txt", Uint8Array.from([0x61, 0, 0x62])),
      route: "SavingFlow.openFile->readTextFile->decodeTextFile->FileNotUTF8",
    },
    {
      name: "a file over 10 MB",
      file: file("big.txt", new Uint8Array(0), 10 * 1024 * 1024 + 1),
      route: "SavingFlow.openFile->readTextFile->FileReadFailed",
    },
    {
      name: "a file that cannot be read",
      file: {
        name: "locked.txt",
        size: 3,
        arrayBuffer: () => Promise.reject(new DOMException("denied", "NotReadableError")),
      },
      route: "SavingFlow.openFile->readTextFile->FileReadFailed",
    },
  ])(
    "$name is refused, reported, and leaves the text alone without asking",
    async ({ file: chosen, route }) => {
      const f = await fixture({ text: "Keep me", dirty: true, info: { name: "mine" } });
      const before = f.source.key;
      expect(await f.flow.openFile(chosen)).toBe(false);
      expect(firstError(f.host.reported).hasRoute(route)).toBe(true);
      // Nothing was asked and nothing was replaced.
      expect(f.asked.unsaved).toEqual([]);
      expect(f.host.loaded).toEqual([]);
      expect(f.host.text).toBe("Keep me");
      expect(f.source.key).toBe(before);
      expect(f.tabText.name).toBe("mine");
      expect(f.tabText.unsaved).toBe(true);
      expect(f.host.banners).toBe(0);
    },
  );

  it("asks about unsaved changes only after the file was read", async () => {
    const f = await fixture({ text: "Keep me", dirty: true, unsaved: ["cancel"] });
    expect(await f.flow.openFile(file("a.txt", utf8("new")))).toBe(false);
    expect(f.asked.unsaved).toHaveLength(1);
    expect(f.host.loaded).toEqual([]);
  });

  it("Save in the dialog downloads the old text, then opens the file", async () => {
    const f = await fixture({
      text: "Old text",
      dirty: true,
      info: { name: "old" },
      unsaved: ["save"],
    });
    expect(await f.flow.openFile(file("new.txt", utf8("New text")))).toBe(true);
    expect(f.downloads.requests.map((r) => r.text)).toEqual(["Old text"]);
    expect(f.host.text).toBe("New text");
    expect(f.tabText.name).toBe("new");
  });
});

describe("Save and Save As", () => {
  it("Save downloads under the text's name, with .txt added, without a dialog", async () => {
    const f = await fixture({ text: "Hello", dirty: true, info: { name: "My essay" } });
    expect(await f.flow.save()).toBe(true);
    expect(f.downloads.requests).toEqual([
      { text: "Hello", filename: "My essay.txt", saveAs: false },
    ]);
    expect(f.tabText.dirty).toBe(false);
    expect(f.tabText.name).toBe("My essay");
  });

  it.each([
    { name: "notes.md", filename: "notes.md" },
    { name: "a/b: c", filename: "a_b_ c.txt" },
  ])("Save names the file $filename for the name $name", async ({ name, filename }) => {
    const f = await fixture({ text: "x", info: { name } });
    await f.flow.save();
    expect(f.downloads.requests[0]?.filename).toBe(filename);
  });

  it("writes the remembered line ending", async () => {
    const f = await fixture({ text: "a\nb\nc", info: { name: "crlf", lineEnding: "crlf" } });
    await f.flow.save();
    expect(f.downloads.requests[0]?.text).toBe("a\r\nb\r\nc");
    const g = await fixture({ text: "a\nb", info: { name: "lf" } });
    await g.flow.save();
    expect(g.downloads.requests[0]?.text).toBe("a\nb");
  });

  it("a text without a name behaves like Save As: the first line proposes the name", async () => {
    const f = await fixture({ text: "A fine title\nMore text", dirty: true });
    expect(await f.flow.save()).toBe(true);
    expect(f.downloads.requests).toEqual([
      { text: "A fine title\nMore text", filename: "A fine title.txt", saveAs: true },
    ]);
  });

  it("does not change the source", async () => {
    const f = await fixture({ text: "x", info: { name: "n" } });
    const before = f.source.key;
    await f.flow.save();
    await f.flow.saveAs();
    expect(f.source.key).toBe(before);
  });

  describe("Save As", () => {
    it("asks the browser for a dialog, proposing the name or the first line", async () => {
      const named = await fixture({ text: "x", info: { name: "kept" } });
      await named.flow.saveAs();
      expect(named.downloads.requests[0]).toMatchObject({ filename: "kept.txt", saveAs: true });
      const unnamed = await fixture({ text: "\n\nSecond line wins\nrest" });
      await unnamed.flow.saveAs();
      expect(unnamed.downloads.requests[0]).toMatchObject({
        filename: "Second line wins.txt",
        saveAs: true,
      });
    });

    it.each([
      { path: "/home/me/Downloads/Renamed essay.txt", name: "Renamed essay" },
      { path: "C:\\Users\\me\\essay-2.md", name: "essay-2" },
      { path: "/home/me/Downloads/", name: "old" },
    ])("the name the user typed ($path) becomes the text's name: $name", async ({ path, name }) => {
      const f = await fixture({
        text: "x",
        dirty: true,
        info: { name: "old" },
        downloads: [{ kind: "saved", path }],
      });
      expect(await f.flow.saveAs()).toBe(true);
      expect(f.tabText.name).toBe(name);
      expect(f.tabText.dirty).toBe(false);
    });

    it("keeps the title of a library document", async () => {
      const f = await fixture({
        text: "x",
        dirty: true,
        info: { name: "Library title", documentId: 3 },
        downloads: [{ kind: "saved", path: "/tmp/other name.txt" }],
      });
      await f.flow.saveAs();
      expect(f.tabText.name).toBe("Library title");
      expect(f.tabText.documentId).toBe(3);
    });
  });

  it.each([
    { name: "Save", act: (f: Awaited<ReturnType<typeof fixture>>) => f.flow.save() },
    { name: "Save As", act: (f: Awaited<ReturnType<typeof fixture>>) => f.flow.saveAs() },
  ])("$name: cancelling the dialog is no error and changes nothing", async ({ act }) => {
    const f = await fixture({
      text: "x",
      dirty: true,
      info: { name: "n" },
      downloads: [{ kind: "cancelled" }],
    });
    expect(await act(f)).toBe(false);
    expect(f.host.reported).toEqual([]);
    expect(f.tabText.unsaved).toBe(true);
    expect(f.tabText.name).toBe("n");
  });

  it.each([
    { name: "Save", act: (f: Awaited<ReturnType<typeof fixture>>) => f.flow.save() },
    { name: "Save As", act: (f: Awaited<ReturnType<typeof fixture>>) => f.flow.saveAs() },
  ])("$name: a failure is FileWriteFailed, and the text stays unsaved", async ({ act }) => {
    const f = await fixture({
      text: "x",
      dirty: true,
      info: { name: "n" },
      downloads: [{ kind: "failed" }],
    });
    expect(await act(f)).toBe(false);
    expect(f.tabText.unsaved).toBe(true);
    const err = firstError(f.host.reported);
    expect(err.hasRoute("SavingFlow.download->FakeDownloads.download->FileWriteFailed")).toBe(true);
  });

  it("typing while the download runs leaves the newer text unsaved", async () => {
    const f = await fixture({ text: "first", dirty: true, info: { name: "n" } });
    let release: () => void = () => undefined;
    f.downloads.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const saving = f.flow.save();
    f.host.text = "first and more";
    f.tabText.edited(f.host.text);
    release();
    expect(await saving).toBe(true);
    expect(f.tabText.unsaved).toBe(true);
  });

  it("ignores a second click while the first is running", async () => {
    const f = await fixture({ text: "x", info: { name: "n" } });
    let release: () => void = () => undefined;
    f.downloads.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = f.flow.save();
    expect(f.flow.isBusy).toBe(true);
    expect(await f.flow.save()).toBe(false);
    expect(await f.flow.saveAs()).toBe(false);
    expect(await f.flow.newText()).toBe(false);
    release();
    expect(await first).toBe(true);
    expect(f.flow.isBusy).toBe(false);
    expect(f.downloads.requests).toHaveLength(1);
  });
});

describe("Save to library", () => {
  const TEXT_60 = `${"a".repeat(50)} ${"b".repeat(30)}`;

  it("asks for the title (default: the first line cut to 60 characters) and stores a document", async () => {
    const f = await fixture({ text: `${TEXT_60}\nsecond line`, dirty: true, titles: ["My title"] });
    expect(await f.flow.saveToLibrary()).toBe(true);
    expect(f.asked.titles).toEqual([
      { heading: "Save to library", initial: TEXT_60.slice(0, 60).trimEnd(), confirm: "Save" },
    ]);
    const [doc] = await f.store.listDocuments();
    expect(doc).toMatchObject({
      title: "My title",
      content: `${TEXT_60}\nsecond line`,
      line_ending: "lf",
    });
    expect([f.tabText.documentId, f.tabText.name, f.tabText.dirty]).toEqual([
      doc?.id,
      "My title",
      false,
    ]);
    expect(f.source.key).toBe(`doc:${String(doc?.id)}`);
  });

  it("defaults the title to the text's name when it has one", async () => {
    const f = await fixture({ text: "Body", info: { name: "from file", lineEnding: "crlf" } });
    await f.flow.saveToLibrary();
    expect(f.asked.titles[0]?.initial).toBe("from file");
    expect((await f.store.listDocuments())[0]?.line_ending).toBe("crlf");
  });

  it("broadcasts library-changed and stats-changed, and tells the page to read the badges again", async () => {
    const f = await fixture({ text: "Body", dirty: true });
    await f.flow.saveToLibrary();
    expect(f.peerSeen.sort()).toEqual(["library-changed", "stats-changed"]);
    expect(f.host.statsMoved).toBe(1);
  });

  it("cancelling the title dialog stores nothing", async () => {
    const f = await fixture({ text: "Body", dirty: true, titles: [undefined] });
    const before = f.source.key;
    expect(await f.flow.saveToLibrary()).toBe(false);
    expect(await f.store.listDocuments()).toEqual([]);
    expect(f.source.key).toBe(before);
    expect(f.tabText.unsaved).toBe(true);
    expect(f.peerSeen).toEqual([]);
    expect(f.host.reported).toEqual([]);
  });

  it("moves the mistakes of the session to the document, dropping duplicates", async () => {
    const f = await fixture({ text: "Body", dirty: true });
    const session = f.source.key;
    await f.stats.record(session, "LLM", [mistake("f1"), mistake("f2")]);
    await f.flow.saveToLibrary();
    const docKey = f.source.key;
    expect(docKey.startsWith("doc:")).toBe(true);
    expect((await f.stats.typeStats())[0]?.total).toBe(2);
    // Checking the saved text again counts nothing twice.
    expect(
      await f.stats.record(docKey, "LLM", [mistake("f1"), mistake("f2"), mistake("f3")]),
    ).toEqual({
      inserted: 1,
      duplicate: 2,
      ignored: 0,
    });
    // Nothing is left under the old session key.
    expect(await f.stats.record(session, "LLM", [mistake("f1")])).toMatchObject({ inserted: 1 });
  });

  it("moves the Not-an-error pairs too, so a re-check does not record them again", async () => {
    const f = await fixture({ text: "Body", dirty: true });
    await f.stats.record(f.source.key, "LLM", [mistake("f1")]);
    await f.stats.notAnError(f.source.key, "f1");
    await f.flow.saveToLibrary();
    expect(await f.stats.record(f.source.key, "LLM", [mistake("f1")])).toEqual({
      inserted: 0,
      duplicate: 0,
      ignored: 1,
    });
  });

  it("updates the open document without asking, keeping its title and source", async () => {
    const f = await fixture({ text: "First" });
    await f.flow.saveToLibrary();
    const doc = (await f.store.listDocuments())[0]!;
    const key = f.source.key;
    f.host.text = "Second version";
    f.tabText.edited(f.host.text);
    f.asked.titles.length = 0;
    f.peerSeen.length = 0;
    expect(await f.flow.saveToLibrary()).toBe(true);
    expect(f.asked.titles).toEqual([]);
    const updated = await f.store.getDocument(doc.id);
    expect(updated).toMatchObject({ title: doc.title, content: "Second version" });
    expect(f.source.key).toBe(key);
    expect(f.tabText.dirty).toBe(false);
    expect(f.peerSeen).toEqual(["library-changed"]);
  });

  it("a document deleted meanwhile is DocumentNotFound: reported, and the text is detached", async () => {
    const f = await fixture({ text: "First" });
    await f.flow.saveToLibrary();
    const doc = (await f.store.listDocuments())[0]!;
    await f.store.deleteDocument(doc.id);
    f.tabText.edited("changed");
    expect(await f.flow.saveToLibrary()).toBe(false);
    expect(f.tabText.documentId).toBeUndefined();
    expect(f.tabText.unsaved).toBe(true);
    expect(
      firstError(f.host.reported).hasRoute(
        "SavingFlow.saveToLibrary->Store.updateDocument->DocumentNotFound",
      ),
    ).toBe(true);
    // The next Save to library creates a new document, and the mistakes follow it.
    f.titles(["Again"]);
    expect(await f.flow.saveToLibrary()).toBe(true);
    const [created] = await f.store.listDocuments();
    expect(created?.id).not.toBe(doc.id);
    expect(f.source.key).toBe(`doc:${String(created?.id)}`);
  });

  it("a failed move of the mistakes is reported, but the document is saved", async () => {
    const failing: SourceMover = {
      moveSource: () => Promise.reject(new AppError("ErrorEventSaveFailed", "could not move")),
    };
    const f = await fixture({ text: "Body", dirty: true, stats: failing });
    expect(await f.flow.saveToLibrary()).toBe(true);
    expect(await f.store.listDocuments()).toHaveLength(1);
    expect(f.tabText.dirty).toBe(false);
    expect(
      firstError(f.host.reported).hasRoute("SavingFlow.saveToLibrary->ErrorEventSaveFailed"),
    ).toBe(true);
  });

  it("does not mark newer text as saved", async () => {
    const f = await fixture({ text: "Body", dirty: true });
    const doc = f.store.createDocument.bind(f.store);
    f.store.createDocument = async (input: DocumentInput) => {
      f.host.text = "Body plus typing";
      f.tabText.edited(f.host.text);
      return doc(input);
    };
    await f.flow.saveToLibrary();
    expect(f.tabText.unsaved).toBe(true);
  });
});

describe("the library's documents", () => {
  async function withDocuments() {
    const f = await fixture({ text: "" });
    const a = await f.store.createDocument({ title: "First", content: "one", line_ending: "lf" });
    const b = await f.store.createDocument({
      title: "Second",
      content: "a\r\nb",
      line_ending: "crlf",
    });
    return { f, a, b };
  }

  it("opens a document: its text, title, line ending and doc: source", async () => {
    const { f, b } = await withDocuments();
    expect(await f.flow.openDocument(b.id)).toBe(true);
    expect(f.host.loaded).toEqual(["a\r\nb"]);
    expect([f.tabText.name, f.tabText.documentId, f.tabText.lineEnding, f.tabText.dirty]).toEqual([
      "Second",
      b.id,
      "crlf",
      false,
    ]);
    expect(f.source.key).toBe(`doc:${String(b.id)}`);
  });

  it("reads the document fresh, and asks about unsaved changes after reading it", async () => {
    const { f, a } = await withDocuments();
    f.host.text = "unsaved";
    f.tabText.edited("unsaved");
    f.unsavedAnswers(["cancel"]);
    expect(await f.flow.openDocument(a.id)).toBe(false);
    expect(f.asked.unsaved).toHaveLength(1);
    expect(f.host.loaded).toEqual([]);
    expect(f.tabText.unsaved).toBe(true);
  });

  it("a document that is gone is reported as DocumentNotFound and nothing is asked", async () => {
    const { f, a } = await withDocuments();
    f.host.text = "unsaved";
    f.tabText.edited("unsaved");
    await f.store.deleteDocument(a.id);
    expect(await f.flow.openDocument(a.id)).toBe(false);
    expect(f.asked.unsaved).toEqual([]);
    expect(
      firstError(f.host.reported).hasRoute(
        "SavingFlow.openDocument->Store.getDocument->DocumentNotFound",
      ),
    ).toBe(true);
  });

  it("renames a document, asks for the title, and tells the other tabs", async () => {
    const { f, a } = await withDocuments();
    f.titles(["Renamed"]);
    await f.flow.renameDocument(a);
    expect(f.asked.titles).toEqual([{ heading: "Rename", initial: "First", confirm: "Rename" }]);
    expect((await f.store.getDocument(a.id)).title).toBe("Renamed");
    expect(f.peerSeen).toEqual(["library-changed"]);
  });

  it.each([
    { name: "cancelled", answer: undefined },
    { name: "unchanged", answer: "First" },
  ])("a rename that is $name changes nothing", async ({ answer }) => {
    const { f, a } = await withDocuments();
    f.titles([answer]);
    await f.flow.renameDocument(a);
    expect((await f.store.getDocument(a.id)).title).toBe("First");
    expect(f.peerSeen).toEqual([]);
  });

  it("renaming the open document renames the tab", async () => {
    const { f, a } = await withDocuments();
    await f.flow.openDocument(a.id);
    f.titles(["New name"]);
    await f.flow.renameDocument(a);
    expect(f.tabText.name).toBe("New name");
  });

  it("renaming another document leaves the tab alone", async () => {
    const { f, a, b } = await withDocuments();
    await f.flow.openDocument(a.id);
    f.titles(["Other"]);
    await f.flow.renameDocument(b);
    expect(f.tabText.name).toBe("First");
  });

  it("rejects a rename of a missing document with the route", async () => {
    const { f, a } = await withDocuments();
    await f.store.deleteDocument(a.id);
    f.titles(["x"]);
    const err = await f.flow.renameDocument(a).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(
      (err as AppError).hasRoute(
        "SavingFlow.renameDocument->Store.renameDocument->DocumentNotFound",
      ),
    ).toBe(true);
  });

  it("deletes a document and tells the other tabs", async () => {
    const { f, a, b } = await withDocuments();
    await f.flow.deleteDocument(a);
    expect((await f.store.listDocuments()).map((d) => d.id)).toEqual([b.id]);
    expect(f.peerSeen).toEqual(["library-changed"]);
  });

  it("deleting the open document detaches the text, which keeps its name and source", async () => {
    const { f, a } = await withDocuments();
    await f.flow.openDocument(a.id);
    await f.flow.deleteDocument(a);
    expect([f.tabText.documentId, f.tabText.name]).toEqual([undefined, "First"]);
    expect(f.source.key).toBe(`doc:${String(a.id)}`);
  });

  it("rejects the deletion of a missing document with the route", async () => {
    const { f, a } = await withDocuments();
    await f.store.deleteDocument(a.id);
    const err = await f.flow.deleteDocument(a).catch((e: unknown) => e);
    expect(
      (err as AppError).hasRoute(
        "SavingFlow.deleteDocument->Store.deleteDocument->DocumentNotFound",
      ),
    ).toBe(true);
  });

  describe("syncWithLibrary (another tab announced library-changed)", () => {
    it("does nothing for a text that is not a document", async () => {
      const { f } = await withDocuments();
      f.tabText.rename("x");
      await f.flow.syncWithLibrary();
      expect(f.tabText.name).toBe("x");
    });

    it("follows a rename made in another tab, without touching the text", async () => {
      const { f, a } = await withDocuments();
      await f.flow.openDocument(a.id);
      await f.store.renameDocument(a.id, "Renamed elsewhere");
      await f.flow.syncWithLibrary();
      expect(f.tabText.name).toBe("Renamed elsewhere");
      expect(f.host.loaded).toEqual(["one"]);
    });

    it("detaches a text whose document was deleted in another tab", async () => {
      const { f, a } = await withDocuments();
      await f.flow.openDocument(a.id);
      await f.store.deleteDocument(a.id);
      await f.flow.syncWithLibrary();
      expect(f.tabText.documentId).toBeUndefined();
      expect(f.tabText.name).toBe("First");
      expect(f.host.reported).toEqual([]);
    });
  });
});
