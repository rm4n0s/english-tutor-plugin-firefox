import { describe, expect, it } from "vitest";
import { WindowFragment } from "./fragment";

function fakeWindow(location: { hash: string; pathname: string; search: string }) {
  const replaced: { state: unknown; url: string }[] = [];
  const win = {
    location,
    history: {
      state: { kept: true },
      replaceState: (state: unknown, _title: string, url: string) => {
        replaced.push({ state, url });
      },
    },
  } as unknown as Pick<Window, "location" | "history">;
  return { win, replaced };
}

describe("WindowFragment", () => {
  it.each(["", "#handoff=abc", "#x"])("reads the fragment %j", (hash) => {
    const { win } = fakeWindow({ hash, pathname: "/tutor.html", search: "" });
    expect(new WindowFragment(win).get()).toBe(hash);
  });

  it.each([
    { search: "", expected: "/tutor.html" },
    { search: "?a=1", expected: "/tutor.html?a=1" },
  ])(
    "clears it with replaceState, without a new history entry, keeping $search",
    ({ search, expected }) => {
      const { win, replaced } = fakeWindow({
        hash: "#handoff=abc",
        pathname: "/tutor.html",
        search,
      });
      new WindowFragment(win).clear();
      expect(replaced).toEqual([{ state: { kept: true }, url: expected }]);
    },
  );
});
