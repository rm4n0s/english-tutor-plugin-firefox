// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { AppError } from "../core/errors";
import type { LibraryDocument } from "../core/store";
import { LibraryDialog, type LibraryActions } from "./library-dialog";

const DAY = Date.UTC(2026, 2, 5, 12);
function doc(id: number, title: string, content: string, updated = DAY): LibraryDocument {
  return { id, title, content, line_ending: "lf", created_at: updated, updated_at: updated };
}

interface Fixture {
  documents: LibraryDocument[];
  opened: number[];
  renamed: number[];
  removed: number[];
  errors: unknown[];
  openResult: boolean;
  failWith: Error | undefined;
  removeError: Error | undefined;
  lists: number;
}

let host: HTMLElement;
let dialog: LibraryDialog;
let fx: Fixture;

beforeEach(() => {
  document.body.replaceChildren();
  host = document.createElement("div");
  document.body.append(host);
  fx = {
    documents: [doc(2, "Second essay", "one two three"), doc(1, "First", "word")],
    opened: [],
    renamed: [],
    removed: [],
    errors: [],
    openResult: true,
    failWith: undefined,
    removeError: undefined,
    lists: 0,
  };
  const actions: LibraryActions = {
    list: () => {
      fx.lists++;
      return fx.failWith === undefined
        ? Promise.resolve(fx.documents)
        : Promise.reject(fx.failWith);
    },
    open: (d) => {
      fx.opened.push(d.id);
      return fx.failWith === undefined
        ? Promise.resolve(fx.openResult)
        : Promise.reject(fx.failWith);
    },
    rename: (d) => {
      fx.renamed.push(d.id);
      return Promise.resolve();
    },
    remove: (d) => {
      fx.removed.push(d.id);
      if (fx.removeError !== undefined) return Promise.reject(fx.removeError);
      fx.documents = fx.documents.filter((x) => x.id !== d.id);
      return Promise.resolve();
    },
    onError: (err) => fx.errors.push(err),
  };
  dialog = new LibraryDialog(document, host, actions);
});

const q = (selector: string): HTMLElement => {
  const found = host.querySelector<HTMLElement>(selector);
  if (found === null) throw new Error(`nothing matches ${selector}`);
  return found;
};
const all = (selector: string) => [...host.querySelectorAll<HTMLElement>(selector)];
const click = (el: HTMLElement) => el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
const row = (n: number) => all(".library-row")[n - 1] as HTMLElement;
const inRow = (n: number, selector: string) => {
  const found = row(n).querySelector<HTMLElement>(selector);
  if (found === null) throw new Error(`row ${String(n)} has no ${selector}`);
  return found;
};
const settle = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

