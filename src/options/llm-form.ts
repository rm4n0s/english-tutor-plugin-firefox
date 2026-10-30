import { AppError } from "../core/errors";
import {
  configProblems,
  DEFAULT_OLLAMA_URL,
  DEFAULT_PROVIDER,
  DEFAULT_TEMPERATURE,
  effectiveBaseUrl,
  isCancelled,
  isProvider,
  PROVIDER_LABELS,
  PROVIDERS,
  privacyNote,
  supportsApiKey,
  supportsNoThinking,
  testConnection,
  type ConfigField,
  type ConfigProblem,
  DEFAULT_ANTHROPIC_URL,
} from "../core/llm";
import type { LLMConfig, LLMConfigInput, Provider } from "../core/store";
import { el, setHidden, setText } from "../ui/dom";
import type { OptionsDeps } from "./deps";

export interface LLMFormOptions {
  doc: Document;
  deps: OptionsDeps;
  /** The LLM to edit; missing for a new one. */
  config?: LLMConfig;
  /** The LLM was saved. `granted` is false when the user refused its host permission. */
  onSaved(config: LLMConfig, granted: boolean): void;
  /** The form wants to go away (Cancel, Escape, or a saved LLM with its permission). */
  onClose(): void;
}

const FIELD_LABELS: Readonly<Record<ConfigField, string>> = {
  name: "Name",
  model: "Model",
  base_url: "Base URL",
  api_key: "API key",
  temperature: "Temperature",
  timeout_seconds: "Timeout",
  max_parallel: "Parallel requests",
};

const BASE_URL_PLACEHOLDERS: Readonly<Record<Provider, string>> = {
  ollama: DEFAULT_OLLAMA_URL,
  "openai-compatible": "https://api.openai.com/v1",
  anthropic: `${DEFAULT_ANTHROPIC_URL} (default)`,
};

function numberOrNull(text: string): number | null {
  const trimmed = text.trim();
  return trimmed === "" ? null : Number(trimmed);
}

/**
 * The form of the Add and Edit actions (SPEC section 4.7). It reads the values, checks them with
 * `configProblems` (messages next to the fields), asks for the host permission in the click
 * handler (before any `await`), and saves through the store.
 */
export class LLMForm {
  readonly element: HTMLFormElement;
  private readonly doc: Document;
  private readonly deps: OptionsDeps;
  private readonly options: LLMFormOptions;
  /** The LLM being edited. It becomes the saved LLM when a new one is saved without permission. */
  private config: LLMConfig | undefined;
  private closed = false;
  private testing: AbortController | undefined;
  private previousProvider: Provider;
  /** The state of "No thinking" to come back to after leaving Anthropic, which has none. */
  private rememberedNoThinking: boolean;

  private readonly title: HTMLElement;
  private readonly name: HTMLInputElement;
  private readonly provider: HTMLSelectElement;
  private readonly model: HTMLInputElement;
  private readonly baseUrl: HTMLInputElement;
  private readonly apiKey: HTMLInputElement;
  private readonly showKey: HTMLButtonElement;
  private readonly removeKey: HTMLInputElement;
  private readonly removeKeyRow: HTMLElement;
  private readonly keyNote: HTMLElement;
  private readonly temperature: HTMLInputElement;
  private readonly timeout: HTMLInputElement;
  private readonly parallel: HTMLInputElement;
  private readonly noThinking: HTMLInputElement;
  private readonly privacy: HTMLElement;
  private readonly warning: HTMLElement;
  private readonly result: HTMLElement;
  private readonly errors = new Map<ConfigField, HTMLElement>();
  private readonly save: HTMLButtonElement;
  private readonly test: HTMLButtonElement;
  private readonly cancel: HTMLButtonElement;

