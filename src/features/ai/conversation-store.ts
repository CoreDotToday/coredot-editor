import { nanoid } from "nanoid";
import {
  CONVERSATION_LIMITS,
  type AppendConversationInput,
  type Conversation,
  type ConversationPage,
  type ConversationResult,
  type ConversationSummary,
  type CreateConversationInput,
  decodeConversationCursor,
  encodeConversationCursor,
  isExpectedVersion,
  isValidAppendInput,
  isValidCreateInput,
  isValidKey,
} from "./conversation-domain";

export type ConversationStorageMode = "database" | "local";
export type ConversationSyncStatus = "saved" | "saving" | "unsaved";
export type StoredConversationView = Conversation & { syncStatus: ConversationSyncStatus };
export type StoredConversationSummary = ConversationSummary & { syncStatus: ConversationSyncStatus };
export type StoreResult<T> = ConversationResult<T> | { ok: false; reason: "unavailable" };

export interface ConversationStore {
  append(documentId: string, conversationId: string, input: AppendConversationInput): Promise<StoreResult<StoredConversationView>>;
  archive(
    documentId: string,
    conversationId: string,
    input: { archived: boolean; expectedVersion: number },
  ): Promise<StoreResult<StoredConversationView>>;
  create(input: CreateConversationInput): Promise<StoreResult<StoredConversationView>>;
  get(documentId: string, conversationId: string): Promise<StoreResult<StoredConversationView>>;
  fork(
    documentId: string,
    conversationId: string,
    input: { creationKey: string; throughMessageId: string; title: string },
  ): Promise<StoreResult<StoredConversationView>>;
  list(input: {
    cursor?: string;
    documentId: string;
    includeArchived?: boolean;
    limit?: number;
  }): Promise<StoreResult<{ items: StoredConversationSummary[]; nextCursor: string | null }>>;
  rename(
    documentId: string,
    conversationId: string,
    input: { expectedVersion: number; title: string },
  ): Promise<StoreResult<StoredConversationView>>;
  setStatus(
    documentId: string,
    conversationId: string,
    input: { expectedVersion: number; status: "failed" | "idle" },
  ): Promise<StoreResult<StoredConversationView>>;
}

type Repository = {
  append: (
    context: never,
    conversationId: string,
    input: AppendConversationInput,
  ) => Promise<ConversationResult<Conversation>>;
  archive: (
    context: never,
    conversationId: string,
    input: { archived: boolean; expectedVersion: number },
  ) => Promise<ConversationResult<Conversation>>;
  create: (context: never, input: CreateConversationInput) => Promise<ConversationResult<Conversation>>;
  get: (context: never, conversationId: string) => Promise<ConversationResult<Conversation>>;
  fork: (
    context: never,
    conversationId: string,
    input: { creationKey: string; throughMessageId: string; title: string },
  ) => Promise<ConversationResult<Conversation>>;
  list: (
    context: never,
    input: { cursor?: string; documentId: string; includeArchived?: boolean; limit?: number },
  ) => Promise<ConversationResult<ConversationPage>>;
  rename: (
    context: never,
    conversationId: string,
    input: { expectedVersion: number; title: string },
  ) => Promise<ConversationResult<Conversation>>;
  setStatus: (
    context: never,
    conversationId: string,
    input: { expectedVersion: number; status: "failed" | "idle" },
  ) => Promise<ConversationResult<Conversation>>;
};

export function createRepositoryConversationStore<TContext>(repository: RepositoryWithContext<TContext>, context: TContext) {
  const wrap = async <T>(operation: () => Promise<ConversationResult<T>>): Promise<StoreResult<T>> => {
    try {
      return await operation();
    } catch {
      return { ok: false, reason: "unavailable" };
    }
  };
  const saved = (result: StoreResult<Conversation>): StoreResult<StoredConversationView> =>
    result.ok ? { ...result, value: { ...result.value, syncStatus: "saved" } } : result;

  return {
    async append(_documentId: string, conversationId: string, input: AppendConversationInput) {
      return saved(await wrap(() => repository.append(context, conversationId, input)));
    },
    async archive(
      _documentId: string,
      conversationId: string,
      input: { archived: boolean; expectedVersion: number },
    ) {
      return saved(await wrap(() => repository.archive(context, conversationId, input)));
    },
    async create(input: CreateConversationInput) {
      return saved(await wrap(() => repository.create(context, input)));
    },
    async get(_documentId: string, conversationId: string) {
      return saved(await wrap(() => repository.get(context, conversationId)));
    },
    async fork(
      _documentId: string,
      conversationId: string,
      input: { creationKey: string; throughMessageId: string; title: string },
    ) {
      return saved(await wrap(() => repository.fork(context, conversationId, input)));
    },
    async list(input: { cursor?: string; documentId: string; includeArchived?: boolean; limit?: number }) {
      const result = await wrap(() => repository.list(context, input));
      return result.ok
        ? {
            ...result,
            value: {
              ...result.value,
              items: result.value.items.map((conversation) => ({ ...conversation, syncStatus: "saved" as const })),
            },
          }
        : result;
    },
    async rename(_documentId: string, conversationId: string, input: { expectedVersion: number; title: string }) {
      return saved(await wrap(() => repository.rename(context, conversationId, input)));
    },
    async setStatus(
      _documentId: string,
      conversationId: string,
      input: { expectedVersion: number; status: "failed" | "idle" },
    ) {
      return saved(await wrap(() => repository.setStatus(context, conversationId, input)));
    },
  } satisfies ConversationStore;
}

