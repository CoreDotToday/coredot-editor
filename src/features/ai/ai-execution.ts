import type { WorkspaceScope } from "@/features/auth/request-context";
import { isAiProviderName } from "@/features/ai/provider-catalog";
import { AiRunCollaborationFenceError } from "@/features/ai/ai-collaboration-fence";
import {
  emitAiExecutionTelemetry,
  normalizeAiExecutionErrorClass,
  type AiExecutionTelemetryEvent,
} from "@/features/observability/telemetry";

export { emitAiExecutionTelemetry } from "@/features/observability/telemetry";
export type { AiExecutionTelemetryEvent } from "@/features/observability/telemetry";

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export type AiIdempotencyKeyResult =
  | { key: string; ok: true; source: "client" | "generated" }
  | { error: string; ok: false; status: 400 };

export function resolveAiIdempotencyKey(
  headers: Headers,
  createUuid: () => string = () => crypto.randomUUID(),
): AiIdempotencyKeyResult {
  const key = headers.get("Idempotency-Key");
  if (key === null) {
    return { key: createUuid(), ok: true, source: "generated" };
  }
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    return { error: "Invalid Idempotency-Key header", ok: false, status: 400 };
  }
  return { key, ok: true, source: "client" };
}

export async function createAiOperationFingerprint(operation: "review" | "rewrite", payload: unknown) {
  const encoded = new TextEncoder().encode(canonicalJson({ operation, payload }));
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("AI operation identity must be JSON-compatible");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => item === undefined ? "null" : canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  throw new TypeError("AI operation identity must be JSON-compatible");
}

export type AiExecutionStepFailure = {
  code?: string;
  details?: unknown;
  error: string;
  ok: false;
  response?: Response;
  status: number;
};

export type AiExecutionStepSuccess<T> = { ok: true; value: T };

export type DurableAiRun = {
  commandType?: "document_review" | "selection_rewrite";
  createdAt?: Date;
  executionToken?: string | null;
  id: string;
  idempotencyKey?: string | null;
  operationFingerprint?: string | null;
  outputText?: string;
  retryNotBeforeAt?: Date | null;
  status: string;
};

export type DurableAiOperation = {
  proposals: unknown[];
  run: DurableAiRun;
};

export type AiRunClaim =
  | { kind: "claimed"; run: DurableAiRun & { executionToken: string } }
  | ({ kind: "completed" } & DurableAiOperation)
  | { kind: "conflict" }
  | { kind: "in_progress"; run: DurableAiRun };

export type ProviderReadiness<TProvider> = {
  model: string;
  ok: true;
  provider: TProvider;
  providerName: string;
} | AiExecutionStepFailure;

export type AiExecutionAdmission = {
  kind: "ai_execution_admitted";
  operation: "review" | "rewrite";
  requestId: string;
  startedAt: number;
  telemetry?: (event: AiExecutionTelemetryEvent) => Promise<void> | void;
};

export type AiExecutionAdmissionResult =
  | { admission: AiExecutionAdmission; ok: true }
  | AiExecutionStepFailure;

export async function admitAiOperation(options: {
  admitRequest: () => Promise<Response | null>;
  deadlineMs: number;
  operation: "review" | "rewrite";
  requestSignal?: AbortSignal;
  requestId: string;
  telemetry?: (event: AiExecutionTelemetryEvent) => Promise<void> | void;
}): Promise<AiExecutionAdmissionResult> {
  const admission: AiExecutionAdmission = {
    kind: "ai_execution_admitted",
    operation: options.operation,
    requestId: options.requestId,
    startedAt: Date.now(),
    telemetry: options.telemetry,
  };
  let response: Response | null;
  const lifecycle = createAiExecutionLifecycle(options.deadlineMs, options.requestSignal);
  try {
    response = await lifecycle.run(options.admitRequest);
  } catch (error) {
    const failure = classifyLifecycleOr(error, executionUnavailableFailure());
    emitTelemetry(admission, failure);
    return failure;
  } finally {
    lifecycle.dispose();
  }
  if (response) {
    const failure: AiExecutionStepFailure = {
      code: "request_budget_denied",
      error: "Request denied",
      ok: false,
      response,
      status: response.status,
    };
    emitTelemetry(admission, failure);
    return failure;
  }
  return { admission, ok: true };
}

