// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { TitleDialog } from "./title-dialog";

let host: HTMLElement;
let dialog: TitleDialog;

beforeEach(() => {
  document.body.replaceChildren();
  host = document.createElement("div");
  document.body.append(host);
  dialog = new TitleDialog(document, host);
});

const q = (selector: string): HTMLElement => {
  const found = host.querySelector<HTMLElement>(selector);
  if (found === null) throw new Error(`nothing matches ${selector}`);
  return found;
};
const input = () => q("#title-input") as HTMLInputElement;
const click = (selector: string) =>
  q(selector).dispatchEvent(new MouseEvent("click", { bubbles: true }));
const submit = () => q("#title-form").dispatchEvent(new Event("submit", { cancelable: true }));
const type = (value: string) => {
  input().value = value;
  input().dispatchEvent(new Event("input", { bubbles: true }));
};
const PROMPT = { heading: "Save to library", initial: "Hello there", confirm: "Save" };

describe("TitleDialog", () => {
  it("opens with the heading, the initial title and the confirm label", () => {
    void dialog.ask(PROMPT);
    expect(dialog.isOpen).toBe(true);
    expect(q("#title-heading").textContent).toBe("Save to library");
    expect(input().value).toBe("Hello there");
    expect(q("#title-ok").textContent).toBe("Save");
    expect(q("#title-problem").hidden).toBe(true);
    expect(input().getAttribute("maxlength")).toBe("200");
  });

  it.each([
    { typed: "My essay", expected: "My essay" },
    { typed: "  padded  ", expected: "padded" },
    { typed: "x".repeat(250), expected: "x".repeat(200) },
  ])("confirming gives the cleaned title: $expected", async ({ typed, expected }) => {
    const answer = dialog.ask(PROMPT);
    type(typed);
    submit();
    expect(await answer).toBe(expected);
    expect(dialog.isOpen).toBe(false);
  });

  it("confirms the initial title as it is", async () => {
    const answer = dialog.ask(PROMPT);
    submit();
    expect(await answer).toBe("Hello there");
  });

  it.each(["", "   ", "\t\n"])("does not accept the empty title %j", async (typed) => {
    const answer = dialog.ask(PROMPT);
    type(typed);
    submit();
    expect(dialog.isOpen).toBe(true);
    expect(q("#title-problem").hidden).toBe(false);
    expect(q("#title-problem").textContent).toBe("Enter a title.");
    // Typing again clears the message, and a good title is accepted.
    type("ok");
    expect(q("#title-problem").hidden).toBe(true);
    submit();
    expect(await answer).toBe("ok");
  });

  it.each([
    { name: "Cancel", cancel: () => click("#title-cancel") },
    {
      name: "Escape",
      cancel: () => q("#title-dialog").dispatchEvent(new Event("cancel", { cancelable: true })),
    },
    { name: "a click outside the box", cancel: () => click("#title-dialog") },
  ])("$name resolves with undefined", async ({ cancel }) => {
    const answer = dialog.ask(PROMPT);
    type("typed but not confirmed");
    cancel();
    expect(await answer).toBeUndefined();
    expect(dialog.isOpen).toBe(false);
  });

  it("is reused: the next ask starts from its own initial title and heading", async () => {
    const first = dialog.ask(PROMPT);
    type("ignored");
    click("#title-cancel");
    await first;
    const second = dialog.ask({ heading: "Rename", initial: "Old", confirm: "Rename" });
    expect(q("#title-heading").textContent).toBe("Rename");
    expect(q("#title-ok").textContent).toBe("Rename");
    expect(input().value).toBe("Old");
    expect(q("#title-problem").hidden).toBe(true);
    submit();
    expect(await second).toBe("Old");
  });

  it("cancels the question before when asked again, and when destroyed", async () => {
    const first = dialog.ask(PROMPT);
    const second = dialog.ask({ ...PROMPT, initial: "second" });
    expect(await first).toBeUndefined();
    dialog.destroy();
    expect(await second).toBeUndefined();
    expect(host.querySelector("dialog")).toBeNull();
  });

  it("shows a markup-like initial title as text", () => {
    void dialog.ask({ ...PROMPT, initial: "<b>x</b>" });
    expect(input().value).toBe("<b>x</b>");
    expect(host.querySelector("b")).toBeNull();
  });
});
