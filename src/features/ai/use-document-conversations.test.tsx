import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  ConversationStore,
  StoredConversationSummary,
  StoredConversationView,
} from "./conversation-store";
import { useDocumentConversations } from "./use-document-conversations";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function conversation(overrides: Partial<StoredConversationView> = {}): StoredConversationView {
  return {
    archived: false,
    command: "Rewrite",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    documentId: "doc-a",
    id: "conversation-a",
    latestAiRunId: null,
    latestProposalId: null,
    messageCount: 1,
    messages: [{
      aiRunId: null,
      command: "Rewrite",
      content: "Original",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      id: "message-a",
      proposalId: null,
      role: "user",
      scopeLabel: null,
    }],
    retentionExpiresAt: null,
    status: "idle",
    syncStatus: "saved",
    title: "Rewrite",
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    version: 1,
    ...overrides,
  };
}

function completedConversation(overrides: Partial<StoredConversationView> = {}): StoredConversationView {
  return conversation({
    messageCount: 2,
    messages: [
      ...conversation().messages,
      {
        aiRunId: null,
        command: "Rewrite",
        content: "Improved",
        createdAt: new Date("2026-01-01T00:00:01.000Z"),
        id: "message-b",
        proposalId: null,
        role: "assistant",
        scopeLabel: null,
      },
    ],
    version: 2,
    ...overrides,
  });
}

function conversationSummary(overrides: Partial<StoredConversationSummary> = {}): StoredConversationSummary {
  const { messages: _messages, ...summary } = conversation();
  void _messages;
  return { ...summary, ...overrides };
}

function store(overrides: Partial<ConversationStore> = {}): ConversationStore {
  const unavailable = vi.fn().mockResolvedValue({ ok: false, reason: "unavailable" });
  return {
    append: unavailable,
    archive: unavailable,
    create: unavailable,
    fork: unavailable,
    get: unavailable,
    list: vi.fn().mockResolvedValue({ ok: true, value: { items: [], nextCursor: null } }),
    rename: unavailable,
    setStatus: unavailable,
    ...overrides,
  };
}

