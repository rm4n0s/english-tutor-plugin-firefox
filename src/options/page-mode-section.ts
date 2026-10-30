import { AppError } from "../core/errors";
import { pageModeNote } from "../core/llm";
import type { LLMConfig, Settings } from "../core/store";
import { el, setHidden, setText } from "../ui/dom";
import type { OptionsDeps } from "./deps";

/** What the form says when the user refuses the permission (SPEC section 4.11). */
export const PERMISSION_DENIED_MESSAGE =
  "Access to all websites was not allowed, so page mode stays off. Tick the box again to be asked again.";

/**
 * Page mode in the General section (SPEC sections 4.7 and 4.11): the box "Check text boxes on
 * websites" with its privacy note, and the list of sites it is turned off on. Ticking the box asks
 * for the `<all_urls>` permission (from the click handler itself), stores the setting and has the
 * background script register the content script; unticking it undoes all three. Changes are saved
 * at once and announced on the channel.
 */
export class PageModeSection {
  private readonly doc: Document;
  private readonly deps: OptionsDeps;
  private readonly report: (err: unknown) => void;
  private readonly box: HTMLInputElement;
  private readonly note: HTMLElement;
  private readonly errorLine: HTMLElement;
  private readonly hostsHeading: HTMLElement;
  private readonly hostList: HTMLElement;
  private readonly hostsEmpty: HTMLElement;
  private failure: AppError | undefined;
  private llm: LLMConfig | undefined;
  /** Called when the box changes, so that the auto-check delay can follow (SPEC section 4.7). */
  onChange: () => void = () => undefined;

  constructor(doc: Document, host: HTMLElement, deps: OptionsDeps, report: (err: unknown) => void) {
    this.doc = doc;
    this.deps = deps;
    this.report = report;
    this.box = el(doc, "input", { id: "page-mode", type: "checkbox" });
    this.note = el(doc, "p", { id: "page-mode-note", class: "note" });
    this.errorLine = el(doc, "p", {
      id: "page-mode-error",
      class: "message error",
      role: "alert",
      hidden: true,
    });
    this.hostsHeading = el(doc, "p", { class: "note page-mode-hosts-heading" }, [
      "Sites where page mode is off:",
    ]);
    this.hostList = el(doc, "ul", { id: "page-mode-hosts", class: "host-list" });
    this.hostsEmpty = el(doc, "p", { id: "page-mode-hosts-empty", class: "note" }, [
      "Page mode is not turned off on any site. The toolbar button's menu turns it off on the site of the tab in front.",
    ]);
    host.append(
      el(doc, "div", { class: "form-row single" }, [
        el(doc, "label", { class: "inline", for: "page-mode" }, [
          this.box,
          " Check text boxes on websites",
        ]),
      ]),
      this.note,
      this.errorLine,
      this.hostsHeading,
      this.hostList,
      this.hostsEmpty,
    );
    // The permission is requested in the click handler itself: Firefox accepts it only during a
    // user gesture, so nothing is awaited before the call.
    this.box.addEventListener("click", () => {
      if (this.box.checked) this.turnOn(this.deps.pageMode.request());
      else this.turnOff();
      this.onChange();
    });
  }

  /** The failure the form shows, or undefined (its route is `PageModeSection.turnOn->...`). */
  get error(): AppError | undefined {
    return this.failure;
  }

  /** Whether the box is ticked. */
  get on(): boolean {
    return this.box.checked;
  }

  /** Shows the settings and the selected LLM (for the privacy note). */
  load(settings: Settings, llm: LLMConfig | undefined): void {
    this.llm = llm;
    this.box.checked = settings.page_mode;
    this.onChange();
    setText(this.note, pageModeNote(llm));
    this.hostList.replaceChildren(
      ...settings.page_mode_off_hosts.map((host) =>
        el(this.doc, "li", { class: "host-row" }, [
          el(this.doc, "span", { class: "host-name" }, [host]),
          this.removeButton(host),
        ]),
      ),
    );
    const none = settings.page_mode_off_hosts.length === 0;
    setHidden(this.hostsEmpty, !none);
    setHidden(this.hostsHeading, none);
    setHidden(this.hostList, none);
  }

  private removeButton(host: string): HTMLButtonElement {
    const button = el(
      this.doc,
      "button",
      { type: "button", class: "host-remove", "aria-label": `Remove ${host}` },
      ["Remove"],
    );
    button.addEventListener("click", () => {
      this.removeHost(host).catch(this.report);
    });
    return button;
  }

  private showError(err: AppError | undefined): void {
    this.failure = err;
    if (err === undefined) setHidden(this.errorLine, true);
    else {
      setText(this.errorLine, err.message);
      setHidden(this.errorLine, false);
    }
  }

  /** `asked` is the permission request, made by the click handler in the turn of the click. */
  private turnOn(asked: Promise<boolean>): void {
    this.finishTurnOn(asked).catch((err: unknown) => {
      this.report(err);
      this.reloadBox();
    });
  }

  private async finishTurnOn(asked: Promise<boolean>): Promise<void> {
    let granted = false;
    let cause: unknown;
    try {
      granted = await asked;
    } catch (err) {
      cause = err;
    }
    if (!granted) {
      this.box.checked = false;
      this.onChange();
      this.showError(
        new AppError(
          "PageModePermissionDenied",
          PERMISSION_DENIED_MESSAGE,
          {},
          cause === undefined ? undefined : { cause },
        ).via("PageModeSection.turnOn"),
      );
      return;
    }
    this.showError(undefined);
    await this.deps.store.setSetting("page_mode", true);
    this.deps.channel.post("settings-changed");
    await this.deps.background.apply();
  }

  private turnOff(): void {
    this.finishTurnOff().catch((err: unknown) => {
      this.report(err);
      this.reloadBox();
    });
  }

  /**
   * Stores the setting first, then the background script unregisters the script and tells the
   * open pages, and only then is the permission given back (the pages are told before it goes).
   */
  private async finishTurnOff(): Promise<void> {
    this.showError(undefined);
    await this.deps.store.setSetting("page_mode", false);
    this.deps.channel.post("settings-changed");
    await this.deps.background.apply();
    await this.deps.pageMode.remove();
  }

  private async removeHost(host: string): Promise<void> {
    const hosts = await this.deps.store.getSetting("page_mode_off_hosts");
    await this.deps.store.setSetting(
      "page_mode_off_hosts",
      hosts.filter((h) => h !== host),
    );
    this.deps.channel.post("settings-changed");
    await this.deps.background.apply();
    await this.reloadSettings();
  }

  private reloadBox(): void {
    this.reloadSettings().catch(this.report);
  }

  private async reloadSettings(): Promise<void> {
    const settings = await this.deps.store.getSettings();
    this.box.checked = settings.page_mode;
    this.load(settings, this.llm);
  }
}
