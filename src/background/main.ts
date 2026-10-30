import { Logger } from "../core/log";
import { BrowserTabOpener } from "../platform/tabs";
import { BrowserToolbarButton } from "../platform/toolbar-button";
import { startBackground } from "./background";

startBackground(
  new BrowserToolbarButton(browser),
  new BrowserTabOpener(browser),
  new Logger(console),
);
