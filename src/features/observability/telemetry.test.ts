import { afterEach, describe, expect, it, vi } from "vitest";

import {
  emitAiExecutionTelemetry,
  type AiExecutionTelemetryEvent,
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