describe("LibraryDialog", () => {
  it("lists the documents in the order given, with date and words, and Open, Rename, Delete", async () => {
    await dialog.open();
    expect(dialog.isOpen).toBe(true);
    expect(q("#library-title").textContent).toBe("Library");
    expect(all(".library-row").map((r) => r.querySelector(".library-title")?.textContent)).toEqual([
      "Second essay",
      "First",
    ]);
    expect(all(".library-meta").map((m) => m.textContent)).toEqual([
      "2026-03-05 · 3 words",
      "2026-03-05 · 1 word",
    ]);
    expect(all(".library-row").map((r) => r.dataset.id)).toEqual(["2", "1"]);
    expect([...row(1).querySelectorAll("button")].map((b) => b.textContent)).toEqual([
      "Open",
      "Rename",
      "Delete",
    ]);
    expect(q("#library-empty").hidden).toBe(true);
  });

  it("shows an empty line for an empty library", async () => {
    fx.documents = [];
    await dialog.open();
    expect(all(".library-row")).toEqual([]);
    expect(q("#library-empty").hidden).toBe(false);
    expect(q("#library-empty").textContent).toContain("The library is empty");
  });

  it("shows titles as text, never as markup", async () => {
    fx.documents = [doc(1, "<b>bold</b>", "x")];
    await dialog.open();
    expect(q(".library-title").textContent).toBe("<b>bold</b>");
    expect(host.querySelector("b")).toBeNull();
  });

  it("Open asks for the document and closes the dialog when it was opened", async () => {
    await dialog.open();
    click(inRow(2, ".library-open"));
    await settle();
    expect(fx.opened).toEqual([1]);
    expect(dialog.isOpen).toBe(false);
  });

  it("Open leaves the dialog open when the user cancelled", async () => {
    fx.openResult = false;
    await dialog.open();
    click(inRow(1, ".library-open"));
    await settle();
    expect(fx.opened).toEqual([2]);
    expect(dialog.isOpen).toBe(true);
    expect(all(".library-row")).toHaveLength(2);
  });

  it("Rename calls the action and reads the list again", async () => {
    await dialog.open();
    const before = fx.lists;
    click(inRow(1, ".library-rename"));
    await settle();
    expect(fx.renamed).toEqual([2]);
    expect(fx.lists).toBe(before + 1);
  });

  it("Delete asks first, in the dialog, and does nothing on Cancel", async () => {
    await dialog.open();
    expect(q("#library-confirm").hidden).toBe(true);
    click(inRow(1, ".library-delete"));
    expect(q("#library-confirm").hidden).toBe(false);
    expect(q(".confirm-text").textContent).toBe(
      "Delete “Second essay” from the library? This cannot be undone.",
    );
    expect(fx.removed).toEqual([]);
    click(q("#library-delete-cancel"));
    expect(q("#library-confirm").hidden).toBe(true);
    await settle();
    expect(fx.removed).toEqual([]);
    expect(all(".library-row")).toHaveLength(2);
  });

  it("Delete removes the document after the confirmation and shows the new list", async () => {
    await dialog.open();
    click(inRow(2, ".library-delete"));
    click(q("#library-delete-ok"));
    await settle();
    expect(fx.removed).toEqual([1]);
    expect(all(".library-row").map((r) => r.dataset.id)).toEqual(["2"]);
    expect(q("#library-confirm").hidden).toBe(true);
  });

  it("a failure while listing shows its message in the banner and is passed on", async () => {
    fx.failWith = new AppError("DatabaseQueryFailed", "The database failed.");
    await dialog.open();
    expect(q("#library-banner").hidden).toBe(false);
    expect(q("#library-banner").textContent).toContain("The database failed.");
    expect(fx.errors).toHaveLength(1);
  });

  it("a failed Delete shows the message, and the list is read again", async () => {
    await dialog.open();
    fx.removeError = new AppError("DocumentNotFound", "The library document no longer exists.");
    const before = fx.lists;
    click(inRow(1, ".library-delete"));
    click(q("#library-delete-ok"));
    await settle();
    expect(q("#library-banner").hidden).toBe(false);
    expect(q("#library-banner").textContent).toContain("no longer exists");
    expect(fx.lists).toBe(before + 1);
    expect(fx.errors).toHaveLength(1);
  });

  it("a failure that is not an AppError says something went wrong", async () => {
    fx.failWith = new Error("secret internals");
    await dialog.open();
    expect(q("#library-banner .banner-text").textContent).toBe("Something went wrong.");
  });

  it("reload shows what changed elsewhere, and keeps the old list on a failure", async () => {
    await dialog.open();
    fx.documents = [doc(3, "Third", "x"), ...fx.documents];
    await dialog.reload();
    expect(all(".library-row")).toHaveLength(3);
    fx.failWith = new AppError("DatabaseQueryFailed", "boom");
    await dialog.reload();
    expect(all(".library-row")).toHaveLength(3);
    expect(q("#library-banner").hidden).toBe(false);
  });

  it("ignores a list that arrives after the dialog was closed", async () => {
    const other = document.createElement("div");
    document.body.append(other);
    let finish: (docs: LibraryDocument[]) => void = () => undefined;
    const slow = new LibraryDialog(document, other, {
      list: () =>
        new Promise<LibraryDocument[]>((resolve) => {
          finish = resolve;
        }),
      open: () => Promise.resolve(true),
      rename: () => Promise.resolve(),
      remove: () => Promise.resolve(),
    });
    const loading = slow.open();
    slow.close();
    finish([doc(9, "Late", "x")]);
    await loading;
    expect(other.querySelectorAll(".library-row")).toHaveLength(0);
  });

  it.each([
    { name: "Close", close: () => click(q("#library-close")) },
    {
      name: "Escape",
      close: () => q("#library-dialog").dispatchEvent(new Event("cancel", { cancelable: true })),
    },
  ])("$name closes the dialog", async ({ close }) => {
    await dialog.open();
    close();
    expect(dialog.isOpen).toBe(false);
  });

  it("opens again with the confirmation and the banner cleared", async () => {
    await dialog.open();
    click(inRow(1, ".library-delete"));
    dialog.close();
    await dialog.open();
    expect(q("#library-confirm").hidden).toBe(true);
  });
});