type RepositoryWithContext<TContext> = Omit<Repository, keyof Repository> & {
  append: (context: TContext, conversationId: string, input: AppendConversationInput) => Promise<ConversationResult<Conversation>>;
  archive: (
    context: TContext,
    conversationId: string,
    input: { archived: boolean; expectedVersion: number },
  ) => Promise<ConversationResult<Conversation>>;
  create: (context: TContext, input: CreateConversationInput) => Promise<ConversationResult<Conversation>>;
  get: (context: TContext, conversationId: string) => Promise<ConversationResult<Conversation>>;
  fork: (
    context: TContext,
    conversationId: string,
    input: { creationKey: string; throughMessageId: string; title: string },
  ) => Promise<ConversationResult<Conversation>>;
  list: (
    context: TContext,
    input: { cursor?: string; documentId: string; includeArchived?: boolean; limit?: number },
  ) => Promise<ConversationResult<ConversationPage>>;
  rename: (
    context: TContext,
    conversationId: string,
    input: { expectedVersion: number; title: string },
  ) => Promise<ConversationResult<Conversation>>;
  setStatus: (
    context: TContext,
    conversationId: string,
    input: { expectedVersion: number; status: "failed" | "idle" },
  ) => Promise<ConversationResult<Conversation>>;
};

type StorageLike = Pick<Storage, "getItem" | "removeItem" | "setItem">;
type LocalMessage = Conversation["messages"][number] & {
  mutationFingerprint: string;
  mutationKey: string;
};
type LocalConversation = Omit<Conversation, "messages"> & {
  creationFingerprint: string;
  creationKey: string;
  messages: LocalMessage[];
};
type SerializedLocalConversation = Omit<LocalConversation, "createdAt" | "messages" | "retentionExpiresAt" | "updatedAt"> & {
  createdAt: string;
  messages: Array<Omit<LocalMessage, "createdAt"> & { createdAt: string }>;
  retentionExpiresAt: string | null;
  updatedAt: string;
};

