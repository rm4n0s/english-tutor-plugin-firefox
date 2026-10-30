// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { AppError } from "../core/errors";
import { config, mountForTest, type OptionsHarness } from "./testing/harness";
import type { FakePageModePermission } from "../platform/testing/fake-page-mode";
import {
  ACCESS_WITHDRAWN,
  AUTO_CHECK_LABEL,
  OFFER_LABEL,
  PERMISSION_DENIED_MESSAGE,
} from "./page-mode-section";

let mounted: OptionsHarness | undefined;

afterEach(() => {
  mounted?.page.destroy();
  mounted = undefined;
});

async function mount(seed?: (h: OptionsHarness["deps"]) => Promise<void>): Promise<OptionsHarness> {
  mounted = await mountForTest(document, undefined, seed);
  return mounted;
}

const byId = (id: string): HTMLElement => {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`no element #${id}`);
  return found;
};
const box = () => byId("page-mode") as HTMLInputElement;
const note = () => byId("page-mode-note").textContent;
const hostRows = () =>
  [...document.querySelectorAll("#page-mode-sites .host-row")].map(
    (row) => row.querySelector(".host-name")?.textContent,
  );
const siteRows = () =>
  [...document.querySelectorAll("#page-mode-sites .host-row")].map((row) => [
    row.querySelector(".host-name")?.textContent,
    row.querySelector(".site-state")?.textContent,
  ]);

const ASKS = "English Tutor asks on each site before it reads anything there.";

/** The user clicks the box: the browser toggles it, then the click handler runs. */
function clickBox(): void {
  box().click();
}

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

describe("the page-mode box", () => {
  it("is on by default, with its label, its note and no sites", async () => {
    await mount();
    expect(box().checked).toBe(true);
    expect(OFFER_LABEL).toBe("Show the English Tutor icon in text boxes on websites");
    expect(byId("page-mode").closest("label")?.textContent).toContain(OFFER_LABEL);
    expect(note()).toBe(
      "English Tutor asks on each site before it reads anything there. What you type on a site you turn on is sent to the server of the selected LLM to be checked. Add an LLM first.",
    );
    expect(byId("page-mode-sites-empty").hidden).toBe(false);
    expect(byId("page-mode-sites").hidden).toBe(true);
    expect(byId("page-mode-error").hidden).toBe(true);
    // Access came with the installation: no notice, and nothing was asked.
    expect(byId("page-mode-access").hidden).toBe(true);
  });

  it.each([
    {
      name: "a server on the internet",
      llm: { base_url: "https://api.example.com/v1" },
      expected: `${ASKS} What you type on a site you turn on is sent to api.example.com to be checked.`,
    },
    {
      name: "Anthropic without a base URL",
      llm: { provider: "anthropic" as const, base_url: "", api_key: "k", no_thinking: false },
      expected: `${ASKS} What you type on a site you turn on is sent to Anthropic's server (api.anthropic.com) to be checked.`,
    },
    {
      name: "a server on this computer",
      llm: { provider: "ollama" as const, base_url: "http://localhost:11434" },
      expected: `${ASKS} What you type on a site you turn on is checked by localhost:11434, on this computer.`,
    },
  ])("names the server of the selected LLM: $name", async ({ llm, expected }) => {
    await mount(async ({ store }) => {
      const saved = await store.createConfig(config(llm));
      await store.setSetting("selected_llm_id", saved.id);
    });
    expect(note()).toBe(expected);
  });

  it("names the selected LLM, not the first, and follows a change of the selection", async () => {
    const h = await mount(async ({ store }) => {
      await store.createConfig(config({ name: "A local", base_url: "http://localhost:8080/v1" }));
      const b = await store.createConfig(
        config({ name: "B cloud", base_url: "https://cloud.example/v1" }),
      );
      await store.setSetting("selected_llm_id", b.id);
    });
    expect(note()).toContain("cloud.example");
    const configs = await h.deps.store.listConfigs();
    await h.deps.store.setSetting("selected_llm_id", configs[0]?.id ?? 0);
    h.otherPage.post("settings-changed");
    await settle(() => {
      expect(note()).toContain("on this computer");
    });
  });

  it("shows the stored setting", async () => {
    await mount(async ({ store }) => {
      await store.setSetting("page_mode", false);
    });
    expect(box().checked).toBe(false);
  });
});

