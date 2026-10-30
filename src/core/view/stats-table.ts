import { categoryLabel, lookupErrorType, type Category } from "../analysis";
import type { Period, TypeStats } from "../store/types";
import { countInPeriod, summarizeRows } from "../store/stats";

/** The columns of the Mistakes table (SPEC section 4.8). */
export type SortColumn = "type" | "category" | "total" | "last7" | "last30" | "seen";

export type SortDirection = "asc" | "desc";

export interface TableSort {
  column: SortColumn;
  direction: SortDirection;
}

/** The table starts sorted by Total, highest first. */
export const DEFAULT_SORT: TableSort = { column: "total", direction: "desc" };

/** The periods of the selector, in the order it lists them. */
export const PERIODS: readonly { value: Period; label: string }[] = [
  { value: "all", label: "All time" },
  { value: "30d", label: "Last 30 days" },
  { value: "7d", label: "Last 7 days" },
];

/** One row of the Mistakes table: an error type with at least one recorded mistake. */
export interface StatRow {
  errorType: string;
  label: string;
  /** `grammar`, `syntax` or `vocabulary`. */
  category: string;
  categoryLabel: string;
  total: number;
  last7: number;
  last30: number;
  /** Milliseconds since the epoch. */
  lastSeen: number;
}

/** Rows for the counts of `Stats.typeStats`, with the labels of the taxonomy. */
export function toRows(stats: readonly TypeStats[]): StatRow[] {
  return stats.map((s) => {
    const type = lookupErrorType(s.error_type);
    const category = type?.category ?? s.category;
    return {
      errorType: s.error_type,
      label: type?.label ?? s.error_type,
      category,
      categoryLabel: categoryLabel(category),
      total: s.total,
      last7: s.last7,
      last30: s.last30,
      lastSeen: s.last_seen,
    };
  });
}

/** Text is sorted alphabetically (A first); numbers and dates with the largest or newest first. */
export function naturalDirection(column: SortColumn): SortDirection {
  return column === "type" || column === "category" ? "asc" : "desc";
}

/** What a click on a header does: the same column reverses, another one uses its natural order. */
export function nextSort(current: TableSort, clicked: SortColumn): TableSort {
  if (current.column === clicked) {
    return { column: clicked, direction: current.direction === "asc" ? "desc" : "asc" };
  }
  return { column: clicked, direction: naturalDirection(clicked) };
}

function compareLabels(a: string, b: string): number {
  return a.localeCompare(b, "en", { sensitivity: "base" });
}

function columnValue(row: StatRow, column: SortColumn): number | string {
  switch (column) {
    case "type":
      return row.label;
    case "category":
      return row.categoryLabel;
    case "total":
      return row.total;
    case "last7":
      return row.last7;
    case "last30":
      return row.last30;
    case "seen":
      return row.lastSeen;
  }
}

/** The rows sorted. Rows that tie are ordered by label, A first, whichever the direction. */
export function sortRows(rows: readonly StatRow[], sort: TableSort): StatRow[] {
  const sign = sort.direction === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = columnValue(a, sort.column);
    const y = columnValue(b, sort.column);
    const order =
      typeof x === "string" && typeof y === "string" ? compareLabels(x, y) : Number(x) - Number(y);
    return order !== 0 ? order * sign : compareLabels(a.label, b.label);
  });
}

export interface RowFilter {
  period: Period;
  /** Only this category, or undefined for all. */
  category?: Category | undefined;
}

/**
 * The rows the table shows: the types of the category (all by default) that have a mistake in the
 * period. A type with none in the period is hidden (SPEC section 4.8).
 */
export function visibleRows(rows: readonly StatRow[], filter: RowFilter): StatRow[] {
  return rows.filter(
    (row) =>
      (filter.category === undefined || row.category === filter.category) &&
      countInPeriod(row, filter.period) > 0,
  );
}

function periodPhrase(period: Period): string {
  return period === "all" ? "all time" : period === "30d" ? "the last 30 days" : "the last 7 days";
}

/**
 * The summary line: "24 mistakes in all time. Most frequent: Article." It counts the rows given
 * (the ones the filters leave); a category filter adds the category in brackets.
 */
export function summaryText(rows: readonly StatRow[], filter: RowFilter): string {
  const asStats = rows.map<TypeStats>((r) => ({
    error_type: r.errorType,
    category: r.category,
    total: r.total,
    last30: r.last30,
    last7: r.last7,
    last_seen: r.lastSeen,
  }));
  const byLabel = new Map(rows.map((r) => [r.errorType, r.label]));
  const summary = summarizeRows(asStats, filter.period, (a, b) =>
    compareLabels(byLabel.get(a.error_type) ?? "", byLabel.get(b.error_type) ?? ""),
  );
  const scope = filter.category === undefined ? "" : ` (${categoryLabel(filter.category)})`;
  if (summary.total === 0) {
    return filter.period === "all" && filter.category === undefined
      ? "No mistakes recorded yet."
      : `No mistakes in ${periodPhrase(filter.period)}${scope}.`;
  }
  const noun = summary.total === 1 ? "mistake" : "mistakes";
  const top = summary.mostFrequent === undefined ? undefined : byLabel.get(summary.mostFrequent);
  return `${String(summary.total)} ${noun} in ${periodPhrase(filter.period)}${scope}. Most frequent: ${top ?? ""}.`;
}

/** The date of a time in the user's time zone, as `2026-10-30`. */
export function formatDate(ms: number): string {
  const d = new Date(ms);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${String(d.getFullYear())}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}