  constructor(options: LLMFormOptions) {
    this.options = options;
    this.doc = options.doc;
    this.deps = options.deps;
    this.config = options.config;
    const doc = this.doc;
    const existing = options.config;

    this.previousProvider = existing?.provider ?? DEFAULT_PROVIDER;
    this.rememberedNoThinking = existing?.no_thinking ?? true;

    this.title = el(doc, "h3", { id: "llm-form-title" });
    this.name = el(doc, "input", { id: "llm-name", type: "text", autocomplete: "off" });
    this.provider = el(
      doc,
      "select",
      { id: "llm-provider" },
      PROVIDERS.map((p) => el(doc, "option", { value: p }, [PROVIDER_LABELS[p]])),
    );
    this.model = el(doc, "input", {
      id: "llm-model",
      type: "text",
      autocomplete: "off",
      placeholder: "llama3.1, gpt-4o, claude-sonnet-5-5",
    });
    this.baseUrl = el(doc, "input", { id: "llm-base-url", type: "text", autocomplete: "off" });
    this.apiKey = el(doc, "input", {
      id: "llm-api-key",
      type: "password",
      autocomplete: "off",
    });
    this.showKey = el(
      doc,
      "button",
      { id: "llm-show-key", type: "button", "aria-pressed": "false" },
      ["Show"],
    );
    this.removeKey = el(doc, "input", { id: "llm-remove-key", type: "checkbox" });
    this.removeKeyRow = el(doc, "label", { class: "inline" }, [this.removeKey, " Remove key"]);
    this.keyNote = el(doc, "p", { class: "note", id: "llm-key-note" }, [
      "API keys are stored unencrypted in your Firefox profile.",
    ]);
    this.temperature = el(doc, "input", {
      id: "llm-temperature",
      type: "text",
      inputmode: "decimal",
      placeholder: String(DEFAULT_TEMPERATURE),
    });
    this.timeout = el(doc, "input", {
      id: "llm-timeout",
      type: "text",
      inputmode: "numeric",
      placeholder: "default",
    });
    this.parallel = el(doc, "input", { id: "llm-parallel", type: "text", inputmode: "numeric" });
    this.noThinking = el(doc, "input", { id: "llm-no-thinking", type: "checkbox" });
    this.privacy = el(doc, "p", { class: "note", id: "llm-privacy-note" });
    this.warning = el(doc, "p", { class: "message warn", id: "llm-form-warning", role: "alert" });
    this.result = el(doc, "p", { class: "message", id: "llm-form-result", role: "status" });
    this.save = el(doc, "button", { id: "llm-save", type: "button", class: "primary" }, ["Save"]);
    this.test = el(doc, "button", { id: "llm-test", type: "button" }, ["Test connection"]);
    this.cancel = el(doc, "button", { id: "llm-cancel", type: "button" }, ["Cancel"]);

    this.element = el(doc, "form", { id: "llm-form", class: "llm-form", novalidate: true });
    this.element.append(
      this.title,
      this.row("Name", "llm-name", this.name, "name"),
      this.row("Provider", "llm-provider", this.provider),
      this.row("Model", "llm-model", this.model, "model"),
      this.row("Base URL", "llm-base-url", this.baseUrl, "base_url"),
      this.privacy,
      this.row(
        "API key",
        "llm-api-key",
        el(doc, "span", { class: "with-button" }, [this.apiKey, this.showKey]),
        "api_key",
      ),
      el(doc, "div", { class: "indent" }, [this.removeKeyRow, this.keyNote]),
      this.row("Temperature", "llm-temperature", this.temperature, "temperature"),
      this.row("Timeout (seconds)", "llm-timeout", this.timeout, "timeout_seconds"),
      this.row("Parallel requests", "llm-parallel", this.parallel, "max_parallel"),
      el(doc, "div", { class: "indent" }, [
        el(doc, "label", { class: "inline" }, [this.noThinking, " No thinking"]),
      ]),
      this.warning,
      this.result,
      el(doc, "div", { class: "buttons" }, [this.save, this.test, this.cancel]),
    );
    this.fill(existing);
    this.listen();
  }

