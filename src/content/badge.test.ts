// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { Badge, BADGE_SIZE } from "./badge";
import type { BadgeView } from "./badge-view";
import { BlockedCard, OPEN_IN_TUTOR_LABEL } from "./blocked-card";
import { OverlayHost } from "./overlay-host";

afterEach(() => {
  document.documentElement.querySelectorAll(":scope > div").forEach((d) => {
    d.remove();
  });
});

function setup(mode: "open" | "closed" = "open") {
  const host = new OverlayHost(document, mode);
  const onClick = vi.fn();
  const badge = new Badge(document, host.layer, onClick);
  return { host, badge, onClick };
}

describe("OverlayHost", () => {
  it("is one div in <html> with a closed shadow root that the page cannot read", () => {
    const host = new OverlayHost(document);
    expect(host.element.parentElement).toBe(document.documentElement);
    expect(host.element.tagName).toBe("DIV");
    expect(host.element.shadowRoot).toBeNull();
    expect(host.layer.getRootNode()).not.toBe(document);
    host.remove();
    expect(host.element.isConnected).toBe(false);
  });

  it("resets the page's styles with all: initial and does not catch the pointer or take room", () => {
    const { host } = setup();
    for (const element of [host.element, host.layer]) {
      expect(element.style.getPropertyValue("all")).toBe("initial");
      expect(element.style.getPropertyValue("pointer-events")).toBe("none");
      expect(element.style.getPropertyPriority("all")).toBe("important");
    }
    expect(host.element.style.getPropertyValue("position")).toBe("fixed");
    expect(host.element.style.getPropertyValue("width")).toBe("0px");
  });

  it("recognises events that come from inside it by their target", () => {
    const { host } = setup();
    expect(host.owns(host.element)).toBe(true);
    expect(host.owns(document.body)).toBe(false);
    expect(host.owns(null)).toBe(false);
  });

  it("builds no HTML: the layer is made with createElement", () => {
    const { host } = setup();
    expect(host.layer.localName).toBe("div");
  });
});

describe("Badge: its states", () => {
  const views: { name: string; view: BadgeView; text: string; background: string }[] = [
    {
      name: "icon",
      view: { kind: "icon", label: "English Tutor" },
      text: "",
      background: "#0072b2",
    },
    {
      name: "spinner",
      view: { kind: "spinner", label: "Checking" },
      text: "",
      background: "#ffffff",
    },
    {
      name: "check",
      view: { kind: "check", label: "No errors found" },
      text: "",
      background: "#1b7a3d",
    },
    {
      name: "warning",
      view: { kind: "warning", label: "No LLM" },
      text: "!",
      background: "#b3261e",
    },
    {
      name: "a grammar count",
      view: { kind: "count", count: 3, category: "grammar", label: "3 issues" },
      text: "3",
      background: "#d55e00",
    },
    {
      name: "a syntax count",
      view: { kind: "count", count: 12, category: "syntax", label: "12 issues" },
      text: "12",
      background: "#009e73",
    },
    {
      name: "a vocabulary count",
      view: { kind: "count", count: 1, category: "vocabulary", label: "1 issue" },
      text: "1",
      background: "#0072b2",
    },
    {
      name: "a large count",
      view: { kind: "count", count: 150, category: "grammar", label: "150 issues" },
      text: "99+",
      background: "#d55e00",
    },
  ];

  it.each(views)("shows $name", ({ view, text, background }) => {
    const { badge } = setup();
    badge.show(view);
    expect(badge.element.textContent).toBe(text);
    expect(badge.element.style.getPropertyValue("background")).toBe(background);
    expect(badge.element.getAttribute("title")).toBe(view.label);
    expect(badge.element.getAttribute("aria-label")).toBe(view.label);
    expect(badge.element.getAttribute("data-kind")).toBe(view.kind);
    expect(badge.view).toEqual(view);
  });

  it.each(["icon", "spinner", "check"] as const)(
    "draws %s as an SVG built with createElementNS",
    (kind) => {
      const { badge } = setup();
      badge.show({ kind, label: "x" });
      const svg = badge.element.firstElementChild;
      expect(svg?.namespaceURI).toBe("http://www.w3.org/2000/svg");
      expect(badge.element.querySelector("script, foreignObject")).toBeNull();
    },
  );

  it("replaces its content when the state changes", () => {
    const { badge } = setup();
    badge.show({ kind: "count", count: 2, category: "grammar", label: "2 issues" });
    badge.show({ kind: "check", label: "No errors found" });
    expect(badge.element.textContent).toBe("");
    expect(badge.element.childElementCount).toBe(1);
  });

  it("is a button of the layer that does not take the tab focus", () => {
    const { host, badge } = setup();
    expect(badge.element.tagName).toBe("BUTTON");
    expect(badge.element.getAttribute("tabindex")).toBe("-1");
    expect(badge.element.parentElement).toBe(host.layer);
  });

  it("is placed in window coordinates and hidden or shown", () => {
    const { badge } = setup();
    badge.place(100.4, 50.6);
    expect(badge.element.style.getPropertyValue("left")).toBe("100px");
    expect(badge.element.style.getPropertyValue("top")).toBe("51px");
    badge.setVisible(false);
    expect(badge.visible).toBe(false);
    badge.setVisible(true);
    expect(badge.visible).toBe(true);
    expect(BADGE_SIZE).toBe(22);
  });

  it("is gone when removed", () => {
    const { host, badge } = setup();
    badge.remove();
    expect(host.layer.childElementCount).toBe(0);
  });
});

