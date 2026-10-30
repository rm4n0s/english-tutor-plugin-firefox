import { CATEGORIES, categoryLabel, type Category } from "../core/analysis";
import { AppError } from "../core/errors";
import type { ErrorEvent, Period, TypeStats, UsageTotals } from "../core/store";
import {
  DEFAULT_SORT,
  formatDate,
  nextSort,
  PERIODS,
  sortRows,
  summaryText,
  toRows,
  usageCellText,
  visibleRows,
  type SortColumn,
  type StatRow,
  type TableSort,
} from "../core/view";
import { Banner } from "./banner";
import { el, setHidden, setText } from "./dom";

/** What the dialog reads and resets. `Stats` fits. */
export interface StatsSource {
  typeStats(): Promise<TypeStats[]>;
  recentExamples(errorType: string, limit?: number): Promise<ErrorEvent[]>;
  resetMistakes(): Promise<number>;
  usageTotals(): Promise<UsageTotals[]>;
  resetUsage(): Promise<void>;
}

export interface StatsDialogDeps {
  stats: StatsSource;
  /**
   * A reset succeeded: the page announces `stats-changed` (SPEC section 4.2) and refreshes its
   * own badges and header counts. `mistakes` clears the counts; `usage` does not touch them.
   */
  onReset(what: "mistakes" | "usage"): void;
  /** Called with every failure, for the log. The dialog shows its message in its own banner. */
  onError?(err: unknown): void;
}

const COLUMNS: readonly { column: SortColumn; title: string; numeric: boolean }[] = [
  { column: "type", title: "Error type", numeric: false },
  { column: "category", title: "Category", numeric: false },
  { column: "total", title: "Total", numeric: true },
  { column: "last7", title: "Last 7 days", numeric: true },
  { column: "last30", title: "Last 30 days", numeric: true },
  { column: "seen", title: "Last seen", numeric: false },
];

type TabName = "mistakes" | "tokens";

/**
 * The Statistics dialog (SPEC section 4.8): a modal `<dialog>` with two tabs.
 *
 * - **Mistakes:** one row per error type with a recorded mistake, sortable by a click on a header
 *   (a second click reverses), a category filter and a period selector that hide types and drive
 *   the summary line, the three most recent examples of the selected row, and **Reset
 *   statistics** with an in-page confirmation.
 * - **Token usage:** one row per LLM with input and output tokens for all time, 30 days and
 *   7 days, `~` for sums that include estimates, and its own **Reset** with a confirmation.
 *
 * A failed query or reset shows its message in a banner inside the dialog.
 */
export class StatsDialog {
  private readonly doc: Document;
  private readonly deps: StatsDialogDeps;
  private readonly dialog: HTMLDialogElement;
  private readonly banner: Banner;
  private readonly tabs = new Map<TabName, { tab: HTMLButtonElement; panel: HTMLElement }>();
  private readonly category: HTMLSelectElement;
  private readonly period: HTMLSelectElement;
  private readonly summary: HTMLElement;
  private readonly head: HTMLTableRowElement;
  private readonly body: HTMLTableSectionElement;
  private readonly examples: HTMLElement;
  private readonly usageBody: HTMLTableSectionElement;
  private readonly usageEmpty: HTMLElement;
  private readonly confirms: Record<"mistakes" | "usage", HTMLElement>;
  private readonly resetButtons: Record<"mistakes" | "usage", HTMLButtonElement>;

  private rows: StatRow[] = [];
  private sort: TableSort = DEFAULT_SORT;
  private selected: string | undefined;
  private active: TabName = "mistakes";
  /** Counts the example requests; an answer for an older one is ignored. */
  private exampleRun = 0;
  /** Counts the loads; an answer for an older one is ignored. */
  private loadRun = 0;

