import "server-only";

import { and, eq } from "drizzle-orm";

import { db } from "@/db/client";
import { collaborationDocuments } from "@/db/schema";
import type { RequestContext, WorkspaceScope } from "@/features/auth/request-context";

import { createCollaborationRoomName } from "./room-name";

type CollaborationIdentity = {
  documentId: string;
  generation: number;
  schemaFingerprint: string;
};

export type CollaborationClientConfiguration =
  | { kind: "legacy" }
  | {
      documentId: string;
      kind: "collaboration";
      room: string;
      schemaFingerprint: string;
      /** Null keeps the canonical Yjs document read-only when runtime routing is unavailable. */
      websocketUrl: string | null;
    };

export type CollaborationClientConfigurationDependencies = {
  loadIdentity(scope: WorkspaceScope, documentId: string): Promise<CollaborationIdentity | null>;
};

type CollaborationClientEnvironment = {
  COLLABORATION_MODE?: string;
  COLLABORATION_WEBSOCKET_URL?: string;
};

const defaultDependencies: CollaborationClientConfigurationDependencies = {
  async loadIdentity(scope, documentId) {
    const [identity] = await db
      .select({
        documentId: collaborationDocuments.documentId,
        generation: collaborationDocuments.generation,
        schemaFingerprint: collaborationDocuments.schemaFingerprint,
      })
      .from(collaborationDocuments)
      .where(and(
        eq(collaborationDocuments.workspaceId, scope.workspaceId),
        eq(collaborationDocuments.documentId, documentId),
        eq(collaborationDocuments.isCurrent, true),
      ))
      .limit(1);
    return identity ?? null;
  },
};

export async function resolveCollaborationClientConfiguration(
  context: RequestContext,
  documentId: string,
  env: CollaborationClientEnvironment = process.env as CollaborationClientEnvironment,
  dependencies: CollaborationClientConfigurationDependencies = defaultDependencies,
): Promise<CollaborationClientConfiguration> {
  const mode = env.COLLABORATION_MODE || "disabled";
  if (mode === "disabled") return { kind: "legacy" };
  if (mode !== "self-hosted") throw new CollaborationClientConfigurationError();

  const identity = await dependencies.loadIdentity(
    { workspaceId: context.workspaceId },
    documentId,
  );
  if (!identity) return { kind: "legacy" };

  return {
    documentId,
    kind: "collaboration",
    room: createCollaborationRoomName({
      documentId,
      generation: identity.generation,
      workspaceId: context.workspaceId,
    }),
    schemaFingerprint: identity.schemaFingerprint,
    websocketUrl: parsePublicWebsocketUrl(env.COLLABORATION_WEBSOCKET_URL),
  };
}

class CollaborationClientConfigurationError extends Error {
  override readonly name = "CollaborationClientConfigurationError";

  constructor() {
    super("Collaboration client configuration is invalid");
  }
}

function parsePublicWebsocketUrl(value: string | undefined) {
  if (
    !value
    || value !== value.trim()
    || /[\u0000-\u001f\u007f-\u009f]/.test(value)
    || value.length > 2_048
  ) {
    return null;
  }

  try {
    const url = new URL(value);
    if (
      (url.protocol !== "ws:" && url.protocol !== "wss:")
      || url.username !== ""
      || url.password !== ""
      || url.pathname !== "/"
      || url.search !== ""
      || url.hash !== ""
      || url.hostname === ""
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}