export type AiExecutionOptions<TContext, TProvider, TOutput, TResult> = {
  admission: AiExecutionAdmission;
  claimAiRun: (
    scope: WorkspaceScope,
    input: {
      commandType: "document_review" | "selection_rewrite";
      documentId: string;
      idempotencyKey: string;
      inputSummaryJson: Record<string, unknown>;
      model: string;
      operationFingerprint: string;
      promptTemplateId: string | null;
      provider: string;
    },
  ) => Promise<AiRunClaim>;
  completeAiRunWithProposals: (
    scope: WorkspaceScope,
    id: string,
    executionToken: string,
    outputText: string,
    proposals: unknown[],
  ) => Promise<DurableAiOperation | null>;
  deadlineMs: number;
  execute: (context: TContext, provider: TProvider, signal: AbortSignal) => Promise<TOutput>;
  failAiRun: (
    scope: WorkspaceScope,
    id: string,
    executionToken: string,
    errorMessage: string,
    options?: { retryNotBeforeAt?: Date | null },
  ) => Promise<unknown>;
  getAiRunByIdempotencyKey: (scope: WorkspaceScope, key: string) => Promise<DurableAiOperation | null>;
  idempotencyKey: string;
  mapDurableResult: (durable: DurableAiOperation) => TResult;
  mapFinalizedResult: (durable: DurableAiOperation, output: TOutput, context: TContext) => TResult;
  operationFingerprint: string | (() => Promise<string>);
  preflight: () => Promise<AiExecutionStepSuccess<TContext> | AiExecutionStepFailure>;
  prepareFinalization: (
    output: TOutput,
    context: TContext,
  ) => { outputText: string; proposals: unknown[] };
  requestSignal?: AbortSignal;
  resolveProvider: (context: TContext) => Promise<ProviderReadiness<TProvider>>;
  runInput: {
    collaborationSnapshot?: {
      contentHash: string;
      documentId: string;
      generation: number;
      headSeq: number;
      schemaFingerprint: string;
      stateVector: Uint8Array;
    };
    commandType: "document_review" | "selection_rewrite";
    documentId: string;
    inputSummaryJson: Record<string, unknown>;
    promptTemplateId: string | null;
  } | ((context: TContext) => {
    collaborationSnapshot?: {
      contentHash: string;
      documentId: string;
      generation: number;
      headSeq: number;
      schemaFingerprint: string;
      stateVector: Uint8Array;
    };
    commandType: "document_review" | "selection_rewrite";
    documentId: string;
    inputSummaryJson: Record<string, unknown>;
    promptTemplateId: string | null;
  });
  scope: WorkspaceScope;
};

export type AiExecutionResult<T> =
  | { ok: true; replayed: boolean; value: T }
  | AiExecutionStepFailure;

export function toPublicAiRun(
  value: unknown,
  fallbackCommandType: "document_review" | "selection_rewrite",
) {
  if (!value || typeof value !== "object") throw new Error("Malformed durable AI run");
  const run = value as {
    commandType?: unknown;
    createdAt?: unknown;
    id?: unknown;
    status?: unknown;
  };
  if (
    typeof run.id !== "string" ||
    typeof run.status !== "string" ||
    !["pending", "streaming", "completed", "failed"].includes(run.status)
  ) {
    throw new Error("Malformed durable AI run");
  }
  const commandType = run.commandType === "document_review" || run.commandType === "selection_rewrite"
    ? run.commandType
    : fallbackCommandType;
  return {
    commandType,
    ...(run.createdAt instanceof Date || typeof run.createdAt === "string" ? { createdAt: run.createdAt } : {}),
    id: run.id,
    status: run.status,
  };
}

