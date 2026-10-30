// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { newState } from "../core/issues/testing/helpers";
import { ExplanationPanel, IDLE_HINT } from "./explanation-panel";

let host: HTMLElement;
let opened: number;
let panel: ExplanationPanel;

beforeEach(() => {
  document.body.replaceChildren();
  host = document.createElement("section");
  document.body.append(host);
  opened = 0;
  panel = new ExplanationPanel(document, host, newState().state, {
    openOptions: () => {
      opened++;
    },
  });
});

describe("ExplanationPanel", () => {
  it("is idle with the hint of SPEC section 4.5", () => {
    expect(IDLE_HINT).toBe(
      "Select an error in the list or an underlined error in the text to learn more",
    );
    expect(host.textContent).toBe(IDLE_HINT);
    expect(host.querySelector("a")).toBeNull();
  });

  it("without an LLM asks for one, with a link that opens the options page", () => {
    panel.setHasLLM(false);
    expect(host.textContent).toBe(
      "No LLM is configured. Add one in Preferences to start checking.",
    );
    const link = host.querySelector("a");
    expect(link?.textContent).toBe("Preferences");
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    link?.dispatchEvent(click);
    expect(opened).toBe(1);
    expect(click.defaultPrevented).toBe(true);
  });

  it("goes back to the idle hint once an LLM exists", () => {
    panel.setHasLLM(false);
    panel.setHasLLM(true);
    expect(host.textContent).toBe(IDLE_HINT);
  });
});
