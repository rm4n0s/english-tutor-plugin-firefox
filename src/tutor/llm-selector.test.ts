import { describe, expect, it } from "vitest";
import { chooseSelectedId } from "./llm-selector";

describe("chooseSelectedId", () => {
  const configs = [{ id: 4 }, { id: 2 }, { id: 9 }];
  it.each([
    { name: "keeps a stored id that exists", configs, stored: 2, expected: 2 },
    { name: "takes the first by name when nothing is stored", configs, stored: null, expected: 4 },
    {
      name: "takes the first by name when the stored LLM was deleted",
      configs,
      stored: 7,
      expected: 4,
    },
    { name: "is none without LLMs", configs: [], stored: null, expected: null },
    { name: "is none without LLMs even if one was stored", configs: [], stored: 3, expected: null },
  ])("$name", ({ configs: list, stored, expected }) => {
    expect(chooseSelectedId(list, stored)).toBe(expected);
  });
});
