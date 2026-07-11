import { describe, expect, it, vi } from "vitest";
import {
  OperationTimeoutError,
  RESOURCE_LIMITS,
  validateTiptapResource,
  withOperationTimeout,
} from "./resource-policy";

describe("resource policy", () => {
  it("defines the required conservative resource limits", () => {
    expect(RESOURCE_LIMITS).toEqual({
      docxBytes: 10 * 1024 * 1024,
      documentDepth: 64,
      documentNodes: 100_000,
      operationMs: 30_000,
    });
  });

  it("counts a valid Tiptap tree deterministically", () => {
    expect(
      validateTiptapResource({
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "Hello" }] }],
      }),
    ).toEqual({ depth: 3, nodes: 3, ok: true });
  });

  it("short-circuits when node or depth limits are exceeded", () => {
    expect(
      validateTiptapResource(
        { type: "doc", content: [{ type: "paragraph" }, { type: "paragraph" }] },
        { documentDepth: 4, documentNodes: 2 },
      ),
    ).toEqual({ limit: "documentNodes", ok: false });

    expect(
      validateTiptapResource(
        { type: "doc", content: [{ type: "paragraph", content: [{ type: "text" }] }] },
        { documentDepth: 2, documentNodes: 10 },
      ),
    ).toEqual({ limit: "documentDepth", ok: false });
  });

  it("rejects malformed and cyclic runtime objects without recursing forever", () => {
    const cyclic: { content?: unknown[]; type: string } = { type: "doc" };
    cyclic.content = [cyclic];

    expect(validateTiptapResource(cyclic)).toEqual({ limit: "malformed", ok: false });
    expect(validateTiptapResource({ type: "doc", content: "not-an-array" })).toEqual({
      limit: "malformed",
      ok: false,
    });
  });

  it("aborts and rejects with a typed timeout at the configured deadline", async () => {
    vi.useFakeTimers();
    const operation = vi.fn(
      (signal: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason));
        }),
    );

    try {
      const pending = withOperationTimeout(operation, 25);
      const rejection = expect(pending).rejects.toBeInstanceOf(OperationTimeoutError);
      await vi.advanceTimersByTimeAsync(25);
      await rejection;
      expect(operation.mock.calls[0]?.[0].aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
