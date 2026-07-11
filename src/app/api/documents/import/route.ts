import { NextResponse } from "next/server";
import { createDocumentFromContent } from "@/features/documents/document-repository";
import { docxBufferToTiptapJson } from "@/features/documents/docx-conversion";
import { createProtectedRouteHandler } from "@/features/auth/route-context";

export const runtime = "nodejs";

const DOCX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const postHandler = createProtectedRouteHandler(async (context, request: Request) => {
  const formData = await request.formData().catch(() => null);
  const file = formData?.get("file");

  if (!(file instanceof File) || !isDocxFile(file)) {
    return NextResponse.json({ error: "DOCX file is required" }, { status: 400 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const conversion = await docxBufferToTiptapJson(buffer);
  const document = await createDocumentFromContent(
    context,
    getDocumentTitleFromFileName(file.name),
    conversion.contentJson,
  );

  return NextResponse.json({ document, warnings: conversion.warnings }, { status: 201 });
});

export async function POST(request: Request) {
  return postHandler(request);
}

function isDocxFile(file: File) {
  return file.name.toLowerCase().endsWith(".docx") || file.type === DOCX_MIME_TYPE;
}

function getDocumentTitleFromFileName(fileName: string) {
  const name = fileName.trim().replace(/\.docx$/i, "");
  return name || "Imported document";
}
