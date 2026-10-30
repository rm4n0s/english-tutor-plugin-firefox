import { AppError } from "../core/errors";
import {
  effectiveBaseUrl,
  isCancelled,
  PROVIDER_LABELS,
  supportsApiKey,
  testConnection,
} from "../core/llm";
import type { LLMConfig } from "../core/store";
import { originPattern } from "../platform/permissions";
import { el, setHidden, setText } from "../ui/dom";
import type { OptionsDeps } from "./deps";
import { formatElapsed, LLMForm } from "./llm-form";

/** The LLMs section of the options page (SPEC section 4.7): the list, its actions and the form. */
export class LLMSection {
  private readonly doc: Document;
  private readonly deps: OptionsDeps;
  private readonly report: (err: unknown) => void;
  private configs: LLMConfig[] = [];
  private selectedLlmId: number | null = null;
  /** The row the actions apply to. */
  private highlighted: number | null = null;
  private form: LLMForm | undefined;
  private testing: AbortController | undefined;

  private readonly list: HTMLElement;
  private readonly empty: HTMLElement;
  private readonly status: HTMLElement;
  private readonly confirm: HTMLElement;
  private readonly confirmText: HTMLElement;
  private readonly formHost: HTMLElement;
  private readonly addButton: HTMLButtonElement;
  private readonly editButton: HTMLButtonElement;
  private readonly deleteButton: HTMLButtonElement;
  private readonly testButton: HTMLButtonElement;

  constructor(doc: Document, host: HTMLElement, deps: OptionsDeps, report: (err: unknown) => void) {
    this.doc = doc;
    this.deps = deps;
    this.report = report;

    this.addButton = el(doc, "button", { id: "llm-add", type: "button" }, ["Add"]);
    this.editButton = el(doc, "button", { id: "llm-edit", type: "button" }, ["Edit"]);
    this.deleteButton = el(doc, "button", { id: "llm-delete", type: "button" }, ["Delete"]);
    this.testButton = el(doc, "button", { id: "llm-test-selected", type: "button" }, [
      "Test connection",
    ]);
    this.list = el(doc, "ul", {
      id: "llm-list",
      class: "llm-list",
      role: "listbox",
      "aria-label": "Configured LLMs",
    });
    this.empty = el(doc, "p", { id: "llm-empty", class: "note" }, [
      "No LLM is configured yet. Press Add to set one up.",
    ]);
    this.status = el(doc, "p", {
      id: "llm-status",
      class: "message",
      role: "status",
      hidden: true,
    });
    this.confirmText = el(doc, "span", { id: "llm-confirm-text" });
    const confirmDelete = el(
      doc,
      "button",
      { id: "llm-confirm-delete", type: "button", class: "danger" },
      ["Delete"],
    );
    const confirmCancel = el(doc, "button", { id: "llm-confirm-cancel", type: "button" }, [
      "Cancel",
    ]);
    this.confirm = el(
      doc,
      "div",
      { id: "llm-confirm", class: "confirm", role: "alertdialog", hidden: true },
      [this.confirmText, confirmDelete, confirmCancel],
    );
    this.formHost = el(doc, "div", { id: "llm-form-host" });

    host.append(
      el(doc, "div", { class: "actions" }, [
        this.addButton,
        this.editButton,
        this.deleteButton,
        this.testButton,
      ]),
      this.list,
      this.empty,
      this.status,
      this.confirm,
      this.formHost,
    );

    this.addButton.addEventListener("click", () => {
      this.openForm(undefined);
    });
    this.editButton.addEventListener("click", () => {
      this.openForm(this.highlightedConfig());
    });
    this.deleteButton.addEventListener("click", () => {
      this.askDelete();
    });
    // The click handler is not async: the permission request must come before any `await`.
    this.testButton.addEventListener("click", () => {
      this.testHighlighted();
    });
    confirmDelete.addEventListener("click", () => {
      void this.deleteHighlighted();
    });
    confirmCancel.addEventListener("click", () => {
      setHidden(this.confirm, true);
    });
    this.list.addEventListener("keydown", (event) => {
      this.onListKey(event);
    });
    this.renderList();
  }

  /** Reads the LLMs and the selection from the store and draws the list. */
  async load(): Promise<void> {
    try {
      const [configs, selected] = await Promise.all([
        this.deps.store.listConfigs(),
        this.deps.store.getSetting("selected_llm_id"),
      ]);
      this.configs = configs;
      this.selectedLlmId = selected;
      if (this.highlighted !== null && !configs.some((c) => c.id === this.highlighted)) {
        this.highlighted = null;
      }
      this.renderList();
    } catch (err) {
      this.report(err);
    }
  }

  /** Stops what is running; called when the page goes away. */
  destroy(): void {
    this.testing?.abort();
    this.form?.close();
  }

  // The list

  private highlightedConfig(): LLMConfig | undefined {
    return this.configs.find((c) => c.id === this.highlighted);
  }

  private renderList(): void {
    const doc = this.doc;
    this.list.replaceChildren(
      ...this.configs.map((config) => {
        const keyText = !supportsApiKey(config.provider)
          ? "no key needed"
          : config.api_key === ""
            ? "no key"
            : "key stored";
        const name = el(doc, "span", { class: "llm-name" }, [config.name]);
        if (config.id === this.selectedLlmId) {
          name.append(
            " ",
            el(doc, "span", { class: "tag", title: "Used by the editor" }, ["in use"]),
          );
        }
        const row = el(
          doc,
          "li",
          {
            class: "llm-row",
            role: "option",
            tabindex: "0",
            "data-id": String(config.id),
            "aria-selected": String(config.id === this.highlighted),
          },
          [
            name,
            el(doc, "span", { class: "llm-provider" }, [PROVIDER_LABELS[config.provider]]),
            el(doc, "span", { class: "llm-model" }, [config.model]),
            el(doc, "span", { class: "llm-url" }, [
              effectiveBaseUrl(config.provider, config.base_url) || "-",
            ]),
            el(doc, "span", { class: "llm-key" }, [keyText]),
          ],
        );
        row.addEventListener("click", () => {
          this.highlight(config.id);
        });
        row.addEventListener("dblclick", () => {
          this.highlight(config.id);
          this.openForm(config);
        });
        return row;
      }),
    );
    setHidden(this.empty, this.configs.length > 0);
    setHidden(this.list, this.configs.length === 0);
    this.syncActions();
  }

