/** A small seeded generator (mulberry32), so that randomised tests are repeatable and need no dependency. */
export class Prng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** A float in `[0, 1)`. */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** An integer in `[0, n)`. */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)] as T;
  }

  /** A string of `length` pieces drawn from `alphabet`. */
  string(alphabet: readonly string[], length: number): string {
    let out = "";
    for (let i = 0; i < length; i++) out += this.pick(alphabet);
    return out;
  }
}
