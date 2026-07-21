import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { createCollaborationDocumentCodec } from "@/features/collaboration/document-codec";
import { hashCanonicalMaterialization } from "@/features/collaboration/exact-document-materialization";
import { getProjectProfile } from "@/features/projects/default-project-profiles";
import { prepareAiCommandRequest } from "./ai-command-service";
import type { AiCommandServiceDependencies } from "./ai-command-service";
import type { AiCommandPayload } from "./types";

const workspaceA = { workspaceId: "workspace_a" };
const workspaceB = { workspaceId: "workspace_b" };
const collaborationCodec = createCollaborationDocumentCodec(getProjectProfile("default"));

const basePayload: AiCommandPayload = {
  afterContext: "",
  beforeContext: "",
  command: "Review",
  documentId: "doc_1",
  documentText: "",
  references: {
    documents: [{ documentId: "doc_ref", titleSnapshot: "Browser title" }],
  },
  selectedText: "",
  templateId: "template_1",
  variables: { audience: "executive" },
};

function createDependencies(overrides: Partial<AiCommandServiceDependencies> = {}) {
  const dependencies: AiCommandServiceDependencies = {
    createAiProvider: vi.fn(() => ({
      capabilities: {
        coreTodayProxy: false,
        reasoningEffort: false,
        streaming: "buffered" as const,
        structuredReview: true,
      },
      generateReview: vi.fn(),
      generateText: vi.fn(),
      model: "stub-editor",
      name: "stub" as const,
      streamText: vi.fn(),
    })),
    collaborationCodec,
    getAiSettings: vi.fn(async (scope) => ({
      aiBaseUrl: null,
      aiMaxCompletionTokens: null,
      aiModel: "stub-editor",
      aiProvider: "stub" as const,
      aiReasoningEffort: null,
      id: "default",
      workspaceId: scope.workspaceId,
    })),
    getDocumentById: vi.fn(async (scope) => ({
      contentJson: { type: "doc" as const },
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: "doc_1",
      workspaceId: scope.workspaceId,
      creationKey: null,
      metadataJson: {},
      plainText: "Persisted document text",
      readiness: "draft" as const,
      revision: 0,
      status: "draft" as const,
      title: "Draft",
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    })),
    getPromptTemplateById: vi.fn(async (scope) => ({
      category: "contract",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      description: "Template",
      id: "template_1",
      workspaceId: scope.workspaceId,
      builtinKey: null,
      isActive: true,
      isDefault: true,
      name: "Template",
      systemPrompt: "Review this.",
      updatedAt: new Date("2026-01-01T00:00:00Z"),
      variableSchemaJson: {
        fields: [{ label: "Audience", name: "audience", required: true, type: "text" as const }],
        required: ["audience"],
      },
    })),
    hydrateAiReferenceDocuments: vi.fn(async () => [
      {
        generation: null,
        id: "doc_ref",
        projectedSeq: null,
        text: "Server reference text",
        title: "Server title",
      },
    ]),
    loadCollaborationSnapshot: vi.fn(async () => null),
  };

  return {
    ...dependencies,
    ...overrides,
  };
}

