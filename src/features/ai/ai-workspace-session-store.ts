export type AiWorkspaceSessionStatus = "failed" | "idle" | "running";

export type AiWorkspaceMessageLike = {
  command?: string;
  content: string;
  createdAt?: Date | string;
  id: string;
  proposalId?: string;
  role: "assistant" | "user";
  runId?: string;
  scopeLabel?: string;
};

export type AiWorkspaceSessionLike = {
  archived?: boolean;
  command: string;
  createdAt: Date | string;
  id: string;
  messages: AiWorkspaceMessageLike[];
  status?: AiWorkspaceSessionStatus;
  title: string;
  updatedAt: Date | string;
};

export type StoredAiWorkspaceMessage = Omit<AiWorkspaceMessageLike, "createdAt"> & {
  createdAt: string;
};

export type StoredAiWorkspaceSession = Omit<AiWorkspaceSessionLike, "createdAt" | "messages" | "updatedAt"> & {
  createdAt: string;
  messages: StoredAiWorkspaceMessage[];
  status: Exclude<AiWorkspaceSessionStatus, "running">;
  updatedAt: string;
};

type WorkspaceStorage = Pick<Storage, "getItem" | "removeItem" | "setItem">;

const AI_WORKSPACE_SESSION_STORAGE_PREFIX = "coredot-ai-workspace-sessions:v1:";

export function readAiWorkspaceSessionsFromStorage(storage: WorkspaceStorage, documentId: string) {
  try {
    const rawValue = storage.getItem(getAiWorkspaceSessionStorageKey(documentId));
    if (!rawValue) return [];

    return fromStoredAiWorkspaceSessions(JSON.parse(rawValue));
  } catch {
    return [];
  }
}

export function writeAiWorkspaceSessionsToStorage(
  storage: WorkspaceStorage,
  documentId: string,
  sessions: AiWorkspaceSessionLike[],
) {
  const key = getAiWorkspaceSessionStorageKey(documentId);

  try {
    if (sessions.length === 0) {
      storage.removeItem(key);
      return;
    }

    storage.setItem(key, JSON.stringify(toStoredAiWorkspaceSessions(sessions)));
  } catch {
    return;
  }
}

export function readAiWorkspaceSessionsForDocument(documentId: string) {
  if (typeof window === "undefined") return [];
  return readAiWorkspaceSessionsFromStorage(window.localStorage, documentId);
}

export function writeAiWorkspaceSessionsForDocument(documentId: string, sessions: AiWorkspaceSessionLike[]) {
  if (typeof window === "undefined") return;
  writeAiWorkspaceSessionsToStorage(window.localStorage, documentId, sessions);
}

export function archiveAiWorkspaceSession<TSession extends AiWorkspaceSessionLike>(
  sessions: TSession[],
  sessionId: string,
): TSession[] {
  return sessions.map((session) => (session.id === sessionId ? { ...session, archived: true } : session));
}

export function toStoredAiWorkspaceSessions(sessions: AiWorkspaceSessionLike[]): StoredAiWorkspaceSession[] {
  return sessions.map((session) => {
    const updatedAt = toIsoDate(session.updatedAt);

    return {
      ...session,
      archived: session.archived ?? false,
      createdAt: toIsoDate(session.createdAt),
      messages: session.messages.map((message) => ({
        ...message,
        createdAt: toIsoDate(message.createdAt ?? updatedAt),
      })),
      status: session.status === "failed" ? "failed" : "idle",
      updatedAt,
    };
  });
}

function fromStoredAiWorkspaceSessions(value: unknown): StoredAiWorkspaceSession[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];

    const session = item as Partial<StoredAiWorkspaceSession>;
    if (
      typeof session.id !== "string" ||
      typeof session.title !== "string" ||
      typeof session.command !== "string" ||
      typeof session.createdAt !== "string" ||
      typeof session.updatedAt !== "string" ||
      !Array.isArray(session.messages)
    ) {
      return [];
    }

    return [
      {
        archived: session.archived === true,
        command: session.command,
        createdAt: session.createdAt,
        id: session.id,
        messages: sanitizeStoredMessages(session.messages),
        status: session.status === "failed" ? "failed" : "idle",
        title: session.title,
        updatedAt: session.updatedAt,
      },
    ];
  });
}

function sanitizeStoredMessages(messages: unknown[]): StoredAiWorkspaceMessage[] {
  return messages.flatMap((item) => {
    if (!item || typeof item !== "object") return [];

    const message = item as Partial<StoredAiWorkspaceMessage>;
    if (
      typeof message.id !== "string" ||
      typeof message.content !== "string" ||
      typeof message.createdAt !== "string" ||
      (message.role !== "assistant" && message.role !== "user")
    ) {
      return [];
    }

    return [
      {
        command: typeof message.command === "string" ? message.command : undefined,
        content: message.content,
        createdAt: message.createdAt,
        id: message.id,
        proposalId: typeof message.proposalId === "string" ? message.proposalId : undefined,
        role: message.role,
        runId: typeof message.runId === "string" ? message.runId : undefined,
        scopeLabel: typeof message.scopeLabel === "string" ? message.scopeLabel : undefined,
      },
    ];
  });
}

function getAiWorkspaceSessionStorageKey(documentId: string) {
  return `${AI_WORKSPACE_SESSION_STORAGE_PREFIX}${encodeURIComponent(documentId)}`;
}

function toIsoDate(value: Date | string) {
  if (value instanceof Date) return value.toISOString();

  const parsedDate = new Date(value);
  return Number.isNaN(parsedDate.getTime()) ? new Date(0).toISOString() : parsedDate.toISOString();
}
