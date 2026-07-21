import type { IncomingMessage, ServerResponse } from "node:http";

type ReadinessCheck = () => boolean | Promise<boolean>;

export type CollaborationReadinessChecks = {
  database: ReadinessCheck;
  migration: ReadinessCheck;
  workers: ReadinessCheck;
};

export function createCollaborationHealthController(options: {
  checks: CollaborationReadinessChecks;
  checkTimeoutMs?: number;
}) {
  let draining = false;
  const timeoutMs = options.checkTimeoutMs ?? 1_000;
  return {
    beginDrain() {
      draining = true;
    },

    get isDraining() {
      return draining;
    },

    async handle(request: IncomingMessage, response: ServerResponse) {
      const path = new URL(request.url ?? "/", "http://sidecar.invalid").pathname;
      if (path !== "/live" && path !== "/ready") return false;
      if (request.method !== "GET" && request.method !== "HEAD") {
        writeJson(response, 405, { status: "method_not_allowed" }, request.method === "HEAD");
        return true;
      }
      if (path === "/live") {
        writeJson(response, 200, { status: "live" }, request.method === "HEAD");
        return true;
      }
      const ready = !draining
        && await checksPass(options.checks, timeoutMs)
        && !draining;
      writeJson(
        response,
        ready ? 200 : 503,
        { status: ready ? "ready" : "not_ready" },
        request.method === "HEAD",
      );
      return true;
    },
  };
}

async function checksPass(checks: CollaborationReadinessChecks, timeoutMs: number) {
  try {
    const results = await Promise.all(
      Object.values(checks).map((check) => boundedCheck(check, timeoutMs)),
    );
    return results.every(Boolean);
  } catch {
    return false;
  }
}

async function boundedCheck(check: ReadinessCheck, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(check),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function writeJson(
  response: ServerResponse,
  status: number,
  body: Record<string, string>,
  head: boolean,
) {
  const encoded = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Length": encoded.byteLength,
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(head ? undefined : encoded);
}
