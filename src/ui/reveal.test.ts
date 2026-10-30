import { describe, expect, it } from "vitest";
import { scrollDeltaToReveal } from "./reveal";

describe("scrollDeltaToReveal", () => {
  it.each([
    { name: "already visible", top: 20, bottom: 40, view: 100, options: {}, expected: 0 },
    {
      name: "visible with the margin to spare",
      top: 30,
      bottom: 60,
      view: 100,
      options: { margin: 24 },
      expected: 0,
    },
    {
      name: "below the view, nearest edge",
      top: 120,
      bottom: 140,
      view: 100,
      options: {},
      expected: 40,
    },
    {
      name: "above the view, nearest edge",
      top: -50,
      bottom: -30,
      view: 100,
      options: {},
      expected: -50,
    },
    { name: "partly below", top: 90, bottom: 110, view: 100, options: {}, expected: 10 },
    {
      name: "inside the margin at the bottom",
      top: 70,
      bottom: 90,
      view: 100,
      options: { margin: 24 },
      expected: 14,
    },
    {
      name: "below the view, centred",
      top: 300,
      bottom: 320,
      view: 100,
      options: { center: true },
      expected: 260,
    },
    {
      name: "above the view, centred",
      top: -200,
      bottom: -180,
      view: 100,
      options: { center: true },
      expected: -240,
    },
    {
      name: "taller than the view: lined up at its top",
      top: 50,
      bottom: 400,
      view: 100,
      options: {},
      expected: 50,
    },
    {
      name: "taller than the view with a margin",
      top: 50,
      bottom: 400,
      view: 100,
      options: { margin: 10 },
      expected: 40,
    },
  ])("$name", ({ top, bottom, view, options, expected }) => {
    expect(scrollDeltaToReveal(top, bottom, view, options)).toBe(expected);
  });
});
