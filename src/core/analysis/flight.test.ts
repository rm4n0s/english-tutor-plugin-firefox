import { describe, expect, it } from "vitest";
import { Flight } from "./flight";

describe("Flight", () => {
  it("begin cancels the request before it", () => {
    const flight = new Flight();
    const first = flight.begin();
    const second = flight.begin();
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
  });

  it("stop cancels the running request, and is harmless when nothing runs", () => {
    const flight = new Flight();
    flight.stop();
    const run = flight.begin();
    flight.stop();
    expect(run.signal.aborted).toBe(true);
  });

  it("follows the parent signal, with its reason", () => {
    const flight = new Flight();
    const parent = new AbortController();
    const run = flight.begin(parent.signal);
    expect(run.signal.aborted).toBe(false);
    const reason = new Error("stop");
    parent.abort(reason);
    expect(run.signal.reason).toBe(reason);
  });

  it("starts aborted when the parent already is", () => {
    expect(new Flight().begin(AbortSignal.abort()).signal.aborted).toBe(true);
  });

  it("an ended request is no longer cancelled by stop, and stops following its parent", () => {
    const flight = new Flight();
    const parent = new AbortController();
    const run = flight.begin(parent.signal);
    run.end();
    flight.stop();
    parent.abort();
    expect(run.signal.aborted).toBe(false);
  });

  it("the end of an old request does not forget a newer one", () => {
    const flight = new Flight();
    const first = flight.begin();
    const second = flight.begin();
    first.end();
    flight.stop();
    expect(second.signal.aborted).toBe(true);
  });
});
