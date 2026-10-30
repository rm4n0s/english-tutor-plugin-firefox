import { describe, expect, it } from "vitest";
import { CountingRandom } from "../analysis/testing/helpers";
import { docSource, isSessionSource, TabSource } from "./source";

describe("TabSource", () => {
  it("starts with a session key from the injected random source", () => {
    const source = new TabSource(new CountingRandom());
    expect(source.key).toBe("session:00000000-0000-4000-8000-000000000000");
    expect(isSessionSource(source.key)).toBe(true);
  });

  it("makes a different session key at New and Clear (renew)", () => {
    const source = new TabSource(new CountingRandom());
    const first = source.key;
    expect(source.renew()).toBe("session:00000000-0000-4000-8000-000000000001");
    expect(source.key).not.toBe(first);
  });

  it("moves to the library document and returns the key it leaves", () => {
    const source = new TabSource(new CountingRandom());
    const old = source.key;
    expect(source.moveToDocument(12)).toBe(old);
    expect(source.key).toBe("doc:12");
    expect(isSessionSource(source.key)).toBe(false);
  });

  it("uses a library document opened in the tab, and a restored key", () => {
    const source = new TabSource(new CountingRandom());
    expect(source.useDocument(7)).toBe("doc:7");
    expect(source.key).toBe("doc:7");
    source.restore("session:restored");
    expect(source.key).toBe("session:restored");
    // A later renew still makes a fresh key.
    expect(source.renew()).toMatch(/^session:/);
  });

  it.each([
    { id: 1, expected: "doc:1" },
    { id: 4096, expected: "doc:4096" },
  ])("names the source of document $id", ({ id, expected }) => {
    expect(docSource(id)).toBe(expected);
  });
});
