import { modelFromConfig, type AnalysisModel } from "../core/analysis";
import type { LLMConfig, Store } from "../core/store";
import type { ChangeChannel } from "../platform/channel";
import type { HostPermissionCheck } from "../core/llm/client";
import { chooseSelectedId } from "../tutor/llm-selector";

export interface FrameSettingsDeps {
  store: Pick<Store, "getSetting" | "listConfigs">;
  permissions: HostPermissionCheck;
  /** The page's `fetch`. */
  fetch: typeof fetch;
  channel: ChangeChannel;
}

/**
 * What the page-mode frame needs from the settings (SPEC sections 4.7 and 4.11): the pause of the
 * automatic check (`auto_check_delay_s`; the editor's own Auto-check box does not apply here),
 * whether checks start by themselves at all (`page_mode_auto_check`) and
 * the selected LLM as a model. It is read from the store when the frame starts, again each time a
 * text box gets the focus, and when another page announces a change. Unlike the tutor page it
 * never writes a setting: with no LLM selected it uses the first by name without storing that.
 */
export class FrameSettings {
  private readonly deps: FrameSettingsDeps;
  private delay = 3;
  private auto = true;
  private config: LLMConfig | undefined;
  private model: AnalysisModel | undefined;
  private loads = 0;
  private readonly listeners = new Set<() => void>();
  private readonly stop: () => void;

  constructor(deps: FrameSettingsDeps) {
    this.deps = deps;
    this.stop = deps.channel.subscribe((message) => {
      if (message.type === "settings-changed" || message.type === "configs-changed") {
        void this.load().catch(() => undefined);
      }
    });
  }

  /** Reads the settings. The latest call wins. */
  async load(): Promise<void> {
    const load = ++this.loads;
    const { store } = this.deps;
    const [delay, auto, configs, selected] = await Promise.all([
      store.getSetting("auto_check_delay_s"),
      store.getSetting("page_mode_auto_check"),
      store.listConfigs(),
      store.getSetting("selected_llm_id"),
    ]);
    if (load !== this.loads) return;
    this.delay = delay;
    this.auto = auto;
    const id = chooseSelectedId(configs, selected);
    const config = configs.find((c) => c.id === id);
    if (config !== this.config) this.model = undefined;
    this.config = config;
    for (const listener of [...this.listeners]) listener();
  }

  /** Called after each read of the settings (the dialog follows the LLM it has). Returns the remover. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  get delaySeconds(): number {
    return this.delay;
  }

  /** Whether text boxes are checked by themselves (`page_mode_auto_check`); the dialog's Check always works. */
  get autoCheck(): boolean {
    return this.auto;
  }

  /** The selected LLM as a model, made on first use; undefined when there is none. */
  getModel(): AnalysisModel | undefined {
    if (this.config === undefined) return undefined;
    this.model ??= modelFromConfig(this.config, {
      fetch: this.deps.fetch,
      permissions: this.deps.permissions,
    });
    return this.model;
  }

  destroy(): void {
    this.listeners.clear();
    this.stop();
  }
}
