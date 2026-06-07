import { NextResponse } from "next/server";
import { aiSettingsPayloadSchema, getAiSettings, updateAiSettings } from "@/features/ai/ai-settings-repository";

export async function GET() {
  const settings = await getAiSettings();
  return NextResponse.json({ settings, secrets: getSecretStatus() });
}

export async function PUT(request: Request) {
  const result = aiSettingsPayloadSchema.safeParse(await request.json().catch(() => null));
  if (!result.success) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  try {
    const settings = await updateAiSettings(result.data);
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
