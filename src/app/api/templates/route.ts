import { NextResponse } from "next/server";
import { z } from "zod";
import { createPromptTemplate, listPromptTemplates } from "@/features/templates/template-repository";

const variableFieldSchema = z.object({
  name: z.string(),
  label: z.string(),
  type: z.enum(["text", "textarea", "select"]),
  required: z.boolean(),
  options: z.array(z.string()).optional(),
});

const templateSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  category: z.string().min(1),
  systemPrompt: z.string().min(1),
  variableSchemaJson: z.object({
    fields: z.array(variableFieldSchema),
    required: z.array(z.string()),
  }),
});

export async function GET() {
  const templates = await listPromptTemplates();
  return NextResponse.json({ templates });
}

export async function POST(request: Request) {
  const result = templateSchema.safeParse(await request.json().catch(() => null));
  if (!result.success) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const template = await createPromptTemplate(result.data);
  return NextResponse.json({ template }, { status: 201 });
}
