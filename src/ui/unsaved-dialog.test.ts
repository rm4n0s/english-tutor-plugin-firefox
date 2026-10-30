// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { UnsavedDialog, type UnsavedChoice } from "./unsaved-dialog";

let host: HTMLElement;
let dialog: UnsavedDialog;
let trigger: HTMLButtonElement;

beforeEach(() => {
  document.body.replaceChildren();
  trigger = document.createElement("button");
  host = document.createElement("div");
  document.body.append(trigger, host);
  dialog = new UnsavedDialog(document, host);
});

const q = (selector: string): HTMLElement => {
  const found = host.querySelector<HTMLElement>(selector);
  if (found === null) throw new Error(`nothing matches ${selector}`);
  return found;
};
const click = (selector: string) =>
  q(selector).dispatchEvent(new MouseEvent("click", { bubbles: true }));

describe("UnsavedDialog", () => {
  it.each([
    {
      prompt: { name: undefined, library: false },
      message: "This text has changes that are not saved.",
      hint: "Save downloads the text as a file.",
    },
    {
      prompt: { name: "My essay", library: false },
      message: "“My essay” has changes that are not saved.",
      hint: "Save downloads the text as a file.",
    },
    {
      prompt: { name: "My essay", library: true },
      message: "“My essay” has changes that are not saved.",
      hint: "Save updates the document in the library.",
    },
  ])("says what Save does: $hint", ({ prompt, message, hint }) => {
    void dialog.ask(prompt);
    expect(dialog.isOpen).toBe(true);
    expect(q("#unsaved-title").textContent).toBe("Unsaved changes");
    expect(q("#unsaved-message").textContent).toBe(message);
    expect(q("#unsaved-hint").textContent).toBe(hint);
    expect([...host.querySelectorAll("button")].map((b) => b.textContent)).toEqual([
      "Save",
      "Discard",
      "Cancel",
    ]);
  });

  it("shows a name as text, never as markup", () => {
    void dialog.ask({ name: "<b>x</b>", library: false });
    expect(q("#unsaved-message").textContent).toContain("<b>x</b>");
    expect(host.querySelector("b")).toBeNull();
  });

  it.each<{ name: string; choose: () => void; result: UnsavedChoice }>([
    { name: "Save", choose: () => click("#unsaved-save"), result: "save" },
    { name: "Discard", choose: () => click("#unsaved-discard"), result: "discard" },
    { name: "Cancel", choose: () => click("#unsaved-cancel"), result: "cancel" },
    {
      name: "Escape",
      choose: () => q("#unsaved-dialog").dispatchEvent(new Event("cancel", { cancelable: true })),
      result: "cancel",
    },
    {
      name: "a click outside the box",
      choose: () => click("#unsaved-dialog"),
      result: "cancel",
    },
  ])("$name resolves with $result and closes the dialog", async ({ choose, result }) => {
    const answer = dialog.ask({ name: undefined, library: false });
    choose();
    expect(await answer).toBe(result);
    expect(dialog.isOpen).toBe(false);
  });

  it("does not close for a click inside the box", () => {
    void dialog.ask({ name: undefined, library: false });
    click(".modal-box");
    expect(dialog.isOpen).toBe(true);
  });

  it("focuses Save, and gives the focus back", async () => {
    trigger.focus();
    const answer = dialog.ask({ name: undefined, library: false });
    expect(document.activeElement).toBe(q("#unsaved-save"));
    click("#unsaved-cancel");
    await answer;
    expect(document.activeElement).toBe(trigger);
  });

  it("cancels the question before when asked again", async () => {
    const first = dialog.ask({ name: "one", library: false });
    const second = dialog.ask({ name: "two", library: false });
    expect(await first).toBe("cancel");
    expect(q("#unsaved-message").textContent).toContain("two");
    click("#unsaved-discard");
    expect(await second).toBe("discard");
  });

  it("is cancelled by destroy", async () => {
    const answer = dialog.ask({ name: undefined, library: false });
    dialog.destroy();
    expect(await answer).toBe("cancel");
    expect(host.querySelector("dialog")).toBeNull();
  });
});
