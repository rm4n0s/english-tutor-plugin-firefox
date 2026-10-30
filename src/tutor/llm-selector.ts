import type { Logger } from "../core/log";
import type { LLMConfig, Store } from "../core/store";
import type { ChangeChannel } from "../platform/channel";
import { el } from "../ui/dom";

/**
 * Which LLM is selected (SPEC sections 4.2 and 4.7): the stored one if it still exists, otherwise
 * the first by name, otherwise none. `configs` are ordered by name, as the store lists them.
 */
export function chooseSelectedId(
  configs: readonly Pick<LLMConfig, "id">[],
  stored: number | null,
): number | null {
  if (stored !== null && configs.some((config) => config.id === stored)) return stored;
  return configs[0]?.id ?? null;
}

export interface LLMSelectorDeps {
  store: Store;
  channel: ChangeChannel;
  log: Logger;
}

/**
 * The LLM `<select>` of the tutor page. It lists the configured LLMs by name, remembers the choice
 * in `selected_llm_id`, and reloads when another page changes the list or the setting. When no LLM
 * is selected but some exist (the first one was just added, or the selected one was deleted), it
 * selects the first by name and stores that. With none, the select is disabled.
 */
export class LLMSelector {
  private readonly doc: Document;
  private readonly select: HTMLSelectElement;
  private readonly deps: LLMSelectorDeps;
  private readonly onChange: (config: LLMConfig | undefined) => void;
  private readonly onError: (err: unknown) => void;
  private configs: readonly LLMConfig[] = [];
  private currentId: number | null = null;
  private loads = 0;

  constructor(
    doc: Document,
    select: HTMLSelectElement,
    deps: LLMSelectorDeps,
    onChange: (config: LLMConfig | undefined) => void,
    onError: (err: unknown) => void,
  ) {
    this.doc = doc;
    this.select = select;
    this.deps = deps;
    this.onChange = onChange;
    this.onError = onError;
    select.addEventListener("change", () => {
      this.choose(Number(select.value)).catch(this.onError);
    });
  }

  /** The selected configuration, or undefined when there is none. */
  get selected(): LLMConfig | undefined {
    return this.configs.find((config) => config.id === this.currentId);
  }

  /** Reads the list and the selection from the store. The latest call wins. */
  async load(): Promise<void> {
    const load = ++this.loads;
    const { store, channel } = this.deps;
    const [configs, stored] = await Promise.all([
      store.listConfigs(),
      store.getSetting("selected_llm_id"),
    ]);
    if (load !== this.loads) return;
    const id = chooseSelectedId(configs, stored);
    if (id !== null && id !== stored) {
      await store.setSetting("selected_llm_id", id);
      if (load !== this.loads) return;
      channel.post("settings-changed");
    }
    this.show(configs, id);
  }

  private async choose(id: number): Promise<void> {
    if (!this.configs.some((config) => config.id === id)) return;
    this.loads++;
    await this.deps.store.setSetting("selected_llm_id", id);
    this.deps.channel.post("settings-changed");
    this.show(this.configs, id);
  }

  private show(configs: readonly LLMConfig[], id: number | null): void {
    this.configs = configs;
    this.currentId = id;
    if (configs.length === 0) {
      this.select.replaceChildren(el(this.doc, "option", {}, ["No LLM configured"]));
      this.select.disabled = true;
    } else {
      this.select.replaceChildren(
        ...configs.map((config) =>
          el(this.doc, "option", { value: String(config.id) }, [config.name]),
        ),
      );
      this.select.value = String(id);
      this.select.disabled = false;
    }
    this.onChange(this.selected);
  }
}
