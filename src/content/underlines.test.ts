// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WireIssue } from "../core/page-mode/protocol";
import { BoxState } from "./box-state";
import { clearBody, setBody } from "./testing/html";
import { BoxUnderlines, isDarkBackdrop, wavePath } from "./underlines";

afterEach(() => {
  vi.restoreAllMocks();
  clearBody(document);
});

const rect = (left: number, top: number, right: number, bottom: number) =>
  ({ left, top, right, bottom, width: right - left, height: bottom - top }) as DOMRect;

const issue = (
  id: number,
  start: number,
  end: number,
  category: WireIssue["category"] = "grammar",
): WireIssue => ({ id, start, end, category });

/** The text "Yesterday I seen him. He go home." with issues on "I seen" and "He go". */
const TEXT = "Yesterday I seen him. He go home.";
const ISSUES = [issue(1, 10, 16), issue(2, 22, 27), issue(3, 28, 32, "vocabulary")];

function textarea(html = `<textarea id="box">${TEXT}</textarea>`) {
  const box = setBody(document, html) as HTMLTextAreaElement;
  vi.spyOn(box, "getBoundingClientRect").mockReturnValue(rect(100, 100, 400, 250));
  Object.defineProperty(box, "clientWidth", { value: 280, configurable: true });
  Object.defineProperty(box, "clientHeight", { value: 130, configurable: true });
  Object.defineProperty(box, "offsetWidth", { value: 300, configurable: true });
  Object.defineProperty(box, "offsetHeight", { value: 150, configurable: true });
  const layer = document.createElement("div");
  document.documentElement.append(layer);
  const state = new BoxState(1, box, "textarea", "session:x", window);
  const underlines = new BoxUnderlines(document, layer, state, window);
  const show = (issues: readonly WireIssue[]) =>
    state.apply({ revision: 0, status: "checked", issues });
  return { box, layer, state, underlines, show };
}

const spans = (layer: Element) => [...layer.querySelectorAll<HTMLElement>("span.issue")];

describe("isDarkBackdrop", () => {
  it.each([
    {
      name: "a white box",
      html: `<textarea style="background-color: rgb(255, 255, 255)"></textarea>`,
      dark: false,
    },
    {
      name: "a black box",
      html: `<textarea style="background-color: rgb(0, 0, 0)"></textarea>`,
      dark: true,
    },
    {
      name: "a dark grey box",
      html: `<textarea style="background-color: rgb(30, 33, 39)"></textarea>`,
      dark: true,
    },
    {
      name: "a light grey box",
      html: `<textarea style="background-color: rgb(230, 232, 235)"></textarea>`,
      dark: false,
    },
    {
      name: "a transparent box on a dark parent",
      html: `<div style="background-color: rgb(20, 22, 26)"><textarea style="background-color: transparent"></textarea></div>`,
      dark: true,
    },
    {
      name: "a mostly transparent box, so the parent decides",
      html: `<div style="background-color: rgb(255, 255, 255)"><textarea style="background-color: rgba(0, 0, 0, 0.2)"></textarea></div>`,
      dark: false,
    },
    { name: "a page that sets no background", html: `<textarea></textarea>`, dark: false },
  ])("says $dark for $name", ({ html, dark }) => {
    setBody(document, html);
    const box = document.querySelector("textarea")!;
    expect(isDarkBackdrop(window, box)).toBe(dark);
  });
});

describe("wavePath", () => {
  it.each([
    { width: 5, y: 3 },
    { width: 40, y: 3 },
  ])("makes a wave as long as $width", ({ width, y }) => {
    const path = wavePath(width, y);
    expect(path.startsWith(`M0 ${String(y)} Q`)).toBe(true);
    // One smooth curve per half period of 3 px, to the end of the line.
    expect(path.match(/T/g)?.length ?? 0).toBe(Math.ceil((width - 3) / 3));
  });
});