class AiOperationTimeoutError extends Error {
  constructor() {
    super("Operation timed out");
    this.name = "AiOperationTimeoutError";
  }
}

class AiRequestAbortedError extends Error {
  constructor() {
    super("Request aborted");
    this.name = "AiRequestAbortedError";
  }
}

export async function executeAiOperation<TContext, TProvider, TOutput, TResult>(
  options: AiExecutionOptions<TContext, TProvider, TOutput, TResult>,
): Promise<AiExecutionResult<TResult>> {
  const elapsedMs = Math.max(0, Date.now() - options.admission.startedAt);
  const lifecycle = createAiExecutionLifecycle(
    Math.max(0, options.deadlineMs - elapsedMs),
    options.requestSignal,
  );
  const startedAt = options.admission.startedAt;
  const finish = async (
    result: AiExecutionResult<TResult>,
    provider?: string,
  ): Promise<AiExecutionResult<TResult>> => {
    emitTelemetry(options.admission, result, provider, startedAt);
    return result;
  };

  try {
    let operationFingerprint: string;
    try {
      operationFingerprint = await lifecycle.run(() => typeof options.operationFingerprint === "function"
        ? options.operationFingerprint()
        : options.operationFingerprint);
    } catch (error) {
      return finish(classifyLifecycleOr(error, executionUnavailableFailure()));
    }

    let existing: DurableAiOperation | null;
    try {
      existing = await lifecycle.run(() =>
        options.getAiRunByIdempotencyKey(options.scope, options.idempotencyKey));
    } catch (error) {
      return finish(classifyLifecycleOr(error, executionUnavailableFailure()));
    }
    const existingResult = mapExistingOperation(operationFingerprint, existing, options.mapDurableResult);
    if (existingResult) return finish(existingResult);

    let preflight: AiExecutionStepSuccess<TContext> | AiExecutionStepFailure;
    try {
      preflight = await lifecycle.run(options.preflight);
    } catch (error) {
      return finish(classifyLifecycleOr(error, preflightFailure()));
    }
    if (!preflight.ok) return finish(normalizePreflightFailure(preflight));

    let providerResult: ProviderReadiness<TProvider>;
    try {
      providerResult = await lifecycle.run(() => options.resolveProvider(preflight.value));
    } catch (error) {
      return finish(classifyLifecycleOr(error, providerUnavailableFailure()));
    }
    if (!providerResult.ok) return finish(providerUnavailableFailure(providerResult.status));

    const runInput = typeof options.runInput === "function"
      ? options.runInput(preflight.value)
      : options.runInput;
    let claimPromise: Promise<AiRunClaim> | undefined;
    let claim: AiRunClaim;
    try {
      claimPromise = Promise.resolve().then(() => options.claimAiRun(options.scope, {
        ...runInput,
        idempotencyKey: options.idempotencyKey,
        model: providerResult.model,
        operationFingerprint,
        provider: providerResult.providerName,
      }));
      claim = await lifecycle.run(() => claimPromise!);
    } catch (error) {
      const failure = error instanceof AiRunCollaborationFenceError
        ? collaborationSnapshotConflictFailure()
        : classifyLifecycleOr(error, executionUnavailableFailure());
      if (claimPromise && isLifecycleError(error)) {
        void claimPromise.then((lateClaim) => {
          if (lateClaim.kind === "claimed") {
            startFailurePersistence(options, lateClaim.run.id, lateClaim.run.executionToken, failure);
          }
        }).catch(() => undefined);
      }
      return finish(failure, providerResult.providerName);
    }
    if (claim.kind !== "claimed") {
      return finish(mapClaimResult(claim, options.mapDurableResult), providerResult.providerName);
    }

    try {
      const output = await lifecycle.run((signal) =>
        options.execute(preflight.value, providerResult.provider, signal));
      const finalization = await lifecycle.run(() => options.prepareFinalization(output, preflight.value));
      const finalized = await lifecycle.run(() => options.completeAiRunWithProposals(
        options.scope,
        claim.run.id,
        claim.run.executionToken,
        finalization.outputText,
        finalization.proposals,
      ));
      if (!finalized) {
        return finish(inProgressFailure(), providerResult.providerName);
      }
      return finish({
        ok: true,
        replayed: false,
        value: options.mapFinalizedResult(finalized, output, preflight.value),
      }, providerResult.providerName);
    } catch (error) {
      const failure = classifyExecutionError(error);
      startFailurePersistence(options, claim.run.id, claim.run.executionToken, failure);
      return finish(failure, providerResult.providerName);
    }
  } finally {
    lifecycle.dispose();
  }
}

