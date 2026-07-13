import { NextResponse } from "next/server";
import { createDocumentFromContent } from "@/features/documents/document-repository";
import { toPublicDocument } from "@/features/documents/document-public";
import { docxBufferToTiptapJson } from "@/features/documents/docx-conversion";
import { createProtectedOptionsHandler, createProtectedRouteHandler } from "@/features/auth/route-context";
import { enforceRequestBudget } from "@/features/security/request-budget";
import {
  RESOURCE_LIMITS,
  parseBoundedFormData,
  resourcePolicyErrorResponse,
  validateTiptapResource,
  withOperationTimeout,
} from "@/features/security/resource-policy";

export const runtime = "nodejs";

const DOCX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const MAX_MULTIPART_OVERHEAD_BYTES = 1024 * 1024;
const optionsHandler = createProtectedOptionsHandler(["POST"]);

const postHandler = createProtectedRouteHandler(async (context, request: Request) => {
  const contentLength = Number(request.headers?.get("content-length"));
  if (
    Number.isFinite(contentLength) &&
    contentLength > RESOURCE_LIMITS.docxBytes + MAX_MULTIPART_OVERHEAD_BYTES
  ) {
    return payloadTooLargeResponse();
  }

  let formData: FormData | null = null;
  try {
    formData = await parseBoundedFormData(request, RESOURCE_LIMITS.docxBytes + MAX_MULTIPART_OVERHEAD_BYTES);
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
  let conversion: Awaited<ReturnType<typeof docxBufferToTiptapJson>>;
  try {
    conversion = await withOperationTimeout((signal) => docxBufferToTiptapJson(buffer, signal));
  } catch (error) {
    return resourcePolicyErrorResponse(error) ?? NextResponse.json({ error: "DOCX import failed" }, { status: 500 });
  }
  if (!validateTiptapResource(conversion.contentJson).ok) return payloadTooLargeResponse();
  const document = await createDocumentFromContent(
    context,
    getDocumentTitleFromFileName(file.name),
    conversion.contentJson,
  );

  return NextResponse.json({ document: toPublicDocument(document), warnings: conversion.warnings }, { status: 201 });
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
