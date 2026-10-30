// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditableWatcher } from "./text-watch";
import { clearBody, setBody } from "./testing/html";

afterEach(() => {
  clearBody(document);
});

/** Lets the observer's microtask run. */
const microtask = () =>
  new Promise<void>((resolve) => {
    queueMicrotask(resolve);
  });
const later = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function make(html = '<div contenteditable="true"><p>one two three</p></div>') {
  const element = setBody(document, html);
  const onChange = vi.fn();
  const watcher = new EditableWatcher(window, onChange);
  return { element, onChange, watcher };
}

describe("EditableWatcher: text an editor's host changed without an input event", () => {
  it.each([
    {
      name: "a text node's data",
      change: (e: HTMLElement) => {
        (e.querySelector("p")!.firstChild as Text).data = "four five six";
      },
    },
    {
      name: "the children replaced (React-style)",
      change: (e: HTMLElement) => {
        const p = document.createElement("p");
        p.textContent = "new";
        e.replaceChildren(p);
      },
    },
    {
      name: "textContent emptied",
      change: (e: HTMLElement) => {
        e.textContent = "";
      },
    },
    {
      name: "a child added deep inside",
      change: (e: HTMLElement) => {
        e.querySelector("p")!.append(document.createElement("br"));
      },
    },
    {
      name: "a text node replaced inside a paragraph",
      change: (e: HTMLElement) => {
        e.querySelector("p")!.replaceChildren(document.createTextNode("x"));
      },
    },
  ])("reports $name, once for a batch", async ({ change }) => {
    const { element, onChange, watcher } = make();
    watcher.watch(element);
    change(element);
    change(element);
    await later();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(element);
  });

  it("does not report an attribute change, or a change outside the host", async () => {
    const { element, onChange, watcher } = make();
    watcher.watch(element);
    element.setAttribute("data-x", "1");
    const other = document.createElement("div");
    document.body.append(other);
    other.textContent = "elsewhere";
    await later();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("watches a host once, and each host on its own", async () => {
    const { element, onChange, watcher } = make();
    const second = document.createElement("div");
    second.setAttribute("contenteditable", "true");
    document.body.append(second);
    watcher.watch(element);
    watcher.watch(element);
    watcher.watch(second);
    expect(watcher.size).toBe(2);
    second.textContent = "changed";
    await later();
    expect(onChange.mock.calls).toEqual([[second]]);
  });

  it("acknowledge drops the mutations already read, and still reports later ones", async () => {
    const { element, onChange, watcher } = make();
    watcher.watch(element);
    element.textContent = "typed";
    watcher.acknowledge(element);
    await later();
    expect(onChange).not.toHaveBeenCalled();
    element.textContent = "typed more";
    await later();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("unwatch and stop end the watching, and a host that was never watched is harmless", async () => {
    const { element, onChange, watcher } = make();
    watcher.watch(element);
    watcher.unwatch(element);
    expect(watcher.has(element)).toBe(false);
    watcher.acknowledge(element);
    watcher.unwatch(element);
    element.textContent = "a";
    await later();
    expect(onChange).not.toHaveBeenCalled();
    watcher.watch(element);
    watcher.stop();
    expect(watcher.size).toBe(0);
    element.textContent = "b";
    await later();
    await microtask();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does nothing in a window with no MutationObserver", () => {
    const element = setBody(document, '<div contenteditable="true">a</div>');
    const watcher = new EditableWatcher({} as Window, vi.fn());
    watcher.watch(element);
    expect(watcher.size).toBe(0);
  });
});
