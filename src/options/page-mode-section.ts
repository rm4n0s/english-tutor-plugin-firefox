import { AppError } from "../core/errors";
import { pageModeNote } from "../core/llm";
import { PAGE_MODE_OFF, SETTINGS_CHANGED } from "../core/page-mode/messages";
import type { LLMConfig, Settings } from "../core/store";
import { el, setHidden, setText } from "../ui/dom";
import type { OptionsDeps } from "./deps";

/** What the form says when the user refuses to give access back (SPEC section 4.11). */
export const PERMISSION_DENIED_MESSAGE =
  "Access to all websites was not allowed, so the icon only appears on the sites English Tutor can reach. Press the button again to be asked again.";

/** The label of the box: the global switch of page mode (SPEC sections 4.7 and 4.11). */
export const OFFER_LABEL = "Show the English Tutor icon in text boxes on websites";

/** The label of the box that turns the automatic checks of text boxes on and off (SPEC section 4.11). */
export const AUTO_CHECK_LABEL = "Check automatically while typing in text boxes on websites";

/** What the options page says when the access to all websites is gone. */
export const ACCESS_WITHDRAWN =
  "English Tutor does not have access to all websites any more (it was withdrawn in the extensions panel or in about:addons). The icon only appears on the websites it can still reach, and on none if nothing is left.";

const SITE_LABELS: Readonly<Record<string, string>> = { on: "On", off: "Off" };

/**
 * Page mode in the General section (SPEC sections 4.7 and 4.11): the box "Show the English Tutor
 * icon in text boxes on websites" (on by default) with its privacy note, the notice with a button
 * that asks for access to all websites again when Firefox no longer grants it, and the list of
 * sites with a choice, with their state and a Remove button. The box only stores the setting and
 * tells the open pages: the content script is declared in the manifest and the access comes with
 * the installation, so nothing is requested or registered here. Changes are saved at once and
 * announced on the channel.
 */
export class PageModeSection {
  private readonly doc: Document;
  private readonly deps: OptionsDeps;
  private readonly report: (err: unknown) => void;
  private readonly box: HTMLInputElement;
  private readonly autoBox: HTMLInputElement;
  private readonly note: HTMLElement;
  private readonly accessNotice: HTMLElement;
  private readonly accessButton: HTMLButtonElement;
  private readonly errorLine: HTMLElement;
  private readonly sitesHeading: HTMLElement;
  private readonly siteList: HTMLElement;
  private readonly sitesEmpty: HTMLElement;
  private failure: AppError | undefined;
  private llm: LLMConfig | undefined;
  /** Called when the box changes, so that the auto-check delay can follow (SPEC section 4.7). */
  onChange: () => void = () => undefined;

  constructor(doc: Document, host: HTMLElement, deps: OptionsDeps, report: (err: unknown) => void) {
    this.doc = doc;
    this.deps = deps;
    this.report = report;
    this.box = el(doc, "input", { id: "page-mode", type: "checkbox" });
    this.autoBox = el(doc, "input", { id: "page-mode-auto-check", type: "checkbox" });
    this.note = el(doc, "p", { id: "page-mode-note", class: "note" });
    this.accessButton = el(doc, "button", { id: "page-mode-access-button", type: "button" }, [
      "Allow access to all websites",
    ]);
    this.accessNotice = el(
      doc,
      "div",
      { id: "page-mode-access", class: "access-notice", hidden: true },
      [
        el(doc, "p", { class: "note" }, [ACCESS_WITHDRAWN]),
        el(doc, "div", { class: "actions" }, [this.accessButton]),
      ],
    );
    this.errorLine = el(doc, "p", {
      id: "page-mode-error",
      class: "message error",
      role: "alert",
      hidden: true,
    });
    this.sitesHeading = el(doc, "p", { class: "note page-mode-hosts-heading" }, [
      "Sites you made a choice on:",
    ]);
    this.siteList = el(doc, "ul", { id: "page-mode-sites", class: "host-list" });
    this.sitesEmpty = el(doc, "p", { id: "page-mode-sites-empty", class: "note" }, [
      "No site has a choice yet. On a site you have not turned on, a grey icon appears on a text box you click into, and English Tutor asks when you click it.",
    ]);
    host.append(
      el(doc, "div", { class: "form-row single" }, [
        el(doc, "label", { class: "inline", for: "page-mode" }, [this.box, ` ${OFFER_LABEL}`]),
      ]),
      el(doc, "div", { class: "form-row single" }, [
        el(doc, "label", { class: "inline", for: "page-mode-auto-check" }, [
          this.autoBox,
          ` ${AUTO_CHECK_LABEL}`,
        ]),
      ]),
      this.note,
      this.accessNotice,
      this.errorLine,
      this.sitesHeading,
      this.siteList,
      this.sitesEmpty,
    );
    this.box.addEventListener("click", () => {
      this.setSwitch(this.box.checked).catch((err: unknown) => {
        this.report(err);
        this.reloadBox();
      });
      this.onChange();
    });
    this.autoBox.addEventListener("click", () => {
      this.saveAutoCheck(this.autoBox.checked).catch((err: unknown) => {
        this.report(err);
        this.reloadBox();
      });
      this.onChange();
    });
    // The permission is requested in the click handler itself: Firefox accepts it only during a
    // user gesture, so nothing is awaited before the call.
    this.accessButton.addEventListener("click", () => {
      this.requestAccess(this.deps.pageMode.request());
    });
    // The user may give access back, or withdraw it, in the extensions panel or about:addons:
    // the notice follows at once, and again when the user comes back to this tab.
    const look = (): void => {
      this.refreshAccess().catch(this.report);
    };
    deps.pageMode.onRemoved(look);
    deps.pageMode.onAdded(look);
    doc.defaultView?.addEventListener("focus", look);
  }

