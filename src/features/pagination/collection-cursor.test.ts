import { describe, expect, it } from "vitest";
import {
  decodeCollectionCursor,
  encodeCollectionCursor,
  InvalidCollectionCursorError,
} from "./collection-cursor";

const scope = {
  collection: "documents",
  documentStatus: "draft",
  projectProfileId: "default",
  query: "policy",
  workspaceId: "workspace-a",
};

describe("collection cursor", () => {
  it("round-trips an opaque bounded cursor only in its exact versioned scope", () => {
    const timestamp = new Date("2026-01-02T03:04:05.678Z");
    const cursor = encodeCollectionCursor({ id: "document-a", timestamp }, scope);

    expect(cursor.length).toBeLessThanOrEqual(512);
    expect(cursor).not.toContain("workspace-a");
    expect(decodeCollectionCursor(cursor, scope)).toEqual({ id: "document-a", timestamp });
  });

  it.each([
    [{ ...scope, workspaceId: "workspace-b" }],
    [{ ...scope, collection: "ai-runs" }],
    [{ ...scope, query: "other" }],
    [{ ...scope, projectProfileId: "legal" }],
  ])("rejects a cursor replayed in a different collection scope", (otherScope) => {
    const cursor = encodeCollectionCursor({ id: "document-a", timestamp: new Date(1_000) }, scope);

    expect(() => decodeCollectionCursor(cursor, otherScope)).toThrow(InvalidCollectionCursorError);
  });
});
