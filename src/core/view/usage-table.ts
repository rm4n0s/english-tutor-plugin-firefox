import { formatTotals } from "../issues/tally";
import type { TokenSums } from "../store/types";

/** One cell of the Token usage table: "812 in / 164 out", with `~` before the numbers of an estimate. */
export function usageCellText(sums: TokenSums): string {
  return formatTotals({
    inputTokens: sums.input_tokens,
    outputTokens: sums.output_tokens,
    estimated: sums.estimated,
  });
}
