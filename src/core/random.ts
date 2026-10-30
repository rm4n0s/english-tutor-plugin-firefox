/** Source of randomness, injected so that delimiter tokens are testable. */
export interface Random {
  /** An integer in `[0, maxExclusive)`. `maxExclusive` is an integer from 1 to 2^32. */
  int(maxExclusive: number): number;
  /** `byteCount` random bytes as lower-case hexadecimal (2 characters per byte). */
  hex(byteCount: number): string;
}

/** Fills the array with random bytes, like `crypto.getRandomValues`. */
export type FillRandom = (bytes: Uint8Array<ArrayBuffer>) => void;

const TWO_POW_32 = 0x1_0000_0000;

export class CryptoRandom implements Random {
  private readonly fill: FillRandom;

  constructor(fill: FillRandom = (bytes) => void crypto.getRandomValues(bytes)) {
    this.fill = fill;
  }

  int(maxExclusive: number): number {
    if (!Number.isInteger(maxExclusive) || maxExclusive < 1 || maxExclusive > TWO_POW_32) {
      throw new RangeError("maxExclusive must be an integer from 1 to 2^32");
    }
    // Rejection sampling, so that every value is equally likely.
    const limit = TWO_POW_32 - (TWO_POW_32 % maxExclusive);
    const buffer = new Uint8Array(4);
    for (;;) {
      this.fill(buffer);
      const value = new DataView(buffer.buffer).getUint32(0);
      if (value < limit) return value % maxExclusive;
    }
  }

  hex(byteCount: number): string {
    if (!Number.isInteger(byteCount) || byteCount < 0) {
      throw new RangeError("byteCount must be a non-negative integer");
    }
    const bytes = new Uint8Array(byteCount);
    this.fill(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }
}