export function createLocalConversationStore(storage: StorageLike, workspaceId: string): ConversationStore {
  function read(documentId: string): StoreResult<LocalConversation[]> {
    try {
      const raw = storage.getItem(localStorageKey(workspaceId, documentId));
      if (!raw) return { ok: true, value: [] };
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return { ok: false, reason: "unavailable" };
      const conversations = parsed.flatMap(parseLocalConversation);
      if (
        conversations.length !== parsed.length ||
        conversations.some((conversation) => conversation.documentId !== documentId) ||
        new Set(conversations.map((conversation) => conversation.id)).size !== conversations.length
      ) {
        return { ok: false, reason: "unavailable" };
      }
      return { ok: true, value: conversations };
    } catch {
      return { ok: false, reason: "unavailable" };
    }
  }

  function write(documentId: string, conversations: LocalConversation[]): StoreResult<LocalConversation[]> {
    try {
      const key = localStorageKey(workspaceId, documentId);
      if (conversations.length === 0) storage.removeItem(key);
      else storage.setItem(key, JSON.stringify(conversations.map(serializeLocalConversation)));
      return { ok: true, value: conversations };
    } catch {
      return { ok: false, reason: "unavailable" };
    }
  }

  const publicResult = (
    result: StoreResult<LocalConversation>,
  ): StoreResult<StoredConversationView> => result.ok
    ? { ...result, value: toStoredConversationView(result.value) }
    : result;

  return {
    async get(documentId, conversationId) {
      const result = read(documentId);
      if (!result.ok) return result;
      const activeRecord = findActiveLocalConversation(result.value, conversationId);
      return activeRecord
        ? { ok: true, value: toStoredConversationView(activeRecord.conversation) }
        : { ok: false, reason: "not_found" };
    },

    async list(input) {
      const cursorScope = {
        documentId: input.documentId,
        includeArchived: input.includeArchived ?? false,
        workspaceId,
      };
      const cursor = input.cursor ? decodeConversationCursor(input.cursor, cursorScope) : null;
      if (input.cursor && !cursor) return { ok: false, reason: "invalid" };
      const result = read(input.documentId);
      if (!result.ok) return result;
      const limit = input.limit ?? CONVERSATION_LIMITS.defaultPageSize;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > CONVERSATION_LIMITS.maximumPageSize) {
        return { ok: false, reason: "invalid" };
      }
      const sorted = result.value
        .filter(isActiveLocalConversation)
        .filter((conversation) => input.includeArchived || !conversation.archived)
        .filter((conversation) => !cursor ||
          conversation.updatedAt.getTime() < cursor.updatedAt.getTime() ||
          (conversation.updatedAt.getTime() === cursor.updatedAt.getTime() && conversation.id < cursor.id))
        .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime() || compareIdsDescending(left.id, right.id));
      const page = sorted.slice(0, limit + 1);
      const items = page.slice(0, limit);
      const last = items.at(-1);
      return {
        ok: true,
        value: {
          items: items.map(toStoredConversationSummary),
          nextCursor: page.length > limit && last
            ? encodeConversationCursor(last.updatedAt, last.id, cursorScope)
            : null,
        },
      };
    },

    async create(input) {
      if (!isValidCreateInput(input)) return { ok: false, reason: "invalid" };
      const current = read(input.documentId);
      if (!current.ok) return current;
      const fingerprint = localFingerprint({ ...input, retentionExpiresAt: input.retentionExpiresAt?.toISOString() ?? null });
      const existing = current.value.find((conversation) => conversation.creationKey === input.creationKey);
      if (existing) {
        if (!isActiveLocalConversation(existing)) return { ok: false, reason: "not_found" };
        return existing.creationFingerprint === fingerprint
          ? { ok: true, replayed: true, value: toStoredConversationView(existing) }
          : { ok: false, reason: "conflict" };
      }
      const activeCount = current.value.filter(isActiveLocalConversation).length;
      if (activeCount >= CONVERSATION_LIMITS.conversationsPerDocument) {
        return { ok: false, reason: "limit" };
      }
      const now = new Date();
      const message: LocalMessage = {
        aiRunId: null,
        command: input.initialMessage.command ?? null,
        content: input.initialMessage.content,
        createdAt: now,
        id: nanoid(),
        mutationFingerprint: localFingerprint(input.initialMessage),
        mutationKey: input.initialMessage.mutationKey,
        proposalId: null,
        role: "user",
        scopeLabel: input.initialMessage.scopeLabel ?? null,
      };
      const created: LocalConversation = {
        archived: false,
        command: input.command,
        createdAt: now,
        creationFingerprint: fingerprint,
        creationKey: input.creationKey,
        documentId: input.documentId,
        id: nanoid(),
        latestAiRunId: null,
        latestProposalId: null,
        messageCount: 1,
        messages: [message],
        retentionExpiresAt: input.retentionExpiresAt ?? null,
        status: "idle",
        title: input.title.trim(),
        updatedAt: now,
        version: 1,
      };
      const persisted = write(input.documentId, [created, ...current.value]);
      return persisted.ok
        ? { ok: true, replayed: false, value: toStoredConversationView(created) }
        : persisted;
    },

    async append(documentId, conversationId, input) {
      if (!isValidAppendInput(input)) return { ok: false, reason: "invalid" };
      const current = read(documentId);
      if (!current.ok) return current;
      const activeRecord = findActiveLocalConversation(current.value, conversationId);
      if (!activeRecord) return { ok: false, reason: "not_found" };
      const { conversation, index } = activeRecord;
      const fingerprint = localFingerprint({
        aiRunId: input.aiRunId ?? null,
        command: input.command ?? null,
        content: input.content,
        proposalId: input.proposalId ?? null,
        role: input.role,
        scopeLabel: input.scopeLabel ?? null,
        status: input.status,
      });
      const existing = conversation.messages.find((message) => message.mutationKey === input.mutationKey);
      if (existing) {
        return existing.mutationFingerprint === fingerprint
          ? { ok: true, replayed: true, value: toStoredConversationView(conversation) }
          : { ok: false, reason: "conflict" };
      }
      if (conversation.version !== input.expectedVersion) return { ok: false, reason: "conflict" };
      if (conversation.messageCount >= CONVERSATION_LIMITS.messagesPerConversation) {
        return { ok: false, reason: "limit" };
      }
      const characterCount = conversation.messages.reduce((total, message) => total + message.content.length, 0);
      if (characterCount + input.content.length > CONVERSATION_LIMITS.charactersPerConversation) {
        return { ok: false, reason: "limit" };
      }
      const now = new Date();
      const hasLink = Boolean(input.aiRunId || input.proposalId);
      const next: LocalConversation = {
        ...conversation,
        latestAiRunId: hasLink ? input.aiRunId ?? null : conversation.latestAiRunId,
        latestProposalId: hasLink ? input.proposalId ?? null : conversation.latestProposalId,
        messageCount: conversation.messageCount + 1,
        messages: [...conversation.messages, {
          aiRunId: input.aiRunId ?? null,
          command: input.command ?? null,
          content: input.content,
          createdAt: now,
          id: nanoid(),
          mutationFingerprint: fingerprint,
          mutationKey: input.mutationKey,
          proposalId: input.proposalId ?? null,
          role: input.role,
          scopeLabel: input.scopeLabel ?? null,
        }],
        status: input.status,
        updatedAt: now,
        version: conversation.version + 1,
      };
      const conversations = current.value.with(index, next);
      const persisted = write(documentId, conversations);
      return publicResult(persisted.ok ? { ok: true, value: next } : persisted);
    },

    async rename(documentId, conversationId, input) {
      const title = input.title.trim();
      if (!title || title.length > CONVERSATION_LIMITS.titleCharacters || !isExpectedVersion(input.expectedVersion)) {
        return { ok: false, reason: "invalid" };
      }
      return updateLocalConversation(documentId, conversationId, input.expectedVersion, (conversation) => ({
        ...conversation,
        title,
      }), (conversation) => conversation.title === title);
    },

    async archive(documentId, conversationId, input) {
      if (!isExpectedVersion(input.expectedVersion) || typeof input.archived !== "boolean") {
        return { ok: false, reason: "invalid" };
      }
      return updateLocalConversation(documentId, conversationId, input.expectedVersion, (conversation) => ({
        ...conversation,
        archived: input.archived,
      }), (conversation) => conversation.archived === input.archived);
    },

    async setStatus(documentId, conversationId, input) {
      if (!isExpectedVersion(input.expectedVersion) || (input.status !== "failed" && input.status !== "idle")) {
        return { ok: false, reason: "invalid" };
      }
      return updateLocalConversation(documentId, conversationId, input.expectedVersion, (conversation) => ({
        ...conversation,
        status: input.status,
      }), (conversation) => conversation.status === input.status);
    },

    async fork(documentId, conversationId, input) {
      const title = input.title.trim();
      if (!isValidKey(input.creationKey) || !input.throughMessageId || !title || title.length > CONVERSATION_LIMITS.titleCharacters) {
        return { ok: false, reason: "invalid" };
      }
      const current = read(documentId);
      if (!current.ok) return current;
      const activeSource = findActiveLocalConversation(current.value, conversationId);
      if (!activeSource) return { ok: false, reason: "not_found" };
      const fingerprint = localFingerprint({ conversationId, throughMessageId: input.throughMessageId, title });
      const existing = current.value.find((conversation) => conversation.creationKey === input.creationKey);
      if (existing) {
        if (!isActiveLocalConversation(existing)) return { ok: false, reason: "not_found" };
        return existing.creationFingerprint === fingerprint
          ? { ok: true, replayed: true, value: toStoredConversationView(existing) }
          : { ok: false, reason: "conflict" };
      }
      const source = activeSource.conversation;
      const throughIndex = source.messages.findIndex((message) => message.id === input.throughMessageId);
      if (throughIndex < 0) return { ok: false, reason: "not_found" };
      const activeCount = current.value.filter(isActiveLocalConversation).length;
      if (activeCount >= CONVERSATION_LIMITS.conversationsPerDocument) {
        return { ok: false, reason: "limit" };
      }
      const now = new Date();
      const messages = source.messages.slice(0, throughIndex + 1).map((message) => ({
        ...message,
        id: nanoid(),
        mutationKey: `fork_${message.id}`,
      }));
      const lastLinked = [...messages].reverse().find((message) => message.aiRunId || message.proposalId);
      const forked: LocalConversation = {
        ...source,
        archived: false,
        createdAt: now,
        creationFingerprint: fingerprint,
        creationKey: input.creationKey,
        id: nanoid(),
        latestAiRunId: lastLinked?.aiRunId ?? null,
        latestProposalId: lastLinked?.proposalId ?? null,
        messageCount: messages.length,
        messages,
        status: "idle",
        title,
        updatedAt: now,
        version: 1,
      };
      const persisted = write(documentId, [forked, ...current.value]);
      return persisted.ok
        ? { ok: true, replayed: false, value: toStoredConversationView(forked) }
        : persisted;
    },
  };

  async function updateLocalConversation(
    documentId: string,
    conversationId: string,
    expectedVersion: number,
    update: (conversation: LocalConversation) => LocalConversation,
    isNoChange: (conversation: LocalConversation) => boolean,
  ): Promise<StoreResult<StoredConversationView>> {
    const current = read(documentId);
    if (!current.ok) return current;
    const activeRecord = findActiveLocalConversation(current.value, conversationId);
    if (!activeRecord) return { ok: false, reason: "not_found" };
    const { conversation, index } = activeRecord;
    if (isNoChange(conversation)) {
      return { ok: true, replayed: true, value: toStoredConversationView(conversation) };
    }
    if (conversation.version !== expectedVersion) return { ok: false, reason: "conflict" };
    const next = { ...update(conversation), updatedAt: new Date(), version: conversation.version + 1 };
    const persisted = write(documentId, current.value.with(index, next));
    return publicResult(persisted.ok ? { ok: true, value: next } : persisted);
  }
}

