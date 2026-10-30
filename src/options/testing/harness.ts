import { FakeClock } from "../../core/testing/fake-clock";
import { validateConfig } from "../../core/llm";
import { FakeFetch, type FakeScript } from "../../core/llm/testing/fake-fetch";
import { Logger } from "../../core/log";
import type { LLMConfigInput } from "../../core/store";
import { freshStore } from "../../core/store/testing/db";
import { FakeChannelBus } from "../../platform/testing/fake-channel";
import { FakePermissions } from "../../platform/testing/fake-permissions";
import { el } from "../../ui/dom";
import type { OptionsDeps } from "../deps";
import { mountOptions, type OptionsPage } from "../page";

/** The skeleton of options.html that `mountOptions` needs, built with createElement. */
export function skeleton(doc: Document): void {
  doc.body.replaceChildren();
  const section = (id: string) =>
    el(doc, "section", { id, class: "card" }, [el(doc, "div", { class: "card-body" })]);
  doc.body.append(el(doc, "main", { class: "page" }, [section("llms"), section("general")]));
}

export interface OptionsHarness {
  deps: OptionsDeps;
  page: OptionsPage;
  doc: Document;
  permissions: FakePermissions;
  fetch: FakeFetch;
  clock: FakeClock;
  /** A second page on the same channel, as another tab. */
  otherPage: { received: string[]; post(type: "configs-changed" | "settings-changed"): void };
  logged: string[];
}

export function config(overrides: Partial<LLMConfigInput> = {}): LLMConfigInput {
  return {
    name: "Local",
    provider: "openai-compatible",
    model: "gpt-4o",
    base_url: "http://localhost:8080/v1",
    api_key: "",
    temperature: null,
    timeout_seconds: null,
    max_parallel: 1,
    no_thinking: true,
    ...overrides,
  };
}

/** Mounts the options page on a fresh database with fakes. */
export async function mountForTest(
  doc: Document,
  script: FakeScript = { kind: "json", body: { choices: [{ message: { content: "ok" } }] } },
  seed: (deps: OptionsDeps) => Promise<void> = () => Promise.resolve(),
): Promise<OptionsHarness> {
  skeleton(doc);
  const { store } = await freshStore({ validateConfig });
  const bus = new FakeChannelBus();
  const received: string[] = [];
  const other = bus.connect();
  other.subscribe((message) => {
    received.push(message.type);
  });
  const permissions = new FakePermissions();
  const fake = new FakeFetch(script);
  const clock = new FakeClock(1_000);
  const logged: string[] = [];
  const record = (message: string) => {
    logged.push(message);
  };
  const deps: OptionsDeps = {
    store,
    channel: bus.connect(),
    permissions,
    fetch: fake.fetch,
    clock,
    log: new Logger({ debug: record, info: record, warn: record, error: record }),
  };
  await seed(deps);
  const page = mountOptions(doc, deps);
  await page.ready;
  return {
    deps,
    page,
    doc,
    permissions,
    fetch: fake,
    clock,
    otherPage: {
      received,
      post: (type) => {
        other.post(type);
      },
    },
    logged,
  };
}
