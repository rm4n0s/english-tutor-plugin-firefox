import type { Logger } from "../core/log";
import type { TabOpener } from "../platform/tabs";
import type { ToolbarButton } from "../platform/toolbar-button";

export const TUTOR_PAGE = "tutor.html";

/** Wires the toolbar button to the tutor page. Opening or focusing the right tab comes in step 12. */
export function startBackground(button: ToolbarButton, tabs: TabOpener, log: Logger): void {
  button.onClick(() => {
    tabs.open(TUTOR_PAGE).catch((err: unknown) => {
      log.error("could not open the tutor page", { err });
    });
  });
}