describe("the switch", () => {
  it("unticked: stores the setting, announces it, tells the open pages to remove everything, and asks for no permission", async () => {
    const h = await mount();
    clickBox();
    // Nothing is requested, registered or removed: the access stays as it is.
    expect(h.pageMode.calls).not.toContain("request");
    await settle(() => {
      expect(h.tabs.sent).toEqual(["page-mode-off"]);
    });
    expect(await h.deps.store.getSetting("page_mode")).toBe(false);
    expect(h.otherPage.received).toContain("settings-changed");
    expect(box().checked).toBe(false);
    expect(h.pageMode.granted).toBe(true);
    // The delay is used by page mode only while it is on.
    expect((byId("auto-check-delay") as HTMLInputElement).disabled).toBe(true);
  });

  it("ticked again: stores it and tells the open pages to ask again", async () => {
    const h = await mount(async ({ store }) => {
      await store.setSetting("page_mode", false);
    });
    clickBox();
    await settle(() => {
      expect(h.tabs.sent).toEqual(["settings-changed"]);
    });
    expect(await h.deps.store.getSetting("page_mode")).toBe(true);
    expect(box().checked).toBe(true);
    expect((byId("auto-check-delay") as HTMLInputElement).disabled).toBe(false);
  });

  it("shows a failure in the page's banner and puts the box back from the store", async () => {
    const h = await mount();
    h.tabs.broadcast = () => Promise.reject(new Error("no tabs"));
    clickBox();
    await settle(() => {
      expect(byId("options-error").hidden).toBe(false);
    });
    expect(byId("options-error").textContent).toBe("Something went wrong.");
    // The setting was stored before the pages were told, so the box follows it.
    expect(box().checked).toBe(false);
  });
});

describe("when Firefox no longer grants access to all websites", () => {
  const withdrawn = async ({ pageMode }: OptionsHarness["deps"]) => {
    (pageMode as FakePageModePermission).granted = false;
    await Promise.resolve();
  };
  const accessButton = () => byId("page-mode-access-button");

  it("explains it and offers a button that asks again", async () => {
    const h = await mount(withdrawn);
    expect(byId("page-mode-access").hidden).toBe(false);
    expect(byId("page-mode-access").textContent).toContain(ACCESS_WITHDRAWN);
    expect(accessButton().textContent).toBe("Allow access to all websites");
    // Nothing was asked yet: Firefox accepts the request only from a click.
    expect(h.pageMode.calls).not.toContain("request");
    // The switch is untouched: it is the user's.
    expect(box().checked).toBe(true);
  });

  it("asks in the turn of the click, then hides the notice and tells the open pages", async () => {
    const h = await mount(withdrawn);
    accessButton().click();
    // Nothing was awaited between the click and the request.
    expect(h.pageMode.calls.filter((c) => c === "request")).toEqual(["request"]);
    await settle(() => {
      expect(byId("page-mode-access").hidden).toBe(true);
    });
    expect(h.pageMode.granted).toBe(true);
    expect(h.tabs.sent).toEqual(["settings-changed"]);
    expect(byId("page-mode-error").hidden).toBe(true);
  });

  it("says so when the user refuses (PageModePermissionDenied) and keeps the button", async () => {
    const h = await mount(withdrawn);
    h.pageMode.answer = "refuse";
    accessButton().click();
    await settle(() => {
      expect(byId("page-mode-error").hidden).toBe(false);
    });
    expect(byId("page-mode-error").textContent).toBe(PERMISSION_DENIED_MESSAGE);
    const err = h.page.pageMode.error;
    expect(err).toBeInstanceOf(AppError);
    expect(err?.hasRoute("PageModeSection.requestAccess->PageModePermissionDenied")).toBe(true);
    expect(byId("page-mode-access").hidden).toBe(false);
    expect(h.tabs.sent).toEqual([]);
    // Asking again works, and the message goes.
    h.pageMode.answer = "grant";
    accessButton().click();
    await settle(() => {
      expect(byId("page-mode-access").hidden).toBe(true);
    });
    expect(h.page.pageMode.error).toBeUndefined();
    expect(byId("page-mode-error").hidden).toBe(true);
  });

  it("is a PageModePermissionDenied too when the browser cannot ask", async () => {
    const h = await mount(withdrawn);
    h.pageMode.request = () =>
      Promise.reject(new Error("permissions.request may only be called from a user input handler"));
    accessButton().click();
    await settle(() => {
      expect(h.page.pageMode.error).toBeDefined();
    });
    expect(h.page.pageMode.error?.hasRoute("PageModePermissionDenied")).toBe(true);
    expect(byId("page-mode-access").hidden).toBe(false);
  });

  it.each([
    { name: "withdrawn while the page is open", start: true, change: "withdraw", hidden: false },
    { name: "given back while the page is open", start: false, change: "add", hidden: true },
  ])("follows access $name, without a reload", async ({ start, change, hidden }) => {
    const h = await mount(async ({ pageMode }) => {
      (pageMode as FakePageModePermission).granted = start;
      await Promise.resolve();
    });
    expect(byId("page-mode-access").hidden).toBe(start);
    if (change === "withdraw") h.pageMode.withdraw();
    else {
      h.pageMode.granted = true;
      h.pageMode.fireAdded();
    }
    await settle(() => {
      expect(byId("page-mode-access").hidden).toBe(hidden);
    });
  });

  it("looks again when the user comes back to the tab (access given back in about:addons)", async () => {
    const h = await mount(withdrawn);
    expect(byId("page-mode-access").hidden).toBe(false);
    h.pageMode.granted = true;
    window.dispatchEvent(new Event("focus"));
    await settle(() => {
      expect(byId("page-mode-access").hidden).toBe(true);
    });
  });
});

