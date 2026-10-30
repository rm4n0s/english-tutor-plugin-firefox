// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { AppError } from "../core/errors";
import { config, mountForTest, type OptionsHarness } from "./testing/harness";
import { PERMISSION_DENIED_MESSAGE } from "./page-mode-section";

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
  it("is off by default, with its note and no hosts", async () => {
    await mount();
    expect(box().checked).toBe(false);
    expect(byId("page-mode").closest("label")?.textContent).toContain(
      "Offer to check text boxes on websites",
    );
    expect(note()).toBe(
      "English Tutor asks on each site before it reads anything there. What you type on a site you turn on is sent to the server of the selected LLM to be checked. Add an LLM first.",
    );
    expect(byId("page-mode-sites-empty").hidden).toBe(false);
    expect(byId("page-mode-sites").hidden).toBe(true);
    expect(byId("page-mode-error").hidden).toBe(true);
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
      await store.setSetting("page_mode", true);
    });
    expect(box().checked).toBe(true);
  });
});

describe("turning page mode on", () => {
  it("asks for <all_urls> in the turn of the click, then stores the setting, announces it and asks the background script to register", async () => {
    const h = await mount();
    h.background.onApply = async () => {
      // The background script reads the setting the page has stored by now.
      expect(await h.deps.store.getSetting("page_mode")).toBe(true);
    };
    clickBox();
    // Nothing was awaited between the click and the request.
    expect(h.pageMode.calls).toEqual(["request"]);
    await settle(() => {
      expect(h.background.applied).toBe(1);
    });
    expect(await h.deps.store.getSetting("page_mode")).toBe(true);
    expect(h.otherPage.received).toContain("settings-changed");
    expect(h.pageMode.granted).toBe(true);
    expect(box().checked).toBe(true);
    expect(byId("page-mode-error").hidden).toBe(true);
  });

  it("stays off when the user refuses, and the form says so (PageModePermissionDenied)", async () => {
    const h = await mount();
    h.pageMode.answer = "refuse";
    clickBox();
    await settle(() => {
      expect(byId("page-mode-error").hidden).toBe(false);
    });
    expect(box().checked).toBe(false);
    expect(byId("page-mode-error").textContent).toBe(PERMISSION_DENIED_MESSAGE);
    const err = h.page.pageMode.error;
    expect(err).toBeInstanceOf(AppError);
    expect(err?.hasRoute("PageModeSection.turnOn->PageModePermissionDenied")).toBe(true);
    // Nothing was stored, announced or registered.
    expect(await h.deps.store.getSetting("page_mode")).toBe(false);
    expect(h.background.applied).toBe(0);
    expect(h.otherPage.received).toEqual([]);
  });

  it("asks again when the user ticks the box again, and the message goes when it works", async () => {
    const h = await mount();
    h.pageMode.answer = "refuse";
    clickBox();
    await settle(() => {
      expect(h.page.pageMode.error).toBeDefined();
    });
    h.pageMode.answer = "grant";
    clickBox();
    await settle(() => {
      expect(h.background.applied).toBe(1);
    });
    expect(h.page.pageMode.error).toBeUndefined();
    expect(byId("page-mode-error").hidden).toBe(true);
    expect(h.pageMode.calls).toEqual(["request", "request"]);
  });

  it("is a PageModePermissionDenied too when the browser cannot ask", async () => {
    const h = await mount();
    h.pageMode.request = () =>
      Promise.reject(new Error("permissions.request may only be called from a user input handler"));
    clickBox();
    await settle(() => {
      expect(h.page.pageMode.error).toBeDefined();
    });
    expect(h.page.pageMode.error?.hasRoute("PageModePermissionDenied")).toBe(true);
    expect(box().checked).toBe(false);
  });

  it("shows a failure of the background script in the page's banner and puts the box back from the store", async () => {
    const h = await mount();
    h.background.failWith = new Error("could not register");
    clickBox();
    await settle(() => {
      expect(byId("options-error").hidden).toBe(false);
    });
    expect(byId("options-error").textContent).toBe("Something went wrong.");
    // The setting was stored before the background script was asked, so the box follows it.
    expect(box().checked).toBe(true);
  });
});

