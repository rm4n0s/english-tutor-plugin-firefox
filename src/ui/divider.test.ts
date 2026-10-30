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

describe("attachDivider remembering", () => {
  function setup() {
    const container = document.createElement("div");
    const handle = document.createElement("div");
    handle.setAttribute("aria-valuenow", "50");
    container.append(handle);
    document.body.append(container);
    const committed: number[] = [];
    const divider = attachDivider(handle, {
      container,
      axis: "x",
      property: "--share",
      min: 20,
      max: 80,
      step: 5,
      onCommit: (percent) => committed.push(percent),
    });
    // happy-dom has no pointer capture: the handle remembers it.
    let captured = false;
    handle.setPointerCapture = () => {
      captured = true;
    };
    handle.hasPointerCapture = () => captured;
    handle.releasePointerCapture = () => {
      captured = false;
    };
    container.getBoundingClientRect = () => new DOMRect(100, 0, 1000, 500);
    return { container, handle, divider, committed };
  }

  const pointer = (type: string, clientX = 0) =>
    Object.assign(new Event(type, { cancelable: true }), { pointerId: 1, clientX, clientY: 0 });

  it("set moves the divider, clamped, without committing", () => {
    const { container, handle, divider, committed } = setup();
    divider.set(33.5);
    expect(container.style.getPropertyValue("--share")).toBe("33.5%");
    expect(handle.getAttribute("aria-valuenow")).toBe("34");
    divider.set(99);
    expect(container.style.getPropertyValue("--share")).toBe("80%");
    expect(committed).toEqual([]);
  });

  it("commits once at the end of a drag, with the last size", () => {
    const { container, handle, committed } = setup();
    handle.dispatchEvent(pointer("pointerdown"));
    handle.dispatchEvent(pointer("pointermove", 400));
    handle.dispatchEvent(pointer("pointermove", 600));
    expect(committed).toEqual([]);
    handle.dispatchEvent(pointer("pointerup"));
    expect(committed).toEqual([50]);
    expect(container.style.getPropertyValue("--share")).toBe("50%");
  });

  it("commits nothing for a click without a move", () => {
    const { handle, committed } = setup();
    handle.dispatchEvent(pointer("pointerdown"));
    handle.dispatchEvent(pointer("pointerup"));
    expect(committed).toEqual([]);
  });

  it("commits each arrow key, and ignores other keys", () => {
    const { handle, committed } = setup();
    handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    handle.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    expect(committed).toEqual([55, 60]);
  });
});
