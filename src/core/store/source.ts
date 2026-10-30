import type { Random } from "../random";

/** The source of a library document's mistakes (SPEC section 5.7). */
export function docSource(documentId: number): string {
  return `doc:${String(documentId)}`;
}

export function isSessionSource(source: string): boolean {
  return source.startsWith("session:");
}

/**
 * The source key of a tab's text (SPEC section 5.7): `session:<uuid>` for a new text, `doc:<id>`
 * once the text is a library document. The UUID comes from the injected random source. The tab
 * makes a new key when it loads and at New and Clear; Save to library moves it to the document
 * (`Stats.moveSource`).
 */
export class TabSource {
  private readonly random: Random;
  private current: string;

  constructor(random: Random) {
    this.random = random;
    this.current = TabSource.newSession(random);
  }

  private static newSession(random: Random): string {
    return `session:${random.uuid()}`;
  }

  get key(): string {
    return this.current;
  }

  /** A new text: a fresh `session:` key, which is returned. */
  renew(): string {
    this.current = TabSource.newSession(this.random);
    return this.current;
  }

  /** A library document was opened in the tab: its mistakes are recorded under `doc:<id>`. */
  useDocument(documentId: number): string {
    this.current = docSource(documentId);
    return this.current;
  }

  /** The tab's text was restored with this key (SPEC section 4.2); the caller checked its form. */
  restore(key: string): void {
    this.current = key;
  }

  /** The text became the library document with this id; returns the old key. */
  moveToDocument(documentId: number): string {
    const old = this.current;
    this.current = docSource(documentId);
    return old;
  }
}
