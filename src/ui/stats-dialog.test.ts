// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppError } from "../core/errors";
import type { ErrorEvent, TypeStats, UsageTotals } from "../core/store";
import { StatsDialog, type StatsSource } from "./stats-dialog";

const DAY = 86_400_000;
const AT = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12).getTime();

const TYPES: TypeStats[] = [
  {
    error_type: "article",
    category: "grammar",
    total: 10,
    last30: 4,
    last7: 2,
    last_seen: AT(2026, 3, 5),
  },
  {
    error_type: "verb_tense",
    category: "grammar",
    total: 10,
    last30: 1,
    last7: 0,
    last_seen: AT(2026, 2, 1),
  },
  {
    error_type: "wrong_word",
    category: "vocabulary",
    total: 5,
    last30: 5,
    last7: 3,
    last_seen: AT(2026, 3, 1),
  },
  {
    error_type: "word_order",
    category: "syntax",
    total: 1,
    last30: 0,
    last7: 0,
    last_seen: AT(2025, 12, 24),
  },
];

const sums = (input: number, output: number, estimated = false) => ({
  input_tokens: input,
  output_tokens: output,
  estimated,
});
const USAGE: UsageTotals[] = [
  { llm_name: "Alpha", all: sums(5200, 1100), last30: sums(812, 164), last7: sums(0, 0) },
  {
    llm_name: "Zed",
    all: sums(40, 10, true),
    last30: sums(40, 10, true),
    last7: sums(40, 10, true),
  },
];

const event = (snippet: string, created_at: number): ErrorEvent => ({
  id: 1,
  error_type: "article",
  category: "grammar",
  snippet,
  source_key: "session:a",
  fingerprint: snippet,
  llm_name: "Local",
  created_at,
});

class FakeStats implements StatsSource {
  types: TypeStats[] = TYPES;
  usage: UsageTotals[] = USAGE;
  examples = new Map<string, ErrorEvent[]>([
    [
      "article",
      [
        event("a apple", AT(2026, 3, 5)),
        event("a hour", AT(2026, 3, 3)),
        event("an car", AT(2026, 3, 1)),
      ],
    ],
  ]);
  readonly calls: string[] = [];
  failWith = new Map<string, Error>();
  hold: Promise<void> | undefined;

  private run<T>(name: string, value: T): Promise<T> {
    this.calls.push(name);
    const failure = this.failWith.get(name);
    if (failure !== undefined) return Promise.reject(failure);
    return Promise.resolve(this.hold).then(() => value);
  }
  typeStats() {
    return this.run("typeStats", this.types);
  }
  recentExamples(type: string, limit?: number) {
    return this.run(`recentExamples ${type} ${String(limit)}`, this.examples.get(type) ?? []);
  }
  resetMistakes() {
    const n = this.types.reduce((sum, t) => sum + t.total, 0);
    return this.run("resetMistakes", n).then((count) => {
      this.types = [];
      return count;
    });
  }
  usageTotals() {
    return this.run("usageTotals", this.usage);
  }
  resetUsage() {
    return this.run("resetUsage", undefined).then(() => {
      this.usage = [];
    });
  }
}

let stats: FakeStats;
let dialog: StatsDialog;
let resets: string[];
let errors: unknown[];

beforeEach(() => {
  document.body.replaceChildren();
  stats = new FakeStats();
  resets = [];
  errors = [];
  dialog = new StatsDialog(document, document.body, {
    stats,
    onReset: (what) => resets.push(what),
    onError: (err) => errors.push(err),
  });
});

afterEach(() => {
  dialog.destroy();
});

function byId(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`no element #${id}`);
  return found;
}
const click = (id: string) => {
  byId(id).click();
};
const text = (id: string) => byId(id).textContent;
const rows = () =>
  [...document.querySelectorAll("#stats-rows .stats-row")].map((tr) =>
    [...tr.querySelectorAll("td")].map((td) => td.textContent),
  );