describe("useDocumentConversations", () => {
  it("loads the first SSR summary transcript and retries a failed detail", async () => {
    const get = vi.fn()
      .mockResolvedValueOnce({ ok: false, reason: "unavailable" })
      .mockResolvedValueOnce({ ok: true, value: conversation() });
    const persistence = store({ get });
    const { result } = renderHook(() => useDocumentConversations({
      documentId: "doc-a",
      initialConversations: [conversationSummary()],
      storageMode: "database",
      store: persistence,
      workspaceId: "workspace-a",
    }));

    await waitFor(() => expect(result.current.sessions[0]?.transcriptState).toBe("failed"));
    expect(result.current.sessions[0]?.messages).toEqual([]);

    await act(async () => {
      await result.current.loadConversationDetail("conversation-a", true);
    });
    expect(result.current.sessions[0]).toMatchObject({
      messages: [{ content: "Original" }],
      transcriptState: "loaded",
    });
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("deduplicates the hook auto-load and active-panel selection while detail is loading", async () => {
    const detail = deferred<Awaited<ReturnType<ConversationStore["get"]>>>();
    const get = vi.fn(() => detail.promise);
    const persistence = store({ get });
    const { result } = renderHook(() => useDocumentConversations({
      documentId: "doc-a",
      initialConversations: [conversationSummary()],
      storageMode: "database",
      store: persistence,
      workspaceId: "workspace-a",
    }));
    await waitFor(() => expect(result.current.sessions[0]?.transcriptState).toBe("loading"));

    await act(async () => {
      void result.current.loadConversationDetail("conversation-a");
    });
    expect(get).toHaveBeenCalledTimes(1);

    detail.resolve({ ok: true, value: conversation() });
    await waitFor(() => expect(result.current.sessions[0]?.transcriptState).toBe("loaded"));
  });

  it("ignores a stale transcript response after the active conversation changes", async () => {
    const first = deferred<Awaited<ReturnType<ConversationStore["get"]>>>();
    const get = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce({
        ok: true,
        value: conversation({ id: "conversation-b", title: "B" }),
      });
    const persistence = store({ get });
    const { result } = renderHook(() => useDocumentConversations({
      documentId: "doc-a",
      initialConversations: [
        conversationSummary({ id: "conversation-a", title: "A" }),
        conversationSummary({ id: "conversation-b", title: "B" }),
      ],
      storageMode: "database",
      store: persistence,
      workspaceId: "workspace-a",
    }));
    await waitFor(() => expect(get).toHaveBeenCalledWith("doc-a", "conversation-a"));

    await act(async () => {
      await result.current.loadConversationDetail("conversation-b");
    });
    first.resolve({ ok: true, value: conversation({ id: "conversation-a", title: "A stale" }) });
    await act(async () => { await first.promise; });

    expect(result.current.sessions.find((session) => session.id === "conversation-b"))
      .toMatchObject({ messages: [{ content: "Original" }], transcriptState: "loaded" });
    expect(result.current.sessions.find((session) => session.id === "conversation-a"))
      .toMatchObject({ messages: [], transcriptState: "idle", title: "A" });
  });

  it("preserves a new optimistic session while loading an older cursor page", async () => {
    const olderPage = deferred<Awaited<ReturnType<ConversationStore["list"]>>>();
    const persistence = store({
      create: vi.fn().mockResolvedValue({ ok: false, reason: "unavailable" }),
      list: vi.fn(() => olderPage.promise),
    });
    const { result } = renderHook(() => useDocumentConversations({
      documentId: "doc-a",
      initialConversations: [conversation()],
      initialNextCursor: "older-cursor",
      storageMode: "database",
      store: persistence,
      workspaceId: "workspace-a",
    }));

    let loadMore!: Promise<void>;
    act(() => { loadMore = result.current.loadMore(); });
    act(() => {
      result.current.beginConversation({ command: "Summarize", content: "New", title: "New" });
    });
    olderPage.resolve({
      ok: true,
      value: {
        items: [conversationSummary({ id: "conversation-older", title: "Older" })],
        nextCursor: null,
      },
    });
    await act(async () => { await loadMore; });

    expect(result.current.sessions[0]).toMatchObject({ syncStatus: "unsaved", title: "New" });
    expect(result.current.sessions.map((session) => session.id)).toContain("conversation-older");
  });

  it("cancels a stale load-more spinner and payload when a reload supersedes it", async () => {
    const olderPage = deferred<Awaited<ReturnType<ConversationStore["list"]>>>();
    const list = vi.fn()
      .mockImplementationOnce(() => olderPage.promise)
      .mockResolvedValueOnce({
        ok: true,
        value: { items: [conversationSummary({ id: "conversation-refreshed" })], nextCursor: null },
      });
    const persistence = store({ list });
    const { result } = renderHook(() => useDocumentConversations({
      documentId: "doc-a",
      initialConversations: [conversation()],
      initialNextCursor: "older-cursor",
      storageMode: "database",
      store: persistence,
      workspaceId: "workspace-a",
    }));

    let loadingOlder!: Promise<void>;
    act(() => { loadingOlder = result.current.loadMore(); });
    expect(result.current.isLoadingMore).toBe(true);
    await act(async () => { await result.current.reload(); });
    expect(result.current.isLoadingMore).toBe(false);

    olderPage.resolve({
      ok: true,
      value: { items: [conversationSummary({ id: "conversation-stale" })], nextCursor: null },
    });
    await act(async () => { await loadingOlder; });
    expect(result.current.sessions.map((session) => session.id)).toEqual(["conversation-refreshed"]);
    expect(result.current.isLoadingMore).toBe(false);
  });

  it("does not let a delayed version-1 reload overwrite a version-2 rename or its loaded transcript", async () => {
    const staleReload = deferred<Awaited<ReturnType<ConversationStore["list"]>>>();
    const persistence = store({
      list: vi.fn(() => staleReload.promise),
      rename: vi.fn().mockResolvedValue({
        ok: true,
        value: conversation({ title: "Renamed", version: 2 }),
      }),
    });
    const { result } = renderHook(() => useDocumentConversations({
      documentId: "doc-a",
      initialConversations: [conversation()],
      storageMode: "database",
      store: persistence,
      workspaceId: "workspace-a",
    }));

    let reload!: Promise<void>;
    act(() => { reload = result.current.reload(); });
    await act(async () => {
      await result.current.renameConversation("conversation-a", "Renamed");
    });
    staleReload.resolve({
      ok: true,
      value: { items: [conversationSummary()], nextCursor: null },
    });
    await act(async () => { await reload; });

    expect(result.current.sessions[0]).toMatchObject({
      messages: [{ content: "Original" }],
      title: "Renamed",
      transcriptState: "loaded",
      version: 2,
    });
  });

  it("does not abandon an in-flight mutation when the same document is reloaded", async () => {
    const renameResult = deferred<Awaited<ReturnType<ConversationStore["rename"]>>>();
    const persistence = store({
      list: vi.fn().mockResolvedValue({
        ok: true,
        value: { items: [conversationSummary()], nextCursor: null },
      }),
      rename: vi.fn(() => renameResult.promise),
    });
    const { result } = renderHook(() => useDocumentConversations({
      documentId: "doc-a",
      initialConversations: [conversation()],
      storageMode: "database",
      store: persistence,
      workspaceId: "workspace-a",
    }));

    let renaming!: Promise<void>;
    act(() => { renaming = result.current.renameConversation("conversation-a", "Renamed"); });
    await act(async () => { await result.current.reload(); });
    expect(result.current.sessions[0]).toMatchObject({ syncStatus: "saving", title: "Renamed" });

    renameResult.resolve({
      ok: true,
      value: conversation({ title: "Renamed", version: 2 }),
    });
    await act(async () => { await renaming; });

    expect(result.current.sessions[0]).toMatchObject({
      syncStatus: "saved",
      title: "Renamed",
      version: 2,
    });
  });

  it("does not let a delayed version-1 list overwrite a version-2 append", async () => {
    const staleReload = deferred<Awaited<ReturnType<ConversationStore["list"]>>>();
    const persistence = store({
      append: vi.fn().mockResolvedValue({ ok: true, value: completedConversation() }),
      create: vi.fn().mockResolvedValue({ ok: true, value: conversation() }),
      list: vi.fn(() => staleReload.promise),
    });
    const { result } = renderHook(() => useDocumentConversations({
      documentId: "doc-a",
      initialConversations: [],
      storageMode: "database",
      store: persistence,
      workspaceId: "workspace-a",
    }));
    let attempt!: ReturnType<typeof result.current.beginConversation>;
    await act(async () => {
      attempt = result.current.beginConversation({ command: "Rewrite", content: "Original", title: "Rewrite" });
      await attempt.ready;
    });

    let reload!: Promise<void>;
    act(() => { reload = result.current.reload(); });
    await act(async () => {
      await result.current.completeConversation(attempt, { content: "Improved" });
    });
    staleReload.resolve({
      ok: true,
      value: { items: [conversationSummary()], nextCursor: null },
    });
    await act(async () => { await reload; });

    expect(result.current.sessions[0]).toMatchObject({
      messages: { length: 2 },
      syncStatus: "saved",
      version: 2,
    });
  });

  it("does not let a delayed version-1 detail overwrite a version-2 archive", async () => {
    const staleDetail = deferred<Awaited<ReturnType<ConversationStore["get"]>>>();
    const persistence = store({
      archive: vi.fn().mockResolvedValue({
        ok: true,
        value: conversation({ archived: true, version: 2 }),
      }),
      get: vi.fn(() => staleDetail.promise),
    });
    const { result } = renderHook(() => useDocumentConversations({
      documentId: "doc-a",
      initialConversations: [conversationSummary()],
      storageMode: "database",
      store: persistence,
      workspaceId: "workspace-a",
    }));
    await waitFor(() => expect(result.current.sessions[0]?.transcriptState).toBe("loading"));

    await act(async () => {
      await result.current.archiveConversation("conversation-a");
    });
    staleDetail.resolve({ ok: true, value: conversation() });
    await act(async () => { await staleDetail.promise; });

    expect(result.current.sessions[0]).toMatchObject({
      archived: true,
      transcriptState: "loaded",
      version: 2,
    });
  });

  it("invalidates a loaded transcript when a newer summary arrives", async () => {
    const refreshedDetail = deferred<Awaited<ReturnType<ConversationStore["get"]>>>();
    const persistence = store({
      get: vi.fn(() => refreshedDetail.promise),
      list: vi.fn().mockResolvedValue({
        ok: true,
        value: {
          items: [conversationSummary({ messageCount: 2, title: "Server update", version: 2 })],
          nextCursor: null,
        },
      }),
    });
    const { result } = renderHook(() => useDocumentConversations({
      documentId: "doc-a",
      initialConversations: [conversation()],
      storageMode: "database",
      store: persistence,
      workspaceId: "workspace-a",
    }));

    await act(async () => { await result.current.reload(); });
    expect(result.current.sessions[0]).toMatchObject({
      messages: [],
      title: "Server update",
      transcriptState: "loading",
      version: 2,
    });

    refreshedDetail.resolve({ ok: true, value: completedConversation({ version: 3 }) });
    await act(async () => { await refreshedDetail.promise; });
    expect(result.current.sessions[0]).toMatchObject({
      messages: { length: 2 },
      transcriptState: "loaded",
      version: 3,
    });
  });

  it("retries the same conversation cursor after a load-more failure", async () => {
    const list = vi.fn()
      .mockResolvedValueOnce({ ok: false, reason: "unavailable" })
      .mockResolvedValueOnce({
        ok: true,
        value: { items: [conversationSummary({ id: "conversation-older" })], nextCursor: null },
      });
    const persistence = store({ list });
    const { result } = renderHook(() => useDocumentConversations({
      documentId: "doc-a",
      initialConversations: [conversation()],
      initialNextCursor: "older-cursor",
      storageMode: "database",
      store: persistence,
      workspaceId: "workspace-a",
    }));

    await act(async () => { await result.current.loadMore(); });
    expect(result.current.loadMoreErrorReason).toBe("unavailable");
    expect(result.current.errorReason).toBe("unavailable");

    await act(async () => { await result.current.loadMore(); });
    expect(list).toHaveBeenNthCalledWith(1, { cursor: "older-cursor", documentId: "doc-a" });
    expect(list).toHaveBeenNthCalledWith(2, { cursor: "older-cursor", documentId: "doc-a" });
    expect(result.current.sessions.map((session) => session.id)).toContain("conversation-older");
    expect(result.current.loadMoreErrorReason).toBeNull();
    expect(result.current.errorReason).toBeNull();
  });

  it("keeps execution and persistence state separate while creating and completing a conversation", async () => {
    const createResult = deferred<Awaited<ReturnType<ConversationStore["create"]>>>();
    const appendResult = deferred<Awaited<ReturnType<ConversationStore["append"]>>>();
    const persistence = store({
      create: vi.fn(() => createResult.promise),
      append: vi.fn(() => appendResult.promise),
    });
    const { result } = renderHook(() => useDocumentConversations({
      documentId: "doc-a",
      initialConversations: [],
      storageMode: "database",
      store: persistence,
      workspaceId: "workspace-a",
    }));

    let attempt!: ReturnType<typeof result.current.beginConversation>;
    act(() => {
      attempt = result.current.beginConversation({ command: "Rewrite", content: "Original", title: "Rewrite" });
    });
    expect(result.current.sessions[0]).toMatchObject({ status: "running", syncStatus: "saving" });

    createResult.resolve({ ok: true, value: conversation() });
    await act(async () => { await attempt.ready; });
    expect(result.current.sessions[0]).toMatchObject({ status: "running", syncStatus: "saved" });

    let completion!: Promise<void>;
    act(() => {
      completion = result.current.completeConversation(attempt, {
        aiRunId: "run-a",
        content: "Improved",
        proposalId: "proposal-a",
      });
    });
    expect(result.current.sessions[0]).toMatchObject({
      messages: { length: 2 },
      status: "idle",
      syncStatus: "saving",
    });
    appendResult.resolve({
      ok: true,
      value: conversation({
        latestAiRunId: "run-a",
        latestProposalId: "proposal-a",
        messageCount: 2,
        messages: [
          ...conversation().messages,
          {
            aiRunId: "run-a",
            command: "Rewrite",
            content: "Improved",
            createdAt: new Date("2026-01-01T00:00:01.000Z"),
            id: "message-b",
            proposalId: "proposal-a",
            role: "assistant",
            scopeLabel: null,
          },
        ],
        version: 2,
      }),
    });
    await act(async () => { await completion; });
    expect(result.current.sessions[0]).toMatchObject({ status: "idle", syncStatus: "saved", version: 2 });
  });

  it("does not disguise a load failure as an empty loaded conversation list", async () => {
    const persistence = store({
      list: vi.fn().mockResolvedValue({ ok: false, reason: "unavailable" }),
    });
    const { result } = renderHook(() => useDocumentConversations({
      documentId: "doc-a",
      storageMode: "database",
      store: persistence,
      workspaceId: "workspace-a",
    }));

    await waitFor(() => expect(result.current.loadState).toBe("failed"));
    expect(result.current.sessions).toEqual([]);
    expect(result.current.errorReason).toBe("unavailable");
  });

  it("rolls a failed rename back and retries the same intended mutation", async () => {
    const renameResult = deferred<Awaited<ReturnType<ConversationStore["rename"]>>>();
    const rename = vi.fn()
      .mockImplementationOnce(() => renameResult.promise)
      .mockResolvedValueOnce({ ok: true, value: conversation({ title: "New title", version: 2 }) });
    const persistence = store({ rename });
    const { result } = renderHook(() => useDocumentConversations({
      documentId: "doc-a",
      initialConversations: [conversation()],
      storageMode: "database",
      store: persistence,
      workspaceId: "workspace-a",
    }));

    let renaming!: Promise<void>;
    act(() => { renaming = result.current.renameConversation("conversation-a", "New title"); });
    expect(result.current.sessions[0]).toMatchObject({ title: "New title", syncStatus: "saving" });
    renameResult.resolve({ ok: false, reason: "unavailable" });
    await act(async () => { await renaming; });
    expect(result.current.sessions[0]).toMatchObject({ title: "Rewrite", syncStatus: "saved" });
    expect(result.current.errorReason).toBe("unavailable");

    await act(async () => { await result.current.retryLastMutation(); });
    expect(result.current.sessions[0]).toMatchObject({ title: "New title", syncStatus: "saved", version: 2 });
    expect(rename).toHaveBeenCalledTimes(2);
  });

  it("refreshes a conflicted rename before retrying with the latest version", async () => {
    const get = vi.fn().mockResolvedValue({
      ok: true,
      value: conversation({ title: "Server title", version: 2 }),
    });
    const rename = vi.fn()
      .mockResolvedValueOnce({ ok: false, reason: "conflict" })
      .mockResolvedValueOnce({
        ok: true,
        value: conversation({ title: "New title", version: 3 }),
      });
    const persistence = store({ get, rename });
    const { result } = renderHook(() => useDocumentConversations({
      documentId: "doc-a",
      initialConversations: [conversation()],
      storageMode: "database",
      store: persistence,
      workspaceId: "workspace-a",
    }));

    await act(async () => { await result.current.renameConversation("conversation-a", "New title"); });
    expect(rename).toHaveBeenNthCalledWith(1, "doc-a", "conversation-a", {
      expectedVersion: 1,
      title: "New title",
    });

    await act(async () => { await result.current.retryLastMutation(); });

    expect(get).toHaveBeenCalledWith("doc-a", "conversation-a");
    expect(rename).toHaveBeenNthCalledWith(2, "doc-a", "conversation-a", {
      expectedVersion: 2,
      title: "New title",
    });
    expect(result.current.sessions[0]).toMatchObject({
      syncStatus: "saved",
      title: "New title",
      version: 3,
    });
  });

  it("keeps a conflicted rename retryable when detail refresh fails", async () => {
    const get = vi.fn()
      .mockResolvedValueOnce({ ok: false, reason: "unavailable" })
      .mockResolvedValueOnce({
        ok: true,
        value: conversation({ title: "Server title", version: 2 }),
      });
    const rename = vi.fn()
      .mockResolvedValueOnce({ ok: false, reason: "conflict" })
      .mockResolvedValueOnce({
        ok: true,
        value: conversation({ title: "New title", version: 3 }),
      });
    const persistence = store({ get, rename });
    const { result } = renderHook(() => useDocumentConversations({
      documentId: "doc-a",
      initialConversations: [conversation()],
      storageMode: "database",
      store: persistence,
      workspaceId: "workspace-a",
    }));

    await act(async () => { await result.current.renameConversation("conversation-a", "New title"); });
    await act(async () => { await result.current.retryLastMutation(); });

    expect(get).toHaveBeenCalledTimes(1);
    expect(rename).toHaveBeenCalledTimes(1);
    expect(result.current.hasPendingRetries).toBe(true);
    expect(result.current.errorReason).toBe("unavailable");

    await act(async () => { await result.current.retryLastMutation(); });

    expect(get).toHaveBeenCalledTimes(2);
    expect(rename).toHaveBeenNthCalledWith(2, "doc-a", "conversation-a", {
      expectedVersion: 2,
      title: "New title",
    });
    expect(result.current.sessions[0]).toMatchObject({
      syncStatus: "saved",
      title: "New title",
      version: 3,
    });
  });

  it("refreshes a conflicted archive before retrying with the latest version", async () => {
    const get = vi.fn().mockResolvedValue({
      ok: true,
      value: conversation({ title: "Server title", version: 2 }),
    });
    const archive = vi.fn()
      .mockResolvedValueOnce({ ok: false, reason: "conflict" })
      .mockResolvedValueOnce({
        ok: true,
        value: conversation({ archived: true, title: "Server title", version: 3 }),
      });
    const persistence = store({ archive, get });
    const { result } = renderHook(() => useDocumentConversations({
      documentId: "doc-a",
      initialConversations: [conversation()],
      storageMode: "database",
      store: persistence,
      workspaceId: "workspace-a",
    }));

    await act(async () => { await result.current.archiveConversation("conversation-a"); });
    await act(async () => { await result.current.retryLastMutation(); });

    expect(get).toHaveBeenCalledWith("doc-a", "conversation-a");
    expect(archive).toHaveBeenNthCalledWith(2, "doc-a", "conversation-a", {
      archived: true,
      expectedVersion: 2,
    });
    expect(result.current.sessions[0]).toMatchObject({
      archived: true,
      title: "Server title",
      version: 3,
    });
  });

  it("refreshes a conflicted append while preserving the assistant and mutation key", async () => {
    const get = vi.fn().mockResolvedValue({
      ok: true,
      value: conversation({ title: "Server title", version: 2 }),
    });
    const append = vi.fn()
      .mockResolvedValueOnce({ ok: false, reason: "conflict" })
      .mockResolvedValueOnce({
        ok: true,
        value: completedConversation({ title: "Server title", version: 3 }),
      });
    const persistence = store({
      append,
      create: vi.fn().mockResolvedValue({ ok: true, value: conversation() }),
      get,
    });
    const { result } = renderHook(() => useDocumentConversations({
      documentId: "doc-a",
      initialConversations: [],
      storageMode: "database",
      store: persistence,
      workspaceId: "workspace-a",
    }));
    let attempt!: ReturnType<typeof result.current.beginConversation>;
    await act(async () => {
      attempt = result.current.beginConversation({ command: "Rewrite", content: "Original", title: "Rewrite" });
      await attempt.ready;
      await result.current.completeConversation(attempt, { content: "Improved" });
    });
    expect(result.current.sessions[0]).toMatchObject({ messages: { length: 2 }, syncStatus: "unsaved" });

    await act(async () => { await result.current.retryLastMutation(); });

    expect(get).toHaveBeenCalledWith("doc-a", "conversation-a");
    expect(append.mock.calls[0]?.[2]).toMatchObject({ expectedVersion: 1 });
    expect(append.mock.calls[1]?.[2]).toMatchObject({ expectedVersion: 2 });
    expect(append.mock.calls[1]?.[2].mutationKey).toBe(append.mock.calls[0]?.[2].mutationKey);
    expect(result.current.sessions[0]).toMatchObject({
      messages: { length: 2 },
      syncStatus: "saved",
      title: "Server title",
      version: 3,
    });
  });

  it("merges an equal-length server transcript without dropping the optimistic assistant", async () => {
    const appendRetry = deferred<Awaited<ReturnType<ConversationStore["append"]>>>();
    const remoteAssistant = {
      aiRunId: null,
      command: "Rewrite",
      content: "Remote reply",
      createdAt: new Date("2026-01-01T00:00:01.000Z"),
      id: "message-remote",
      proposalId: null,
      role: "assistant" as const,
      scopeLabel: null,
    };
    const get = vi.fn().mockResolvedValue({
      ok: true,
      value: conversation({
        messageCount: 2,
        messages: [...conversation().messages, remoteAssistant],
        title: "Server title",
        version: 2,
      }),
    });
    const append = vi.fn()
      .mockResolvedValueOnce({ ok: false, reason: "conflict" })
      .mockImplementationOnce(() => appendRetry.promise);
    const persistence = store({
      append,
      create: vi.fn().mockResolvedValue({ ok: true, value: conversation() }),
      get,
    });
    const { result } = renderHook(() => useDocumentConversations({
      documentId: "doc-a",
      initialConversations: [],
      storageMode: "database",
      store: persistence,
      workspaceId: "workspace-a",
    }));
    let attempt!: ReturnType<typeof result.current.beginConversation>;
    await act(async () => {
      attempt = result.current.beginConversation({ command: "Rewrite", content: "Original", title: "Rewrite" });
      await attempt.ready;
      await result.current.completeConversation(attempt, { content: "Improved" });
    });

    let retry!: Promise<void>;
    act(() => { retry = result.current.retryLastMutation(); });
    await waitFor(() => expect(append).toHaveBeenCalledTimes(2));

    expect(result.current.sessions[0]).toMatchObject({
      syncStatus: "saving",
      title: "Server title",
      version: 2,
    });
    expect(result.current.sessions[0]?.messages.map((message) => message.content)).toEqual([
      "Original",
      "Remote reply",
      "Improved",
    ]);

    appendRetry.resolve({
      ok: true,
      value: conversation({
        messageCount: 3,
        messages: [
          ...conversation().messages,
          remoteAssistant,
          {
            ...remoteAssistant,
            content: "Improved",
            id: "message-assistant",
          },
        ],
        title: "Server title",
        version: 3,
      }),
    });
    await act(async () => { await retry; });

    expect(result.current.sessions[0]).toMatchObject({ syncStatus: "saved", version: 3 });
    expect(result.current.sessions[0]?.messages.map((message) => message.content)).toEqual([
      "Original",
      "Remote reply",
      "Improved",
    ]);
  });

  it("refreshes a conflicted status while preserving the optimistic target status", async () => {
    const statusRetry = deferred<Awaited<ReturnType<ConversationStore["setStatus"]>>>();
    const get = vi.fn().mockResolvedValue({
      ok: true,
      value: conversation({ title: "Server title", version: 2 }),
    });
    const setStatus = vi.fn()
      .mockResolvedValueOnce({ ok: false, reason: "conflict" })
      .mockImplementationOnce(() => statusRetry.promise);
    const persistence = store({
      create: vi.fn().mockResolvedValue({ ok: true, value: conversation() }),
      get,
      setStatus,
    });
    const { result } = renderHook(() => useDocumentConversations({
      documentId: "doc-a",
      initialConversations: [],
      storageMode: "database",
      store: persistence,
      workspaceId: "workspace-a",
    }));
    let attempt!: ReturnType<typeof result.current.beginConversation>;
    await act(async () => {
      attempt = result.current.beginConversation({ command: "Rewrite", content: "Original", title: "Rewrite" });
      await attempt.ready;
      await result.current.failConversation(attempt);
    });

    let retry!: Promise<void>;
    act(() => { retry = result.current.retryLastMutation(); });
    await waitFor(() => expect(setStatus).toHaveBeenCalledTimes(2));

    expect(get).toHaveBeenCalledWith("doc-a", "conversation-a");
    expect(setStatus).toHaveBeenNthCalledWith(2, "doc-a", "conversation-a", {
      expectedVersion: 2,
      status: "failed",
    });
    expect(result.current.sessions[0]).toMatchObject({
      status: "failed",
      syncStatus: "saving",
      title: "Server title",
      version: 2,
    });

    statusRetry.resolve({
      ok: true,
      value: conversation({ status: "failed", title: "Server title", version: 3 }),
    });
    await act(async () => { await retry; });
    expect(result.current.sessions[0]).toMatchObject({ status: "failed", syncStatus: "saved", version: 3 });
  });

  it("ignores a delayed conflict refresh after the document scope changes", async () => {
    const refresh = deferred<Awaited<ReturnType<ConversationStore["get"]>>>();
    const rename = vi.fn()
      .mockResolvedValueOnce({ ok: false, reason: "conflict" })
      .mockResolvedValueOnce({
        ok: true,
        value: conversation({ title: "New title", version: 3 }),
      });
    const persistence = store({ get: vi.fn(() => refresh.promise), rename });
    const { result, rerender } = renderHook(
      ({ documentId, initialConversations }: { documentId: string; initialConversations: StoredConversationView[] }) =>
        useDocumentConversations({
          documentId,
          initialConversations,
          storageMode: "database",
          store: persistence,
          workspaceId: "workspace-a",
        }),
      { initialProps: { documentId: "doc-a", initialConversations: [conversation()] } },
    );

    await act(async () => { await result.current.renameConversation("conversation-a", "New title"); });
    let retry!: Promise<void>;
    act(() => { retry = result.current.retryLastMutation(); });
    await waitFor(() => expect(persistence.get).toHaveBeenCalledWith("doc-a", "conversation-a"));

    rerender({
      documentId: "doc-b",
      initialConversations: [conversation({ documentId: "doc-b", id: "conversation-b", title: "B" })],
    });
    refresh.resolve({
      ok: true,
      value: conversation({ title: "Server title", version: 2 }),
    });
    await act(async () => { await retry; });

    expect(rename).toHaveBeenCalledTimes(1);
    expect(result.current.sessions).toEqual([
      expect.objectContaining({ id: "conversation-b", title: "B" }),
    ]);
    expect(result.current.errorReason).toBeNull();
    expect(result.current.hasPendingRetries).toBe(false);
  });

  it("rehydrates instead of retaining sessions when the document changes", () => {
    const persistence = store();
    const { result, rerender } = renderHook(
      ({ documentId, initialConversations }: { documentId: string; initialConversations: StoredConversationView[] }) =>
        useDocumentConversations({
          documentId,
          initialConversations,
          storageMode: "database",
          store: persistence,
          workspaceId: "workspace-a",
        }),
      {
        initialProps: {
          documentId: "doc-a",
          initialConversations: [conversation()],
        },
      },
    );

    expect(result.current.sessions[0]?.id).toBe("conversation-a");
    rerender({
      documentId: "doc-b",
      initialConversations: [conversation({ documentId: "doc-b", id: "conversation-b" })],
    });
    expect(result.current.sessions.map((session) => session.id)).toEqual(["conversation-b"]);
  });

  it("invalidates an immediately resolved list microtask during a scope rerender", async () => {
    const listResult = deferred<Awaited<ReturnType<ConversationStore["list"]>>>();
    const persistence = store({ list: vi.fn(() => listResult.promise) });
    const { result, rerender } = renderHook(
      ({ documentId, initialConversations }: {
        documentId: string;
        initialConversations?: StoredConversationView[];
      }) => useDocumentConversations({
          documentId,
          initialConversations,
          storageMode: "database",
          store: persistence,
          workspaceId: "workspace-a",
        }),
      {
        initialProps: {
          documentId: "doc-a",
          initialConversations: undefined as StoredConversationView[] | undefined,
        },
      },
    );
    await waitFor(() => expect(persistence.list).toHaveBeenCalledWith({ documentId: "doc-a" }));

    await act(async () => {
      listResult.resolve({
        ok: true,
        value: { items: [conversationSummary({ title: "STALE A" })], nextCursor: null },
      });
      rerender({
        documentId: "doc-b",
        initialConversations: [conversation({ documentId: "doc-b", id: "conversation-b", title: "B" })],
      });
      await Promise.resolve();
    });

    expect(result.current.sessions).toEqual([
      expect.objectContaining({ id: "conversation-b", title: "B" }),
    ]);
  });

  it("ignores a delayed creation failure after the document scope changes", async () => {
    const createResult = deferred<Awaited<ReturnType<ConversationStore["create"]>>>();
    const persistence = store({ create: vi.fn(() => createResult.promise) });
    const { result, rerender } = renderHook(
      ({ documentId, initialConversations }: { documentId: string; initialConversations: StoredConversationView[] }) =>
        useDocumentConversations({
          documentId,
          initialConversations,
          storageMode: "database",
          store: persistence,
          workspaceId: "workspace-a",
        }),
      { initialProps: { documentId: "doc-a", initialConversations: [] as StoredConversationView[] } },
    );

    let attempt!: ReturnType<typeof result.current.beginConversation>;
    act(() => {
      attempt = result.current.beginConversation({ command: "Rewrite", content: "Original", title: "Rewrite" });
    });
    rerender({
      documentId: "doc-b",
      initialConversations: [conversation({ documentId: "doc-b", id: "conversation-b", title: "B" })],
    });
    createResult.resolve({ ok: false, reason: "unavailable" });
    await act(async () => { await attempt.ready; });

    expect(result.current.sessions).toEqual([
      expect.objectContaining({ id: "conversation-b", title: "B" }),
    ]);
    expect(result.current.errorReason).toBeNull();
    expect(result.current.hasPendingRetries).toBe(false);
  });

  it("ignores a delayed append failure after the document scope changes", async () => {
    const appendResult = deferred<Awaited<ReturnType<ConversationStore["append"]>>>();
    const persistence = store({
      append: vi.fn(() => appendResult.promise),
      create: vi.fn().mockResolvedValue({ ok: true, value: conversation() }),
    });
    const { result, rerender } = renderHook(
      ({ documentId, initialConversations }: { documentId: string; initialConversations: StoredConversationView[] }) =>
        useDocumentConversations({
          documentId,
          initialConversations,
          storageMode: "database",
          store: persistence,
          workspaceId: "workspace-a",
        }),
      { initialProps: { documentId: "doc-a", initialConversations: [] as StoredConversationView[] } },
    );
    let attempt!: ReturnType<typeof result.current.beginConversation>;
    await act(async () => {
      attempt = result.current.beginConversation({ command: "Rewrite", content: "Original", title: "Rewrite" });
      await attempt.ready;
    });

    let completion!: Promise<void>;
    act(() => { completion = result.current.completeConversation(attempt, { content: "Improved" }); });
    rerender({
      documentId: "doc-b",
      initialConversations: [conversation({ documentId: "doc-b", id: "conversation-b", title: "B" })],
    });
    appendResult.resolve({ ok: false, reason: "unavailable" });
    await act(async () => { await completion; });

    expect(result.current.sessions).toEqual([
      expect.objectContaining({ id: "conversation-b", title: "B" }),
    ]);
    expect(result.current.errorReason).toBeNull();
    expect(result.current.hasPendingRetries).toBe(false);
  });

  it("ignores a delayed fork success after the document scope changes", async () => {
    const forkResult = deferred<Awaited<ReturnType<ConversationStore["fork"]>>>();
    const persistence = store({ fork: vi.fn(() => forkResult.promise) });
    const { result, rerender } = renderHook(
      ({ documentId, initialConversations }: { documentId: string; initialConversations: StoredConversationView[] }) =>
        useDocumentConversations({
          documentId,
          initialConversations,
          storageMode: "database",
          store: persistence,
          workspaceId: "workspace-a",
        }),
      { initialProps: { documentId: "doc-a", initialConversations: [conversation()] } },
    );

    let forking!: Promise<void>;
    act(() => { forking = result.current.forkConversation("conversation-a", "message-a"); });
    rerender({
      documentId: "doc-b",
      initialConversations: [conversation({ documentId: "doc-b", id: "conversation-b", title: "B" })],
    });
    forkResult.resolve({
      ok: true,
      value: conversation({ id: "conversation-fork", title: "Rewrite copy" }),
    });
    await act(async () => { await forking; });

    expect(result.current.sessions).toEqual([
      expect.objectContaining({ id: "conversation-b", title: "B" }),
    ]);
  });

  it("keeps a failed execution in saving state until status persistence is confirmed", async () => {
    const statusResult = deferred<Awaited<ReturnType<ConversationStore["setStatus"]>>>();
    const persistence = store({
      create: vi.fn().mockResolvedValue({ ok: true, value: conversation() }),
      setStatus: vi.fn(() => statusResult.promise),
    });
    const { result } = renderHook(() => useDocumentConversations({
      documentId: "doc-a",
      initialConversations: [],
      storageMode: "database",
      store: persistence,
      workspaceId: "workspace-a",
    }));
    let attempt!: ReturnType<typeof result.current.beginConversation>;
    await act(async () => {
      attempt = result.current.beginConversation({ command: "Rewrite", content: "Original", title: "Rewrite" });
      await attempt.ready;
    });

    let failing!: Promise<void>;
    act(() => { failing = result.current.failConversation(attempt); });
    expect(result.current.sessions[0]).toMatchObject({ status: "failed", syncStatus: "saving" });
    statusResult.resolve({ ok: true, value: conversation({ status: "failed", version: 2 }) });
    await act(async () => { await failing; });
    expect(result.current.sessions[0]).toMatchObject({ status: "failed", syncStatus: "saved", version: 2 });
  });

  it("retries failed execution status persistence", async () => {
    const setStatus = vi.fn()
      .mockResolvedValueOnce({ ok: false, reason: "unavailable" })
      .mockResolvedValueOnce({ ok: true, value: conversation({ status: "failed", version: 2 }) });
    const persistence = store({
      create: vi.fn().mockResolvedValue({ ok: true, value: conversation() }),
      setStatus,
    });
    const { result } = renderHook(() => useDocumentConversations({
      documentId: "doc-a",
      initialConversations: [],
      storageMode: "database",
      store: persistence,
      workspaceId: "workspace-a",
    }));
    let attempt!: ReturnType<typeof result.current.beginConversation>;
    await act(async () => {
      attempt = result.current.beginConversation({ command: "Rewrite", content: "Original", title: "Rewrite" });
      await attempt.ready;
      await result.current.failConversation(attempt);
    });
    expect(result.current.sessions[0]).toMatchObject({ status: "failed", syncStatus: "unsaved" });

    await act(async () => { await result.current.retryLastMutation(); });
    expect(result.current.sessions[0]).toMatchObject({ status: "failed", syncStatus: "saved", version: 2 });
    expect(setStatus).toHaveBeenCalledTimes(2);
  });

  it("reuses a fork creation key when an unavailable response is retried", async () => {
    const fork = vi.fn()
      .mockResolvedValueOnce({ ok: false, reason: "unavailable" })
      .mockResolvedValueOnce({ ok: true, value: conversation({ id: "conversation-fork", title: "Rewrite copy" }) });
    const persistence = store({ fork });
    const { result } = renderHook(() => useDocumentConversations({
      documentId: "doc-a",
      initialConversations: [conversation()],
      storageMode: "database",
      store: persistence,
      workspaceId: "workspace-a",
    }));

    await act(async () => { await result.current.forkConversation("conversation-a", "message-a"); });
    await act(async () => { await result.current.retryLastMutation(); });

    expect(fork).toHaveBeenCalledTimes(2);
    expect(fork.mock.calls[0]?.[2].creationKey).toBe(fork.mock.calls[1]?.[2].creationKey);
    expect(result.current.sessions[0]?.id).toBe("conversation-fork");
  });

  it("keeps failed retries isolated when another conversation mutation succeeds", async () => {
    const conversationA = conversation({ id: "conversation-a", title: "A" });
    const conversationB = conversation({ id: "conversation-b", title: "B" });
    const rename = vi.fn()
      .mockResolvedValueOnce({ ok: false, reason: "unavailable" })
      .mockResolvedValueOnce({ ok: true, value: conversation({ id: "conversation-b", title: "New B", version: 2 }) })
      .mockResolvedValueOnce({ ok: true, value: conversation({ id: "conversation-a", title: "New A", version: 2 }) });
    const persistence = store({ rename });
    const { result } = renderHook(() => useDocumentConversations({
      documentId: "doc-a",
      initialConversations: [conversationA, conversationB],
      storageMode: "database",
      store: persistence,
      workspaceId: "workspace-a",
    }));

    await act(async () => { await result.current.renameConversation("conversation-a", "New A"); });
    expect(result.current.errorReason).toBe("unavailable");

    await act(async () => { await result.current.renameConversation("conversation-b", "New B"); });
    expect(result.current.errorReason).toBe("unavailable");

    await act(async () => { await result.current.retryLastMutation(); });
    expect(result.current.sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "conversation-a", title: "New A", version: 2 }),
      expect.objectContaining({ id: "conversation-b", title: "New B", version: 2 }),
    ]));
    expect(result.current.errorReason).toBeNull();
    expect(rename).toHaveBeenCalledTimes(3);
  });

  it("persists a failed execution after retrying its failed conversation creation", async () => {
    const statusResult = deferred<Awaited<ReturnType<ConversationStore["setStatus"]>>>();
    const create = vi.fn()
      .mockResolvedValueOnce({ ok: false, reason: "unavailable" })
      .mockResolvedValueOnce({ ok: true, value: conversation({ status: "idle", version: 1 }) });
    const setStatus = vi.fn(() => statusResult.promise);
    const persistence = store({ create, setStatus });
    const { result } = renderHook(() => useDocumentConversations({
      documentId: "doc-a",
      initialConversations: [],
      storageMode: "database",
      store: persistence,
      workspaceId: "workspace-a",
    }));
    let attempt!: ReturnType<typeof result.current.beginConversation>;
    await act(async () => {
      attempt = result.current.beginConversation({ command: "Rewrite", content: "Original", title: "Rewrite" });
      await attempt.ready;
      await result.current.failConversation(attempt);
    });
    expect(result.current.sessions[0]).toMatchObject({ status: "failed", syncStatus: "unsaved" });

    let retry!: Promise<void>;
    act(() => { retry = result.current.retryLastMutation(); });
    await waitFor(() => expect(setStatus).toHaveBeenCalledTimes(1));
    expect(result.current.sessions[0]).toMatchObject({ status: "failed", syncStatus: "saving" });
    statusResult.resolve({ ok: true, value: conversation({ status: "failed", version: 2 }) });
    await act(async () => { await retry; });

    expect(result.current.sessions[0]).toMatchObject({ status: "failed", syncStatus: "saved", version: 2 });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("uses the canonical version from a successful rename while an execution is running", async () => {
    const append = vi.fn().mockResolvedValue({
      ok: true,
      value: conversation({
        messageCount: 2,
        messages: [
          ...conversation().messages,
          {
            aiRunId: null,
            command: "Rewrite",
            content: "Improved",
            createdAt: new Date("2026-01-01T00:00:01.000Z"),
            id: "message-b",
            proposalId: null,
            role: "assistant" as const,
            scopeLabel: null,
          },
        ],
        title: "New title",
        version: 3,
      }),
    });
    const persistence = store({
      append,
      create: vi.fn().mockResolvedValue({ ok: true, value: conversation() }),
      rename: vi.fn().mockResolvedValue({ ok: true, value: conversation({ title: "New title", version: 2 }) }),
    });
    const { result } = renderHook(() => useDocumentConversations({
      documentId: "doc-a",
      initialConversations: [],
      storageMode: "database",
      store: persistence,
      workspaceId: "workspace-a",
    }));
    let attempt!: ReturnType<typeof result.current.beginConversation>;
    await act(async () => {
      attempt = result.current.beginConversation({ command: "Rewrite", content: "Original", title: "Rewrite" });
      await attempt.ready;
      await result.current.renameConversation("conversation-a", "New title");
      await result.current.completeConversation(attempt, { content: "Improved" });
    });

    expect(append).toHaveBeenCalledWith("doc-a", "conversation-a", expect.objectContaining({
      expectedVersion: 2,
    }));
    expect(result.current.sessions[0]).toMatchObject({ status: "idle", syncStatus: "saved", title: "New title", version: 3 });
  });

  it("serializes a rename behind an in-flight append for the same conversation", async () => {
    const appendResult = deferred<Awaited<ReturnType<ConversationStore["append"]>>>();
    const append = vi.fn(() => appendResult.promise);
    const renameResult = deferred<Awaited<ReturnType<ConversationStore["rename"]>>>();
    const rename = vi.fn(() => renameResult.promise);
    const persistence = store({
      append,
      create: vi.fn().mockResolvedValue({ ok: true, value: conversation() }),
      rename,
    });
    const { result } = renderHook(() => useDocumentConversations({
      documentId: "doc-a",
      initialConversations: [],
      storageMode: "database",
      store: persistence,
      workspaceId: "workspace-a",
    }));
    let attempt!: ReturnType<typeof result.current.beginConversation>;
    await act(async () => {
      attempt = result.current.beginConversation({ command: "Rewrite", content: "Original", title: "Rewrite" });
      await attempt.ready;
    });

    let completion!: Promise<void>;
    act(() => { completion = result.current.completeConversation(attempt, { content: "Improved" }); });
    await waitFor(() => expect(append).toHaveBeenCalledTimes(1));
    let renaming!: Promise<void>;
    act(() => { renaming = result.current.renameConversation("conversation-a", "New title"); });
    const renameCallsBeforeAppendCompleted = rename.mock.calls.length;
    appendResult.resolve({ ok: true, value: completedConversation() });
    await waitFor(() => expect(rename).toHaveBeenCalledTimes(1));
    expect(result.current.sessions[0]).toMatchObject({
      messages: { length: 2 },
      syncStatus: "saving",
      title: "New title",
      version: 2,
    });
    renameResult.resolve({
      ok: true,
      value: completedConversation({ title: "New title", version: 3 }),
    });
    await act(async () => { await Promise.all([completion, renaming]); });

    expect(renameCallsBeforeAppendCompleted).toBe(0);
    expect(rename).toHaveBeenCalledWith("doc-a", "conversation-a", {
      expectedVersion: 2,
      title: "New title",
    });
    expect(result.current.sessions[0]).toMatchObject({ title: "New title", version: 3 });
  });

  it("serializes an append behind an in-flight rename for the same conversation", async () => {
    const renameResult = deferred<Awaited<ReturnType<ConversationStore["rename"]>>>();
    const rename = vi.fn(() => renameResult.promise);
    const appendResult = deferred<Awaited<ReturnType<ConversationStore["append"]>>>();
    const append = vi.fn(() => appendResult.promise);
    const persistence = store({
      append,
      create: vi.fn().mockResolvedValue({ ok: true, value: conversation() }),
      rename,
    });
    const { result } = renderHook(() => useDocumentConversations({
      documentId: "doc-a",
      initialConversations: [],
      storageMode: "database",
      store: persistence,
      workspaceId: "workspace-a",
    }));
    let attempt!: ReturnType<typeof result.current.beginConversation>;
    await act(async () => {
      attempt = result.current.beginConversation({ command: "Rewrite", content: "Original", title: "Rewrite" });
      await attempt.ready;
    });

    let renaming!: Promise<void>;
    act(() => { renaming = result.current.renameConversation("conversation-a", "New title"); });
    await waitFor(() => expect(rename).toHaveBeenCalledTimes(1));
    let completion!: Promise<void>;
    act(() => { completion = result.current.completeConversation(attempt, { content: "Improved" }); });
    const appendCallsBeforeRenameCompleted = append.mock.calls.length;
    renameResult.resolve({ ok: true, value: conversation({ title: "New title", version: 2 }) });
    await waitFor(() => expect(append).toHaveBeenCalledTimes(1));
    expect(result.current.sessions[0]).toMatchObject({
      messages: { length: 2 },
      syncStatus: "saving",
      title: "New title",
      version: 2,
    });
    appendResult.resolve({
      ok: true,
      value: completedConversation({ title: "New title", version: 3 }),
    });
    await act(async () => { await Promise.all([renaming, completion]); });

    expect(appendCallsBeforeRenameCompleted).toBe(0);
    expect(append).toHaveBeenCalledWith("doc-a", "conversation-a", expect.objectContaining({
      expectedVersion: 2,
    }));
    expect(result.current.sessions[0]).toMatchObject({ title: "New title", version: 3 });
  });

  it("retries an append with the latest canonical version and its original mutation key", async () => {
    const append = vi.fn()
      .mockResolvedValueOnce({ ok: false, reason: "unavailable" })
      .mockResolvedValueOnce({ ok: true, value: completedConversation({ title: "New title", version: 3 }) });
    const persistence = store({
      append,
      create: vi.fn().mockResolvedValue({ ok: true, value: conversation() }),
      rename: vi.fn().mockResolvedValue({ ok: true, value: conversation({ title: "New title", version: 2 }) }),
    });
    const { result } = renderHook(() => useDocumentConversations({
      documentId: "doc-a",
      initialConversations: [],
      storageMode: "database",
      store: persistence,
      workspaceId: "workspace-a",
    }));
    let attempt!: ReturnType<typeof result.current.beginConversation>;
    await act(async () => {
      attempt = result.current.beginConversation({ command: "Rewrite", content: "Original", title: "Rewrite" });
      await attempt.ready;
      await result.current.completeConversation(attempt, { content: "Improved" });
      await result.current.renameConversation("conversation-a", "New title");
      await result.current.retryLastMutation();
    });

    expect(append).toHaveBeenCalledTimes(2);
    expect(append.mock.calls[0]?.[2]).toMatchObject({ expectedVersion: 1 });
    expect(append.mock.calls[1]?.[2]).toMatchObject({ expectedVersion: 2 });
    expect(append.mock.calls[0]?.[2].mutationKey).toBe(append.mock.calls[1]?.[2].mutationKey);
    expect(result.current.sessions[0]).toMatchObject({ title: "New title", version: 3 });
  });

  it("preserves an unsaved assistant and its retry when a failed initial load later succeeds", async () => {
    const serverConversation = conversation();
    const create = vi.fn()
      .mockResolvedValueOnce({ ok: false, reason: "unavailable" })
      .mockResolvedValueOnce({ ok: true, replayed: true, value: serverConversation });
    const append = vi.fn().mockResolvedValue({
      ok: true,
      value: completedConversation(),
    });
    const list = vi.fn()
      .mockResolvedValueOnce({ ok: false, reason: "unavailable" })
      .mockResolvedValueOnce({ ok: true, value: { items: [serverConversation], nextCursor: null } });
    const persistence = store({ append, create, list });
    const { result } = renderHook(() => useDocumentConversations({
      documentId: "doc-a",
      storageMode: "database",
      store: persistence,
      workspaceId: "workspace-a",
    }));
    await waitFor(() => expect(result.current.loadState).toBe("failed"));

    let attempt!: ReturnType<typeof result.current.beginConversation>;
    await act(async () => {
      attempt = result.current.beginConversation({ command: "Rewrite", content: "Original", title: "Rewrite" });
      await attempt.ready;
      await result.current.completeConversation(attempt, { content: "Improved" });
    });
    expect(result.current.hasPendingRetries).toBe(true);
    expect(result.current.sessions[0]).toMatchObject({ messages: { length: 2 }, syncStatus: "unsaved" });

    await act(async () => { await result.current.reload(); });
    expect(result.current.loadState).toBe("loaded");
    expect(result.current.hasPendingRetries).toBe(true);
    expect(result.current.sessions.some((session) =>
      session.messages.length === 2 && session.syncStatus === "unsaved"
    )).toBe(true);

    await act(async () => { await result.current.retryLastMutation(); });
    expect(result.current.hasPendingRetries).toBe(false);
    expect(result.current.sessions).toHaveLength(1);
    expect(result.current.sessions[0]).toMatchObject({
      id: "conversation-a",
      messages: { length: 2 },
      syncStatus: "saved",
      version: 2,
    });
    expect(create).toHaveBeenCalledTimes(2);
    expect(append).toHaveBeenCalledTimes(1);
  });

  it("never forks from a pending or non-canonical assistant message", async () => {
    const appendResult = deferred<Awaited<ReturnType<ConversationStore["append"]>>>();
    const fork = vi.fn().mockResolvedValue({
      ok: true,
      value: completedConversation({ id: "conversation-fork", title: "Rewrite copy", version: 1 }),
    });
    const persistence = store({
      append: vi.fn(() => appendResult.promise),
      create: vi.fn().mockResolvedValue({ ok: true, value: conversation() }),
      fork,
    });
    const { result } = renderHook(() => useDocumentConversations({
      documentId: "doc-a",
      initialConversations: [],
      storageMode: "database",
      store: persistence,
      workspaceId: "workspace-a",
    }));
    let attempt!: ReturnType<typeof result.current.beginConversation>;
    await act(async () => {
      attempt = result.current.beginConversation({ command: "Rewrite", content: "Original", title: "Rewrite" });
      await attempt.ready;
    });

    let completion!: Promise<void>;
    act(() => { completion = result.current.completeConversation(attempt, { content: "Improved" }); });
    const pendingAssistantId = result.current.sessions[0]!.messages.at(-1)!.id;
    await act(async () => { await result.current.forkConversation("conversation-a", pendingAssistantId); });
    expect(fork).not.toHaveBeenCalled();
    expect(result.current.hasPendingRetries).toBe(false);

    appendResult.resolve({ ok: true, value: completedConversation() });
    await act(async () => { await completion; });
    await act(async () => { await result.current.forkConversation("conversation-a", pendingAssistantId); });
    expect(fork).not.toHaveBeenCalled();

    await act(async () => { await result.current.forkConversation("conversation-a", "message-b"); });
    expect(fork).toHaveBeenCalledTimes(1);
    expect(fork).toHaveBeenCalledWith("doc-a", "conversation-a", expect.objectContaining({
      throughMessageId: "message-b",
    }));
  });
});
