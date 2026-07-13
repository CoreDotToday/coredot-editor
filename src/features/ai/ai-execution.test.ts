import { describe, expect, it, vi } from "vitest";
import {
  admitAiOperation,
  createAiOperationFingerprint,
  executeAiOperation,
  resolveAiIdempotencyKey,
  toPublicAiRun,
  type AiExecutionStepFailure,
  type AiExecutionStepSuccess,
  type AiRunClaim,
  type DurableAiOperation,
  type ProviderReadiness,
} from "./ai-execution";

const scope = { workspaceId: "workspace_a" };

function createBaseOptions() {
  const durable: DurableAiOperation = {
    run: {
      id: "run_1",
      idempotencyKey: "operation-1",
      operationFingerprint: "fingerprint-1",
      status: "completed",
    },
    proposals: [{ id: "proposal_1", replacementText: "durable output" }],
  };

  return {
    admission: {
      kind: "ai_execution_admitted" as const,
      operation: "review" as const,
      requestId: "request-1",
      startedAt: Date.now(),
      telemetry: vi.fn(),
    },
    claimAiRun: vi.fn<(_scope: typeof scope, _input: unknown) => Promise<AiRunClaim>>(),
    completeAiRunWithProposals: vi.fn<(
      _scope: typeof scope,
      _id: string,
      _outputText: string,
      _proposals: unknown[],
    ) => Promise<DurableAiOperation | null>>(),
    deadlineMs: 100,
    execute: vi.fn<(_context: unknown, _provider: unknown, _signal: AbortSignal) => Promise<string>>(
      async () => "provider output",
    ),
    failAiRun: vi.fn<(_scope: typeof scope, _id: string, _errorMessage: string) => Promise<unknown>>(),
    getAiRunByIdempotencyKey: vi.fn<
      (_scope: typeof scope, _key: string) => Promise<DurableAiOperation | null>
    >(async () => durable),
    idempotencyKey: "operation-1",
    mapDurableResult: vi.fn(() => ({
      proposal: durable.proposals[0],
      run: durable.run,
    })),
    mapFinalizedResult: vi.fn(() => ({
      run: durable.run,
    })),
    operationFingerprint: "fingerprint-1",
    preflight: vi.fn<() => Promise<AiExecutionStepSuccess<unknown> | AiExecutionStepFailure>>(),
    prepareFinalization: vi.fn(() => ({ outputText: "", proposals: [] })),
    resolveProvider: vi.fn<(_context: unknown) => Promise<ProviderReadiness<unknown>>>(),
    runInput: {
      commandType: "document_review" as const,
      documentId: "doc_1",
      inputSummaryJson: {},
      promptTemplateId: "tpl_1",
    },
    scope,
  };
}

