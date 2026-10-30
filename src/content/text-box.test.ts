// @vitest-environment happy-dom
import { clearBody, setBody } from "./testing/html";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkableTextBox,
  editingHost,
  findTextBox,
  isExcluded,
  isPrivateAutocomplete,
  textBoxKind,
} from "./text-box";

/** A text box of the page: the HTML is parsed from a string in the test only, never in product code. */
function page(html: string): HTMLElement {
  return setBody(document, html);
}

/** Makes every element 200x80 and visible, which happy-dom does not lay out by itself. */
function layOut(width = 200, height = 80): void {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    () => ({ width, height, top: 0, left: 0, right: width, bottom: height }) as DOMRect,
  );
}

beforeEach(() => {
  layOut();
});

afterEach(() => {
  vi.restoreAllMocks();
  clearBody(document);
});

describe("textBoxKind: which elements are text boxes", () => {
  it.each([
    { name: "a textarea", html: "<textarea></textarea>", kind: "textarea" },
    { name: "an input without a type", html: "<input>", kind: "input" },
    { name: "an input of type text", html: '<input type="text">', kind: "input" },
    { name: "an input of type TEXT", html: '<input type="TEXT">', kind: "input" },
    { name: "an input with an empty type", html: '<input type="">', kind: "input" },
    { name: "contenteditable=true", html: '<div contenteditable="true"></div>', kind: "editable" },
    { name: "contenteditable=TRUE", html: '<div contenteditable="TRUE"></div>', kind: "editable" },
    {
      name: "contenteditable=plaintext-only",
      html: '<div contenteditable="plaintext-only"></div>',
      kind: "editable",
    },
    {
      name: "a bare contenteditable attribute",
      html: "<div contenteditable></div>",
      kind: "editable",
    },
    { name: "contenteditable=false", html: '<div contenteditable="false"></div>', kind: undefined },
    { name: "a plain div", html: "<div></div>", kind: undefined },
    { name: "a paragraph", html: "<p>text</p>", kind: undefined },
    { name: "a button", html: "<button>Go</button>", kind: undefined },
    { name: "a select", html: "<select></select>", kind: undefined },
    {
      name: "an unknown contenteditable value",
      html: '<div contenteditable="yes"></div>',
      kind: undefined,
    },
  ])("$name", ({ html, kind }) => {
    expect(textBoxKind(page(html))).toBe(kind);
  });

  it.each([
    "password",
    "email",
    "url",
    "search",
    "number",
    "tel",
    "date",
    "datetime-local",
    "month",
    "week",
    "time",
    "color",
    "range",
    "checkbox",
    "radio",
    "file",
    "hidden",
    "submit",
    "reset",
    "button",
    "image",
    "foo",
  ])("an input of type %s is not a text box", (type) => {
    expect(textBoxKind(page(`<input type="${type}">`))).toBeUndefined();
  });
});

describe("isPrivateAutocomplete: every credential and payment value", () => {
  it.each([
    "current-password",
    "new-password",
    "one-time-code",
    "username",
    "cc-name",
    "cc-given-name",
    "cc-additional-name",
    "cc-family-name",
    "cc-number",
    "cc-exp",
    "cc-exp-month",
    "cc-exp-year",
    "cc-csc",
    "cc-type",
    "CC-NUMBER",
    "  username  ",
    "section-bank billing cc-number",
    "shipping username",
    "webauthn username",
  ])("%s is private", (value) => {
    expect(isPrivateAutocomplete(value.trim().toLowerCase())).toBe(true);
  });

  it.each([
    null,
    "",
    "off",
    "on",
    "name",
    "email",
    "street-address",
    "organization",
    "off nickname",
    "username-not",
    "my-cc-number",
    "ccnumber",
  ])("%s is not", (value) => {
    expect(isPrivateAutocomplete(value)).toBe(false);
  });
});

