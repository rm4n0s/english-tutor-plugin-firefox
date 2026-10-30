import { describe, expect, it } from "vitest";
import { AppError } from "../core/errors";
import { BrowserDownloads, type BlobUrls } from "./downloads";

interface Delta {
  id: number;
  state?: { current: string };
  error?: { current: string };
}

type Item = { id: number; state: string; filename: string; error?: string };

interface Script {
  /** What `downloads.download` does. */
  download?: "ok" | "cancelled-dialog" | "fails" | "throws-other";
  /** The state changes sent after the id was returned, in order. */
  changes?: Delta[];
  /** The changes sent while `downloads.download` is still running (before its id is known). */
  early?: Delta[];
  /** What `downloads.search` finds. */
  items?: Item[];
  searchFails?: boolean;
}

function fakeApi(script: Script = {}) {
  const listeners = new Set<(delta: Delta) => void>();
  const calls = {
    download: [] as { url: string; filename: string; saveAs: boolean }[],
    cancel: [] as number[],
    search: [] as number[],
  };
  const send = (delta: Delta) => {
    for (const listener of [...listeners]) listener(delta);
  };
  const api = {
    downloads: {
      download: (options: { url: string; filename: string; saveAs: boolean }) => {
        calls.download.push(options);
        for (const delta of script.early ?? []) send(delta);
        const mode = script.download ?? "ok";
        if (mode === "cancelled-dialog")
          return Promise.reject(new Error("Download canceled by the user"));
        if (mode === "fails") return Promise.reject(new Error("Invalid filename"));
        if (mode === "throws-other")
          return Promise.reject(new Error("Download canceled by the user"));
        queueMicrotask(() => {
          for (const delta of script.changes ?? []) send(delta);
        });
        return Promise.resolve(7);
      },
      search: (query: { id: number }) => {
        calls.search.push(query.id);
        if (script.searchFails === true) return Promise.reject(new Error("search failed"));
        return Promise.resolve((script.items ?? []).filter((i) => i.id === query.id));
      },
      cancel: (id: number) => {
        calls.cancel.push(id);
        return Promise.resolve();
      },
      onChanged: {
        addListener: (l: (delta: Delta) => void) => listeners.add(l),
        removeListener: (l: (delta: Delta) => void) => listeners.delete(l),
      },
    },
  };
  return { api: api as unknown as typeof browser, calls, listeners, send };
}

function fakeUrls() {
  const made: Blob[] = [];
  const revoked: string[] = [];
  const urls: BlobUrls = {
    createObjectURL: (blob) => {
      made.push(blob);
      return `blob:fake/${String(made.length)}`;
    },
    revokeObjectURL: (url) => {
      revoked.push(url);
    },
  };
  return { urls, made, revoked };
}

const caught = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (e: unknown) => e,
  );

const COMPLETE: Delta = { id: 7, state: { current: "complete" } };
const FILE: Item = { id: 7, state: "complete", filename: "/home/me/Downloads/essay.txt" };

