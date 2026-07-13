import { isAiProviderName } from "@/features/ai/provider-catalog";

export type AiExecutionTelemetryEvent = {
  duration: number;
  errorClass?: string;
  operation: "review" | "rewrite";
  provider?: string;
  requestId: string;
  status: number;
  type: "ai_execution";
};

export type AiExecutionTelemetryRecord = {
  durationMs: number;
  errorClass?: string;
  operation: "review" | "rewrite";
  outcome: "failure" | "success";
  provider?: string;
  requestId: string;
  status: number;
  type: "ai_execution";
};

const SAFE_AI_EXECUTION_ERROR_CLASSES = new Set([
  "ai_execution_unavailable",
  "ai_generation_failed",
  "ai_operation_in_progress",
  "idempotency_key_reused",
  "invalid_durable_result",
  "operation_timed_out",
  "preflight_failed",
  "preflight_rejected",
  "provider_unavailable",
  "request_aborted",
  "request_budget_denied",
  "unknown_failure",
]);
const CANONICAL_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function normalizeAiExecutionErrorClass(errorClass: string | undefined) {
  if (errorClass === undefined) return undefined;
  return SAFE_AI_EXECUTION_ERROR_CLASSES.has(errorClass) ? errorClass : "unknown_failure";
}

export function emitAiExecutionTelemetry(event: AiExecutionTelemetryEvent) {
  try {
    const status = Number.isInteger(event.status) && event.status >= 100 && event.status <= 599
      ? event.status
      : 500;
    const record: AiExecutionTelemetryRecord = {
      durationMs: Number.isFinite(event.duration) ? Math.max(0, event.duration) : 0,
      operation: event.operation === "rewrite" ? "rewrite" : "review",
      outcome: status >= 200 && status < 400 ? "success" : "failure",
      requestId: CANONICAL_UUID_PATTERN.test(event.requestId) ? event.requestId.toLowerCase() : "invalid",
      status,
      type: "ai_execution",
    };
    const errorClass = normalizeAiExecutionErrorClass(event.errorClass);
    if (errorClass !== undefined) record.errorClass = errorClass;
    if (isAiProviderName(event.provider)) record.provider = event.provider;
    console.info(JSON.stringify(record));
  } catch {
    // Telemetry is best-effort and must never affect the operation it describes.
  }
}
