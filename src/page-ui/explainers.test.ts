import { describe, expect, it } from "vitest";
import { placed, resultOf } from "../core/issues/testing/helpers";
import type { ExplanationRunner } from "../core/issues";
import { BoxSession } from "./box-session";
import { BoxExplainers } from "./explainers";
import { sessionDeps, settle } from "./testing";

class Counting implements ExplanationRunner {
  resets = 0;
  explain(): never {
    throw new Error("not used");
  }
  cancel(): void {
    // Nothing runs.
  }
  reset(): void {
    this.resets++;
  }
}

async function session(id: number) {
  const t = sessionDeps();
  t.runner.answer(resultOf([placed(0, 3)]));
  const s = new BoxSession(t.deps, id, `session:${String(id)}`, "Foo bar baz", 0);
  s.focus(0, "Foo bar baz");
  await settle();
  return { session: s, parts: t };
}

describe("BoxExplainers", () => {
  it("makes one explainer per box and gives the same one back", async () => {
    const made: Counting[] = [];
    const explainers = new BoxExplainers(() => {
      const c = new Counting();
      made.push(c);
      return c;
    });
    const a = await session(1);
    const b = await session(2);
    expect(explainers.of(a.session)).toBe(explainers.of(a.session));
    expect(explainers.of(b.session)).not.toBe(explainers.of(a.session));
    expect(made).toHaveLength(2);
  });

  it("empties the cache once, when the check result changed", async () => {
    const made: Counting[] = [];
    const explainers = new BoxExplainers(() => {
      const c = new Counting();
      made.push(c);
      return c;
    });
    const a = await session(1);
    explainers.of(a.session);
    expect(made[0]?.resets).toBe(0);
    // A new check result: a new check id.
    a.parts.runner.answer(resultOf([placed(0, 3)]));
    await a.session.checkManually();
    explainers.of(a.session);
    explainers.of(a.session);
    expect(made[0]?.resets).toBe(1);
  });
});
