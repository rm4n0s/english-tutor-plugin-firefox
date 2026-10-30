// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { Banner } from "./banner";

let host: HTMLElement;
let banner: Banner;

beforeEach(() => {
  document.body.replaceChildren();
  host = document.createElement("div");
  document.body.append(host);
  banner = new Banner(document, host);
});

const click = (selector: string) =>
  host.querySelector(selector)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
const action = () => host.querySelector<HTMLElement>(".banner-action");

describe("Banner", () => {
  it("is hidden at first, and an alert when shown", () => {
    expect(banner.visible).toBe(false);
    banner.show("The server returned HTTP 500.");
    expect(banner.visible).toBe(true);
    expect(banner.message).toBe("The server returned HTTP 500.");
    expect(banner.element.getAttribute("role")).toBe("alert");
    expect(action()?.hidden).toBe(true);
  });

  it("can be dismissed", () => {
    banner.show("x");
    click(".banner-dismiss");
    expect(banner.visible).toBe(false);
  });

  it("shows an action button that runs its function on click", () => {
    let calls = 0;
    banner.show("No access", {
      label: "Grant access",
      onClick: () => {
        calls++;
      },
    });
    expect(action()?.hidden).toBe(false);
    expect(action()?.textContent).toBe("Grant access");
    click(".banner-action");
    expect(calls).toBe(1);
  });

  it("a later message without an action removes the button", () => {
    banner.show("a", { label: "Go", onClick: () => undefined });
    banner.show("b");
    expect(action()?.hidden).toBe(true);
    expect(banner.message).toBe("b");
  });

  it("shows text only, never markup", () => {
    banner.show("<b>bold</b>");
    expect(host.querySelector("b")).toBeNull();
    expect(banner.message).toBe("<b>bold</b>");
  });
});