describe("isExcluded and checkableTextBox: the rules of SPEC section 4.11", () => {
  it.each([
    { name: "a plain textarea", html: "<textarea></textarea>", checked: true },
    { name: "a plain input", html: '<input type="text">', checked: true },
    { name: "a plain editable div", html: '<div contenteditable="true"></div>', checked: true },
    { name: "autocomplete off", html: '<textarea autocomplete="off"></textarea>', checked: true },
    { name: "spellcheck true", html: '<textarea spellcheck="true"></textarea>', checked: true },
    {
      name: "data-english-tutor with another value",
      html: '<div data-english-tutor="on"><textarea></textarea></div>',
      checked: true,
      target: "textarea",
    },
    { name: "readonly", html: "<textarea readonly></textarea>", checked: false },
    { name: "readonly input", html: "<input readonly>", checked: false },
    { name: "disabled", html: "<textarea disabled></textarea>", checked: false },
    { name: "disabled input", html: "<input disabled>", checked: false },
    {
      name: "inside a disabled fieldset",
      html: "<fieldset disabled><textarea></textarea></fieldset>",
      checked: false,
      target: "textarea",
    },
    { name: "spellcheck=false", html: '<textarea spellcheck="false"></textarea>', checked: false },
    {
      name: "spellcheck=false on an editable",
      html: '<div contenteditable="true" spellcheck="false"></div>',
      checked: false,
    },
    {
      name: "inside spellcheck=false",
      html: '<div spellcheck="false"><textarea></textarea></div>',
      checked: false,
      target: "textarea",
    },
    {
      name: "inside spellcheck=false but true itself",
      html: '<div spellcheck="false"><textarea spellcheck="true"></textarea></div>',
      checked: true,
      target: "textarea",
    },
    {
      name: "data-english-tutor=off on itself",
      html: '<textarea data-english-tutor="off"></textarea>',
      checked: false,
    },
    {
      name: "inside data-english-tutor=off",
      html: '<div data-english-tutor="off"><section><textarea></textarea></section></div>',
      checked: false,
      target: "textarea",
    },
    {
      name: "autocomplete=current-password",
      html: '<input autocomplete="current-password">',
      checked: false,
    },
    {
      name: "autocomplete=new-password",
      html: '<input autocomplete="new-password">',
      checked: false,
    },
    {
      name: "autocomplete=one-time-code",
      html: '<input autocomplete="one-time-code">',
      checked: false,
    },
    { name: "autocomplete=username", html: '<input autocomplete="username">', checked: false },
    { name: "autocomplete=cc-number", html: '<input autocomplete="cc-number">', checked: false },
    {
      name: "autocomplete=cc-csc on a textarea",
      html: '<textarea autocomplete="cc-csc"></textarea>',
      checked: false,
    },
    {
      name: "autocomplete=cc-exp on an editable",
      html: '<div contenteditable="true" autocomplete="cc-exp"></div>',
      checked: false,
    },
    { name: "a password input", html: '<input type="password">', checked: false },
    { name: "an email input", html: '<input type="email">', checked: false },
  ])("$name", ({ html, checked, target }) => {
    const root = page(html);
    const element = target === undefined ? root : root.querySelector(target)!;
    const kind = textBoxKind(element);
    const excluded = kind !== undefined && isExcluded(element, kind);
    expect(kind !== undefined && !excluded).toBe(checked);
    expect(checkableTextBox(element, window) !== undefined).toBe(checked);
  });

  describe("visibility and size", () => {
    it.each([
      {
        name: "200 x 80",
        width: 200,
        height: 80,
        display: "block",
        visibility: "visible",
        opacity: "1",
        checked: true,
      },
      {
        name: "exactly 40 x 16",
        width: 40,
        height: 16,
        display: "block",
        visibility: "visible",
        opacity: "1",
        checked: true,
      },
      {
        name: "39 wide",
        width: 39,
        height: 80,
        display: "block",
        visibility: "visible",
        opacity: "1",
        checked: false,
      },
      {
        name: "15 high",
        width: 200,
        height: 15,
        display: "block",
        visibility: "visible",
        opacity: "1",
        checked: false,
      },
      {
        name: "no size",
        width: 0,
        height: 0,
        display: "block",
        visibility: "visible",
        opacity: "1",
        checked: false,
      },
      {
        name: "display none",
        width: 200,
        height: 80,
        display: "none",
        visibility: "visible",
        opacity: "1",
        checked: false,
      },
      {
        name: "visibility hidden",
        width: 200,
        height: 80,
        display: "block",
        visibility: "hidden",
        opacity: "1",
        checked: false,
      },
      {
        name: "visibility collapse",
        width: 200,
        height: 80,
        display: "block",
        visibility: "collapse",
        opacity: "1",
        checked: false,
      },
      {
        name: "opacity 0",
        width: 200,
        height: 80,
        display: "block",
        visibility: "visible",
        opacity: "0",
        checked: false,
      },
      {
        name: "opacity 0.5",
        width: 200,
        height: 80,
        display: "block",
        visibility: "visible",
        opacity: "0.5",
        checked: true,
      },
    ])("$name", ({ width, height, display, visibility, opacity, checked }) => {
      layOut(width, height);
      const box = page("<textarea></textarea>");
      box.style.display = display;
      box.style.visibility = visibility;
      box.style.opacity = opacity;
      expect(checkableTextBox(box, window) !== undefined).toBe(checked);
    });
  });
});

describe("editingHost", () => {
  it.each([
    {
      name: "the host itself",
      html: '<div id="a" contenteditable="true"></div>',
      from: "#a",
      expected: "a",
    },
    {
      name: "a child of the host",
      html: '<div id="a" contenteditable="true"><p><b id="b">x</b></p></div>',
      from: "#b",
      expected: "a",
    },
    {
      name: "the outermost of nested editable elements",
      html: '<div id="a" contenteditable="true"><div id="b" contenteditable="true"><i id="c">x</i></div></div>',
      from: "#c",
      expected: "a",
    },
    {
      name: "a non-editable island inside",
      html: '<div id="a" contenteditable="true"><span id="b" contenteditable="false"><i id="c">x</i></span></div>',
      from: "#c",
      expected: undefined,
    },
    {
      name: "an editable inside a non-editable island",
      html: '<div contenteditable="true"><span contenteditable="false"><em id="d" contenteditable="true">x</em></span></div>',
      from: "#d",
      expected: "d",
    },
    { name: "plain content", html: '<div><p id="p">x</p></div>', from: "#p", expected: undefined },
  ])("$name", ({ html, from, expected }) => {
    page(html);
    const start = document.querySelector(from);
    expect(editingHost(start)?.id).toBe(expected);
  });

  it("is undefined for null", () => {
    expect(editingHost(null)).toBeUndefined();
  });
});

describe("findTextBox", () => {
  it("finds a textarea from its own event target", () => {
    const box = page("<textarea></textarea>");
    expect(findTextBox(box, window)).toEqual({ element: box, kind: "textarea" });
  });

  it("finds the editing host from a text node deep inside it", () => {
    const host = page('<div contenteditable="true"><p><b>bold text</b></p></div>');
    const text = host.querySelector("b")?.firstChild ?? null;
    expect(findTextBox(text, window)).toEqual({ element: host, kind: "editable" });
  });

  it.each([
    { name: "null", target: () => null },
    { name: "the window", target: () => window },
    { name: "a plain element", target: () => page("<p>x</p>") },
    { name: "an excluded field", target: () => page("<textarea readonly></textarea>") },
  ])("finds nothing for $name", ({ target }) => {
    expect(findTextBox(target(), window)).toBeUndefined();
  });
});