const labels = () => rows().map((r) => r[0]);
const header = (column: string) =>
  document.querySelector<HTMLButtonElement>(`#stats-table th button[data-column="${column}"]`);
const sortOf = () =>
  [...document.querySelectorAll("#stats-table th")].map((th) => th.getAttribute("aria-sort"));
const choose = (id: string, value: string) => {
  const select = byId(id) as HTMLSelectElement;
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
};
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function open(): Promise<void> {
  await dialog.open();
  await tick();
}

describe("opening", () => {
  it("is a closed modal dialog until opened, then shows Mistakes, sorted by Total, highest first", async () => {
    expect((byId("stats-dialog") as HTMLDialogElement).open).toBe(false);
    expect(dialog.isOpen).toBe(false);
    await open();
    expect(dialog.isOpen).toBe(true);
    expect(byId("stats-dialog").tagName).toBe("DIALOG");
    expect(byId("stats-tab-mistakes").getAttribute("aria-selected")).toBe("true");
    expect(byId("stats-panel-mistakes").hidden).toBe(false);
    expect(byId("stats-panel-tokens").hidden).toBe(true);
    expect(labels()).toEqual(["Article", "Verb tense", "Wrong word", "Word order"]);
    expect(rows()[0]).toEqual(["Article", "Grammar", "10", "2", "4", "2026-03-05"]);
    expect(sortOf()).toEqual(["none", "none", "descending", "none", "none", "none"]);
    expect(text("stats-summary")).toBe("26 mistakes in all time. Most frequent: Article.");
  });

  it("has the columns of the spec in order", async () => {
    await open();
    expect(
      [...document.querySelectorAll("#stats-table th")].map((th) => th.textContent.trim()),
    ).toEqual(["Error type", "Category", "Total ▼", "Last 7 days", "Last 30 days", "Last seen"]);
  });

  it("reads again each time it opens, and Close closes it", async () => {
    await open();
    click("stats-close");
    expect(dialog.isOpen).toBe(false);
    stats.types = [TYPES[3]!];
    await open();
    expect(labels()).toEqual(["Word order"]);
    expect(stats.calls.filter((c) => c === "typeStats")).toHaveLength(2);
  });

  it("says so when nothing was recorded", async () => {
    stats.types = [];
    stats.usage = [];
    await open();
    expect(rows()).toEqual([]);
    expect(text("stats-summary")).toBe("No mistakes recorded yet.");
    expect(byId("usage-empty").hidden).toBe(false);
  });
});

describe("sorting (SPEC section 4.8)", () => {
  it.each([
    {
      column: "type",
      first: ["Article", "Verb tense", "Word order", "Wrong word"],
      sort: "ascending",
    },
    {
      column: "category",
      first: ["Article", "Verb tense", "Word order", "Wrong word"],
      sort: "ascending",
    },
    {
      column: "last7",
      first: ["Wrong word", "Article", "Verb tense", "Word order"],
      sort: "descending",
    },
    {
      column: "last30",
      first: ["Wrong word", "Article", "Verb tense", "Word order"],
      sort: "descending",
    },
    {
      column: "seen",
      first: ["Article", "Wrong word", "Verb tense", "Word order"],
      sort: "descending",
    },
  ])(
    "a click on $column sorts $sort, and a second click reverses it",
    async ({ column, first, sort }) => {
      await open();
      header(column)?.click();
      expect(labels()).toEqual(first);
      expect(sortOf()).toContain(sort);
      header(column)?.click();
      expect(sortOf()).toContain(sort === "ascending" ? "descending" : "ascending");
      expect(labels()).not.toEqual(first);
    },
  );

  it("a click on Total reverses the default order, keeping ties by label", async () => {
    await open();
    header("total")?.click();
    expect(labels()).toEqual(["Word order", "Wrong word", "Article", "Verb tense"]);
    header("total")?.click();
    expect(labels()).toEqual(["Article", "Verb tense", "Wrong word", "Word order"]);
  });

  it("keeps the sort when the filters change", async () => {
    await open();
    header("type")?.click();
    choose("stats-period", "7d");
    expect(labels()).toEqual(["Article", "Wrong word"]);
  });
});

