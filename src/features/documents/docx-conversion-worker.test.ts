import { describe, expect, it } from "vitest";
import { OperationTimeoutError, withOperationTimeout } from "@/features/security/resource-policy";
import { runDocxWorkerForTests } from "./docx-conversion";

describe("DOCX conversion worker", () => {
  it("terminates CPU-blocking conversion work at the main-thread deadline", async () => {
    const startedAt = performance.now();

    await expect(
      withOperationTimeout((signal) => runDocxWorkerForTests({ blockForMs: 2_000 }, signal), 50),
    ).rejects.toBeInstanceOf(OperationTimeoutError);

    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });
});