describe("prepareAiCommandRequest", () => {
  it("prepares validated document, template, provider, reviewed text, and server-hydrated references", async () => {
    const dependencies = createDependencies();

    const result = await prepareAiCommandRequest(workspaceA, { dependencies, payload: basePayload });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.document.id).toBe("doc_1");
    expect(result.template.id).toBe("template_1");
    expect(result.provider.name).toBe("stub");
    expect(result.reviewedText).toBe("Persisted document text");
    expect(result.referencedDocuments).toEqual([
      {
        generation: null,
        id: "doc_ref",
        projectedSeq: null,
        text: "Server reference text",
        title: "Server title",
      },
    ]);
    expect(dependencies.getDocumentById).toHaveBeenCalledWith(workspaceA, "doc_1");
    expect(dependencies.getPromptTemplateById).toHaveBeenCalledWith(workspaceA, "template_1");
    expect(dependencies.getAiSettings).toHaveBeenCalledWith(workspaceA);
    expect(dependencies.hydrateAiReferenceDocuments).toHaveBeenCalledWith(
      workspaceA,
      basePayload.references,
      { currentDocumentId: "doc_1" },
    );
  });

  it("uses one exact durable collaborative snapshot for AI text and proposal anchoring", async () => {
    const materialization = {
      contentJson: {
        type: "doc" as const,
        content: [{ type: "paragraph", content: [{ type: "text", text: "Exact body" }] }],
      },
      metadataJson: { owner: "board" },
      plainText: "Exact body",
      title: "Exact title",
    };
    const durable = collaborationCodec.bootstrap(materialization);
    const checkpoint = collaborationCodec.encodeCheckpoint(durable);
    const stateVector = Y.encodeStateVector(durable);
    durable.destroy();
    const dependencies = createDependencies({
      loadCollaborationSnapshot: vi.fn(async () => ({
        checkpointSeq: 0,
        document: collaborationCodec.loadCheckpoint(checkpoint),
        documentId: "doc_1",
        generation: 3,
        headSeq: 7,
        projectedSeq: 5,
        schemaFingerprint: collaborationCodec.fingerprint(),
        schemaVersion: 1,
      })),
    });

    const result = await prepareAiCommandRequest(workspaceA, {
      deferProviderCreation: true,
      dependencies,
      payload: {
        ...basePayload,
        collaborationBarrier: {
          generation: 3,
          stateVector: Buffer.from(stateVector).toString("base64url"),
        },
        documentText: "Untrusted browser text",
      },
      useSubmittedDocumentText: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reviewedText).toBe("Exact body");
    expect(result.document).toMatchObject({
      contentJson: materialization.contentJson,
      metadataJson: materialization.metadataJson,
      plainText: materialization.plainText,
      title: materialization.title,
    });
    expect(result.collaborationSnapshot).toMatchObject({
      contentHash: hashCanonicalMaterialization(materialization),
      generation: 3,
      headSeq: 7,
      schemaFingerprint: collaborationCodec.fingerprint(),
      schemaVersion: 1,
      stateVector,
    });
    const restored = collaborationCodec.loadCheckpoint(result.collaborationSnapshot!.checkpoint);
    expect(collaborationCodec.materialize(restored)).toEqual(materialization);
    restored.destroy();
  });

  it("fails closed when initialized collaboration lacks an exact compatible browser barrier", async () => {
    const durable = collaborationCodec.bootstrap({
      contentJson: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Exact" }] }] },
      metadataJson: {},
      plainText: "Exact",
      title: "Exact",
    });
    const checkpoint = collaborationCodec.encodeCheckpoint(durable);
    durable.destroy();
    const dependencies = createDependencies({
      loadCollaborationSnapshot: vi.fn(async () => ({
        checkpointSeq: 0,
        document: collaborationCodec.loadCheckpoint(checkpoint),
        documentId: "doc_1",
        generation: 2,
        headSeq: 0,
        projectedSeq: 0,
        schemaFingerprint: collaborationCodec.fingerprint(),
        schemaVersion: 1,
      })),
    });

    await expect(prepareAiCommandRequest(workspaceA, {
      deferProviderCreation: true,
      dependencies,
      payload: basePayload,
    })).resolves.toMatchObject({ ok: false, status: 409 });
    await expect(prepareAiCommandRequest(workspaceA, {
      deferProviderCreation: true,
      dependencies,
      payload: {
        ...basePayload,
        collaborationBarrier: { generation: 1, stateVector: "AA" },
      },
    })).resolves.toMatchObject({ ok: false, status: 409 });
  });

  it("uses submitted document text for unsaved draft review payloads", async () => {
    const result = await prepareAiCommandRequest(workspaceA, {
      dependencies: createDependencies(),
      payload: {
        ...basePayload,
        documentText: "Unsaved browser draft text",
      },
      useSubmittedDocumentText: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.reviewedText).toBe("Unsaved browser draft text");
  });

  it("returns a typed validation failure before creating a provider", async () => {
    const dependencies = createDependencies();

    const result = await prepareAiCommandRequest(workspaceA, {
      dependencies,
      payload: {
        ...basePayload,
        variables: {},
      },
    });

    expect(result).toMatchObject({
      error: "Invalid template variables",
      ok: false,
      status: 400,
    });
    expect(dependencies.createAiProvider).not.toHaveBeenCalled();
  });

  it("normalizes provider configuration failures into a route-safe failure", async () => {
    const dependencies = createDependencies({
      createAiProvider: vi.fn(() => {
        throw new Error("missing key");
      }),
    });

    const result = await prepareAiCommandRequest(workspaceA, { dependencies, payload: basePayload });

    expect(result).toEqual({
      error: "AI generation failed",
      ok: false,
      status: 500,
    });
  });

  it("uses only the explicitly passed workspace for document, template, settings, and references", async () => {
    const dependencies = createDependencies();

    const result = await prepareAiCommandRequest(workspaceB, { dependencies, payload: basePayload });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.workspaceId).toBe(workspaceB.workspaceId);
    expect(result.template.workspaceId).toBe(workspaceB.workspaceId);
    expect(result.aiSettings.workspaceId).toBe(workspaceB.workspaceId);
    expect(dependencies.getDocumentById).not.toHaveBeenCalledWith({ workspaceId: "local" }, expect.anything());
    expect(dependencies.getAiSettings).not.toHaveBeenCalledWith({ workspaceId: "local" });
    expect(dependencies.hydrateAiReferenceDocuments).toHaveBeenCalledWith(
      workspaceB,
      basePayload.references,
      expect.anything(),
    );
  });
});