function isActiveLocalConversation(conversation: LocalConversation) {
  return !conversation.retentionExpiresAt || conversation.retentionExpiresAt.getTime() > Date.now();
}

function findActiveLocalConversation(conversations: LocalConversation[], conversationId: string) {
  const index = conversations.findIndex((conversation) => conversation.id === conversationId);
  if (index < 0) return null;
  const conversation = conversations[index]!;
  return isActiveLocalConversation(conversation) ? { conversation, index } : null;
}

export function resolveConversationStorageMode(value: string | undefined): ConversationStorageMode {
  const normalized = value?.trim() || "database";
  if (normalized === "database" || normalized === "local") return normalized;
  throw new Error(`Invalid CONVERSATION_STORAGE: ${normalized}`);
}

function localStorageKey(workspaceId: string, documentId: string) {
  return `coredot-ai-workspace-conversations:v2:${encodeURIComponent(workspaceId)}:${encodeURIComponent(documentId)}`;
}

function compareIdsDescending(left: string, right: string) {
  if (left === right) return 0;
  return left < right ? 1 : -1;
}

function localFingerprint(value: unknown) {
  return JSON.stringify(value);
}

function toStoredConversationView(conversation: LocalConversation): StoredConversationView {
  return {
    archived: conversation.archived,
    command: conversation.command,
    createdAt: conversation.createdAt,
    documentId: conversation.documentId,
    id: conversation.id,
    latestAiRunId: conversation.latestAiRunId,
    latestProposalId: conversation.latestProposalId,
    messageCount: conversation.messageCount,
    messages: conversation.messages.map(toPublicLocalMessage),
    retentionExpiresAt: conversation.retentionExpiresAt,
    status: conversation.status,
    syncStatus: "saved",
    title: conversation.title,
    updatedAt: conversation.updatedAt,
    version: conversation.version,
  };
}

