import { sqliteClient } from "@/db/client";
import { createReadinessHandler } from "@/features/health/readiness";

const getHandler = createReadinessHandler(sqliteClient);
const headHandler = createReadinessHandler(sqliteClient, { includeBody: false });
const PUBLIC_STATUS_HEADERS = {
  "Cache-Control": "no-store",
};
const PUBLIC_STATUS_METHODS = "GET, HEAD, OPTIONS";

export async function GET(request: Request) {
  return getHandler(request);
}

export async function HEAD(request: Request) {
  return headHandler(request);
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
