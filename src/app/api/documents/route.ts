import { NextResponse } from "next/server";
import { z } from "zod";
import {
  createDocumentDraft,
  createDocumentFromDraft,
  createDocumentFromDraftIdempotently,
  listDocuments,
} from "@/features/documents/document-repository";
import { documentReadinessValues } from "@/features/documents/document-metadata";
import { toPublicDocument } from "@/features/documents/document-public";
import { createProtectedOptionsHandler, createProtectedRouteHandler } from "@/features/auth/route-context";
import { enforceRequestBudget } from "@/features/security/request-budget";
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
  readiness: z.enum(documentReadinessValues).optional(),
});
const documentCreationKeySchema = z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$/);

const optionsHandler = createProtectedOptionsHandler(["GET", "POST"]);
const getHandler = createProtectedRouteHandler(async (context) => {
  const documents = await listDocuments(context);
  return NextResponse.json({ documents: documents.map(toPublicDocument) });
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
  if (body.contentJson && creationKeyResult.data) {
    const creation = await createDocumentFromDraftIdempotently(context, {
      title: body.title,
      contentJson: body.contentJson,
      metadataJson: body.metadataJson ?? {},
      readiness: body.readiness ?? "draft",
    }, creationKeyResult.data);
    return NextResponse.json({
      document: toPublicDocument(creation.document),
      replayed: creation.replayed,
    }, { status: creation.replayed ? 200 : 201 });
  }
  const document = body.contentJson
    ? await createDocumentFromDraft(context, {
        title: body.title,
        contentJson: body.contentJson,
        metadataJson: body.metadataJson ?? {},
        readiness: body.readiness ?? "draft",
      })
    : await createDocumentDraft(context, body.title);
  return NextResponse.json({ document: toPublicDocument(document) }, { status: 201 });
}, { beforeWorkspaceBootstrap: (context) => enforceRequestBudget(context, "documents.create") });

export async function GET() {
  return getHandler();
}

export async function POST(request: Request) {
  return postHandler(request);
}

export async function OPTIONS() {
  return optionsHandler();
}
