/** Source of randomness, injected so that delimiter tokens are testable. */
export interface Random {
  /** An integer in `[0, maxExclusive)`. `maxExclusive` is an integer from 1 to 2^32. */
  int(maxExclusive: number): number;
  /** `byteCount` random bytes as lower-case hexadecimal (2 characters per byte). */
  hex(byteCount: number): string;
  /** A random (version 4) UUID in its 36-character lower-case form, like `crypto.randomUUID()`. */
  uuid(): string;
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

  uuid(): string {
    const bytes = new Uint8Array(16);
    this.fill(bytes);
    // Version 4, variant 1 (RFC 9562).
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
    const h = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
}
