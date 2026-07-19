import { act, renderHook, waitFor } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import * as Y from "yjs";
import { describe, expect, it, vi } from "vitest";

import { getProjectProfile } from "@/features/projects/default-project-profiles";

import { createCollaborationSessionStore } from "./session-store";
import {
  useCollaborationSession,
  type CollaborationSessionHookDependencies,
} from "./use-collaboration-session";

const configuration = {
  documentId: "document-a",
  projectProfile: getProjectProfile("default"),
  room: "collab:v1:workspace-a:document-a:g1",
  schemaFingerprint: "a".repeat(64),
  websocketUrl: "wss://collaboration.example.test/",
};

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
          provider: null,
          refreshCapability: vi.fn(async () => undefined),
          room: options.room,
          store: options.store,
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
    provider: null,
    refreshCapability: vi.fn(async () => undefined),
    room: options.room,
    store: options.store,
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
