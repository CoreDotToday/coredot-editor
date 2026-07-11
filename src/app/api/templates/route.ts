import { NextResponse } from "next/server";
import { createPromptTemplate, listPromptTemplates } from "@/features/templates/template-repository";

const localWorkspace = { workspaceId: "local" };
import { promptTemplatePayloadSchema } from "@/features/templates/template-validation";

export async function GET() {
  const templates = await listPromptTemplates(localWorkspace);
  return NextResponse.json({ templates });
}

export async function POST(request: Request) {
  const result = promptTemplatePayloadSchema.safeParse(await request.json().catch(() => null));
  if (!result.success) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const template = await createPromptTemplate(localWorkspace, result.data);
  return NextResponse.json({ template }, { status: 201 });
}
