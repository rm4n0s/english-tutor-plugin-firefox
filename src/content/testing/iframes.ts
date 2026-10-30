/**
 * happy-dom tries to load the page of every `<iframe>` that is connected to a document and prints
 * an error when iframe loading is disabled, as it is by default. The page-mode tests make iframes
 * and fire their `load` event by hand, so loading is switched off here, without the noise. Returns
 * the function that puts happy-dom's own behaviour back.
 */
export function skipIframeLoading(win: Window & typeof globalThis): () => void {
  const proto = win.HTMLIFrameElement.prototype as unknown as Record<symbol, unknown>;
  const parent = Object.getPrototypeOf(proto) as Record<symbol, unknown>;
  const saved = new Map<symbol, unknown>();
  for (const name of ["connectedToDocument", "onSetAttribute"]) {
    const symbol = Object.getOwnPropertySymbols(proto).find((s) => s.description === name);
    if (symbol === undefined) continue;
    saved.set(symbol, proto[symbol]);
    proto[symbol] = parent[symbol];
  }
  return () => {
    for (const [symbol, original] of saved) proto[symbol] = original;
  };
}
