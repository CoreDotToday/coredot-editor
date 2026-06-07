import { describe, expect, it } from "vitest";
import { normalizeCoreTodayBaseUrl } from "./core-today-base-url";

describe("Core.Today base URL normalization", () => {
  it.each([
    "https://api.core.today:444/llm/openai/v1",
    "https://api.core.today:443/llm/openai/v1",
    "http://api.core.today/llm/openai/v1",
    "https://user:pass@api.core.today/llm/openai/v1",
    "https://api.core.today/llm/openai/v1?key=value",
    "https://api.core.today/llm/openai/v1#fragment",
    "https://api.core.today/llm/gemini/v1beta",
  ])("rejects non-allowlisted OpenAI-compatible Core.Today URL %s", (baseUrl) => {
    expect(() => normalizeCoreTodayBaseUrl("coredot", baseUrl)).toThrow("Invalid Core.Today base URL");
  });

  it("normalizes trailing slashes for the provider-specific allowlisted URL", () => {
    expect(normalizeCoreTodayBaseUrl("anthropic", "https://api.core.today/llm/anthropic/v1/")).toBe(
      "https://api.core.today/llm/anthropic/v1",
    );
    expect(normalizeCoreTodayBaseUrl("gemini", "https://api.core.today/llm/gemini/v1beta/")).toBe(
      "https://api.core.today/llm/gemini/v1beta",
    );
  });
});
