import { NextResponse } from "next/server";
import { createPromptTemplate, listPromptTemplates } from "@/features/templates/template-repository";
import { promptTemplatePayloadSchema } from "@/features/templates/template-validation";

export async function GET() {
  const templates = await listPromptTemplates();
  return NextResponse.json({ templates });
}

export async function POST(request: Request) {
  const result = promptTemplatePayloadSchema.safeParse(await request.json().catch(() => null));
  if (!result.success) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const template = await createPromptTemplate(result.data);
  return NextResponse.json({ template }, { status: 201 });
}
