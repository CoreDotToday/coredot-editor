import { availableParallelism } from "node:os";
import { describe, expect, it } from "vitest";
import vitestConfig from "../../vitest.config";

describe("Vitest worker policy", () => {
  it("keeps the mixed jsdom and DOCX suite below the available CPU count", () => {
    const expectedWorkers = Math.max(
      1,
      Math.min(8, availableParallelism() - 1),
    );

    expect(vitestConfig).toMatchObject({
      test: { maxWorkers: expectedWorkers },
    });
  });
});
