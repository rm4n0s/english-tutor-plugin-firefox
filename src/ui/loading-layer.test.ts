// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IssueState } from "../core/issues";
import { newState } from "../core/issues/testing/helpers";
import { FakeScheduler } from "../core/testing/fake-clock";
import { LoadingLayer, NOTIFY_AFTER_MS } from "./loading-layer";

let state: IssueState;
let scheduler: FakeScheduler;
let textarea: HTMLTextAreaElement;
let layer: LoadingLayer;

beforeEach(() => {
  document.body.replaceChildren();
  const host = document.createElement("div");
  textarea = document.createElement("textarea");
  document.body.append(host, textarea);
  state = newState().state;
  scheduler = new FakeScheduler();
  layer = new LoadingLayer(document, host, textarea, state, scheduler);
});

afterEach(() => {
  layer.destroy();
});

const notice = () => layer.element.querySelector<HTMLElement>(".loading-notice");

describe("LoadingLayer", () => {
  it("is hidden and leaves the textarea editable when nothing runs", () => {
    expect(layer.visible).toBe(false);
    expect(textarea.readOnly).toBe(false);
  });

  it("covers the editor with Checking... and makes the textarea read-only during a manual check", () => {
    state.beginCheck(true);
    expect(layer.visible).toBe(true);
    expect(layer.element.textContent).toContain("Checking...");
    expect(textarea.readOnly).toBe(true);
    expect(notice()?.hidden).toBe(true);
  });

  it("shows nothing for an auto-check", () => {
    state.beginCheck(false);
    expect(layer.visible).toBe(false);
    expect(textarea.readOnly).toBe(false);
    expect(scheduler.pending).toBe(0);
  });

  it.each([
    { name: "just before 10 seconds", ms: NOTIFY_AFTER_MS - 1, shown: false },
    { name: "at 10 seconds", ms: NOTIFY_AFTER_MS, shown: true },
    { name: "after a minute", ms: 60_000, shown: true },
  ])("the notification line is shown $shown $name", ({ ms, shown }) => {
    state.beginCheck(true);
    scheduler.advance(ms);
    expect(notice()?.hidden).toBe(!shown);
    expect(notice()?.textContent).toBe("We will notify you when the results are ready.");
  });

  it.each([
    {
      name: "a result",
      end: () => {
        state.finishCheck([], "", 0);
      },
    },
    {
      name: "a cancel",
      end: () => {
        state.endCheck("cancelled");
      },
    },
    {
      name: "a failure",
      end: () => {
        state.endCheck("failed");
      },
    },
  ])("goes away with $name, and the textarea is editable again", ({ end }) => {
    state.beginCheck(true);
    scheduler.advance(NOTIFY_AFTER_MS);
    end();
    expect(layer.visible).toBe(false);
    expect(textarea.readOnly).toBe(false);
    expect(notice()?.hidden).toBe(true);
    expect(scheduler.pending).toBe(0);
  });

  it("starts the 10 seconds again for a check that replaces another", () => {
    state.beginCheck(true);
    scheduler.advance(6_000);
    state.beginCheck(true);
    scheduler.advance(6_000);
    expect(notice()?.hidden).toBe(true);
    scheduler.advance(4_000);
    expect(notice()?.hidden).toBe(false);
  });

  it("does not run its timer after destroy", () => {
    state.beginCheck(true);
    layer.destroy();
    expect(scheduler.pending).toBe(0);
  });
});
