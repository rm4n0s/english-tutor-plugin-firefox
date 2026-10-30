import { categoryLabel } from "../core/analysis";
import {
  issuesEmptyText,
  issuesHeaderText,
  type IssueCounts,
  type IssueState,
  type TextIssue,
} from "../core/issues";
import { el, setText } from "./dom";
import { scrollElementIntoView } from "./reveal";

/** Snippets in a row are cut to about this many characters (SPEC section 4.4). */
export const SNIPPET_CHARS = 40;

/** The wrong snippet for a row: white space runs become one space, and a long one is cut with "…". */
export function snippetPreview(snippet: string, limit = SNIPPET_CHARS): string {
  const flat = snippet.replace(/\s+/g, " ").trim();
  const characters = Array.from(flat);
  return characters.length <= limit ? flat : `${characters.slice(0, limit).join("").trimEnd()}…`;
}

/** The marker letter of a category: G, V or S. */
export function markerLetter(category: string): string {
  return category.charAt(0).toUpperCase();
}

/**
 * The issues list (SPEC section 4.4): a header, and a `role="listbox"` with one row per visible
 * issue in text order, or one grey line when there is none. It observes the `IssueState` and never
 * talks to the editor: clicking a row selects the issue in the state. The tutor page and the
 * page-mode dialog both use it.
 *
 * Each row has the marker, the snippet, the error type label and the count badge (`.count-badge`,
 * "x7": how often the user made that error type, SPEC section 4.4). The badge shows only on rows
 * of a manual check whose type has a recorded mistake, and follows the counts when they change.
 *
 * Keyboard (the list is one tab stop and keeps the focus; the selected row is its
 * `aria-activedescendant`): Up and Down select the previous and next issue, Home and End the first
 * and last, Enter activates the selected one. A double click on a row activates it too. The
 * selected row is scrolled into view, whoever selected it.
 */
export interface IssuesListOptions {
  /**
   * Double click or Enter on an issue (SPEC section 4.4): the tutor page moves the focus to the
   * editor, with the caret at the start of the issue.
   */
  onActivate?(id: number): void;
  /** The counts that the badges show. Without them no badge shows. */
  counts?: IssueCounts;
  /**
   * The context menu opened on a row (SPEC section 4.4). Called from the `contextmenu` event
   * handler, so the page can call `menus.overrideContext` in it.
   */
  onRowContextMenu?(id: number, event: MouseEvent): void;
}

export class IssuesList {
  private readonly doc: Document;
  private readonly options: IssuesListOptions;
  private readonly state: IssueState;
  private readonly header: HTMLElement;
  private readonly list: HTMLElement;
  private readonly unsubscribe: () => void;
  private readonly unsubscribeCounts: (() => void) | undefined;

  constructor(
    doc: Document,
    host: HTMLElement,
    state: IssueState,
    options: IssuesListOptions = {},
  ) {
    this.doc = doc;
    this.options = options;
    this.state = state;
    this.header = el(doc, "h2", { id: "issues-header", class: "issues-header" });
    this.list = el(doc, "div", {
      id: "issues",
      class: "issues",
      role: "listbox",
      "aria-labelledby": "issues-header",
      "aria-orientation": "vertical",
      tabindex: "0",
    });
    host.replaceChildren(this.header, this.list);

    this.list.addEventListener("click", (event) => {
      const id = this.rowId(event);
      if (id !== undefined) this.state.select(id);
    });
    this.list.addEventListener("dblclick", (event) => {
      const id = this.rowId(event);
      if (id === undefined) return;
      this.state.select(id);
      this.options.onActivate?.(id);
    });
    this.list.addEventListener("keydown", this.onKeydown);
    this.list.addEventListener("contextmenu", this.onContextMenu);
    this.unsubscribeCounts = options.counts?.subscribe(() => {
      this.updateBadges();
    });
    this.unsubscribe = state.subscribe((change) => {
      if (change === "selection") this.markSelection();
      else if (change !== "revision") this.render();
    });
    this.render();
  }

  destroy(): void {
    this.unsubscribe();
    this.unsubscribeCounts?.();
    this.list.removeEventListener("keydown", this.onKeydown);
    this.list.removeEventListener("contextmenu", this.onContextMenu);
  }