describe("the sites with a choice", () => {
  const seed = async ({ store }: OptionsHarness["deps"]) => {
    await store.setSetting("page_mode", true);
    await store.setSetting("page_mode_sites", {
      "news.example.org": "off",
      "example.com": "on",
    });
  };

  it("lists them by name, each with its state and Remove", async () => {
    await mount(seed);
    expect(siteRows()).toEqual([
      ["example.com", "On"],
      ["news.example.org", "Off"],
    ]);
    expect(byId("page-mode-sites-empty").hidden).toBe(true);
    expect(
      [...document.querySelectorAll(".host-remove")].map((b) => b.getAttribute("aria-label")),
    ).toEqual(["Remove example.com", "Remove news.example.org"]);
  });

  it("Remove takes one out, so that it is asked again; announces it and has the open pages told", async () => {
    const h = await mount(seed);
    document
      .querySelector(".host-remove")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle(() => {
      expect(hostRows()).toEqual(["news.example.org"]);
    });
    expect(await h.deps.store.getSetting("page_mode_sites")).toEqual({ "news.example.org": "off" });
    expect(h.otherPage.received).toContain("settings-changed");
    expect(h.tabs.sent).toEqual(["settings-changed"]);
  });

  it("shows the empty line when the last one is removed", async () => {
    await mount(async ({ store }) => {
      await store.setSetting("page_mode_sites", { "example.com": "on" });
    });
    document
      .querySelector(".host-remove")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await settle(() => {
      expect(byId("page-mode-sites-empty").hidden).toBe(false);
    });
    expect(hostRows()).toEqual([]);
  });

  it("follows a change made elsewhere (the toolbar menu or the prompt)", async () => {
    const h = await mount();
    await h.deps.store.setSetting("page_mode_sites", { "added.example": "on" });
    h.otherPage.post("settings-changed");
    await settle(() => {
      expect(siteRows()).toEqual([["added.example", "On"]]);
    });
  });

  it("keeps the choices when page mode is turned off", async () => {
    const h = await mount(seed);
    clickBox();
    await settle(() => {
      expect(h.tabs.sent).toEqual(["page-mode-off"]);
    });
    expect(await h.deps.store.getSetting("page_mode_sites")).toEqual({
      "news.example.org": "off",
      "example.com": "on",
    });
    expect(hostRows()).toHaveLength(2);
  });

  it("shows host names as text, never as markup", async () => {
    await mount(async ({ store }) => {
      await store.setSetting("page_mode_sites", { "<img src=x onerror=alert(1)>": "on" });
    });
    expect(hostRows()).toEqual(["<img src=x onerror=alert(1)>"]);
    expect(document.querySelector("#page-mode-sites img")).toBeNull();
  });
});

describe("the Welcome block", () => {
  const welcome = () => document.getElementById("welcome");
  const click = (id: string) =>
    byId(id).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

  it("is not on the page unless it was asked for (options.html without #welcome)", async () => {
    await mount();
    expect(welcome()).toBeNull();
  });

  it("is shown above the sections when asked for: the sentence, Add an LLM, and how page mode works (nothing to allow)", async () => {
    mounted = await mountForTest(document, undefined, undefined, { welcome: true });
    expect(welcome()).not.toBeNull();
    // Right after the title, before the LLMs section.
    expect(document.querySelector("h1")?.nextElementSibling).toBe(welcome());
    expect(welcome()?.nextElementSibling?.id).toBe("llms");
    expect(byId("welcome-heading").textContent).toBe("Welcome to English Tutor");
    expect(byId("welcome-intro").textContent).toContain("grammar, vocabulary and syntax errors");
    expect(byId("welcome-page-mode").textContent).toContain(
      "click the grey English Tutor icon in a text box to turn checking on for that site",
    );
    expect([...byId("welcome").querySelectorAll("button")].map((b) => b.textContent)).toEqual([
      "Add an LLM",
    ]);
    // Opening it asks for nothing and changes nothing.
    expect(mounted.pageMode.calls).not.toContain("request");
    expect(mounted.tabs.sent).toEqual([]);
  });

  it("Add an LLM opens the Add form of the LLMs section", async () => {
    mounted = await mountForTest(document, undefined, undefined, { welcome: true });
    expect(document.getElementById("llm-form")).toBeNull();
    click("welcome-add-llm");
    expect(document.getElementById("llm-form")).not.toBeNull();
    expect(welcome()).not.toBeNull();
  });
});

