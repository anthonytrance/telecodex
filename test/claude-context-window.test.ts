import { contextWindowForModel } from "../src/providers/claude-adapter.js";

describe("claude context window per model", () => {
  it("gives the million-token models their real window", () => {
    // A single configured window reported an Opus 5 session as five times
    // over capacity, because the configured default was 200k.
    expect(contextWindowForModel("claude-opus-5")).toBe(1_000_000);
    expect(contextWindowForModel("claude-sonnet-5")).toBe(1_000_000);
    expect(contextWindowForModel("claude-opus-4-8")).toBe(1_000_000);
    expect(contextWindowForModel("claude-fable-5")).toBe(1_000_000);
  });

  it("keeps Haiku at its smaller window", () => {
    expect(contextWindowForModel("claude-haiku-4-5-20251001")).toBe(200_000);
  });

  it("uses the registered vendor model window", () => {
    expect(contextWindowForModel("qwen3.8-max")).toBe(1_000_000);
    expect(contextWindowForModel("qwen")).toBe(1_000_000);
  });

  it("defers to the configured default for anything it does not recognise", () => {
    expect(contextWindowForModel("some-future-model")).toBeUndefined();
    expect(contextWindowForModel(undefined)).toBeUndefined();
  });
});