  private readonly onContextMenu = (event: MouseEvent): void => {
    const id = this.rowId(event);
    if (id !== undefined) this.options.onRowContextMenu?.(id, event);
  };

  private rowId(event: Event): number | undefined {
    const row = event.target instanceof Element ? event.target.closest(".issue-row") : null;
    const id = Number(row?.getAttribute("data-id"));
    return row !== null && Number.isInteger(id) ? id : undefined;
  }

  private readonly onKeydown = (event: KeyboardEvent): void => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const issues = this.state.visibleIssues;
    const at = issues.findIndex((issue) => issue.id === this.state.selectedId);
    let target: number | undefined;
    switch (event.key) {
      case "ArrowDown":
        target = at < 0 ? 0 : Math.min(at + 1, issues.length - 1);
        break;
      case "ArrowUp":
        target = at < 0 ? issues.length - 1 : Math.max(at - 1, 0);
        break;
      case "Home":
        target = 0;
        break;
      case "End":
        target = issues.length - 1;
        break;
      case "Enter":
        if (this.state.selectedId !== null && at >= 0) {
          event.preventDefault();
          this.options.onActivate?.(this.state.selectedId);
        }
        return;
      default:
        return;
    }
    event.preventDefault();
    const issue = issues[target];
    if (issue !== undefined) this.state.select(issue.id);
  };

  render(): void {
    setText(this.header, issuesHeaderText(this.state));
    const empty = issuesEmptyText(this.state);
    if (empty !== undefined) {
      this.list.replaceChildren(el(this.doc, "p", { class: "empty" }, [empty]));
      this.list.removeAttribute("aria-activedescendant");
      return;
    }
    this.list.replaceChildren(...this.state.visibleIssues.map((issue) => this.row(issue)));
    this.updateBadges();
    this.markSelection();
  }

  /** Shows `x7` on the rows that have a count, in place, so that nothing else redraws. */
  private updateBadges(): void {
    const counts = this.options.counts;
    const issues = new Map(this.state.issues.map((i) => [i.id, i]));
    for (const row of this.list.querySelectorAll<HTMLElement>(".issue-row")) {
      const badge = row.querySelector<HTMLElement>(".count-badge");
      if (badge === null) continue;
      const issue = issues.get(Number(row.dataset.id));
      const count = issue === undefined ? undefined : counts?.badge(issue);
      badge.hidden = count === undefined;
      if (count === undefined) {
        badge.textContent = "";
        badge.removeAttribute("title");
        badge.removeAttribute("aria-label");
      } else {
        const times = count === 1 ? "1 time" : `${String(count)} times`;
        badge.textContent = `x${String(count)}`;
        badge.title = `You have made this mistake ${times}`;
        badge.setAttribute("aria-label", `made ${times}`);
      }
    }
  }

  private row(issue: TextIssue): HTMLElement {
    const doc = this.doc;
    return el(
      doc,
      "div",
      {
        id: `issue-row-${String(issue.id)}`,
        class: "issue-row",
        role: "option",
        "data-id": String(issue.id),
        "data-category": issue.category,
        "aria-selected": "false",
        title: `${issue.type.label} · ${categoryLabel(issue.category)}`,
      },
      [
        el(doc, "span", { class: `marker marker-${issue.category}`, "aria-hidden": "true" }, [
          markerLetter(issue.category),
        ]),
        el(doc, "span", { class: "row-body" }, [
          el(doc, "span", { class: "row-snippet" }, [snippetPreview(issue.snippet)]),
          el(doc, "span", { class: "row-meta" }, [
            el(doc, "span", { class: "row-label" }, [issue.type.label]),
            el(doc, "span", { class: "count-badge", hidden: true }),
          ]),
        ]),
      ],
    );
  }

  private markSelection(): void {
    const selected = this.state.selectedId;
    let current: HTMLElement | undefined;
    for (const row of this.list.querySelectorAll<HTMLElement>(".issue-row")) {
      const isSelected = Number(row.dataset.id) === selected;
      row.setAttribute("aria-selected", String(isSelected));
      if (isSelected) current = row;
    }
    if (current === undefined) {
      this.list.removeAttribute("aria-activedescendant");
    } else {
      this.list.setAttribute("aria-activedescendant", current.id);
      scrollElementIntoView(this.list, current);
    }
  }
}
