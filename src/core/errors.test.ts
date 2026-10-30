import { describe, expect, it } from "vitest";
import { AppError } from "./errors";

describe("AppError", () => {
  it("is an Error with a tag, a message and a copy of the metadata", () => {
    const metadata = { id: 3 };
    const err = new AppError("DocumentNotFound", "no such document", metadata);
    metadata.id = 4;
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AppError);
    expect(err.name).toBe("AppError");
    expect(err.tag).toBe("DocumentNotFound");
    expect(err.message).toBe("no such document");
    expect(err.metadata).toEqual({ id: 3 });
    expect(err.cause).toBeUndefined();
  });

  describe.each([
    { name: "no layers", layers: [], route: "LLMCallTimeout" },
    {
      name: "one layer",
      layers: ["OpenAIClient.chat"],
      route: "OpenAIClient.chat->LLMCallTimeout",
    },
    {
      name: "layers are added outermost last, listed outermost first",
      layers: ["OpenAIClient.chat", "Analyzer.check"],
      route: "Analyzer.check->OpenAIClient.chat->LLMCallTimeout",
    },
  ])("route with $name", ({ layers, route }) => {
    const err = new AppError("LLMCallTimeout", "too slow");
    for (const layer of layers) err.via(layer);

    it("builds the route", () => {
      expect(err.route()).toBe(route);
    });

    it("keeps the tag", () => {
      expect(err.tag).toBe("LLMCallTimeout");
    });
  });

  it.each([
    { route: "Analyzer.check->OpenAIClient.chat->LLMCallTimeout", expected: true },
    { route: "OpenAIClient.chat->LLMCallTimeout", expected: true },
    { route: "LLMCallTimeout", expected: true },
    { route: "Analyzer.check", expected: true },
    { route: "Analyzer.check->LLMCallTimeout", expected: false },
    { route: "LLMCallFailed", expected: false },
    { route: "Explainer.explain->OpenAIClient.chat->LLMCallTimeout", expected: false },
  ])("hasRoute($route) is $expected", ({ route, expected }) => {
    const err = new AppError("LLMCallTimeout", "too slow")
      .via("OpenAIClient.chat")
      .via("Analyzer.check");
    expect(err.hasRoute(route)).toBe(expected);
  });

  it("via returns the same error, so it can be thrown at once", () => {
    const err = new AppError("X", "x");
    expect(err.via("A.b")).toBe(err);
    expect(err.where).toEqual(["A.b"]);
  });

  describe("wrap", () => {
    it.each([
      { name: "an Error", foreign: new TypeError("NetworkError"), message: "NetworkError" },
      { name: "an Error with no message", foreign: new Error(""), message: "unknown error" },
      { name: "a string", foreign: "boom", message: "unknown error" },
      { name: "undefined", foreign: undefined, message: "unknown error" },
    ])("wraps $name and keeps it as the cause", ({ foreign, message }) => {
      const err = AppError.wrap("DatabaseQueryFailed", foreign, { store: "documents" });
      expect(err).toBeInstanceOf(AppError);
      expect(err.tag).toBe("DatabaseQueryFailed");
      expect(err.message).toBe(message);
      expect(err.metadata).toEqual({ store: "documents" });
      expect(err.cause).toBe(foreign);
    });

    it("returns an AppError unchanged, so its tag and route survive", () => {
      const inner = new AppError("LLMCallTimeout", "too slow").via("OpenAIClient.chat");
      const result = AppError.wrap("LLMCallFailed", inner);
      expect(result).toBe(inner);
      expect(result.tag).toBe("LLMCallTimeout");
      expect(result.route()).toBe("OpenAIClient.chat->LLMCallTimeout");
    });
  });
});
