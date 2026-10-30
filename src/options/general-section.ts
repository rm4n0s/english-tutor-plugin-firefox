import { AppError } from "../core/errors";
import type { SettingKey, Settings } from "../core/store";
import { el, setHidden, setText } from "../ui/dom";
import type { OptionsDeps } from "./deps";
import { PageModeSection } from "./page-mode-section";

type FontGroup = "editor" | "button" | "results";

const FONT_ROWS: readonly { group: FontGroup; label: string }[] = [
  { group: "editor", label: "Editor font" },
  { group: "button", label: "Button font" },
  { group: "results", label: "Results font (issues and explanations)" },
];

const MESSAGES: Readonly<Partial<Record<SettingKey, string>>> = {
  auto_check_delay_s: "The delay must be a number from 1 to 60 seconds.",
  editor_font_family: "A font family is at most 100 characters.",
  button_font_family: "A font family is at most 100 characters.",
  results_font_family: "A font family is at most 100 characters.",
  editor_font_size: "The size must be a number from 6 to 48 points.",
  button_font_size: "The size must be a number from 6 to 48 points.",
  results_font_size: "The size must be a number from 6 to 48 points.",
};

/** The General section of the options page (SPEC section 4.7). Changes are saved at once. */
export class GeneralSection {
  private readonly doc: Document;
  private readonly deps: OptionsDeps;
  private readonly report: (err: unknown) => void;
  private readonly autoCheck: HTMLInputElement;
  private readonly delay: HTMLInputElement;
  private readonly delayError: HTMLElement;
  /** The page-mode box and the list of sites it is off on (SPEC section 4.11). */
  readonly pageMode: PageModeSection;
  private readonly families = new Map<FontGroup, HTMLInputElement>();
  private readonly sizes = new Map<FontGroup, HTMLInputElement>();
  private readonly fontErrors = new Map<FontGroup, HTMLElement>();

  constructor(doc: Document, host: HTMLElement, deps: OptionsDeps, report: (err: unknown) => void) {
    this.doc = doc;
    this.deps = deps;
    this.report = report;

    this.autoCheck = el(doc, "input", { id: "auto-check", type: "checkbox" });
    this.delay = el(doc, "input", {
      id: "auto-check-delay",
      type: "number",
      min: "1",
      max: "60",
      step: "1",
    });
    this.delayError = this.errorLine("auto-check-delay-error");
    host.append(
      el(doc, "div", { class: "form-row single" }, [
        el(doc, "label", { class: "inline", for: "auto-check" }, [
          this.autoCheck,
          " Auto-check while typing",
        ]),
      ]),
      el(doc, "div", { class: "form-row" }, [
        el(doc, "label", { for: "auto-check-delay" }, ["Auto-check delay (seconds)"]),
        this.delay,
        this.delayError,
      ]),
    );

    this.pageMode = new PageModeSection(doc, host, deps, report);
    this.pageMode.onChange = () => {
      this.syncDelay();
    };

    for (const { group, label } of FONT_ROWS) {
      const family = el(doc, "input", {
        id: `font-${group}-family`,
        type: "text",
        maxlength: "100",
        placeholder: "default",
        autocomplete: "off",
        "aria-label": `${label}: family`,
      });
      const size = el(doc, "input", {
        id: `font-${group}-size`,
        type: "number",
        min: "6",
        max: "48",
        step: "1",
        "aria-label": `${label}: size in points`,
      });
      const error = this.errorLine(`font-${group}-error`);
      this.families.set(group, family);
      this.sizes.set(group, size);
      this.fontErrors.set(group, error);
      host.append(
        el(doc, "div", { class: "form-row font-row" }, [
          el(doc, "label", { for: `font-${group}-family` }, [label]),
          el(doc, "span", { class: "font-controls" }, [family, size, " pt"]),
          error,
        ]),
      );
      this.bindFont(group, family, size, error);
    }
    host.append(
      el(doc, "p", { class: "note" }, [
        "Changes are saved at once. A font that is not installed falls back to the default.",
      ]),
    );

    this.autoCheck.addEventListener("change", () => {
      this.syncDelay();
      void this.save("auto_check", this.autoCheck.checked, this.delayError);
    });
    this.delay.addEventListener("change", () => {
      void this.save("auto_check_delay_s", Number(this.delay.value), this.delayError);
    });
  }

  /** Reads the settings from the store into the controls. */
  async load(): Promise<void> {
    try {
      const [settings, configs] = await Promise.all([
        this.deps.store.getSettings(),
        this.deps.store.listConfigs(),
      ]);
      this.show(settings);
      // The LLM the privacy note names: the selected one, or the first by name, as the tutor page.
      await this.pageMode.load(
        settings,
        configs.find((c) => c.id === settings.selected_llm_id) ?? configs[0],
      );
    } catch (err) {
      this.report(err);
    }
  }

  private show(settings: Settings): void {
    this.autoCheck.checked = settings.auto_check;
    this.delay.value = String(settings.auto_check_delay_s);
    this.syncDelay();
    for (const { group } of FONT_ROWS) {
      const family = this.families.get(group);
      const size = this.sizes.get(group);
      if (family) family.value = settings[`${group}_font_family`];
      if (size) size.value = String(settings[`${group}_font_size`]);
    }
  }

  /** The delay is used by auto-check, and by page mode (SPEC section 4.7). */
  private syncDelay(): void {
    this.delay.disabled = !this.autoCheck.checked && !this.pageMode.autoCheckOn;
  }

  private errorLine(id: string): HTMLElement {
    return el(this.doc, "p", { id, class: "message error", role: "alert", hidden: true });
  }

  private bindFont(
    group: FontGroup,
    family: HTMLInputElement,
    size: HTMLInputElement,
    error: HTMLElement,
  ): void {
    family.addEventListener("change", () => {
      void this.save(`${group}_font_family`, family.value.trim(), error);
    });
    size.addEventListener("change", () => {
      void this.save(`${group}_font_size`, Number(size.value), error);
    });
  }

  /** Saves one setting and announces it. A value the store refuses is explained next to its field. */
  private async save<K extends SettingKey>(
    key: K,
    value: Settings[K],
    error: HTMLElement,
  ): Promise<void> {
    try {
      await this.deps.store.setSetting(key, value);
      setHidden(error, true);
      this.deps.channel.post("settings-changed");
    } catch (err) {
      if (err instanceof AppError && err.tag === "SettingInvalid") {
        setText(error, MESSAGES[key] ?? "This value is not allowed.");
        setHidden(error, false);
        return;
      }
      this.report(err);
    }
  }
}