  constructor(doc: Document, host: HTMLElement, deps: StatsDialogDeps) {
    this.doc = doc;
    this.deps = deps;

    const closeButton = el(doc, "button", { type: "button", id: "stats-close" }, ["Close"]);
    const bannerHost = el(doc, "div", { id: "stats-banner-host" });
    this.banner = new Banner(doc, bannerHost, "stats-banner");

    this.category = el(doc, "select", { id: "stats-category" }, [
      el(doc, "option", { value: "" }, ["All categories"]),
      ...CATEGORIES.map((c) => el(doc, "option", { value: c }, [categoryLabel(c)])),
    ]);
    this.period = el(
      doc,
      "select",
      { id: "stats-period" },
      PERIODS.map((p) => el(doc, "option", { value: p.value }, [p.label])),
    );
    this.summary = el(doc, "p", { id: "stats-summary", class: "stats-summary", role: "status" });
    this.head = el(doc, "tr");
    this.body = el(doc, "tbody", { id: "stats-rows" });
    this.examples = el(doc, "section", {
      id: "stats-examples",
      class: "stats-examples",
      "aria-live": "polite",
    });
    this.usageBody = el(doc, "tbody", { id: "usage-rows" });
    this.usageEmpty = el(doc, "p", { id: "usage-empty", class: "empty" }, [
      "No requests recorded yet.",
    ]);

    this.resetButtons = {
      mistakes: el(doc, "button", { type: "button", id: "stats-reset" }, ["Reset statistics"]),
      usage: el(doc, "button", { type: "button", id: "usage-reset" }, ["Reset token usage"]),
    };
    this.confirms = {
      mistakes: this.confirmBar(
        "stats-reset-confirm",
        "Delete every recorded mistake? The counts start again from zero. This cannot be undone.",
        "Delete all mistakes",
        "mistakes",
      ),
      usage: this.confirmBar(
        "usage-reset-confirm",
        "Delete the recorded token usage of every LLM? This cannot be undone.",
        "Delete token usage",
        "usage",
      ),
    };

    const mistakesPanel = el(
      doc,
      "section",
      {
        id: "stats-panel-mistakes",
        class: "stats-panel",
        role: "tabpanel",
        "aria-labelledby": "stats-tab-mistakes",
      },
      [
        el(doc, "div", { class: "stats-controls" }, [
          el(doc, "label", {}, ["Category ", this.category]),
          el(doc, "label", {}, ["Period ", this.period]),
          el(doc, "span", { class: "spacer" }),
          this.resetButtons.mistakes,
        ]),
        this.confirms.mistakes,
        this.summary,
        el(doc, "div", { class: "stats-table-wrap" }, [
          el(doc, "table", { id: "stats-table", class: "stats-table" }, [
            el(doc, "thead", {}, [this.head]),
            this.body,
          ]),
        ]),
        this.examples,
      ],
    );
    const tokensPanel = el(
      doc,
      "section",
      {
        id: "stats-panel-tokens",
        class: "stats-panel",
        role: "tabpanel",
        "aria-labelledby": "stats-tab-tokens",
        hidden: true,
      },
      [
        el(doc, "div", { class: "stats-controls" }, [
          el(doc, "p", { class: "stats-note" }, [
            "Input in / output out. ~ marks sums that include estimates.",
          ]),
          el(doc, "span", { class: "spacer" }),
          this.resetButtons.usage,
        ]),
        this.confirms.usage,
        el(doc, "div", { class: "stats-table-wrap" }, [
          el(doc, "table", { id: "usage-table", class: "stats-table" }, [
            el(doc, "thead", {}, [
              el(doc, "tr", {}, [
                el(doc, "th", { scope: "col" }, ["LLM"]),
                el(doc, "th", { scope: "col" }, ["All time"]),
                el(doc, "th", { scope: "col" }, ["Last 30 days"]),
                el(doc, "th", { scope: "col" }, ["Last 7 days"]),
              ]),
            ]),
            this.usageBody,
          ]),
        ]),
        this.usageEmpty,
      ],
    );

    const tablist = el(doc, "div", { class: "stats-tabs", role: "tablist" });
    for (const [name, title, panel] of [
      ["mistakes", "Mistakes", mistakesPanel],
      ["tokens", "Token usage", tokensPanel],
    ] as const) {
      const tab = el(
        doc,
        "button",
        {
          type: "button",
          role: "tab",
          id: `stats-tab-${name}`,
          "aria-controls": panel.id,
          "aria-selected": String(name === this.active),
          tabindex: name === this.active ? "0" : "-1",
        },
        [title],
      );
      tab.addEventListener("click", () => {
        this.selectTab(name);
      });
      tab.addEventListener("keydown", (event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        this.selectTab(name === "mistakes" ? "tokens" : "mistakes", true);
      });
      this.tabs.set(name, { tab, panel });
      tablist.append(tab);
    }

    this.dialog = el(
      doc,
      "dialog",
      { id: "stats-dialog", class: "stats-dialog", "aria-labelledby": "stats-title" },
      [
        el(doc, "div", { class: "stats-head" }, [
          el(doc, "h2", { id: "stats-title" }, ["Statistics"]),
          closeButton,
        ]),
        tablist,
        bannerHost,
        mistakesPanel,
        tokensPanel,
      ],
    );
    host.append(this.dialog);

    closeButton.addEventListener("click", () => {
      this.close();
    });
    this.resetButtons.mistakes.addEventListener("click", () => {
      this.askToReset("mistakes");
    });
    this.resetButtons.usage.addEventListener("click", () => {
      this.askToReset("usage");
    });
    this.category.addEventListener("change", () => {
      this.renderMistakes();
    });
    this.period.addEventListener("change", () => {
      this.renderMistakes();
    });
    this.renderHead();
  }

