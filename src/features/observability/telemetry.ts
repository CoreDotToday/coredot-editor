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

type CollaborationMetricUnit = "bytes" | "count" | "ms" | "sequences";
type CollaborationMetricKind = "counter" | "gauge" | "histogram";

type CollaborationMetricDefinition = {
  categories?: ReadonlySet<string>;
  kind: CollaborationMetricKind;
  unit: CollaborationMetricUnit;
};

const COLLABORATION_CLOSE_CATEGORIES = new Set([
  "archived",
  "authorization_expired",
  "authorization_revoked",
  "capability_invalid",
  "invalid_message",
  "resource_limit",
  "revoked",
  "room_rotated",
  "schema_changed",
  "server_draining",
  "storage_unavailable",
  "update_rejected",
]);

const COLLABORATION_CONFLICT_CATEGORIES = new Set([
  "idempotency_conflict",
  "proposal_overlap_conflict",
  "proposal_target_conflict",
  "sequence_conflict",
  "undo_conflict",
]);

/**
 * The complete registry of collaboration metrics. Every emitted record uses
 * one of these names; anything else is dropped so telemetry can never invent
 * a metric out of caller-provided (potentially content-bearing) strings.
 */
export const COLLABORATION_TELEMETRY_METRICS: Readonly<
  Record<string, CollaborationMetricDefinition>
> = Object.freeze({
  auth_rejected: {
    categories: COLLABORATION_CLOSE_CATEGORIES,
    kind: "counter",
    unit: "count",
  },
  checkpoint_duration_ms: { kind: "histogram", unit: "ms" },
  command_conflict: {
    categories: COLLABORATION_CONFLICT_CATEGORIES,
    kind: "counter",
    unit: "count",
  },
  connection_closed: {
    categories: COLLABORATION_CLOSE_CATEGORIES,
    kind: "counter",
    unit: "count",
  },
  connection_opened: { kind: "counter", unit: "count" },
  drain_duration_ms: { kind: "histogram", unit: "ms" },
  durable_append_latency_ms: { kind: "histogram", unit: "ms" },
  head_projection_lag: { kind: "gauge", unit: "sequences" },
  recovery_duration_ms: { kind: "histogram", unit: "ms" },
  room_reload: { kind: "counter", unit: "count" },
  update_bytes: { kind: "histogram", unit: "bytes" },
} satisfies Record<string, CollaborationMetricDefinition>);

export type CollaborationTelemetryMetric = keyof typeof COLLABORATION_TELEMETRY_METRICS;

export type CollaborationTelemetryEvent = {
  /** Bounded label; normalized against the metric's allowlist, never echoed raw. */
  category?: string;
  metric: CollaborationTelemetryMetric;
  type: "collaboration_metric";
  /** Counter increment or measured value. Counters default to one increment. */
  value?: number;
};

export type CollaborationTelemetryRecord = {
  category?: string;
  kind: CollaborationMetricKind;
  metric: CollaborationTelemetryMetric;
  type: "collaboration_metric";
  unit: CollaborationMetricUnit;
  value: number;
};

/**
 * Emits one privacy-safe collaboration counter/histogram/gauge sample.
 *
 * The record is rebuilt from an allowlist: caller extras are dropped, category
 * strings outside the metric's bounded set become "unknown", and values are
 * clamped to finite non-negative numbers. Document content, titles, metadata
 * values, names, email addresses, tokens, prompts, and Yjs bytes can therefore
 * never reach the sink.
 */
export function emitCollaborationTelemetry(event: CollaborationTelemetryEvent) {
  try {
    const definition = Object.hasOwn(COLLABORATION_TELEMETRY_METRICS, event.metric)
      ? COLLABORATION_TELEMETRY_METRICS[event.metric]
      : undefined;
    if (!definition) return;
    const fallbackValue = definition.kind === "counter" ? 1 : 0;
    const value = typeof event.value === "number" && Number.isFinite(event.value)
      ? Math.max(0, event.value)
      : fallbackValue;
    const record: CollaborationTelemetryRecord = {
      kind: definition.kind,
      metric: event.metric,
      type: "collaboration_metric",
      unit: definition.unit,
      value,
    };
    if (definition.categories && typeof event.category === "string") {
      record.category = definition.categories.has(event.category)
        ? event.category
        : "unknown";
    }
    console.info(JSON.stringify(record));
  } catch {
    // Telemetry is best-effort and must never affect the operation it describes.
  }
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
