/** Typed settings with the defaults and the validity rules of SPEC section 9. */

/** The editor's share of the width, and the issues list's share of the right column (percent). */
export interface PaneSizes {
  editor: number;
  issues: number;
}

export interface Settings {
  /** The id of the selected LLM, or null for none. */
  selected_llm_id: number | null;
  auto_check: boolean;
  /** Seconds, 1 to 60. */
  auto_check_delay_s: number;
  /** A family name of at most 100 characters; "" means the page's default. */
  editor_font_family: string;
  /** Points, 6 to 48. */
  editor_font_size: number;
  button_font_family: string;
  button_font_size: number;
  results_font_family: string;
  results_font_size: number;
  pane_sizes: PaneSizes;
  /** Whether the icon is shown in text boxes: on by default; it asks on each site before it reads anything (SPEC section 4.11). */
  page_mode: boolean;
  /** Whether text boxes on sites that are on are checked by themselves (on focus and after the typing pause). Default true (SPEC section 4.11). */
  page_mode_auto_check: boolean;
  /** The sites the user made a choice on. A site with no entry is `ask`. */
  page_mode_sites: PageModeSites;
}

/** The user's choice on one site: Turn on, or Never on this site (SPEC section 4.11). */
export type SiteChoice = "on" | "off";

/** Host name (lower case, at most 253 characters) to the choice made on it. */
export type PageModeSites = Record<string, SiteChoice>;

export type SettingKey = keyof Settings;

interface SettingDefinition<T> {
  default: T;
  /** The value for a stored one, or undefined when the stored one is not valid. */
  decode(raw: unknown): T | undefined;
  /**
   * The value to store (plain data). A value that is not a `T` at run time must give something
   * that `decode` refuses, never throw.
   */
  encode(value: T): unknown;
}

const FONT_SIZE_MIN = 6;
const FONT_SIZE_MAX = 48;
const DELAY_MIN = 1;
const DELAY_MAX = 60;
const FAMILY_MAX_LENGTH = 100;
/** The longest host name there is (DNS). */
export const HOST_MAX_LENGTH = 253;

function inRange(raw: unknown, min: number, max: number): number | undefined {
  return typeof raw === "number" && Number.isFinite(raw) && raw >= min && raw <= max
    ? raw
    : undefined;
}

function percent(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 && raw < 100 ? raw : undefined;
}

function fontSize(defaultValue: number): SettingDefinition<number> {
  return {
    default: defaultValue,
    decode: (raw) => inRange(raw, FONT_SIZE_MIN, FONT_SIZE_MAX),
    encode: (value) => value,
  };
}

const fontFamily: SettingDefinition<string> = {
  default: "",
  decode: (raw) => (typeof raw === "string" && raw.length <= FAMILY_MAX_LENGTH ? raw : undefined),
  encode: (value) => value,
};

/** Whether `host` can be a key of `page_mode_sites`. */
export function isSiteHost(host: string): boolean {
  return host !== "" && host.length <= HOST_MAX_LENGTH && host === host.toLowerCase();
}

function siteChoices(raw: unknown): PageModeSites | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const entries: [string, SiteChoice][] = [];
  for (const [host, choice] of Object.entries(raw as Record<string, unknown>)) {
    if (!isSiteHost(host) || (choice !== "on" && choice !== "off")) return undefined;
    entries.push([host, choice]);
  }
  // `fromEntries` makes own properties, so even a host named `__proto__` stays a plain entry.
  return Object.fromEntries(entries);
}

export const SETTING_DEFINITIONS: { readonly [K in SettingKey]: SettingDefinition<Settings[K]> } = {
  selected_llm_id: {
    default: null,
    decode: (raw) =>
      raw === null || (typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0)
        ? raw
        : undefined,
    encode: (value) => value,
  },
  auto_check: {
    default: false,
    decode: (raw) => (typeof raw === "boolean" ? raw : undefined),
    encode: (value) => value,
  },
  auto_check_delay_s: {
    default: 3,
    decode: (raw) => inRange(raw, DELAY_MIN, DELAY_MAX),
    encode: (value) => value,
  },
  editor_font_family: fontFamily,
  editor_font_size: fontSize(13),
  button_font_family: fontFamily,
  button_font_size: fontSize(11),
  results_font_family: fontFamily,
  results_font_size: fontSize(11),
  pane_sizes: {
    default: { editor: 65, issues: 40 },
    // Stored as the array [editor, issues].
    decode: (raw) => {
      if (!Array.isArray(raw) || raw.length !== 2) return undefined;
      const [editor, issues] = raw as unknown[];
      const e = percent(editor);
      const i = percent(issues);
      return e === undefined || i === undefined ? undefined : { editor: e, issues: i };
    },
    encode: (value) => {
      const candidate: unknown = value;
      return typeof candidate === "object" && candidate !== null
        ? [value.editor, value.issues]
        : undefined;
    },
  },
  page_mode: {
    default: true,
    decode: (raw) => (typeof raw === "boolean" ? raw : undefined),
    encode: (value) => value,
  },
  page_mode_auto_check: {
    default: true,
    decode: (raw) => (typeof raw === "boolean" ? raw : undefined),
    encode: (value) => value,
  },
  page_mode_sites: {
    default: {},
    decode: siteChoices,
    // A copy, so that a later change of the caller's object cannot change what is stored.
    encode: (value) => {
      const candidate: unknown = value;
      return typeof candidate === "object" && candidate !== null && !Array.isArray(candidate)
        ? Object.fromEntries(Object.entries(candidate))
        : undefined;
    },
  },
};

export const SETTING_KEYS = Object.keys(SETTING_DEFINITIONS) as SettingKey[];

export function isSettingKey(key: string): key is SettingKey {
  return Object.hasOwn(SETTING_DEFINITIONS, key);
}

/** The value of a setting from its stored form: the stored value if valid, else the default. */
export function decodeSetting<K extends SettingKey>(key: K, raw: unknown): Settings[K] {
  const definition: SettingDefinition<Settings[K]> = SETTING_DEFINITIONS[key];
  const value = definition.decode(raw);
  // A fresh copy of the default, so that callers cannot change it.
  return value ?? structuredClone(definition.default);
}

/** The stored form of a value, or undefined when the value is not valid for the key. */
export function encodeSetting<K extends SettingKey>(
  key: K,
  value: Settings[K],
): { raw: unknown } | undefined {
  const definition: SettingDefinition<Settings[K]> = SETTING_DEFINITIONS[key];
  const raw = definition.encode(value);
  return definition.decode(raw) === undefined ? undefined : { raw };
}