describe("filters and the summary line (SPEC section 4.8)", () => {
  it.each([
    {
      period: "all",
      category: "",
      labels: ["Article", "Verb tense", "Wrong word", "Word order"],
      summary: "26 mistakes in all time. Most frequent: Article.",
    },
    {
      period: "30d",
      category: "",
      labels: ["Article", "Verb tense", "Wrong word"],
      summary: "10 mistakes in the last 30 days. Most frequent: Wrong word.",
    },
    {
      period: "7d",
      category: "",
      labels: ["Article", "Wrong word"],
      summary: "5 mistakes in the last 7 days. Most frequent: Wrong word.",
    },
    {
      period: "all",
      category: "grammar",
      labels: ["Article", "Verb tense"],
      summary: "20 mistakes in all time (Grammar). Most frequent: Article.",
    },
    {
      period: "7d",
      category: "grammar",
      labels: ["Article"],
      summary: "2 mistakes in the last 7 days (Grammar). Most frequent: Article.",
    },
    {
      period: "7d",
      category: "syntax",
      labels: [],
      summary: "No mistakes in the last 7 days (Syntax).",
    },
  ])(
    "period $period, category '$category'",
    async ({ period, category, labels: expected, summary }) => {
      await open();
      choose("stats-period", period);
      choose("stats-category", category);
      expect(labels()).toEqual(expected);
      expect(text("stats-summary")).toBe(summary);
    },
  );

  it("offers all time, 30 days and 7 days, and the three categories", async () => {
    await open();
    expect(
      [...(byId("stats-period") as HTMLSelectElement).options].map((o) => o.textContent),
    ).toEqual(["All time", "Last 30 days", "Last 7 days"]);
    expect(
      [...(byId("stats-category") as HTMLSelectElement).options].map((o) => o.textContent),
    ).toEqual(["All categories", "Grammar", "Syntax", "Vocabulary"]);
  });
});

