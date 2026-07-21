import { afterEach, describe, expect, it, vi } from "vitest";

import {
  COLLABORATION_TELEMETRY_METRICS,
  emitAiExecutionTelemetry,
  emitCollaborationTelemetry,
  type AiExecutionTelemetryEvent,
  type CollaborationTelemetryEvent,
} from "./telemetry";

describe("structured telemetry", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs an allowlisted AI execution record as JSON without caller extras", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const rawError = new Error("raw-error-secret");
    const event = {
      duration: 37,
      error: rawError,
      errorClass: "provider_unavailable",
      idempotencyKey: "idempotency-secret",
      input: { prompt: "input-secret" },
      message: rawError.message,
      model: "model-secret",
      operation: "review",
      operationFingerprint: "fingerprint-secret",
      output: "output-secret",
      principalId: "principal-secret",
      provider: "openai",
      requestId: "00000000-0000-4000-8000-000000000001",
      secret: "api-key-secret",
      status: 503,
      type: "ai_execution",
      workspaceId: "workspace-secret",
    } as AiExecutionTelemetryEvent;

    emitAiExecutionTelemetry(event);

    expect(info).toHaveBeenCalledTimes(1);
    const output = info.mock.calls[0]![0];
    expect(typeof output).toBe("string");
    const record = JSON.parse(output as string);
    expect(record).toEqual({
      durationMs: 37,
      errorClass: "provider_unavailable",
      operation: "review",
      outcome: "failure",
      provider: "openai",
      requestId: "00000000-0000-4000-8000-000000000001",
      status: 503,
      type: "ai_execution",
    });
    expect(Object.keys(record).sort()).toEqual([
      "durationMs",
      "errorClass",
      "operation",
      "outcome",
      "provider",
      "requestId",
      "status",
      "type",
    ]);
    for (const forbiddenName of [
      "workspaceId",
      "principalId",
      "idempotencyKey",
      "operationFingerprint",
      "input",
      "output",
      "model",
      "error",
      "message",
      "secret",
    ]) {
      expect(Object.hasOwn(record, forbiddenName)).toBe(false);
    }
    for (const forbiddenValue of [
      "workspace-secret",
      "principal-secret",
      "idempotency-secret",
      "fingerprint-secret",
      "input-secret",
      "output-secret",
      "model-secret",
      "raw-error-secret",
      "api-key-secret",
    ]) {
      expect(output).not.toContain(forbiddenValue);
    }
  });

  it("omits undefined optional fields and derives a success outcome", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    emitAiExecutionTelemetry({
      duration: 0,
      operation: "rewrite",
      requestId: "00000000-0000-4000-8000-000000000002",
      status: 200,
      type: "ai_execution",
    });

    const record = JSON.parse(info.mock.calls[0]![0] as string);
    expect(record).toEqual({
      durationMs: 0,
      operation: "rewrite",
      outcome: "success",
      requestId: "00000000-0000-4000-8000-000000000002",
      status: 200,
      type: "ai_execution",
    });
    expect(Object.keys(record).sort()).toEqual([
      "durationMs",
      "operation",
      "outcome",
      "requestId",
      "status",
      "type",
    ]);
  });

  it("rejects arbitrary request and provider strings as secret-carrying dimensions", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    emitAiExecutionTelemetry({
      duration: 4,
      errorClass: "raw-error-class-secret",
      operation: "review",
      provider: "provider-secret",
      requestId: "request-id-secret",
      status: 500,
      type: "ai_execution",
    });

    const output = info.mock.calls[0]![0] as string;
    const record = JSON.parse(output);
    expect(record).toEqual({
      durationMs: 4,
      errorClass: "unknown_failure",
      operation: "review",
      outcome: "failure",
      requestId: "invalid",
      status: 500,
      type: "ai_execution",
    });
    expect(output).not.toMatch(/request-id-secret|provider-secret|raw-error-class-secret/);
  });

  it("never changes request behavior when the telemetry sink throws", () => {
    vi.spyOn(console, "info").mockImplementation(() => {
      throw new Error("telemetry sink failed");
    });

    expect(() => emitAiExecutionTelemetry({
      duration: 12,
      errorClass: "provider_unavailable",
      operation: "review",
      requestId: "00000000-0000-4000-8000-000000000003",
      status: 500,
      type: "ai_execution",
    })).not.toThrow();
  });
});

