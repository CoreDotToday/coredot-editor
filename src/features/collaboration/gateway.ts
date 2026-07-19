import * as Y from "yjs";

import type { RequestContext, WorkspaceScope } from "@/features/auth/request-context";
import type { CollaborationUpdateOriginKind } from "@/db/schema";

import type {
  AppendCollaborationUpdate,
  CollaborationPersistence,
  CollaborationSnapshot,
  DurableUpdateReceipt,
} from "./persistence";
import { createCollaborationRoomName } from "./room-name";

const MAX_STATE_VECTOR_BYTES = 1024 * 1024;
const MAX_IDENTIFIER_BYTES = 256;

export type CollaborativeProposalCommand = CollaborationCommandIdentity;
export type CollaborativeProposalBatchCommand = CollaborationCommandIdentity;
export type CollaborativeUndoCommand = CollaborationCommandIdentity;

type CollaborationCommandIdentity = {
  commandId: string;
  documentId: string;
  generation: number;
};

export type CollaborativeCommandResult = {
  checksum: string;
  documentId: string;
  generation: number;
  headSeq: number;
  status: "applied";
};

export type DurableBarrier = {
  documentId: string;
  generation: number;
  headSeq: number;
  stateVector: Uint8Array;
};

export interface CollaborativeDocumentGateway {
  applyProposal(
    context: RequestContext,
    command: CollaborativeProposalCommand,
  ): Promise<CollaborativeCommandResult>;
  applyProposalBatch(
    context: RequestContext,
    command: CollaborativeProposalBatchCommand,
  ): Promise<CollaborativeCommandResult>;
  closeRoom(
    scope: WorkspaceScope,
    documentId: string,
    reason: "archived" | "revoked" | "schema_changed",
  ): Promise<void>;
  flushBarrier(
    scope: WorkspaceScope,
    documentId: string,
    observedStateVector: Uint8Array,
  ): Promise<DurableBarrier>;
  getSnapshot(
    scope: WorkspaceScope,
    documentId: string,
  ): Promise<CollaborationSnapshot>;
  undoChange(
    context: RequestContext,
    command: CollaborativeUndoCommand,
  ): Promise<CollaborativeCommandResult>;
}

export type CollaborationGatewayCategory =
  | "invalid_input"
  | "live_apply_failed"
  | "not_durable"
  | "not_found"
  | "stale_generation"
  | "unavailable";

export class CollaborationGatewayError extends Error {
  override readonly name = "CollaborationGatewayError";

  constructor(readonly category: CollaborationGatewayCategory) {
    super({
      invalid_input: "Collaborative command input is invalid",
      live_apply_failed: "Collaborative update is durable but live delivery failed",
      not_durable: "Observed collaboration state is not durable",
      not_found: "Collaboration document was not found",
      stale_generation: "Collaboration generation is no longer current",
      unavailable: "Collaboration gateway is unavailable",
    }[category]);
  }
}

type CommandPlanner<TCommand extends CollaborationCommandIdentity> = (
  document: Y.Doc,
  command: TCommand,
  snapshot: CollaborationSnapshot,
) => void | Promise<void>;

