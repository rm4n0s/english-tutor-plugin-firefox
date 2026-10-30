import type { Logger } from "../core/log";
import type { ContextMenus } from "../platform/menus";
import type { CurrentTab } from "../platform/tabs";

export interface EditorMenuActions {
  /** The **Alternative** entry was chosen. Read the selection now. */
  alternatives(): void;
  /** The **Check** entry was chosen. Read the selection now. */
  checkSelection(): void;
  /**
   * Whether the entries show: the editor has a selection that is not only white space, and no
   * manual check runs (the loading layer is up). Asked when the menu is shown.
   */
  available(): boolean;
  /** Whether Check can work now (an LLM is selected). */
  canCheck(): boolean;
}

export interface EditorMenuDeps {
  menus: ContextMenus;
  currentTab: CurrentTab;
  /** The address of the tutor page, which the entries are limited to (`documentUrlPatterns`). */
  pageUrl: string;
  actions: EditorMenuActions;
  log: Logger;
}

/**
 * The editor's context menu entries (SPEC section 4.3): **Alternative** and, below it, **Check**,
 * after the browser's own entries (Cut, Copy, Paste, Select All, spell check). The page calls
 * `open` from the textarea's `contextmenu` event, which calls `menus.overrideContext({
 * showDefaults: true })`.
 *
 * Made like the row menu (`RowMenu`): the entries are made for this tab alone (their ids contain
 * the tab id), invisible, and `menus.onShown` makes them visible for the menu this page opened
 * only when `available()` says so (and enables Check only when `canCheck()`), followed by
 * `menus.refresh()`. A click is handled only for this tab. The selection is not remembered here:
 * the page reads it from the textarea when an entry is chosen.
 */
export class EditorMenu {
  private readonly deps: EditorMenuDeps;
  private ids: { alternative: string; check: string } | undefined;
  private armed = false;
  private readonly stops: (() => void)[] = [];

  constructor(deps: EditorMenuDeps) {
    this.deps = deps;
  }

  /** Makes the entries. Without a tab (the page is not in one) there is no menu. */
  async start(): Promise<void> {
    const { menus, currentTab, pageUrl } = this.deps;
    const tabId = await currentTab.id();
    if (tabId === undefined) return;
    const ids = {
      alternative: `editor-alternative-${String(tabId)}`,
      check: `editor-check-${String(tabId)}`,
    };
    this.ids = ids;
    this.stops.push(
      menus.onClicked((click) => {
        if (click.tabId !== tabId) return;
        if (click.id === ids.alternative) this.deps.actions.alternatives();
        else if (click.id === ids.check && this.deps.actions.canCheck()) {
          this.deps.actions.checkSelection();
        }
      }),
      menus.onShown((shown) => {
        if (!this.armed || shown.tabId !== tabId) return;
        this.show().catch((err: unknown) => {
          this.deps.log.warn("could not show the editor menu entries", { err });
        });
      }),
      menus.onHidden(() => {
        if (!this.armed) return;
        this.armed = false;
        menus
          .update(ids.alternative, { visible: false })
          .then(() => menus.update(ids.check, { visible: false }))
          .catch((err: unknown) => {
            this.deps.log.warn("could not hide the editor menu entries", { err });
          });
      }),
    );
    await menus.create(
      [
        { id: ids.alternative, title: "Alternative", visible: false },
        { id: ids.check, title: "Check", visible: false },
      ],
      [pageUrl],
    );
  }

  /** The user opened the context menu on the editor. Call it from the event. */
  open(): void {
    if (this.ids === undefined) return;
    this.armed = true;
    this.deps.menus.overrideContext({ showDefaults: true });
  }

  destroy(): void {
    for (const stop of this.stops.splice(0)) stop();
    if (this.ids !== undefined) {
      this.deps.menus.remove([this.ids.alternative, this.ids.check]).catch((err: unknown) => {
        this.deps.log.warn("could not remove the editor menu entries", { err });
      });
    }
  }

  private async show(): Promise<void> {
    const { menus, actions } = this.deps;
    if (this.ids === undefined || !actions.available()) return;
    await menus.update(this.ids.alternative, { visible: true });
    await menus.update(this.ids.check, { visible: true, enabled: actions.canCheck() });
    await menus.refresh();
  }
}
