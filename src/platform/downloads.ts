import { AppError } from "../core/errors";

/** How a download ended. */
export type DownloadResult =
  /** The file is on disk. `path` is where the browser put it (the user may have renamed it). */
  | { kind: "saved"; path: string }
  /** The user cancelled Save As's dialog. Not an error. */
  | { kind: "cancelled" };

export interface DownloadRequest {
  /** The file's content. */
  text: string;
  /** A file name relative to the downloads folder (`downloadFileName`). */
  filename: string;
  /** True shows the browser's save dialog (Save As). */
  saveAs: boolean;
}

/** Writes a text to a file by downloading it. The only place that calls `browser.downloads`. */
export interface Downloads {
  /**
   * Resolves when the download has ended. Fails with `FileWriteFailed`. A cancelled dialog is
   * `{ kind: "cancelled" }`; an aborted `signal` cancels the download and rejects with its reason.
   */
  download(request: DownloadRequest, options?: { signal?: AbortSignal }): Promise<DownloadResult>;
}

/** The part of the `URL` class that is used. */
export interface BlobUrls {
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
}

/** `downloads.download` rejects with this message when the user cancels the save dialog. */
const CANCELLED = /cancel/i;

interface Ended {
  state: "complete" | "interrupted";
  error?: string;
}

/**
 * Downloads a blob URL (SPEC section 8): `downloads.download({ url, filename, saveAs })`, then
 * waits on `downloads.onChanged` until the download is `complete` or `interrupted`, revokes the
 * URL, and asks `downloads.search` where the file went. A failure is `FileWriteFailed`. The file's
 * content and name are never put in the error.
 */
export class BrowserDownloads implements Downloads {
  private readonly api: typeof browser;
  private readonly urls: BlobUrls;

  constructor(api: typeof browser, urls: BlobUrls) {
    this.api = api;
    this.urls = urls;
  }

  async download(
    request: DownloadRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<DownloadResult> {
    const { signal } = options;
    signal?.throwIfAborted();
    const url = this.urls.createObjectURL(
      new Blob([request.text], { type: "text/plain;charset=utf-8" }),
    );
    // The listener goes on before the download starts: a small file can finish before
    // `downloads.download` has returned its id.
    const ended = new Map<number, Ended>();
    let wake: (() => void) | undefined;
    const onChanged = (delta: browser.downloads._OnChangedDownloadDelta): void => {
      const state = delta.state?.current;
      if (state === "complete" || state === "interrupted") {
        ended.set(delta.id, {
          state,
          ...(delta.error?.current ? { error: delta.error.current } : {}),
        });
        wake?.();
      }
    };
    this.api.downloads.onChanged.addListener(onChanged);
    let id: number | undefined;
    try {
      try {
        id = await this.api.downloads.download({
          url,
          filename: request.filename,
          saveAs: request.saveAs,
        });
      } catch (err) {
        if (request.saveAs && err instanceof Error && CANCELLED.test(err.message)) {
          return { kind: "cancelled" };
        }
        throw AppError.wrap("FileWriteFailed", err).via("BrowserDownloads.download");
      }
      const result = await this.waitForEnd(id, ended, signal, (resolve) => {
        wake = resolve;
      });
      if (result.state === "interrupted") {
        if (result.error === "USER_CANCELED") return { kind: "cancelled" };
        throw new AppError("FileWriteFailed", "The browser could not write the file.", {
          reason: result.error ?? "unknown",
        }).via("BrowserDownloads.download");
      }
      return { kind: "saved", path: await this.pathOf(id) };
    } catch (err) {
      if (signal?.aborted === true && id !== undefined) {
        // Stop the download; a failure of the stop itself changes nothing for the caller.
        await this.api.downloads.cancel(id).catch(() => undefined);
      }
      throw err;
    } finally {
      this.api.downloads.onChanged.removeListener(onChanged);
      this.urls.revokeObjectURL(url);
    }
  }

  private async waitForEnd(
    id: number,
    ended: Map<number, Ended>,
    signal: AbortSignal | undefined,
    onWake: (resolve: () => void) => void,
  ): Promise<Ended> {
    for (;;) {
      // The download may have ended before its id was known, or while `search` was running.
      const early = ended.get(id);
      if (early !== undefined) return early;
      const [item] = await this.search(id);
      const found = ended.get(id);
      if (found !== undefined) return found;
      if (item?.state === "complete" || item?.state === "interrupted") {
        return { state: item.state, ...(item.error ? { error: item.error } : {}) };
      }
      // Nothing can happen between the checks above and the waiting below: they run in one turn.
      await new Promise<void>((resolve, reject) => {
        const abort = (): void => {
          // The reason of a cancel is passed on as it is (an AbortError, or what the caller chose).
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          reject(signal?.reason);
        };
        signal?.addEventListener("abort", abort, { once: true });
        onWake(() => {
          signal?.removeEventListener("abort", abort);
          resolve();
        });
        if (signal?.aborted === true) abort();
      });
    }
  }

  private async search(id: number): Promise<browser.downloads.DownloadItem[]> {
    try {
      return await this.api.downloads.search({ id });
    } catch (err) {
      throw AppError.wrap("FileWriteFailed", err).via("BrowserDownloads.download");
    }
  }

  /** Where the browser put the file; the user's choice in Save As's dialog. */
  private async pathOf(id: number): Promise<string> {
    const [item] = await this.search(id);
    return item?.filename ?? "";
  }
}
