const PUBLIC_STATUS_HEADERS = {
  "Cache-Control": "no-store",
};

const PUBLIC_STATUS_METHODS = "GET, HEAD, OPTIONS";

export async function GET() {
  return Response.json(
    { status: "ok" },
    { headers: PUBLIC_STATUS_HEADERS },
  );
}

export async function HEAD() {
  return new Response(null, {
    headers: PUBLIC_STATUS_HEADERS,
    status: 200,
  });
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
