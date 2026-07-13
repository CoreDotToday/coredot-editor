"use client";

import { nanoid } from "nanoid";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createHttpConversationStore } from "./conversation-client";
import type { ConversationFailureReason } from "./conversation-domain";
import {
  createLocalConversationStore,
  type ConversationStorageMode,
  type ConversationStore,
  type StoreResult,
  type StoredConversationView,
} from "./conversation-store";

export type ConversationLoadState = "failed" | "loaded" | "loading";
export type ConversationErrorReason = ConversationFailureReason | "unavailable";

export type DocumentConversationMessage = {
  aiRunId?: string;
  command?: string;
  content: string;
  createdAt: Date;
  id: string;
  proposalId?: string;
  role: "assistant" | "user";
  scopeLabel?: string;
};

export type DocumentConversationSession = {
  archived: boolean;
  command: string;
  createdAt: Date;
  id: string;
  messages: DocumentConversationMessage[];
  status: "failed" | "idle" | "running";
  syncStatus: "saved" | "saving" | "unsaved";
  title: string;
  updatedAt: Date;
  version: number;
};

export type ConversationAttempt = {
  localId: string;
  ready: Promise<StoredConversationView | null>;
  /** Internal stable operation state retained for retries. */
  state: {
    assistant: CompleteConversationInput | null;
    canonical: StoredConversationView | null;
    createInput: Parameters<ConversationStore["create"]>[0];
    targetStatus: DocumentConversationSession["status"];
  };
};

export type CompleteConversationInput = {
  aiRunId?: string | null;
  command?: string | null;
  content: string;
  proposalId?: string | null;
};

type UseDocumentConversationsInput = {
  documentId: string;
  initialConversations?: StoredConversationView[];
  initialLoadFailed?: boolean;
  storageMode: ConversationStorageMode;
  store?: ConversationStore;
  workspaceId: string;
};

