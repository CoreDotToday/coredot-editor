import * as Y from "yjs";

import type { ProjectProfile } from "@/features/projects/project-profile";

import type { CollaborationDocumentCodec, CollaborationMaterialization } from "./contracts";
import { CollaborationCodecError } from "./document-codec";

export type AppendCandidateEvaluation = {
  candidateCheckpoint: Uint8Array;
  changed: boolean;
  document: Y.Doc;
  preCandidateCheckpoint: Uint8Array;
  rotation?: {
    checkpoint: Uint8Array;
    materialization?: CollaborationMaterialization;
  };
};

export type AppendCandidateEvaluationFailure = "corrupt_state" | "storage_budget";

export class AppendCandidateEvaluationError extends Error {
  override readonly name = "AppendCandidateEvaluationError";

  constructor(readonly failure: AppendCandidateEvaluationFailure) {
    super("Collaboration append candidate evaluation failed");
  }
}

export function shouldRotateAppend(input: {
  checkpointBytes: number;
  cumulativeLimitBytes: number;
  tailBytes: number;
  updateBytes: number;
}) {
  return input.checkpointBytes + input.tailBytes + input.updateBytes > input.cumulativeLimitBytes;
}

export function evaluateAppendCandidate(input: {
  checkpointBytesLimit: number;
  codec: CollaborationDocumentCodec;
  document: Y.Doc;
  projectProfile: ProjectProfile;
  shouldMaterializeBeforeRotation: boolean;
  shouldRotate: boolean;
  update: Uint8Array;
}): AppendCandidateEvaluation {
  const preCandidateCheckpoint = encodeCandidateCheckpoint(
    input.codec,
    input.document,
    input.checkpointBytesLimit,
    input.shouldRotate,
  );
  let candidateDocument = input.document;
  let rotation: AppendCandidateEvaluation["rotation"];

  if (input.shouldRotate) {
    let materialization: CollaborationMaterialization | undefined;
    try {
      if (input.shouldMaterializeBeforeRotation) {
        materialization = input.codec.materialize(input.document);
      }
      candidateDocument = input.codec.loadCheckpoint(preCandidateCheckpoint);
    } catch {
      throw new AppendCandidateEvaluationError("storage_budget");
    }
    rotation = {
      checkpoint: preCandidateCheckpoint,
      ...(materialization ? { materialization } : {}),
    };
  }

  try {
    Y.applyUpdate(candidateDocument, input.update, "durable-append-validation");
  } catch {
    throw new AppendCandidateEvaluationError("corrupt_state");
  }

  let candidateCheckpoint: Uint8Array;
  try {
    input.codec.validate(candidateDocument, input.projectProfile);
    candidateCheckpoint = input.codec.encodeCheckpoint(candidateDocument);
  } catch (error) {
    if (
      error instanceof CollaborationCodecError
      && error.failure.reason === "checkpoint_budget"
    ) {
      throw new AppendCandidateEvaluationError("storage_budget");
    }
    throw new AppendCandidateEvaluationError("corrupt_state");
  }
  if (candidateCheckpoint.byteLength > input.checkpointBytesLimit) {
    throw new AppendCandidateEvaluationError("storage_budget");
  }

  return {
    candidateCheckpoint,
    // Full-state encoding includes pendingStructs and pendingDs. Event-based
    // detection would incorrectly classify those dependency-only changes as no-op.
    changed: !equalBytes(preCandidateCheckpoint, candidateCheckpoint),
    document: candidateDocument,
    preCandidateCheckpoint,
    ...(rotation ? { rotation } : {}),
  };
}

function encodeCandidateCheckpoint(
  codec: CollaborationDocumentCodec,
  document: Y.Doc,
  checkpointBytesLimit: number,
  rotating: boolean,
) {
  let checkpoint: Uint8Array;
  try {
    checkpoint = codec.encodeCheckpoint(document);
  } catch (error) {
    if (
      rotating
      || (error instanceof CollaborationCodecError && error.failure.reason === "checkpoint_budget")
    ) {
      throw new AppendCandidateEvaluationError("storage_budget");
    }
    throw new AppendCandidateEvaluationError("corrupt_state");
  }
  if (checkpoint.byteLength > checkpointBytesLimit) {
    throw new AppendCandidateEvaluationError("storage_budget");
  }
  return checkpoint;
}

function equalBytes(left: Uint8Array, right: Uint8Array) {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((value, index) => value === right[index]);
}
