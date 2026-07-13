import { describe, expect, it } from "vitest";
import vitestConfig from "../../vitest.config";

describe("Vitest worker policy", () => {
  it("keeps the mixed jsdom and DOCX suite on a bounded worker pool", () => {
    expect(vitestConfig).toMatchObject({ test: { maxWorkers: 8 } });
  });
});