  /** True while the dialog is open. */
  get isOpen(): boolean {
    return this.dialog.open;
  }

  /** Opens the dialog on the Mistakes tab and reads both tabs. */
  async open(): Promise<void> {
    if (!this.dialog.open) {
      this.hideConfirms();
      this.banner.hide();
      this.selectTab("mistakes");
      if (typeof this.dialog.showModal === "function") this.dialog.showModal();
      else this.dialog.setAttribute("open", "");
    }
    await this.reload();
  }

  close(): void {
    this.exampleRun++;
    this.loadRun++;
    if (typeof this.dialog.close === "function") this.dialog.close();
    else this.dialog.removeAttribute("open");
  }

  destroy(): void {
    this.close();
    this.dialog.remove();
  }

  /**
   * Reads both tabs again (the dialog opened, or another tab announced `stats-changed`). A failure
   * is shown in the dialog's banner and the table keeps what it had.
   */
  async reload(): Promise<void> {
    const run = ++this.loadRun;
    const [mistakes, usage] = await Promise.allSettled([
      this.deps.stats.typeStats(),
      this.deps.stats.usageTotals(),
    ]);
    if (run !== this.loadRun || !this.dialog.open) return;
    let failed = false;
    if (mistakes.status === "fulfilled") {
      this.rows = toRows(mistakes.value);
      this.renderMistakes();
    } else {
      failed = true;
      this.fail(mistakes.reason);
    }
    if (usage.status === "fulfilled") {
      this.renderUsage(usage.value);
    } else {
      failed = true;
      this.fail(usage.reason);
    }
    if (!failed) this.banner.hide();
  }

  // Tabs

  private selectTab(name: TabName, focus = false): void {
    this.active = name;
    for (const [tabName, { tab, panel }] of this.tabs) {
      const on = tabName === name;
      tab.setAttribute("aria-selected", String(on));
      tab.tabIndex = on ? 0 : -1;
      setHidden(panel, !on);
    }
    if (focus) this.tabs.get(name)?.tab.focus();
  }

  // The Mistakes tab

  private renderHead(): void {
    this.head.replaceChildren(
      ...COLUMNS.map(({ column, title, numeric }) => {
        const sorted = this.sort.column === column;
        const button = el(
          this.doc,
          "button",
          { type: "button", class: "sort-button", "data-column": column },
          [
            title,
            el(this.doc, "span", { class: "sort-mark", "aria-hidden": "true" }, [
              sorted ? (this.sort.direction === "asc" ? " ▲" : " ▼") : "",
            ]),
          ],
        );
        button.addEventListener("click", () => {
          this.sort = nextSort(this.sort, column);
          this.renderHead();
          this.renderMistakes();
        });
        return el(
          this.doc,
          "th",
          {
            scope: "col",
            class: numeric ? "num" : undefined,
            "aria-sort": sorted
              ? this.sort.direction === "asc"
                ? "ascending"
                : "descending"
              : "none",
          },
          [button],
        );
      }),
    );
  }

  private get categoryFilter(): Category | undefined {
    return CATEGORIES.find((c) => c === this.category.value);
  }

  private get periodFilter(): Period {
    return PERIODS.find((p) => p.value === this.period.value)?.value ?? "all";
  }

