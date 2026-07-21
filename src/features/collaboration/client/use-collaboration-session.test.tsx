import { act, renderHook, waitFor } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import * as Y from "yjs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getProjectProfile } from "@/features/projects/default-project-profiles";

import { createCollaborationSessionStore } from "./session-store";
import {
  useCollaborationSession,
  type CollaborationSessionHookDependencies,
} from "./use-collaboration-session";

const configuration = {
  currentPrincipalId: "principal-a",
  documentId: "document-a",
  projectProfile: getProjectProfile("default"),
  room: "collab:v1:workspace-a:document-a:g1",
  schemaFingerprint: "a".repeat(64),
  websocketUrl: "wss://collaboration.example.test/",
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useCollaborationSession", () => {
  it("creates one exact-room session, stays read-only until sync, and tears it down", async () => {
    const harness = createHarness();
    const { result, unmount } = renderHook(() => useCollaborationSession(configuration, harness.dependencies));

    await waitFor(() => expect(harness.connect).toHaveBeenCalledOnce());
    expect(harness.createSession).toHaveBeenCalledWith(expect.objectContaining({
      document: harness.document,
      room: configuration.room,
      store: harness.store,
      url: configuration.websocketUrl,
    }));
    expect(result.current.snapshot.writable).toBe(false);

    act(() => {
      harness.store.markAuthenticated("read-write");
      harness.store.markTransportSynced();
    });
    expect(result.current.snapshot).toMatchObject({ status: "synced", writable: true });

    unmount();
    expect(harness.destroy).toHaveBeenCalledOnce();
  });

  it("fetches short-lived capabilities without exposing the token in React state", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      expiresInSeconds: 60,
      room: configuration.room,
      token: "sensitive-short-lived-token",
    }), { headers: { "content-type": "application/json" }, status: 200 }));
    const harness = createHarness({ fetch });
    const { result } = renderHook(() => useCollaborationSession(configuration, harness.dependencies));
    await waitFor(() => expect(harness.createSession).toHaveBeenCalledOnce());

    const factoryOptions = harness.createSession.mock.calls[0]![0];
    await expect(factoryOptions.issueCapability()).resolves.toEqual({
      expiresInSeconds: 60,
      room: configuration.room,
      token: "sensitive-short-lived-token",
    });

    expect(fetch).toHaveBeenCalledWith(
      "/api/documents/document-a/collaboration-capability",
      expect.objectContaining({ cache: "no-store", method: "POST" }),
    );
    expect(JSON.stringify(result.current.snapshot)).not.toContain("sensitive-short-lived-token");
  });

  it("retries a retryable 503 capability response before succeeding", async () => {
    const responses = [
      new Response(null, { headers: { "retry-after": "0" }, status: 503 }),
      new Response(null, { headers: { "retry-after": "0" }, status: 503 }),
      new Response(JSON.stringify({
        expiresInSeconds: 60,
        room: configuration.room,
        token: "token-after-retry",
      }), { headers: { "content-type": "application/json" }, status: 200 }),
    ];
    const fetch = vi.fn(async () => responses.shift()!);
    const harness = createHarness({ fetch });
    renderHook(() => useCollaborationSession(configuration, harness.dependencies));
    await waitFor(() => expect(harness.createSession).toHaveBeenCalledOnce());

    const factoryOptions = harness.createSession.mock.calls[0]![0];
    await expect(factoryOptions.issueCapability()).resolves.toMatchObject({
      token: "token-after-retry",
    });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("gives up on capability issuance after bounded 503 retries", async () => {
    const fetch = vi.fn(async () => new Response(null, {
      headers: { "retry-after": "0" },
      status: 503,
    }));
    const harness = createHarness({ fetch });
    renderHook(() => useCollaborationSession(configuration, harness.dependencies));
    await waitFor(() => expect(harness.createSession).toHaveBeenCalledOnce());

    const factoryOptions = harness.createSession.mock.calls[0]![0];
    await expect(factoryOptions.issueCapability()).rejects.toThrow("Collaboration capability unavailable");
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("does not retry a non-retryable capability failure", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 404 }));
    const harness = createHarness({ fetch });
    renderHook(() => useCollaborationSession(configuration, harness.dependencies));
    await waitFor(() => expect(harness.createSession).toHaveBeenCalledOnce());

    const factoryOptions = harness.createSession.mock.calls[0]![0];
    await expect(factoryOptions.issueCapability()).rejects.toThrow("Collaboration capability unavailable");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps an initialized document in fatal read-only mode when its public URL is unavailable", () => {
    const harness = createHarness();
    const { result } = renderHook(() => useCollaborationSession(
      { ...configuration, websocketUrl: null },
      harness.dependencies,
    ));

    return waitFor(() => {
      expect(result.current.session).toBeNull();
      expect(result.current.snapshot).toMatchObject({ status: "fatal", writable: false });
      expect(harness.createSession).not.toHaveBeenCalled();
      expect(harness.connect).not.toHaveBeenCalled();
    });
  });

  it("keeps a stale browser schema on the read-only SQL projection without creating a provider", async () => {
    const harness = createHarness({ fingerprintSchema: async () => "b".repeat(64) });
    const { result } = renderHook(() => useCollaborationSession(configuration, harness.dependencies));

    await waitFor(() => expect(result.current.snapshot.status).toBe("read_only"));

    expect(result.current).toMatchObject({ session: null, snapshot: { writable: false } });
    expect(harness.createSession).not.toHaveBeenCalled();
    expect(harness.connect).not.toHaveBeenCalled();
  });

  it("installs a fatal read-only session when the provider factory throws synchronously", async () => {
    const document = new Y.Doc();
    const destroyDocument = vi.spyOn(document, "destroy");
    const store = createCollaborationSessionStore();
    const dependencies: CollaborationSessionHookDependencies = {
      createDocument: () => document,
      createSession: vi.fn(() => {
        throw new Error("provider internals must not escape");
      }),
      createStore: () => store,
      fetch: vi.fn(async () => new Response(null, { status: 503 })),
      fingerprintSchema: async () => configuration.schemaFingerprint,
    };

    const { result, unmount } = renderHook(() => useCollaborationSession(configuration, dependencies));

    await waitFor(() => expect(result.current.snapshot.status).toBe("fatal"));
    expect(result.current).toMatchObject({ session: null, snapshot: { writable: false } });
    expect(destroyDocument).not.toHaveBeenCalled();

    unmount();
    expect(destroyDocument).toHaveBeenCalledOnce();
  });

  it("falls back to a fatal store when the injected store factory throws synchronously", async () => {
    const document = new Y.Doc();
    const destroyDocument = vi.spyOn(document, "destroy");
    const dependencies: CollaborationSessionHookDependencies = {
      createDocument: () => document,
      createSession: vi.fn(),
      createStore: vi.fn(() => {
        throw new Error("store construction failed");
      }),
      fetch: vi.fn(async () => new Response(null, { status: 503 })),
      fingerprintSchema: async () => configuration.schemaFingerprint,
    };

    const { result, unmount } = renderHook(() => useCollaborationSession(configuration, dependencies));

    await waitFor(() => expect(result.current.snapshot.status).toBe("fatal"));
    expect(result.current).toMatchObject({ session: null, snapshot: { writable: false } });
    expect(dependencies.createSession).not.toHaveBeenCalled();

    unmount();
    expect(destroyDocument).toHaveBeenCalledOnce();
  });

  it("destroys each successful session and document exactly once across document and Principal churn", async () => {
    const documents: Y.Doc[] = [];
    const destroyDocuments: Array<ReturnType<typeof vi.spyOn>> = [];
    const destroySessions: Array<ReturnType<typeof vi.fn>> = [];
    const dependencies: CollaborationSessionHookDependencies = {
      createDocument: () => {
        const document = new Y.Doc();
        documents.push(document);
        destroyDocuments.push(vi.spyOn(document, "destroy"));
        return document;
      },
      createSession: vi.fn((options) => {
        const destroy = vi.fn();
        destroySessions.push(destroy);
        return {
          connect: vi.fn(async () => undefined),
          destroy,
          document: options.document,
          flushPendingUpdates: vi.fn(async () => ({ generation: 1, stateVector: new Uint8Array([0]) })),
          provider: null,
          refreshCapability: vi.fn(async () => undefined),
          room: options.room,
          store: options.store,
          subscribeWorkflowChanged: vi.fn(() => () => undefined),
        };
      }),
      createStore: createCollaborationSessionStore,
      fetch: vi.fn(async () => new Response(null, { status: 503 })),
      fingerprintSchema: async () => configuration.schemaFingerprint,
    };
    const { result, rerender, unmount } = renderHook(
      ({ currentPrincipalId, documentId }) => useCollaborationSession({
        ...configuration,
        currentPrincipalId,
        documentId,
        room: `collab:v1:workspace-a:${documentId}:g1`,
      }, dependencies),
      { initialProps: { currentPrincipalId: "principal-a", documentId: "document-a" } },
    );

    await waitFor(() => expect(dependencies.createSession).toHaveBeenCalledTimes(1));
    rerender({ currentPrincipalId: "principal-a", documentId: "document-b" });
    await waitFor(() => expect(dependencies.createSession).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.session?.room).toBe("collab:v1:workspace-a:document-b:g1"));

    expect(destroySessions[0]).toHaveBeenCalledOnce();
    expect(destroyDocuments[0]).toHaveBeenCalledOnce();

    rerender({ currentPrincipalId: "principal-b", documentId: "document-b" });
    await waitFor(() => expect(dependencies.createSession).toHaveBeenCalledTimes(3));
    expect(destroySessions[1]).toHaveBeenCalledOnce();
    expect(destroyDocuments[1]).toHaveBeenCalledOnce();

    unmount();
    expect(destroySessions.every((destroy) => destroy.mock.calls.length === 1)).toBe(true);
    expect(destroyDocuments.every((destroy) => destroy.mock.calls.length === 1)).toBe(true);
    expect(documents.every((document) => document.isDestroyed)).toBe(true);
  });

  it("defers unmount cleanup while durability is pending and cleans up on acknowledgement", async () => {
    const harness = createHarness();
    harness.store.recordLocalUpdate("a".repeat(64));
    harness.store.markAwaitingDurableAcknowledgement("a".repeat(64));
    const destroyDocument = vi.spyOn(harness.document, "destroy");
    const { unmount } = renderHook(() => useCollaborationSession(configuration, harness.dependencies));
    await waitFor(() => expect(harness.createSession).toHaveBeenCalledOnce());

    unmount();
    expect(harness.destroy).not.toHaveBeenCalled();
    expect(destroyDocument).not.toHaveBeenCalled();

    act(() => harness.store.acknowledgeDurableUpdate("a".repeat(64)));
    await waitFor(() => expect(harness.destroy).toHaveBeenCalledOnce());
    expect(destroyDocument).toHaveBeenCalledOnce();
  });

  it("bounds deferred cleanup, emits a generic warning, and remains exact-once after timeout", async () => {
    const harness = createHarness();
    harness.store.recordLocalUpdate("b".repeat(64));
    harness.store.markAwaitingDurableAcknowledgement("b".repeat(64));
    const destroyDocument = vi.spyOn(harness.document, "destroy");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { unmount } = renderHook(() => useCollaborationSession(configuration, harness.dependencies));
    await waitFor(() => expect(harness.createSession).toHaveBeenCalledOnce());
    vi.useFakeTimers();

    unmount();
    vi.advanceTimersByTime(1);
    expect(harness.destroy).not.toHaveBeenCalled();

    vi.runOnlyPendingTimers();
    expect(warning).toHaveBeenCalledOnce();
    expect(warning.mock.calls[0]?.[0]).toBe("Collaboration cleanup timed out");
    expect(harness.destroy).toHaveBeenCalledOnce();
    expect(destroyDocument).toHaveBeenCalledOnce();

    act(() => harness.store.acknowledgeDurableUpdate("b".repeat(64)));
    expect(harness.destroy).toHaveBeenCalledOnce();
    expect(destroyDocument).toHaveBeenCalledOnce();
  });

  it("destroys the Y.Doc even when session teardown throws", async () => {
    const harness = createHarness();
    harness.destroy.mockImplementation(() => {
      throw new Error("provider teardown detail");
    });
    const destroyDocument = vi.spyOn(harness.document, "destroy");
    const { unmount } = renderHook(() => useCollaborationSession(configuration, harness.dependencies));
    await waitFor(() => expect(harness.createSession).toHaveBeenCalledOnce());

    expect(() => unmount()).not.toThrow();
    expect(harness.destroy).toHaveBeenCalledOnce();
    expect(destroyDocument).toHaveBeenCalledOnce();
  });

  it("destroys every session created by StrictMode's mount probe", async () => {
    const documents: Y.Doc[] = [];
    const destroys: Array<ReturnType<typeof vi.fn>> = [];
    const dependencies: CollaborationSessionHookDependencies = {
      createDocument: () => {
        const document = new Y.Doc();
        documents.push(document);
        return document;
      },
      createSession: vi.fn((options) => {
        const destroy = vi.fn();
        destroys.push(destroy);
        return {
          connect: vi.fn(async () => undefined),
          destroy,
          document: options.document,
          flushPendingUpdates: vi.fn(async () => ({ generation: 1, stateVector: new Uint8Array([0]) })),
          provider: null,
          refreshCapability: vi.fn(async () => undefined),
          room: options.room,
          store: options.store,
          subscribeWorkflowChanged: vi.fn(() => () => undefined),
        };
      }),
      createStore: createCollaborationSessionStore,
      fetch: vi.fn(async () => new Response(null, { status: 503 })),
      fingerprintSchema: async () => configuration.schemaFingerprint,
    };
    const wrapper = ({ children }: { children: ReactNode }) => (
      <StrictMode>{children}</StrictMode>
    );

    const { unmount } = renderHook(
      () => useCollaborationSession(configuration, dependencies),
      { wrapper },
    );
    await waitFor(() => expect(dependencies.createSession).toHaveBeenCalled());

    unmount();
    expect(destroys).toHaveLength(documents.length);
    expect(destroys.every((destroy) => destroy.mock.calls.length === 1)).toBe(true);
    expect(documents.every((document) => document.isDestroyed)).toBe(true);
  });
});

function createHarness(overrides: {
  fetch?: typeof fetch;
  fingerprintSchema?: CollaborationSessionHookDependencies["fingerprintSchema"];
} = {}) {
  const store = createCollaborationSessionStore();
  const document = new Y.Doc();
  const connect = vi.fn(async () => undefined);
  const destroy = vi.fn();
  const createSession = vi.fn((options: Parameters<CollaborationSessionHookDependencies["createSession"]>[0]) => ({
    connect,
    destroy,
    document: options.document,
    flushPendingUpdates: vi.fn(async () => ({ generation: 1, stateVector: new Uint8Array([0]) })),
    provider: null,
    refreshCapability: vi.fn(async () => undefined),
    room: options.room,
    store: options.store,
    subscribeWorkflowChanged: vi.fn(() => () => undefined),
  }));
  const dependencies: CollaborationSessionHookDependencies = {
    createDocument: () => document,
    createSession,
    createStore: () => store,
    fetch: overrides.fetch ?? vi.fn(async () => new Response(null, { status: 503 })),
    fingerprintSchema: overrides.fingerprintSchema ?? (async () => configuration.schemaFingerprint),
  };
  return { connect, createSession, dependencies, destroy, document, store };
}
