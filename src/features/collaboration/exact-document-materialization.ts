import "server-only";

import { db } from "@/db/client";
import type { WorkspaceScope } from "@/features/auth/request-context";
import { resolveActiveProjectProfile } from "@/features/projects/active-project-profile";

import { hashCanonicalJson } from "./canonical-hashing";
import type { CollaborationDocumentCodec, CollaborationMaterialization } from "./contracts";
import { createCollaborationDocumentCodec } from "./document-codec";
import {
  CollaborationPersistenceError,
  createCollaborationPersistence,
  type CollaborationPersistence,
} from "./persistence";

export type ExactCollaborationDiagnostics = {
  contentHash: string;
  generation: number;
  headSeq: number;
  schemaFingerprint: string;
};

export type ExactCollaborationMaterialization =
  | { kind: "legacy" }
  | {
      diagnostics: ExactCollaborationDiagnostics;
      kind: "collaboration";
      materialization: CollaborationMaterialization;
    };

export type ExactCollaborationMaterializationFailure = "conflict" | "unavailable";

export class ExactCollaborationMaterializationError extends Error {
  override readonly name = "ExactCollaborationMaterializationError";

  constructor(readonly category: ExactCollaborationMaterializationFailure) {
    super(category === "conflict"
      ? "Collaboration state is not safe to materialize"
      : "Collaboration state is temporarily unavailable");
  }
}

export type ExactCollaborationHttpFailure = {
  code: "collaboration_state_conflict" | "collaboration_state_unavailable";
  error: string;
  status: 409 | 503;
};

export function toExactCollaborationHttpFailure(error: unknown): ExactCollaborationHttpFailure | null {
  if (!(error instanceof ExactCollaborationMaterializationError)) return null;
  return error.category === "conflict"
    ? {
        code: "collaboration_state_conflict",
        error: error.message,
        status: 409,
      }
    : {
        code: "collaboration_state_unavailable",
        error: error.message,
        status: 503,
      };
}

type ExactCollaborationMaterializationDependencies = {
  codec: Pick<CollaborationDocumentCodec, "materialize">;
  persistence: Pick<CollaborationPersistence, "load">;
};

export function createExactCollaborationMaterializationLoader(
  dependencies: ExactCollaborationMaterializationDependencies,
) {
  return async function loadExactMaterialization(
    scope: WorkspaceScope,
    documentId: string,
  ): Promise<ExactCollaborationMaterialization> {
    let snapshot: Awaited<ReturnType<CollaborationPersistence["load"]>>;
    try {
      snapshot = await dependencies.persistence.load(scope, documentId);
    } catch (error) {
      throw mapLoadFailure(error);
    }
    if (!snapshot) return { kind: "legacy" };

    try {
      const materialization = dependencies.codec.materialize(snapshot.document);
      return {
        diagnostics: {
          contentHash: hashCanonicalMaterialization(materialization),
          generation: snapshot.generation,
          headSeq: snapshot.headSeq,
          schemaFingerprint: snapshot.schemaFingerprint,
        },
        kind: "collaboration",
        materialization,
      };
    } catch {
      throw new ExactCollaborationMaterializationError("conflict");
    } finally {
      snapshot.document.destroy();
    }
  };
}

const projectProfile = resolveActiveProjectProfile();
const codec = createCollaborationDocumentCodec(projectProfile);
const persistence = createCollaborationPersistence(db, { codec, projectProfile });

export const loadExactCollaborationMaterialization = createExactCollaborationMaterializationLoader({
  codec,
  persistence,
});

function mapLoadFailure(error: unknown) {
  if (error instanceof CollaborationPersistenceError) {
    return new ExactCollaborationMaterializationError(error.retryable ? "unavailable" : "conflict");
  }
  return new ExactCollaborationMaterializationError("unavailable");
}

export function hashCanonicalMaterialization(value: CollaborationMaterialization) {
  return hashCanonicalJson(value);
}
