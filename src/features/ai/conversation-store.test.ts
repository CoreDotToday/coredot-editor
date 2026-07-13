import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import type { RequestContext } from "@/features/auth/request-context";
import { createConversationRepository } from "./conversation-repository";
import { CONVERSATION_LIMITS } from "./conversation-domain";
import {
  createLocalConversationStore,
  createRepositoryConversationStore,
  resolveConversationStorageMode,
  type ConversationStore,
} from "./conversation-store";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

class MemoryStorage implements Pick<Storage, "getItem" | "removeItem" | "setItem"> {
  readonly values = new Map<string, string>();
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

async function exerciseStore(store: ConversationStore) {
  const created = await store.create({
    command: "Improve clarity",
    creationKey: "create-local-conversation-0001",
    documentId: "doc-a",
    initialMessage: {
      command: "Improve clarity",
      content: "Original",
      mutationKey: "create-local-message-0001",
      role: "user",
    },
    title: "Improve clarity",
  });
  expect(created).toMatchObject({ ok: true, value: { messageCount: 1, syncStatus: "saved", version: 1 } });
  if (!created.ok) return;
  const appended = await store.append("doc-a", created.value.id, {
    content: "Clearer",
    expectedVersion: created.value.version,
    mutationKey: "append-local-message-0001",
    role: "assistant",
    status: "idle",
  });
  expect(appended).toMatchObject({ ok: true, value: { messageCount: 2, version: 2 } });
  if (!appended.ok) return;
  const renamed = await store.rename("doc-a", created.value.id, {
    expectedVersion: appended.value.version,
    title: "Follow-up",
  });
  expect(renamed).toMatchObject({ ok: true, value: { title: "Follow-up" } });
  if (!renamed.ok) return;
  const forked = await store.fork("doc-a", created.value.id, {
    creationKey: "fork-local-conversation-0001",
    throughMessageId: created.value.messages[0]!.id,
    title: "Branch",
  });
  expect(forked).toMatchObject({ ok: true, value: { messages: { length: 1 }, title: "Branch" } });
  const archived = await store.archive("doc-a", created.value.id, {
    archived: true,
    expectedVersion: renamed.value.version,
  });
  expect(archived).toMatchObject({ ok: true, value: { archived: true } });
}

async function exerciseMessageBudgets(store: ConversationStore) {
  const maximumMessage = "가".repeat(CONVERSATION_LIMITS.messageCharacters);
  await expect(store.create({
    command: "Rewrite",
    creationKey: "oversized-create-key-0001",
    documentId: "doc-a",
    initialMessage: {
      content: `${maximumMessage}x`,
      mutationKey: "oversized-message-key-0001",
      role: "user",
    },
    title: "Oversized",
  })).resolves.toEqual({ ok: false, reason: "invalid" });

  const created = await store.create({
    command: "Rewrite",
    creationKey: "maximum-create-key-0001",
    documentId: "doc-a",
    initialMessage: {
      content: maximumMessage,
      mutationKey: "maximum-message-key-0001",
      role: "user",
    },
    title: "Maximum message",
  });
  expect(created).toMatchObject({ ok: true, value: { messages: [{ content: maximumMessage }] } });
  if (!created.ok) return;

  let version = created.value.version;
  for (let index = 1; index < 10; index += 1) {
    const appended = await store.append("doc-a", created.value.id, {
      content: maximumMessage,
      expectedVersion: version,
      mutationKey: `maximum-append-key-${String(index).padStart(4, "0")}`,
      role: "assistant",
      status: "idle",
    });
    expect(appended).toMatchObject({ ok: true });
    if (!appended.ok) return;
    version = appended.value.version;
  }
  await expect(store.append("doc-a", created.value.id, {
    content: "x",
    expectedVersion: version,
    mutationKey: "aggregate-limit-key-0001",
    role: "assistant",
    status: "idle",
  })).resolves.toEqual({ ok: false, reason: "limit" });
}

async function exerciseForkLinkParity(store: ConversationStore) {
  const created = await store.create({
    command: "Rewrite",
    creationKey: "linked-create-key-0001",
    documentId: "doc-a",
    initialMessage: {
      content: "Original",
      mutationKey: "linked-initial-key-0001",
      role: "user",
    },
    title: "Linked source",
  });
  if (!created.ok) throw new Error("Could not create linked conversation fixture");
  await expect(store.append("doc-a", created.value.id, {
    content: "Proposal without run",
    expectedVersion: created.value.version,
    mutationKey: "proposal-only-key-0001",
    proposalId: "proposal-a",
    role: "assistant",
    status: "idle",
  })).resolves.toEqual({ ok: false, reason: "invalid" });
  const linked = await store.append("doc-a", created.value.id, {
    aiRunId: "run-a",
    content: "Linked answer",
    expectedVersion: created.value.version,
    mutationKey: "linked-answer-key-0001",
    proposalId: "proposal-a",
    role: "assistant",
    status: "idle",
  });
  if (!linked.ok) throw new Error("Could not append linked conversation fixture");
  const unlinked = await store.append("doc-a", created.value.id, {
    content: "Follow-up",
    expectedVersion: linked.value.version,
    mutationKey: "unlinked-followup-key-0001",
    role: "user",
    status: "idle",
  });
  if (!unlinked.ok) throw new Error("Could not append unlinked conversation fixture");
  expect(unlinked).toMatchObject({
    ok: true,
    value: { latestAiRunId: "run-a", latestProposalId: "proposal-a" },
  });

  const beforeLink = await store.fork("doc-a", created.value.id, {
    creationKey: "fork-before-link-key-0001",
    throughMessageId: created.value.messages[0]!.id,
    title: "Before link",
  });
  expect(beforeLink).toMatchObject({
    ok: true,
    value: { latestAiRunId: null, latestProposalId: null },
  });
  const throughUnlinked = await store.fork("doc-a", created.value.id, {
    creationKey: "fork-through-link-key-0001",
    throughMessageId: unlinked.value.messages.at(-1)!.id,
    title: "Through linked prefix",
  });
  expect(throughUnlinked).toMatchObject({
    ok: true,
    value: { latestAiRunId: "run-a", latestProposalId: "proposal-a" },
  });

  const runOnly = await store.append("doc-a", created.value.id, {
    aiRunId: "run-b",
    content: "A different run",
    expectedVersion: unlinked.value.version,
    mutationKey: "run-only-answer-key-0001",
    role: "assistant",
    status: "idle",
  });
  expect(runOnly).toMatchObject({
    ok: true,
    value: { latestAiRunId: "run-b", latestProposalId: null },
  });
  if (!runOnly.ok) return;
  const throughRunOnly = await store.fork("doc-a", created.value.id, {
    creationKey: "fork-through-run-key-0001",
    throughMessageId: runOnly.value.messages.at(-1)!.id,
    title: "Through run-only prefix",
  });
  expect(throughRunOnly).toMatchObject({
    ok: true,
    value: { latestAiRunId: "run-b", latestProposalId: null },
  });
}

describe("conversation store", () => {
  it("runs the complete persistence contract against the local adapter", async () => {
    const storage = new MemoryStorage();
    const store = createLocalConversationStore(storage, "workspace-a");
    await exerciseStore(store);
    await exerciseMessageBudgets(store);
    await exerciseForkLinkParity(store);
    expect([...storage.values.keys()]).toEqual([
      "coredot-ai-workspace-conversations:v2:workspace-a:doc-a",
    ]);
  });

  it("runs the same complete persistence contract against the database adapter", async () => {
    const dir = await mkdtemp(join(tmpdir(), "coredot-conversation-store-"));
    tempDirs.push(dir);
    const client = createClient({ url: `file:${join(dir, "store.db")}` });
    const database = drizzle(client, { schema });
    await migrate(database, { migrationsFolder: resolve(process.cwd(), "drizzle") });
    const context: RequestContext = {
      authMode: "test",
      principalId: "principal-a",
      requestId: "request-a",
      role: "owner",
      workspaceId: "workspace-a",
    };
    await database.insert(schema.documents).values({
      id: "doc-a",
      workspaceId: context.workspaceId,
      title: "Document",
      contentJson: { type: "doc" },
      plainText: "",
      status: "draft",
      readiness: "draft",
      metadataJson: {},
      revision: 0,
      createdAt: new Date(1_000),
      updatedAt: new Date(1_000),
    });

    await database.insert(schema.aiRuns).values({
      commandType: "selection_rewrite",
      createdAt: new Date(2_000),
      documentId: "doc-a",
      id: "run-a",
      inputSummaryJson: {},
      model: "stub",
      outputText: "Linked answer",
      provider: "stub",
      status: "completed",
      updatedAt: new Date(2_000),
      wasApplied: false,
      workspaceId: context.workspaceId,
    });
    await database.insert(schema.aiRuns).values({
      commandType: "selection_rewrite",
      createdAt: new Date(2_100),
      documentId: "doc-a",
      id: "run-b",
      inputSummaryJson: {},
      model: "stub",
      outputText: "A different run",
      provider: "stub",
      status: "completed",
      updatedAt: new Date(2_100),
      wasApplied: false,
      workspaceId: context.workspaceId,
    });
    await database.insert(schema.aiProposals).values({
      aiRunId: "run-a",
      createdAt: new Date(2_000),
      defaultApplyMode: "replace",
      documentId: "doc-a",
      explanation: "Clearer",
      id: "proposal-a",
      replacementText: "Linked answer",
      source: "selection",
      status: "pending",
      targetText: "Original",
      updatedAt: new Date(2_000),
      workspaceId: context.workspaceId,
    });
    const store = createRepositoryConversationStore(createConversationRepository(database), context);
    await exerciseStore(store);
    await exerciseMessageBudgets(store);
    await exerciseForkLinkParity(store);
  });

  it("returns explicit unavailable results when local storage fails", async () => {
    const store = createLocalConversationStore(new ThrowingStorage(), "workspace-a");
    await expect(store.list({ documentId: "doc-a" })).resolves.toEqual({ ok: false, reason: "unavailable" });
    await expect(store.create({
      command: "Rewrite",
      creationKey: "failed-local-create-0001",
      documentId: "doc-a",
      initialMessage: {
        content: "Original",
        mutationKey: "failed-local-message-0001",
        role: "user",
      },
      title: "Rewrite",
    })).resolves.toEqual({ ok: false, reason: "unavailable" });
  });

  it("validates local mutations and rejects malformed cursors", async () => {
    const storage = new MemoryStorage();
    const store = createLocalConversationStore(storage, "workspace-a");
    const invalidCreate = {
      command: "Rewrite",
      creationKey: "short",
      documentId: "doc-a",
      initialMessage: { content: "", mutationKey: "short", role: "user" as const },
      title: " ",
    };
    await expect(store.create(invalidCreate)).resolves.toEqual({ ok: false, reason: "invalid" });
    expect(storage.values.size).toBe(0);

    const created = await store.create({
      command: "Rewrite",
      creationKey: "valid-create-key-0001",
      documentId: "doc-a",
      initialMessage: { content: "Original", mutationKey: "valid-message-key-0001", role: "user" },
      title: "Rewrite",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await expect(store.append("doc-a", created.value.id, {
      content: "",
      expectedVersion: 0,
      mutationKey: "short",
      role: "assistant",
      status: "idle",
    })).resolves.toEqual({ ok: false, reason: "invalid" });
    await expect(store.rename("doc-a", created.value.id, {
      expectedVersion: 0,
      title: " ",
    })).resolves.toEqual({ ok: false, reason: "invalid" });
    await expect(store.list({ cursor: "not-supported", documentId: "doc-a" }))
      .resolves.toEqual({ ok: false, reason: "invalid" });
  });

  it("paginates 21+ local conversations with stable tie ordering", async () => {
    const key = "coredot-ai-workspace-conversations:v2:workspace-a:doc-a";
    const storage = new MemoryStorage();
    const store = createLocalConversationStore(storage, "workspace-a");
    for (let index = 0; index < 21; index += 1) {
      await store.create({
        command: "Rewrite",
        creationKey: `page-create-key-${String(index).padStart(4, "0")}`,
        documentId: "doc-a",
        initialMessage: {
          content: `Message ${index}`,
          mutationKey: `page-message-key-${String(index).padStart(4, "0")}`,
          role: "user",
        },
        title: `Conversation ${index}`,
      });
    }
    const records = JSON.parse(storage.getItem(key) ?? "[]") as Array<Record<string, unknown>>;
    for (const record of records) record.updatedAt = "2026-01-01T00:00:00.000Z";
    storage.setItem(key, JSON.stringify(records));
    const expectedIds = records.map((record) => String(record.id)).sort((left, right) => {
      if (left === right) return 0;
      return left < right ? 1 : -1;
    });

    const first = await store.list({ documentId: "doc-a", limit: 10 });
    expect(first).toMatchObject({ ok: true, value: { nextCursor: expect.any(String) } });
    if (!first.ok || !first.value.nextCursor) return;
    const second = await store.list({ cursor: first.value.nextCursor, documentId: "doc-a", limit: 10 });
    expect(second).toMatchObject({ ok: true, value: { nextCursor: expect.any(String) } });
    if (!second.ok || !second.value.nextCursor) return;
    const third = await store.list({ cursor: second.value.nextCursor, documentId: "doc-a", limit: 10 });
    expect(third).toMatchObject({ ok: true, value: { nextCursor: null } });
    if (!third.ok) return;
    expect([...first.value.items, ...second.value.items, ...third.value.items].map((item) => item.id))
      .toEqual(expectedIds);
  });

  it("matches database no-op replay behavior without changing local versions", async () => {
    const storage = new MemoryStorage();
    const store = createLocalConversationStore(storage, "workspace-a");
    const created = await store.create({
      command: "Rewrite",
      creationKey: "noop-create-key-0001",
      documentId: "doc-a",
      initialMessage: { content: "Original", mutationKey: "noop-message-key-0001", role: "user" },
      title: "Rewrite",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await expect(store.rename("doc-a", created.value.id, { expectedVersion: 99, title: "Rewrite" }))
      .resolves.toMatchObject({ ok: true, replayed: true, value: { version: 1 } });
    await expect(store.archive("doc-a", created.value.id, { archived: false, expectedVersion: 99 }))
      .resolves.toMatchObject({ ok: true, replayed: true, value: { version: 1 } });
    await expect(store.setStatus("doc-a", created.value.id, { expectedVersion: 99, status: "idle" }))
      .resolves.toMatchObject({ ok: true, replayed: true, value: { version: 1 } });
  });

  it("filters expired local records and treats corrupt persisted data as unavailable", async () => {
    const key = "coredot-ai-workspace-conversations:v2:workspace-a:doc-a";
    const storage = new MemoryStorage();
    const store = createLocalConversationStore(storage, "workspace-a");
    await store.create({
      command: "Rewrite",
      creationKey: "expiry-create-key-0001",
      documentId: "doc-a",
      initialMessage: { content: "Original", mutationKey: "expiry-message-key-0001", role: "user" },
      title: "Rewrite",
    });
    const records = JSON.parse(storage.getItem(key) ?? "[]") as Array<Record<string, unknown>>;
    records[0]!.retentionExpiresAt = "2000-01-01T00:00:00.000Z";
    storage.setItem(key, JSON.stringify(records));
    await expect(store.list({ documentId: "doc-a" }))
      .resolves.toMatchObject({ ok: true, value: { items: [] } });

    records[0]!.retentionExpiresAt = null;
    records[0]!.createdAt = "not-a-date";
    storage.setItem(key, JSON.stringify(records));
    await expect(store.list({ documentId: "doc-a" })).resolves.toEqual({ ok: false, reason: "unavailable" });

    records[0]!.createdAt = "2026-01-01T00:00:00.000Z";
    records[0]!.messageCount = 99;
    storage.setItem(key, JSON.stringify(records));
    await expect(store.list({ documentId: "doc-a" })).resolves.toEqual({ ok: false, reason: "unavailable" });
  });

  it("treats expired local records as not found without rewriting serialized storage", async () => {
    const key = "coredot-ai-workspace-conversations:v2:workspace-a:doc-a";
    const storage = new MemoryStorage();
    const store = createLocalConversationStore(storage, "workspace-a");
    const createInput = {
      command: "Rewrite",
      creationKey: "expired-create-key-0001",
      documentId: "doc-a",
      initialMessage: { content: "Original", mutationKey: "expired-message-key-0001", role: "user" },
      title: "Rewrite",
    } as const;
    const created = await store.create(createInput);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const records = JSON.parse(storage.getItem(key) ?? "[]") as Array<Record<string, unknown>>;
    records[0]!.retentionExpiresAt = "2000-01-01T00:00:00.000Z";
    const serializedExpiredRecord = JSON.stringify(records);
    storage.setItem(key, serializedExpiredRecord);

    const operations = [
      () => store.create(createInput),
      () => store.get("doc-a", created.value.id),
      () => store.append("doc-a", created.value.id, {
        content: "Should not persist",
        expectedVersion: 1,
        mutationKey: "expired-append-key-0001",
        role: "assistant" as const,
        status: "idle" as const,
      }),
      () => store.rename("doc-a", created.value.id, { expectedVersion: 1, title: "Changed" }),
      () => store.archive("doc-a", created.value.id, { archived: true, expectedVersion: 1 }),
      () => store.setStatus("doc-a", created.value.id, { expectedVersion: 1, status: "failed" as const }),
      () => store.fork("doc-a", created.value.id, {
        creationKey: "expired-fork-key-0001",
        throughMessageId: created.value.messages[0]!.id,
        title: "Expired branch",
      }),
    ];

    for (const operation of operations) {
      await expect(operation()).resolves.toEqual({ ok: false, reason: "not_found" });
      expect(storage.getItem(key)).toBe(serializedExpiredRecord);
    }
  });

  it("rejects an expired local fork replay without rewriting serialized storage", async () => {
    const key = "coredot-ai-workspace-conversations:v2:workspace-a:doc-a";
    const storage = new MemoryStorage();
    const store = createLocalConversationStore(storage, "workspace-a");
    const source = await store.create({
      command: "Rewrite",
      creationKey: "fork-source-create-key-0001",
      documentId: "doc-a",
      initialMessage: { content: "Original", mutationKey: "fork-source-message-key-0001", role: "user" },
      title: "Rewrite",
    });
    expect(source.ok).toBe(true);
    if (!source.ok) return;
    const forkInput = {
      creationKey: "expired-fork-replay-key-0001",
      throughMessageId: source.value.messages[0]!.id,
      title: "Rewrite copy",
    };
    const forked = await store.fork("doc-a", source.value.id, forkInput);
    expect(forked.ok).toBe(true);
    if (!forked.ok) return;
    const records = JSON.parse(storage.getItem(key) ?? "[]") as Array<Record<string, unknown>>;
    const expiredFork = records.find((record) => record.id === forked.value.id);
    expect(expiredFork).toBeDefined();
    expiredFork!.retentionExpiresAt = "2000-01-01T00:00:00.000Z";
    const serializedExpiredFork = JSON.stringify(records);
    storage.setItem(key, serializedExpiredFork);

    await expect(store.fork("doc-a", source.value.id, forkInput))
      .resolves.toEqual({ ok: false, reason: "not_found" });
    expect(storage.getItem(key)).toBe(serializedExpiredFork);
  });

  it("defaults to database mode and rejects unknown configuration", () => {
    expect(resolveConversationStorageMode(undefined)).toBe("database");
    expect(resolveConversationStorageMode("database")).toBe("database");
    expect(resolveConversationStorageMode("local")).toBe("local");
    expect(() => resolveConversationStorageMode("other")).toThrow("Invalid CONVERSATION_STORAGE");
  });
});
