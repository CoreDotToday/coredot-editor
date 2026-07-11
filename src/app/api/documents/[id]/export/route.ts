import { NextResponse } from "next/server";
import { z } from "zod";
import { getDocumentById } from "@/features/documents/document-repository";
import { tiptapJsonToDocxBuffer } from "@/features/documents/docx-conversion";
import { createProtectedOptionsHandler, createProtectedRouteHandler } from "@/features/auth/route-context";
import { enforceRequestBudget } from "@/features/security/request-budget";
import {
  documentResourceLimitResponse,
  requestExceedsDocumentBodyLimit,
  resourcePolicyErrorResponse,
  validateTiptapResource,
  withOperationTimeout,
} from "@/features/security/resource-policy";

export const runtime = "nodejs";

const DOCX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const optionsHandler = createProtectedOptionsHandler(["POST"]);

const exportDocumentSchema = z.object({
  title: z.string().trim().min(1).max(500),
  contentJson: z.object({
    type: z.literal("doc"),
    content: z.array(z.unknown()).optional(),
  }),
});

type Params = {
  params: Promise<{ id: string }>;
};

const postHandler = createProtectedRouteHandler(async (context, request: Request, { params }: Params) => {
  if (requestExceedsDocumentBodyLimit(request)) return documentResourceLimitResponse();

  const { id } = await params;
  const document = await getDocumentById(context, id);
  if (!document) {
    return NextResponse.json({ error: "Document not found" }, { status: 404 });
  }

  const result = exportDocumentSchema.safeParse(await request.json().catch(() => null));
  if (!result.success) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (!validateTiptapResource(result.data.contentJson).ok) {
    return documentResourceLimitResponse();
  }

  let buffer: Buffer;
  try {
    buffer = await withOperationTimeout(() => tiptapJsonToDocxBuffer(result.data.contentJson, result.data.title));
  } catch (error) {
    return resourcePolicyErrorResponse(error) ?? NextResponse.json({ error: "DOCX export failed" }, { status: 500 });
  }
  return new Response(new Uint8Array(buffer), {
    headers: {
      "Content-Disposition": `attachment; filename="${sanitizeFileName(result.data.title)}.docx"`,
      "Content-Type": DOCX_MIME_TYPE,
    },
  });
}, { beforeWorkspaceBootstrap: (context) => enforceRequestBudget(context, "documents.export") });

export async function POST(request: Request, params: Params) {
  return postHandler(request, params);
}

export async function OPTIONS() {
  return optionsHandler();
}

function sanitizeFileName(value: string) {
  return value.replace(/[\\/:*?"<>|]/g, "").trim() || "document";
}