  private renderMistakes(): void {
    const filter = { period: this.periodFilter, category: this.categoryFilter };
    const shown = visibleRows(this.rows, filter);
    setText(this.summary, summaryText(shown, filter));
    const sorted = sortRows(shown, this.sort);
    if (this.selected !== undefined && !sorted.some((r) => r.errorType === this.selected)) {
      this.selected = undefined;
    }
    this.body.replaceChildren(
      ...sorted.map((row) => {
        const tr = el(
          this.doc,
          "tr",
          {
            class: "stats-row",
            tabindex: "0",
            "data-type": row.errorType,
            "aria-selected": String(row.errorType === this.selected),
          },
          [
            el(this.doc, "td", {}, [row.label]),
            el(this.doc, "td", {}, [row.categoryLabel]),
            el(this.doc, "td", { class: "num" }, [String(row.total)]),
            el(this.doc, "td", { class: "num" }, [String(row.last7)]),
            el(this.doc, "td", { class: "num" }, [String(row.last30)]),
            el(this.doc, "td", {}, [formatDate(row.lastSeen)]),
          ],
        );
        tr.addEventListener("click", () => {
          this.select(row.errorType);
        });
        tr.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            this.select(row.errorType);
          }
        });
        return tr;
      }),
    );
    this.renderExamples();
  }

  private select(errorType: string): void {
    this.selected = errorType;
    for (const tr of this.body.querySelectorAll<HTMLElement>(".stats-row")) {
      tr.setAttribute("aria-selected", String(tr.dataset.type === errorType));
    }
    this.renderExamples();
  }

  /** The three most recent mistakes of the selected row, with their dates. */
  private renderExamples(): void {
    const run = ++this.exampleRun;
    const type = this.selected;
    const row = this.rows.find((r) => r.errorType === type);
    if (type === undefined || row === undefined) {
      this.examples.replaceChildren(
        el(this.doc, "p", { class: "empty" }, [
          this.body.childElementCount === 0 ? "" : "Select a row to see its most recent examples.",
        ]),
      );
      return;
    }
    this.examples.replaceChildren(
      el(this.doc, "h3", {}, [`Most recent examples: ${row.label}`]),
      el(this.doc, "p", { class: "empty" }, ["Loading..."]),
    );
    this.deps.stats.recentExamples(type, 3).then(
      (events) => {
        if (run !== this.exampleRun) return;
        this.examples.replaceChildren(
          el(this.doc, "h3", { id: "stats-examples-title" }, [
            `Most recent examples: ${row.label}`,
          ]),
          el(
            this.doc,
            "ul",
            { class: "stats-example-list", "aria-labelledby": "stats-examples-title" },
            events.map((event) =>
              el(this.doc, "li", {}, [
                el(this.doc, "time", { class: "example-date" }, [formatDate(event.created_at)]),
                el(this.doc, "q", { class: "example-snippet" }, [event.snippet]),
              ]),
            ),
          ),
        );
      },
      (err: unknown) => {
        if (run !== this.exampleRun) return;
        this.examples.replaceChildren();
        this.fail(err);
      },
    );
  }

  // The Token usage tab

  private renderUsage(totals: readonly UsageTotals[]): void {
    this.usageBody.replaceChildren(
      ...totals.map((t) =>
        el(this.doc, "tr", { class: "usage-row" }, [
          el(this.doc, "th", { scope: "row" }, [t.llm_name]),
          el(this.doc, "td", { class: "all" }, [usageCellText(t.all)]),
          el(this.doc, "td", { class: "d30" }, [usageCellText(t.last30)]),
          el(this.doc, "td", { class: "d7" }, [usageCellText(t.last7)]),
        ]),
      ),
    );
    setHidden(this.usageEmpty, totals.length > 0);
  }

  // Resets

  private confirmBar(
    id: string,
    question: string,
    confirmLabel: string,
    what: "mistakes" | "usage",
  ): HTMLElement {
    const yes = el(this.doc, "button", { type: "button", id: `${id}-yes`, class: "danger" }, [
      confirmLabel,
    ]);
    const no = el(this.doc, "button", { type: "button", id: `${id}-no` }, ["Cancel"]);
    yes.addEventListener("click", () => {
      this.reset(what);
    });
    no.addEventListener("click", () => {
      this.hideConfirms();
      this.resetButtons[what].focus();
    });
    return el(
      this.doc,
      "div",
      { id, class: "stats-confirm", role: "group", "aria-label": "Confirm", hidden: true },
      [el(this.doc, "p", {}, [question]), yes, no],
    );
  }

  private hideConfirms(): void {
    for (const bar of Object.values(this.confirms)) setHidden(bar, true);
  }

  private askToReset(what: "mistakes" | "usage"): void {
    this.hideConfirms();
    setHidden(this.confirms[what], false);
    this.confirms[what].querySelector("button")?.focus();
  }

  private reset(what: "mistakes" | "usage"): void {
    this.hideConfirms();
    const done =
      what === "mistakes" ? this.deps.stats.resetMistakes() : this.deps.stats.resetUsage();
    done
      .then(() => {
        this.selected = what === "mistakes" ? undefined : this.selected;
        this.banner.hide();
        this.deps.onReset(what);
        return this.reload();
      })
      .catch((err: unknown) => {
        this.fail(err);
      });
  }

  private fail(err: unknown): void {
    this.deps.onError?.(err);
    this.banner.show(err instanceof AppError ? err.message : "Something went wrong.");
  }
}