  /** Puts keyboard focus on the first field. */
  focus(): void {
    this.name.focus();
  }

  /** True once `close` was called. A method, so that checks after an `await` are not narrowed away. */
  private isClosed(): boolean {
    return this.closed;
  }

  /** Stops a running test and ignores whatever it was going to report. */
  close(): void {
    this.closed = true;
    this.testing?.abort();
  }

  // Building

  /** A labelled row; with a `field`, an error line for it follows the control. */
  private row(
    label: string,
    forId: string,
    control: HTMLElement,
    field?: ConfigField,
  ): HTMLElement {
    const row = el(this.doc, "div", { class: "form-row" }, [
      el(this.doc, "label", { for: forId }, [label]),
      control,
    ]);
    if (field !== undefined) {
      const line = el(this.doc, "p", {
        class: "message error",
        "data-field": field,
        role: "alert",
        hidden: true,
      });
      this.errors.set(field, line);
      row.append(line);
    }
    return row;
  }

  private fill(config: LLMConfig | undefined): void {
    setText(this.title, config === undefined ? "Add LLM" : "Edit LLM");
    this.name.value = config?.name ?? "";
    this.provider.value = config?.provider ?? DEFAULT_PROVIDER;
    this.model.value = config?.model ?? "";
    this.baseUrl.value = config?.base_url ?? "";
    this.temperature.value = config?.temperature == null ? "" : String(config.temperature);
    this.timeout.value =
      config?.timeout_seconds == null || config.timeout_seconds === 0
        ? ""
        : String(config.timeout_seconds);
    this.parallel.value = String(config?.max_parallel ?? 1);
    this.noThinking.checked = config?.no_thinking ?? true;
    this.syncProvider();
    this.syncPrivacy();
    setHidden(this.warning, true);
    setHidden(this.result, true);
  }

  private listen(): void {
    this.element.addEventListener("submit", (event) => {
      event.preventDefault();
    });
    this.element.addEventListener("keydown", (event) => {
      if (event.key === "Escape") this.options.onClose();
    });
    this.provider.addEventListener("change", () => {
      this.onProviderChange();
    });
    for (const input of [this.baseUrl, this.provider]) {
      input.addEventListener("input", () => {
        this.syncPrivacy();
      });
    }
    this.showKey.addEventListener("click", () => {
      const hidden = this.apiKey.type === "password";
      this.apiKey.type = hidden ? "text" : "password";
      setText(this.showKey, hidden ? "Hide" : "Show");
      this.showKey.setAttribute("aria-pressed", String(hidden));
    });
    this.removeKey.addEventListener("change", () => {
      this.apiKey.disabled = this.removeKey.checked;
    });
    // The click handlers are not async: the permission request must be made before any `await`.
    this.save.addEventListener("click", () => {
      this.onSave();
    });
    this.test.addEventListener("click", () => {
      this.onTest();
    });
    this.cancel.addEventListener("click", () => {
      this.options.onClose();
    });
  }

  // Provider switching

  private currentProvider(): Provider {
    const value = this.provider.value;
    return isProvider(value) ? value : DEFAULT_PROVIDER;
  }

  private onProviderChange(): void {
    const previous = this.previousProvider;
    const next = this.currentProvider();
    if (next === "ollama" && this.baseUrl.value.trim() === "") {
      this.baseUrl.value = DEFAULT_OLLAMA_URL;
    } else if (previous === "ollama" && this.baseUrl.value.trim() === DEFAULT_OLLAMA_URL) {
      this.baseUrl.value = "";
    }
    if (!supportsNoThinking(previous)) {
      // Coming back from Anthropic.
      this.noThinking.checked = this.rememberedNoThinking;
    } else if (!supportsNoThinking(next)) {
      this.rememberedNoThinking = this.noThinking.checked;
    }
    this.previousProvider = next;
    this.syncProvider();
    this.syncPrivacy();
  }

