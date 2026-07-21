import { and, eq, sql } from "drizzle-orm";

import {
  collaborationAuthorizationEpochs,
  collaborationDocuments,
  documents,
} from "@/db/schema";
import type { WorkspaceScope } from "@/features/auth/request-context";

import {
  createCollaborationRepository,
  type CollaborationDatabase,
  type CollaborationTransaction,
} from "./repository";

const MAX_KEY_BYTES = 256;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
const BOUNDARY_WHITESPACE = /^[\t\n\v\f\r\u00a0 ]|[\t\n\v\f\r\u00a0 ]$/;
let authorizationWriteTail: Promise<void> = Promise.resolve();

export class CollaborationAuthorizationRepositoryError extends Error {
  override readonly name = "CollaborationAuthorizationRepositoryError";

  constructor(readonly category: "invalid_input" | "unavailable") {
    super(category === "invalid_input"
      ? "Collaboration authorization input is invalid"
      : "Collaboration authorization storage is unavailable");
  }
}

export function createCollaborationAuthorizationRepository(database: CollaborationDatabase) {
  const repository = createCollaborationRepository(database);

  const readCapabilityAuthorityInTransaction = (
    transaction: CollaborationTransaction,
    scope: WorkspaceScope,
    input: { documentId: string; principalId: string },
  ) => execute(async () => {
    validateKey(scope.workspaceId);
    validateKey(input.documentId);
    validateKey(input.principalId);
    const [row] = await transaction
      .select({
        authorizationEpoch: sql<number>`coalesce(${collaborationAuthorizationEpochs.epoch}, 0)`,
        generation: collaborationDocuments.generation,
      })
      .from(documents)
      .innerJoin(
        collaborationDocuments,
        and(
          eq(collaborationDocuments.workspaceId, documents.workspaceId),
          eq(collaborationDocuments.documentId, documents.id),
          eq(collaborationDocuments.isCurrent, true),
        ),
      )
      .leftJoin(
        collaborationAuthorizationEpochs,
        and(
          eq(collaborationAuthorizationEpochs.workspaceId, documents.workspaceId),
          eq(collaborationAuthorizationEpochs.principalId, input.principalId),
        ),
      )
      .where(and(
        eq(documents.workspaceId, scope.workspaceId),
        eq(documents.id, input.documentId),
        eq(documents.status, "draft"),
      ))
      .limit(1);
    return row
      ? {
          authorizationEpoch: Number(row.authorizationEpoch),
          generation: row.generation,
        }
      : null;
  });

  return {
    readCapabilityAuthority(
      scope: WorkspaceScope,
      input: { documentId: string; principalId: string },
    ) {
      return execute(() => repository.read((transaction) => readCapabilityAuthorityInTransaction(
        transaction,
        scope,
        input,
      )));
    },

    readCapabilityAuthorityInTransaction,

    readEpoch(scope: WorkspaceScope, principalId: string) {
      return execute(async () => {
        validateKey(scope.workspaceId);
        validateKey(principalId);
        return repository.read(async (transaction) => {
          const [row] = await transaction
            .select({ epoch: collaborationAuthorizationEpochs.epoch })
            .from(collaborationAuthorizationEpochs)
            .where(and(
              eq(collaborationAuthorizationEpochs.workspaceId, scope.workspaceId),
              eq(collaborationAuthorizationEpochs.principalId, principalId),
            ))
            .limit(1);
          return row?.epoch ?? 0;
        });
      });
    },

    bumpEpoch(scope: WorkspaceScope, principalId: string) {
      return execute(async () => {
        validateKey(scope.workspaceId);
        validateKey(principalId);
        return withSerializedAuthorizationWrite(() => repository.write(async (transaction) => {
          const timestamp = new Date();
          const [row] = await transaction
            .insert(collaborationAuthorizationEpochs)
            .values({
              epoch: 1,
              principalId,
              updatedAt: timestamp,
              workspaceId: scope.workspaceId,
            })
            .onConflictDoUpdate({
              target: [
                collaborationAuthorizationEpochs.workspaceId,
                collaborationAuthorizationEpochs.principalId,
              ],
              set: {
                epoch: sql`${collaborationAuthorizationEpochs.epoch} + 1`,
                updatedAt: timestamp,
              },
            })
            .returning({ epoch: collaborationAuthorizationEpochs.epoch });
          if (!row || !Number.isSafeInteger(row.epoch) || row.epoch < 1) {
            throw new CollaborationAuthorizationRepositoryError("unavailable");
          }
          return row.epoch;
        }));
      });
    },
  };
}

async function withSerializedAuthorizationWrite<T>(operation: () => Promise<T>) {
  const previous = authorizationWriteTail;
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current, () => current);
  authorizationWriteTail = tail;
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (authorizationWriteTail === tail) authorizationWriteTail = Promise.resolve();
  }
}

function validateKey(value: unknown): asserts value is string {
  if (
    typeof value !== "string"
    || Buffer.byteLength(value, "utf8") < 1
    || Buffer.byteLength(value, "utf8") > MAX_KEY_BYTES
    || CONTROL_CHARACTERS.test(value)
    || BOUNDARY_WHITESPACE.test(value)
  ) {
    throw new CollaborationAuthorizationRepositoryError("invalid_input");
  }
}

async function execute<T>(operation: () => Promise<T>) {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof CollaborationAuthorizationRepositoryError) throw error;
    throw new CollaborationAuthorizationRepositoryError("unavailable");
  }
}
