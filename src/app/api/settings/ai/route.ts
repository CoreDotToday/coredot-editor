import { NextResponse } from "next/server";
import { aiSettingsPayloadSchema, getAiSettings, updateAiSettings } from "@/features/ai/ai-settings-repository";

const localWorkspace = { workspaceId: "local" };

export async function GET() {
  const settings = await getAiSettings(localWorkspace);
  return NextResponse.json({ settings, secrets: getSecretStatus() });
}

export async function PUT(request: Request) {
  const result = aiSettingsPayloadSchema.safeParse(await request.json().catch(() => null));
  if (!result.success) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  try {
    const settings = await updateAiSettings(localWorkspace, result.data);
    return NextResponse.json({ settings, secrets: getSecretStatus() });
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
}

function getSecretStatus() {
  return {
    coredotConfigured: Boolean(process.env.COREDOT_API_KEY),
    openaiConfigured: Boolean(process.env.OPENAI_API_KEY),
  };
}
