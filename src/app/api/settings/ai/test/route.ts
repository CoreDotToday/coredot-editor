import { NextResponse } from "next/server";
import { getAiSettings } from "@/features/ai/ai-settings-repository";
import { createAiProvider } from "@/features/ai/providers";
import {
  createProtectedOptionsHandler,
  createProtectedRouteHandler,
  requireWorkspaceAdministrator,
} from "@/features/auth/route-context";
import { enforceRequestBudget } from "@/features/security/request-budget";
import { resourcePolicyErrorResponse, withOperationTimeout } from "@/features/security/resource-policy";

const optionsHandler = createProtectedOptionsHandler(["POST"]);
const postHandler = createProtectedRouteHandler(async (context) => {
  try {
    const settings = await getAiSettings(context);
    const provider = createAiProvider(settings);
    await withOperationTimeout((abortSignal) =>
      provider.generateText({
        abortSignal,
        messages: [
          { role: "system", content: "Respond with only OK." },
          { role: "user", content: "Return OK." },
        ],
      }),
    );

    return NextResponse.json({ ok: true, provider: provider.name, model: provider.model });
  } catch (error) {
    const resourceResponse = resourcePolicyErrorResponse(error);
    if (resourceResponse) return resourceResponse;
    return NextResponse.json({ ok: false, error: "LLM 설정을 확인해 주세요." }, { status: 400 });
  }
}, {
  beforeWorkspaceBootstrap: (context) => {
    requireWorkspaceAdministrator(context);
    return enforceRequestBudget(context, "ai.connection-test");
  },
});

export async function POST() {
  return postHandler();
}

export async function OPTIONS() {
  return optionsHandler();
}
