import { NextResponse } from "next/server";
import { z } from "zod";
import { archiveDocument, getDocumentById, updateDocumentContent } from "@/features/documents/document-repository";

const updateDocumentSchema = z.object({
  title: z.string().min(1),
  contentJson: z.object({
    type: z.literal("doc"),
    content: z.array(z.unknown()).optional(),
  }),
});

type Params = {
  params: Promise<{ id: string }>;
};

export async function GET(_request: Request, { params }: Params) {
  const { id } = await params;
  const document = await getDocumentById(id);
  if (!document) {
    return NextResponse.json({ error: "Document not found" }, { status: 404 });
  }
  return NextResponse.json({ document });
}

export async function PUT(request: Request, { params }: Params) {
  const { id } = await params;
  const body = updateDocumentSchema.parse(await request.json());
  const document = await updateDocumentContent(id, body);
  if (!document) {
    return NextResponse.json({ error: "Document not found" }, { status: 404 });
  }
  return NextResponse.json({ document });
}

export async function DELETE(_request: Request, { params }: Params) {
  const { id } = await params;
  await archiveDocument(id);
  return NextResponse.json({ ok: true });
}
