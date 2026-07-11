import { NextResponse } from "next/server";

export const RESOURCE_LIMITS = Object.freeze({
  docxBytes: 10 * 1024 * 1024,
  documentDepth: 64,
  documentNodes: 100_000,
  operationMs: 30_000,
});

type TiptapLimits = { documentDepth: number; documentNodes: number };
type TiptapValidation =
  | { depth: number; nodes: number; ok: true }
  | { limit: "documentDepth" | "documentNodes" | "malformed"; ok: false };

export class OperationTimeoutError extends Error {
  constructor(message = "Operation timed out") {
    super(message);
    this.name = "OperationTimeoutError";
  }
}

export function validateTiptapResource(
  root: unknown,
  limits: TiptapLimits = RESOURCE_LIMITS,
): TiptapValidation {
  if (!isNode(root) || root.type !== "doc") {
    return { limit: "malformed", ok: false };
  }

  const seen = new WeakSet<object>();
  const stack: Array<{ depth: number; node: Record<string, unknown> }> = [{ depth: 1, node: root }];
  let maxDepth = 0;
  let nodes = 0;

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    if (seen.has(current.node)) return { limit: "malformed", ok: false };
    seen.add(current.node);
    nodes += 1;
    if (nodes > limits.documentNodes) return { limit: "documentNodes", ok: false };
    if (current.depth > limits.documentDepth) return { limit: "documentDepth", ok: false };
    maxDepth = Math.max(maxDepth, current.depth);

    const content = current.node.content;
    if (content === undefined) continue;
    if (!Array.isArray(content)) return { limit: "malformed", ok: false };
    for (let index = content.length - 1; index >= 0; index -= 1) {
      const child = content[index];
      if (!isNode(child)) return { limit: "malformed", ok: false };
      stack.push({ depth: current.depth + 1, node: child });
    }
  }

  return { depth: maxDepth, nodes, ok: true };
}

export async function withOperationTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number = RESOURCE_LIMITS.operationMs,
): Promise<T> {
  const controller = new AbortController();
  const timeoutError = new OperationTimeoutError();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort(timeoutError);
      reject(timeoutError);
    }, timeoutMs);
  });

  try {
    return await Promise.race([operation(controller.signal), timeout]);
  } catch (error) {
    if (controller.signal.aborted) throw timeoutError;
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function resourcePolicyErrorResponse(error: unknown): Response | null {
  if (error instanceof OperationTimeoutError) {
    return NextResponse.json({ error: "Operation timed out" }, { status: 504 });
  }
  return null;
}

function isNode(value: unknown): value is Record<string, unknown> & { type: string } {
  return Boolean(value) && typeof value === "object" && typeof (value as { type?: unknown }).type === "string";
}
