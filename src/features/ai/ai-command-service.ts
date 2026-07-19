import { createHash } from "node:crypto";
import type { DocumentRecord, PromptTemplateRecord } from "@/db/schema";
import { COLLABORATION_STORAGE_LIMITS } from "@/db/schema";
import * as Y from "yjs";
import type { CollaborationDocumentCodec } from "@/features/collaboration/contracts";
import {
  createCollaborativeProposalAnchor,
  findUniqueCollaborativeTextRange,
  type CollaborativeProposalAnchor,
} from "@/features/collaboration/proposal-command";
import { hashCanonicalMaterialization } from "@/features/collaboration/exact-document-materialization";
import {
  CollaborationPersistenceError,
  type CollaborationSnapshot,
} from "@/features/collaboration/persistence";
import { getDocumentById } from "@/features/documents/document-repository";
import type { WorkspaceScope } from "@/features/auth/request-context";
import { getPromptTemplateById } from "@/features/templates/template-repository";
import { validateTemplateVariables } from "@/features/templates/template-validation";
import { getAiSettings, type AiSettings } from "./ai-settings-repository";
import { hydrateAiReferenceDocuments, type HydratedAiReferenceDocument } from "./reference-hydration";
import { createAiProvider, type AiProvider } from "./providers";
import type { AiCommandPayload } from "./types";
import { aiCollaborationCodec, loadAiCollaborationSnapshot } from "./ai-collaboration-snapshot";

export type PreparedAiCollaborationSnapshot = {
  checkpoint: Uint8Array;
  contentHash: string;
  generation: number;
  headSeq: number;
  schemaFingerprint: string;
  schemaVersion: number;
  stateVector: Uint8Array;
};

export function createAiCollaborativeProposalAnchor(
  snapshot: PreparedAiCollaborationSnapshot,
  input: { range?: { from: number; to: number }; targetText: string },
): CollaborativeProposalAnchor {
  const document = collaborationCodec.loadCheckpoint(snapshot.checkpoint);
  try {
    const range = input.range ?? findUniqueCollaborativeTextRange(document, input.targetText);
    if (!range) throw new Error("Collaborative AI proposal target is not unique");
    const anchor = createCollaborativeProposalAnchor(document, {
      baseHeadSeq: snapshot.headSeq,
      generation: snapshot.generation,
      range,
      schemaFingerprint: snapshot.schemaFingerprint,
    });
    if (anchor.targetHash !== sha256(input.targetText)) {
      throw new Error("Collaborative AI proposal target does not match its exact snapshot");
    }
    return anchor;
  } finally {
    document.destroy();
  }
}

export type PreparedAiCommandRequest = {
  aiSettings: AiSettings;
  document: DocumentRecord;
  provider: AiProvider;
  referencedDocuments: HydratedAiReferenceDocument[];
  reviewedText: string;
  template: PromptTemplateRecord;
  collaborationSnapshot?: PreparedAiCollaborationSnapshot;
};

export type AiCommandRequestFailure = {
  code?: string;
  details?: unknown;
  error: string;
  ok: false;
  status: 400 | 404 | 409 | 500 | 503;
};

export type AiCommandRequestResult =
  | ({ ok: true } & PreparedAiCommandRequest)
  | AiCommandRequestFailure;

export type PreparedAiCommandContext = Omit<PreparedAiCommandRequest, "aiSettings" | "provider">;

export type AiCommandContextResult =
  | ({ ok: true } & PreparedAiCommandContext)
  | AiCommandRequestFailure;

export type AiProviderCreationResult =
  | { aiSettings: AiSettings; ok: true; provider: AiProvider }
  | AiCommandRequestFailure;

export type AiCommandServiceDependencies = {
  collaborationCodec: Pick<
    CollaborationDocumentCodec,
    "encodeCheckpoint" | "materialize"
  >;
  createAiProvider: typeof createAiProvider;
  getAiSettings: typeof getAiSettings;
  getDocumentById: typeof getDocumentById;
  getPromptTemplateById: typeof getPromptTemplateById;
  hydrateAiReferenceDocuments: typeof hydrateAiReferenceDocuments;
  loadCollaborationSnapshot(
    scope: WorkspaceScope,
    documentId: string,
  ): Promise<CollaborationSnapshot | null>;
};

const collaborationCodec = aiCollaborationCodec;
const defaultDependencies: AiCommandServiceDependencies = {
  collaborationCodec,
  createAiProvider,
  getAiSettings,
  getDocumentById,
  getPromptTemplateById,
  hydrateAiReferenceDocuments,
  loadCollaborationSnapshot: loadAiCollaborationSnapshot,
};

export async function createAiProviderForCommand(
  scope: WorkspaceScope,
  {
    dependencies = defaultDependencies,
  }: {
    dependencies?: Pick<AiCommandServiceDependencies, "createAiProvider" | "getAiSettings">;
  } = {},
): Promise<AiProviderCreationResult> {
  try {
    const aiSettings = await dependencies.getAiSettings(scope);
    return { aiSettings, ok: true, provider: dependencies.createAiProvider(aiSettings) };
  } catch {
    return { error: "AI generation failed", ok: false, status: 500 };
  }
}

export async function prepareAiCommandRequest(scope: WorkspaceScope, {
  dependencies,
  deferProviderCreation,
  payload,
  useSubmittedDocumentText,
}: {
  dependencies?: AiCommandServiceDependencies;
  deferProviderCreation: true;
  payload: AiCommandPayload;
  useSubmittedDocumentText?: boolean;
}): Promise<AiCommandContextResult>;

