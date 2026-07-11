import { NextResponse } from "next/server";
import { archivePromptTemplate, updatePromptTemplate } from "@/features/templates/template-repository";

const localWorkspace = { workspaceId: "local" };
import { promptTemplateUpdatePayloadSchema } from "@/features/templates/template-validation";

type Params = {
  params: Promise<{ id: string }>;
};

export async function PUT(request: Request, { params }: Params) {
  const { id } = await params;
  const result = promptTemplateUpdatePayloadSchema.safeParse(await request.json().catch(() => null));
  if (!result.success) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const template = await updatePromptTemplate(localWorkspace, id, result.data);
  if (!template) {
    return NextResponse.json({ error: "Template not found" }, { status: 404 });
  }

  return NextResponse.json({ template });
}

export async function DELETE(_request: Request, { params }: Params) {
  const { id } = await params;
  const template = await archivePromptTemplate(localWorkspace, id);
  if (!template) {
    return NextResponse.json({ error: "Template not found" }, { status: 404 });
  }

  return NextResponse.json({ template });
}
