import type { Logger } from "../core/log";
import type { ContextMenus } from "../platform/menus";
import type { CurrentTab } from "../platform/tabs";

export interface RowMenuActions {
  notAnError(issueId: number): void;
  regenerate(issueId: number): void;
  /** Whether Regenerate explanation can work now (an LLM is selected). */
  canRegenerate(): boolean;
}

export interface RowMenuDeps {
  menus: ContextMenus;
  currentTab: CurrentTab;
  /** The address of the tutor page, which the entries are limited to (`documentUrlPatterns`). */
  pageUrl: string;
  actions: RowMenuActions;
  log: Logger;
}

/**
 * The context menu of a row of the issues list (SPEC section 4.4): **Not an error** and
 * **Regenerate explanation**. The page calls `open` from the row's `contextmenu` event, which
 * calls `menus.overrideContext` for this tab, so the browser shows only these entries.
 *
 * The entries are made for this tab alone (their ids contain the tab id) and are invisible until
 * the menu this page opened is shown: `menus.onShown` makes them visible (and enables or
 * disables Regenerate) and `menus.refresh()` redraws the open menu. The browser sends menu
 * events to every tutor tab, so a click or a shown menu is handled only when its tab id is
 * the one `tabs.getCurrent()` gave.
 */
export class RowMenu {
  private readonly deps: RowMenuDeps;
  private tabId: number | undefined;
  private ids: { notAnError: string; regenerate: string } | undefined;
  private target: number | undefined;
  private armed = false;
  private readonly stops: (() => void)[] = [];

  constructor(deps: RowMenuDeps) {
    this.deps = deps;
  }

  /** Makes the entries. Without a tab (the page is not in one) there is no menu. */
  async start(): Promise<void> {
    const { menus, currentTab, pageUrl } = this.deps;
    const tabId = await currentTab.id();
    if (tabId === undefined) return;
    const ids = {
      notAnError: `row-not-an-error-${String(tabId)}`,
      regenerate: `row-regenerate-${String(tabId)}`,
    };
    this.tabId = tabId;
    this.ids = ids;
    this.stops.push(
      menus.onClicked((click) => {
        if (click.tabId !== tabId || this.target === undefined) return;
        if (click.id === ids.notAnError) this.deps.actions.notAnError(this.target);
        else if (click.id === ids.regenerate) this.deps.actions.regenerate(this.target);
      }),
      menus.onShown((shown) => {
        if (!this.armed || shown.tabId !== tabId) return;
        this.show().catch((err: unknown) => {
          this.deps.log.warn("could not show the row menu entries", { err });
        });
      }),
      menus.onHidden(() => {
        if (!this.armed) return;
        this.armed = false;
        menus
          .update(ids.notAnError, { visible: false })
          .then(() => menus.update(ids.regenerate, { visible: false }))
          .catch((err: unknown) => {
            this.deps.log.warn("could not hide the row menu entries", { err });
          });
      }),
    );
    await menus.create(
      [
        { id: ids.notAnError, title: "Not an error", visible: false },
        { id: ids.regenerate, title: "Regenerate explanation", visible: false },
      ],
      [pageUrl],
    );
  }

  /** The user opened the context menu on the row of issue `issueId`. Call it from the event. */
  open(issueId: number): void {
    if (this.tabId === undefined || this.ids === undefined) return;
    this.target = issueId;
    this.armed = true;
    this.deps.menus.overrideContext(this.tabId);
  }

  destroy(): void {
    for (const stop of this.stops.splice(0)) stop();
    if (this.ids !== undefined) {
      this.deps.menus.remove([this.ids.notAnError, this.ids.regenerate]).catch((err: unknown) => {
        this.deps.log.warn("could not remove the row menu entries", { err });
      });
    }
  }

  private async show(): Promise<void> {
    const { menus, actions } = this.deps;
    if (this.ids === undefined) return;
    await menus.update(this.ids.notAnError, { visible: true });
    await menus.update(this.ids.regenerate, { visible: true, enabled: actions.canRegenerate() });
    await menus.refresh();
  }
}
