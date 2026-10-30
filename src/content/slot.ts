/**
 * Page mode starts once per page frame, whichever way its script got there: the registered script,
 * or the copy the background script runs in the tabs that were open when page mode was allowed (or
 * when the extension was updated). Both run in the extension's one content script world of the
 * frame, so a flag on its global object, under a symbol the page cannot name or see, tells the
 * second one to stop.
 */
const SLOT = Symbol.for("english-tutor.page-mode");

/** True for the first call on `scope`, false for every later one. */
export function claimPageSlot(scope: object): boolean {
  if (Reflect.get(scope, SLOT) === true) return false;
  Reflect.set(scope, SLOT, true);
  return true;
}