function toStoredConversationSummary(conversation: LocalConversation): StoredConversationSummary {
  const { messages: _messages, ...summary } = toStoredConversationView(conversation);
  void _messages;
  return summary;
}

function toPublicLocalMessage(message: LocalMessage): Conversation["messages"][number] {
  return {
    aiRunId: message.aiRunId,
    command: message.command,
    content: message.content,
    createdAt: message.createdAt,
    id: message.id,
    proposalId: message.proposalId,
    role: message.role,
    scopeLabel: message.scopeLabel,
  };
}

function serializeLocalConversation(conversation: LocalConversation): SerializedLocalConversation {
  return {
    ...conversation,
    createdAt: conversation.createdAt.toISOString(),
    messages: conversation.messages.map((message) => ({ ...message, createdAt: message.createdAt.toISOString() })),
    retentionExpiresAt: conversation.retentionExpiresAt?.toISOString() ?? null,
    updatedAt: conversation.updatedAt.toISOString(),
  };
}

function parseLocalConversation(value: unknown): LocalConversation[] {
  if (!value || typeof value !== "object") return [];
  const item = value as Partial<SerializedLocalConversation>;
  if (
    typeof item.id !== "string" ||
    typeof item.documentId !== "string" ||
    typeof item.creationKey !== "string" ||
    typeof item.creationFingerprint !== "string" ||
    typeof item.title !== "string" ||
    typeof item.command !== "string" ||
    typeof item.createdAt !== "string" ||
    typeof item.updatedAt !== "string" ||
    !Array.isArray(item.messages) ||
    !Number.isSafeInteger(item.version) ||
    !Number.isSafeInteger(item.messageCount)
  ) return [];
  const messages = item.messages.flatMap(parseLocalMessage);
  const createdAt = new Date(item.createdAt);
  const updatedAt = new Date(item.updatedAt);
  const retentionExpiresAt = typeof item.retentionExpiresAt === "string"
    ? new Date(item.retentionExpiresAt)
    : item.retentionExpiresAt === null ? null : undefined;
  if (
    messages.length !== item.messages.length ||
    messages.length !== item.messageCount ||
    new Set(messages.map((message) => message.id)).size !== messages.length ||
    new Set(messages.map((message) => message.mutationKey)).size !== messages.length ||
    !isFiniteDate(createdAt) ||
    !isFiniteDate(updatedAt) ||
    retentionExpiresAt === undefined ||
    (retentionExpiresAt !== null && !isFiniteDate(retentionExpiresAt)) ||
    typeof item.archived !== "boolean" ||
    (item.status !== "failed" && item.status !== "idle") ||
    Number(item.version) < 1 ||
    Number(item.messageCount) < 1 ||
    messages.reduce((total, message) => total + message.content.length, 0) > CONVERSATION_LIMITS.charactersPerConversation ||
    !isValidKey(item.creationKey) ||
    !item.title.trim() ||
    item.title.trim().length > CONVERSATION_LIMITS.titleCharacters ||
    !item.command ||
    item.command.length > CONVERSATION_LIMITS.commandCharacters
  ) return [];
  return [{
    archived: item.archived,
    command: item.command,
    createdAt,
    creationFingerprint: item.creationFingerprint,
    creationKey: item.creationKey,
    documentId: item.documentId,
    id: item.id,
    latestAiRunId: typeof item.latestAiRunId === "string" ? item.latestAiRunId : null,
    latestProposalId: typeof item.latestProposalId === "string" ? item.latestProposalId : null,
    messageCount: Number(item.messageCount),
    messages,
    retentionExpiresAt,
    status: item.status,
    title: item.title,
    updatedAt,
    version: Number(item.version),
  }];
}