describe("turning page mode off", () => {
  async function turnedOn() {
    return mount(async ({ store }) => {
      await store.setSetting("page_mode", true);
    });
  }

  it("stores it, tells the background script, and only then gives the permission back", async () => {
    const h = await turnedOn();
    h.pageMode.granted = true;
    const order: string[] = [];
    h.background.onApply = () => {
      order.push(`apply (permission ${h.pageMode.granted ? "kept" : "gone"})`);
      return Promise.resolve();
    };
    clickBox();
    expect(h.pageMode.calls).toEqual([]);
    await settle(() => {
      expect(h.pageMode.calls).toEqual(["remove"]);
    });
    expect(order).toEqual(["apply (permission kept)"]);
    expect(await h.deps.store.getSetting("page_mode")).toBe(false);
    expect(h.otherPage.received).toContain("settings-changed");
    expect(h.pageMode.granted).toBe(false);
    expect(box().checked).toBe(false);
  });

  it("does not remove the permission when the background script fails, and shows the failure", async () => {
    const h = await turnedOn();
    h.pageMode.granted = true;
    h.background.failWith = new Error("no");
    clickBox();
    await settle(() => {
      expect(byId("options-error").hidden).toBe(false);
    });
    expect(h.pageMode.calls).toEqual([]);
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
    expect(h.background.applied).toBe(1);
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
    h.pageMode.granted = true;
    clickBox();
    await settle(() => {
      expect(h.pageMode.calls).toEqual(["remove"]);
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

  it("is shown above the sections when asked for, with its sentence, Add an LLM, the offer, Allow and Not now", async () => {
    mounted = await mountForTest(document, undefined, undefined, { welcome: true });
    expect(welcome()).not.toBeNull();
    // Right after the title, before the LLMs section.
    expect(document.querySelector("h1")?.nextElementSibling).toBe(welcome());
    expect(welcome()?.nextElementSibling?.id).toBe("llms");
    expect(byId("welcome-heading").textContent).toBe("Welcome to English Tutor");
    expect(byId("welcome-intro").textContent).toContain("grammar, vocabulary and syntax errors");
    expect(byId("welcome-offer").textContent).toBe(
      "Offer to check what you write on websites. English Tutor asks on each site first, and reads nothing on a site until you say yes.",
    );
    expect([...byId("welcome").querySelectorAll("button")].map((b) => b.textContent)).toEqual([
      "Add an LLM",
      "Allow",
      "Not now",
    ]);
  });

  it("Add an LLM opens the Add form of the LLMs section", async () => {
    mounted = await mountForTest(document, undefined, undefined, { welcome: true });
    expect(document.getElementById("llm-form")).toBeNull();
    click("welcome-add-llm");
    expect(document.getElementById("llm-form")).not.toBeNull();
    expect(welcome()).not.toBeNull();
  });

  it("Not now closes the block and changes nothing", async () => {
    mounted = await mountForTest(document, undefined, undefined, { welcome: true });
    click("welcome-later");
    expect(welcome()).toBeNull();
    expect(mounted.pageMode.calls).toEqual([]);
    expect(await mounted.deps.store.getSetting("page_mode")).toBe(false);
    expect(box().checked).toBe(false);
    expect(mounted.background.applied).toBe(0);
  });

  it("Allow asks for <all_urls> in the turn of the click, stores page_mode, has the background script register, ticks the box and says so", async () => {
    mounted = await mountForTest(document, undefined, undefined, { welcome: true });
    const h = mounted;
    click("welcome-allow");
    // Nothing was awaited between the click and the request.
    expect(h.pageMode.calls).toEqual(["request"]);
    await settle(() => {
      expect(h.background.applied).toBe(1);
    });
    expect(await h.deps.store.getSetting("page_mode")).toBe(true);
    expect(h.otherPage.received).toContain("settings-changed");
    expect(box().checked).toBe(true);
    await settle(() => {
      expect(byId("welcome-allowed").hidden).toBe(false);
    });
    expect(byId("welcome-offer").hidden).toBe(true);
    expect(byId("welcome-error").hidden).toBe(true);
    // The delay field follows, as it does for the box.
    expect((byId("auto-check-delay") as HTMLInputElement).disabled).toBe(false);
  });

  it("Allow that the user refuses says so in the block (PageModePermissionDenied) and keeps the offer", async () => {
    mounted = await mountForTest(document, undefined, undefined, { welcome: true });
    const h = mounted;
    h.pageMode.answer = "refuse";
    click("welcome-allow");
    await settle(() => {
      expect(byId("welcome-error").hidden).toBe(false);
    });
    expect(byId("welcome-error").textContent).toBe(PERMISSION_DENIED_MESSAGE);
    expect(
      h.page.pageMode.error?.hasRoute("PageModeSection.turnOn->PageModePermissionDenied"),
    ).toBe(true);
    expect(box().checked).toBe(false);
    expect(await h.deps.store.getSetting("page_mode")).toBe(false);
    expect(h.background.applied).toBe(0);
    expect(byId("welcome-allowed").hidden).toBe(true);
    // Allow again, and the error goes.
    h.pageMode.answer = "grant";
    click("welcome-allow");
    await settle(() => {
      expect(byId("welcome-allowed").hidden).toBe(false);
    });
    expect(byId("welcome-error").hidden).toBe(true);
  });
});

describe("the auto-check delay", () => {
  it("is enabled while page mode is on, even with auto-check off, because page mode uses it", async () => {
    await mount(async ({ store }) => {
      await store.setSetting("page_mode", true);
    });
    expect((byId("auto-check-delay") as HTMLInputElement).disabled).toBe(false);
  });

  it("is disabled when both are off, and follows the box", async () => {
    const h = await mount();
    expect((byId("auto-check-delay") as HTMLInputElement).disabled).toBe(true);
    clickBox();
    expect((byId("auto-check-delay") as HTMLInputElement).disabled).toBe(false);
    await settle(() => {
      expect(h.background.applied).toBe(1);
    });
    clickBox();
    expect((byId("auto-check-delay") as HTMLInputElement).disabled).toBe(true);
  });
});
