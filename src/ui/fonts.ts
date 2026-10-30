/** The font settings of SPEC section 4.7, applied to a page through CSS custom properties. */
export interface FontSettings {
  editor_font_family: string;
  editor_font_size: number;
  button_font_family: string;
  button_font_size: number;
  results_font_family: string;
  results_font_size: number;
}

/**
 * The sizes (points) that the style sheets already use, so a setting equal to its default sets no
 * property and the stylesheet decides (the buttons keep the page's own 13 px, which is the look
 * the default has always had).
 */
const DEFAULT_SIZES = { editor: 13, button: 11, results: 11 } as const;

const GENERIC_FAMILIES = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "ui-rounded",
  "math",
  "emoji",
  "fangsong",
]);

/** What a font family is followed by, so that a font that is not installed falls back. */
const FALLBACK = "system-ui, sans-serif";

/**
 * The CSS value for a family name typed by the user, or undefined for an empty one. A name is
 * quoted as a CSS string (backslashes and quotes escaped, control characters turned into spaces),
 * so nothing typed can be anything but a family name. A generic family (`monospace`) stays a
 * keyword.
 */
export function cssFontFamily(name: string): string | undefined {
  // eslint-disable-next-line no-control-regex
  const clean = name.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (clean === "") return undefined;
  if (GENERIC_FAMILIES.has(clean.toLowerCase())) return `${clean.toLowerCase()}, ${FALLBACK}`;
  const quoted = clean.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${quoted}", ${FALLBACK}`;
}

function setFamily(style: CSSStyleDeclaration, property: string, name: string): void {
  const value = cssFontFamily(name);
  if (value === undefined) style.removeProperty(property);
  else style.setProperty(property, value);
}

function setSize(
  style: CSSStyleDeclaration,
  property: string,
  points: number,
  defaultPoints: number,
): void {
  if (points === defaultPoints) style.removeProperty(property);
  else style.setProperty(property, `${String(points)}pt`);
}

/**
 * Sets (or removes) `--editor-font-family`, `--editor-font-size`, `--button-font-family`,
 * `--button-font-size`, `--results-font-family` and `--results-font-size` on `style`, with
 * `style.setProperty`, never by building CSS text.
 */
export function applyFonts(style: CSSStyleDeclaration, fonts: FontSettings): void {
  setFamily(style, "--editor-font-family", fonts.editor_font_family);
  setSize(style, "--editor-font-size", fonts.editor_font_size, DEFAULT_SIZES.editor);
  setFamily(style, "--button-font-family", fonts.button_font_family);
  setSize(style, "--button-font-size", fonts.button_font_size, DEFAULT_SIZES.button);
  setFamily(style, "--results-font-family", fonts.results_font_family);
  setSize(style, "--results-font-size", fonts.results_font_size, DEFAULT_SIZES.results);
}
