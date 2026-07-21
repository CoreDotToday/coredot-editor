import { randomUUID } from "node:crypto";

import { db } from "@/db/client";
import type { RequestContext, WorkspaceScope } from "@/features/auth/request-context";

import { createCollaborationAuthorizationRepository } from "./authorization-repository";
import {
  CollaborationCapabilityConfigurationError,
  CollaborationCapabilityError,
  createCollaborationCapabilityAuthority,
  readCollaborationCapabilitySigningKeyRing,
  type CollaborationCapabilityBindings,
} from "./capability";
import {
  CollaborationPersistenceError,
  createCollaborationPersistence,
  type CollaborationPersistence,
} from "./persistence";
import { createCollaborationRoomName } from "./room-name";

type CapabilityAuthoritySnapshot = {
  authorizationEpoch: number;
  generation: number;
};

type CapabilityServiceDependencies = {
  generateSessionId?: () => string;
  prepareIssue: () => Promise<(claims: CollaborationCapabilityBindings) => Promise<string>>;
  withAuthority: (
    scope: WorkspaceScope,
    input: { documentId: string; principalId: string },
    operation: (
      current: CapabilityAuthoritySnapshot,
    ) => Promise<CollaborationCapabilityIssueResult>,
  ) => Promise<CollaborationCapabilityIssueResult | null>;
};

export type CollaborationCapabilityIssueResult = {
  expiresInSeconds: 60;
  room: string;
  token: string;
};

export class CollaborationCapabilityServiceError extends Error {
  override readonly name = "CollaborationCapabilityServiceError";

  constructor(readonly category: "invalid_request" | "not_found" | "unavailable") {
    super({
      invalid_request: "Collaboration capability request is invalid",
      not_found: "Collaboration document was not found",
      unavailable: "Collaboration capability service is unavailable",
    }[category]);
  }
}

export function createCollaborationCapabilityService(
  dependencies: CapabilityServiceDependencies,
) {
  const generateSessionId = dependencies.generateSessionId ?? randomUUID;
  return {
    async issue(
      context: RequestContext,
      input: { documentId: string },
    ): Promise<CollaborationCapabilityIssueResult> {
      try {
        validateIdentifier(input.documentId, 256);
        validateIdentifier(context.workspaceId, 256);
        validateIdentifier(context.principalId, 256);
        const preparedIssue = await dependencies.prepareIssue();
        const sessionId = generateSessionId();
        validateIdentifier(sessionId, 128);
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId)) {
          throw new InvalidCapabilityServiceInputError();
        }
        const result = await dependencies.withAuthority(
          { workspaceId: context.workspaceId },
          { documentId: input.documentId, principalId: context.principalId },
          async (current) => {
            const room = createCollaborationRoomName({
              documentId: input.documentId,
              generation: current.generation,
              workspaceId: context.workspaceId,
            });
            const token = await preparedIssue({
              authorizationEpoch: current.authorizationEpoch,
              documentId: input.documentId,
              permission: "write",
              principalId: context.principalId,
              room,
              sessionId,
              workspaceId: context.workspaceId,
            });
            return { expiresInSeconds: 60, room, token };
          },
        );
        if (!result) throw new CollaborationCapabilityServiceError("not_found");
        return result;
      } catch (error) {
        if (error instanceof CollaborationCapabilityServiceError) throw error;
        if (
          error instanceof CollaborationPersistenceError
          && error.category === "not_found"
        ) {
          throw new CollaborationCapabilityServiceError("not_found");
        }
        if (
          error instanceof CollaborationCapabilityConfigurationError
          || error instanceof CollaborationCapabilityError
        ) {
          throw new CollaborationCapabilityServiceError("unavailable");
        }
        if (error instanceof InvalidCapabilityServiceInputError) {
          throw new CollaborationCapabilityServiceError("invalid_request");
        }
        throw new CollaborationCapabilityServiceError("unavailable");
      }
    },
  };
}

type CapabilityPersistenceTransaction = Pick<CollaborationPersistence, "withInitializedWrite">;
type CapabilityAuthorizationTransaction = {
  readCapabilityAuthorityInTransaction: ReturnType<
    typeof createCollaborationAuthorizationRepository
  >["readCapabilityAuthorityInTransaction"];
};

export function createCollaborationCapabilityAuthorityTransaction(
  persistence: CapabilityPersistenceTransaction,
  authorization: CapabilityAuthorizationTransaction,
): CapabilityServiceDependencies["withAuthority"] {
  return (scope, input, operation) => persistence.withInitializedWrite(
    scope,
    input.documentId,
    async (transaction) => {
      const current = await authorization.readCapabilityAuthorityInTransaction(
        transaction,
        scope,
        input,
      );
      if (!current) throw new CollaborationPersistenceError("not_found", false);
      return operation(current);
    },
  );
}

class InvalidCapabilityServiceInputError extends Error {}

function validateIdentifier(value: unknown, maximumBytes: number): asserts value is string {
  if (
    typeof value !== "string"
    || Buffer.byteLength(value, "utf8") < 1
    || Buffer.byteLength(value, "utf8") > maximumBytes
    || /^[\t\n\v\f\r\u00a0 ]|[\t\n\v\f\r\u00a0 ]$/.test(value)
    || /[\u0000-\u001f\u007f-\u009f]/.test(value)
  ) {
    throw new InvalidCapabilityServiceInputError();
  }
}

const persistence = createCollaborationPersistence(db);
const authorizationRepository = createCollaborationAuthorizationRepository(db);
const defaultService = createCollaborationCapabilityService({
  prepareIssue: () => createCollaborationCapabilityAuthority({
    signingKeyRing: readCollaborationCapabilitySigningKeyRing(),
  }).prepareSigner(),
  withAuthority: createCollaborationCapabilityAuthorityTransaction(
    persistence,
    authorizationRepository,
  ),
});

export const issueCollaborationCapabilityForDocument = defaultService.issue;
