import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

describe("collaboration document codec Node portability", () => {
  it("imports under ordinary Node with the tsx loader", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        "await import('./src/features/collaboration/document-codec.ts')",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        maxBuffer: 16_384,
        timeout: 10_000,
      },
    );
    const output = `${result.stdout}${result.stderr}`;

    expect(output.length).toBeLessThanOrEqual(4_096);
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
  });
});
