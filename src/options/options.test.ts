// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { OLLAMA_FORBIDDEN_MESSAGE } from "../core/llm";
import { openai } from "../core/llm/testing/canned";
import type { FakeScript } from "../core/llm/testing/fake-fetch";
import { config, mountForTest, type OptionsHarness } from "./testing/harness";

let mounted: OptionsHarness | undefined;

afterEach(() => {
  mounted?.page.destroy();
  mounted = undefined;
});

async function mount(
  script?: FakeScript,
  seed?: (h: OptionsHarness["deps"]) => Promise<void>,
): Promise<OptionsHarness> {
  mounted = await mountForTest(document, script, seed);
  return mounted;
}

function byId(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`no element #${id}`);
  return found;
}

const input = (id: string) => byId(id) as HTMLInputElement;
const control = (id: string) => byId(id) as HTMLInputElement | HTMLButtonElement;
const parentOf = (id: string) => byId(id).parentElement!;

const exists = (id: string) => document.getElementById(id) !== null;
const click = (id: string) => {
  byId(id).dispatchEvent(new MouseEvent("click", { bubbles: true }));
};
const fire = (element: HTMLElement, type: string) => {
  element.dispatchEvent(new Event(type, { bubbles: true }));
};
const type = (id: string, value: string) => {
  const field = input(id);
  field.value = value;
  fire(field, "input");
  fire(field, "change");
};
const choose = (provider: string) => {
  const select = byId("llm-provider") as HTMLSelectElement;
  select.value = provider;
  fire(select, "change");
};
const tick = (id: string, checked: boolean) => {
  const box = input(id);
  box.checked = checked;
  fire(box, "change");
};
const text = (id: string) => byId(id).textContent;
const value = (id: string) => input(id).value;
const checked = (id: string) => input(id).checked;
const disabled = (id: string) => control(id).disabled;
const hidden = (element: HTMLElement) => element.hidden;
const fieldError = (field: string): HTMLElement => {
  const found = document.querySelector<HTMLElement>(`[data-field="${field}"]`);
  if (found === null) throw new Error(`no error line for ${field}`);
  return found;
};
const rows = () => [...document.querySelectorAll<HTMLElement>(".llm-row")];
const rowNames = () => rows().map((row) => row.querySelector(".llm-name")?.firstChild?.textContent);

