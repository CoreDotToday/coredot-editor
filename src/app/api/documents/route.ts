import { NextResponse } from "next/server";
import { z } from "zod";
import { createDocumentDraft, listDocuments } from "@/features/documents/document-repository";

const createDocumentSchema = z.object({
  title: z.string().min(1).default("Untitled document"),
});

export async function GET() {
  const documents = await listDocuments();
  return NextResponse.json({ documents });
}

export async function POST(request: Request) {
  const result = createDocumentSchema.safeParse(await request.json().catch(() => null));
  if (!result.success) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const body = result.data;
  const document = await createDocumentDraft(body.title);
  return NextResponse.json({ document }, { status: 201 });
}
