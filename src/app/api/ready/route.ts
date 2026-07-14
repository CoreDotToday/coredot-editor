import { sqliteClient } from "@/db/client";
import { createReadinessHandler } from "@/features/health/readiness";

const getHandler = createReadinessHandler(sqliteClient);
const headHandler = createReadinessHandler(sqliteClient, { includeBody: false });
const PUBLIC_STATUS_HEADERS = {
  "Cache-Control": "no-store",
};
const PUBLIC_STATUS_METHODS = "GET, HEAD, OPTIONS";
const TOOL_RUN_NONCE_HEADER = "X-Coredot-Tool-Run-Nonce";

async function addOwnedToolRunNonce(
  request: Request,
  handler: (request: Request) => Promise<Response>,
) {
  const response = await handler(request);
  const expected = process.env.COREDOT_TOOL_RUN_NONCE;
  if (
    process.env.AUTH_MODE === "test" &&
    expected &&
    /^[A-Za-z0-9_-]{32,128}$/.test(expected) &&
    request.headers.get(TOOL_RUN_NONCE_HEADER) === expected
  ) {
    response.headers.set(TOOL_RUN_NONCE_HEADER, expected);
  }
  return response;
}

export async function GET(request: Request) {
  return addOwnedToolRunNonce(request, getHandler);
}

export async function HEAD(request: Request) {
  return addOwnedToolRunNonce(request, headHandler);
}

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      ...PUBLIC_STATUS_HEADERS,
      Allow: PUBLIC_STATUS_METHODS,
    },
    status: 204,
  });
}