describe("examples", () => {
  it("lists the three most recent examples of the selected row with their dates", async () => {
    await open();
    expect(text("stats-examples")).toContain("Select a row");
    document.querySelector<HTMLElement>('.stats-row[data-type="article"]')?.click();
    await tick();
    expect(stats.calls).toContain("recentExamples article 3");
    expect(text("stats-examples")).toContain("Most recent examples: Article");
    expect(
      [...document.querySelectorAll("#stats-examples li")].map((li) => li.textContent),
    ).toEqual(["2026-03-05a apple", "2026-03-03a hour", "2026-03-01an car"]);
    expect(
      document.querySelector('.stats-row[data-type="article"]')?.getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("selects with Enter and Space, and moves to the other row", async () => {
    await open();
    const first = document.querySelector<HTMLElement>('.stats-row[data-type="article"]');
    first?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await tick();
    expect(first?.getAttribute("aria-selected")).toBe("true");
    const second = document.querySelector<HTMLElement>('.stats-row[data-type="wrong_word"]');
    second?.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    await tick();
    expect(first?.getAttribute("aria-selected")).toBe("false");
    expect(second?.getAttribute("aria-selected")).toBe("true");
    expect(text("stats-examples")).toContain("Wrong word");
  });

  it("drops the examples when a filter hides the selected row", async () => {
    await open();
    document.querySelector<HTMLElement>('.stats-row[data-type="word_order"]')?.click();
    await tick();
    expect(text("stats-examples")).toContain("Word order");
    choose("stats-period", "7d");
    expect(text("stats-examples")).toContain("Select a row");
    expect(document.querySelectorAll('.stats-row[aria-selected="true"]')).toHaveLength(0);
  });

  it("ignores the answer for a row that is no longer the selected one", async () => {
    await open();
    let release: () => void = () => undefined;
    stats.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    document.querySelector<HTMLElement>('.stats-row[data-type="article"]')?.click();
    stats.hold = undefined;
    document.querySelector<HTMLElement>('.stats-row[data-type="wrong_word"]')?.click();
    await tick();
    release();
    await tick();
    expect(text("stats-examples")).toContain("Wrong word");
    expect(text("stats-examples")).not.toContain("a apple");
  });
});

describe("Token usage (SPEC section 4.8)", () => {
  async function openTokens(): Promise<void> {
    await open();
    click("stats-tab-tokens");
  }
  const usageRows = () =>
    [...document.querySelectorAll("#usage-rows .usage-row")].map((tr) =>
      [...tr.children].map((c) => c.textContent),
    );

  it("has a row per LLM with input in / output out for all time, 30 days and 7 days", async () => {
    await openTokens();
    expect(byId("stats-panel-tokens").hidden).toBe(false);
    expect(byId("stats-panel-mistakes").hidden).toBe(true);
    expect(byId("stats-tab-tokens").getAttribute("aria-selected")).toBe("true");
    expect(usageRows()).toEqual([
      ["Alpha", "5.2k in / 1.1k out", "812 in / 164 out", "0 in / 0 out"],
      ["Zed", "~40 in / ~10 out", "~40 in / ~10 out", "~40 in / ~10 out"],
    ]);
    expect(
      [...document.querySelectorAll("#usage-table th[scope=col]")].map((t) => t.textContent),
    ).toEqual(["LLM", "All time", "Last 30 days", "Last 7 days"]);
    expect(byId("usage-empty").hidden).toBe(true);
  });

  it("moves between the tabs with the arrow keys", async () => {
    await open();
    byId("stats-tab-mistakes").dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }),
    );
    expect(byId("stats-tab-tokens").getAttribute("aria-selected")).toBe("true");
    byId("stats-tab-tokens").dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }),
    );
    expect(byId("stats-tab-mistakes").getAttribute("aria-selected")).toBe("true");
    expect(byId("stats-tab-mistakes").tabIndex).toBe(0);
    expect(byId("stats-tab-tokens").tabIndex).toBe(-1);
  });

  it("Reset asks first; Cancel changes nothing; confirming deletes the usage", async () => {
    await openTokens();
    click("usage-reset");
    expect(byId("usage-reset-confirm").hidden).toBe(false);
    click("usage-reset-confirm-no");
    expect(byId("usage-reset-confirm").hidden).toBe(true);
    expect(stats.calls).not.toContain("resetUsage");
    click("usage-reset");
    click("usage-reset-confirm-yes");
    await tick();
    await tick();
    expect(stats.calls).toContain("resetUsage");
    expect(resets).toEqual(["usage"]);
    expect(usageRows()).toEqual([]);
    expect(byId("usage-empty").hidden).toBe(false);
    // The mistakes are untouched.
    expect(stats.calls).not.toContain("resetMistakes");
    expect(labels()).toHaveLength(4);
  });
});

describe("Reset statistics (SPEC section 4.8)", () => {
  it("asks for confirmation in the page before deleting anything", async () => {
    await open();
    expect(byId("stats-reset-confirm").hidden).toBe(true);
    click("stats-reset");
    expect(byId("stats-reset-confirm").hidden).toBe(false);
    expect(text("stats-reset-confirm")).toContain("Delete every recorded mistake?");
    expect(stats.calls).not.toContain("resetMistakes");
    click("stats-reset-confirm-no");
    expect(byId("stats-reset-confirm").hidden).toBe(true);
    expect(stats.calls).not.toContain("resetMistakes");
    expect(resets).toEqual([]);
  });

  it("deletes the mistakes, tells the page, and shows the empty table", async () => {
    await open();
    document.querySelector<HTMLElement>('.stats-row[data-type="article"]')?.click();
    await tick();
    click("stats-reset");
    click("stats-reset-confirm-yes");
    await tick();
    await tick();
    expect(resets).toEqual(["mistakes"]);
    expect(rows()).toEqual([]);
    expect(text("stats-summary")).toBe("No mistakes recorded yet.");
    expect(byId("stats-reset-confirm").hidden).toBe(true);
    expect(text("stats-examples")).not.toContain("Article");
    // The token usage is untouched.
    expect(stats.calls).not.toContain("resetUsage");
  });

  it("a confirmation left open is closed when the dialog is opened again", async () => {
    await open();
    click("stats-reset");
    click("stats-close");
    await open();
    expect(byId("stats-reset-confirm").hidden).toBe(true);
  });
});

