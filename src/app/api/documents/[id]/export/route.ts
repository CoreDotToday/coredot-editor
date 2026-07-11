import { NextResponse } from "next/server";
import { z } from "zod";
import { getDocumentById } from "@/features/documents/document-repository";
import { tiptapJsonToDocxBuffer } from "@/features/documents/docx-conversion";
import { createProtectedRouteHandler } from "@/features/auth/route-context";

export const runtime = "nodejs";

const DOCX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const exportDocumentSchema = z.object({
  title: z.string().min(1),
  contentJson: z.object({
    type: z.literal("doc"),
    content: z.array(z.unknown()).optional(),
  }),
});

type Params = {
  params: Promise<{ id: string }>;
};

const postHandler = createProtectedRouteHandler(async (context, request: Request, { params }: Params) => {
  const { id } = await params;
  const document = await getDocumentById(context, id);
  if (!document) {
    return NextResponse.json({ error: "Document not found" }, { status: 404 });
  }

  const result = exportDocumentSchema.safeParse(await request.json().catch(() => null));
  if (!result.success) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const buffer = await tiptapJsonToDocxBuffer(result.data.contentJson, result.data.title);
  return new Response(new Uint8Array(buffer), {
    headers: {
      "Content-Disposition": `attachment; filename="${sanitizeFileName(result.data.title)}.docx"`,
      "Content-Type": DOCX_MIME_TYPE,
    },
  });
});

export async function POST(request: Request, params: Params) {
  return postHandler(request, params);
}

function sanitizeFileName(value: string) {
  return value.replace(/[\\/:*?"<>|]/g, "").trim() || "document";
}