/** Waits for the page to settle: the store and the fakes answer in a few turns. */
async function settle(check: () => void): Promise<void> {
  const deadline = Date.now() + 2000;
  for (;;) {
    try {
      check();
      return;
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}

function fillNew(overrides: Partial<Record<string, string>> = {}) {
  const fields: Record<string, string> = {
    "llm-name": "Work",
    "llm-model": "gpt-4o",
    "llm-base-url": "https://api.example.com/v1",
    "llm-api-key": "sk-typed-key",
    ...overrides,
  };
  for (const [id, v] of Object.entries(fields)) type(id, v);
}

describe("LLM list", () => {
  it("is empty at first, with the actions that need a row disabled", async () => {
    await mount();
    expect(rows()).toHaveLength(0);
    expect(hidden(byId("llm-empty"))).toBe(false);
    expect(disabled("llm-add")).toBe(false);
    for (const id of ["llm-edit", "llm-delete", "llm-test-selected"])
      expect(disabled(id)).toBe(true);
  });

  it("shows the LLMs by name with 'key stored' and never the key", async () => {
    await mount(undefined, async ({ store }) => {
      await store.createConfig(config({ name: "Zed", api_key: "sk-very-secret", model: "m1" }));
      await store.createConfig(config({ name: "Alpha", api_key: "" }));
      await store.createConfig(
        config({ name: "Beta", provider: "ollama", base_url: "http://localhost:11434" }),
      );
    });
    expect(rowNames()).toEqual(["Alpha", "Beta", "Zed"]);
    const keys = rows().map((row) => row.querySelector(".llm-key")?.textContent);
    expect(keys).toEqual(["no key", "no key needed", "key stored"]);
    expect(document.body.textContent).not.toContain("sk-very-secret");
    for (const input of document.querySelectorAll("input")) {
      expect(input.value).not.toContain("sk-very-secret");
    }
  });

  it("marks the LLM in use and enables the actions for the highlighted row", async () => {
    const h = await mount(undefined, async ({ store }) => {
      const a = await store.createConfig(config({ name: "A" }));
      await store.createConfig(config({ name: "B" }));
      await store.setSetting("selected_llm_id", a.id);
    });
    expect(rows()[0]?.querySelector(".tag")?.textContent).toBe("in use");
    expect(rows()[1]?.querySelector(".tag")).toBeNull();
    rows()[1]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(rows()[1]?.getAttribute("aria-selected")).toBe("true");
    expect(rows()[0]?.getAttribute("aria-selected")).toBe("false");
    for (const id of ["llm-edit", "llm-delete", "llm-test-selected"])
      expect(disabled(id)).toBe(false);
    expect(h.permissions.calls).toEqual([]);
  });

  it("moves the highlight with the arrow keys", async () => {
    await mount(undefined, async ({ store }) => {
      await store.createConfig(config({ name: "A" }));
      await store.createConfig(config({ name: "B" }));
    });
    rows()[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    byId("llm-list").dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );
    expect(rows()[1]?.getAttribute("aria-selected")).toBe("true");
    byId("llm-list").dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );
    expect(rows()[1]?.getAttribute("aria-selected")).toBe("true");
  });

  it("reloads when another page announces a change", async () => {
    const h = await mount();
    await h.deps.store.createConfig(config({ name: "Added elsewhere" }));
    h.otherPage.post("configs-changed");
    await settle(() => {
      expect(rowNames()).toEqual(["Added elsewhere"]);
    });
  });
});

describe("the form: a new LLM", () => {
  it("starts with openai-compatible, an empty Base URL, No thinking ticked and a masked key", async () => {
    await mount();
    click("llm-add");
    expect(text("llm-form-title")).toBe("Add LLM");
    expect(value("llm-provider")).toBe("openai-compatible");
    expect(value("llm-base-url")).toBe("");
    expect(checked("llm-no-thinking")).toBe(true);
    expect(disabled("llm-no-thinking")).toBe(false);
    expect(value("llm-parallel")).toBe("1");
    expect(input("llm-api-key").type).toBe("password");
    expect(text("llm-key-note")).toBe("API keys are stored unencrypted in your Firefox profile.");
    expect(exists("llm-remove-key")).toBe(true);
    expect(hidden(parentOf("llm-remove-key"))).toBe(true);
  });

  it("shows and hides the key", async () => {
    await mount();
    click("llm-add");
    click("llm-show-key");
    expect(input("llm-api-key").type).toBe("text");
    expect(text("llm-show-key")).toBe("Hide");
    click("llm-show-key");
    expect(input("llm-api-key").type).toBe("password");
    expect(text("llm-show-key")).toBe("Show");
  });

  it("saves, asks for the host permission in the click, announces the change and closes", async () => {
    const h = await mount();
    click("llm-add");
    fillNew({ "llm-temperature": "0.5", "llm-timeout": "120", "llm-parallel": "4" });
    click("llm-save");
    // Synchronously, before any await: the permission request for the origin.
    expect(h.permissions.calls).toEqual(["request https://api.example.com/*"]);
    await settle(() => {
      expect(exists("llm-form")).toBe(false);
    });
    const [saved] = await h.deps.store.listConfigs();
    expect(saved).toMatchObject({
      name: "Work",
      provider: "openai-compatible",
      model: "gpt-4o",
      base_url: "https://api.example.com/v1",
      api_key: "sk-typed-key",
      temperature: 0.5,
      timeout_seconds: 120,
      max_parallel: 4,
      no_thinking: true,
    });
    expect(h.otherPage.received).toEqual(["configs-changed"]);
    expect(rowNames()).toEqual(["Work"]);
    expect(text("llm-status")).toBe('Saved "Work".');
  });

  it.each([
    {
      name: "Anthropic with no Base URL: the default origin",
      provider: "anthropic",
      base: "",
      origin: "https://api.anthropic.com/*",
    },
    {
      name: "Ollama",
      provider: "ollama",
      base: "http://localhost:11434",
      origin: "http://localhost:11434/*",
    },
  ])("asks for the origin of $name", async ({ provider, base, origin }) => {
    const h = await mount();
    click("llm-add");
    choose(provider);
    fillNew({ "llm-base-url": base });
    click("llm-save");
    expect(h.permissions.calls).toEqual([`request ${origin}`]);
    await settle(() => {
      expect(exists("llm-form")).toBe(false);
    });
  });

  it("does not store No thinking for Anthropic", async () => {
    const h = await mount();
    click("llm-add");
    choose("anthropic");
    fillNew({ "llm-base-url": "" });
    click("llm-save");
    await settle(() => {
      expect(exists("llm-form")).toBe(false);
    });
    expect((await h.deps.store.listConfigs())[0]).toMatchObject({
      provider: "anthropic",
      no_thinking: false,
    });
  });

  it("keeps the form and the data when the user refuses the host permission", async () => {
    const h = await mount();
    h.permissions.answer = "refuse";
    click("llm-add");
    fillNew();
    click("llm-save");
    await settle(() => {
      expect(hidden(byId("llm-form-warning"))).toBe(false);
    });
    expect(text("llm-form-warning")).toContain("https://api.example.com/v1");
    expect(text("llm-form-warning")).toContain("HostPermissionDenied");
    expect(exists("llm-form")).toBe(true);
    expect(text("llm-form-title")).toBe("Edit LLM");
    expect(text("llm-cancel")).toBe("Close");
    expect(await h.deps.store.listConfigs()).toHaveLength(1);
    expect(rowNames()).toEqual(["Work"]);
    // Saving again edits the same LLM instead of adding a second one.
    h.permissions.answer = "grant";
    click("llm-save");
    await settle(() => {
      expect(exists("llm-form")).toBe(false);
    });
    expect(await h.deps.store.listConfigs()).toHaveLength(1);
  });

  it("cancels without saving", async () => {
    const h = await mount();
    click("llm-add");
    fillNew();
    click("llm-cancel");
    expect(exists("llm-form")).toBe(false);
    expect(await h.deps.store.listConfigs()).toEqual([]);
    expect(h.permissions.calls).toEqual([]);
  });

  it("closes on Escape", async () => {
    await mount();
    click("llm-add");
    byId("llm-name").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(exists("llm-form")).toBe(false);
  });
});

describe("the form: provider switching", () => {
  it("fills Ollama's URL when it is empty and clears it again when switching away", async () => {
    await mount();
    click("llm-add");
    choose("ollama");
    expect(value("llm-base-url")).toBe("http://localhost:11434");
    choose("openai-compatible");
    expect(value("llm-base-url")).toBe("");
  });

  it.each([
    { name: "a URL the user typed", url: "http://gpu-box:11434" },
    { name: "an address of another server", url: "https://api.example.com/v1" },
  ])("keeps $name when switching to and from Ollama", async ({ url }) => {
    await mount();
    click("llm-add");
    type("llm-base-url", url);
    choose("ollama");
    expect(value("llm-base-url")).toBe(url);
    choose("anthropic");
    expect(value("llm-base-url")).toBe(url);
  });

  it("disables the API key for Ollama and does not store one", async () => {
    const h = await mount();
    click("llm-add");
    type("llm-api-key", "sk-typed-key");
    choose("ollama");
    expect(disabled("llm-api-key")).toBe(true);
    expect(disabled("llm-show-key")).toBe(true);
    expect(hidden(byId("llm-key-note"))).toBe(true);
    fillNew({ "llm-base-url": "http://localhost:11434" });
    click("llm-save");
    await settle(() => {
      expect(exists("llm-form")).toBe(false);
    });
    expect((await h.deps.store.listConfigs())[0]?.api_key).toBe("");
  });

  it("enables the key again when leaving Ollama", async () => {
    await mount();
    click("llm-add");
    choose("ollama");
    choose("anthropic");
    expect(disabled("llm-api-key")).toBe(false);
    expect(hidden(byId("llm-key-note"))).toBe(false);
  });

  it("unticks and disables No thinking for Anthropic and brings it back", async () => {
    await mount();
    click("llm-add");
    expect(checked("llm-no-thinking")).toBe(true);
    choose("anthropic");
    expect(checked("llm-no-thinking")).toBe(false);
    expect(disabled("llm-no-thinking")).toBe(true);
    choose("ollama");
    expect(checked("llm-no-thinking")).toBe(true);
    expect(disabled("llm-no-thinking")).toBe(false);
    tick("llm-no-thinking", false);
    choose("anthropic");
    choose("openai-compatible");
    expect(checked("llm-no-thinking")).toBe(false);
  });
});

describe("the form: validation", () => {
  it.each([
    { name: "no name", fields: { "llm-name": "" }, field: "name", message: "Name is required." },
    {
      name: "no model",
      fields: { "llm-model": "" },
      field: "model",
      message: "Model is required.",
    },
    {
      name: "no Base URL",
      fields: { "llm-base-url": "" },
      field: "base_url",
      message: "Base URL is required for this provider.",
    },
    {
      name: "a Base URL that is not an address",
      fields: { "llm-base-url": "localhost:1" },
      field: "base_url",
      message: "Base URL must be an address such as http://localhost:11434.",
    },
    {
      name: "a temperature over 2",
      fields: { "llm-temperature": "2.5" },
      field: "temperature",
      message: "Temperature must be a number between 0 and 2.",
    },
    {
      name: "a temperature that is not a number",
      fields: { "llm-temperature": "warm" },
      field: "temperature",
      message: "Temperature must be a number between 0 and 2.",
    },
    {
      name: "a timeout under 10",
      fields: { "llm-timeout": "5" },
      field: "timeout_seconds",
      message: "Timeout must be between 10 and 3600 seconds, or empty for the default.",
    },
    {
      name: "17 parallel requests",
      fields: { "llm-parallel": "17" },
      field: "max_parallel",
      message: "Parallel requests must be a whole number from 1 to 16.",
    },
    {
      name: "an empty parallel field",
      fields: { "llm-parallel": "" },
      field: "max_parallel",
      message: "Parallel requests must be a whole number from 1 to 16.",
    },
  ])(
    "shows a message next to the field for $name and saves nothing",
    async ({ fields, field, message }) => {
      const h = await mount();
      click("llm-add");
      fillNew(fields);
      click("llm-save");
      const line = fieldError(field);
      expect(line.hidden).toBe(false);
      expect(line.textContent).toBe(message);
      expect(exists("llm-form")).toBe(true);
      expect(await h.deps.store.listConfigs()).toEqual([]);
      expect(h.permissions.calls).toEqual([]);
    },
  );

  it("requires a key for Anthropic", async () => {
    await mount();
    click("llm-add");
    choose("anthropic");
    fillNew({ "llm-base-url": "", "llm-api-key": "" });
    click("llm-save");
    expect(fieldError("api_key").textContent).toBe("API key is required for Anthropic.");
  });

  it("clears the messages when the form is saved correctly", async () => {
    await mount();
    click("llm-add");
    fillNew({ "llm-name": "" });
    click("llm-save");
    expect(fieldError("name").hidden).toBe(false);
    type("llm-name", "Fixed");
    click("llm-save");
    expect(fieldError("name").hidden).toBe(true);
    await settle(() => {
      expect(exists("llm-form")).toBe(false);
    });
  });

  it("shows LLMConfigNameTaken in the form, next to the name", async () => {
    const h = await mount(undefined, async ({ store }) => {
      await store.createConfig(config({ name: "Work" }));
    });
    click("llm-add");
    fillNew();
    click("llm-save");
    await settle(() => {
      expect(fieldError("name").hidden).toBe(false);
    });
    expect(fieldError("name").textContent).toBe("Another LLM already has this name.");
    expect(exists("llm-form")).toBe(true);
    expect(await h.deps.store.listConfigs()).toHaveLength(1);
    expect(h.otherPage.received).toEqual([]);
  });
});

describe("the form: privacy and key notes", () => {
  it.each([
    {
      name: "a remote server",
      provider: "openai-compatible",
      url: "https://api.example.com/v1",
      note: "The text you write is sent to api.example.com when you check it, ask for an explanation or ask for alternatives.",
    },
    {
      name: "Anthropic without a Base URL",
      provider: "anthropic",
      url: "",
      note: "The text you write is sent to Anthropic's server (api.anthropic.com) when you check it, ask for an explanation or ask for alternatives.",
    },
    { name: "localhost", provider: "ollama", url: "http://localhost:11434", note: null },
    {
      name: "127.0.0.1",
      provider: "openai-compatible",
      url: "http://127.0.0.1:8080/v1",
      note: null,
    },
    { name: "[::1]", provider: "openai-compatible", url: "http://[::1]:8080/v1", note: null },
    { name: "no address yet", provider: "openai-compatible", url: "", note: null },
  ])("$name", async ({ provider, url, note }) => {
    await mount();
    click("llm-add");
    choose(provider);
    type("llm-base-url", url);
    const element = byId("llm-privacy-note");
    expect(element.hidden).toBe(note === null);
    if (note !== null) expect(element.textContent).toBe(note);
  });

  it("follows the Base URL as it is typed", async () => {
    await mount();
    click("llm-add");
    type("llm-base-url", "https://api.example.com");
    expect(byId("llm-privacy-note").hidden).toBe(false);
    type("llm-base-url", "http://localhost:8080");
    expect(byId("llm-privacy-note").hidden).toBe(true);
  });
});

describe("the form: editing", () => {
  const SECRET = "sk-stored-secret";
  const seed = async ({ store }: OptionsHarness["deps"]) => {
    await store.createConfig(
      config({ name: "Work", api_key: SECRET, temperature: 0.7, timeout_seconds: 90 }),
    );
  };

  async function edit() {
    const h = await mount(undefined, seed);
    rows()[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    click("llm-edit");
    return h;
  }

  it("fills the fields, masks the key and never shows the stored key", async () => {
    await edit();
    expect(text("llm-form-title")).toBe("Edit LLM");
    expect(value("llm-name")).toBe("Work");
    expect(value("llm-model")).toBe("gpt-4o");
    expect(value("llm-base-url")).toBe("http://localhost:8080/v1");
    expect(value("llm-temperature")).toBe("0.7");
    expect(value("llm-timeout")).toBe("90");
    expect(value("llm-api-key")).toBe("");
    expect(input("llm-api-key").placeholder).toBe("Key stored (leave empty to keep it)");
    expect(hidden(parentOf("llm-remove-key"))).toBe(false);
    expect(document.body.textContent).not.toContain(SECRET);
  });

  it.each([
    { name: "an empty key field keeps the stored key", typed: "", remove: false, expected: SECRET },
    { name: "a typed key replaces it", typed: "sk-new", remove: false, expected: "sk-new" },
    { name: "Remove key removes it", typed: "", remove: true, expected: "" },
    { name: "Remove key wins over a typed key", typed: "sk-new", remove: true, expected: "" },
  ])("$name", async ({ typed, remove, expected }) => {
    const h = await edit();
    type("llm-api-key", typed);
    if (remove) tick("llm-remove-key", true);
    type("llm-model", "gpt-4o-mini");
    click("llm-save");
    await settle(() => {
      expect(exists("llm-form")).toBe(false);
    });
    const [saved] = await h.deps.store.listConfigs();
    expect(saved).toMatchObject({ api_key: expected, model: "gpt-4o-mini" });
    expect(h.permissions.calls).toEqual(["request http://localhost:8080/*"]);
  });

  it("disables the key field while Remove key is ticked", async () => {
    await edit();
    tick("llm-remove-key", true);
    expect(disabled("llm-api-key")).toBe(true);
    tick("llm-remove-key", false);
    expect(disabled("llm-api-key")).toBe(false);
  });

  it("keeps the same LLM when its name is saved unchanged", async () => {
    const h = await edit();
    click("llm-save");
    await settle(() => {
      expect(exists("llm-form")).toBe(false);
    });
    expect(await h.deps.store.listConfigs()).toHaveLength(1);
  });

  it("opens with a double click on a row", async () => {
    await mount(undefined, seed);
    rows()[0]?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(text("llm-form-title")).toBe("Edit LLM");
  });

  it("a key typed for an LLM that had none is stored, and a stored key is not offered for Ollama", async () => {
    const h = await mount(undefined, async ({ store }) => {
      await store.createConfig(config({ name: "Bare", api_key: "" }));
    });
    rows()[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    click("llm-edit");
    expect(hidden(parentOf("llm-remove-key"))).toBe(true);
    type("llm-api-key", "sk-first");
    click("llm-save");
    await settle(() => {
      expect(exists("llm-form")).toBe(false);
    });
    expect((await h.deps.store.listConfigs())[0]?.api_key).toBe("sk-first");
  });
});

describe("Test connection", () => {
  it("in the form: asks for the permission in the click, sends the test prompt, shows the time", async () => {
    const h = await mount();
    click("llm-add");
    fillNew({ "llm-name": "" }); // no name is needed
    click("llm-test");
    expect(h.permissions.calls[0]).toBe("request https://api.example.com/*");
    await settle(() => {
      expect(text("llm-form-result")).toMatch(/^Connection works \(\d+ ms\)\.$/);
    });
    expect(h.fetch.requests).toHaveLength(1);
    expect(h.fetch.requests[0]?.url).toBe("https://api.example.com/v1/chat/completions");
    expect(h.fetch.requests[0]?.headers.authorization).toBe("Bearer sk-typed-key");
    expect(h.fetch.requests[0]?.body.messages).toEqual([
      { role: "user", content: "Reply with the single word: ok" },
    ]);
    // Testing saves nothing and announces nothing.
    expect(await h.deps.store.listConfigs()).toEqual([]);
    expect(h.otherPage.received).toEqual([]);
  });

  it("in the form: shows the failure with the status and the provider's message", async () => {
    await mount({ kind: "json", status: 401, body: openai.error("Invalid API key") });
    click("llm-add");
    fillNew();
    click("llm-test");
    await settle(() => {
      expect(text("llm-form-result")).toContain("Test failed");
    });
    expect(text("llm-form-result")).toBe(
      "Test failed: The request to Work failed (HTTP 401): Invalid API key",
    );
    expect(byId("llm-form-result").className).toContain("error");
  });

  it("in the form: shows the Ollama 403 message", async () => {
    await mount({ kind: "text", status: 403, body: "" });
    click("llm-add");
    choose("ollama");
    fillNew({ "llm-base-url": "http://localhost:11434" });
    click("llm-test");
    await settle(() => {
      expect(text("llm-form-result")).toContain(OLLAMA_FORBIDDEN_MESSAGE);
    });
  });

  it("in the form: validates the typed values and asks for no permission when they are wrong", async () => {
    const h = await mount();
    click("llm-add");
    fillNew({ "llm-model": "" });
    click("llm-test");
    expect(fieldError("model").hidden).toBe(false);
    expect(h.permissions.calls).toEqual([]);
    expect(h.fetch.requests).toEqual([]);
  });

  it("in the form: warns when the permission is refused and reports that the request cannot go out", async () => {
    const h = await mount();
    h.permissions.answer = "refuse";
    click("llm-add");
    fillNew();
    click("llm-test");
    await settle(() => {
      expect(text("llm-form-result")).toContain("Test failed");
    });
    expect(hidden(byId("llm-form-warning"))).toBe(false);
    expect(h.fetch.requests).toEqual([]);
  });

  it("in the form: drops a result that arrives after the form was closed", async () => {
    const h = await mount({ kind: "json", delayMs: 30, body: openai.json({ content: "ok" }) });
    click("llm-add");
    fillNew();
    click("llm-test");
    click("llm-cancel");
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(exists("llm-form")).toBe(false);
    expect(text("llm-status")).toBe("");
    expect(h.logged.filter((line) => line.includes("failed"))).toEqual([]);
  });

  it("for the selected row: uses the stored values and key", async () => {
    const h = await mount(undefined, async ({ store }) => {
      await store.createConfig(config({ name: "Work", api_key: "sk-stored" }));
    });
    rows()[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    click("llm-test-selected");
    expect(h.permissions.calls[0]).toBe("request http://localhost:8080/*");
    await settle(() => {
      expect(text("llm-status")).toMatch(/^"Work": connection works \(\d+ ms\)\.$/);
    });
    expect(h.fetch.requests[0]?.headers.authorization).toBe("Bearer sk-stored");
  });

  it("for the selected row: shows the failure", async () => {
    await mount({ kind: "network-error" }, async ({ store }) => {
      await store.createConfig(config({ name: "Work" }));
    });
    rows()[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    click("llm-test-selected");
    await settle(() => {
      expect(text("llm-status")).toContain('Test of "Work" failed');
    });
    expect(byId("llm-status").className).toContain("error");
  });
});

describe("Delete", () => {
  const seed = async ({ store }: OptionsHarness["deps"]) => {
    const a = await store.createConfig(config({ name: "A", base_url: "http://localhost:8080/v1" }));
    await store.createConfig(config({ name: "B", base_url: "http://localhost:8080/v2" }));
    await store.createConfig(config({ name: "C", base_url: "https://other.example.com/v1" }));
    await store.setSetting("selected_llm_id", a.id);
  };

  function pick(h: OptionsHarness, name: string) {
    const row = rows().find((r) => r.querySelector(".llm-name")?.firstChild?.textContent === name);
    row?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return h;
  }

  it("asks for a confirmation and keeps the LLM when it is cancelled", async () => {
    const h = pick(await mount(undefined, seed), "A");
    click("llm-delete");
    expect(hidden(byId("llm-confirm"))).toBe(false);
    expect(text("llm-confirm-text")).toContain('Delete "A"?');
    click("llm-confirm-cancel");
    expect(hidden(byId("llm-confirm"))).toBe(true);
    expect(await h.deps.store.listConfigs()).toHaveLength(3);
  });

  it("deletes the LLM and announces it", async () => {
    const h = pick(await mount(undefined, seed), "C");
    click("llm-delete");
    click("llm-confirm-delete");
    await settle(() => {
      expect(rowNames()).toEqual(["A", "B"]);
    });
    expect(h.otherPage.received).toEqual(["configs-changed"]);
    expect(text("llm-status")).toBe('Deleted "C".');
    expect(await h.deps.store.getSetting("selected_llm_id")).not.toBeNull();
  });

  it("selects the first remaining LLM by name when the selected one is deleted", async () => {
    const h = pick(await mount(undefined, seed), "A");
    click("llm-delete");
    click("llm-confirm-delete");
    await settle(() => {
      expect(rowNames()).toEqual(["B", "C"]);
    });
    const remaining = await h.deps.store.listConfigs();
    expect(await h.deps.store.getSetting("selected_llm_id")).toBe(remaining[0]?.id);
    expect(h.otherPage.received).toEqual(["configs-changed", "settings-changed"]);
  });

  it("selects none when the last LLM is deleted", async () => {
    const h = await mount(undefined, async ({ store }) => {
      const only = await store.createConfig(config({ name: "Only" }));
      await store.setSetting("selected_llm_id", only.id);
    });
    pick(h, "Only");
    click("llm-delete");
    click("llm-confirm-delete");
    await settle(() => {
      expect(rowNames()).toEqual([]);
    });
    expect(await h.deps.store.getSetting("selected_llm_id")).toBeNull();
  });

  it.each([
    { name: "A", removes: false, why: "B uses the same origin" },
    { name: "C", removes: true, why: "no other LLM uses its origin" },
  ])("deleting $name: permission removed is $removes ($why)", async ({ name, removes }) => {
    const h = await mount(undefined, seed);
    h.permissions.granted.add("http://localhost:8080/*");
    h.permissions.granted.add("https://other.example.com/*");
    pick(h, name);
    click("llm-delete");
    click("llm-confirm-delete");
    await settle(() => {
      expect(rowNames()).not.toContain(name);
    });
    const removed = h.permissions.calls.filter((call) => call.startsWith("remove"));
    expect(removed).toEqual(
      removes
        ? [`remove ${name === "C" ? "https://other.example.com/*" : "http://localhost:8080/*"}`]
        : [],
    );
  });

  it("removes the default Anthropic origin with the last Anthropic LLM without a Base URL", async () => {
    const h = await mount(undefined, async ({ store }) => {
      await store.createConfig(
        config({ name: "Claude", provider: "anthropic", base_url: "", api_key: "k" }),
      );
    });
    h.permissions.granted.add("https://api.anthropic.com/*");
    pick(h, "Claude");
    click("llm-delete");
    click("llm-confirm-delete");
    await settle(() => {
      expect(rowNames()).toEqual([]);
    });
    expect(h.permissions.calls).toContain("remove https://api.anthropic.com/*");
  });
});

describe("General section", () => {
  it("shows the defaults", async () => {
    await mount();
    expect(checked("auto-check")).toBe(false);
    expect(value("auto-check-delay")).toBe("3");
    expect(disabled("auto-check-delay")).toBe(true);
    expect(value("font-editor-family")).toBe("");
    expect([
      value("font-editor-size"),
      value("font-button-size"),
      value("font-results-size"),
    ]).toEqual(["13", "11", "11"]);
  });

  it("shows what is stored", async () => {
    await mount(undefined, async ({ store }) => {
      await store.setSetting("auto_check", true);
      await store.setSetting("auto_check_delay_s", 7);
      await store.setSetting("results_font_family", "Georgia");
      await store.setSetting("results_font_size", 14);
    });
    expect(checked("auto-check")).toBe(true);
    expect(value("auto-check-delay")).toBe("7");
    expect(disabled("auto-check-delay")).toBe(false);
    expect(value("font-results-family")).toBe("Georgia");
    expect(value("font-results-size")).toBe("14");
  });

  it("enables the delay with auto-check, saves at once and announces it", async () => {
    const h = await mount();
    tick("auto-check", true);
    expect(disabled("auto-check-delay")).toBe(false);
    type("auto-check-delay", "10");
    await settle(() => {
      expect(h.otherPage.received).toEqual(["settings-changed", "settings-changed"]);
    });
    expect(await h.deps.store.getSetting("auto_check")).toBe(true);
    expect(await h.deps.store.getSetting("auto_check_delay_s")).toBe(10);
    tick("auto-check", false);
    expect(disabled("auto-check-delay")).toBe(true);
  });

  it.each([
    {
      id: "font-editor-family",
      value: " Fira Sans ",
      key: "editor_font_family",
      expected: "Fira Sans",
    },
    { id: "font-editor-size", value: "16", key: "editor_font_size", expected: 16 },
    { id: "font-button-family", value: "Arial", key: "button_font_family", expected: "Arial" },
    { id: "font-button-size", value: "9", key: "button_font_size", expected: 9 },
    {
      id: "font-results-family",
      value: "Georgia",
      key: "results_font_family",
      expected: "Georgia",
    },
    { id: "font-results-size", value: "48", key: "results_font_size", expected: 48 },
  ] as const)("saves $id", async ({ id, value: typed, key, expected }) => {
    const h = await mount();
    type(id, typed);
    await settle(() => {
      expect(h.otherPage.received).toContain("settings-changed");
    });
    expect(await h.deps.store.getSetting(key)).toBe(expected);
  });

  it.each([
    {
      id: "auto-check-delay",
      bad: "0",
      key: "auto_check_delay_s",
      message: "The delay must be a number from 1 to 60 seconds.",
      before: 3,
    },
    {
      id: "auto-check-delay",
      bad: "61",
      key: "auto_check_delay_s",
      message: "The delay must be a number from 1 to 60 seconds.",
      before: 3,
    },
    {
      id: "auto-check-delay",
      bad: "",
      key: "auto_check_delay_s",
      message: "The delay must be a number from 1 to 60 seconds.",
      before: 3,
    },
    {
      id: "font-editor-size",
      bad: "5",
      key: "editor_font_size",
      message: "The size must be a number from 6 to 48 points.",
      before: 13,
    },
    {
      id: "font-button-size",
      bad: "49",
      key: "button_font_size",
      message: "The size must be a number from 6 to 48 points.",
      before: 11,
    },
    {
      id: "font-results-family",
      bad: "x".repeat(101),
      key: "results_font_family",
      message: "A font family is at most 100 characters.",
      before: "",
    },
  ] as const)(
    "refuses $bad for $id with a message and saves nothing",
    async ({ id, bad, key, message, before }) => {
      const h = await mount();
      type(id, bad);
      await settle(() => {
        const shown = [...document.querySelectorAll<HTMLElement>("#general .message.error")].filter(
          (line) => !line.hidden,
        );
        expect(shown.map((line) => line.textContent)).toEqual([message]);
      });
      expect(await h.deps.store.getSetting(key)).toBe(before);
      expect(h.otherPage.received).toEqual([]);
    },
  );

  it("clears the message once the value is valid", async () => {
    await mount();
    type("auto-check-delay", "0");
    await settle(() => {
      expect(byId("auto-check-delay-error").hidden).toBe(false);
    });
    type("auto-check-delay", "5");
    await settle(() => {
      expect(byId("auto-check-delay-error").hidden).toBe(true);
    });
  });

  it("follows a settings change made by another page", async () => {
    const h = await mount();
    await h.deps.store.setSetting("editor_font_size", 20);
    h.otherPage.post("settings-changed");
    await settle(() => {
      expect(value("font-editor-size")).toBe("20");
    });
  });
});

describe("failures", () => {
  it("shows a store failure in the banner", async () => {
    const h = await mount();
    h.deps.store.close();
    h.otherPage.post("configs-changed");
    await settle(() => {
      expect(hidden(byId("options-error"))).toBe(false);
    });
    expect(text("options-error")).not.toBe("");
  });
});