export function useDocumentConversations({
  documentId,
  initialConversations,
  initialLoadFailed = false,
  storageMode,
  store: providedStore,
  workspaceId,
}: UseDocumentConversationsInput) {
  const store = useMemo(() => {
    if (providedStore) return providedStore;
    if (storageMode === "database") return createHttpConversationStore();
    if (typeof window !== "undefined") return createLocalConversationStore(window.localStorage, workspaceId);
    return createUnavailableStore();
  }, [providedStore, storageMode, workspaceId]);
  const initialSessions = useMemo(
    () => (initialConversations ?? []).map(toDocumentConversationSession),
    [initialConversations],
  );
  const [sessions, setSessions] = useState<DocumentConversationSession[]>(initialSessions);
  const sessionsRef = useRef(sessions);
  const [loadState, setLoadState] = useState<ConversationLoadState>(
    initialLoadFailed ? "failed" : initialConversations ? "loaded" : "loading",
  );
  const [errorReason, setErrorReason] = useState<ConversationErrorReason | null>(
    initialLoadFailed ? "unavailable" : null,
  );
  const [pendingRetryCount, setPendingRetryCount] = useState(0);
  const pendingRetriesRef = useRef(new Map<string, {
    reason: ConversationErrorReason;
    retry: () => Promise<void>;
  }>());
  const activeAttemptsRef = useRef(new Set<ConversationAttempt>());
  const conversationMutationTailsRef = useRef(new Map<string, Promise<void>>());
  const conversationMutationCountsRef = useRef(new Map<string, number>());
  const loadGenerationRef = useRef(0);
  const scopeRef = useRef(`${storageMode}:${workspaceId}:${documentId}`);

  const updateSessions = useCallback((update: (current: DocumentConversationSession[]) => DocumentConversationSession[]) => {
    const next = update(sessionsRef.current);
    sessionsRef.current = next;
    setSessions(next);
  }, []);

  function latestRetryReason() {
    return Array.from(pendingRetriesRef.current.values()).at(-1)?.reason ?? null;
  }

  function registerRetry(
    key: string,
    reason: ConversationErrorReason,
    retry: () => Promise<void>,
  ) {
    pendingRetriesRef.current.set(key, { reason, retry });
    setPendingRetryCount(pendingRetriesRef.current.size);
    setErrorReason(reason);
  }

  function clearRetry(key: string) {
    pendingRetriesRef.current.delete(key);
    setPendingRetryCount(pendingRetriesRef.current.size);
    setErrorReason(latestRetryReason());
  }

  function sessionHasPendingPersistence(session: DocumentConversationSession) {
    if (session.syncStatus !== "saved") return true;
    const attempt = Array.from(activeAttemptsRef.current).find((candidate) => matchesAttempt(session, candidate));
    const identities = new Set([session.id, attempt?.localId].filter((value): value is string => Boolean(value)));
    return Array.from(pendingRetriesRef.current.keys()).some((key) => {
      const separator = key.indexOf(":");
      return separator >= 0 && identities.has(key.slice(separator + 1));
    });
  }

  function syncAttemptCanonical(conversation: StoredConversationView) {
    for (const attempt of activeAttemptsRef.current) {
      if (attempt.state.canonical?.id === conversation.id || attempt.localId === conversation.id) {
        attempt.state.canonical = conversation;
      }
    }
  }

  function conversationMutationKey(conversationId: string) {
    for (const attempt of activeAttemptsRef.current) {
      if (attempt.localId === conversationId || attempt.state.canonical?.id === conversationId) {
        return attempt.localId;
      }
    }
    return conversationId;
  }

  async function withConversationMutation<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = conversationMutationTailsRef.current.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current, () => current);
    conversationMutationTailsRef.current.set(key, tail);
    conversationMutationCountsRef.current.set(key, (conversationMutationCountsRef.current.get(key) ?? 0) + 1);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      const remaining = (conversationMutationCountsRef.current.get(key) ?? 1) - 1;
      if (remaining === 0) conversationMutationCountsRef.current.delete(key);
      else conversationMutationCountsRef.current.set(key, remaining);
      if (conversationMutationTailsRef.current.get(key) === tail) {
        conversationMutationTailsRef.current.delete(key);
      }
    }
  }

  function reconcilePersistedSession(
    conversation: StoredConversationView,
    current: DocumentConversationSession,
    executionStatus: DocumentConversationSession["status"],
    mutationKey: string,
  ) {
    const canonical = toDocumentConversationSession(conversation);
    const hasFollowingMutation = (conversationMutationCountsRef.current.get(mutationKey) ?? 0) > 1;
    const hasOptimisticMessages = current.messages.length > canonical.messages.length;
    return {
      ...canonical,
      archived: hasFollowingMutation ? current.archived : canonical.archived,
      messages: hasOptimisticMessages ? current.messages : canonical.messages,
      status: executionStatus,
      syncStatus: hasFollowingMutation || hasOptimisticMessages ? "saving" as const : "saved" as const,
      title: hasFollowingMutation ? current.title : canonical.title,
    };
  }

  const load = useCallback(async () => {
    const generation = loadGenerationRef.current + 1;
    loadGenerationRef.current = generation;
    setLoadState("loading");
    setErrorReason(latestRetryReason());
    const result = await store.list({ documentId });
    if (generation !== loadGenerationRef.current) return;
    if (!result.ok) {
      setLoadState("failed");
      setErrorReason(result.reason);
      return;
    }
    const persisted = result.value.items.map(toDocumentConversationSession);
    updateSessions((current) => {
      const pending = current.filter(sessionHasPendingPersistence);
      if (pending.length === 0) return persisted;
      const pendingIds = new Set(pending.map((session) => session.id));
      return dedupeConversationSessions([
        ...pending,
        ...persisted.filter((session) => !pendingIds.has(session.id)),
      ]);
    });
    setLoadState("loaded");
    setErrorReason(latestRetryReason());
  }, [documentId, store, updateSessions]);

  useEffect(() => {
    const scope = `${storageMode}:${workspaceId}:${documentId}`;
    if (scopeRef.current === scope) return;
    scopeRef.current = scope;
    loadGenerationRef.current += 1;
    conversationMutationTailsRef.current.clear();
    conversationMutationCountsRef.current.clear();
    pendingRetriesRef.current.clear();
    setPendingRetryCount(0);
    activeAttemptsRef.current.clear();
    setErrorReason(initialLoadFailed ? "unavailable" : null);
    setLoadState(initialLoadFailed ? "failed" : initialConversations ? "loaded" : "loading");
    updateSessions(() => initialSessions);
  }, [documentId, initialConversations, initialLoadFailed, initialSessions, storageMode, updateSessions, workspaceId]);

  useEffect(() => {
    if (initialConversations || initialLoadFailed) return;
    let active = true;
    queueMicrotask(() => {
      if (active) void load();
    });
    return () => {
      active = false;
      loadGenerationRef.current += 1;
    };
  }, [initialConversations, initialLoadFailed, load]);

  async function persistCreate(attempt: ConversationAttempt): Promise<StoredConversationView | null> {
    const retryKey = `create:${attempt.localId}`;
    const result = await store.create(attempt.state.createInput);
    if (!result.ok) {
      updateSessions((current) => current.map((session) =>
        session.id === attempt.localId ? { ...session, syncStatus: "unsaved" } : session
      ));
      registerRetry(retryKey, result.reason, async () => {
        updateSessions((current) => current.map((session) =>
          session.id === attempt.localId ? { ...session, syncStatus: "saving" } : session
        ));
        const canonical = await persistCreate(attempt);
        if (canonical && attempt.state.assistant) {
          await persistAssistant(attempt, canonical, attempt.state.assistant);
        } else if (canonical && attempt.state.targetStatus === "failed") {
          await persistAttemptStatus(attempt, "failed");
        }
      });
      return null;
    }
    attempt.state.canonical = result.value;
    const needsFollowUp = Boolean(attempt.state.assistant) || attempt.state.targetStatus === "failed";
    updateSessions((current) => dedupeConversationSessions(current.map((session) => {
      if (session.id !== attempt.localId && session.id !== result.value.id) return session;
      const canonical = toDocumentConversationSession(result.value);
      return {
        ...canonical,
        messages: session.messages.length > canonical.messages.length ? session.messages : canonical.messages,
        status: session.status,
        syncStatus: session.messages.length > canonical.messages.length || needsFollowUp ? "saving" : "saved",
      };
    })));
    clearRetry(retryKey);
    return result.value;
  }

  async function persistAssistant(
    attempt: ConversationAttempt,
    canonical: StoredConversationView,
    input: CompleteConversationInput,
  ) {
    const mutationKey = `append_${nanoid(24)}`;
    const retryKey = `append:${attempt.localId}`;
    const append = () => withConversationMutation(attempt.localId, async () => {
      const base = attempt.state.canonical ?? canonical;
      return store.append(documentId, base.id, {
        aiRunId: input.aiRunId ?? null,
        command: input.command ?? attempt.state.createInput.command,
        content: input.content,
        expectedVersion: base.version,
        mutationKey,
        proposalId: input.proposalId ?? null,
        role: "assistant",
        status: "idle",
      });
    });
    const result = await append();
    if (!result.ok) {
      updateSessions((current) => current.map((session) =>
        matchesAttempt(session, attempt) ? { ...session, syncStatus: "unsaved" } : session
      ));
      const retryAppend = async () => {
        updateSessions((current) => current.map((session) =>
          matchesAttempt(session, attempt) ? { ...session, syncStatus: "saving" } : session
        ));
        const replay = await append();
        applyPersistedResult(replay, attempt, "idle", retryKey);
        if (!replay.ok) registerRetry(retryKey, replay.reason, retryAppend);
      };
      registerRetry(retryKey, result.reason, retryAppend);
      return;
    }
    attempt.state.canonical = result.value;
    applyPersistedResult(result, attempt, "idle", retryKey);
  }

  function applyPersistedResult(
    result: StoreResult<StoredConversationView>,
    attempt: ConversationAttempt,
    executionStatus: DocumentConversationSession["status"],
    retryKey: string,
  ) {
    if (!result.ok) {
      setErrorReason(result.reason);
      updateSessions((current) => current.map((session) =>
        matchesAttempt(session, attempt) ? { ...session, syncStatus: "unsaved" } : session
      ));
      return;
    }
    attempt.state.canonical = result.value;
    updateSessions((current) => dedupeConversationSessions(current.map((session) =>
      matchesAttempt(session, attempt)
        ? reconcilePersistedSession(result.value, session, executionStatus, attempt.localId)
        : session
    )));
    clearRetry(retryKey);
  }

  function beginConversation(input: {
    command: string;
    content: string;
    scopeLabel?: string;
    title: string;
  }): ConversationAttempt {
    const now = new Date();
    const localId = `pending_${nanoid(24)}`;
    const createInput = {
      command: input.command,
      creationKey: `create_${nanoid(24)}`,
      documentId,
      initialMessage: {
        command: input.command,
        content: input.content,
        mutationKey: `message_${nanoid(24)}`,
        role: "user" as const,
        scopeLabel: input.scopeLabel ?? null,
      },
      title: input.title,
    };
    const attempt = {
      localId,
      ready: Promise.resolve(null) as Promise<StoredConversationView | null>,
      state: { assistant: null, canonical: null, createInput, targetStatus: "running" },
    } satisfies ConversationAttempt;
    activeAttemptsRef.current.add(attempt);
    updateSessions((current) => [{
      archived: false,
      command: input.command,
      createdAt: now,
      id: localId,
      messages: [{
        command: input.command,
        content: input.content,
        createdAt: now,
        id: `pending_message_${nanoid(16)}`,
        role: "user",
        scopeLabel: input.scopeLabel,
      }],
      status: "running",
      syncStatus: "saving",
      title: input.title,
      updatedAt: now,
      version: 1,
    }, ...current]);
    attempt.ready = persistCreate(attempt);
    return attempt;
  }

  async function completeConversation(attempt: ConversationAttempt, input: CompleteConversationInput) {
    const now = new Date();
    attempt.state.assistant = input;
    attempt.state.targetStatus = "idle";
    updateSessions((current) => current.map((session) => matchesAttempt(session, attempt)
      ? {
          ...session,
          messages: [...session.messages, {
            aiRunId: input.aiRunId ?? undefined,
            command: input.command ?? session.command,
            content: input.content,
            createdAt: now,
            id: `pending_assistant_${nanoid(16)}`,
            proposalId: input.proposalId ?? undefined,
            role: "assistant",
          }],
          status: "idle",
          syncStatus: "saving",
          updatedAt: now,
        }
      : session));
    const canonical = attempt.state.canonical ?? await attempt.ready;
    if (!canonical) {
      updateSessions((current) => current.map((session) =>
        matchesAttempt(session, attempt) ? { ...session, syncStatus: "unsaved" } : session
      ));
      return;
    }
    await persistAssistant(attempt, canonical, input);
  }

  async function failConversation(attempt: ConversationAttempt) {
    attempt.state.targetStatus = "failed";
    updateSessions((current) => current.map((session) =>
      matchesAttempt(session, attempt)
        ? { ...session, status: "failed", syncStatus: "saving", updatedAt: new Date() }
        : session
    ));
    const canonical = attempt.state.canonical ?? await attempt.ready;
    if (!canonical) {
      updateSessions((current) => current.map((session) =>
        matchesAttempt(session, attempt) ? { ...session, syncStatus: "unsaved" } : session
      ));
      return;
    }
    await persistAttemptStatus(attempt, "failed");
  }

  async function persistAttemptStatus(
    attempt: ConversationAttempt,
    status: Extract<DocumentConversationSession["status"], "failed" | "idle">,
  ) {
    const retryKey = `status:${attempt.localId}`;
    const persistStatus = async () => {
      const canonical = attempt.state.canonical;
      if (!canonical) return;
      updateSessions((current) => current.map((session) =>
        matchesAttempt(session, attempt) ? { ...session, syncStatus: "saving" } : session
      ));
      const result = await withConversationMutation(attempt.localId, async () => {
        const latest = attempt.state.canonical ?? canonical;
        return store.setStatus(documentId, latest.id, {
          expectedVersion: latest.version,
          status,
        });
      });
      applyPersistedResult(result, attempt, status, retryKey);
      if (!result.ok) registerRetry(retryKey, result.reason, persistStatus);
    };
    await persistStatus();
  }

  function markConversationIdle(attempt: ConversationAttempt) {
    attempt.state.targetStatus = "idle";
    updateSessions((current) => current.map((session) =>
      matchesAttempt(session, attempt) ? { ...session, status: "idle" } : session
    ));
  }

  async function renameConversation(conversationId: string, title: string) {
    const previous = sessionsRef.current.find((session) => session.id === conversationId);
    const nextTitle = title.trim();
    if (!previous || !nextTitle) return;
    const retryKey = `rename:${conversationId}`;
    const generation = loadGenerationRef.current;
    const mutationKey = conversationMutationKey(conversationId);
    const waitsForPriorMutation = conversationMutationTailsRef.current.has(mutationKey);
    clearRetry(retryKey);
    updateSessions((current) => current.map((session) => session.id === conversationId
      ? { ...session, syncStatus: "saving", title: nextTitle }
      : session));
    await withConversationMutation(mutationKey, async () => {
      if (generation !== loadGenerationRef.current) return;
      const latest = sessionsRef.current.find((session) => session.id === conversationId);
      if (!latest) return;
      const base = waitsForPriorMutation ? { ...latest, title: previous.title } : previous;
      updateSessions((current) => current.map((session) => session.id === conversationId
        ? { ...session, syncStatus: "saving", title: nextTitle }
        : session));
      const result = await store.rename(documentId, conversationId, {
        expectedVersion: base.version,
        title: nextTitle,
      });
      if (generation !== loadGenerationRef.current) return;
      if (!result.ok) {
        updateSessions((current) => current.map((session) => session.id === conversationId ? base : session));
        registerRetry(retryKey, result.reason, () => renameConversation(conversationId, nextTitle));
        return;
      }
      syncAttemptCanonical(result.value);
      updateSessions((current) => current.map((session) => session.id === conversationId
        ? reconcilePersistedSession(result.value, session, session.status, mutationKey)
        : session));
      clearRetry(retryKey);
    });
  }

  async function archiveConversation(conversationId: string) {
    const previous = sessionsRef.current.find((session) => session.id === conversationId);
    if (!previous) return;
    const retryKey = `archive:${conversationId}`;
    const generation = loadGenerationRef.current;
    const mutationKey = conversationMutationKey(conversationId);
    const waitsForPriorMutation = conversationMutationTailsRef.current.has(mutationKey);
    clearRetry(retryKey);
    updateSessions((current) => current.map((session) => session.id === conversationId
      ? { ...session, archived: true, syncStatus: "saving" }
      : session));
    await withConversationMutation(mutationKey, async () => {
      if (generation !== loadGenerationRef.current) return;
      const latest = sessionsRef.current.find((session) => session.id === conversationId);
      if (!latest) return;
      const base = waitsForPriorMutation ? { ...latest, archived: previous.archived } : previous;
      updateSessions((current) => current.map((session) => session.id === conversationId
        ? { ...session, archived: true, syncStatus: "saving" }
        : session));
      const result = await store.archive(documentId, conversationId, {
        archived: true,
        expectedVersion: base.version,
      });
      if (generation !== loadGenerationRef.current) return;
      if (!result.ok) {
        updateSessions((current) => current.map((session) => session.id === conversationId ? base : session));
        registerRetry(retryKey, result.reason, () => archiveConversation(conversationId));
        return;
      }
      syncAttemptCanonical(result.value);
      updateSessions((current) => current.map((session) => session.id === conversationId
        ? reconcilePersistedSession(result.value, session, session.status, mutationKey)
        : session));
      clearRetry(retryKey);
    });
  }

  async function forkConversation(conversationId: string, throughMessageId: string) {
    const source = sessionsRef.current.find((session) => session.id === conversationId);
    if (!source || source.syncStatus !== "saved") return;
    const attempt = Array.from(activeAttemptsRef.current).find((candidate) => matchesAttempt(source, candidate));
    const durableMessages = attempt?.state.canonical?.messages ?? source.messages;
    if (!durableMessages.some((message) => message.id === throughMessageId)) return;
    const creationKey = `fork_${nanoid(24)}`;
    await persistFork(
      conversationId,
      throughMessageId,
      source.title,
      creationKey,
      conversationMutationKey(conversationId),
    );
  }

  async function persistFork(
    conversationId: string,
    throughMessageId: string,
    sourceTitle: string,
    creationKey: string,
    mutationKey: string,
  ) {
    const retryKey = `fork:${creationKey}`;
    const result = await withConversationMutation(mutationKey, async () => {
      const source = sessionsRef.current.find((session) => session.id === conversationId);
      if (!source || source.syncStatus !== "saved") return null;
      const attempt = Array.from(activeAttemptsRef.current).find((candidate) => matchesAttempt(source, candidate));
      const durableMessages = attempt?.state.canonical?.messages ?? source.messages;
      if (!durableMessages.some((message) => message.id === throughMessageId)) return null;
      return store.fork(documentId, conversationId, {
        creationKey,
        throughMessageId,
        title: `${sourceTitle} copy`,
      });
    });
    if (!result) {
      clearRetry(retryKey);
      return;
    }
    if (!result.ok) {
      registerRetry(
        retryKey,
        result.reason,
        () => persistFork(conversationId, throughMessageId, sourceTitle, creationKey, mutationKey),
      );
      return;
    }
    updateSessions((current) => [toDocumentConversationSession(result.value), ...current]);
    clearRetry(retryKey);
  }

  async function retryLastMutation() {
    const pending = Array.from(pendingRetriesRef.current.entries());
    if (pending.length === 0) return;
    for (const [key, entry] of pending) {
      if (pendingRetriesRef.current.get(key) !== entry) continue;
      await entry.retry();
    }
    setErrorReason(latestRetryReason());
  }

  return {
    archiveConversation,
    beginConversation,
    completeConversation,
    errorReason,
    failConversation,
    forkConversation,
    loadState,
    hasPendingRetries: pendingRetryCount > 0,
    markConversationIdle,
    reload: load,
    renameConversation,
    retryLastMutation,
    sessions,
  };
}

