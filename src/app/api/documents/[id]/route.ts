import { NextResponse } from "next/server";
import { z } from "zod";
import { archiveDocument, getDocumentById, updateDocumentContent } from "@/features/documents/document-repository";

const localWorkspace = { workspaceId: "local" };
import { documentReadinessValues } from "@/features/documents/document-metadata";

const updateDocumentSchema = z.object({
  title: z.string().min(1),
  contentJson: z.object({
    type: z.literal("doc"),
    content: z.array(z.unknown()).optional(),
  }),
  metadataJson: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()]))
    .optional(),
  readiness: z.enum(documentReadinessValues).optional(),
});

type Params = {
  params: Promise<{ id: string }>;
};

export async function GET(_request: Request, { params }: Params) {
  const { id } = await params;
  const document = await getDocumentById(localWorkspace, id);
  if (!document) {
    return NextResponse.json({ error: "Document not found" }, { status: 404 });
  }
  return NextResponse.json({ document });
}

export async function PUT(request: Request, { params }: Params) {
  const { id } = await params;
  const result = updateDocumentSchema.safeParse(await request.json().catch(() => null));
  if (!result.success) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const body = result.data;
  const document = await updateDocumentContent(localWorkspace, id, body);
  if (!document) {
    return NextResponse.json({ error: "Document not found" }, { status: 404 });
  }
  return NextResponse.json({ document });
}

export async function DELETE(_request: Request, { params }: Params) {
  const { id } = await params;
  const document = await archiveDocument(localWorkspace, id);
  if (!document) {
    return NextResponse.json({ error: "Document not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