  /** The parts of the form that depend on the provider. */
  private syncProvider(): void {
    const provider = this.currentProvider();
    this.previousProvider = provider;
    this.baseUrl.placeholder = BASE_URL_PLACEHOLDERS[provider];

    const keyUsed = supportsApiKey(provider);
    this.apiKey.disabled = !keyUsed || this.removeKey.checked;
    this.showKey.disabled = !keyUsed;
    const storedKey = this.config !== undefined && this.config.api_key !== "";
    setHidden(this.removeKeyRow, !keyUsed || !storedKey);
    setHidden(this.keyNote, !keyUsed);
    this.apiKey.placeholder = !keyUsed
      ? "Not used by Ollama"
      : storedKey
        ? "Key stored (leave empty to keep it)"
        : provider === "anthropic"
          ? "Required"
          : "Optional for local servers";

    const thinking = supportsNoThinking(provider);
    if (!thinking) this.noThinking.checked = false;
    this.noThinking.disabled = !thinking;
    this.noThinking.title = thinking ? "" : "Anthropic models do not think unless asked to.";
  }

  private syncPrivacy(): void {
    const note = privacyNote(this.currentProvider(), this.baseUrl.value);
    setHidden(this.privacy, note === null);
    setText(this.privacy, note ?? "");
  }

  // Reading

  /** The values of the form as a configuration. Numbers that are not numbers are `NaN`. */
  private read(): LLMConfigInput {
    const provider = this.currentProvider();
    let apiKey = "";
    if (supportsApiKey(provider) && !this.removeKey.checked) {
      const typed = this.apiKey.value.trim();
      apiKey = typed !== "" ? typed : (this.config?.api_key ?? "");
    }
    const parallelText = this.parallel.value.trim();
    return {
      name: this.name.value.trim(),
      provider,
      model: this.model.value.trim(),
      base_url: this.baseUrl.value.trim(),
      api_key: apiKey,
      temperature: numberOrNull(this.temperature.value),
      timeout_seconds: numberOrNull(this.timeout.value),
      max_parallel: parallelText === "" ? Number.NaN : Number(parallelText),
      no_thinking: supportsNoThinking(provider) && this.noThinking.checked,
    };
  }

  // Messages

  private clearMessages(): void {
    for (const line of this.errors.values()) {
      setText(line, "");
      setHidden(line, true);
    }
    setHidden(this.warning, true);
    setHidden(this.result, true);
  }

  private showProblems(problems: readonly ConfigProblem[]): void {
    for (const problem of problems) this.showFieldError(problem.field, problem.message);
    const first = problems[0];
    if (first !== undefined) this.focusField(first.field);
  }

  private showFieldError(field: ConfigField, message: string): void {
    const line = this.errors.get(field);
    if (line === undefined) return;
    setText(line, message);
    setHidden(line, false);
  }

  private focusField(field: ConfigField): void {
    const control: Record<ConfigField, HTMLElement> = {
      name: this.name,
      model: this.model,
      base_url: this.baseUrl,
      api_key: this.apiKey,
      temperature: this.temperature,
      timeout_seconds: this.timeout,
      max_parallel: this.parallel,
    };
    control[field].focus();
  }

  private showResult(kind: "ok" | "error" | "busy", message: string): void {
    this.result.className = `message ${kind}`;
    setText(this.result, message);
    setHidden(this.result, false);
  }

  private showRefused(input: LLMConfigInput): void {
    const origin = effectiveBaseUrl(input.provider, input.base_url);
    setText(
      this.warning,
      `Access to ${origin} was not allowed. Requests to this LLM will fail with HostPermissionDenied until you allow it. Press Save or Test connection to ask again.`,
    );
    setHidden(this.warning, false);
  }

  // Save

  private onSave(): void {
    this.clearMessages();
    const input = this.read();
    const problems = configProblems(input);
    if (problems.length > 0) {
      this.showProblems(problems);
      return;
    }
    // Before any `await`: Firefox accepts the request only during the click.
    const permission = this.deps.permissions.request(
      effectiveBaseUrl(input.provider, input.base_url),
    );
    void this.saveInput(input, permission);
  }