function toDocumentConversationSession(conversation: StoredConversationView): DocumentConversationSession {
  return {
    archived: conversation.archived,
    command: conversation.command,
    createdAt: conversation.createdAt,
    id: conversation.id,
    messages: conversation.messages.map((message) => ({
      aiRunId: message.aiRunId ?? undefined,
      command: message.command ?? undefined,
      content: message.content,
      createdAt: message.createdAt,
      id: message.id,
      proposalId: message.proposalId ?? undefined,
      role: message.role,
      scopeLabel: message.scopeLabel ?? undefined,
    })),
    status: conversation.status,
    syncStatus: conversation.syncStatus,
    title: conversation.title,
    updatedAt: conversation.updatedAt,
    version: conversation.version,
  };
}

function matchesAttempt(session: DocumentConversationSession, attempt: ConversationAttempt) {
  return session.id === attempt.localId || session.id === attempt.state.canonical?.id;
}

function dedupeConversationSessions(sessions: DocumentConversationSession[]) {
  const seen = new Set<string>();
  return sessions.filter((session) => {
    if (seen.has(session.id)) return false;
    seen.add(session.id);
    return true;
  });
}

function createUnavailableStore(): ConversationStore {
  const unavailable = async (): Promise<{ ok: false; reason: "unavailable" }> => ({
    ok: false,
    reason: "unavailable",
  });
  return {
    append: unavailable,
    archive: unavailable,
    create: unavailable,
    fork: unavailable,
    list: unavailable,
    rename: unavailable,
    setStatus: unavailable,
  };
}