describe("BoxUnderlines for a textarea", () => {
  it("draws a mirror with the box's text and one span per issue, in the category's line style", () => {
    const t = textarea();
    t.show(ISSUES);
    t.underlines.draw(null);
    const found = spans(t.layer);
    expect(found.map((s) => s.textContent)).toEqual(["I seen", "He go", "home"]);
    expect(found.map((s) => s.style.getPropertyValue("text-decoration-style"))).toEqual([
      "wavy",
      "wavy",
      "dashed",
    ]);
    expect(found[0]?.style.getPropertyValue("text-decoration-line")).toBe("underline");
    expect(found[0]?.style.getPropertyValue("text-decoration-skip-ink")).toBe("none");
    expect(found[0]?.style.getPropertyValue("text-decoration-color")).toBe("#d55e00");
    expect(found[2]?.style.getPropertyValue("text-decoration-color")).toBe("#0072b2");
    // The text is transparent: only the underlines show. Nothing is written to the box.
    expect(found[0]?.style.getPropertyValue("color")).toBe("transparent");
    expect(t.box.value).toBe(TEXT);
  });

  it("is in the layer, never in the page: no element is added to or around the box", () => {
    const t = textarea();
    t.show(ISSUES);
    t.underlines.draw(null);
    expect(t.box.parentElement?.children).toHaveLength(1);
    expect(t.layer.children).toHaveLength(1);
  });

  it("ignores the pointer on every element it makes, so typing and clicking go through", () => {
    const t = textarea();
    t.show(ISSUES);
    t.underlines.draw(2);
    for (const element of t.layer.querySelectorAll<HTMLElement>("*")) {
      const own = element.style.getPropertyValue("pointer-events");
      // The spans inherit `none` from the mirror's inner element.
      if (element.tagName !== "SPAN") expect(own, element.tagName).toBe("none");
    }
  });

  it("sets its styles one property at a time through the CSS object model, never a style attribute string", () => {
    const t = textarea();
    t.show(ISSUES);
    t.underlines.draw(null);
    const clip = t.layer.firstElementChild as HTMLElement;
    expect(clip.style.getPropertyPriority("position")).toBe("important");
    expect(clip.style.getPropertyValue("position")).toBe("fixed");
  });

  it("has the box's size, borders, padding and the text styles that decide where lines break", () => {
    const t = textarea(
      `<textarea id="box" style="font-size: 18px; line-height: 27px; letter-spacing: 1px; padding: 8px 10px; white-space: pre-wrap; text-align: center">${TEXT}</textarea>`,
    );
    t.show(ISSUES);
    t.underlines.draw(null);
    const clip = t.layer.firstElementChild as HTMLElement;
    expect(clip.style.getPropertyValue("left")).toBe("100px");
    expect(clip.style.getPropertyValue("top")).toBe("100px");
    // The room of the scroll bar is taken off: the box's own client width, plus its borders.
    expect(clip.style.getPropertyValue("width")).toBe("280px");
    expect(clip.style.getPropertyValue("height")).toBe("130px");
    for (const [name, value] of [
      ["font-size", "18px"],
      ["line-height", "27px"],
      ["letter-spacing", "1px"],
      ["padding-top", "8px"],
      ["padding-left", "10px"],
      ["white-space", "pre-wrap"],
      ["text-align", "center"],
    ] as const) {
      expect(clip.style.getPropertyValue(name), name).toBe(value);
    }
    expect(clip.style.getPropertyValue("color")).toBe("transparent");
  });

  it("follows the box's scroll position and moves with the box", () => {
    const t = textarea();
    t.show(ISSUES);
    t.box.scrollTop = 37;
    t.underlines.draw(null);
    const clip = t.layer.firstElementChild as HTMLElement;
    expect(clip.scrollTop).toBe(37);
    vi.spyOn(t.box, "getBoundingClientRect").mockReturnValue(rect(140, 90, 440, 240));
    t.underlines.draw(null);
    expect(clip.style.getPropertyValue("left")).toBe("140px");
    expect(clip.style.getPropertyValue("top")).toBe("90px");
  });

  it("gives the selected issue the background of its colour at 20%", () => {
    const t = textarea();
    t.show(ISSUES);
    t.underlines.draw(2);
    const [first, second, third] = spans(t.layer);
    expect(first?.style.getPropertyValue("background-color")).toBe("");
    expect(second?.style.getPropertyValue("background-color")).toBe("rgba(213, 94, 0, 0.2)");
    expect(third?.style.getPropertyValue("background-color")).toBe("");
    t.underlines.draw(3);
    expect(spans(t.layer)[2]?.style.getPropertyValue("background-color")).toBe(
      "rgba(0, 114, 178, 0.2)",
    );
    t.underlines.draw(null);
    expect(spans(t.layer).every((s) => s.style.getPropertyValue("background-color") === "")).toBe(
      true,
    );
  });

  it("uses the dark colours on a dark page", () => {
    const t = textarea(
      `<textarea id="box" style="background-color: rgb(30, 33, 39)">${TEXT}</textarea>`,
    );
    t.show(ISSUES);
    t.underlines.draw(null);
    expect(spans(t.layer).map((s) => s.style.getPropertyValue("text-decoration-color"))).toEqual([
      "#ff8a4c",
      "#ff8a4c",
      "#56b4e9",
    ]);
  });

  it("makes the content again only when the text, the issues, the selection or the palette changed", () => {
    const t = textarea();
    t.show(ISSUES);
    t.underlines.draw(null);
    const before = spans(t.layer);
    t.underlines.draw(null);
    expect(spans(t.layer)[0]).toBe(before[0]);
    t.underlines.draw(1);
    expect(spans(t.layer)[0]).not.toBe(before[0]);
    // New issues (an edit moved them, or a check answered): redrawn.
    const drawn = spans(t.layer)[0];
    t.show([issue(1, 11, 17), ...ISSUES.slice(1)]);
    t.underlines.draw(1);
    expect(spans(t.layer)[0]).not.toBe(drawn);
  });

  it("draws nothing when the box has no issues or is not visible, and takes its element away", () => {
    const t = textarea();
    t.show(ISSUES);
    t.underlines.draw(null);
    expect(t.layer.children).toHaveLength(1);
    t.underlines.draw(null, false);
    expect(t.layer.children).toHaveLength(0);
    expect(t.underlines.issueRects).toEqual([]);
    t.underlines.draw(null);
    expect(t.layer.children).toHaveLength(1);
    t.show([]);
    t.underlines.draw(null);
    expect(t.layer.children).toHaveLength(0);
    t.show(ISSUES);
    t.underlines.draw(null);
    t.box.remove();
    t.underlines.draw(null);
    expect(t.layer.children).toHaveLength(0);
  });

  it("skips an issue that does not fit the text (past its end, empty) instead of throwing", () => {
    const t = textarea();
    t.show([issue(1, 10, 16), issue(2, 30, 90), issue(3, 5, 5)]);
    t.underlines.draw(null);
    expect(spans(t.layer).map((s) => s.textContent)).toEqual(["I seen"]);
  });

  it("finds the issue under a point from the rectangles of its spans, clipped to the box", () => {
    const t = textarea();
    t.show(ISSUES);
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(function (this: Element) {
      const id = (this as HTMLElement).dataset.issueId;
      if (id === "1") return [rect(150, 120, 200, 140)] as unknown as DOMRectList;
      if (id === "2") {
        // Two lines: the first sticks out at the right of the box (380), the second at its bottom (230).
        return [rect(350, 120, 430, 140), rect(110, 220, 160, 242)] as unknown as DOMRectList;
      }
      if (id === "3") return [rect(10, 10, 60, 30)] as unknown as DOMRectList;
      return [] as unknown as DOMRectList;
    });
    t.underlines.draw(null);
    expect(t.underlines.issueAt(160, 130)).toBe(1);
    // The part of the line inside the box counts; the part outside it, and the box's own edge, do not.
    expect(t.underlines.issueAt(120, 225)).toBe(2);
    expect(t.underlines.issueAt(120, 235)).toBeUndefined();
    expect(t.underlines.issueAt(370, 130)).toBe(2);
    expect(t.underlines.issueAt(385, 130)).toBeUndefined();
    // The right edge of a rectangle is not in it; an issue outside the box has no rectangle at all.
    expect(t.underlines.issueAt(200, 130)).toBeUndefined();
    expect(t.underlines.rectsOf(3)).toEqual([]);
    expect(t.underlines.rectsOf(2)).toHaveLength(2);
    expect(t.underlines.issueAt(30, 20)).toBeUndefined();
  });
});