  private async saveInput(input: LLMConfigInput, permission: Promise<boolean>): Promise<void> {
    this.setBusy(true);
    try {
      const granted = await this.awaitPermission(permission);
      if (this.isClosed()) return;
      let saved: LLMConfig;
      try {
        saved =
          this.config === undefined
            ? await this.deps.store.createConfig(input)
            : await this.deps.store.updateConfig(this.config.id, input);
      } catch (err) {
        this.showSaveError(err);
        return;
      }
      this.deps.channel.post("configs-changed");
      this.config = saved;
      this.options.onSaved(saved, granted);
      if (this.isClosed()) return;
      if (granted) {
        this.options.onClose();
      } else {
        // Stay open, now editing the saved LLM, so that the warning can be read.
        this.fill(saved);
        this.apiKey.value = "";
        this.showRefused(input);
        setText(this.cancel, "Close");
      }
    } finally {
      this.setBusy(false);
    }
  }

  private async awaitPermission(permission: Promise<boolean>): Promise<boolean> {
    try {
      return await permission;
    } catch (err) {
      this.deps.log.warn("asking for the host permission failed", { err });
      return false;
    }
  }

  private showSaveError(err: unknown): void {
    this.deps.log.error("saving the LLM failed", { err });
    if (err instanceof AppError) {
      if (err.tag === "LLMConfigNameTaken") {
        this.showFieldError("name", "Another LLM already has this name.");
        this.name.focus();
        return;
      }
      const field = err.metadata.field;
      if (err.tag === "LLMConfigInvalid" && typeof field === "string" && field in FIELD_LABELS) {
        this.showFieldError(field as ConfigField, err.message);
        return;
      }
      this.showResult("error", `Could not save the LLM: ${err.message}`);
      return;
    }
    this.showResult("error", "Could not save the LLM.");
  }

  private setBusy(busy: boolean): void {
    this.save.disabled = busy;
  }

  // Test connection

  private onTest(): void {
    this.clearMessages();
    // Test connection needs no name: a placeholder stands in for the check.
    const input = this.read();
    const problems = configProblems({ ...input, name: input.name === "" ? "test" : input.name });
    if (problems.length > 0) {
      this.showProblems(problems);
      return;
    }
    const permission = this.deps.permissions.request(
      effectiveBaseUrl(input.provider, input.base_url),
    );
    void this.runTest(input, permission);
  }

  private async runTest(input: LLMConfigInput, permission: Promise<boolean>): Promise<void> {
    this.testing?.abort();
    const controller = new AbortController();
    this.testing = controller;
    const aborted = () => controller.signal.aborted;
    this.test.disabled = true;
    this.showResult("busy", "Testing the connection...");
    try {
      const granted = await this.awaitPermission(permission);
      if (aborted()) return;
      if (!granted) this.showRefused(input);
      const { elapsedMs } = await testConnection(input, this.deps, {
        signal: controller.signal,
        ...(input.name === "" ? {} : { name: input.name }),
      });
      if (aborted()) return;
      this.showResult("ok", `Connection works (${formatElapsed(elapsedMs)}).`);
    } catch (err) {
      // A cancelled test, or one that finished after the form was closed, reports nothing.
      if (isCancelled(err, controller.signal) || aborted()) return;
      this.deps.log.warn("test connection failed", { err });
      this.showResult(
        "error",
        `Test failed: ${err instanceof AppError ? err.message : "unexpected error"}`,
      );
    } finally {
      if (this.testing === controller) this.testing = undefined;
      this.test.disabled = false;
    }
  }
}

/** "0.4 s" or "850 ms". */
export function formatElapsed(ms: number): string {
  return ms < 1000 ? `${String(Math.round(ms))} ms` : `${(ms / 1000).toFixed(1)} s`;
}
