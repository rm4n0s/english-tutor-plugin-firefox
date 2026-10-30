// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { applyFonts, cssFontFamily, type FontSettings } from "./fonts";

const DEFAULTS: FontSettings = {
  editor_font_family: "",
  editor_font_size: 13,
  button_font_family: "",
  button_font_size: 11,
  results_font_family: "",
  results_font_size: 11,
};

describe("cssFontFamily", () => {
  it.each([
    { name: "", expected: undefined },
    { name: "   ", expected: undefined },
    { name: "Georgia", expected: '"Georgia", system-ui, sans-serif' },
    { name: "  Fira Code ", expected: '"Fira Code", system-ui, sans-serif' },
    { name: "monospace", expected: "monospace, system-ui, sans-serif" },
    { name: "Sans-Serif", expected: "sans-serif, system-ui, sans-serif" },
    // Nothing typed can leave the string or start another declaration.
    { name: 'Evil"; color: red', expected: '"Evil\\"; color: red", system-ui, sans-serif' },
    { name: "a\\b", expected: '"a\\\\b", system-ui, sans-serif' },
    { name: "two\nlines\u0000", expected: '"two lines", system-ui, sans-serif' },
    { name: "Fira Code, monospace", expected: '"Fira Code, monospace", system-ui, sans-serif' },
  ])("turns $name into $expected", ({ name, expected }) => {
    expect(cssFontFamily(name)).toBe(expected);
  });
});

describe("applyFonts", () => {
  const read = (style: CSSStyleDeclaration) =>
    Object.fromEntries(
      [
        "--editor-font-family",
        "--editor-font-size",
        "--button-font-family",
        "--button-font-size",
        "--results-font-family",
        "--results-font-size",
      ].map((p) => [p, style.getPropertyValue(p)]),
    );

  it("sets no property for the defaults", () => {
    const style = document.createElement("div").style;
    applyFonts(style, DEFAULTS);
    expect(Object.values(read(style))).toEqual(["", "", "", "", "", ""]);
  });

  it("sets all six for custom fonts, in points", () => {
    const style = document.createElement("div").style;
    applyFonts(style, {
      editor_font_family: "Georgia",
      editor_font_size: 18,
      button_font_family: "monospace",
      button_font_size: 14,
      results_font_family: "Fira Code",
      results_font_size: 9,
    });
    expect(read(style)).toEqual({
      "--editor-font-family": '"Georgia", system-ui, sans-serif',
      "--editor-font-size": "18pt",
      "--button-font-family": "monospace, system-ui, sans-serif",
      "--button-font-size": "14pt",
      "--results-font-family": '"Fira Code", system-ui, sans-serif',
      "--results-font-size": "9pt",
    });
  });

  it("removes what a setting no longer asks for", () => {
    const style = document.createElement("div").style;
    applyFonts(style, { ...DEFAULTS, editor_font_family: "Georgia", editor_font_size: 20 });
    applyFonts(style, DEFAULTS);
    expect(Object.values(read(style))).toEqual(["", "", "", "", "", ""]);
  });

  it("never writes CSS text", () => {
    const style = document.createElement("div").style;
    applyFonts(style, { ...DEFAULTS, editor_font_family: "x; background: url(//evil)" });
    // The text is inside the quoted name: no other declaration came out of it.
    expect(style.length).toBe(1);
    expect(style.getPropertyValue("background")).toBe("");
    expect(style.getPropertyValue("--editor-font-family")).toBe(
      '"x; background: url(//evil)", system-ui, sans-serif',
    );
  });
});
