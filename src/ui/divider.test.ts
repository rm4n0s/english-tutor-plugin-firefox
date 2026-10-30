// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { attachDivider, clampPercent, percentAt } from "./divider";

describe("clampPercent", () => {
  it.each([
    { value: 50, expected: 50 },
    { value: 5, expected: 20 },
    { value: 95, expected: 80 },
    { value: 20, expected: 20 },
    { value: 80, expected: 80 },
  ])("clamps $value to $expected between 20 and 80", ({ value, expected }) => {
    expect(clampPercent(value, 20, 80)).toBe(expected);
  });
});

describe("percentAt", () => {
  it.each([
    { name: "middle", position: 600, start: 100, size: 1000, expected: 50 },
    { name: "before the box", position: 0, start: 100, size: 1000, expected: 20 },
    { name: "after the box", position: 5000, start: 100, size: 1000, expected: 80 },
    { name: "an empty box", position: 10, start: 0, size: 0, expected: 20 },
  ])("$name", ({ position, start, size, expected }) => {
    expect(percentAt(position, start, size, 20, 80)).toBe(expected);
  });
});

describe("attachDivider keyboard", () => {
  function setup(axis: "x" | "y") {
    const container = document.createElement("div");
    const handle = document.createElement("div");
    handle.setAttribute("aria-valuenow", "50");
    container.append(handle);
    document.body.append(container);
    attachDivider(handle, { container, axis, property: "--share", min: 20, max: 80, step: 5 });
    return { container, handle };
  }

  it.each([
    { axis: "x" as const, key: "ArrowRight", expected: "55%" },
    { axis: "x" as const, key: "ArrowLeft", expected: "45%" },
    { axis: "y" as const, key: "ArrowDown", expected: "55%" },
    { axis: "y" as const, key: "ArrowUp", expected: "45%" },
  ])("$key moves a $axis divider", ({ axis, key, expected }) => {
    const { container, handle } = setup(axis);
    handle.dispatchEvent(new KeyboardEvent("keydown", { key, cancelable: true }));
    expect(container.style.getPropertyValue("--share")).toBe(expected);
  });

  it.each(["ArrowUp", "Enter", "a"])("ignores %s on an x divider", (key) => {
    const { container, handle } = setup("x");
    const event = new KeyboardEvent("keydown", { key, cancelable: true });
    handle.dispatchEvent(event);
    expect(container.style.getPropertyValue("--share")).toBe("");
    expect(event.defaultPrevented).toBe(false);
  });

  it("stops at the limits", () => {
    const { container, handle } = setup("x");
    for (let i = 0; i < 20; i++) {
      handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    }
    expect(container.style.getPropertyValue("--share")).toBe("80%");
    expect(handle.getAttribute("aria-valuenow")).toBe("80");
  });
});