describe("failures show their message in the dialog's own banner", () => {
  const failure = (tag: string, message: string) => new AppError(tag, message);

  it.each([
    {
      call: "typeStats",
      error: failure("StatsQueryFailed", "The mistake counts could not be read."),
    },
    {
      call: "usageTotals",
      error: failure("UsageQueryFailed", "The token usage could not be read."),
    },
  ])("a failing $call", async ({ call, error }) => {
    stats.failWith.set(call, error);
    await open();
    expect(byId("stats-banner").hidden).toBe(false);
    expect(text("stats-banner")).toContain(error.message);
    expect(errors).toEqual([error]);
    // The other tab still shows what it could read.
    if (call === "typeStats") expect(byId("usage-rows").children).toHaveLength(2);
    else expect(rows()).toHaveLength(4);
  });

  it("a failing reset shows the message and keeps the table", async () => {
    stats.failWith.set(
      "resetMistakes",
      failure("StatsResetFailed", "The statistics could not be reset."),
    );
    await open();
    click("stats-reset");
    click("stats-reset-confirm-yes");
    await tick();
    await tick();
    expect(text("stats-banner")).toContain("The statistics could not be reset.");
    expect(resets).toEqual([]);
    expect(rows()).toHaveLength(4);
  });

  it("a failing example request shows its message", async () => {
    stats.failWith.set(
      "recentExamples article 3",
      failure("StatsQueryFailed", "The mistake counts could not be read."),
    );
    await open();
    document.querySelector<HTMLElement>('.stats-row[data-type="article"]')?.click();
    await tick();
    expect(text("stats-banner")).toContain("could not be read");
  });

  it("the banner goes after a good read and can be dismissed", async () => {
    stats.failWith.set(
      "typeStats",
      failure("StatsQueryFailed", "The mistake counts could not be read."),
    );
    await open();
    expect(byId("stats-banner").hidden).toBe(false);
    stats.failWith.clear();
    await dialog.reload();
    expect(byId("stats-banner").hidden).toBe(true);
    stats.failWith.set("usageTotals", new Error("odd"));
    await dialog.reload();
    expect(text("stats-banner")).toContain("Something went wrong.");
    byId("stats-banner").querySelector<HTMLElement>(".banner-dismiss")?.click();
    expect(byId("stats-banner").hidden).toBe(true);
  });
});

describe("reload (stats-changed from another tab)", () => {
  it("redraws with the new counts and keeps the sort and the filters", async () => {
    await open();
    header("type")?.click();
    choose("stats-category", "grammar");
    stats.types = [{ ...TYPES[0]!, total: 99 }];
    await dialog.reload();
    expect(rows()).toEqual([["Article", "Grammar", "99", "2", "4", "2026-03-05"]]);
    expect(sortOf()).toContain("ascending");
  });

  it("ignores an answer that arrives after the dialog closed", async () => {
    let release: () => void = () => undefined;
    stats.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = dialog.open();
    dialog.close();
    release();
    await pending;
    await tick();
    expect(rows()).toEqual([]);
  });
});

describe("dates", () => {
  it("are written as year-month-day in the user's time zone", async () => {
    stats.types = [
      { ...TYPES[0]!, last_seen: new Date(2026, 0, 9, 23, 59).getTime() },
      { ...TYPES[1]!, last_seen: new Date(2026, 0, 10, 0, 1).getTime() - DAY * 0 },
    ];
    await open();
    expect(
      rows()
        .map((r) => r[5])
        .sort(),
    ).toEqual(["2026-01-09", "2026-01-10"]);
  });
});