function startFailurePersistence<TContext, TProvider, TOutput, TResult>(
  options: AiExecutionOptions<TContext, TProvider, TOutput, TResult>,
  runId: string,
  executionToken: string,
  failure: AiExecutionStepFailure,
) {
  try {
    const retryNotBeforeAt = failure.code === "operation_timed_out" || failure.code === "request_aborted"
      ? new Date(Date.now() + options.deadlineMs)
      : undefined;
    const persisted = retryNotBeforeAt
      ? options.failAiRun(options.scope, runId, executionToken, failure.error, { retryNotBeforeAt })
      : options.failAiRun(options.scope, runId, executionToken, failure.error);
    void Promise.resolve(persisted).catch(() => undefined);
  } catch {
    // The primary bounded failure remains authoritative if persistence is unavailable.
  }
}

function emitTelemetry(
  admission: AiExecutionAdmission,
  result: AiExecutionResult<unknown>,
  provider?: string,
  startedAt = admission.startedAt,
) {
  const safeProvider = isAiProviderName(provider) ? provider : undefined;
  const rawErrorClass = !result.ok ? result.code ?? "unknown_failure" : undefined;
  const safeErrorClass = normalizeAiExecutionErrorClass(rawErrorClass);
  const event: AiExecutionTelemetryEvent = {
    duration: Math.max(0, Date.now() - startedAt),
    ...(safeErrorClass ? { errorClass: safeErrorClass } : {}),
    operation: admission.operation,
    ...(safeProvider ? { provider: safeProvider } : {}),
    requestId: admission.requestId,
    status: result.ok ? 200 : result.status,
    type: "ai_execution",
  };
  try {
    const emitted = (admission.telemetry ?? emitAiExecutionTelemetry)(event);
    void Promise.resolve(emitted).catch(() => undefined);
  } catch {
    // Telemetry is deliberately best-effort and must never affect the operation.
  }
}

function normalizePreflightFailure(failure: AiExecutionStepFailure): AiExecutionStepFailure {
  if (failure.status < 500) {
    return { ...failure, code: "preflight_rejected" };
  }
  return preflightFailure();
}

function preflightFailure(): AiExecutionStepFailure {
  return {
    code: "preflight_failed",
    error: "AI request could not be prepared",
    ok: false,
    status: 500,
  };
}

function providerUnavailableFailure(status = 500): AiExecutionStepFailure {
  return {
    code: "provider_unavailable",
    error: "AI generation failed",
    ok: false,
    status: status >= 400 && status <= 599 ? status : 500,
  };
}

function executionUnavailableFailure(): AiExecutionStepFailure {
  return {
    code: "ai_execution_unavailable",
    error: "AI execution is temporarily unavailable",
    ok: false,
    status: 500,
  };
}

function mapExistingOperation<TResult>(
  operationFingerprint: string,
  existing: DurableAiOperation | null,
  mapDurableResult: (durable: DurableAiOperation) => TResult,
): AiExecutionResult<TResult> | null {
  if (!existing) return null;
  if (existing.run.operationFingerprint !== operationFingerprint) return conflictFailure();
  if (
    existing.run.status === "failed" &&
    existing.run.retryNotBeforeAt &&
    existing.run.retryNotBeforeAt.getTime() > Date.now()
  ) {
    return inProgressFailure();
  }
  if (existing.run.status === "failed") return null;
  if (existing.run.status === "completed") {
    try {
      return { ok: true, replayed: true, value: mapDurableResult(existing) };
    } catch {
      return {
        code: "invalid_durable_result",
        error: "Stored AI result is unavailable",
        ok: false,
        status: 500,
      };
    }
  }
  return inProgressFailure();
}

