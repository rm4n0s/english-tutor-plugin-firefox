// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { LinkConfirm } from "./link-confirm";

let host: HTMLElement;
let confirm: LinkConfirm;
let trigger: HTMLButtonElement;

beforeEach(() => {
  document.body.replaceChildren();
  trigger = document.createElement("button");
  host = document.createElement("div");
  document.body.append(trigger, host);
  confirm = new LinkConfirm(document, host);
});

const q = (selector: string): HTMLElement => {
  const found = host.querySelector<HTMLElement>(selector);
  if (found === null) throw new Error(`nothing matches ${selector}`);
  return found;
};
const click = (selector: string) =>
  q(selector).dispatchEvent(new MouseEvent("click", { bubbles: true }));
const key = (init: KeyboardEventInit, target: HTMLElement = q("#link-confirm-open")) => {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
};
const URL_TEXT = "https://example.com/some/long/path?with=query&and=more#fragment";

describe("LinkConfirm", () => {
  it("is hidden until asked, then shows the full address", () => {
    expect(confirm.visible).toBe(false);
    void confirm.ask(URL_TEXT);
    expect(confirm.visible).toBe(true);
    expect(q("#link-confirm-url").textContent).toBe(URL_TEXT);
    expect(q("[role=alertdialog]").getAttribute("aria-modal")).toBe("true");
    expect(q("#link-confirm-title").textContent).toBe("Open this link?");
  });

  it("shows an address as text, never as markup", () => {
    void confirm.ask("https://example.com/<b>x</b>");
    expect(q("#link-confirm-url").textContent).toBe("https://example.com/<b>x</b>");
    expect(host.querySelector("b")).toBeNull();
  });

  it.each([
    { name: "Open link", close: () => click("#link-confirm-open"), result: true },
    { name: "Cancel", close: () => click("#link-confirm-cancel"), result: false },
    { name: "Escape", close: () => key({ key: "Escape" }), result: false },
    {
      name: "a click outside the box",
      close: () => click("#link-confirm"),
      result: false,
    },
  ])("$name resolves with $result and closes the box", async ({ close, result }) => {
    const answer = confirm.ask(URL_TEXT);
    close();
    expect(await answer).toBe(result);
    expect(confirm.visible).toBe(false);
  });

  it("a click inside the box does not close it", () => {
    void confirm.ask(URL_TEXT);
    click("#link-confirm-url");
    expect(confirm.visible).toBe(true);
  });

  it("puts the focus on Open link and gives it back to where it was", async () => {
    trigger.focus();
    const answer = confirm.ask(URL_TEXT);
    expect(document.activeElement).toBe(q("#link-confirm-open"));
    click("#link-confirm-cancel");
    await answer;
    expect(document.activeElement).toBe(trigger);
  });

  it("keeps Tab inside the box", () => {
    void confirm.ask(URL_TEXT);
    expect(key({ key: "Tab" }).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(q("#link-confirm-cancel"));
    key({ key: "Tab" }, q("#link-confirm-cancel"));
    expect(document.activeElement).toBe(q("#link-confirm-open"));
    key({ key: "Tab", shiftKey: true }, q("#link-confirm-open"));
    expect(document.activeElement).toBe(q("#link-confirm-cancel"));
  });

  it("asking again cancels the first question", async () => {
    const first = confirm.ask("https://one.example/");
    const second = confirm.ask("https://two.example/");
    expect(await first).toBe(false);
    expect(q("#link-confirm-url").textContent).toBe("https://two.example/");
    click("#link-confirm-open");
    expect(await second).toBe(true);
  });

  it("destroy cancels an open question and removes the box", async () => {
    const answer = confirm.ask(URL_TEXT);
    confirm.destroy();
    expect(await answer).toBe(false);
    expect(host.querySelector("#link-confirm")).toBeNull();
  });
});
