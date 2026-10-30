import { describe, expect, it } from "vitest";
import { AppError } from "../errors";
import { requestResult } from "./idb";
import { SETTING_KEYS, type Settings } from "./settings";
import { freshStore } from "./testing/db";

const caught = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (e: unknown) => e,
  );

const DEFAULTS: Settings = {
  selected_llm_id: null,
  auto_check: false,
  auto_check_delay_s: 3,
  editor_font_family: "",
  editor_font_size: 13,
  button_font_family: "",
  button_font_size: 11,
  results_font_family: "",
  results_font_size: 11,
  pane_sizes: { editor: 65, issues: 40 },
  page_mode: false,
  page_mode_sites: {},
};

/** Writes a raw value, bypassing the setter, as an older or damaged database might hold it. */
async function writeRaw(db: IDBDatabase, key: string, value: unknown): Promise<void> {
  const tx = db.transaction("settings", "readwrite");
  await requestResult(tx.objectStore("settings").put({ key, value }));
}

describe("Store settings", () => {
  it("has a default for every key of SPEC section 9", () => {
    expect([...SETTING_KEYS].sort()).toEqual(Object.keys(DEFAULTS).sort());
    expect(SETTING_KEYS).toHaveLength(12);
  });

  it("returns the defaults on an empty database", async () => {
    const { store } = await freshStore();
    expect(await store.getSettings()).toEqual(DEFAULTS);
    for (const key of SETTING_KEYS) {
      expect(await store.getSetting(key)).toEqual(DEFAULTS[key]);
    }
  });

  it("returns a new default object each time", async () => {
    const { store } = await freshStore();
    const first = await store.getSetting("pane_sizes");
    first.editor = 1;
    expect(await store.getSetting("pane_sizes")).toEqual(DEFAULTS.pane_sizes);
  });

  describe.each([
    { key: "selected_llm_id" as const, value: 7 },
    { key: "selected_llm_id" as const, value: null },
    { key: "auto_check" as const, value: true },
    { key: "auto_check_delay_s" as const, value: 1 },
    { key: "auto_check_delay_s" as const, value: 60 },
    { key: "editor_font_family" as const, value: "Fira Code" },
    { key: "editor_font_family" as const, value: "x".repeat(100) },
    { key: "editor_font_size" as const, value: 6 },
    { key: "editor_font_size" as const, value: 48 },
    { key: "button_font_family" as const, value: "Arial" },
    { key: "button_font_size" as const, value: 20 },
    { key: "results_font_family" as const, value: "Georgia" },
    { key: "results_font_size" as const, value: 12.5 },
    { key: "pane_sizes" as const, value: { editor: 50, issues: 30.5 } },
    { key: "page_mode" as const, value: true },
    {
      key: "page_mode_sites" as const,
      value: { "example.com": "on", "a.b.example.org": "off" } as Record<string, "on" | "off">,
    },
    {
      key: "page_mode_sites" as const,
      value: { ["x".repeat(253)]: "on" } as Record<string, "on" | "off">,
    },
    { key: "page_mode_sites" as const, value: {} as Record<string, "on" | "off"> },
  ])("set and get $key = $value", ({ key, value }) => {
    it("round-trips and changes no other setting", async () => {
      const { store } = await freshStore();
      await store.setSetting(key, value);
      expect(await store.getSetting(key)).toEqual(value);
      expect(await store.getSettings()).toEqual({ ...DEFAULTS, [key]: value });
    });
  });

  it("overwrites an earlier value", async () => {
    const { store } = await freshStore();
    await store.setSetting("auto_check", true);
    await store.setSetting("auto_check", false);
    expect(await store.getSetting("auto_check")).toBe(false);
  });

  it("stores pane_sizes as the array [editor, issues]", async () => {
    const { store, db } = await freshStore();
    await store.setSetting("pane_sizes", { editor: 70, issues: 35 });
    const row: unknown = await requestResult(
      db.transaction("settings").objectStore("settings").get("pane_sizes"),
    );
    expect(row).toEqual({ key: "pane_sizes", value: [70, 35] });
  });

  describe.each<{ key: keyof Settings; invalid: unknown[]; invalidSet?: unknown[] }>([
    { key: "selected_llm_id", invalid: ["3", 0, -1, 1.5, NaN, true, {}, undefined] },
    { key: "auto_check", invalid: ["true", 1, 0, null] },
    { key: "auto_check_delay_s", invalid: [0, 0.5, 61, -3, NaN, Infinity, "3", null] },
    { key: "editor_font_family", invalid: [12, null, true, "x".repeat(101)] },
    { key: "button_font_family", invalid: [12, null, "x".repeat(101)] },
    { key: "results_font_family", invalid: [12, null, "x".repeat(101)] },
    { key: "editor_font_size", invalid: [5, 5.9, 49, 0, -13, NaN, Infinity, "13", null] },
    { key: "button_font_size", invalid: [5, 49, NaN, "11", null] },
    { key: "results_font_size", invalid: [5, 49, NaN, "11", null] },
    { key: "page_mode", invalid: ["true", 1, 0, null, []] },
    {
      key: "page_mode_sites",
      invalid: [
        "example.com",
        ["example.com"],
        [],
        { "example.com": "ask" },
        { "example.com": "later" },
        { "example.com": true },
        { "example.com": null },
        { "": "on" },
        { ["x".repeat(254)]: "on" },
        { "Example.COM": "on" },
        { "example.com": "on", "other.org": 5 },
        null,
      ],
    },
    {
      key: "pane_sizes",
      invalid: [
        [65],
        [65, 40, 10],
        [0, 40],
        [65, 100],
        [-5, 40],
        [NaN, 40],
        ["65", "40"],
        { editor: 65, issues: 40 },
        "[65,40]",
        null,
        65,
      ],
      invalidSet: [
        { editor: 0, issues: 40 },
        { editor: 65, issues: 100 },
        { editor: NaN, issues: 40 },
        { editor: 65 },
        [65, 40],
        null,
        65,
      ],
    },
  ])("a stored $key that is invalid", ({ key, invalid, invalidSet = invalid }) => {
    it.each(invalid.map((value) => ({ value })))(
      "reads as the default for $value",
      async ({ value }) => {
        const { store, db } = await freshStore();
        await writeRaw(db, key, value);
        expect(await store.getSetting(key)).toEqual(DEFAULTS[key]);
        expect(await store.getSettings()).toEqual(DEFAULTS);
      },
    );

    it.each(invalidSet.map((value) => ({ value })))(
      "is refused by the setter for $value",
      async ({ value }) => {
        const { store } = await freshStore();
        const err = await caught(store.setSetting(key, value as never));
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).hasRoute("Store.setSetting->SettingInvalid")).toBe(true);
        expect((err as AppError).metadata).toEqual({ key });
        expect(await store.getSettings()).toEqual(DEFAULTS);
      },
    );
  });

  it("copies the site choices it stores", async () => {
    const { store } = await freshStore();
    const sites: Record<string, "on" | "off"> = { "example.com": "on" };
    await store.setSetting("page_mode_sites", sites);
    sites["other.org"] = "off";
    expect(await store.getSetting("page_mode_sites")).toEqual({ "example.com": "on" });
  });

  it("keeps a host named __proto__ as a plain entry", async () => {
    const { store } = await freshStore();
    await store.setSetting("page_mode_sites", Object.fromEntries([["__proto__", "off"]]));
    const read = await store.getSetting("page_mode_sites");
    expect(Object.keys(read)).toEqual(["__proto__"]);
    expect(Object.getPrototypeOf(read)).toBe(Object.prototype);
  });

  it("drops the key the first draft of page mode used (no release shipped it)", async () => {
    const { store, db } = await freshStore();
    await writeRaw(db, "page_mode_off_hosts", ["example.com"]);
    expect(await store.getSettings()).toEqual(DEFAULTS);
  });

  it("ignores stored keys it does not know", async () => {
    const { store, db } = await freshStore();
    await writeRaw(db, "from_a_future_version", 1);
    expect(await store.getSettings()).toEqual(DEFAULTS);
  });

  it("keeps a valid setting when another one is invalid", async () => {
    const { store, db } = await freshStore();
    await store.setSetting("auto_check", true);
    await writeRaw(db, "editor_font_size", 99);
    expect(await store.getSettings()).toEqual({ ...DEFAULTS, auto_check: true });
  });

  it("refuses a key it does not know", async () => {
    const { store } = await freshStore();
    const err = await caught(store.setSetting("nope" as never, 1 as never));
    expect((err as AppError).hasRoute("Store.setSetting->SettingInvalid")).toBe(true);
  });
});