describe("Badge: events", () => {
  it("calls back for a trusted click only", () => {
    const { badge, onClick } = setup();
    // An event a script made is not trusted.
    badge.element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onClick).not.toHaveBeenCalled();
    const trusted = new MouseEvent("click", { bubbles: true });
    Object.defineProperty(trusted, "isTrusted", { value: true });
    badge.element.dispatchEvent(trusted);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("does not take the focus from the text box when the mouse is pressed", () => {
    const { badge } = setup();
    const press = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    badge.element.dispatchEvent(press);
    expect(press.defaultPrevented).toBe(true);
  });
});

describe("BlockedCard: only Open in English Tutor", () => {
  function trusted(type: string, init: KeyboardEventInit = {}): Event {
    const event =
      "key" in init
        ? new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init })
        : new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
    Object.defineProperty(event, "isTrusted", { value: true });
    return event;
  }

  function open() {
    const host = new OverlayHost(document, "open");
    const card = new BlockedCard(document, host.layer);
    const openInTutor = vi.fn();
    card.open(
      "This site does not let English Tutor show its panel",
      { left: 500, top: 400 },
      openInTutor,
    );
    return {
      host,
      card,
      openInTutor,
      element: host.layer.querySelector<HTMLElement>("[role=dialog]"),
    };
  }

  it("shows the reason and one button", () => {
    const { element } = open();
    expect(element?.textContent).toContain("This site does not let English Tutor show its panel");
    const buttons = element?.querySelectorAll("button") ?? [];
    expect([...buttons].map((b) => b.textContent)).toEqual([OPEN_IN_TUTOR_LABEL]);
  });

  it("opens the tutor on a trusted click of the button and closes", () => {
    const { card, element, openInTutor } = open();
    const button = element?.querySelector("button");
    button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(openInTutor).not.toHaveBeenCalled();
    button?.dispatchEvent(trusted("click"));
    expect(openInTutor).toHaveBeenCalledTimes(1);
    expect(card.isOpen).toBe(false);
  });

  it("closes on Escape and on a press anywhere else, but not on a press on the card", () => {
    const { card, element } = open();
    element?.dispatchEvent(trusted("mousedown"));
    expect(card.isOpen).toBe(true);
    document.dispatchEvent(trusted("keydown", { key: "a" }));
    expect(card.isOpen).toBe(true);
    document.dispatchEvent(trusted("keydown", { key: "Escape" }));
    expect(card.isOpen).toBe(false);
    const again = open();
    document.body.dispatchEvent(trusted("mousedown"));
    expect(again.card.isOpen).toBe(false);
  });

  it("ignores Escape and presses that a page script made", () => {
    const { card } = open();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(card.isOpen).toBe(true);
  });

  it("is one card at a time, and removes its listeners when closed", () => {
    const { host, card } = open();
    card.open("again", { left: 10, top: 10 }, () => undefined);
    expect(host.layer.querySelectorAll("[role=dialog]")).toHaveLength(1);
    card.close();
    expect(host.layer.querySelectorAll("[role=dialog]")).toHaveLength(0);
    card.close();
  });
});