describe("collaboration telemetry", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("covers every required collaboration counter and histogram", () => {
    expect(Object.keys(COLLABORATION_TELEMETRY_METRICS).toSorted()).toEqual([
      "auth_rejected",
      "checkpoint_duration_ms",
      "command_conflict",
      "connection_closed",
      "connection_opened",
      "drain_duration_ms",
      "durable_append_latency_ms",
      "head_projection_lag",
      "recovery_duration_ms",
      "room_reload",
      "update_bytes",
    ]);
  });

  it("emits only the allowlisted metric shape and drops content-bearing caller extras", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const event = {
      awareness: { user: { displayName: "name-secret" } },
      category: "authorization_revoked",
      content: "document-content-secret",
      displayName: "participant-name-secret",
      documentId: "document-id-secret",
      email: "user@secret.example",
      metadataJson: { audience: "metadata-value-secret" },
      metric: "auth_rejected",
      principalId: "principal-secret",
      prompt: "prompt-body-secret",
      room: "room-name-secret",
      title: "document-title-secret",
      token: "capability-token-secret",
      type: "collaboration_metric",
      update: new Uint8Array([1, 2, 3]),
      value: 1,
      workspaceId: "workspace-secret",
    } as CollaborationTelemetryEvent;

    emitCollaborationTelemetry(event);

    expect(info).toHaveBeenCalledTimes(1);
    const output = info.mock.calls[0]![0];
    expect(typeof output).toBe("string");
    const record = JSON.parse(output as string);
    expect(record).toEqual({
      category: "authorization_revoked",
      kind: "counter",
      metric: "auth_rejected",
      type: "collaboration_metric",
      unit: "count",
      value: 1,
    });
    for (const forbiddenValue of [
      "document-content-secret",
      "document-title-secret",
      "metadata-value-secret",
      "participant-name-secret",
      "name-secret",
      "user@secret.example",
      "capability-token-secret",
      "prompt-body-secret",
      "principal-secret",
      "workspace-secret",
      "document-id-secret",
      "room-name-secret",
    ]) {
      expect(output).not.toContain(forbiddenValue);
    }
  });

  it("normalizes unknown categories instead of echoing caller strings", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    emitCollaborationTelemetry({
      category: "Bearer raw-token-secret",
      metric: "command_conflict",
      type: "collaboration_metric",
      value: 1,
    });

    const output = info.mock.calls[0]![0] as string;
    expect(JSON.parse(output)).toEqual({
      category: "unknown",
      kind: "counter",
      metric: "command_conflict",
      type: "collaboration_metric",
      unit: "count",
      value: 1,
    });
    expect(output).not.toContain("raw-token-secret");
  });

  it("emits histogram units and sanitizes non-finite or negative values", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    emitCollaborationTelemetry({
      metric: "update_bytes",
      type: "collaboration_metric",
      value: 4096,
    });
    emitCollaborationTelemetry({
      metric: "durable_append_latency_ms",
      type: "collaboration_metric",
      value: Number.NaN,
    });
    emitCollaborationTelemetry({
      metric: "head_projection_lag",
      type: "collaboration_metric",
      value: -7,
    });
    emitCollaborationTelemetry({
      metric: "drain_duration_ms",
      type: "collaboration_metric",
      value: 1250.5,
    });

    const records = info.mock.calls.map((call) => JSON.parse(call[0] as string));
    expect(records).toEqual([
      {
        kind: "histogram",
        metric: "update_bytes",
        type: "collaboration_metric",
        unit: "bytes",
        value: 4096,
      },
      {
        kind: "histogram",
        metric: "durable_append_latency_ms",
        type: "collaboration_metric",
        unit: "ms",
        value: 0,
      },
      {
        kind: "gauge",
        metric: "head_projection_lag",
        type: "collaboration_metric",
        unit: "sequences",
        value: 0,
      },
      {
        kind: "histogram",
        metric: "drain_duration_ms",
        type: "collaboration_metric",
        unit: "ms",
        value: 1250.5,
      },
    ]);
  });

  it("defaults counters to one increment and ignores categories on category-free metrics", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    emitCollaborationTelemetry({
      category: "should-not-appear-secret",
      metric: "room_reload",
      type: "collaboration_metric",
    } as CollaborationTelemetryEvent);

    const output = info.mock.calls[0]![0] as string;
    expect(JSON.parse(output)).toEqual({
      kind: "counter",
      metric: "room_reload",
      type: "collaboration_metric",
      unit: "count",
      value: 1,
    });
    expect(output).not.toContain("should-not-appear-secret");
  });

  it("drops metrics outside the registry rather than guessing a shape", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    emitCollaborationTelemetry({
      metric: "document_text",
      type: "collaboration_metric",
      value: 1,
    } as unknown as CollaborationTelemetryEvent);

    expect(info).not.toHaveBeenCalled();
  });

  it("never changes sidecar behavior when the collaboration telemetry sink throws", () => {
    vi.spyOn(console, "info").mockImplementation(() => {
      throw new Error("telemetry sink failed");
    });

    expect(() => emitCollaborationTelemetry({
      metric: "connection_opened",
      type: "collaboration_metric",
      value: 1,
    })).not.toThrow();
  });
});