describe("executeAiOperation", () => {
  it("preserves a denied budget response and does no durable or provider work", async () => {
    const options = createBaseOptions();
    const operationFingerprint = vi.fn(async () => "fingerprint-1");
    const denied = new Response(JSON.stringify({ error: "Request rate limit exceeded" }), {
      headers: { "Retry-After": "7", "X-RateLimit-Limit": "20" },
      status: 429,
    });
    const result = await admitAiOperation({
      admitRequest: vi.fn(async () => denied),
      deadlineMs: 100,
      operation: "review",
      requestId: "request-1",
      telemetry: options.admission.telemetry,
    });

    expect(result).toMatchObject({ ok: false, response: denied, status: 429 });
    expect(options.getAiRunByIdempotencyKey).not.toHaveBeenCalled();
    expect(options.preflight).not.toHaveBeenCalled();
    expect(options.execute).not.toHaveBeenCalled();
    expect(operationFingerprint).not.toHaveBeenCalled();
    expect(result.ok ? null : result.response?.headers.get("Retry-After")).toBe("7");
  });

  it("resolves the operation fingerprint after budget admission and before durable lookup", async () => {
    const options = createBaseOptions();
    const operationFingerprint = vi.fn(async () => "fingerprint-1");

    const admitRequest = vi.fn(async () => null);
    const admitted = await admitAiOperation({
      admitRequest,
      deadlineMs: 100,
      operation: "review",
      requestId: "request-1",
      telemetry: options.admission.telemetry,
    });
    if (!admitted.ok) throw new Error("Expected admission");
    const result = await executeAiOperation({
      ...options,
      admission: admitted.admission,
      operationFingerprint,
    });

    expect(result).toMatchObject({ ok: true, replayed: true });
    expect(operationFingerprint).toHaveBeenCalledTimes(1);
    expect(admitRequest.mock.invocationCallOrder[0]).toBeLessThan(
      operationFingerprint.mock.invocationCallOrder[0]!,
    );
    expect(operationFingerprint.mock.invocationCallOrder[0]).toBeLessThan(
      options.getAiRunByIdempotencyKey.mock.invocationCallOrder[0]!,
    );
  });

  it("preserves a 503 budget-unavailable response and Retry-After without durable work", async () => {
    const options = createBaseOptions();
    const unavailable = new Response(JSON.stringify({ error: "Request rate limit temporarily unavailable" }), {
      headers: { "Retry-After": "1" },
      status: 503,
    });
    const result = await admitAiOperation({
      admitRequest: vi.fn(async () => unavailable),
      deadlineMs: 100,
      operation: "review",
      requestId: "request-1",
      telemetry: options.admission.telemetry,
    });

    expect(result).toMatchObject({ ok: false, response: unavailable, status: 503 });
    expect(result.ok ? null : result.response?.headers.get("Retry-After")).toBe("1");
    expect(options.getAiRunByIdempotencyKey).not.toHaveBeenCalled();
    expect(options.preflight).not.toHaveBeenCalled();
  });

  it("bounds a hung budget admission with the operation deadline", async () => {
    vi.useFakeTimers();
    let result: Awaited<ReturnType<typeof admitAiOperation>> | undefined;

    try {
      void admitAiOperation({
        admitRequest: async () => new Promise(() => undefined),
        deadlineMs: 100,
        operation: "review",
        requestId: "request-1",
      }).then((value) => {
        result = value;
      });
      await vi.advanceTimersByTimeAsync(100);

      expect(result).toMatchObject({ code: "operation_timed_out", ok: false, status: 504 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds budget admission when the request is aborted", async () => {
    const controller = new AbortController();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const pending = admitAiOperation({
      admitRequest: async () => {
        markStarted();
        return new Promise(() => undefined);
      },
      deadlineMs: 100,
      operation: "review",
      requestId: "request-1",
      requestSignal: controller.signal,
    });
    await started;
    controller.abort();

    await expect(pending).resolves.toMatchObject({ code: "request_aborted", ok: false, status: 408 });
  });

  it("subtracts admission and body-parse elapsed time from the execution deadline", async () => {
    const options = createBaseOptions();
    const fingerprint = vi.fn(async () => "fingerprint-1");
    options.admission.startedAt = Date.now() - options.deadlineMs;

    await expect(executeAiOperation({ ...options, operationFingerprint: fingerprint })).resolves.toMatchObject({
      code: "operation_timed_out",
      ok: false,
      status: 504,
    });
    expect(fingerprint).not.toHaveBeenCalled();
    expect(options.getAiRunByIdempotencyKey).not.toHaveBeenCalled();
  });

  it("admits budget before replaying an exact completed durable result without provider work", async () => {
    const options = createBaseOptions();

    const result = await executeAiOperation(options);

    expect(result).toMatchObject({
      ok: true,
      replayed: true,
      value: {
        proposal: { id: "proposal_1", replacementText: "durable output" },
        run: { id: "run_1", status: "completed" },
      },
    });
    expect(options.getAiRunByIdempotencyKey).toHaveBeenCalledTimes(1);
    expect(options.preflight).not.toHaveBeenCalled();
    expect(options.resolveProvider).not.toHaveBeenCalled();
    expect(options.claimAiRun).not.toHaveBeenCalled();
    expect(options.execute).not.toHaveBeenCalled();
  });

  it("aborts provider execution at the deadline, fails the claimed run once, and never finalizes", async () => {
    vi.useFakeTimers();
    const options = createBaseOptions();
    options.getAiRunByIdempotencyKey.mockResolvedValueOnce(null);
    options.preflight.mockResolvedValueOnce({ ok: true, value: { documentId: "doc_1" } });
    options.resolveProvider.mockResolvedValueOnce({
      model: "stub-editor",
      ok: true,
      provider: { name: "stub" },
      providerName: "stub",
    });
    options.claimAiRun.mockResolvedValueOnce({
      kind: "claimed",
      run: { id: "run_1", status: "pending" },
    });
    options.execute.mockImplementationOnce(
      async (_context: unknown, _provider: unknown, signal: AbortSignal) =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason));
        }),
    );
    options.failAiRun.mockResolvedValueOnce({ id: "run_1", status: "failed" });

    try {
      const pending = executeAiOperation(options);
      await vi.advanceTimersByTimeAsync(100);

      await expect(pending).resolves.toMatchObject({
        code: "operation_timed_out",
        error: "Operation timed out",
        ok: false,
        status: 504,
      });
      expect(options.failAiRun).toHaveBeenCalledTimes(1);
      expect(options.failAiRun).toHaveBeenCalledWith(
        scope,
        "run_1",
        "Operation timed out",
        { retryNotBeforeAt: expect.any(Date) },
      );
      expect(options.completeAiRunWithProposals).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds a hung preflight without creating or failing a durable run", async () => {
    vi.useFakeTimers();
    const options = createBaseOptions();
    options.getAiRunByIdempotencyKey.mockResolvedValueOnce(null);
    options.preflight.mockImplementationOnce(async () => new Promise(() => undefined));
    let result: Awaited<ReturnType<typeof executeAiOperation>> | undefined;

    try {
      void executeAiOperation(options).then((value) => {
        result = value;
      });
      await vi.advanceTimersByTimeAsync(100);

      expect(result).toMatchObject({ code: "operation_timed_out", ok: false, status: 504 });
      expect(options.claimAiRun).not.toHaveBeenCalled();
      expect(options.execute).not.toHaveBeenCalled();
      expect(options.failAiRun).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds a hung finalization and starts guarded failure persistence without waiting for it", async () => {
    vi.useFakeTimers();
    const options = createBaseOptions();
    options.getAiRunByIdempotencyKey.mockResolvedValueOnce(null);
    options.preflight.mockResolvedValueOnce({ ok: true, value: { documentId: "doc_1" } });
    options.resolveProvider.mockResolvedValueOnce({
      model: "stub-editor",
      ok: true,
      provider: { name: "stub" },
      providerName: "stub",
    });
    options.claimAiRun.mockResolvedValueOnce({ kind: "claimed", run: { id: "run_1", status: "pending" } });
    options.prepareFinalization.mockReturnValueOnce({ outputText: "output", proposals: [] });
    options.completeAiRunWithProposals.mockImplementationOnce(async () => new Promise(() => undefined));
    options.failAiRun.mockImplementationOnce(async () => new Promise(() => undefined));
    let result: Awaited<ReturnType<typeof executeAiOperation>> | undefined;

    try {
      void executeAiOperation(options).then((value) => {
        result = value;
      });
      await vi.advanceTimersByTimeAsync(100);

      expect(result).toMatchObject({ code: "operation_timed_out", ok: false, status: 504 });
      expect(options.completeAiRunWithProposals).toHaveBeenCalledTimes(1);
      expect(options.failAiRun).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cleans up a claim that resolves after the lifecycle deadline without executing the provider", async () => {
    vi.useFakeTimers();
    const options = createBaseOptions();
    let resolveClaim!: (claim: AiRunClaim) => void;
    options.getAiRunByIdempotencyKey.mockResolvedValueOnce(null);
    options.preflight.mockResolvedValueOnce({ ok: true, value: { documentId: "doc_1" } });
    options.resolveProvider.mockResolvedValueOnce({
      model: "stub-editor",
      ok: true,
      provider: { name: "stub" },
      providerName: "stub",
    });
    options.claimAiRun.mockImplementationOnce(async () => new Promise((resolve) => {
      resolveClaim = resolve;
    }));
    options.failAiRun.mockResolvedValueOnce({ id: "run_late", status: "failed" });
    let result: Awaited<ReturnType<typeof executeAiOperation>> | undefined;

    try {
      void executeAiOperation(options).then((value) => {
        result = value;
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(result).toMatchObject({ code: "operation_timed_out", ok: false, status: 504 });

      resolveClaim({ kind: "claimed", run: { id: "run_late", status: "pending" } });
      await vi.runAllTimersAsync();
      await Promise.resolve();

      expect(options.failAiRun).toHaveBeenCalledWith(
        scope,
        "run_late",
        "Operation timed out",
        { retryNotBeforeAt: expect.any(Date) },
      );
      expect(options.execute).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns bounded conflicts for a mismatched fingerprint or an in-progress exact operation", async () => {
    const mismatch = createBaseOptions();
    mismatch.getAiRunByIdempotencyKey.mockResolvedValueOnce({
      proposals: [],
      run: {
        id: "run_1",
        idempotencyKey: "operation-1",
        operationFingerprint: "other-fingerprint",
        status: "completed",
      },
    });

    await expect(executeAiOperation(mismatch)).resolves.toMatchObject({
      code: "idempotency_key_reused",
      ok: false,
      status: 409,
    });
    expect(mismatch.preflight).not.toHaveBeenCalled();

    const inProgress = createBaseOptions();
    inProgress.getAiRunByIdempotencyKey.mockResolvedValueOnce({
      proposals: [],
      run: {
        id: "run_1",
        idempotencyKey: "operation-1",
        operationFingerprint: "fingerprint-1",
        status: "streaming",
      },
    });

    await expect(executeAiOperation(inProgress)).resolves.toMatchObject({
      code: "ai_operation_in_progress",
      ok: false,
      status: 409,
    });
    expect(inProgress.preflight).not.toHaveBeenCalled();
  });

  it("rejects a failed key with a different fingerprint before preflight or provider construction", async () => {
    const options = createBaseOptions();
    options.getAiRunByIdempotencyKey.mockResolvedValueOnce({
      proposals: [],
      run: {
        id: "run_1",
        idempotencyKey: "operation-1",
        operationFingerprint: "fingerprint-for-other-body",
        status: "failed",
      },
    });

    await expect(executeAiOperation(options)).resolves.toMatchObject({
      code: "idempotency_key_reused",
      ok: false,
      status: 409,
    });
    expect(options.preflight).not.toHaveBeenCalled();
    expect(options.resolveProvider).not.toHaveBeenCalled();
    expect(options.claimAiRun).not.toHaveBeenCalled();
  });

  it("returns a bounded conflict for an exact failed key whose retry lease is still active", async () => {
    const options = createBaseOptions();
    options.getAiRunByIdempotencyKey.mockResolvedValueOnce({
      proposals: [],
      run: {
        id: "run_1",
        idempotencyKey: "operation-1",
        operationFingerprint: "fingerprint-1",
        retryNotBeforeAt: new Date(Date.now() + 30_000),
        status: "failed",
      },
    });

    await expect(executeAiOperation(options)).resolves.toMatchObject({
      code: "ai_operation_in_progress",
      ok: false,
      status: 409,
    });
    expect(options.preflight).not.toHaveBeenCalled();
    expect(options.resolveProvider).not.toHaveBeenCalled();
    expect(options.claimAiRun).not.toHaveBeenCalled();
  });

  it("returns 408 for request abort, fails once, and ignores a provider that resolves late", async () => {
    const controller = new AbortController();
    const options = createBaseOptions();
    let resolveExecution!: (value: string) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    options.getAiRunByIdempotencyKey.mockResolvedValueOnce(null);
    options.preflight.mockResolvedValueOnce({ ok: true, value: { documentId: "doc_1" } });
    options.resolveProvider.mockResolvedValueOnce({
      model: "stub-editor",
      ok: true,
      provider: { name: "stub" },
      providerName: "stub",
    });
    options.claimAiRun.mockResolvedValueOnce({ kind: "claimed", run: { id: "run_1", status: "pending" } });
    options.execute.mockImplementationOnce(async () => {
      markStarted();
      return new Promise<string>((resolve) => {
        resolveExecution = resolve;
      });
    });
    options.failAiRun.mockResolvedValueOnce({ id: "run_1", status: "failed" });

    const pending = executeAiOperation({ ...options, requestSignal: controller.signal });
    await started;
    controller.abort(new Error("client disconnected with secret prompt"));

    await expect(pending).resolves.toMatchObject({
      code: "request_aborted",
      error: "Request aborted",
      ok: false,
      status: 408,
    });
    resolveExecution("late secret output");
    await Promise.resolve();
    expect(options.failAiRun).toHaveBeenCalledTimes(1);
    expect(options.failAiRun).toHaveBeenCalledWith(
      scope,
      "run_1",
      "Request aborted",
      { retryNotBeforeAt: expect.any(Date) },
    );
    expect(options.completeAiRunWithProposals).not.toHaveBeenCalled();
  });

  it("keeps ordinary provider failures immediately retryable without a retry lease", async () => {
    const options = createBaseOptions();
    options.getAiRunByIdempotencyKey.mockResolvedValueOnce(null);
    options.preflight.mockResolvedValueOnce({ ok: true, value: { documentId: "doc_1" } });
    options.resolveProvider.mockResolvedValueOnce({
      model: "stub-editor",
      ok: true,
      provider: { name: "stub" },
      providerName: "stub",
    });
    options.claimAiRun.mockResolvedValueOnce({ kind: "claimed", run: { id: "run_1", status: "pending" } });
    options.execute.mockRejectedValueOnce(new Error("provider failed with secret details"));
    options.failAiRun.mockResolvedValueOnce({ id: "run_1", status: "failed" });

    await expect(executeAiOperation(options)).resolves.toMatchObject({
      code: "ai_generation_failed",
      error: "AI generation failed",
      ok: false,
      status: 500,
    });
    expect(options.failAiRun).toHaveBeenCalledWith(scope, "run_1", "AI generation failed");
  });

  it("does no durable or provider work for a request that was already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("client secret"));
    const options = createBaseOptions();
    options.getAiRunByIdempotencyKey.mockResolvedValueOnce(null);
    options.preflight.mockResolvedValueOnce({ ok: true, value: { documentId: "doc_1" } });
    options.resolveProvider.mockResolvedValueOnce({
      model: "stub-editor",
      ok: true,
      provider: { name: "stub" },
      providerName: "stub",
    });
    options.claimAiRun.mockResolvedValueOnce({ kind: "claimed", run: { id: "run_1", status: "pending" } });
    options.failAiRun.mockResolvedValueOnce({ id: "run_1", status: "failed" });

    await expect(executeAiOperation({ ...options, requestSignal: controller.signal })).resolves.toMatchObject({
      code: "request_aborted",
      error: "Request aborted",
      ok: false,
      status: 408,
    });
    expect(options.getAiRunByIdempotencyKey).not.toHaveBeenCalled();
    expect(options.claimAiRun).not.toHaveBeenCalled();
    expect(options.execute).not.toHaveBeenCalled();
    expect(options.failAiRun).not.toHaveBeenCalled();
    expect(options.completeAiRunWithProposals).not.toHaveBeenCalled();
  });

  it("classifies lookup, preflight, provider-construction, and claim throws without leaking raw errors", async () => {
    const cases = [
      {
        arrange(options: ReturnType<typeof createBaseOptions>) {
          options.getAiRunByIdempotencyKey.mockRejectedValueOnce(new Error("sqlite path /secret/workspace"));
        },
        code: "ai_execution_unavailable",
      },
      {
        arrange(options: ReturnType<typeof createBaseOptions>) {
          options.getAiRunByIdempotencyKey.mockResolvedValueOnce(null);
          options.preflight.mockRejectedValueOnce(new Error("prompt secret"));
        },
        code: "preflight_failed",
      },
      {
        arrange(options: ReturnType<typeof createBaseOptions>) {
          options.getAiRunByIdempotencyKey.mockResolvedValueOnce(null);
          options.preflight.mockResolvedValueOnce({ ok: true, value: { documentId: "doc_1" } });
          options.resolveProvider.mockRejectedValueOnce(new Error("OPENAI_API_KEY=secret"));
        },
        code: "provider_unavailable",
      },
      {
        arrange(options: ReturnType<typeof createBaseOptions>) {
          options.getAiRunByIdempotencyKey.mockResolvedValueOnce(null);
          options.preflight.mockResolvedValueOnce({ ok: true, value: { documentId: "doc_1" } });
          options.resolveProvider.mockResolvedValueOnce({
            model: "secret-model-detail",
            ok: true,
            provider: { name: "stub" },
            providerName: "stub",
          });
          options.claimAiRun.mockRejectedValueOnce(new Error("database secret"));
        },
        code: "ai_execution_unavailable",
      },
    ];

    for (const testCase of cases) {
      const options = createBaseOptions();
      testCase.arrange(options);
      const result = await executeAiOperation(options);

      expect(result).toMatchObject({ code: testCase.code, ok: false, status: 500 });
      expect(JSON.stringify(result)).not.toMatch(/secret|OPENAI_API_KEY|workspace/);
      expect(options.execute).not.toHaveBeenCalled();
    }
  });

  it("keeps the primary timeout response when guarded failure persistence throws", async () => {
    vi.useFakeTimers();
    const options = createBaseOptions();
    options.getAiRunByIdempotencyKey.mockResolvedValueOnce(null);
    options.preflight.mockResolvedValueOnce({ ok: true, value: { documentId: "doc_1" } });
    options.resolveProvider.mockResolvedValueOnce({
      model: "stub-editor",
      ok: true,
      provider: { name: "stub" },
      providerName: "stub",
    });
    options.claimAiRun.mockResolvedValueOnce({ kind: "claimed", run: { id: "run_1", status: "pending" } });
    options.execute.mockImplementationOnce(async () => new Promise<string>(() => undefined));
    options.failAiRun.mockRejectedValueOnce(new Error("database credentials secret"));

    try {
      const pending = executeAiOperation(options);
      await vi.advanceTimersByTimeAsync(100);
      await expect(pending).resolves.toMatchObject({ code: "operation_timed_out", ok: false, status: 504 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("emits allowlisted telemetry for replay, denial, success, and provider failure without changing results", async () => {
    const replayTelemetry = vi.fn(async () => {
      throw new Error("telemetry unavailable");
    });
    const replay = createBaseOptions();
    const replayResult = await executeAiOperation({
      ...replay,
      admission: { ...replay.admission, telemetry: replayTelemetry },
    });
    expect(replayResult).toMatchObject({ ok: true, replayed: true });
    expect(replayTelemetry).toHaveBeenCalledWith({
      duration: expect.any(Number),
      operation: "review",
      requestId: "request-1",
      status: 200,
      type: "ai_execution",
    });

    const denialTelemetry = vi.fn();
    await admitAiOperation({
      admitRequest: vi.fn(async () => new Response(null, { status: 429 })),
      deadlineMs: 100,
      operation: "review",
      requestId: "request-1",
      telemetry: denialTelemetry,
    });
    expect(denialTelemetry).toHaveBeenCalledWith({
      duration: expect.any(Number),
      errorClass: "request_budget_denied",
      operation: "review",
      requestId: "request-1",
      status: 429,
      type: "ai_execution",
    });

    const successTelemetry = vi.fn();
    const success = createBaseOptions();
    success.getAiRunByIdempotencyKey.mockResolvedValueOnce(null);
    success.preflight.mockResolvedValueOnce({ ok: true, value: { documentId: "doc_1" } });
    success.resolveProvider.mockResolvedValueOnce({
      model: "model-must-not-appear",
      ok: true,
      provider: { name: "stub" },
      providerName: "stub",
    });
    success.claimAiRun.mockResolvedValueOnce({ kind: "claimed", run: { id: "run_1", status: "pending" } });
    success.prepareFinalization.mockReturnValueOnce({ outputText: "secret output", proposals: [] });
    success.completeAiRunWithProposals.mockResolvedValueOnce({
      proposals: [],
      run: { id: "run_1", status: "completed" },
    });
    success.mapFinalizedResult.mockReturnValueOnce({ run: { id: "run_1", status: "completed" } });
    await executeAiOperation({
      ...success,
      admission: { ...success.admission, telemetry: successTelemetry },
    });
    expect(successTelemetry).toHaveBeenCalledWith({
      duration: expect.any(Number),
      operation: "review",
      provider: "stub",
      requestId: "request-1",
      status: 200,
      type: "ai_execution",
    });
    expect(JSON.stringify(successTelemetry.mock.calls)).not.toMatch(/model-must-not-appear|secret output|fingerprint-1|operation-1|workspace_a/);

    const providerTelemetry = vi.fn();
    const providerFailure = createBaseOptions();
    providerFailure.getAiRunByIdempotencyKey.mockResolvedValueOnce(null);
    providerFailure.preflight.mockResolvedValueOnce({ ok: true, value: { documentId: "doc_1" } });
    providerFailure.resolveProvider.mockRejectedValueOnce(new Error("provider API key secret"));
    await executeAiOperation({
      ...providerFailure,
      admission: { ...providerFailure.admission, telemetry: providerTelemetry },
    });
    expect(providerTelemetry).toHaveBeenCalledWith({
      duration: expect.any(Number),
      errorClass: "provider_unavailable",
      operation: "review",
      requestId: "request-1",
      status: 500,
      type: "ai_execution",
    });
  });

  it("uses a non-throwing default telemetry emitter with only allowlisted metadata", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const options = createBaseOptions();
    const withoutInjectedTelemetry = {
      ...options,
      admission: { ...options.admission, telemetry: undefined },
    };

    const result = await executeAiOperation(withoutInjectedTelemetry);

    expect(result).toMatchObject({ ok: true, replayed: true });
    expect(info).toHaveBeenCalledWith({
      duration: expect.any(Number),
      operation: "review",
      requestId: "request-1",
      status: 200,
      type: "ai_execution",
    });
    expect(Object.keys(info.mock.calls[0]![0] as object).sort()).toEqual([
      "duration",
      "operation",
      "requestId",
      "status",
      "type",
    ]);
    expect(JSON.stringify(info.mock.calls)).not.toMatch(/workspace_a|operation-1|fingerprint-1|durable output/);
    info.mockRestore();
  });
});

describe("AI idempotency helpers", () => {
  it("maps durable runs to the exact public shell shape without internal identity fields", () => {
    expect(toPublicAiRun({
      commandType: "document_review",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      id: "run_1",
      idempotencyKey: "secret-key",
      inputSummaryJson: { prompt: "secret" },
      operationFingerprint: "secret-fingerprint",
      outputText: "secret-output",
      retryNotBeforeAt: new Date("2026-01-01T00:01:00.000Z"),
      status: "completed",
      workspaceId: "secret-workspace",
    }, "document_review")).toEqual({
      commandType: "document_review",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      id: "run_1",
      status: "completed",
    });
  });

  it("accepts bounded ASCII token keys, rejects malformed keys, and generates a UUID when omitted", () => {
    expect(resolveAiIdempotencyKey(new Headers({ "Idempotency-Key": "review_1:retry-2" }))).toEqual({
      key: "review_1:retry-2",
      ok: true,
      source: "client",
    });
    expect(resolveAiIdempotencyKey(new Headers({ "Idempotency-Key": "contains spaces" }))).toMatchObject({
      error: "Invalid Idempotency-Key header",
      ok: false,
      status: 400,
    });
    for (const invalid of ["", "a".repeat(129), "검토-key"]) {
      expect(resolveAiIdempotencyKey({ get: () => invalid } as unknown as Headers)).toMatchObject({
        error: "Invalid Idempotency-Key header",
        ok: false,
        status: 400,
      });
    }
    expect(resolveAiIdempotencyKey(new Headers(), () => "00000000-0000-4000-8000-000000000001")).toEqual({
      key: "00000000-0000-4000-8000-000000000001",
      ok: true,
      source: "generated",
    });
  });

  it("hashes canonical operation identity deterministically without returning raw sensitive input", async () => {
    const first = await createAiOperationFingerprint("review", {
      command: "secret instruction",
      documentId: "doc_1",
      variables: { audience: "board", tone: "direct" },
    });
    const reordered = await createAiOperationFingerprint("review", {
      variables: { tone: "direct", audience: "board" },
      documentId: "doc_1",
      command: "secret instruction",
    });
    const otherRoute = await createAiOperationFingerprint("rewrite", {
      command: "secret instruction",
      documentId: "doc_1",
      variables: { audience: "board", tone: "direct" },
    });

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(reordered).toBe(first);
    expect(otherRoute).not.toBe(first);
    expect(first).not.toContain("secret instruction");
  });

  it("uses locale-independent ordering for Unicode object keys", async () => {
    const localeCompare = vi.spyOn(String.prototype, "localeCompare").mockImplementation(() => {
      throw new Error("locale-sensitive comparison must not be used");
    });

    try {
      const first = await createAiOperationFingerprint("review", {
        variables: { "ä": "umlaut", z: "latin" },
      });
      const reordered = await createAiOperationFingerprint("review", {
        variables: { z: "latin", "ä": "umlaut" },
      });

      expect(reordered).toBe(first);
    } finally {
      localeCompare.mockRestore();
    }
  });
});