  /** The failure the form shows, or undefined (its route is `PageModeSection.requestAccess->...`). */
  get error(): AppError | undefined {
    return this.failure;
  }

  /** Whether the switch is ticked. */
  get on(): boolean {
    return this.box.checked;
  }

  /** Whether page mode checks by itself now: the switch is on and the automatic-check box is ticked. */
  get autoCheckOn(): boolean {
    return this.box.checked && this.autoBox.checked;
  }

  /** Shows the settings and the selected LLM (for the privacy note). */
  async load(settings: Settings, llm: LLMConfig | undefined): Promise<void> {
    this.llm = llm;
    this.box.checked = settings.page_mode;
    this.autoBox.checked = settings.page_mode_auto_check;
    this.autoBox.disabled = !settings.page_mode;
    this.onChange();
    setText(this.note, pageModeNote(llm));
    const sites = Object.entries(settings.page_mode_sites).sort(([a], [b]) => a.localeCompare(b));
    this.siteList.replaceChildren(
      ...sites.map(([host, choice]) =>
        el(this.doc, "li", { class: "host-row", "data-host": host }, [
          el(this.doc, "span", { class: "host-name" }, [host]),
          el(this.doc, "span", { class: `site-state site-${choice}` }, [
            SITE_LABELS[choice] ?? choice,
          ]),
          this.removeButton(host),
        ]),
      ),
    );
    const none = sites.length === 0;
    setHidden(this.sitesEmpty, !none);
    setHidden(this.sitesHeading, none);
    setHidden(this.siteList, none);
    await this.refreshAccess();
  }

  /** Shows the notice with its button while access to all websites is not granted. */
  async refreshAccess(): Promise<void> {
    const granted = await this.deps.pageMode.contains();
    setHidden(this.accessNotice, granted);
    if (granted) this.showError(undefined);
  }

  private removeButton(host: string): HTMLButtonElement {
    const button = el(
      this.doc,
      "button",
      { type: "button", class: "host-remove", "aria-label": `Remove ${host}` },
      ["Remove"],
    );
    button.addEventListener("click", () => {
      this.removeSite(host).catch(this.report);
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

  /**
   * The box: stores the setting and tells the open pages (`page-mode-off` removes everything at
   * once; `settings-changed` makes them ask again).
   */
  private async setSwitch(on: boolean): Promise<void> {
    await this.deps.store.setSetting("page_mode", on);
    this.autoBox.disabled = !on;
    this.deps.channel.post("settings-changed");
    await this.deps.tabs.broadcast(on ? SETTINGS_CHANGED : PAGE_MODE_OFF);
  }

  /** The automatic-check box: stored and announced; the frame reads it when a box is focused. */
  private async saveAutoCheck(on: boolean): Promise<void> {
    await this.deps.store.setSetting("page_mode_auto_check", on);
    this.deps.channel.post("settings-changed");
  }

  /** `asked` is the permission request, made by the click handler in the turn of the click. */
  private requestAccess(asked: Promise<boolean>): void {
    this.finishRequestAccess(asked).catch((err: unknown) => {
      this.report(err);
    });
  }

  private async finishRequestAccess(asked: Promise<boolean>): Promise<void> {
    let granted = false;
    let cause: unknown;
    try {
      granted = await asked;
    } catch (err) {
      cause = err;
    }
    if (!granted) {
      this.showError(
        new AppError(
          "PageModePermissionDenied",
          PERMISSION_DENIED_MESSAGE,
          {},
          cause === undefined ? undefined : { cause },
        ).via("PageModeSection.requestAccess"),
      );
      return;
    }
    this.showError(undefined);
    setHidden(this.accessNotice, true);
    // The background script starts the open tabs when it sees the permission arrive; the pages
    // that already run ask again.
    await this.deps.tabs.broadcast(SETTINGS_CHANGED);
  }

  /** A removed site is asked about again. */
  private async removeSite(host: string): Promise<void> {
    const sites = await this.deps.store.getSetting("page_mode_sites");
    await this.deps.store.setSetting(
      "page_mode_sites",
      Object.fromEntries(Object.entries(sites).filter(([h]) => h !== host)),
    );
    this.deps.channel.post("settings-changed");
    await this.deps.tabs.broadcast(SETTINGS_CHANGED);
    await this.reloadSettings();
  }

  private reloadBox(): void {
    this.reloadSettings().catch(this.report);
  }

  private async reloadSettings(): Promise<void> {
    const settings = await this.deps.store.getSettings();
    await this.load(settings, this.llm);
  }
}
