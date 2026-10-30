import { categoryLabel } from "../core/analysis";
import { issuesEmptyText, issuesHeaderText, type IssueState, type TextIssue } from "../core/issues";
import { el, setText } from "./dom";

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
 * Each row has the marker, the snippet, the error type label and a slot (`.count-badge`, hidden)
 * for the "x7" count that step 9 fills.
 */
export class IssuesList {
  private readonly doc: Document;
  private readonly state: IssueState;
  private readonly header: HTMLElement;
  private readonly list: HTMLElement;
  private readonly unsubscribe: () => void;

  constructor(doc: Document, host: HTMLElement, state: IssueState) {
    this.doc = doc;
    this.state = state;
    this.header = el(doc, "h2", { id: "issues-header", class: "issues-header" });
    this.list = el(doc, "div", {
      id: "issues",
      class: "issues",
      role: "listbox",
      "aria-labelledby": "issues-header",
    });
    host.replaceChildren(this.header, this.list);

    this.list.addEventListener("click", (event) => {
      const row = event.target instanceof Element ? event.target.closest(".issue-row") : null;
      const id = Number(row?.getAttribute("data-id"));
      if (row !== null && Number.isInteger(id)) this.state.select(id);
    });
    this.unsubscribe = state.subscribe((change) => {
      if (change === "selection") this.markSelection();
      else if (change !== "revision") this.render();
    });
    this.render();
  }

  destroy(): void {
    this.unsubscribe();
  }

  render(): void {
    setText(this.header, issuesHeaderText(this.state));
    const empty = issuesEmptyText(this.state);
    if (empty !== undefined) {
      this.list.replaceChildren(el(this.doc, "p", { class: "empty" }, [empty]));
      return;
    }
    this.list.replaceChildren(...this.state.visibleIssues.map((issue) => this.row(issue)));
    this.markSelection();
  }

  private row(issue: TextIssue): HTMLElement {
    const doc = this.doc;
    return el(
      doc,
      "div",
      {
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
    for (const row of this.list.querySelectorAll<HTMLElement>(".issue-row")) {
      row.setAttribute("aria-selected", String(Number(row.dataset.id) === selected));
    }
  }
}
