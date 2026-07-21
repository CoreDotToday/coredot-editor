import { NextResponse } from "next/server";
import { z } from "zod";
import {
  createDocumentDraft,
  createDocumentFromDraft,
  createDocumentFromDraftIdempotently,
  emptyDocument,
  listDocumentSummaries,
} from "@/features/documents/document-repository";
import { toPublicDocument } from "@/features/documents/document-public";
import { createProtectedOptionsHandler, createProtectedRouteHandler } from "@/features/auth/route-context";
import { enforceRequestBudget } from "@/features/security/request-budget";
import { resolveActiveProjectProfile } from "@/features/projects/active-project-profile";
import { validateProjectDocumentState } from "@/features/projects/project-profile";
import {
  InvalidDocumentSummaryFilterError,
  parseDocumentSummaryFilters,
} from "@/features/documents/document-filters";
import { InvalidCollectionCursorError } from "@/features/pagination/collection-cursor";
import {
  documentResourceLimitResponse,
  parseBoundedJson,
  resourcePolicyErrorResponse,
  validateTiptapResource,
} from "@/features/security/resource-policy";

const createDocumentSchema = z.object({
  title: z.string().trim().min(1).max(500).default("Untitled document"),
  contentJson: z.object({
    type: z.literal("doc"),
    content: z.array(z.unknown()).optional(),
  }).optional(),
  metadataJson: z.record(
    z.string(),
    z.union([z.string(), z.number().finite(), z.boolean(), z.array(z.string()), z.null()]),
  ).optional(),
}).strict();
const documentCreationKeySchema = z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$/);

const optionsHandler = createProtectedOptionsHandler(["GET", "POST"]);
const getHandler = createProtectedRouteHandler(async (context, request: Request) => {
  const url = new URL(request.url);
  const limitValue = url.searchParams.get("limit");
  const limit = limitValue === null ? 20 : Number(limitValue);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    return NextResponse.json({ error: "Invalid collection query" }, { status: 400 });
  }
  try {
    const filters = parseDocumentSummaryFilters(resolveActiveProjectProfile(), {
      metadataKey: url.searchParams.get("metadataKey") ?? undefined,
      metadataValue: url.searchParams.get("metadataValue") ?? undefined,
      query: url.searchParams.get("query") ?? undefined,
      readiness: url.searchParams.get("readiness") ?? undefined,
    });
    const page = await listDocumentSummaries(context, {
      ...filters,
      cursor: url.searchParams.get("cursor") ?? undefined,
      limit,
    });
    return NextResponse.json({ documents: page.items, nextCursor: page.nextCursor });
  } catch (error) {
    if (error instanceof InvalidCollectionCursorError || error instanceof InvalidDocumentSummaryFilterError) {
      return NextResponse.json({
        error: error instanceof InvalidCollectionCursorError
          ? "Invalid collection cursor"
          : "Invalid document filter",
      }, { status: 400 });
    }
    throw error;
  }
});

const postHandler = createProtectedRouteHandler(async (context, request: Request) => {
  const creationKeyHeader = request.headers.get("Idempotency-Key");
  const creationKeyResult = creationKeyHeader === null
    ? { data: null, success: true as const }
    : documentCreationKeySchema.safeParse(creationKeyHeader);
  if (!creationKeyResult.success) {
    return NextResponse.json({ error: "Invalid Idempotency-Key header" }, { status: 400 });
  }

  let payload: unknown;
  try {
    payload = await parseBoundedJson(request);
  } catch (error) {
    const resourceResponse = resourcePolicyErrorResponse(error);
    if (resourceResponse) return resourceResponse;
    payload = null;
  }
  const result = createDocumentSchema.safeParse(payload);
  if (!result.success) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const body = result.data;
  if (body.contentJson && !validateTiptapResource(body.contentJson).ok) {
    return documentResourceLimitResponse();
  }
  if (creationKeyResult.data && !body.contentJson) {
    return NextResponse.json({ error: "Idempotent creation requires a full document draft" }, { status: 400 });
  }
  const projectProfile = resolveActiveProjectProfile();
  const projectState = validateProjectDocumentState(projectProfile, {
    metadataJson: body.metadataJson ?? {},
    readiness: projectProfile.readiness[0]!.id,
  });
  if (!projectState.ok) {
    return NextResponse.json({
      error: "Document violates active Project Profile",
      reason: "invalid_project_profile",
      violation: projectState.violation,
    }, { status: 400 });
  }
  if (body.contentJson && creationKeyResult.data) {
    const creation = await createDocumentFromDraftIdempotently(context, {
      title: body.title,
      contentJson: body.contentJson,
      metadataJson: projectState.value.metadataJson,
    }, creationKeyResult.data);
    return NextResponse.json({
      document: toPublicDocument(creation.document),
      replayed: creation.replayed,
    }, { status: creation.replayed ? 200 : 201 });
  }
  const hasDraftState = body.contentJson !== undefined || body.metadataJson !== undefined;
  const document = hasDraftState
    ? await createDocumentFromDraft(context, {
        title: body.title,
        contentJson: body.contentJson ?? emptyDocument,
        metadataJson: projectState.value.metadataJson,
      })
    : await createDocumentDraft(context, body.title);
  return NextResponse.json({ document: toPublicDocument(document) }, { status: 201 });
}, { beforeWorkspaceBootstrap: (context) => enforceRequestBudget(context, "documents.create") });

export async function GET(request: Request) {
  return getHandler(request);
}

export async function POST(request: Request) {
  return postHandler(request);
}

export async function OPTIONS() {
  return optionsHandler();
}
