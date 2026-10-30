import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CountingRandom } from "../../core/analysis/testing/helpers";
import { validateConfig } from "../../core/llm";
import { FakeFetch, type FakeScript } from "../../core/llm/testing/fake-fetch";
import { Logger } from "../../core/log";
import type { LLMConfigInput } from "../../core/store";
import { freshStore } from "../../core/store/testing/db";
import { FakeClock, FakeScheduler } from "../../core/testing/fake-clock";
import { FakeChannelBus, type FakeChangeChannel } from "../../platform/testing/fake-channel";
import { FakeLinkOpener } from "../../platform/testing/fake-link-opener";
import { FakePermissions } from "../../platform/testing/fake-permissions";
import type { TutorDeps } from "../deps";
import { mountTutor, type TutorPage } from "../page";

const TUTOR_HTML = join(import.meta.dirname, "..", "tutor.html");

/** Puts the body of the real `tutor.html` into `doc`, parsed without `innerHTML`. */
export function loadTutorHtml(doc: Document): void {
  // The tags that load files are left out: a test has no stylesheet or script to fetch.
  const html = readFileSync(TUTOR_HTML, "utf8").replace(/<(link|script)\b[^>]*>(<\/script>)?/g, "");
  const parsed = new DOMParser().parseFromString(html, "text/html");
  doc.body.replaceChildren(
    ...[...parsed.body.childNodes].map((node) => doc.importNode(node, true)),
  );
}

export function config(overrides: Partial<LLMConfigInput> = {}): LLMConfigInput {
  return {
    name: "Local",
    provider: "openai-compatible",
    model: "gpt-4o",
    base_url: "https://api.example.com/v1",
    api_key: "",
    temperature: null,
    timeout_seconds: null,
    max_parallel: 1,
    no_thinking: true,
    ...overrides,
  };
}

export const ORIGIN = "https://api.example.com/*";

export interface TutorHarness {
  page: TutorPage;
  doc: Document;
  deps: TutorDeps;
  db: IDBDatabase;
  fake: FakeFetch;
  permissions: FakePermissions;
  scheduler: FakeScheduler;
  clock: FakeClock;
  /** The tutor page's own channel (`posted` lists what it announced). */
  channel: FakeChangeChannel;
  /** Another page on the same channel (the options page, or another tab). */
  other: { received: string[]; channel: FakeChangeChannel };
  logged: { level: string; message: string; fields: unknown }[];
  /** The addresses the page opened in new tabs. */
  links: FakeLinkOpener;
  /** How many times the page asked to open the options page. */
  opened: { options: number };
}

export interface HarnessOptions {
  /** Configurations stored before the page opens. */
  configs?: LLMConfigInput[];
  /** The stored `selected_llm_id`, by index in `configs` (ids are 1, 2, ...), or a raw id. */
  selected?: number | null;
  /** Settings stored before the page opens. */
  settings?: { auto_check?: boolean; auto_check_delay_s?: number };
  script?: FakeScript;
  /** Whether the host permission of `ORIGIN` is granted; default true. */
  granted?: boolean;
}

/** Mounts the tutor page on a fresh database with fakes. */
export async function mountForTest(
  doc: Document,
  options: HarnessOptions = {},
): Promise<TutorHarness> {
  loadTutorHtml(doc);
  const { store, db } = await freshStore({ validateConfig });
  for (const input of options.configs ?? []) await store.createConfig(input);
  if (options.selected !== undefined && options.selected !== null) {
    await store.setSetting("selected_llm_id", options.selected);
  }
  if (options.settings?.auto_check !== undefined) {
    await store.setSetting("auto_check", options.settings.auto_check);
  }
  if (options.settings?.auto_check_delay_s !== undefined) {
    await store.setSetting("auto_check_delay_s", options.settings.auto_check_delay_s);
  }
  const bus = new FakeChannelBus();
  const received: string[] = [];
  const otherChannel = bus.connect();
  otherChannel.subscribe((message) => {
    received.push(message.type);
  });
  const permissions = new FakePermissions();
  if (options.granted !== false) permissions.granted.add(ORIGIN);
  const fake = new FakeFetch(
    options.script ?? { kind: "json", body: { choices: [{ message: { content: "{}" } }] } },
  );
  const clock = new FakeClock(1_000);
  const scheduler = new FakeScheduler();
  const logged: TutorHarness["logged"] = [];
  const sink = (level: string) => (message: string, fields?: unknown) => {
    logged.push({ level, message, fields });
  };
  const opened = { options: 0 };
  const links = new FakeLinkOpener();
  const channel = bus.connect();
  const deps: TutorDeps = {
    store,
    channel,
    permissions,
    links,
    fetch: fake.fetch,
    clock,
    scheduler,
    random: new CountingRandom(),
    log: new Logger({
      debug: sink("debug"),
      info: sink("info"),
      warn: sink("warn"),
      error: sink("error"),
    }),
    openOptions: () => {
      opened.options++;
    },
  };
  const page = mountTutor(doc, deps);
  await page.ready;
  return {
    page,
    doc,
    deps,
    db,
    fake,
    permissions,
    scheduler,
    clock,
    channel,
    other: { received, channel: otherChannel },
    logged,
    links,
    opened,
  };
}