export function createCollaborativeDocumentGateway(options: {
  closeRoom(
    room: string,
    reason: "archived" | "revoked" | "room_rotated" | "schema_changed",
  ): void | Promise<void>;
  persistence: Pick<CollaborationPersistence, "appendValidatedUpdate" | "load">;
  planners: {
    proposal: CommandPlanner<CollaborativeProposalCommand>;
    proposalBatch: CommandPlanner<CollaborativeProposalBatchCommand>;
    undo: CommandPlanner<CollaborativeUndoCommand>;
  };
  publish(
    scope: WorkspaceScope,
    documentId: string,
    generation: number,
    update: Uint8Array,
  ): void | Promise<void>;
}): CollaborativeDocumentGateway {
  const getSnapshot = async (scope: WorkspaceScope, documentId: string) => {
    validateScope(scope, documentId);
    const loaded = await load(options.persistence, scope, documentId);
    try {
      return { ...loaded, document: cloneDocument(loaded.document) };
    } finally {
      loaded.document.destroy();
    }
  };

  const applyCommand = async <TCommand extends CollaborationCommandIdentity>(
    context: RequestContext,
    command: TCommand,
    originKind: Extract<CollaborationUpdateOriginKind, "proposal_command" | "undo_command">,
    planner: CommandPlanner<TCommand>,
  ): Promise<CollaborativeCommandResult> => {
    validateContextAndCommand(context, command);
    const scope = { workspaceId: context.workspaceId };
    const snapshot = await load(options.persistence, scope, command.documentId);
    if (snapshot.generation !== command.generation) {
      snapshot.document.destroy();
      throw new CollaborationGatewayError("stale_generation");
    }
    const working = cloneDocument(snapshot.document);
    snapshot.document.destroy();
    let update: Uint8Array;
    try {
      const before = Y.encodeStateVector(working);
      await planner(working, command, { ...snapshot, document: working });
      update = Y.encodeStateAsUpdate(working, before);
    } catch {
      throw new CollaborationGatewayError("invalid_input");
    } finally {
      working.destroy();
    }
    let receipt: DurableUpdateReceipt;
    try {
      const input: AppendCollaborationUpdate = {
        documentId: command.documentId,
        generation: command.generation,
        idempotencyKey: command.commandId,
        originKind,
        principalId: context.principalId,
        requestId: context.requestId,
        semanticActionId: command.commandId,
        update,
      };
      receipt = await options.persistence.appendValidatedUpdate(scope, input);
    } catch {
      throw new CollaborationGatewayError("unavailable");
    }
    try {
      await options.publish(
        scope,
        command.documentId,
        receipt.generation,
        update,
      );
    } catch {
      try {
        await options.closeRoom(createCollaborationRoomName({
          documentId: command.documentId,
          generation: receipt.generation,
          workspaceId: scope.workspaceId,
        }), "room_rotated");
      } catch {
        // Durability remains authoritative. A failed close is intentionally not
        // allowed to mask the live-apply category returned to the caller.
      }
      throw new CollaborationGatewayError("live_apply_failed");
    }
    return {
      checksum: receipt.checksum,
      documentId: receipt.documentId,
      generation: receipt.generation,
      headSeq: receipt.headSeq,
      status: "applied",
    };
  };

  return {
    applyProposal(context, command) {
      return applyCommand(
        context,
        command,
        "proposal_command",
        options.planners.proposal,
      );
    },

    applyProposalBatch(context, command) {
      return applyCommand(
        context,
        command,
        "proposal_command",
        options.planners.proposalBatch,
      );
    },

    async closeRoom(scope, documentId, reason) {
      validateScope(scope, documentId);
      const snapshot = await load(options.persistence, scope, documentId);
      try {
        await options.closeRoom(createCollaborationRoomName({
          documentId,
          generation: snapshot.generation,
          workspaceId: scope.workspaceId,
        }), reason);
      } finally {
        snapshot.document.destroy();
      }
    },

    async flushBarrier(scope, documentId, observedStateVector) {
      validateScope(scope, documentId);
      if (
        !(observedStateVector instanceof Uint8Array)
        || observedStateVector.byteLength < 1
        || observedStateVector.byteLength > MAX_STATE_VECTOR_BYTES
      ) {
        throw new CollaborationGatewayError("invalid_input");
      }
      const snapshot = await load(options.persistence, scope, documentId);
      try {
        const observed = decodeStateVector(observedStateVector);
        const durableVector = Y.encodeStateVector(snapshot.document);
        const durable = decodeStateVector(durableVector);
        for (const [client, clock] of observed) {
          if ((durable.get(client) ?? 0) < clock) {
            throw new CollaborationGatewayError("not_durable");
          }
        }
        return {
          documentId,
          generation: snapshot.generation,
          headSeq: snapshot.headSeq,
          stateVector: durableVector,
        };
      } finally {
        snapshot.document.destroy();
      }
    },

    getSnapshot,

    undoChange(context, command) {
      return applyCommand(context, command, "undo_command", options.planners.undo);
    },
  };
}

async function load(
  persistence: Pick<CollaborationPersistence, "load">,
  scope: WorkspaceScope,
  documentId: string,
) {
  try {
    const snapshot = await persistence.load(scope, documentId);
    if (!snapshot) throw new CollaborationGatewayError("not_found");
    return snapshot;
  } catch (error) {
    if (error instanceof CollaborationGatewayError) throw error;
    throw new CollaborationGatewayError("unavailable");
  }
}

function cloneDocument(document: Y.Doc) {
  const clone = new Y.Doc();
  Y.applyUpdate(clone, Y.encodeStateAsUpdate(document));
  return clone;
}

function decodeStateVector(encoded: Uint8Array) {
  try {
    return Y.decodeStateVector(encoded);
  } catch {
    throw new CollaborationGatewayError("invalid_input");
  }
}

function validateScope(scope: WorkspaceScope, documentId: string) {
  validateIdentifier(scope.workspaceId);
  validateIdentifier(documentId);
}

function validateContextAndCommand(
  context: RequestContext,
  command: CollaborationCommandIdentity,
) {
  validateScope({ workspaceId: context.workspaceId }, command.documentId);
  validateIdentifier(context.principalId);
  validateIdentifier(context.requestId);
  validateIdentifier(command.commandId);
  if (!Number.isSafeInteger(command.generation) || command.generation < 1) {
    throw new CollaborationGatewayError("invalid_input");
  }
}

function validateIdentifier(value: unknown) {
  if (
    typeof value !== "string"
    || Buffer.byteLength(value, "utf8") < 1
    || Buffer.byteLength(value, "utf8") > MAX_IDENTIFIER_BYTES
    || /^[\t\n\v\f\r\u00a0 ]|[\t\n\v\f\r\u00a0 ]$/.test(value)
    || /[\u0000-\u001f\u007f-\u009f]/.test(value)
  ) {
    throw new CollaborationGatewayError("invalid_input");
  }
}