describe("the auto-check delay", () => {
  it("is enabled while page mode is on, even with auto-check off, because page mode uses it", async () => {
    await mount();
    expect((byId("auto-check-delay") as HTMLInputElement).disabled).toBe(false);
  });

  it("is disabled when both are off", async () => {
    await mount(async ({ store }) => {
      await store.setSetting("page_mode", false);
    });
    expect((byId("auto-check-delay") as HTMLInputElement).disabled).toBe(true);
  });
});

describe("the box for automatic checks in text boxes on websites", () => {
  const auto = () => byId("page-mode-auto-check") as HTMLInputElement;
  const delay = () => byId("auto-check-delay") as HTMLInputElement;

  it("has its label, sits directly under the switch, and is ticked by default", async () => {
    await mount();
    expect(AUTO_CHECK_LABEL).toBe("Check automatically while typing in text boxes on websites");
    expect(auto().closest("label")?.textContent).toContain(AUTO_CHECK_LABEL);
    expect(auto().checked).toBe(true);
    expect(auto().disabled).toBe(false);
    const row = auto().closest(".form-row");
    expect(row?.previousElementSibling).toBe(box().closest(".form-row"));
  });

  it.each([
    { name: "unticked", stored: false },
    { name: "ticked", stored: true },
  ])("shows what is stored: $name", async ({ stored }) => {
    await mount(async ({ store }) => {
      await store.setSetting("page_mode_auto_check", stored);
    });
    expect(auto().checked).toBe(stored);
  });

  it("unticking stores it, announces it, and tells nobody to remove anything", async () => {
    const h = await mount();
    auto().click();
    await settle(() => {
      expect(h.otherPage.received).toContain("settings-changed");
    });
    expect(await h.deps.store.getSetting("page_mode_auto_check")).toBe(false);
    expect(await h.deps.store.getSetting("page_mode")).toBe(true);
    expect(h.tabs.sent).toEqual([]);
  });

  it.each([
    {
      name: "page mode on, box ticked, editor's Auto-check off",
      page: true,
      autoPage: true,
      editor: false,
      enabled: true,
    },
    {
      name: "page mode on, box unticked, editor's Auto-check off",
      page: true,
      autoPage: false,
      editor: false,
      enabled: false,
    },
    {
      name: "page mode on, box unticked, editor's Auto-check on",
      page: true,
      autoPage: false,
      editor: true,
      enabled: true,
    },
    {
      name: "the switch off, box ticked (disabled), editor's Auto-check off",
      page: false,
      autoPage: true,
      editor: false,
      enabled: false,
    },
    {
      name: "the switch off, editor's Auto-check on",
      page: false,
      autoPage: true,
      editor: true,
      enabled: true,
    },
  ])(
    "the delay field with $name is enabled: $enabled",
    async ({ page, autoPage, editor, enabled }) => {
      await mount(async ({ store }) => {
        await store.setSetting("page_mode", page);
        await store.setSetting("page_mode_auto_check", autoPage);
        await store.setSetting("auto_check", editor);
      });
      expect(delay().disabled).toBe(!enabled);
    },
  );

  it("follows the box and the switch as they are clicked", async () => {
    const h = await mount();
    expect(delay().disabled).toBe(false);
    auto().click();
    expect(delay().disabled).toBe(true);
    auto().click();
    expect(delay().disabled).toBe(false);
    box().click();
    // The box is disabled with the switch, and the delay with it.
    await settle(() => {
      expect(auto().disabled).toBe(true);
    });
    expect(delay().disabled).toBe(true);
    expect(h.tabs.sent).toEqual(["page-mode-off"]);
    box().click();
    await settle(() => {
      expect(auto().disabled).toBe(false);
    });
    expect(delay().disabled).toBe(false);
  });
});