function parseLocalMessage(value: unknown): LocalMessage[] {
  if (!value || typeof value !== "object") return [];
  const item = value as Partial<SerializedLocalConversation["messages"][number]>;
  if (
    typeof item.id !== "string" ||
    typeof item.content !== "string" ||
    typeof item.createdAt !== "string" ||
    typeof item.mutationKey !== "string" ||
    typeof item.mutationFingerprint !== "string" ||
    (item.role !== "assistant" && item.role !== "user") ||
    !isValidKey(item.mutationKey) ||
    item.content.length < 1 ||
    item.content.length > CONVERSATION_LIMITS.messageCharacters ||
    (typeof item.command === "string" && item.command.length > CONVERSATION_LIMITS.commandCharacters) ||
    (typeof item.scopeLabel === "string" && item.scopeLabel.length > CONVERSATION_LIMITS.scopeLabelCharacters)
  ) return [];
  const createdAt = new Date(item.createdAt);
  if (!isFiniteDate(createdAt)) return [];
  return [{
    aiRunId: typeof item.aiRunId === "string" ? item.aiRunId : null,
    command: typeof item.command === "string" ? item.command : null,
    content: item.content,
    createdAt,
    id: item.id,
    mutationFingerprint: item.mutationFingerprint,
    mutationKey: item.mutationKey,
    proposalId: typeof item.proposalId === "string" ? item.proposalId : null,
    role: item.role,
    scopeLabel: typeof item.scopeLabel === "string" ? item.scopeLabel : null,
  }];
}

function isFiniteDate(value: Date) {
  return Number.isFinite(value.getTime());
}