export async function prepareAiCommandRequest(scope: WorkspaceScope, {
  dependencies,
  deferProviderCreation,
  payload,
  useSubmittedDocumentText,
}: {
  dependencies?: AiCommandServiceDependencies;
  deferProviderCreation?: false;
  payload: AiCommandPayload;
  useSubmittedDocumentText?: boolean;
}): Promise<AiCommandRequestResult>;

export async function prepareAiCommandRequest(scope: WorkspaceScope, {
  dependencies = defaultDependencies,
  deferProviderCreation = false,
  payload,
  useSubmittedDocumentText = false,
}: {
  dependencies?: AiCommandServiceDependencies;
  deferProviderCreation?: boolean;
  payload: AiCommandPayload;
  useSubmittedDocumentText?: boolean;
}): Promise<AiCommandRequestResult | AiCommandContextResult> {
  const document = await dependencies.getDocumentById(scope, payload.documentId);
  if (!document) {
    return { error: "Document not found", ok: false, status: 404 };
  }

  const template = await dependencies.getPromptTemplateById(scope, payload.templateId);
  if (!template?.isActive) {
    return { error: "Template not found", ok: false, status: 404 };
  }

  let collaborationSnapshot: CollaborationSnapshot | null;
  try {
    collaborationSnapshot = await dependencies.loadCollaborationSnapshot(scope, document.id);
  } catch (error) {
    return collaborationLoadFailure(error);
  }

  let exactDocument = document;
  let preparedCollaborationSnapshot: PreparedAiCollaborationSnapshot | undefined;
  if (collaborationSnapshot) {
    try {
      if (!isCompatibleBarrier(payload, collaborationSnapshot)) {
        return {
          code: "collaboration_snapshot_conflict",
          error: "Collaboration snapshot is not available for this request",
          ok: false,
          status: 409,
        };
      }
      const materialization = dependencies.collaborationCodec.materialize(
        collaborationSnapshot.document,
      );
      const stateVector = Y.encodeStateVector(collaborationSnapshot.document);
      preparedCollaborationSnapshot = {
        checkpoint: dependencies.collaborationCodec.encodeCheckpoint(collaborationSnapshot.document),
        contentHash: hashCanonicalMaterialization(materialization),
        generation: collaborationSnapshot.generation,
        headSeq: collaborationSnapshot.headSeq,
        schemaFingerprint: collaborationSnapshot.schemaFingerprint,
        schemaVersion: collaborationSnapshot.schemaVersion,
        stateVector,
      };
      exactDocument = {
        ...document,
        contentJson: materialization.contentJson,
        metadataJson: materialization.metadataJson,
        plainText: materialization.plainText,
        title: materialization.title,
      };
    } catch {
      return {
        code: "collaboration_snapshot_conflict",
        error: "Collaboration snapshot is not available for this request",
        ok: false,
        status: 409,
      };
    } finally {
      collaborationSnapshot.document.destroy();
    }
  } else if (payload.collaborationBarrier) {
    return {
      code: "collaboration_snapshot_conflict",
      error: "Collaboration snapshot is not available for this request",
      ok: false,
      status: 409,
    };
  }

  const variableValidation = validateTemplateVariables(template.variableSchemaJson, payload.variables);
  if (!variableValidation.ok) {
    return {
      details: variableValidation.errors,
      error: "Invalid template variables",
      ok: false,
      status: 400,
    };
  }

  const referencedDocuments = await dependencies.hydrateAiReferenceDocuments(
    scope,
    payload.references,
    { currentDocumentId: document.id },
  );

  const preparedContext = {
    ...(preparedCollaborationSnapshot
      ? { collaborationSnapshot: preparedCollaborationSnapshot }
      : {}),
    document: exactDocument,
    ok: true,
    referencedDocuments,
    reviewedText: preparedCollaborationSnapshot
      ? exactDocument.plainText
      : useSubmittedDocumentText ? payload.documentText : exactDocument.plainText,
    template,
  } satisfies { ok: true } & PreparedAiCommandContext;

  if (deferProviderCreation) {
    return preparedContext;
  }

  const providerResult = await createAiProviderForCommand(scope, { dependencies });
  if (!providerResult.ok) {
    return providerResult;
  }

  return {
    ...preparedContext,
    aiSettings: providerResult.aiSettings,
    provider: providerResult.provider,
  };
}

function isCompatibleBarrier(payload: AiCommandPayload, snapshot: CollaborationSnapshot) {
  const barrier = payload.collaborationBarrier;
  if (!barrier || barrier.generation !== snapshot.generation) return false;
  let encoded: Uint8Array;
  let clientVector: Map<number, number>;
  let serverVector: Map<number, number>;
  try {
    const buffer = Buffer.from(barrier.stateVector, "base64url");
    if (
      buffer.byteLength < 1
      || buffer.byteLength > COLLABORATION_STORAGE_LIMITS.stateVectorBytes
      || buffer.toString("base64url") !== barrier.stateVector
    ) {
      return false;
    }
    encoded = new Uint8Array(buffer);
    clientVector = Y.decodeStateVector(encoded);
    serverVector = Y.decodeStateVector(Y.encodeStateVector(snapshot.document));
  } catch {
    return false;
  }
  return [...clientVector].every(([clientId, clock]) =>
    Number.isSafeInteger(clock) && clock >= 0 && clock <= (serverVector.get(clientId) ?? 0));
}

function collaborationLoadFailure(error: unknown): AiCommandRequestFailure {
  if (error instanceof CollaborationPersistenceError && !error.retryable) {
    return {
      code: "collaboration_snapshot_conflict",
      error: "Collaboration snapshot is not available for this request",
      ok: false,
      status: 409,
    };
  }
  return {
    code: "collaboration_snapshot_unavailable",
    error: "Collaboration snapshot is temporarily unavailable",
    ok: false,
    status: 503,
  };
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