  private highlight(id: number): void {
    this.highlighted = id;
    setHidden(this.confirm, true);
    setHidden(this.status, true);
    for (const row of this.list.children) {
      row.setAttribute("aria-selected", String(row.getAttribute("data-id") === String(id)));
    }
    this.syncActions();
  }

  private syncActions(): void {
    const none = this.highlightedConfig() === undefined;
    this.editButton.disabled = none;
    this.deleteButton.disabled = none;
    this.testButton.disabled = none;
  }

  private onListKey(event: KeyboardEvent): void {
    const index = this.configs.findIndex((c) => c.id === this.highlighted);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const next = this.configs[index + (event.key === "ArrowDown" ? 1 : -1)];
      if (next !== undefined) {
        event.preventDefault();
        this.highlight(next.id);
        this.list.querySelector<HTMLElement>(`[data-id="${String(next.id)}"]`)?.focus();
      }
    } else if (event.key === "Enter") {
      const config = this.highlightedConfig();
      if (config !== undefined) this.openForm(config);
    }
  }

  private showStatus(kind: "ok" | "error" | "busy", message: string): void {
    this.status.className = `message ${kind}`;
    setText(this.status, message);
    setHidden(this.status, false);
  }

  // The form

  private openForm(config: LLMConfig | undefined): void {
    this.closeForm();
    setHidden(this.confirm, true);
    setHidden(this.status, true);
    const form = new LLMForm({
      doc: this.doc,
      deps: this.deps,
      ...(config === undefined ? {} : { config }),
      onSaved: (saved, granted) => {
        this.highlighted = saved.id;
        this.showStatus(
          granted ? "ok" : "error",
          granted
            ? `Saved "${saved.name}".`
            : `Saved "${saved.name}", without access to its server.`,
        );
        void this.load();
      },
      onClose: () => {
        this.closeForm();
      },
    });
    this.form = form;
    this.formHost.replaceChildren(form.element);
    form.element.scrollIntoView({ block: "nearest" });
    form.focus();
  }

  private closeForm(): void {
    this.form?.close();
    this.form = undefined;
    this.formHost.replaceChildren();
  }

  // Test connection for the highlighted row

  private testHighlighted(): void {
    const config = this.highlightedConfig();
    if (config === undefined) return;
    // Before any `await`: Firefox accepts the request only during the click.
    const permission = this.deps.permissions.request(
      effectiveBaseUrl(config.provider, config.base_url),
    );
    void this.runTest(config, permission);
  }

  private async runTest(config: LLMConfig, permission: Promise<boolean>): Promise<void> {
    this.testing?.abort();
    const controller = new AbortController();
    this.testing = controller;
    this.testButton.disabled = true;
    this.showStatus("busy", `Testing "${config.name}"...`);
    try {
      try {
        await permission;
      } catch (err) {
        this.deps.log.warn("asking for the host permission failed", { err });
      }
      const { elapsedMs } = await testConnection(config, this.deps, {
        name: config.name,
        signal: controller.signal,
      });
      this.showStatus("ok", `"${config.name}": connection works (${formatElapsed(elapsedMs)}).`);
    } catch (err) {
      if (isCancelled(err, controller.signal)) return;
      this.deps.log.warn("test connection failed", { err });
      this.showStatus(
        "error",
        `Test of "${config.name}" failed: ${err instanceof AppError ? err.message : "unexpected error"}`,
      );
    } finally {
      if (this.testing === controller) this.testing = undefined;
      this.syncActions();
    }
  }

  // Delete

  private askDelete(): void {
    const config = this.highlightedConfig();
    if (config === undefined) return;
    setText(this.confirmText, `Delete "${config.name}"? This cannot be undone.`);
    setHidden(this.confirm, false);
  }

  private async deleteHighlighted(): Promise<void> {
    const config = this.highlightedConfig();
    setHidden(this.confirm, true);
    if (config === undefined) return;
    this.closeForm();
    const { store, channel, permissions } = this.deps;
    try {
      await store.deleteConfig(config.id);
      const remaining = await store.listConfigs();
      // The store leaves the selection alone: the next one is the first by name, or none.
      const selectionChanged = (await store.getSetting("selected_llm_id")) === config.id;
      if (selectionChanged) await store.setSetting("selected_llm_id", remaining[0]?.id ?? null);
      channel.post("configs-changed");
      if (selectionChanged) channel.post("settings-changed");

      // The permission goes with the last LLM that uses the origin.
      const url = effectiveBaseUrl(config.provider, config.base_url);
      const pattern = originPattern(url);
      const stillUsed = remaining.some(
        (other) => originPattern(effectiveBaseUrl(other.provider, other.base_url)) === pattern,
      );
      if (!stillUsed) {
        try {
          await permissions.remove(url);
        } catch (err) {
          this.deps.log.warn("removing the host permission failed", { err });
        }
      }
      if (this.highlighted === config.id) this.highlighted = null;
      this.showStatus("ok", `Deleted "${config.name}".`);
    } catch (err) {
      this.report(err);
    }
    await this.load();
  }
}
