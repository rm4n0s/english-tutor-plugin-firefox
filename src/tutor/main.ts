import { Logger } from "../core/log";
import { attachDivider } from "../ui/divider";

const log = new Logger(console);

function element(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (found === null) throw new TypeError(`tutor.html has no element #${id}`);
  return found;
}

// The two draggable dividers. Their positions are remembered in step 12.
attachDivider(element("divider-main"), {
  container: element("panes"),
  axis: "x",
  property: "--editor-share",
  min: 30,
  max: 85,
});
attachDivider(element("divider-side"), {
  container: element("side"),
  axis: "y",
  property: "--issues-share",
  min: 15,
  max: 85,
});

log.debug("tutor page ready");
