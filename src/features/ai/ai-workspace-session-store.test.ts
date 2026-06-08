import { describe, expect, it } from "vitest";
import {
  archiveAiWorkspaceSession,
  readAiWorkspaceSessionsFromStorage,
  toStoredAiWorkspaceSessions,
  writeAiWorkspaceSessionsToStorage,
  type AiWorkspaceSessionLike,
} from "./ai-workspace-session-store";

class MemoryStorage implements Pick<Storage, "getItem" | "removeItem" | "setItem"> {
  private values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

class ThrowingStorage implements Pick<Storage, "getItem" | "removeItem" | "setItem"> {
  getItem(): string | null {
    throw new Error("storage unavailable");
  }

  removeItem() {
    throw new Error("storage unavailable");
  }

  setItem() {
    throw new Error("storage unavailable");
  }
}

const session: AiWorkspaceSessionLike = {
  command: "Improve clarity",
  createdAt: new Date("2026-06-08T01:00:00.000Z"),
  id: "session_1",
  messages: [
    {
      command: "Improve clarity",
      content: "원문",
      id: "message_1",
      role: "user",
      scopeLabel: "선택 영역",
    },
  ],
  status: "running",
  title: "명확하게 개선",
  updatedAt: new Date("2026-06-08T01:00:01.000Z"),
};

describe("ai workspace session store", () => {
  it("serializes sessions and normalizes running status for reload", () => {
    const stored = toStoredAiWorkspaceSessions([session]);

    expect(stored[0]).toMatchObject({
      command: "Improve clarity",
      createdAt: "2026-06-08T01:00:00.000Z",
      status: "idle",
      title: "명확하게 개선",
    });
    expect(stored[0]?.messages[0]).toMatchObject({
      content: "원문",
      createdAt: "2026-06-08T01:00:01.000Z",
      role: "user",
    });
  });

  it("stores sessions under document-scoped keys", () => {
    const storage = new MemoryStorage();

    writeAiWorkspaceSessionsToStorage(storage, "doc_1", [session]);
    writeAiWorkspaceSessionsToStorage(storage, "doc_2", [{ ...session, id: "session_2", title: "다른 문서" }]);

    expect(readAiWorkspaceSessionsFromStorage(storage, "doc_1")[0]?.id).toBe("session_1");
    expect(readAiWorkspaceSessionsFromStorage(storage, "doc_2")[0]?.id).toBe("session_2");
  });

  it("recovers from invalid storage payloads", () => {
    const storage = new MemoryStorage();
    storage.setItem("coredot-ai-workspace-sessions:v1:doc_1", "{not valid json");

    expect(readAiWorkspaceSessionsFromStorage(storage, "doc_1")).toEqual([]);
  });

  it("treats storage API failures as non-fatal", () => {
    const storage = new ThrowingStorage();

    expect(readAiWorkspaceSessionsFromStorage(storage, "doc_1")).toEqual([]);
    expect(() => writeAiWorkspaceSessionsToStorage(storage, "doc_1", [session])).not.toThrow();
    expect(() => writeAiWorkspaceSessionsToStorage(storage, "doc_1", [])).not.toThrow();
  });

  it("archives a session without mutating the original list", () => {
    const sessions = [session, { ...session, id: "session_2", title: "번역" }];
    const archived = archiveAiWorkspaceSession(sessions, "session_1");

    expect(archived[0]?.archived).toBe(true);
    expect(archived[1]?.archived).toBeFalsy();
    expect(sessions[0]?.archived).toBeUndefined();
  });
});
