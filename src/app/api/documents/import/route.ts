import { NextResponse } from "next/server";
import { z } from "zod";
import { createDocumentFromDraftIdempotently } from "@/features/documents/document-repository";
import { toPublicDocument } from "@/features/documents/document-public";
import { documentInterchange } from "@/features/documents/document-interchange";
import { createProtectedOptionsHandler, createProtectedRouteHandler } from "@/features/auth/route-context";
import { enforceRequestBudget } from "@/features/security/request-budget";
import {
  RESOURCE_LIMITS,
  documentResourceLimitResponse,
  parseBoundedFormData,
  parseBoundedJson,
  requestExceedsDocumentBodyLimit,
  resourcePolicyErrorResponse,
  validateTiptapResource,
} from "@/features/security/resource-policy";

export const runtime = "nodejs";

const DOCX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const MAX_MULTIPART_OVERHEAD_BYTES = 1024 * 1024;
const optionsHandler = createProtectedOptionsHandler(["POST"]);
const importCreationKeySchema = z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$/);
const confirmImportSchema = z.object({
  action: z.literal("confirm"),
  contentJson: z.object({
    type: z.literal("doc"),
    content: z.array(z.unknown()).optional(),
  }),
  title: z.string().trim().min(1).max(500),
});

const postHandler = createProtectedRouteHandler(async (context, request: Request) => {
  const deadline = Date.now() + RESOURCE_LIMITS.operationMs;
  if (request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    if (requestExceedsDocumentBodyLimit(request)) return documentResourceLimitResponse();
    let payload: unknown;
    try {
      payload = await parseBoundedJson(request, undefined, {
        deadlineMs: remainingDeadlineMs(deadline),
        requestSignal: request.signal,
      });
    } catch (error) {
      return resourcePolicyErrorResponse(error) ?? NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }
    const result = confirmImportSchema.safeParse(payload);
    const creationKey = importCreationKeySchema.safeParse(request.headers.get("Idempotency-Key"));
    if (!result.success || !creationKey.success) {
      return NextResponse.json({ error: "Invalid import confirmation" }, { status: 400 });
    }
    if (!validateTiptapResource(result.data.contentJson).ok) return documentResourceLimitResponse();
    const creation = await createDocumentFromDraftIdempotently(context, {
      contentJson: result.data.contentJson,
      metadataJson: {},
      readiness: "draft",
      title: result.data.title,
    }, creationKey.data);
    return NextResponse.json({
      document: toPublicDocument(creation.document),
      replayed: creation.replayed,
    }, { status: creation.replayed ? 200 : 201 });
  }

  const contentLength = Number(request.headers?.get("content-length"));
  if (
    Number.isFinite(contentLength) &&
    contentLength > RESOURCE_LIMITS.docxBytes + MAX_MULTIPART_OVERHEAD_BYTES
  ) {
    return payloadTooLargeResponse();
  }

  let formData: FormData | null = null;
  try {
    formData = await parseBoundedFormData(
      request,
      RESOURCE_LIMITS.docxBytes + MAX_MULTIPART_OVERHEAD_BYTES,
      { deadlineMs: remainingDeadlineMs(deadline), requestSignal: request.signal },
    );
  } catch (error) {
    const resourceResponse = resourcePolicyErrorResponse(error);
    if (resourceResponse) return resourceResponse;
  }
  const file = formData?.get("file");

  if (!isUploadedFile(file) || !isDocxFile(file)) {
    return NextResponse.json({ error: "DOCX file is required" }, { status: 400 });
  }

  if (file.size > RESOURCE_LIMITS.docxBytes) return payloadTooLargeResponse();

  const buffer = Buffer.from(await file.arrayBuffer());
  let conversion: Awaited<ReturnType<typeof documentInterchange.import>>;
  try {
    conversion = await documentInterchange.import({
      bytes: buffer,
      fileName: file.name,
      signal: request.signal,
      timeoutMs: remainingDeadlineMs(deadline),
    });
  } catch (error) {
    return resourcePolicyErrorResponse(error) ?? NextResponse.json({ error: "DOCX import failed" }, { status: 500 });
  }
  if (!conversion.ok) return payloadTooLargeResponse();

  return NextResponse.json({
    fidelity: conversion.fidelity,
    preview: {
      contentJson: conversion.contentJson,
      title: getDocumentTitleFromFileName(file.name),
    },
    warnings: conversion.warnings,
  });
}, { beforeWorkspaceBootstrap: (context) => enforceRequestBudget(context, "documents.import") });

export async function POST(request: Request) {
  return postHandler(request);
}

export async function OPTIONS() {
  return optionsHandler();
}

function isDocxFile(file: File) {
  return file.name.toLowerCase().endsWith(".docx") || file.type === DOCX_MIME_TYPE;
}

function isUploadedFile(value: unknown): value is File {
  return Boolean(value) &&
    typeof value === "object" &&
    typeof (value as File).arrayBuffer === "function" &&
    typeof (value as File).name === "string" &&
    typeof (value as File).size === "number" &&
    typeof (value as File).type === "string";
}

function getDocumentTitleFromFileName(fileName: string) {
  const name = fileName.trim().replace(/\.docx$/i, "");
  return (name || "Imported document").slice(0, 500);
}

function payloadTooLargeResponse() {
  return NextResponse.json({ error: "Document exceeds resource limits" }, { status: 413 });
}

function remainingDeadlineMs(deadline: number) {
  return Math.max(0, deadline - Date.now());
}
