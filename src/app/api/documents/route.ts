import { NextResponse } from "next/server";
import { z } from "zod";
import {
  createDocumentDraft,
  createDocumentFromDraft,
  listDocuments,
} from "@/features/documents/document-repository";
import { documentReadinessValues } from "@/features/documents/document-metadata";
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

const optionsHandler = createProtectedOptionsHandler(["GET", "POST"]);
const getHandler = createProtectedRouteHandler(async (context) => {
  const documents = await listDocuments(context);
  return NextResponse.json({ documents });
});

const postHandler = createProtectedRouteHandler(async (context, request: Request) => {
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
  const document = body.contentJson
    ? await createDocumentFromDraft(context, {
        title: body.title,
        contentJson: body.contentJson,
        metadataJson: body.metadataJson ?? {},
        readiness: body.readiness ?? "draft",
      })
    : await createDocumentDraft(context, body.title);
  return NextResponse.json({ document }, { status: 201 });
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