function mapClaimResult<TResult>(
  claim: Exclude<AiRunClaim, { kind: "claimed" }>,
  mapDurableResult: (durable: DurableAiOperation) => TResult,
): AiExecutionResult<TResult> {
  if (claim.kind === "conflict") return conflictFailure();
  if (claim.kind === "in_progress") return inProgressFailure();
  try {
    return { ok: true, replayed: true, value: mapDurableResult(claim) };
  } catch {
    return {
      code: "invalid_durable_result",
      error: "Stored AI result is unavailable",
      ok: false,
      status: 500,
    };
  }
}

function conflictFailure(): AiExecutionStepFailure {
  return {
    code: "idempotency_key_reused",
    error: "Idempotency key was already used for another operation",
    ok: false,
    status: 409,
  };
}

function inProgressFailure(): AiExecutionStepFailure {
  return {
    code: "ai_operation_in_progress",
    error: "AI operation is already in progress",
    ok: false,
    status: 409,
  };
}

function collaborationSnapshotConflictFailure(): AiExecutionStepFailure {
  return {
    code: "collaboration_snapshot_conflict",
    error: "Collaboration snapshot is not available for this request",
    ok: false,
    status: 409,
  };
}

function createAiExecutionLifecycle(
  deadlineMs: number,
  requestSignal?: AbortSignal,
) {
  const controller = new AbortController();
  const timeoutError = new AiOperationTimeoutError();
  const requestAbortError = new AiRequestAbortedError();
  let interruption: AiOperationTimeoutError | AiRequestAbortedError | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectAbort!: (error: Error) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  void aborted.catch(() => undefined);
  const abortForRequest = () => {
    if (interruption) return;
    interruption = requestAbortError;
    controller.abort(requestAbortError);
    rejectAbort(requestAbortError);
  };
  const abortForDeadline = () => {
    if (interruption) return;
    interruption = timeoutError;
    controller.abort(timeoutError);
    rejectAbort(timeoutError);
  };

  if (requestSignal?.aborted) {
    abortForRequest();
  } else if (deadlineMs <= 0) {
    abortForDeadline();
  } else {
    requestSignal?.addEventListener("abort", abortForRequest, { once: true });
    timer = setTimeout(abortForDeadline, Math.max(0, deadlineMs));
  }

  return {
    dispose() {
      if (timer) clearTimeout(timer);
      requestSignal?.removeEventListener("abort", abortForRequest);
    },
    async run<T>(operation: (signal: AbortSignal) => Promise<T> | T): Promise<T> {
      if (interruption) throw interruption;
      const execution = Promise.resolve().then(() => {
        if (interruption) throw interruption;
        return operation(controller.signal);
      });
      return Promise.race([execution, aborted]);
    },
  };
}

function isLifecycleError(error: unknown): error is AiOperationTimeoutError | AiRequestAbortedError {
  return error instanceof AiOperationTimeoutError || error instanceof AiRequestAbortedError;
}

function classifyLifecycleOr(
  error: unknown,
  fallback: AiExecutionStepFailure,
): AiExecutionStepFailure {
  return isLifecycleError(error) ? classifyExecutionError(error) : fallback;
}

function classifyExecutionError(error: unknown): AiExecutionStepFailure {
  if (error instanceof AiRunCollaborationFenceError) {
    return collaborationSnapshotConflictFailure();
  }
  if (error instanceof AiOperationTimeoutError) {
    return {
      code: "operation_timed_out",
      error: "Operation timed out",
      ok: false,
      status: 504,
    };
  }
  if (error instanceof AiRequestAbortedError) {
    return {
      code: "request_aborted",
      error: "Request aborted",
      ok: false,
      status: 408,
    };
  }
  return {
    code: "ai_generation_failed",
    error: "AI generation failed",
    ok: false,
    status: 500,
  };
}
