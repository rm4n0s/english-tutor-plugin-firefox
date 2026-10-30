import { describe, expect, it } from "vitest";
import { CryptoRandom, type FillRandom } from "./random";

/** A filler that hands out the given 32-bit values, one per call of `int`. */
function words(...values: number[]): FillRandom {
  let next = 0;
  return (bytes) => {
    const value = values[next++] ?? 0;
    new DataView(bytes.buffer).setUint32(0, value);
  };
}

describe("CryptoRandom.int", () => {
  it.each([
    { name: "max 1 is always 0", max: 1, value: 0xffffffff, expected: 0 },
    { name: "first value", max: 10, value: 0, expected: 0 },
    { name: "modulo", max: 10, value: 25, expected: 5 },
    { name: "largest accepted value for 10", max: 10, value: 4294967289, expected: 9 },
    { name: "full range", max: 2 ** 32, value: 0xffffffff, expected: 0xffffffff },
  ])("$name", ({ max, value, expected }) => {
    expect(new CryptoRandom(words(value)).int(max)).toBe(expected);
  });

  it("rejects values that would bias the result", () => {
    // 4294967290..4294967295 are above the largest multiple of 10 that fits in 32 bits.
    const random = new CryptoRandom(words(4294967295, 4294967290, 7));
    expect(random.int(10)).toBe(7);
  });

  it.each([0, -1, 1.5, 2 ** 32 + 1, Number.NaN])("refuses %s", (max) => {
    expect(() => new CryptoRandom(words(0)).int(max)).toThrow(RangeError);
  });

  it("stays in range with the real source", () => {
    const random = new CryptoRandom();
    for (let i = 0; i < 1000; i++) {
      const n = random.int(7);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(7);
    }
  });
});

describe("CryptoRandom.hex", () => {
  it.each([
    { name: "no bytes", count: 0, fill: 0x00, expected: "" },
    { name: "one byte", count: 1, fill: 0x0a, expected: "0a" },
    { name: "pads with zeros", count: 3, fill: 0x01, expected: "010101" },
    { name: "high bytes", count: 2, fill: 0xff, expected: "ffff" },
  ])("$name", ({ count, fill, expected }) => {
    const random = new CryptoRandom((bytes) => bytes.fill(fill));
    expect(random.hex(count)).toBe(expected);
  });

  it.each([-1, 1.5, Number.NaN])("refuses %s", (count) => {
    expect(() => new CryptoRandom().hex(count)).toThrow(RangeError);
  });

  it("gives 2 hex characters per byte and different tokens from the real source", () => {
    const random = new CryptoRandom();
    const a = random.hex(16);
    const b = random.hex(16);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });
});

describe("CryptoRandom.uuid", () => {
  it.each([
    { name: "all zero bytes", fill: 0x00, expected: "00000000-0000-4000-8000-000000000000" },
    { name: "all one bits", fill: 0xff, expected: "ffffffff-ffff-4fff-bfff-ffffffffffff" },
    { name: "mixed bytes", fill: 0x5a, expected: "5a5a5a5a-5a5a-4a5a-9a5a-5a5a5a5a5a5a" },
  ])("$name gives a version 4 UUID", ({ fill, expected }) => {
    const random = new CryptoRandom((bytes) => {
      bytes.fill(fill);
    });
    expect(random.uuid()).toBe(expected);
  });

  it("looks like crypto.randomUUID() and differs between calls with the real source", () => {
    const random = new CryptoRandom();
    const pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const id = random.uuid();
      expect(id).toMatch(pattern);
      seen.add(id);
    }
    expect(seen.size).toBe(50);
  });
});
