/**
 * Helpers for the page's modal `<dialog>` elements. `showModal` and `close` exist in Firefox; the
 * fallbacks only serve test environments that lack them.
 */
export function showModal(dialog: HTMLDialogElement): void {
  if (dialog.open) return;
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
}

export function closeModal(dialog: HTMLDialogElement): void {
  if (!dialog.open) return;
  if (typeof dialog.close === "function") dialog.close();
  else dialog.removeAttribute("open");
}

/**
 * Calls `onDismiss` when the user dismisses the dialog without choosing: `Escape` (the browser's
 * `cancel` event, which would close the dialog by itself) or a click on the backdrop.
 */
export function onDismiss(dialog: HTMLDialogElement, dismiss: () => void): void {
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    dismiss();
  });
  dialog.addEventListener("click", (event) => {
    // The box fills the dialog, so a click whose target is the dialog itself is on the backdrop.
    if (event.target === dialog) dismiss();
  });
}
