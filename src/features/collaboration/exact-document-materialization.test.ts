import { describe, expect, it, vi } from "vitest";

import type { CollaborationDocumentCodec } from "./contracts";
import {
  createExactCollaborationMaterializationLoader,
  ExactCollaborationMaterializationError,
} from "./exact-document-materialization";
import type { CollaborationPersistence } from "./persistence";
import { CollaborationPersistenceError } from "./persistence";

const scope = { workspaceId: "workspace_a" };

describe("exact collaboration document materialization", () => {
  it("returns legacy only when no current collaboration generation exists", async () => {
    const load = vi.fn(async () => null);
    const loader = createExactCollaborationMaterializationLoader({
      codec: { materialize: vi.fn() } as unknown as CollaborationDocumentCodec,
      persistence: { load } as unknown as CollaborationPersistence,
    });

    await expect(loader(scope, "doc_legacy")).resolves.toEqual({ kind: "legacy" });
    expect(load).toHaveBeenCalledWith(scope, "doc_legacy");
  });

  it("materializes and hashes the exact loaded Y.Doc before destroying it", async () => {
    const destroy = vi.fn();
    const document = { destroy };
    const materialization = {
      contentJson: { type: "doc" as const, content: [{ type: "paragraph" }] },
      metadataJson: { owner: "alice" },
      plainText: "Canonical",
      title: "Canonical title",
    };
    const materialize = vi.fn(() => materialization);
    const loader = createExactCollaborationMaterializationLoader({
      codec: { materialize } as unknown as CollaborationDocumentCodec,
      persistence: {
        load: vi.fn(async () => ({
          checkpointSeq: 7,
          document,
          documentId: "doc_1",
          generation: 2,
          headSeq: 11,
          projectedSeq: 9,
          schemaFingerprint: "f".repeat(64),
          schemaVersion: 1,
        })),
      } as unknown as CollaborationPersistence,
    });

    const result = await loader(scope, "doc_1");

    expect(materialize).toHaveBeenCalledWith(document);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      diagnostics: {
        contentHash: "aa5aac411bad40b78db45790e95df3fbd1f274b31c5a3be682b745535c33aecf",
        generation: 2,
        headSeq: 11,
        schemaFingerprint: "f".repeat(64),
      },
      kind: "collaboration",
      materialization,
    });
  });

  it.each([
    [new CollaborationPersistenceError("contention", true), "unavailable"],
    [new CollaborationPersistenceError("corrupt_state", false), "conflict"],
    [new Error("database offline"), "unavailable"],
  ] as const)("maps persistence failures without falling back to SQL", async (failure, expectedCategory) => {
    const loader = createExactCollaborationMaterializationLoader({
      codec: { materialize: vi.fn() } as unknown as CollaborationDocumentCodec,
      persistence: {
        load: vi.fn(async () => {
          throw failure;
        }),
      } as unknown as CollaborationPersistence,
    });

    await expect(loader(scope, "doc_1")).rejects.toEqual(
      new ExactCollaborationMaterializationError(expectedCategory),
    );
  });

  it("destroys a loaded document when codec materialization rejects it", async () => {
    const destroy = vi.fn();
    const loader = createExactCollaborationMaterializationLoader({
      codec: {
        materialize: vi.fn(() => {
          throw new Error("invalid canonical document");
        }),
      } as unknown as CollaborationDocumentCodec,
      persistence: {
        load: vi.fn(async () => ({
          checkpointSeq: 0,
          document: { destroy },
          documentId: "doc_1",
          generation: 1,
          headSeq: 0,
          projectedSeq: 0,
          schemaFingerprint: "f".repeat(64),
          schemaVersion: 1,
        })),
      } as unknown as CollaborationPersistence,
    });

    await expect(loader(scope, "doc_1")).rejects.toEqual(
      new ExactCollaborationMaterializationError("conflict"),
    );
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});
