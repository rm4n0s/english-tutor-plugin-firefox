import { AppError } from "../../core/errors";
import type { DownloadRequest, DownloadResult, Downloads } from "../downloads";

/** What a test tells the fake to do with the next download. */
export type FakeDownloadOutcome =
  { kind: "saved"; path?: string } | { kind: "cancelled" } | { kind: "failed" };

/** Downloads in memory: records every request and answers as the test said. */
export class FakeDownloads implements Downloads {
  readonly requests: DownloadRequest[] = [];
  /** The answer of the next downloads, in order; the last one repeats. */
  outcomes: FakeDownloadOutcome[] = [{ kind: "saved" }];
  /** When set, the download waits for this promise before it ends. */
  hold: Promise<void> | undefined;

  async download(
    request: DownloadRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<DownloadResult> {
    options.signal?.throwIfAborted();
    this.requests.push(request);
    if (this.hold !== undefined) await this.hold;
    const outcome: FakeDownloadOutcome = (this.outcomes.length > 1
      ? this.outcomes.shift()
      : this.outcomes[0]) ?? { kind: "saved" };
    if (outcome.kind === "cancelled") return { kind: "cancelled" };
    if (outcome.kind === "failed") {
      throw new AppError("FileWriteFailed", "The browser could not save the file.").via(
        "FakeDownloads.download",
      );
    }
    return { kind: "saved", path: outcome.path ?? `/home/user/Downloads/${request.filename}` };
  }
}