describe("BoxUnderlines for editable content", () => {
  const html = `<div id="box" contenteditable="true"><p>Yesterday I seen him.</p><p>He go home.</p></div>`;

  function editable() {
    const box = setBody(document, html);
    vi.spyOn(box, "getBoundingClientRect").mockReturnValue(rect(100, 100, 400, 250));
    Object.defineProperty(box, "clientWidth", { value: 298, configurable: true });
    Object.defineProperty(box, "clientHeight", { value: 148, configurable: true });
    const layer = document.createElement("div");
    document.documentElement.append(layer);
    const state = new BoxState(1, box, "editable", "session:x", window);
    const underlines = new BoxUnderlines(document, layer, state, window);
    return { box, layer, state, underlines };
  }

  it("draws one underline per rectangle of a Range over the issue, with the category's line style", () => {
    const t = editable();
    t.state.apply({
      revision: 0,
      status: "checked",
      // "Yesterday I seen him.\nHe go home.": "I seen" 10..16, "He go" 22..27 (vocabulary), "home" 28..32 (syntax)
      issues: [issue(1, 10, 16), issue(2, 22, 27, "vocabulary"), issue(3, 28, 32, "syntax")],
    });
    const asked: string[] = [];
    vi.spyOn(Range.prototype, "getClientRects").mockImplementation(function (this: Range) {
      asked.push(this.toString());
      return [rect(120, 110, 170, 130)] as unknown as DOMRectList;
    });
    t.underlines.draw(null);
    expect(asked).toEqual(["I seen", "He go", "home"]);
    const clip = t.layer.firstElementChild as HTMLElement;
    const paths = [...clip.querySelectorAll("path")];
    expect(paths).toHaveLength(3);
    expect(paths[0]?.getAttribute("d")?.startsWith("M0 3 Q")).toBe(true);
    expect(paths[0]?.getAttribute("stroke")).toBe("#d55e00");
    expect(paths[1]?.getAttribute("stroke-dasharray")).toBe("5 3");
    expect(paths[1]?.getAttribute("stroke")).toBe("#0072b2");
    expect(paths[2]?.getAttribute("stroke-dasharray")).toBe("2 2");
    expect(paths[2]?.getAttribute("stroke")).toBe("#009e73");
    // Positioned inside the box's clip: relative to its padding box, at the rectangle's bottom.
    const svg = clip.querySelector("svg") as SVGElement;
    expect(svg.style.getPropertyValue("left")).toBe("20px");
    // The line is drawn 4 px above the rectangle's bottom edge (30 px into the box), in a 6 px box.
    expect(svg.style.getPropertyValue("top")).toBe("26px");
    expect(clip.style.getPropertyValue("left")).toBe("100px");
  });

  it("adds a background rectangle for the selected issue only", () => {
    const t = editable();
    t.state.apply({ revision: 0, status: "checked", issues: [issue(1, 10, 16), issue(2, 22, 27)] });
    vi.spyOn(Range.prototype, "getClientRects").mockImplementation(
      () => [rect(120, 110, 170, 130)] as unknown as DOMRectList,
    );
    t.underlines.draw(2);
    const clip = t.layer.firstElementChild as HTMLElement;
    const backgrounds = [...clip.querySelectorAll<HTMLElement>("div")];
    expect(backgrounds).toHaveLength(1);
    expect(backgrounds[0]?.style.getPropertyValue("background-color")).toBe(
      "rgba(213, 94, 0, 0.2)",
    );
    expect(backgrounds[0]?.style.getPropertyValue("width")).toBe("50px");
    t.underlines.draw(null);
    expect(clip.querySelectorAll("div")).toHaveLength(0);
  });

  it("draws an issue that wraps on each of its lines, and keeps nothing outside the box", () => {
    const t = editable();
    t.state.apply({ revision: 0, status: "checked", issues: [issue(1, 10, 16), issue(2, 22, 27)] });
    vi.spyOn(Range.prototype, "getClientRects").mockImplementation(function (this: Range) {
      return this.toString() === "I seen"
        ? ([rect(300, 110, 398, 130), rect(101, 134, 150, 154)] as unknown as DOMRectList)
        : // Scrolled out of the box: above its top edge.
          ([rect(120, 40, 170, 60)] as unknown as DOMRectList);
    });
    t.underlines.draw(null);
    expect(t.layer.querySelectorAll("path")).toHaveLength(2);
    expect(t.underlines.issueRects.map((r) => r.id)).toEqual([1]);
    expect(t.underlines.rectsOf(1)).toHaveLength(2);
    expect(t.underlines.rectsOf(2)).toEqual([]);
    expect(t.underlines.issueAt(310, 120)).toBe(1);
    expect(t.underlines.issueAt(120, 50)).toBeUndefined();
  });

  it("draws nothing for a box with no model of its text, and clears when it has no issue", () => {
    const t = editable();
    t.state.apply({ revision: 0, status: "checked", issues: [issue(1, 10, 16)] });
    vi.spyOn(Range.prototype, "getClientRects").mockImplementation(
      () => [rect(120, 110, 170, 130)] as unknown as DOMRectList,
    );
    t.underlines.draw(null);
    expect(t.layer.children).toHaveLength(1);
    t.underlines.remove();
    expect(t.layer.children).toHaveLength(0);
  });
});
