import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq, sql } from "drizzle-orm";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import type { RequestContext } from "@/features/auth/request-context";
import { createConversationRepository } from "./conversation-repository";

const context: RequestContext = {
  authMode: "test",
  principalId: "principal-a",
  requestId: "request-a",
  role: "owner",
  workspaceId: "workspace-a",
};

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

async function createConversationDatabase() {
  const dir = await mkdtemp(join(tmpdir(), "coredot-conversation-test-"));
  tempDirs.push(dir);
  const url = `file:${join(dir, "conversations.db")}`;
  const client = createClient({ url });
  await client.executeMultiple(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE documents (
      id text PRIMARY KEY NOT NULL,
      workspace_id text NOT NULL,
      creation_key text,
      title text NOT NULL,
      content_json text NOT NULL,
      plain_text text NOT NULL DEFAULT '',
      status text NOT NULL DEFAULT 'draft',
      readiness text NOT NULL DEFAULT 'draft',
      metadata_json text NOT NULL DEFAULT '{}',
      revision integer NOT NULL DEFAULT 0,
      created_at integer NOT NULL,
      updated_at integer NOT NULL
    );
    CREATE UNIQUE INDEX documents_workspace_id_id_unique ON documents(workspace_id, id);
    CREATE TABLE ai_runs (
      id text PRIMARY KEY NOT NULL,
      workspace_id text NOT NULL,
      document_id text NOT NULL,
      command_type text NOT NULL,
      provider text NOT NULL,
      model text NOT NULL,
      input_summary_json text NOT NULL,
      output_text text NOT NULL DEFAULT '',
      status text NOT NULL,
      was_applied integer NOT NULL DEFAULT 0,
      created_at integer NOT NULL,
      updated_at integer NOT NULL
    );
    CREATE UNIQUE INDEX ai_runs_workspace_id_id_document_id_unique
      ON ai_runs(workspace_id, id, document_id);
    CREATE TABLE ai_proposals (
      id text PRIMARY KEY NOT NULL,
      workspace_id text NOT NULL,
      ai_run_id text NOT NULL,
      document_id text NOT NULL,
      target_text text NOT NULL,
      replacement_text text NOT NULL,
      explanation text NOT NULL,
      source text NOT NULL DEFAULT 'review',
      default_apply_mode text NOT NULL DEFAULT 'replace',
      status text NOT NULL DEFAULT 'pending',
      created_at integer NOT NULL,
      updated_at integer NOT NULL
    );
    CREATE UNIQUE INDEX ai_proposals_workspace_id_id_document_id_unique
      ON ai_proposals(workspace_id, id, document_id);
    CREATE TABLE ai_workspace_conversations (
      id text PRIMARY KEY NOT NULL,
      workspace_id text NOT NULL,
      document_id text NOT NULL,
      created_by_principal_id text NOT NULL,
      creation_key text NOT NULL,
      creation_fingerprint text NOT NULL,
      title text NOT NULL,
      command text NOT NULL,
      status text NOT NULL DEFAULT 'idle',
      version integer NOT NULL DEFAULT 1,
      message_count integer NOT NULL DEFAULT 1,
      latest_ai_run_id text,
      latest_proposal_id text,
      archived_at integer,
      retention_expires_at integer,
      created_at integer NOT NULL,
      updated_at integer NOT NULL,
      FOREIGN KEY(workspace_id, document_id) REFERENCES documents(workspace_id, id) ON DELETE CASCADE,
      FOREIGN KEY(workspace_id, latest_ai_run_id, document_id)
        REFERENCES ai_runs(workspace_id, id, document_id),
      FOREIGN KEY(workspace_id, latest_proposal_id, document_id)
        REFERENCES ai_proposals(workspace_id, id, document_id)
    );
    CREATE UNIQUE INDEX ai_workspace_conversations_workspace_id_document_unique
      ON ai_workspace_conversations(workspace_id, id, document_id);
    CREATE UNIQUE INDEX ai_workspace_conversations_workspace_creation_key_unique
      ON ai_workspace_conversations(workspace_id, creation_key);
    CREATE INDEX ai_workspace_conversations_workspace_document_updated_idx
      ON ai_workspace_conversations(workspace_id, document_id, archived_at, updated_at, id);
    CREATE TABLE ai_workspace_messages (
      id text PRIMARY KEY NOT NULL,
      workspace_id text NOT NULL,
      conversation_id text NOT NULL,
      document_id text NOT NULL,
      mutation_key text NOT NULL,
      mutation_fingerprint text NOT NULL,
      ordinal integer NOT NULL,
      role text NOT NULL,
      content text NOT NULL,
      command text,
      scope_label text,
      ai_run_id text,
      proposal_id text,
      retention_expires_at integer,
      created_at integer NOT NULL,
      FOREIGN KEY(workspace_id, conversation_id, document_id)
        REFERENCES ai_workspace_conversations(workspace_id, id, document_id) ON DELETE CASCADE,
      FOREIGN KEY(workspace_id, ai_run_id, document_id)
        REFERENCES ai_runs(workspace_id, id, document_id),
      FOREIGN KEY(workspace_id, proposal_id, document_id)
        REFERENCES ai_proposals(workspace_id, id, document_id)
    );
    CREATE UNIQUE INDEX ai_workspace_messages_conversation_ordinal_unique
      ON ai_workspace_messages(workspace_id, conversation_id, ordinal);
    CREATE UNIQUE INDEX ai_workspace_messages_conversation_mutation_key_unique
      ON ai_workspace_messages(workspace_id, conversation_id, mutation_key);
  `);
  const database = drizzle(client, { schema });
  await database.insert(schema.documents).values({
    id: "doc-a",
    workspaceId: context.workspaceId,
    title: "Document A",
    contentJson: { type: "doc" },
    plainText: "",
    status: "draft",
    readiness: "draft",
    metadataJson: {},
    revision: 0,
    createdAt: new Date(1_000),
    updatedAt: new Date(1_000),
  });
  await database.insert(schema.documents).values({
    id: "doc-b",
    workspaceId: "workspace-b",
    title: "Document B",
    contentJson: { type: "doc" },
    plainText: "",
    status: "draft",
    readiness: "draft",
    metadataJson: {},
    revision: 0,
    createdAt: new Date(1_000),
    updatedAt: new Date(1_000),
  });
  return { client, database, url };
}

function interleaveAfterConversationRows<TDatabase extends object>(
  database: TDatabase,
  interleave: () => Promise<void>,
): TDatabase {
  let armed = true;
  let completedSelects = 0;

  function wrapQuery<TQuery extends object>(query: TQuery, shouldInterleave: boolean): TQuery {
    return new Proxy(query, {
      get(target, property) {
        if (property === "then") {
          return (fulfilled?: (value: unknown) => unknown, rejected?: (reason: unknown) => unknown) =>
            Promise.resolve(target).then(async (value) => {
              completedSelects += 1;
              if (shouldInterleave && armed && completedSelects === 2) {
                armed = false;
                await interleave();
              }
              return value;
            }).then(fulfilled, rejected);
        }
        const member = Reflect.get(target, property, target) as unknown;
        if (typeof member !== "function") return member;
        return (...args: unknown[]) => {
          const result = Reflect.apply(member, target, args) as unknown;
          return result && typeof result === "object"
            ? wrapQuery(result, shouldInterleave)
            : result;
        };
      },
    });
  }

  function wrapReader<TReader extends object>(reader: TReader): TReader {
    return new Proxy(reader, {
      get(target, property) {
        const member = Reflect.get(target, property, target) as unknown;
        if (property === "select" && typeof member === "function") {
          return (...args: unknown[]) => {
            const builder = Reflect.apply(member, target, args) as object;
            return new Proxy(builder, {
              get(selectTarget, selectProperty) {
                const selectMember = Reflect.get(selectTarget, selectProperty, selectTarget) as unknown;
                if (selectProperty === "from" && typeof selectMember === "function") {
                  return (table: unknown) => {
                    const query = Reflect.apply(selectMember, selectTarget, [table]) as object;
                    return wrapQuery(query, true);
                  };
                }
                return typeof selectMember === "function" ? selectMember.bind(selectTarget) : selectMember;
              },
            });
          };
        }
        if (property === "transaction" && typeof member === "function") {
          return (callback: (transaction: object) => unknown, ...args: unknown[]) =>
            Reflect.apply(member, target, [
              (transaction: object) => callback(wrapReader(transaction)),
              ...args,
            ]);
        }
        return typeof member === "function" ? member.bind(target) : member;
      },
    });
  }

  return wrapReader(database);
}

const createInput = {
  command: "Improve clarity",
  creationKey: "create-conversation-0001",
  documentId: "doc-a",
  initialMessage: {
    command: "Improve clarity",
    content: "Original text",
    mutationKey: "message-user-0001",
    role: "user" as const,
    scopeLabel: "Selection",
  },
  title: "Improve clarity",
};

describe("conversation repository", () => {
  it("creates, lists, appends, renames, archives, changes status, and forks a scoped conversation", async () => {
    const { database } = await createConversationDatabase();
    const repository = createConversationRepository(database);

    const created = await repository.create(context, createInput);
    expect(created).toMatchObject({ ok: true, replayed: false, value: { messageCount: 1, version: 1 } });
    if (!created.ok) return;

    const appended = await repository.append(context, created.value.id, {
      aiRunId: null,
      content: "Clearer text",
      expectedVersion: created.value.version,
      mutationKey: "message-assistant-0001",
      proposalId: null,
      role: "assistant",
      status: "idle",
    });
    expect(appended).toMatchObject({ ok: true, value: { messageCount: 2, version: 2 } });
    if (!appended.ok) return;

    const renamed = await repository.rename(context, created.value.id, {
      expectedVersion: appended.value.version,
      title: "Review follow-up",
    });
    expect(renamed).toMatchObject({ ok: true, value: { title: "Review follow-up", version: 3 } });
    if (!renamed.ok) return;

    const archived = await repository.archive(context, created.value.id, {
      archived: true,
      expectedVersion: renamed.value.version,
    });
    expect(archived).toMatchObject({ ok: true, value: { archived: true, version: 4 } });
    if (!archived.ok) return;

    const failed = await repository.setStatus(context, created.value.id, {
      expectedVersion: archived.value.version,
      status: "failed",
    });
    expect(failed).toMatchObject({ ok: true, value: { status: "failed", version: 5 } });

    const page = await repository.list(context, { documentId: "doc-a", includeArchived: true, limit: 20 });
    expect(page).toMatchObject({ ok: true, value: { items: [{ messages: { length: 2 } }] } });

    const forked = await repository.fork(context, created.value.id, {
      creationKey: "fork-conversation-0001",
      throughMessageId: appended.ok ? appended.value.messages[0]!.id : "missing",
      title: "Review branch",
    });
    expect(forked).toMatchObject({ ok: true, value: { title: "Review branch", messages: { length: 1 } } });
  });

  it("replays same-key mutations, rejects different payloads, and never crosses a Workspace", async () => {
    const { database } = await createConversationDatabase();
    const repository = createConversationRepository(database);
    const created = await repository.create(context, createInput);
    const replayed = await repository.create(context, createInput);
    const conflicted = await repository.create(context, { ...createInput, title: "Different title" });

    expect(created).toMatchObject({ ok: true, replayed: false });
    expect(replayed).toMatchObject({ ok: true, replayed: true });
    expect(conflicted).toEqual({ ok: false, reason: "conflict" });
    expect(await repository.list({ ...context, workspaceId: "workspace-b" }, {
      documentId: "doc-a",
      limit: 20,
    })).toEqual({ ok: false, reason: "not_found" });
  });

  it("replays append before checking a stale version and rejects a reused key with different content", async () => {
    const { database } = await createConversationDatabase();
    const repository = createConversationRepository(database);
    const created = await repository.create(context, createInput);
    if (!created.ok) return;
    const input = {
      content: "Clearer text",
      expectedVersion: 1,
      mutationKey: "message-assistant-replay",
      role: "assistant" as const,
      status: "idle" as const,
    };

    const appended = await repository.append(context, created.value.id, input);
    const replayed = await repository.append(context, created.value.id, input);
    const conflicted = await repository.append(context, created.value.id, { ...input, content: "Other text" });

    expect(appended).toMatchObject({ ok: true, replayed: false, value: { messageCount: 2 } });
    expect(replayed).toMatchObject({ ok: true, replayed: true, value: { messageCount: 2 } });
    expect(conflicted).toEqual({ ok: false, reason: "conflict" });
  });

  it("allows only one competing append at the same expected version", async () => {
    const { database } = await createConversationDatabase();
    const repository = createConversationRepository(database);
    const created = await repository.create(context, createInput);
    if (!created.ok) return;

    const results = await Promise.all([
      repository.append(context, created.value.id, {
        content: "First",
        expectedVersion: 1,
        mutationKey: "competing-message-0001",
        role: "assistant",
        status: "idle",
      }),
      repository.append(context, created.value.id, {
        content: "Second",
        expectedVersion: 1,
        mutationKey: "competing-message-0002",
        role: "assistant",
        status: "idle",
      }),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, reason: "conflict" }]);
  });

  it("hydrates conversation rows and messages from one read snapshot during an append", async () => {
    const { client, database, url } = await createConversationDatabase();
    await client.execute("PRAGMA journal_mode=WAL");
    const repository = createConversationRepository(database);
    const created = await repository.create(context, createInput);
    if (!created.ok) return;

    const writerClient = createClient({ url });
    await writerClient.execute("PRAGMA journal_mode=WAL");
    const writer = drizzle(writerClient, { schema });
    const interleaved = interleaveAfterConversationRows(database, async () => {
      await writer.transaction(async (transaction) => {
        await transaction
          .update(schema.aiWorkspaceConversations)
          .set({
            messageCount: sql`${schema.aiWorkspaceConversations.messageCount} + 1`,
            updatedAt: new Date(3_000),
            version: sql`${schema.aiWorkspaceConversations.version} + 1`,
          })
          .where(eq(schema.aiWorkspaceConversations.id, created.value.id));
        await transaction.insert(schema.aiWorkspaceMessages).values({
          content: "Interleaved",
          conversationId: created.value.id,
          createdAt: new Date(3_000),
          documentId: "doc-a",
          mutationFingerprint: "interleaved-fingerprint",
          mutationKey: "interleaved-message-0001",
          ordinal: 1,
          role: "assistant",
          workspaceId: context.workspaceId,
        });
      });
    });

    const page = await createConversationRepository(interleaved).list(context, {
      documentId: "doc-a",
      limit: 20,
    });
    expect(page).toMatchObject({ ok: true });
    if (!page.ok) return;
    expect(page.value.items[0]?.messageCount).toBe(page.value.items[0]?.messages.length);
    expect(page.value.items[0]).toMatchObject({ messageCount: 1, messages: { length: 1 }, version: 1 });

    const refreshed = await repository.list(context, { documentId: "doc-a", limit: 20 });
    expect(refreshed).toMatchObject({
      ok: true,
      value: { items: [{ messageCount: 2, messages: { length: 2 }, version: 2 }] },
    });
  });

  it("creates one fork for concurrent requests with the same creation key", async () => {
    const { database } = await createConversationDatabase();
    const repository = createConversationRepository(database);
    const created = await repository.create(context, createInput);
    if (!created.ok) return;
    const input = {
      creationKey: "fork-conversation-race",
      throughMessageId: created.value.messages[0]!.id,
      title: "Branch",
    };

    const results = await Promise.all([
      repository.fork(context, created.value.id, input),
      repository.fork(context, created.value.id, input),
    ]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(results.filter((result) => result.ok && result.replayed)).toHaveLength(1);
    const page = await repository.list(context, { documentId: "doc-a", includeArchived: true, limit: 20 });
    expect(page.ok && page.value.items).toHaveLength(2);
  });

  it("enforces the active conversation quota while excluding expired records", async () => {
    const { database } = await createConversationDatabase();
    const repository = createConversationRepository(database);
    await database.insert(schema.aiWorkspaceConversations).values(Array.from({ length: 100 }, (_, index) => ({
      command: "Rewrite",
      createdAt: new Date(1_000),
      createdByPrincipalId: context.principalId,
      creationFingerprint: `fingerprint-${index}`,
      creationKey: `quota-conversation-${String(index).padStart(4, "0")}`,
      documentId: "doc-a",
      id: `quota-${index}`,
      messageCount: 1,
      retentionExpiresAt: index === 0 ? new Date(2_000) : null,
      status: "idle" as const,
      title: `Conversation ${index}`,
      updatedAt: new Date(1_000 + index),
      version: 1,
      workspaceId: context.workspaceId,
    })));

    const allowed = await repository.create(context, {
      ...createInput,
      creationKey: "quota-create-allowed-0001",
      initialMessage: { ...createInput.initialMessage, mutationKey: "quota-message-allowed-0001" },
    });
    expect(allowed).toMatchObject({ ok: true });

    const limited = await repository.create(context, {
      ...createInput,
      creationKey: "quota-create-limited-0001",
      initialMessage: { ...createInput.initialMessage, mutationKey: "quota-message-limited-0001" },
    });
    expect(limited).toEqual({ ok: false, reason: "limit" });
  });
});