describe("BrowserDownloads", () => {
  it.each([
    { name: "Save", saveAs: false },
    { name: "Save As", saveAs: true },
  ])("$name: downloads a blob URL and waits for the end", async ({ saveAs }) => {
    const { api, calls, listeners } = fakeApi({ changes: [COMPLETE], items: [FILE] });
    const { urls, made, revoked } = fakeUrls();
    const result = await new BrowserDownloads(api, urls).download({
      text: "Hello\r\nthere",
      filename: "essay.txt",
      saveAs,
    });
    expect(result).toEqual({ kind: "saved", path: "/home/me/Downloads/essay.txt" });
    expect(calls.download).toEqual([{ url: "blob:fake/1", filename: "essay.txt", saveAs }]);
    // The blob holds the text exactly as given, as plain text.
    expect(made).toHaveLength(1);
    expect(made[0]?.type).toBe("text/plain;charset=utf-8");
    expect(await made[0]?.text()).toBe("Hello\r\nthere");
    // The blob URL is revoked at the end, and the listener removed.
    expect(revoked).toEqual(["blob:fake/1"]);
    expect(listeners.size).toBe(0);
  });

  it("keeps the blob URL until the download has ended", async () => {
    const script: Script = { items: [{ id: 7, state: "in_progress", filename: "" }] };
    const { api, send } = fakeApi(script);
    const { urls, revoked } = fakeUrls();
    let done = false;
    const pending = new BrowserDownloads(api, urls)
      .download({ text: "x", filename: "a.txt", saveAs: false })
      .then((result) => {
        done = true;
        return result;
      });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect([done, revoked]).toEqual([false, []]);
    script.items = [FILE];
    send(COMPLETE);
    expect(await pending).toEqual({ kind: "saved", path: FILE.filename });
    expect(revoked).toEqual(["blob:fake/1"]);
  });

  it("sees a download that ended before its id was known", async () => {
    const { api } = fakeApi({ early: [COMPLETE], items: [FILE] });
    const { urls, revoked } = fakeUrls();
    const result = await new BrowserDownloads(api, urls).download({
      text: "x",
      filename: "a.txt",
      saveAs: false,
    });
    expect(result.kind).toBe("saved");
    expect(revoked).toHaveLength(1);
  });

  it("sees a download that is already complete when searched", async () => {
    const { api } = fakeApi({ items: [FILE] });
    const { urls } = fakeUrls();
    const result = await new BrowserDownloads(api, urls).download({
      text: "x",
      filename: "a.txt",
      saveAs: false,
    });
    expect(result).toEqual({ kind: "saved", path: FILE.filename });
  });

  it("ignores the changes of other downloads and of other fields", async () => {
    const { api } = fakeApi({
      changes: [
        { id: 99, state: { current: "complete" } },
        { id: 7 },
        { id: 7, state: { current: "in_progress" } },
        COMPLETE,
      ],
      items: [
        { ...FILE, state: "in_progress" },
        { ...FILE, id: 99 },
      ],
    });
    // The first search finds the item in progress; the end comes from onChanged.
    const { urls } = fakeUrls();
    const result = await new BrowserDownloads(api, urls).download({
      text: "x",
      filename: "a.txt",
      saveAs: false,
    });
    expect(result.kind).toBe("saved");
  });

  it.each([{ name: "Save As", saveAs: true }])(
    "$name: cancelling the dialog is not an error",
    async ({ saveAs }) => {
      const { api, calls } = fakeApi({ download: "cancelled-dialog" });
      const { urls, revoked } = fakeUrls();
      const result = await new BrowserDownloads(api, urls).download({
        text: "x",
        filename: "a.txt",
        saveAs,
      });
      expect(result).toEqual({ kind: "cancelled" });
      expect(calls.search).toEqual([]);
      expect(revoked).toHaveLength(1);
    },
  );

  it("a download the user cancels in the browser is not an error", async () => {
    const { api } = fakeApi({
      changes: [{ id: 7, state: { current: "interrupted" }, error: { current: "USER_CANCELED" } }],
      items: [{ id: 7, state: "in_progress", filename: "" }],
    });
    const { urls, revoked } = fakeUrls();
    const result = await new BrowserDownloads(api, urls).download({
      text: "x",
      filename: "a.txt",
      saveAs: false,
    });
    expect(result).toEqual({ kind: "cancelled" });
    expect(revoked).toHaveLength(1);
  });

  it("Save: a failure that says 'cancel' is a failure, not a cancelled dialog", async () => {
    const { api } = fakeApi({ download: "throws-other" });
    const { urls, revoked } = fakeUrls();
    const err = await caught(
      new BrowserDownloads(api, urls).download({ text: "x", filename: "a.txt", saveAs: false }),
    );
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).hasRoute("BrowserDownloads.download->FileWriteFailed")).toBe(true);
    expect(revoked).toHaveLength(1);
  });

  it("gives FileWriteFailed when the browser refuses the download", async () => {
    const { api, listeners } = fakeApi({ download: "fails" });
    const { urls, revoked } = fakeUrls();
    const err = await caught(
      new BrowserDownloads(api, urls).download({
        text: "secret",
        filename: "../a.txt",
        saveAs: true,
      }),
    );
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).hasRoute("BrowserDownloads.download->FileWriteFailed")).toBe(true);
    expect((err as AppError).cause).toBeInstanceOf(Error);
    expect(revoked).toHaveLength(1);
    expect(listeners.size).toBe(0);
  });

  it("gives FileWriteFailed when the download is interrupted, with the reason", async () => {
    const { api } = fakeApi({
      changes: [
        { id: 7, state: { current: "interrupted" }, error: { current: "FILE_ACCESS_DENIED" } },
      ],
      items: [{ id: 7, state: "in_progress", filename: "" }],
    });
    const { urls, revoked } = fakeUrls();
    const err = await caught(
      new BrowserDownloads(api, urls).download({ text: "x", filename: "a.txt", saveAs: false }),
    );
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).hasRoute("BrowserDownloads.download->FileWriteFailed")).toBe(true);
    expect((err as AppError).metadata).toEqual({ reason: "FILE_ACCESS_DENIED" });
    expect(revoked).toHaveLength(1);
  });

  it("gives FileWriteFailed when the finished download cannot be looked up", async () => {
    const { api } = fakeApi({ changes: [COMPLETE], items: [FILE], searchFails: true });
    const { urls, revoked } = fakeUrls();
    const err = await caught(
      new BrowserDownloads(api, urls).download({ text: "x", filename: "a.txt", saveAs: false }),
    );
    expect((err as AppError).hasRoute("BrowserDownloads.download->FileWriteFailed")).toBe(true);
    expect(revoked).toHaveLength(1);
  });

  it("cancels the download and rejects with the reason when the signal aborts", async () => {
    const { api, calls, listeners } = fakeApi({
      items: [{ id: 7, state: "in_progress", filename: "" }],
    });
    const { urls, revoked } = fakeUrls();
    const controller = new AbortController();
    const pending = caught(
      new BrowserDownloads(api, urls).download(
        { text: "x", filename: "a.txt", saveAs: false },
        { signal: controller.signal },
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    const err = await pending;
    expect(err).not.toBeInstanceOf(AppError);
    expect((err as DOMException).name).toBe("AbortError");
    expect(calls.cancel).toEqual([7]);
    expect(revoked).toHaveLength(1);
    expect(listeners.size).toBe(0);
  });

  it("does not start when the signal is already aborted", async () => {
    const { api, calls } = fakeApi();
    const { urls, made } = fakeUrls();
    const controller = new AbortController();
    controller.abort();
    const err = await caught(
      new BrowserDownloads(api, urls).download(
        { text: "x", filename: "a.txt", saveAs: false },
        { signal: controller.signal },
      ),
    );
    expect((err as DOMException).name).toBe("AbortError");
    expect(calls.download).toEqual([]);
    expect(made).toEqual([]);
  });
});
